import { execFile } from "node:child_process";

export interface DisasmLine {
  /** Link-time address. */
  readonly address: bigint;
  readonly text: string;
  /** The faulting instruction, or the call a caller frame returns to. */
  readonly marked: boolean;
}

const OBJDUMP_TIMEOUT_MS = 30_000;
const BEFORE = 16;
const AFTER = 4;

/**
 * Disassemble one function of the binary on disk with objdump (static: reads
 * the file, never runs it) and keep a window around `target`. The marked line
 * is the instruction containing `target`. Returns null when objdump is missing
 * or prints nothing for the range.
 */
export function disassembleAround(
  binaryPath: string,
  start: bigint,
  end: bigint,
  target: bigint,
  objdump = "objdump",
): Promise<DisasmLine[] | null> {
  const args = [
    "-d",
    "--no-show-raw-insn",
    "--wide",
    `--start-address=0x${start.toString(16)}`,
    `--stop-address=0x${end.toString(16)}`,
    "--",
    binaryPath,
  ];
  return new Promise((resolve) => {
    execFile(objdump, args, { timeout: OBJDUMP_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      resolve(windowAround(parseObjdump(stdout), target));
    });
  });
}

/** Exported for tests: instruction lines of `objdump -d --no-show-raw-insn`. */
export function parseObjdump(output: string): { address: bigint; text: string }[] {
  const lines: { address: bigint; text: string }[] = [];
  for (const line of output.split("\n")) {
    const match = /^\s+([0-9a-f]+):\s+(.+?)\s*$/.exec(line);
    if (match === null) continue;
    // objdump names targets after the nearest symbol; in a stripped binary that is
    // often an unrelated PLT stub ("<usleep@plt+0x135>"), so drop offset labels.
    const text = (match[2] as string).replace(/\s+/g, " ").replace(/ <[^>]*\+0x[0-9a-f]+>/g, "");
    if (text === "(bad)" || text.startsWith("...")) continue;
    lines.push({ address: BigInt(`0x${match[1]}`), text });
  }
  return lines;
}

/** Exported for tests: a window ending a few instructions after the one containing `target`. */
export function windowAround(lines: readonly { address: bigint; text: string }[], target: bigint): DisasmLine[] | null {
  if (lines.length === 0) return null;
  let index = -1;
  for (let i = 0; i < lines.length; i++) if ((lines[i] as { address: bigint }).address <= target) index = i;
  if (index === -1) return null;
  return lines
    .slice(Math.max(0, index - BEFORE), index + AFTER + 1)
    .map((line) => ({ ...line, marked: line === lines[index] }));
}
