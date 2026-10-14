import { createHash } from "node:crypto";
import { basename } from "node:path";
import { classify, refineWithFrames, type Classification } from "./classify.js";
import { inspectWithGdb, type GdbInstruction, type GdbReport } from "./gdb.js";
import { parseNtFile } from "./ntFile.js";
import {
  inspectBinaryLayout,
  inspectRecordedCrash,
  type BinaryLayout,
  type CrashRegister,
  type ReaCommand,
  type RecordedCrash,
} from "./rea.js";
import { err, ok, type Result } from "./result.js";
import {
  createSymbolizer,
  type Location,
  type Symbolizer,
} from "./symbolize.js";

export interface TriageOptions {
  readonly corePath: string;
  readonly binaryPath: string;
  readonly rea: ReaCommand;
  /** null disables gdb; otherwise the gdb executable to use. */
  readonly gdb: string | null;
}

export interface TriageFrame {
  readonly index: number;
  readonly address: bigint | null;
  /** Name gdb printed, if any. */
  readonly gdbFunction: string | null;
  readonly source: string | null;
  readonly location: Location;
}

export interface TriageReport {
  readonly program: string;
  readonly corePath: string;
  readonly binaryPath: string;
  readonly crash: RecordedCrash;
  readonly layout: BinaryLayout;
  readonly classification: Classification;
  readonly pc: bigint | null;
  readonly faultLocation: Location | null;
  /** First frame inside the analyzed binary, when the crash is in a library. */
  readonly firstOwnFrame: TriageFrame | null;
  readonly frames: readonly TriageFrame[];
  readonly instructions: readonly GdbInstruction[];
  readonly relevantRegisters: readonly CrashRegister[];
  readonly signature: string;
  readonly gdb: {
    readonly status: GdbReport["status"];
    readonly reason?: string;
  };
  readonly warnings: readonly string[];
  readonly limitations: readonly string[];
}

export async function triage(
  options: TriageOptions,
): Promise<Result<TriageReport>> {
  const [crash, layout, gdb] = await Promise.all([
    inspectRecordedCrash(options.rea, options.corePath),
    inspectBinaryLayout(options.rea, options.binaryPath),
    options.gdb === null
      ? Promise.resolve<GdbReport>({
          status: "unavailable",
          reason: "disabled with --no-gdb",
        })
      : inspectWithGdb(options.binaryPath, options.corePath, options.gdb),
  ]);
  if (!crash.ok) return crash;
  if (!layout.ok) return layout;
  return buildReport(options, crash.value, layout.value, gdb);
}

/** Exported for tests: pure assembly of a report from adapter results. */
export function buildReport(
  options: Pick<TriageOptions, "corePath" | "binaryPath">,
  crash: RecordedCrash,
  layout: BinaryLayout,
  gdb: GdbReport,
): Result<TriageReport> {
  if (crash.ntFileDescriptor === null)
    return err(
      "unsupported_crash",
      "The core has no NT_FILE note, so mapped files cannot be resolved.",
    );
  const mappings = parseNtFile(crash.ntFileDescriptor);
  if (!mappings.ok)
    return err(
      "unsupported_crash",
      `Could not read the core's file mappings: ${mappings.reason}`,
    );

  const symbolizer = createSymbolizer(
    options.binaryPath,
    mappings.mappings,
    layout,
  );
  const pc = register(crash, "rip");
  const sp = register(crash, "rsp");
  const faultLocation = pc === null ? null : symbolizer.locate(pc);

  const frames = buildFrames(gdb, pc, symbolizer);

  const classification = refineWithFrames(
    classify({ signal: crash.signal, pc, sp }),
    frames.flatMap((frame) =>
      frame.gdbFunction === null ? [] : [frame.gdbFunction],
    ),
  );

  const isOwn = (frame: TriageFrame) =>
    frame.location.kind === "binary-function" ||
    frame.location.kind === "binary";
  const firstOwnFrame =
    frames[0] !== undefined && !isOwn(frames[0])
      ? (frames.find(isOwn) ?? null)
      : null;

  const instructions = gdb.status === "ok" ? gdb.instructions : [];
  const warnings = [
    ...(gdb.status === "ok" ? gdb.warnings : []),
    ...(symbolizer.binaryFoundInCore
      ? []
      : [
          `No mapping named "${basename(options.binaryPath)}" was found in the core; function names come from gdb only.`,
        ]),
  ];

  return ok({
    program: basename(options.binaryPath),
    corePath: options.corePath,
    binaryPath: options.binaryPath,
    crash,
    layout,
    classification,
    pc,
    faultLocation,
    firstOwnFrame,
    frames,
    instructions,
    relevantRegisters: relevantRegisters(
      crash,
      instructions.find((i) => i.isFault),
    ),
    signature: signature(classification, frames),
    gdb:
      gdb.status === "ok"
        ? { status: "ok" }
        : { status: gdb.status, reason: gdb.reason },
    warnings,
    limitations: [
      "The program was not executed; all facts come from the recorded core and the binary on disk.",
      "The binary is matched to the core by file name only. Rebuilt binaries give wrong function names; gdb warns when it detects a mismatch.",
      ...(gdb.status === "ok"
        ? [
            "Backtrace frames beyond #0 come from gdb unwinding and may be incomplete without debug info or frame pointers.",
          ]
        : [
            "No backtrace: gdb was not used, so only the faulting frame is shown.",
          ]),
    ],
  });
}

