import { createHash } from "node:crypto";
import { basename } from "node:path";
import { classify, refineWithFrames, type Classification } from "./classify.js";
import { disassembleAround, type DisasmLine } from "./disasm.js";
import { binaryBuildId, coreImageBuildId, functionRanges, type FunctionRange } from "./elf.js";
import { inspectWithGdb, type GdbInstruction, type GdbReport } from "./gdb.js";
import { parseNtFile } from "./ntFile.js";
import {
  decompileFunction,
  inspectBinaryLayout,
  inspectRecordedCrash,
  type BinaryLayout,
  type CrashRegister,
  type Decompilation,
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
  /**
   * REA + Ghidra pseudocode of the crashing function. "auto" (default): only when
   * that function has no symbol (a stripped binary) and GHIDRA_INSTALL_DIR is set.
   */
  readonly decompile?: boolean | "auto";
  /** Also decompile the nearest caller in the binary (default true; agents can ask for it separately). */
  readonly decompileCaller?: boolean;
}

export interface BuildIdCheck {
  readonly binary: string | null;
  readonly core: string | null;
  readonly status: "match" | "mismatch" | "unknown";
}

/** The function the report explains: where it faulted, or the first caller in the binary. */
export interface FocusFunction {
  readonly name: string;
  readonly start: bigint;
  readonly end: bigint;
  /** Link-time address of the faulting instruction or of the call. */
  readonly target: bigint;
  readonly reason: "fault" | "caller";
  readonly fromUnwindTables: boolean;
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
  readonly buildId: BuildIdCheck;
  readonly focus: FocusFunction | null;
  readonly disassembly: readonly DisasmLine[] | null;
  /** Pseudocode of the focus function and of its nearest caller in the binary. */
  readonly decompiled: readonly DecompiledFunction[];
  readonly warnings: readonly string[];
  readonly limitations: readonly string[];
}

export interface DecompiledFunction extends Decompilation {
  readonly name: string;
  /** Address in the decompiler's address space. */
  readonly address: bigint;
  readonly role: "crash" | "caller";
}

/** Facts read directly from the files, beside REA and gdb. */
export interface FileFacts {
  readonly unwindRanges: readonly FunctionRange[];
  readonly buildId: BuildIdCheck;
  /** The binary's file name in the core when it was found by build ID under another name. */
  readonly mappedName?: string;
}

const NO_FILE_FACTS: FileFacts = { unwindRanges: [], buildId: { binary: null, core: null, status: "unknown" } };
/** Fallback length for a function whose size is not recorded. */
const UNSIZED_FUNCTION_BYTES = 0x400n;

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
  const facts = await readFileFacts(options, crash.value);
  const report = buildReport(options, crash.value, layout.value, gdb, facts);
  if (!report.ok) return report;
  return ok(await explainFocus(options, report.value));
}

async function readFileFacts(options: TriageOptions, crash: RecordedCrash): Promise<FileFacts> {
  const quiet = <T>(promise: Promise<T>, fallback: T) => promise.catch(() => fallback);
  const mappings = crash.ntFileDescriptor === null ? null : parseNtFile(crash.ntFileDescriptor);
  const name = basename(options.binaryPath);
  const images = mappings?.ok ? mappings.mappings.filter((m) => m.fileOffset === 0n) : [];
  const base = images.filter((m) => basename(m.path) === name).map((m) => m.start).sort((a, b) => (a < b ? -1 : 1))[0];
  const [unwindRanges, binary, core] = await Promise.all([
    quiet(functionRanges(options.binaryPath), []),
    quiet(binaryBuildId(options.binaryPath), null),
    base === undefined ? Promise.resolve(null) : quiet(coreImageBuildId(options.corePath, base), null),
  ]);
  if (base === undefined && binary !== null) {
    // Renamed or redeployed under another path: find the image with the same build ID.
    for (const image of images) {
      if ((await quiet(coreImageBuildId(options.corePath, image.start), null)) === binary)
        return { unwindRanges, buildId: { binary, core: binary, status: "match" }, mappedName: basename(image.path) };
    }
  }
  const status = binary === null || core === null ? "unknown" : binary === core ? "match" : "mismatch";
  return { unwindRanges, buildId: { binary, core, status } };
}

