import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseObjdump } from "../src/disasm.js";
import { traceNullCall } from "../src/nullCall.js";

const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "native");

const listing = (text: string) => parseObjdump(text.replace(/^ *([0-9a-f]+): /gm, "  $1:\t"));

describe("traceNullCall", () => {
  it("finds the unguarded fallback load in binutils PR 31872 (elf_slurp_reloc_table_from_section)", () => {
    // objdump of a stripped binutils 2.42 objdump; the call returns to 0x88061f.
    const lines = parseObjdump(readFileSync(join(fixtures, "binutils-pr31872-slurp-reloc.objdump"), "utf8"));
    const trace = traceNullCall(lines, 0x88061fn);
    assert.ok(trace !== null);
    assert.equal(trace.callText, "call *%rax");
    assert.equal(trace.register, "rax");
    assert.equal(trace.guardedPaths, 3);
    assert.equal(trace.sources.length, 1);
    const [source] = trace.sources;
    assert.ok(source !== undefined && source.kind === "load");
    assert.equal(source.address, 0x880710n);
    assert.equal(source.base, "r13");
    assert.equal(source.offset, 0x48n);
    assert.equal(source.baseChanged, false);
    assert.deepEqual(
      [...new Set(source.reachedWhenNull.map((check) => `${check.base}+${check.offset}`))],
      ["r13+80"],
    );
  });

  it("reads the slot straight from a memory-operand call", () => {
    const trace = traceNullCall(
      listing(`
  1170: mov %edi,%esi
  1172: mov $0x3,%edi
  1179: call *0x10(%rbx)
  117c: add 0xc(%rbx),%eax
`),
      0x117cn,
    );
    assert.deepEqual(trace?.slot && { base: trace.slot.base, offset: trace.slot.offset }, { base: "rbx", offset: 0x10n });
  });

  it("notices when the base register changes after the load", () => {
    const trace = traceNullCall(
      listing(`
  1000: mov 0x18(%rdi),%rax
  1004: mov %esi,%edi
  1006: call *%rax
  1008: ret
`),
      0x1008n,
    );
    const source = trace?.sources[0];
    assert.ok(source !== undefined && source.kind === "load");
    assert.equal(source.baseChanged, true);
  });

  it("reports nothing to trace when every path tests the register first", () => {
    const trace = traceNullCall(
      listing(`
  2000: mov 0x8(%rbx),%rax
  2004: test %rax,%rax
  2007: je 2010
  2009: call *%rax
  200b: ret
  2010: xor %eax,%eax
  2012: ret
`),
      0x200bn,
    );
    assert.equal(trace?.guardedPaths, 1);
    assert.deepEqual(trace?.sources, []);
  });

  it("ignores direct calls", () => {
    assert.equal(traceNullCall(listing("  3000: call 4000\n  3005: ret\n"), 0x3005n), null);
  });
});
