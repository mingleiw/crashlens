import {
  failure,
  frame,
  lineStart,
  type FailureFrame,
  type FailureStack,
  type ParsedFailure,
} from "../failure.js";

/** `==466==ERROR: AddressSanitizer: heap-use-after-free on address ...` */
const REPORT = /^==\d+==(?:ERROR|WARNING): (\w+Sanitizer): (.+)$/m;
/** `order.c:11:34: runtime error: signed integer overflow: ...` (UBSan) */
const UBSAN = /^(.+?):(\d+):(\d+): runtime error: (.+)$/m;
/** `    #1 0x55fe in release /app/order.c:7:3` or `    #2 0x7f95 (/lib/libc.so.6+0x29d90)` */
const FRAME =
  /^\s+#\d+ 0x[0-9a-f]+(?: in (.+?))?(?: (\S+?))?(?: \(BuildId: [0-9a-f]+\))?$/;
const SOURCE = /^(.+?):(\d+)(?::(\d+))?$/;
const ACCESS = /^(READ|WRITE) of size (\d+) at (0x[0-9a-f]+) thread (\S+)/m;
const SUMMARY = /^SUMMARY: \w+Sanitizer: \S+ (.+?):(\d+)(?::(\d+))? in /m;
const REGION = /^0x[0-9a-f]+ is located .*$/m;

const RUNTIME_FUNCTION =
  /^(__asan|__lsan|__tsan|__msan|__ubsan|__interceptor|__sanitizer|__libc_|_start$|malloc$|calloc$|realloc$|free$|strdup$|operator (new|delete))/;
const RUNTIME_FILE = /(libsanitizer|compiler-rt|\/sysdeps\/|\.\.\/csu\/|^\(|\/libc\.so|\/libasan)/;

export function parseSanitizer(text: string): ParsedFailure | null {
  return parseReport(text) ?? parseUbsan(text);
}

function parseReport(text: string): ParsedFailure | null {
  const report = REPORT.exec(text);
  if (report === null) return null;
  let start = lineStart(text, report.index);
  const banner = text.lastIndexOf("=================================================================\n", start);
  if (banner !== -1 && banner + 66 === start) start = banner;

  const tool = report[1] ?? "Sanitizer";
  // Drop register dump: "... at pc 0x55fe bp 0x7ffe sp 0x7ffe".
  const description = (report[2] ?? "").replace(/ at pc 0x[0-9a-f]+ bp 0x[0-9a-f]+ sp 0x[0-9a-f]+$/, "");
  const bugType = description.split(" ")[0] ?? description;
  const body = text.slice(report.index);
  const stacks = readStacks(body.split("\n").slice(1));
  const leak = bugType === "detected";
  const main = stacks[0];

  const access = ACCESS.exec(body);
  const summary = SUMMARY.exec(body);
  const region = REGION.exec(body);
  return failure({
    language: "sanitizer",
    header: tool,
    errorType: leak ? "memory-leak" : bugType,
    message: [description, region?.[0]].filter(Boolean).join(". "),
    context: leak
      ? (main?.title ?? null)
      : access
        ? `${access[1]} of ${access[2]} bytes at ${access[3]} (thread ${access[4]})`
        : null,
    location: summary
      ? { file: summary[1] ?? "", line: Number(summary[2]), column: summary[3] === undefined ? null : Number(summary[3]) }
      : null,
    frames: main?.frames ?? [],
    extraStacks: stacks.slice(1),
    start,
  });
}

function parseUbsan(text: string): ParsedFailure | null {
  const match = UBSAN.exec(text);
  if (match === null) return null;
  const following = text.slice(match.index + match[0].length + 1).split("\n");
  const stacks = readStacks(following);
  return failure({
    language: "sanitizer",
    header: "UndefinedBehaviorSanitizer",
    errorType: "undefined-behavior",
    message: match[4] ?? "",
    location: { file: match[1] ?? "", line: Number(match[2]), column: Number(match[3]) },
    frames: stacks[0]?.frames ?? [],
    start: lineStart(text, match.index),
  });
}

/** Stacks are runs of `#N` lines; the line before each run (ending in ':') is its title. */
function readStacks(lines: readonly string[]): FailureStack[] {
  const stacks: { title: string; frames: FailureFrame[] }[] = [];
  let title = "";
  let current: FailureFrame[] | null = null;
  for (const line of lines) {
    const match = FRAME.exec(line);
    if (match !== null && /^\s+#\d+ /.test(line)) {
      if (current === null) {
        current = [];
        stacks.push({ title, frames: current });
      }
      current.push(sanitizerFrame(match[1] ?? null, match[2] ?? null));
      continue;
    }
    current = null;
    if (line.trim().endsWith(":")) title = line.trim().replace(/:$/, "");
    else if (line.startsWith("SUMMARY:") || line.startsWith("Shadow bytes")) break;
  }
  return stacks;
}

function sanitizerFrame(fn: string | null, place: string | null): FailureFrame {
  const source = place !== null && !place.startsWith("(") ? SOURCE.exec(place) : null;
  const file = source?.[1] ?? null;
  const name = fn ?? place ?? "??";
  return frame({
    function: name,
    file,
    line: source ? Number(source[2]) : null,
    column: source?.[3] === undefined ? null : Number(source[3]),
    own:
      fn !== null &&
      !RUNTIME_FUNCTION.test(fn) &&
      file !== null &&
      !RUNTIME_FILE.test(file),
  });
}