/** Frames from gdb when available, otherwise just the faulting frame. */
function buildFrames(
  gdb: GdbReport,
  pc: bigint | null,
  symbolizer: Symbolizer,
): TriageFrame[] {
  if (gdb.status !== "ok" || gdb.frames.length === 0)
    return pc === null
      ? []
      : [
          {
            index: 0,
            address: pc,
            gdbFunction: null,
            source: null,
            location: symbolizer.locate(pc),
          },
        ];
  return gdb.frames.map((frame) => {
    const address = frame.index === 0 ? (frame.address ?? pc) : frame.address;
    // Caller frames hold return addresses; look up the call instruction.
    const lookup =
      address === null ? null : frame.index === 0 ? address : address - 1n;
    return {
      index: frame.index,
      address,
      gdbFunction: frame.function === "??" ? null : frame.function,
      source: frame.source,
      // Inlined frames have no address of their own.
      location:
        lookup === null ? { kind: "unknown" } : symbolizer.locate(lookup),
    };
  });
}

function register(crash: RecordedCrash, name: string): bigint | null {
  return crash.registers.find((entry) => entry.name === name)?.value ?? null;
}

const SUBREGISTER: Readonly<Record<string, string>> = {
  eax: "rax",
  ebx: "rbx",
  ecx: "rcx",
  edx: "rdx",
  esi: "rsi",
  edi: "rdi",
  ebp: "rbp",
  esp: "rsp",
};

/** Registers named by the faulting instruction, mapped to their 64-bit values. */
function relevantRegisters(
  crash: RecordedCrash,
  instruction: GdbInstruction | undefined,
): CrashRegister[] {
  if (instruction === undefined) return [];
  // Operands follow the "<address> <symbol>:" prefix and the mnemonic.
  const operands = instruction.text
    .split(":")
    .slice(1)
    .join(":")
    .trim()
    .split(/\s+/)
    .slice(1)
    .join(" ");
  const names = new Set<string>();
  for (const match of operands.matchAll(/[a-z][a-z0-9]*/g)) {
    const token = match[0];
    names.add(SUBREGISTER[token] ?? token.replace(/^(r\d{1,2})[dwb]$/, "$1"));
  }
  return crash.registers.filter((entry) => names.has(entry.name));
}

/**
 * Stable grouping key: crash kind plus the top three frame names (or module
 * offsets). Addresses are excluded because ASLR changes them on every run.
 */
function signature(
  classification: Classification,
  frames: readonly TriageFrame[],
): string {
  const parts = frames.slice(0, 3).map((frame) => {
    const location = frame.location;
    if (location.kind === "binary-function") return location.symbol.name;
    if (frame.gdbFunction !== null) return frame.gdbFunction;
    if (location.kind === "unmapped" || location.kind === "unknown") return "?";
    return `${location.module}+0x${location.moduleOffset.toString(16)}`;
  });
  return createHash("sha256")
    .update([classification.kind, ...parts].join("|"))
    .digest("hex")
    .slice(0, 12);
}