/** Disassemble (and optionally decompile) the function the report points at. */
async function explainFocus(options: TriageOptions, report: TriageReport): Promise<TriageReport> {
  const focus = report.focus;
  if (focus === null) return report;
  const disassembly = await disassembleAround(options.binaryPath, focus.start, focus.end, focus.target).catch(() => null);
  const decompiled: DecompiledFunction[] = [];
  const warnings = [...report.warnings];
  const auto = (options.decompile ?? "auto") === "auto";
  const wanted = auto ? focus.fromUnwindTables && Boolean(process.env["GHIDRA_INSTALL_DIR"]) : options.decompile === true;
  if (wanted) {
    // Ghidra loads position-independent images at 0x100000.
    const base = /DYN/i.test(report.layout.imageType) ? 0x100000n : 0n;
    // The bad value is often produced one level up, so also decompile the nearest caller.
    const targets: { name: string; start: bigint; role: DecompiledFunction["role"] }[] = [
      { name: focus.name, start: focus.start, role: "crash" },
    ];
    const caller = options.decompileCaller === false ? null : nearestCaller(report, focus);
    if (caller !== null) targets.push({ ...caller, role: "caller" });
    for (const target of targets) {
      const result = await decompileFunction(options.rea, options.binaryPath, target.start + base);
      if (result.ok) {
        decompiled.push({ ...result.value, name: target.name, address: target.start + base, role: target.role });
        continue;
      }
      if (!auto || result.error.tag !== "unexpected_rea_output")
        warnings.push(`Decompilation unavailable: ${result.error.message} REA needs Ghidra 12.1.x (GHIDRA_INSTALL_DIR) and a JDK.`);
      break;
    }
  }
  return { ...report, disassembly, decompiled, warnings };
}

/** Exported for tests: pure assembly of a report from adapter results. */
export function buildReport(
  options: Pick<TriageOptions, "corePath" | "binaryPath">,
  crash: RecordedCrash,
  layout: BinaryLayout,
  gdb: GdbReport,
  facts: FileFacts = NO_FILE_FACTS,
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
    facts.unwindRanges,
    facts.mappedName,
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
  const { buildId } = facts;
  const warnings = [
    ...(buildId.status === "mismatch"
      ? [
          `Build ID mismatch: the binary is ${buildId.binary} but the crashed process ran ${buildId.core}. Function names and offsets are likely wrong; pass the exact binary that crashed.`,
        ]
      : []),
    ...(gdb.status === "ok" ? gdb.warnings : []),
    ...(facts.mappedName !== undefined
      ? [
          `The binary is named "${basename(options.binaryPath)}" here but ran as "${facts.mappedName}"; matched by build ID.`,
        ]
      : []),
    ...(symbolizer.binaryFoundInCore
      ? []
      : [
          `No mapping named "${basename(options.binaryPath)}" was found in the core; function names come from gdb only.`,
        ]),
  ];

  return ok({
    program: facts.mappedName ?? basename(options.binaryPath),
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
    buildId,
    focus: focusFunction(faultLocation, firstOwnFrame, facts.unwindRanges),
    disassembly: null,
    decompiled: [],
    gdb:
      gdb.status === "ok"
        ? { status: "ok" }
        : { status: gdb.status, reason: gdb.reason },
    warnings,
    limitations: [
      "The program was not executed; all facts come from the recorded core and the binary on disk.",
      buildId.status === "match"
        ? "The binary's GNU build ID matches the image recorded in the core."
        : buildId.status === "mismatch"
          ? "The binary's GNU build ID differs from the image recorded in the core, so this report likely describes the wrong build."
          : "The binary is matched to the core by file name only (no build ID in one of them, or the core did not record the binary's headers). Rebuilt binaries give wrong function names.",
      ...(frames.some((frame) => frame.location.kind === "binary-function" && frame.location.symbol.origin === "eh_frame")
        ? ["sub_<address> names mark functions found in the binary's .eh_frame unwind tables because it has no symbol table entry for them."]
        : []),
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

/** The first frame above the focus function that is a different function in the binary. */
function nearestCaller(report: TriageReport, focus: FocusFunction): { name: string; start: bigint } | null {
  const from = report.frames.findIndex(
    (frame) => frame.location.kind === "binary-function" && frame.location.symbol.value === focus.start,
  );
  if (from === -1) return null;
  for (const frame of report.frames.slice(from + 1)) {
    if (frame.location.kind !== "binary-function") continue;
    if (frame.location.symbol.value === focus.start) continue; // recursion
    return { name: frame.location.symbol.name, start: frame.location.symbol.value };
  }
  return null;
}

/** The binary function to show as code: where it faulted, else the first caller in the binary. */
function focusFunction(
  faultLocation: Location | null,
  firstOwnFrame: TriageFrame | null,
  unwindRanges: readonly FunctionRange[],
): FocusFunction | null {
  const pick =
    faultLocation?.kind === "binary-function"
      ? { location: faultLocation, reason: "fault" as const, target: faultLocation.moduleOffset }
      : firstOwnFrame?.location.kind === "binary-function"
        ? { location: firstOwnFrame.location, reason: "caller" as const, target: firstOwnFrame.location.moduleOffset }
        : null;
  if (pick === null) return null;
  const { symbol } = pick.location;
  const unwind = unwindRanges.find((range) => range.start === symbol.value && range.end !== null);
  const end = symbol.size > 0n ? symbol.value + symbol.size : (unwind?.end ?? symbol.value + UNSIZED_FUNCTION_BYTES);
  return {
    name: symbol.name,
    start: symbol.value,
    end,
    target: pick.target,
    reason: pick.reason,
    fromUnwindTables: symbol.origin === "eh_frame",
  };
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
