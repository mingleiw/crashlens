import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { err, ok, type Result } from "./result.js";

/** How to launch REA: an executable plus leading arguments. */
export interface ReaCommand {
  readonly file: string;
  readonly args: readonly string[];
}

export interface CrashRegister {
  readonly name: string;
  readonly value: bigint;
}

export interface CrashSignal {
  readonly number: number;
  readonly code: number;
  /** Present only when REA established a fault-address meaning. */
  readonly faultAddress: bigint | null;
}

export interface CrashLoadSegment {
  readonly start: bigint;
  readonly memorySize: bigint;
  readonly flags: number;
}

/** Facts this package uses from `rea inspect-recorded-crash`. */
export interface RecordedCrash {
  readonly evidenceId: string;
  readonly coreSha256: string;
  readonly historicalPid: number | null;
  readonly registers: readonly CrashRegister[];
  readonly signal: CrashSignal | null;
  readonly loadSegments: readonly CrashLoadSegment[];
  /** Raw NT_FILE descriptor bytes, if REA recorded one. */
  readonly ntFileDescriptor: Uint8Array | null;
  readonly limitations: readonly string[];
}

export interface LayoutSymbol {
  readonly name: string;
  readonly value: bigint;
  readonly size: bigint;
}

export interface LayoutSegment {
  readonly offset: bigint;
  readonly virtualAddress: bigint;
}

/** Facts this package uses from `rea inspect-binary-layout`. */
export interface BinaryLayout {
  readonly evidenceId: string;
  readonly binarySha256: string;
  readonly imageType: string;
  readonly loadSegments: readonly LayoutSegment[];
  readonly functions: readonly LayoutSymbol[];
  readonly mitigations: Readonly<Record<string, unknown>> | null;
}

const READ_TIMEOUT_MS = 180_000;
/** Core inspections preserve every note's bytes, so output can be large. */
const MAX_OUTPUT_BYTES = 512 * 1024 * 1024;

/**
 * Resolve REA in order: CRASHLENS_REA, the installed `rea-agents` package,
 * then `rea` on PATH. A `.mjs`/`.js` path runs under the current Node.
 */
export function resolveReaCommand(
  env: NodeJS.ProcessEnv = process.env,
): ReaCommand {
  const override = env["CRASHLENS_REA"];
  if (override !== undefined && override !== "") return commandFor(override);
  try {
    const require = createRequire(import.meta.url);
    const manifest = require.resolve("rea-agents/package.json");
    const script = join(dirname(manifest), "scripts", "rea.mjs");
    if (existsSync(script)) return commandFor(script);
  } catch {
    // Not installed alongside this package.
  }
  return { file: "rea", args: [] };
}

function commandFor(path: string): ReaCommand {
  return /\.(c|m)?js$/.test(path)
    ? { file: process.execPath, args: [path] }
    : { file: path, args: [] };
}

function runRea(
  rea: ReaCommand,
  args: readonly string[],
): Promise<Result<unknown>> {
  return new Promise((resolve) => {
    execFile(
      rea.file,
      [...rea.args, ...args, "--json"],
      { maxBuffer: MAX_OUTPUT_BYTES, timeout: READ_TIMEOUT_MS },
      (error, stdout) => {
        if (error && "code" in error && error.code === "ENOENT") {
          resolve(
            err(
              "rea_unavailable",
              `Could not start REA (${rea.file}). Install rea-agents or set CRASHLENS_REA.`,
            ),
          );
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          resolve(
            err(
              error ? "rea_failed" : "unexpected_rea_output",
              `REA ${args[0]} did not return JSON${error ? `: ${error.message}` : ""}`,
            ),
          );
          return;
        }
        if (error || isReaError(parsed)) {
          const message = isReaError(parsed)
            ? parsed.message
            : String(error?.message);
          resolve(
            err("rea_failed", `REA ${args[0]} failed: ${message}`, parsed),
          );
          return;
        }
        resolve(ok(parsed));
      },
    );
  });
}

function isReaError(value: unknown): value is { message: string } {
  return (
    isRecord(value) &&
    typeof value["code"] === "string" &&
    typeof value["message"] === "string" &&
    !("normalized_result" in value)
  );
}

export async function inspectRecordedCrash(
  rea: ReaCommand,
  corePath: string,
): Promise<Result<RecordedCrash>> {
  const result = await runRea(rea, ["inspect-recorded-crash", corePath]);
  if (!result.ok) return result;
  try {
    return ok(parseRecordedCrash(result.value));
  } catch (cause) {
    return err(
      "unexpected_rea_output",
      `REA crash evidence had an unexpected shape: ${(cause as Error).message}`,
    );
  }
}

