import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classify, refineWithFrames } from "../src/classify.js";
import { parseGdbOutput, type GdbReport } from "../src/gdb.js";
import { parseNtFile } from "../src/ntFile.js";
import {
  parseBinaryLayout,
  parseRecordedCrash,
  type BinaryLayout,
  type RecordedCrash,
} from "../src/rea.js";
import { toCoreIssue } from "../src/coreIssue.js";
import { renderIssueMarkdown } from "../src/issue.js";
import { createSymbolizer } from "../src/symbolize.js";
import { buildReport } from "../src/triage.js";

/** Encode an NT_FILE descriptor the way the Linux kernel writes it. */
function ntFile(
  pageSize: bigint,
  entries: readonly [bigint, bigint, bigint, string][],
): Uint8Array {
  const names = Buffer.from(
    entries.map(([, , , path]) => `${path}\0`).join(""),
  );
  const table = Buffer.alloc(16 + entries.length * 24);
  table.writeBigUInt64LE(BigInt(entries.length), 0);
  table.writeBigUInt64LE(pageSize, 8);
  entries.forEach(([start, end, page], index) => {
    table.writeBigUInt64LE(start, 16 + index * 24);
    table.writeBigUInt64LE(end, 24 + index * 24);
    table.writeBigUInt64LE(page, 32 + index * 24);
  });
  return new Uint8Array(Buffer.concat([table, names]));
}

/** Process layout from the real `parser` crash, relocated by `base`. */
function mappings(base: bigint): Uint8Array {
  return ntFile(0x1000n, [
    [base, base + 0x1000n, 0n, "/srv/app/parser"],
    [base + 0x1000n, base + 0x2000n, 1n, "/srv/app/parser"],
    [
      0x7f0000028000n,
      0x7f00001b1000n,
      0x28n,
      "/usr/lib/x86_64-linux-gnu/libc.so.6",
    ],
  ]);
}

const layout: BinaryLayout = {
  evidenceId: "ev_layout",
  binarySha256: "b".repeat(64),
  imageType: "ET_DYN",
  loadSegments: [
    { offset: 0x0n, virtualAddress: 0x0n },
    { offset: 0x1000n, virtualAddress: 0x1000n },
  ],
  functions: [
    { name: "sum", value: 0x11a9n, size: 0x4bn },
    { name: "main", value: 0x11f4n, size: 0xaen },
  ],
  mitigations: {
    position_independent: true,
    nx_indicator: true,
    stack_canary_indicator: true,
    relro: "Full",
  },
};

function crashAt(base: bigint): RecordedCrash {
  return {
    evidenceId: "ev_crash",
    coreSha256: "c".repeat(64),
    historicalPid: 724,
    registers: [
      { name: "rax", value: 0n },
      { name: "rip", value: base + 0x11dan },
      { name: "rsp", value: 0x7ffe06dafec0n },
    ],
    signal: { number: 11, code: 1, faultAddress: 0n },
    loadSegments: [],
    ntFileDescriptor: mappings(base),
    limitations: [],
  };
}

function gdbAt(base: bigint): GdbReport {
  return {
    status: "ok",
    frames: [
      { index: 0, address: base + 0x11dan, function: "sum", source: null },
      { index: 1, address: base + 0x126an, function: "main", source: null },
    ],
    instructions: [
      {
        address: base + 0x11dan,
        isFault: true,
        text: "0x1 <sum+49>:\tmov    (%rax),%eax",
      },
    ],
    warnings: [],
  };
}

describe("parseNtFile", () => {
  it("decodes start, end, byte offset and path", () => {
    const parsed = parseNtFile(mappings(0x5000n));
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.mappings.length, 3);
    assert.deepEqual(parsed.mappings[1], {
      start: 0x6000n,
      end: 0x7000n,
      fileOffset: 0x1000n,
      path: "/srv/app/parser",
    });
  });

  it("rejects truncated and implausible descriptors without allocating", () => {
    assert.equal(parseNtFile(new Uint8Array(8)).ok, false);
    const huge = new Uint8Array(16);
    new DataView(huge.buffer).setBigUint64(0, 1n << 40n, true);
    assert.equal(parseNtFile(huge).ok, false);
    const table = mappings(0x5000n);
    assert.equal(parseNtFile(table.subarray(0, 40)).ok, false);
  });
});

