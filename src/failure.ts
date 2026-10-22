import { parseGo, parseRust } from "./parsers/goRust.js";
import { parseJava } from "./parsers/java.js";
import { parseNode } from "./parsers/node.js";
import { parsePytest } from "./parsers/pytest.js";
import { parsePython } from "./parsers/python.js";
import { parseSanitizer } from "./parsers/sanitizer.js";
import { parseSentry } from "./parsers/sentry.js";
import { err, ok, type Result } from "./result.js";

/** Failure output crashlens reads as text (everything except core dumps). */
export type FailureLanguage = "go" | "rust" | "python" | "java" | "node" | "sanitizer";

export interface FailureFrame {
  readonly function: string;
  readonly file: string | null;
  readonly line: number | null;
  readonly column: number | null;
  /** Heuristic: frame belongs to the program, not the runtime, stdlib or dependencies. */
  readonly own: boolean;
  /** Go "created by" pseudo-frame: where the goroutine was started. */
  readonly createdBy: boolean;
  /** Source line printed with the frame (Python, Node), if any. */
  readonly code: string | null;
  /**
   * Local variables at the failure, as the output printed them (pytest
   * --showlocals, Sentry frame vars): name to repr. Values may hold secrets;
   * show them only through `maskValue`.
   */
  readonly locals?: Readonly<Record<string, string>>;
}

/** A secondary stack, e.g. ASan's "freed by thread T0 here". */
export interface FailureStack {
  readonly title: string;
  readonly frames: readonly FailureFrame[];
}

export interface ParsedFailure {
  readonly language: FailureLanguage;
  /**
   * What kind of failure output this is: "panic" / "fatal error" (Go),
   * "panic" (Rust), "exception" (Python, Java, Node), or the sanitizer name.
   */
  readonly header: string;
  /** Exception class or sanitizer bug type, e.g. "KeyError", "heap-use-after-free". */
  readonly errorType: string | null;
  readonly message: string;
  /** Goroutine, thread, or sanitizer access description. */
  readonly context: string | null;
  /** Location printed by the runtime itself (Rust "panicked at", sanitizer SUMMARY). */
  readonly location: FailureLocation | null;
  /** Go's "[signal SIGSEGV: ...]" line. */
  readonly signal: string | null;
  readonly frames: readonly FailureFrame[];
  readonly extraStacks: readonly FailureStack[];
  /** Exceptions wrapping the reported one ("IllegalStateException: bad config value"). */
  readonly wrappedBy: readonly string[];
  /** Go: other goroutines printed after the failing one. */
  readonly otherGoroutines: number;
  /** Offset in the input where the failure output starts; text before it is log context. */
  readonly start: number;
}

export interface FailureLocation {
  readonly file: string;
  readonly line: number;
  readonly column: number | null;
}

/**
 * Most specific formats first: sanitizer reports and Python tracebacks have
 * unambiguous banners, while Node's "TypeError: ..." line also appears at the
 * end of a Python traceback.
 */
const PARSERS = [parseSentry, parseSanitizer, parsePytest, parsePython, parseJava, parseGo, parseRust, parseNode];

/** Longer lines are cut before parsing: no real frame is this long, and it bounds regex work. */
const MAX_LINE = 4096;

export function parseFailure(text: string): Result<ParsedFailure> {
  const normalized = text
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => (line.length > MAX_LINE ? line.slice(0, MAX_LINE) : line))
    .join("\n");
  for (const parse of PARSERS) {
    const parsed = parse(normalized);
    if (parsed !== null) return ok(parsed);
  }
  return err(
    "unsupported_crash",
    "No supported failure found. crashlens reads Go/Rust panics, Python tracebacks and pytest failures, Java and Node stack traces, Sentry event JSON, and AddressSanitizer/UBSan reports.",
  );
}

/** Defaults for fields most parsers don't use. */
export function failure(
  fields: Pick<ParsedFailure, "language" | "header" | "message" | "frames" | "start"> &
    Partial<ParsedFailure>,
): ParsedFailure {
  return {
    errorType: null,
    context: null,
    location: null,
    signal: null,
    extraStacks: [],
    wrappedBy: [],
    otherGoroutines: 0,
    ...fields,
  };
}

export function frame(
  fields: Pick<FailureFrame, "function" | "file" | "line" | "own"> & Partial<FailureFrame>,
): FailureFrame {
  return { column: null, createdBy: false, code: null, ...fields };
}

/** Index of the start of the line containing `index`. */
export function lineStart(text: string, index: number): number {
  return text.lastIndexOf("\n", index - 1) + 1;
}
