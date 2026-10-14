import { execFile } from "node:child_process";

export interface GdbFrame {
  readonly index: number;
  /** Absent for inlined frames and when gdb omits the address. */
  readonly address: bigint | null;
  readonly function: string;
  readonly source: string | null;
}

export interface GdbInstruction {
  readonly address: bigint;
  readonly isFault: boolean;
  readonly text: string;
}

export type GdbReport =
  | {
      readonly status: "ok";
      readonly frames: readonly GdbFrame[];
      readonly instructions: readonly GdbInstruction[];
      /** gdb warnings worth surfacing, e.g. a core/executable mismatch. */
      readonly warnings: readonly string[];
    }
  | { readonly status: "unavailable" | "failed"; readonly reason: string };

const GDB_TIMEOUT_MS = 60_000;
const MAX_FRAMES = 32;
const MARK = "@@crashlens@@";

/**
 * Load the binary and core in batch mode. gdb never starts the program:
 * `core-file` only reads recorded memory. Auto-loading of scripts from the
 * target and debuginfod network lookups are disabled.
 */
export function inspectWithGdb(
  binaryPath: string,
  corePath: string,
  gdbPath = "gdb",
): Promise<GdbReport> {
  const args = [
    "-batch",
    "-nx",
    "-iex",
    "set auto-load off",
    "-iex",
    "set debuginfod enabled off",
    "-ex",
    "set pagination off",
    "-ex",
    "set width 0",
    "-ex",
    `echo ${MARK}bt\\n`,
    "-ex",
    `bt ${MAX_FRAMES}`,
    "-ex",
    `echo ${MARK}insn\\n`,
    "-ex",
    "x/6i $pc",
    // Positional `<program> <core>` avoids gdb's command-line quoting rules.
    "--",
    binaryPath,
    corePath,
  ];
  return new Promise((resolve) => {
    execFile(
      gdbPath,
      args,
      { timeout: GDB_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error && "code" in error && error.code === "ENOENT") {
          resolve({
            status: "unavailable",
            reason: `${gdbPath} not found on PATH`,
          });
          return;
        }
        if (!stdout.includes(`${MARK}bt`) || /^No stack\.$/m.test(stderr)) {
          resolve({
            status: "failed",
            reason: (
              stderr ||
              error?.message ||
              "gdb produced no output"
            ).trim(),
          });
          return;
        }
        resolve(parseGdbOutput(stdout, stderr));
      },
    );
  });
}

/** Exported for tests. */
export function parseGdbOutput(stdout: string, stderr: string): GdbReport {
  const sections = new Map<string, string[]>();
  let current = "preamble";
  for (const line of stdout.split("\n")) {
    if (line.startsWith(MARK)) {
      current = line.slice(MARK.length).trim();
      continue;
    }
    const lines = sections.get(current) ?? [];
    lines.push(line);
    sections.set(current, lines);
  }
  return {
    status: "ok",
    frames: (sections.get("bt") ?? []).flatMap(parseFrame),
    instructions: (sections.get("insn") ?? []).flatMap(parseInstruction),
    warnings: [...(sections.get("preamble") ?? []), ...stderr.split("\n")]
      .map((line) => line.trim())
      .filter((line) =>
        /core file may not match|not in executable format|warning: .*(mismatch|does not match)/i.test(
          line,
        ),
      ),
  };
}

const FRAME =
  /^#(\d+)\s+(?:(0x[0-9a-f]+) in )?(\S+) \(.*?\)(?: (?:at|from) (.+))?$/i;

function parseFrame(line: string): GdbFrame[] {
  const match = FRAME.exec(line.trim());
  if (match === null) return [];
  return [
    {
      index: Number(match[1]),
      address: match[2] === undefined ? null : BigInt(match[2]),
      function: match[3] ?? "??",
      source: match[4] ?? null,
    },
  ];
}

const INSTRUCTION = /^(=>)?\s*(0x[0-9a-f]+)(?: <[^>]*>)?:\s*(.*)$/i;

function parseInstruction(line: string): GdbInstruction[] {
  const match = INSTRUCTION.exec(line.trim());
  if (match === null || match[2] === undefined) return [];
  return [
    {
      address: BigInt(match[2]),
      isFault: match[1] === "=>",
      text: line.trim().replace(/^=>\s*/, ""),
    },
  ];
}