describe("createSymbolizer", () => {
  it("maps a PIE address to function+offset using the load bias", () => {
    const parsed = parseNtFile(mappings(0x556fdda1a000n));
    assert.ok(parsed.ok);
    const symbolizer = createSymbolizer(
      "/local/build/parser",
      parsed.mappings,
      layout,
    );
    assert.equal(symbolizer.loadBias, 0x556fdda1a000n);
    const location = symbolizer.locate(0x556fdda1b1dan);
    assert.equal(location.kind, "binary-function");
    if (location.kind !== "binary-function") return;
    assert.equal(location.symbol.name, "sum");
    assert.equal(location.symbolOffset, 0x31n);
  });

  it("reports library and unmapped addresses without guessing a symbol", () => {
    const parsed = parseNtFile(mappings(0x5000n));
    assert.ok(parsed.ok);
    const symbolizer = createSymbolizer("/x/parser", parsed.mappings, layout);
    assert.deepEqual(symbolizer.locate(0x7f0000030000n), {
      kind: "other-module",
      module: "libc.so.6",
      moduleOffset: 0x8000n,
    });
    assert.deepEqual(symbolizer.locate(0x10n), { kind: "unmapped" });
  });

  it("treats a binary missing from the core as unknown, not as its own code", () => {
    const parsed = parseNtFile(mappings(0x5000n));
    assert.ok(parsed.ok);
    const symbolizer = createSymbolizer("/x/other", parsed.mappings, layout);
    assert.equal(symbolizer.binaryFoundInCore, false);
    assert.equal(symbolizer.loadBias, null);
    assert.equal(symbolizer.locate(0x61dan).kind, "other-module");
  });
});

describe("classify", () => {
  const segv = (code: number, faultAddress: bigint | null) => ({
    number: 11,
    code,
    faultAddress,
  });

  it("distinguishes NULL, near-NULL, stack and wild accesses", () => {
    assert.equal(
      classify({ signal: segv(1, 0n), pc: 1n, sp: 0x7000n }).title,
      "NULL pointer dereference",
    );
    assert.match(
      classify({ signal: segv(1, 0x18n), pc: 1n, sp: 0x7000n }).title,
      /offset 0x18/,
    );
    assert.equal(
      classify({
        signal: segv(1, 0x7ffe0000ff00n),
        pc: 1n,
        sp: 0x7ffe00010000n,
      }).kind,
      "stack-overflow",
    );
    assert.equal(
      classify({ signal: segv(1, 0xdead0000n), pc: 1n, sp: 0x7000n }).kind,
      "invalid-memory-access",
    );
  });

  it("calls a jump to address 0 a NULL function call, not a NULL dereference", () => {
    assert.equal(classify({ signal: segv(1, 0n), pc: 0n, sp: 0x7000n }).kind, "null-function-call");
    assert.equal(classify({ signal: segv(1, 0x8n), pc: 0x8n, sp: 0x7000n }).kind, "null-function-call");
    assert.equal(classify({ signal: segv(1, 0n), pc: 0x401000n, sp: 0x7000n }).kind, "null-pointer-dereference");
  });

  it("separates permission faults, jumps to data and non-canonical pointers", () => {
    assert.equal(
      classify({ signal: segv(2, 0x4000n), pc: 0x4000n, sp: null }).kind,
      "execute-non-executable",
    );
    assert.equal(
      classify({ signal: segv(2, 0x4000n), pc: 0x1000n, sp: null }).kind,
      "permission-violation",
    );
    assert.equal(
      classify({ signal: segv(0x80, 0n), pc: 0x1000n, sp: null }).kind,
      "general-protection-fault",
    );
  });

  it("names other fatal signals and admits when nothing was recorded", () => {
    assert.equal(
      classify({
        signal: { number: 8, code: 1, faultAddress: null },
        pc: null,
        sp: null,
      }).kind,
      "divide-by-zero",
    );
    assert.equal(
      classify({
        signal: { number: 4, code: 2, faultAddress: null },
        pc: null,
        sp: null,
      }).kind,
      "illegal-instruction",
    );
    assert.equal(
      classify({ signal: null, pc: null, sp: null }).confidence,
      "low",
    );
  });

  it("refines aborts from frame names but leaves other signals alone", () => {
    const abort = classify({
      signal: { number: 6, code: -6, faultAddress: null },
      pc: null,
      sp: null,
    });
    assert.equal(
      refineWithFrames(abort, ["raise", "abort", "__assert_fail", "main"])
        .title,
      "Assertion failure",
    );
    assert.equal(
      refineWithFrames(abort, ["abort", "malloc_printerr", "_int_free"]).title,
      "Heap corruption detected",
    );
    assert.equal(
      refineWithFrames(abort, ["abort", "main"]).title,
      "abort() called",
    );
    const nul = classify({ signal: segv(1, 0n), pc: 1n, sp: null });
    assert.equal(refineWithFrames(nul, ["__assert_fail"]), nul);
  });
});

