import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { describe, it } from "node:test";
import { toCoreIssue } from "../src/coreIssue.js";
import { parseObjdump, windowAround } from "../src/disasm.js";
import { binaryBuildId, functionRanges, rangeFor } from "../src/elf.js";
import type { GdbReport } from "../src/gdb.js";
import { renderIssueMarkdown } from "../src/issue.js";
import { parseNtFile } from "../src/ntFile.js";
import type { BinaryLayout, RecordedCrash } from "../src/rea.js";
import { createSymbolizer } from "../src/symbolize.js";
import { buildReport, type FileFacts, type TriageReport } from "../src/triage.js";

/** A stripped PIE: no function symbols, so names must come from .eh_frame. */
const base = 0x556fdda1a000n;
const stripped: BinaryLayout = {
  evidenceId: "ev_layout",
  binarySha256: "b".repeat(64),
  imageType: "ET_DYN",
  loadSegments: [
    { offset: 0x0n, virtualAddress: 0x0n },
    { offset: 0x1000n, virtualAddress: 0x1000n },
  ],
  functions: [],
  mitigations: null,
};

function ntFile(entries: [bigint, bigint, bigint, string][]): Uint8Array {
  const names = Buffer.concat(entries.map(([, , , path]) => Buffer.from(`${path}\0`)));
  const table = Buffer.alloc(16 + 24 * entries.length);
  table.writeBigUInt64LE(BigInt(entries.length), 0);
  table.writeBigUInt64LE(0x1000n, 8);
  entries.forEach(([start, end, page], i) => {
    table.writeBigUInt64LE(start, 16 + 24 * i);
    table.writeBigUInt64LE(end, 24 + 24 * i);
    table.writeBigUInt64LE(page, 32 + 24 * i);
  });
  return new Uint8Array(Buffer.concat([table, names]));
}

const crash: RecordedCrash = {
  evidenceId: "ev_crash",
  coreSha256: "c".repeat(64),
  historicalPid: 7,
  registers: [
    { name: "rax", value: 0n },
    { name: "rip", value: base + 0x11dan },
    { name: "rsp", value: 0x7ffe06dafec0n },
  ],
  signal: { number: 11, code: 1, faultAddress: 0n },
  loadSegments: [],
  ntFileDescriptor: ntFile([
    [base, base + 0x1000n, 0n, "/srv/app/parser"],
    [base + 0x1000n, base + 0x2000n, 1n, "/srv/app/parser"],
  ]),
  limitations: [],
};

const gdb: GdbReport = {
  status: "ok",
  frames: [
    { index: 0, address: base + 0x11dan, function: "??", source: null },
    { index: 1, address: base + 0x126an, function: "??", source: null },
  ],
  instructions: [{ address: base + 0x11dan, isFault: true, text: "0x1:\tmov    (%rax),%eax" }],
  warnings: [],
};

const unwindRanges = [
  { start: 0x11a9n, end: 0x11f4n },
  { start: 0x11f4n, end: 0x12a2n },
];

function facts(status: FileFacts["buildId"]["status"]): FileFacts {
  const id = "ab".repeat(20);
  return {
    unwindRanges,
    buildId:
      status === "unknown"
        ? { binary: id, core: null, status }
        : { binary: id, core: status === "match" ? id : "cd".repeat(20), status },
  };
}

function report(status: FileFacts["buildId"]["status"]): TriageReport {
  const result = buildReport({ corePath: "/c", binaryPath: "/b/parser" }, crash, stripped, gdb, facts(status));
  assert.ok(result.ok);
  return result.value;
}

