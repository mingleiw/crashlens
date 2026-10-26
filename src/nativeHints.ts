import { hex } from "./symbolize.js";
import type { SlotReading, TriageReport } from "./triage.js";

/**
 * Hypotheses read off a core triage report: register values that are fill
 * patterns rather than pointers, and a use after free visible in the
 * decompiled crash function or its caller. Static and labelled as guesses.
 */
export function nativeHypotheses(report: TriageReport): string[] {
  const out: string[] = [];
  const nullCall = nullCallHypothesis(report);
  if (nullCall !== null) out.push(nullCall);
  const fills = new Map<number, string>();
  for (const reg of report.relevantRegisters) {
    const byte = repeatedByte(reg.value);
    if (byte === null) continue;
    fills.set(byte, reg.name);
    const ch = byte >= 0x20 && byte < 0x7f ? ` ('${String.fromCharCode(byte)}')` : "";
    out.push(
      `**Overwritten memory.** \`${reg.name}\` = \`${hex(reg.value)}\` is the byte \`0x${byte.toString(16)}\`${ch} repeated: not a pointer the program computed, but memory filled by \`memset\`, a string copy or input data. The object it was loaded from was overwritten, often after it was freed and its memory reused.`,
    );
  }
  for (const fn of report.decompiled) {
    const uaf = useAfterFree(fn.pseudocode);
    if (uaf === null) continue;
    const fill = uaf.between.find((line) => [...fills.keys()].some((b) => fillsWith(line, b)));
    out.push(
      `**Use after free.** The decompiled ${fn.role === "caller" ? "caller " : ""}\`${fn.name}\` calls \`${uaf.free}\` and later uses \`${uaf.pointer}\` again: \`${uaf.use}\`.${fill === undefined ? "" : ` In between, \`${fill}\` writes the same byte as the bad register: the freed chunk was handed out again and overwritten.`} Fix the lifetime (free after the last use, or clear the pointer), not the crashing call.`,
    );
  }
  return out;
}

/** The byte when all 8 (or the low 4) bytes are the same and it is not 0x00 or 0xff. */
function repeatedByte(value: bigint): number | null {
  const byte = Number(value & 0xffn);
  if (byte === 0 || byte === 0xff) return null;
  const pattern = (n: number) => [...Array(n).keys()].reduce((v, i) => v | (BigInt(byte) << BigInt(8 * i)), 0n);
  return value === pattern(8) || value === pattern(4) ? byte : null;
}

function fillsWith(line: string, byte: number): boolean {
  const m = /memset\s*\([^,]+,\s*(0x[0-9a-f]+|\d+|'.')/i.exec(line);
  if (m === null) return false;
  const arg = m[1] as string;
  const value = arg.startsWith("'") ? arg.charCodeAt(1) : Number(arg);
  return value === byte;
}

function useAfterFree(pseudocode: string): { free: string; pointer: string; use: string; between: string[] } | null {
  const lines = pseudocode.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const freed = /\bfree\s*\(\s*(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\)/.exec(lines[i] as string);
    if (freed === null) continue;
    const pointer = freed[1] as string;
    const word = new RegExp(`\\b${pointer}\\b`);
    // The block that frees may leave before any later use: `if (err) { free(p); return -1; }`.
    const exits = /\b(?:return|goto|break|continue|exit|abort|longjmp)\b/;
    const after = (lines[i] as string).slice((freed.index ?? 0) + freed[0].length);
    const beforeClose = after.split("}")[0] ?? "";
    if (exits.test(beforeClose)) continue;
    let depth = after.includes("}") ? -1 : 0;
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (new RegExp(`^${pointer}\\s*=[^=]`).test(line)) break;
      if (word.test(line)) return { free: lines[i] as string, pointer, use: line, between: lines.slice(i + 1, j) };
      // Still inside the block that freed, and it leaves: this path never reaches a later use.
      if (depth >= 0 && exits.test(line.split("}")[0] ?? "")) break;
      for (const ch of line) depth += ch === "{" ? 1 : ch === "}" ? -1 : 0;
    }
  }
  return null;
}

const at = (line: string | null) => (line === null ? "" : ` (\`${line}\`)`);
const slotName = (reading: SlotReading) => `[${reading.slot.base}${reading.slot.offset === 0n ? "" : `+${hex(reading.slot.offset)}`}]`;
const slotValue = (reading: SlotReading) =>
  reading.value === null ? "not recorded in the core" : reading.value === 0n ? "0 (NULL) in the core" : `\`${hex(reading.value)}\` in the core`;

/** Where a NULL function pointer was loaded, and what the core says about that slot. */
function nullCallHypothesis(report: TriageReport): string | null {
  const nullCall = report.nullCall ?? null;
  if (nullCall === null) return null;
  const { trace } = nullCall;
  const call = `\`${trace.callText}\` at \`${hex(trace.callAddress)}\` in \`${nullCall.caller}\``;
  const targets = nullCall.slots.filter((reading) => reading.role === "target");
  const checks = nullCall.slots.filter((reading) => reading.role === "check");
  if (targets.length === 0) {
    if (trace.sources.length === 0) return null;
    const how = trace.sources.map((source) => `\`${source.text}\` at \`${hex(source.address)}\``).join(", ");
    return `**NULL function pointer.** ${call} called \`${trace.register}\` = 0, set by ${how} on the path${trace.sources.length > 1 ? "s" : ""} that do not test it for NULL first.`;
  }
  const target = targets[0] as SlotReading;
  const parts = [
    `**NULL function pointer${target.builtIn ? " from a table built into the binary" : ""}.** ${call} called ${trace.register === null ? "a NULL slot" : `\`${trace.register}\` = 0`}.`,
  ];
  if (trace.register !== null) {
    const load = trace.sources.find((source) => source.kind === "load" && source.address === target.slot.address);
    const guarded = trace.guardedPaths > 0 ? `${trace.guardedPaths} of the ${trace.guardedPaths + trace.sources.length} paths into that call test \`${trace.register}\` for NULL first; the` : "The";
    const checkLines = [...new Set(checks.flatMap((check) => (check.line === null ? [] : [check.line])))];
    parts.push(`${guarded} unguarded one loads it with \`${target.slot.text}\` at \`${hex(target.slot.address)}\`${at(target.line)}${load !== undefined && load.kind === "load" && load.reachedWhenNull.length > 0 ? `, which runs only when ${[...new Set(load.reachedWhenNull.map((check) => `\`[${check.base}${check.offset === 0n ? "" : `+${hex(check.offset)}`}]\``))].join(" or ")} was NULL${checkLines.length === 0 ? "" : ` (checked at ${checkLines.map((line) => `\`${line}\``).join(", ")})`}: a fallback` : ""}.`);
    const callLine = report.firstOwnFrame?.source ?? null;
    if (target.line !== null && callLine !== null && !callLine.endsWith(target.line.replace(/^.*\//, "/")) && !callLine.endsWith(`:${target.line.split(":").pop()}`))
      parts.push(`The backtrace puts the call at \`${callLine}\` because the compiler shares one call instruction between branches; the NULL target is the one loaded at \`${target.line}\`.`);
  }
  if (target.baseValue !== null)
    parts.push(`\`${target.slot.base}\` = \`${hex(target.baseValue)}\` points into ${target.region ?? "unknown memory"}; \`${slotName(target)}\` is ${slotValue(target)}${checks.length === 0 ? "" : `, and ${checks.map((check) => `\`${slotName(check)}\` is ${slotValue(check)}`).join(", ")}`}.`);
  const allNull = [target, ...checks].every((reading) => reading.value === 0n);
  if (target.builtIn)
    parts.push(
      `That memory is a table the program was built with, not heap data, so this is not memory corruption: ${allNull && checks.length > 0 ? "none of the handlers this code tries is set in that table, and the fallback calls the last one without checking it" : "the entry was never filled in"}. Fix the table (add the missing entry) or make the code check for it before calling; do not just guard the crash.`,
    );
  else if (target.region === "memory not backed by a file (heap or mmap)")
    parts.push("That is a runtime object: find where this field is set, and whether the object was fully initialized or already freed when it was called.");
  return parts.join(" ");
}