describe("parseGdbOutput", () => {
  it("reads frames, inlined frames, the faulting instruction and mismatch warnings", () => {
    const stdout = [
      "@@crashlens@@bt",
      "#0  0x00007f32fe99bc5c in __strlen_evex () at ../sysdeps/x86_64/multiarch/strlen-evex-base.S:81",
      "#1  __pthread_kill_internal (signo=6, threadid=<optimized out>) at ./nptl/pthread_kill.c:78",
      "#2  0x0000556b92662205 in name_length (name=0x0) at multi.c:5",
      "#3  0x00007f2dffc288ff in abort () from /lib/x86_64-linux-gnu/libc.so.6",
      "@@crashlens@@insn",
      "=> 0x556fdda1b1da <sum+49>:\tmov    (%rax),%eax",
      "   0x556fdda1b1dc <sum+51>:\tadd    %eax,-0x8(%rbp)",
    ].join("\n");
    const report = parseGdbOutput(
      stdout,
      "warning: core file may not match specified executable file.\n",
    );
    assert.equal(report.status, "ok");
    if (report.status !== "ok") return;
    assert.deepEqual(
      report.frames.map((frame) => [frame.index, frame.function, frame.source]),
      [
        [
          0,
          "__strlen_evex",
          "../sysdeps/x86_64/multiarch/strlen-evex-base.S:81",
        ],
        [1, "__pthread_kill_internal", "./nptl/pthread_kill.c:78"],
        [2, "name_length", "multi.c:5"],
        [3, "abort", "/lib/x86_64-linux-gnu/libc.so.6"],
      ],
    );
    assert.equal(report.frames[1]?.address, null);
    assert.deepEqual(
      report.instructions.map((insn) => insn.isFault),
      [true, false],
    );
    assert.equal(report.warnings.length, 1);
  });
});