describe("stripped binaries", () => {
  it("names functions sub_<address> from .eh_frame when the symbol table has none", () => {
    const parsed = parseNtFile(crash.ntFileDescriptor as Uint8Array);
    assert.ok(parsed.ok);
    const symbolizer = createSymbolizer("/b/parser", parsed.mappings, stripped, unwindRanges);
    assert.equal(symbolizer.imageBase, base);
    const location = symbolizer.locate(base + 0x11dan);
    assert.equal(location.kind, "binary-function");
    if (location.kind !== "binary-function") return;
    assert.equal(location.symbol.name, "sub_11a9");
    assert.equal(location.symbol.origin, "eh_frame");
    assert.equal(location.symbolOffset, 0x31n);
    // Outside every unwind range: no invented name.
    assert.equal(symbolizer.locate(base + 0x1fffn).kind, "binary");
  });

  it("reports a matching build ID and explains the sub_ names", () => {
    const value = report("match");
    assert.deepEqual(value.focus, {
      name: "sub_11a9",
      start: 0x11a9n,
      end: 0x11f4n,
      target: 0x11dan,
      reason: "fault",
      fromUnwindTables: true,
    });
    const markdown = renderIssueMarkdown(toCoreIssue(value));
    assert.match(markdown, /^# Crash: NULL pointer dereference in `sub_11a9\+0x31`/);
    assert.match(markdown, /#1 0x556fdda1b26a\s+sub_11f4\+0x75/);
    assert.match(markdown, /\| Build ID \| matches the core/);
    assert.match(markdown, /GNU build ID matches the image recorded in the core/);
    assert.match(markdown, /sub_<address> names mark functions found in the binary's \.eh_frame/);
    assert.equal(value.warnings.length, 0);
  });

  it("warns loudly on a build ID mismatch", () => {
    const value = report("mismatch");
    assert.match(value.warnings[0] ?? "", /^Build ID mismatch: the binary is abab.* but the crashed process ran cdcd/);
    const markdown = renderIssueMarkdown(toCoreIssue(value));
    assert.match(markdown, /\| Build ID \| \*\*mismatch\*\*/);
    assert.match(markdown, /likely describes the wrong build/);
  });

  it("finds a renamed binary by build ID and says so", () => {
    const result = buildReport({ corePath: "/c", binaryPath: "/local/renamed" }, crash, stripped, gdb, { ...facts("match"), mappedName: "parser" });
    assert.ok(result.ok);
    assert.equal(result.value.program, "parser");
    assert.equal(result.value.faultLocation?.kind, "binary-function");
    assert.match(result.value.warnings.join("\n"), /named "renamed" here but ran as "parser"; matched by build ID/);
    // Without the build-ID match, the renamed binary is not found in the core at all.
    const unmatched = buildReport({ corePath: "/c", binaryPath: "/local/renamed" }, crash, stripped, gdb, facts("unknown"));
    assert.ok(unmatched.ok);
    assert.equal(unmatched.value.faultLocation?.kind, "other-module");
  });

  it("falls back to the file-name caveat when the build ID cannot be compared", () => {
    const markdown = renderIssueMarkdown(toCoreIssue(report("unknown")));
    assert.doesNotMatch(markdown, /\| Build ID \|/);
    assert.match(markdown, /matched to the core by file name only/);
  });

  it("shows the crashing function's code and decompiled pseudocode when present", () => {
    const value: TriageReport = {
      ...report("match"),
      disassembly: [
        { address: 0x11d6n, text: "mov 0x8(%rax),%rax", marked: false },
        { address: 0x11dan, text: "mov (%rax),%eax", marked: true },
      ],
      decompiled: [
        { evidenceId: "ev_decomp", pseudocode: "long FUN_001011a9(long p)\n{\n  return *(long *)(p + 8);\n}", provider: "ghidra", address: 0x1011a9n, name: "sub_11a9", role: "crash" },
        { evidenceId: "ev_caller", pseudocode: "int FUN_001011f4(void)\n{\n  free(p);\n  return FUN_001011a9(p);\n}", provider: "ghidra", address: 0x1011f4n, name: "sub_11f4", role: "caller" },
      ],
    };
    const markdown = renderIssueMarkdown(toCoreIssue(value));
    assert.match(markdown, /## Function around the fault: `sub_11a9`/);
    assert.match(markdown, /no symbol; boundaries from \.eh_frame/);
    assert.match(markdown, /=> 0x11da: mov \(%rax\),%eax/);
    assert.match(markdown, /## Decompiled `sub_11a9` \(REA \+ ghidra: decompiler output, not your source\)/);
    assert.match(markdown, /return \*\(long \*\)\(p \+ 8\);/);
    assert.match(markdown, /decompilation of sub_11a9 `ev_decomp`, decompilation of sub_11f4 `ev_caller`/);
    assert.match(markdown, /## Decompiled caller `sub_11f4`/);
    assert.match(markdown, /free\(p\);/);
    // The whole function replaces gdb's short window after the fault.
    assert.doesNotMatch(markdown, /## Instructions at the fault/);
  });
});

describe("disassembly window", () => {
  const output = `
Disassembly of section .text:

000000000000120a <.text+0xea>:
    120a:\tendbr64
    121e:\tjmp    1225 <usleep@plt+0x135>
    1229:\tmov    0x8(%rax),%rdx
    1234:\tmovzbl (%rax),%eax
    1237:\ttest   %al,%al
    1239:\tcall   1090 <__assert_fail@plt>
`;
  it("parses instructions and drops misleading nearest-symbol labels", () => {
    const lines = parseObjdump(output);
    assert.deepEqual(
      lines.map((line) => line.text),
      ["endbr64", "jmp 1225", "mov 0x8(%rax),%rdx", "movzbl (%rax),%eax", "test %al,%al", "call 1090 <__assert_fail@plt>"],
    );
  });

  it("marks the instruction containing the target, including a return-address minus one", () => {
    const lines = parseObjdump(output);
    assert.equal(windowAround(lines, 0x1234n)?.find((line) => line.marked)?.address, 0x1234n);
    // A caller frame looks up return_address - 1, inside the call instruction.
    assert.equal(windowAround(lines, 0x1236n)?.find((line) => line.marked)?.address, 0x1234n);
    assert.equal(windowAround(lines, 0x1000n), null);
  });
});

describe("rangeFor", () => {
  it("finds the containing range and respects known ends", () => {
    assert.equal(rangeFor(unwindRanges, 0x11a9n)?.start, 0x11a9n);
    assert.equal(rangeFor(unwindRanges, 0x11f3n)?.start, 0x11a9n);
    assert.equal(rangeFor(unwindRanges, 0x12a2n), null);
    assert.equal(rangeFor(unwindRanges, 0x1000n), null);
    assert.equal(rangeFor([{ start: 0x10n, end: null }], 0x99n)?.start, 0x10n);
  });
});

// /bin/ls is stripped on mainstream distros and still carries .eh_frame_hdr and a build ID.
const systemBinary = "/bin/ls";
describe("ELF readers on a real stripped binary", { skip: (process.platform !== "linux" || !existsSync(systemBinary)) && "needs Linux /bin/ls" }, () => {
  it("reads sorted function ranges from .eh_frame_hdr", async () => {
    const ranges = await functionRanges(systemBinary);
    assert.ok(ranges.length > 20, `only ${ranges.length} ranges`);
    for (let i = 1; i < ranges.length; i++) assert.ok((ranges[i - 1] as { start: bigint }).start <= (ranges[i] as { start: bigint }).start);
    assert.ok(ranges.filter((r) => r.end !== null && r.end > r.start).length > ranges.length / 2);
  });

  it("reads the GNU build ID", async () => {
    const id = await binaryBuildId(systemBinary);
    assert.match(id ?? "", /^[0-9a-f]{40}$/);
  });
});
