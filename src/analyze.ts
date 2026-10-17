import { readFileSync } from "node:fs";
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
    bytes = readFileSync(path === "-" ? 0 : path);
  } catch (error) {
    return { ok: false, message: `Could not read ${path}: ${(error as Error).message}` };
  }
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
      log = readFileSync(input.logPath, "utf8");
    } catch (error) {
      return { ok: false, message: `Could not read ${input.logPath}: ${(error as Error).message}` };
    }
    issue = withLog(issue, logContext(log, log.length));
  }
  return { ok: true, issue, details: coreDetails(result.value) };
}