describe("REA evidence parsers", () => {
  it("extract only the facts triage uses and reject malformed evidence", () => {
    const crash = parseRecordedCrash({
      evidence_id: "ev_1",
      normalized_result: {
        artifact: { sha256: "a".repeat(64) },
        threads: [
          { historical_pid: 9, registers: [{ name: "rip", value: "0x10" }] },
        ],
        signals: [{ number: 11, code: 1, fault_address: "0x0" }],
        segments: [
          { type: "PT_NOTE" },
          {
            type: "PT_LOAD",
            virtual_address: "0x1000",
            memory_size: "0x1000",
            flags: "0x5",
          },
        ],
        notes: [
          {
            type: "NT_FILE",
            descriptor_bytes_base64: Buffer.from(mappings(0x1000n)).toString(
              "base64",
            ),
          },
        ],
        limitations: ["recorded only"],
      },
    });
    assert.equal(crash.registers[0]?.value, 0x10n);
    assert.equal(crash.signal?.faultAddress, 0n);
    assert.equal(crash.loadSegments.length, 1);
    assert.ok(crash.ntFileDescriptor && parseNtFile(crash.ntFileDescriptor).ok);
    assert.throws(() =>
      parseRecordedCrash({
        evidence_id: "ev",
        normalized_result: { artifact: {} },
      }),
    );

    const parsedLayout = parseBinaryLayout({
      evidence_id: "ev_2",
      normalized_result: {
        artifact: { sha256: "b".repeat(64) },
        image_type: "ET_DYN",
        segments: [{ type: "PT_LOAD", offset: "0x0", virtual_address: "0x0" }],
        symbols: [
          {
            name: { display: "sum" },
            type: "STT_FUNC",
            value_meaning: "linked-virtual-address",
            value: "0x11a9",
            size: "0x4b",
          },
          {
            name: { display: "tls" },
            type: "STT_FUNC",
            value_meaning: "tls-offset",
            value: "0x0",
            size: "0x8",
          },
          {
            name: { display: "data" },
            type: "STT_OBJECT",
            value_meaning: "linked-virtual-address",
            value: "0x4000",
            size: "0x8",
          },
        ],
        mitigations: null,
      },
    });
    assert.deepEqual(
      parsedLayout.functions.map((fn) => fn.name),
      ["sum"],
    );
  });
});

describe("buildReport", () => {
  it("produces an issue whose signature survives ASLR", () => {
    const first = buildReport(
      { corePath: "/c", binaryPath: "/b/parser" },
      crashAt(0x556fdda1a000n),
      layout,
      gdbAt(0x556fdda1a000n),
    );
    const second = buildReport(
      { corePath: "/c", binaryPath: "/b/parser" },
      crashAt(0x5600aa000000n),
      layout,
      gdbAt(0x5600aa000000n),
    );
    assert.ok(first.ok && second.ok);
    assert.equal(first.value.signature, second.value.signature);
    assert.deepEqual(
      first.value.relevantRegisters.map((entry) => entry.name),
      ["rax"],
    );
    const markdown = renderIssueMarkdown(toCoreIssue(first.value));
    assert.match(markdown, /^# Crash: NULL pointer dereference in `sum\+0x31`/);
    assert.match(markdown, /#1 0x556fdda1b26a\s+main\+0x75/);
    assert.match(markdown, /`rax` = `0x0` ← NULL/);
  });

  it("points at the caller in the user's binary when the crash is in a library", () => {
    const base = 0x556fdda1a000n;
    const gdb: GdbReport = {
      status: "ok",
      frames: [
        {
          index: 0,
          address: 0x7f0000030000n,
          function: "__strlen_evex",
          source: null,
        },
        {
          index: 1,
          address: base + 0x126an,
          function: "main",
          source: "parser.c:13",
        },
      ],
      instructions: [],
      warnings: [],
    };
    const crash = {
      ...crashAt(base),
      registers: [{ name: "rip", value: 0x7f0000030000n }],
    };
    const report = buildReport(
      { corePath: "/c", binaryPath: "/b/parser" },
      crash,
      layout,
      gdb,
    );
    assert.ok(report.ok);
    assert.equal(report.value.firstOwnFrame?.index, 1);
    const markdown = renderIssueMarkdown(toCoreIssue(report.value));
    assert.match(markdown, /in `main\+0x75`/);
    assert.match(markdown, /inside `__strlen_evex`, called from `main\+0x75`/);
    assert.match(markdown, /\| Source \| `parser.c:13` \|/);
  });

  it("fails clearly when the core has no file mappings", () => {
    const report = buildReport(
      { corePath: "/c", binaryPath: "/b/parser" },
      { ...crashAt(0n), ntFileDescriptor: null },
      layout,
      { status: "unavailable", reason: "test" },
    );
    assert.equal(report.ok, false);
    if (!report.ok) assert.equal(report.error.tag, "unsupported_crash");
  });
});
