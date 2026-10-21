import { failure, frame, type FailureFrame, type ParsedFailure } from "../failure.js";

// ---------------------------------------------------------------- Go

const GO_HEADER = /^(panic|fatal error): (.*)$/m;
/** `goroutine 1 [running]:`, or with GOTRACEBACK=system: `goroutine 1 gp=0x… m=0 mp=0x… [running]:` */
const GO_GOROUTINE = /^goroutine (\d+)(?: [^[\]\n]*)? \[([^\]]+)\]:$/;
/** `\tfile.go:12 +0x1d`, plus ` fp=… sp=… pc=…` with GOTRACEBACK=system */
const GO_FILE_LINE = /^\t(.+?):(\d+)(?: \+0x[0-9a-f]+)?(?: [^\n]*)?$/;

export function parseGo(text: string): ParsedFailure | null {
  const header = GO_HEADER.exec(text);
  if (header === null) return null;
  const lines = text.slice(header.index).split("\n");
  const signal =
    lines.slice(1, 4).find((line) => line.startsWith("[signal ")) ?? null;

  const start = lines.findIndex((line) => GO_GOROUTINE.test(line));
  const frames: FailureFrame[] = [];
  let context: string | null = null;
  let otherGoroutines = 0;
  if (start !== -1) {
    const goroutine = GO_GOROUTINE.exec(lines[start] ?? "");
    context = goroutine ? `goroutine ${goroutine[1]} [${goroutine[2]}]` : null;
    let index = start + 1;
    while (index < lines.length && (lines[index] ?? "") !== "") {
      const name = lines[index] ?? "";
      const location = GO_FILE_LINE.exec(lines[index + 1] ?? "");
      if (name.startsWith("\t")) {
        index++;
        continue;
      }
      const createdBy = name.startsWith("created by ");
      const fn = createdBy
        ? name.replace(/^created by (\S+).*$/, "$1")
        : name.replace(/\([^()]*\)$/, "");
      const file = location?.[1] ?? null;
      frames.push(
        frame({
          function: fn,
          file,
          line: location ? Number(location[2]) : null,
          own: isOwnGoFrame(fn, file),
          createdBy,
        }),
      );
      index += location ? 2 : 1;
    }
    otherGoroutines = lines
      .slice(index)
      .filter((line) => GO_GOROUTINE.test(line)).length;
  }
  return failure({
    language: "go",
    header: header[1] ?? "panic",
    message: (header[2] ?? "").replace(/ \[recovered\]$/, ""),
    context,
    signal,
    frames,
    otherGoroutines,
    start: header.index,
  });
}

/**
 * Standard library packages have no dot in their first path element
 * ("fmt", "internal/runtime/maps"); module paths do ("github.com/...").
 * Package main is always the program's own code.
 */
function isOwnGoFrame(fn: string, file: string | null): boolean {
  if (file !== null && /\/go[\d.]*\/src\//.test(file)) return false;
  // Dependencies: the module cache and vendored copies.
  if (file !== null && /\/pkg\/mod\/|\/vendor\//.test(file)) return false;
  const lastSlash = fn.lastIndexOf("/");
  const pkg =
    fn.slice(0, lastSlash + 1) + fn.slice(lastSlash + 1).split(".")[0];
  if (pkg === "main") return true;
  return (pkg.split("/")[0] ?? "").includes(".");
}

// ---------------------------------------------------------------- Rust

/** Rust ≥ 1.73: `thread 'main' (123) panicked at src/main.rs:5:20:` */
const RUST_HEADER =
  /^thread '([^']*)'(?: \(\d+\))? panicked at (.+?):(\d+):(\d+):$/m;
/** Rust < 1.73: `thread 'main' panicked at 'message', src/main.rs:5:20` */
const RUST_LEGACY_HEADER =
  /^thread '([^'\n]*)' panicked at '([^\n]*?)', ([^\n]+?):(\d+):(\d+)$/m;
const RUST_FRAME = /^\s*\d+:\s+(?:0x[0-9a-f]+ - )?(.+)$/;
const RUST_AT = /^\s+at (.+?):(\d+)(?::(\d+))?$/;

export function parseRust(text: string): ParsedFailure | null {
  const modern = RUST_HEADER.exec(text);
  const legacy = modern === null ? RUST_LEGACY_HEADER.exec(text) : null;
  if (modern === null && legacy === null) return null;

  let message: string;
  let thread: string;
  let file: string;
  let line: number;
  let column: number;
  let rest: string;
  if (modern !== null) {
    thread = modern[1] ?? "";
    file = modern[2] ?? "";
    line = Number(modern[3]);
    column = Number(modern[4]);
    rest = text.slice(modern.index + modern[0].length + 1);
    const end = rest.search(/^(note: |stack backtrace:)/m);
    message = (end === -1 ? rest : rest.slice(0, end)).trim();
  } else {
    const match = legacy as RegExpExecArray;
    thread = match[1] ?? "";
    message = match[2] ?? "";
    file = match[3] ?? "";
    line = Number(match[4]);
    column = Number(match[5]);
    rest = text.slice(match.index + match[0].length);
  }

  const frames: FailureFrame[] = [];
  const traceStart = rest.indexOf("stack backtrace:");
  if (traceStart !== -1) {
    const lines = rest.slice(traceStart).split("\n").slice(1);
    for (let index = 0; index < lines.length; index++) {
      const symbol = RUST_FRAME.exec(lines[index] ?? "");
      if (symbol === null) {
        if (!RUST_AT.test(lines[index] ?? "")) break;
        continue;
      }
      const at = RUST_AT.exec(lines[index + 1] ?? "");
      const fn = normalizeRustSymbol(symbol[1] ?? "");
      const frameFile = at?.[1] ?? null;
      frames.push(
        frame({
          function: fn,
          file: frameFile,
          line: at ? Number(at[2]) : null,
          column: at?.[3] === undefined ? null : Number(at[3]),
          own: isOwnRustFrame(fn, frameFile),
        }),
      );
    }
  }
  return failure({
    language: "rust",
    header: "panic",
    message,
    context: `thread '${thread}'`,
    location: { file, line, column },
    frames,
    start: (modern ?? legacy)?.index ?? 0,
  });
}

/** Drop crate disambiguators (`std[0a1b…]`) and symbol hashes (`::h0a1b…`). */
function normalizeRustSymbol(symbol: string): string {
  return symbol
    .replace(/\[[0-9a-f]{16}\]/g, "")
    .replace(/::h[0-9a-f]{16}$/, "")
    .trim();
}

const RUST_RUNTIME_CRATES = new Set([
  "std",
  "core",
  "alloc",
  "__rustc",
  "backtrace",
  "panic_unwind",
  "rust_begin_unwind",
]);
const RUST_RUNTIME_SYMBOLS = /^(main|_start|__libc_\w+|<unknown>)$/;

function isOwnRustFrame(fn: string, file: string | null): boolean {
  if (file !== null && (file.startsWith("/rustc/") || file.includes("/.cargo/registry/")))
    return false;
  if (RUST_RUNTIME_SYMBOLS.test(fn)) return false;
  const crate = fn.replace(/^<+/, "").split("::")[0] ?? "";
  return !RUST_RUNTIME_CRATES.has(crate) && !crate.startsWith("fn(");
}