export async function inspectBinaryLayout(
  rea: ReaCommand,
  binaryPath: string,
): Promise<Result<BinaryLayout>> {
  const result = await runRea(rea, ["inspect-binary-layout", binaryPath]);
  if (!result.ok) return result;
  try {
    return ok(parseBinaryLayout(result.value));
  } catch (cause) {
    return err(
      "unexpected_rea_output",
      `REA layout evidence had an unexpected shape: ${(cause as Error).message}`,
    );
  }
}

/** Exported for tests: parse REA crash Evidence into the facts used here. */
export function parseRecordedCrash(evidence: unknown): RecordedCrash {
  const root = record(evidence, "evidence");
  const result = record(root["normalized_result"], "normalized_result");
  const artifact = record(result["artifact"], "artifact");
  const threads = array(result["threads"], "threads");
  const firstThread =
    threads[0] === undefined ? null : record(threads[0], "thread");
  const signals = array(result["signals"], "signals");
  const firstSignal =
    signals[0] === undefined ? null : record(signals[0], "signal");
  const ntFile = array(result["notes"], "notes")
    .map((note) => record(note, "note"))
    .find((note) => note["type"] === "NT_FILE");

  return {
    evidenceId: string(root["evidence_id"], "evidence_id"),
    coreSha256: string(artifact["sha256"], "artifact.sha256"),
    historicalPid:
      firstThread && typeof firstThread["historical_pid"] === "number"
        ? firstThread["historical_pid"]
        : null,
    registers: firstThread
      ? array(firstThread["registers"], "registers").map((entry) => {
          const register = record(entry, "register");
          return {
            name: string(register["name"], "register.name"),
            value: hex(register["value"], "register.value"),
          };
        })
      : [],
    signal: firstSignal
      ? {
          number: number(firstSignal["number"], "signal.number"),
          code: number(firstSignal["code"], "signal.code"),
          faultAddress:
            typeof firstSignal["fault_address"] === "string"
              ? hex(firstSignal["fault_address"], "signal.fault_address")
              : null,
        }
      : null,
    loadSegments: array(result["segments"], "segments")
      .map((entry) => record(entry, "segment"))
      .filter((segment) => segment["type"] === "PT_LOAD")
      .map((segment) => ({
        start: hex(segment["virtual_address"], "segment.virtual_address"),
        memorySize: hex(segment["memory_size"], "segment.memory_size"),
        flags: Number(hex(segment["flags"], "segment.flags")),
      })),
    ntFileDescriptor:
      ntFile && typeof ntFile["descriptor_bytes_base64"] === "string"
        ? new Uint8Array(
            Buffer.from(ntFile["descriptor_bytes_base64"], "base64"),
          )
        : null,
    limitations: array(result["limitations"] ?? [], "limitations").filter(
      (item): item is string => typeof item === "string",
    ),
  };
}

/** Exported for tests: parse REA layout Evidence into the facts used here. */
export function parseBinaryLayout(evidence: unknown): BinaryLayout {
  const root = record(evidence, "evidence");
  const result = record(root["normalized_result"], "normalized_result");
  const artifact = record(result["artifact"], "artifact");
  const mitigations = result["mitigations"];
  return {
    evidenceId: string(root["evidence_id"], "evidence_id"),
    binarySha256: string(artifact["sha256"], "artifact.sha256"),
    imageType: string(result["image_type"], "image_type"),
    loadSegments: array(result["segments"], "segments")
      .map((entry) => record(entry, "segment"))
      .filter((segment) => segment["type"] === "PT_LOAD")
      .map((segment) => ({
        offset: hex(segment["offset"], "segment.offset"),
        virtualAddress: hex(
          segment["virtual_address"],
          "segment.virtual_address",
        ),
      })),
    functions: array(result["symbols"], "symbols")
      .map((entry) => record(entry, "symbol"))
      .filter(
        (symbol) =>
          symbol["type"] === "STT_FUNC" &&
          symbol["value_meaning"] === "linked-virtual-address",
      )
      .map((symbol) => ({
        name: string(
          record(symbol["name"], "symbol.name")["display"],
          "symbol.name.display",
        ),
        value: hex(symbol["value"], "symbol.value"),
        size: hex(symbol["size"], "symbol.size"),
      }))
      .filter((symbol) => symbol.name !== ""),
    mitigations: isRecord(mitigations) ? mitigations : null,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new Error(`${path} is not an object`);
  return value;
}

function array(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new Error(`${path} is not an array`);
  return value;
}

function string(value: unknown, path: string): string {
  if (typeof value !== "string") throw new Error(`${path} is not a string`);
  return value;
}

function number(value: unknown, path: string): number {
  if (typeof value !== "number") throw new Error(`${path} is not a number`);
  return value;
}

function hex(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value))
    throw new Error(`${path} is not a hex string`);
  return BigInt(value);
}
