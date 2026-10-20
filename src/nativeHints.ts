import { hex } from "./symbolize.js";
import type { TriageReport } from "./triage.js";

/**
 * Hypotheses read off a core triage report: register values that are fill
 * patterns rather than pointers, and a use after free visible in the
 * decompiled crash function or its caller. Static and labelled as guesses.
 */
export function nativeHypotheses(report: TriageReport): string[] {
  const out: string[] = [];
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
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j] as string;
      if (new RegExp(`^${pointer}\\s*=[^=]`).test(line)) break;
      if (word.test(line))
        return { free: lines[i] as string, pointer, use: line, between: lines.slice(i + 1, j) };
    }
  }
  return null;
}
