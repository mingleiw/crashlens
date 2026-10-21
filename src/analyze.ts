import { closeSync, openSync, readSync, statSync } from "node:fs";
import { MAX_TEXT_BYTES } from "./fileKind.js";
import { coreDetails, toCoreIssue } from "./coreIssue.js";
import { parseFailure } from "./failure.js";
import { logContext, toFailureIssue } from "./failureIssue.js";
import { withLog, type Issue } from "./issue.js";
import type { ReaCommand } from "./rea.js";
import { triage } from "./triage.js";

/** One analyzed failure, or why it could not be analyzed. Shared by the CLI and the MCP server. */
export type Analysis =
  | { readonly ok: true; readonly issue: Issue; readonly details: unknown }
  | { readonly ok: false; readonly message: string };

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

/** A panic, exception or sanitizer report in text. */
export function analyzeText(text: string, name: string): Analysis {
  const parsed = parseFailure(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  return { ok: true, issue: toFailureIssue(parsed.value, name, text), details: parsed.value };
}

/** A saved log (or "-" for stdin). Core dumps are refused with a hint to pass the binary. */
export function analyzeFile(path: string): Analysis {
  let bytes: Buffer;
  try {
    if (path !== "-" && !statSync(path).isFile()) return { ok: false, message: `${path} is not a regular file.` };
    bytes = readLimited(path === "-" ? 0 : path, "head");
  } catch (error) {
    return { ok: false, message: `Could not read ${path}: ${(error as Error).message}` };
  }
  if (bytes.length > MAX_TEXT_BYTES)
    return { ok: false, message: `${path} is larger than ${MAX_TEXT_BYTES / 1024 / 1024} MiB; pass the part around the failure.` };
  if (bytes.subarray(0, 4).equals(ELF_MAGIC))
    return {
      ok: false,
      message: `${path} is an ELF file. For a core dump, also pass the binary that crashed: crashlens ${path} <binary>`,
    };
  return analyzeText(bytes.toString("utf8"), path === "-" ? "stdin" : path);
}

export interface CoreInput {
  readonly corePath: string;
  readonly binaryPath: string;
  /** Application log whose last lines are attached to the report. */
  readonly logPath?: string | undefined;
  readonly rea: ReaCommand;
  readonly gdb: string | null;
  /** REA + Ghidra pseudocode of the crashing function; "auto" decompiles stripped functions when Ghidra is set up. */
  readonly decompile?: boolean | "auto";
  readonly decompileCaller?: boolean;
}

/** A Linux core dump plus the binary that crashed. Paths must be absolute. */
export async function analyzeCore(input: CoreInput): Promise<Analysis> {
  const result = await triage({ corePath: input.corePath, binaryPath: input.binaryPath, rea: input.rea, gdb: input.gdb, decompile: input.decompile ?? "auto", decompileCaller: input.decompileCaller ?? true });
  if (!result.ok) return { ok: false, message: result.error.message };
  let issue = toCoreIssue(result.value);
  if (input.logPath !== undefined) {
    let log: string;
    try {
      if (!statSync(input.logPath).isFile()) throw new Error("not a regular file");
      // Only the end of a long log matters: its last lines are shown.
      log = readLimited(input.logPath, "tail").toString("utf8");
    } catch (error) {
      return { ok: false, message: `Could not read ${input.logPath}: ${(error as Error).message}` };
    }
    issue = withLog(issue, logContext(log, log.length));
  }
  return { ok: true, issue, details: coreDetails(result.value) };
}

/**
 * At most MAX_TEXT_BYTES + 1 bytes of a file or stdin (fd 0): from the start,
 * or the last MAX_TEXT_BYTES of a regular file for "tail". One byte over the
 * limit tells "head" callers the input was too large.
 */
function readLimited(path: string | 0, from: "head" | "tail"): Buffer {
  const fd = path === 0 ? 0 : openSync(path, "r");
  try {
    const size = path === 0 ? Infinity : statSync(path).size;
    let position = from === "tail" && size > MAX_TEXT_BYTES ? size - MAX_TEXT_BYTES : 0;
    const limit = from === "tail" ? MAX_TEXT_BYTES : MAX_TEXT_BYTES + 1;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < limit) {
      const chunk = Buffer.alloc(Math.min(1 << 16, limit - total));
      let n: number;
      try {
        n = readSync(fd, chunk, 0, chunk.length, path === 0 ? null : position);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EAGAIN") continue;
        throw error;
      }
      if (n === 0) break;
      chunks.push(chunk.subarray(0, n));
      total += n;
      position += n;
    }
    return Buffer.concat(chunks);
  } finally {
    if (path !== 0) closeSync(fd);
  }
}
