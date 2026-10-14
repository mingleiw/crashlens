import { createHash } from "node:crypto";
import { basename } from "node:path";
import type { Issue } from "./issue.js";
import type { PanicFrame, PanicLanguage, ParsedPanic } from "./panic.js";

interface PanicRule {
  readonly language: PanicLanguage;
  readonly pattern: RegExp;
  readonly kind: string;
  readonly title: string;
  readonly explain: (match: RegExpExecArray) => string;
  readonly nextSteps: readonly string[];
}

const NIL_STEPS = [
  "Find where the value used on the failing line is created, and why it can be nil/None.",
  "Handle the missing case explicitly (return an error, use a default) instead of assuming it exists.",
];

/** First matching rule wins; order from most to least specific. */
const RULES: readonly PanicRule[] = [
  // Go
  {
    language: "go",
    pattern: /invalid memory address or nil pointer dereference/,
    kind: "go-nil-pointer",
    title: "Nil pointer dereference",
    explain: () => "The code used a nil pointer: a field or method was accessed on a pointer that was never set.",
    nextSteps: NIL_STEPS,
  },
  {
    language: "go",
    pattern: /index out of range \[(-?\d+)\] with length (\d+)/,
    kind: "go-index-out-of-range",
    title: "Index out of range",
    explain: (m) => `The code read index ${m[1]} of a slice or array that only has ${m[2]} element${m[2] === "1" ? "" : "s"}.`,
    nextSteps: [
      "Check where the index comes from and whether the slice can be shorter than expected (empty input, off-by-one).",
      "Guard the access with a length check, or validate the input earlier.",
    ],
  },
  {
    language: "go",
    pattern: /slice bounds out of range/,
    kind: "go-slice-bounds",
    title: "Slice bounds out of range",
    explain: () => "A slice expression `s[a:b]` used bounds outside the slice's length or capacity.",
    nextSteps: ["Check the start/end values against `len(s)` before slicing."],
  },
  {
    language: "go",
    pattern: /assignment to entry in nil map/,
    kind: "go-nil-map-write",
    title: "Write to nil map",
    explain: () => "The code wrote to a map that was declared but never created with `make` or a literal.",
    nextSteps: ["Initialize the map (`m := make(map[K]V)`) before writing, including in struct constructors."],
  },
  {
    language: "go",
    pattern: /integer divide by zero/,
    kind: "go-divide-by-zero",
    title: "Integer divide by zero",
    explain: () => "An integer division or modulo used a zero divisor.",
    nextSteps: ["Check the divisor for zero before dividing, or validate the input that produces it."],
  },
  {
    language: "go",
    pattern: /interface conversion: (.+)/,
    kind: "go-type-assertion",
    title: "Failed type assertion",
    explain: (m) => `A type assertion failed: ${m[1]}.`,
    nextSteps: ["Use the two-value form `v, ok := x.(T)` and handle `!ok`, or a type switch."],
  },
  {
    language: "go",
    pattern: /concurrent map (writes|read and map write|iteration and map write)/,
    kind: "go-concurrent-map-access",
    title: "Concurrent map access",
    explain: () => "Two goroutines used the same map at the same time without synchronization. Go aborts instead of corrupting memory.",
    nextSteps: [
      "Protect the map with a `sync.Mutex`/`RWMutex`, or use `sync.Map` for this access pattern.",
      "Run the tests with `-race` to find every unsynchronized access.",
    ],
  },
  {
    language: "go",
    pattern: /all goroutines are asleep - deadlock/,
    kind: "go-deadlock",
    title: "Deadlock",
    explain: () => "Every goroutine is blocked (on a channel, mutex or WaitGroup), so the program can never make progress.",
    nextSteps: [
      "Look at what the failing goroutine waits on (its state is in the details table) and who should have sent or unlocked it.",
      "Check for unbuffered channels with no receiver and missing `wg.Done()` calls.",
    ],
  },
  {
    language: "go",
    pattern: /(send on closed channel|close of closed channel|close of nil channel)/,
    kind: "go-closed-channel",
    title: "Channel misuse",
    explain: (m) => `The program attempted a ${m[1]}.`,
    nextSteps: ["Make one owner responsible for closing the channel, and stop senders before it closes."],
  },
  {
    language: "go",
    pattern: /(stack overflow|goroutine stack exceeds)/,
    kind: "go-stack-overflow",
    title: "Stack overflow",
    explain: () => "A goroutine's stack exceeded its limit, almost always from unbounded recursion.",
    nextSteps: ["Look for a function that calls itself (directly or indirectly) without a base case."],
  },
  // Rust
  {
    language: "rust",
    pattern: /called `Option::unwrap\(\)` on a `None` value/,
    kind: "rust-unwrap-none",
    title: "Unwrap on None",
    explain: () => "`unwrap()` was called on an `Option` that was `None`.",
    nextSteps: NIL_STEPS,
  },
  {
    language: "rust",
    pattern: /called `Result::unwrap\(\)` on an `Err` value: (.*)/,
    kind: "rust-unwrap-err",
    title: "Unwrap on Err",
    explain: (m) => `\`unwrap()\` was called on a \`Result\` that held an error: \`${m[1]}\`.`,
    nextSteps: [
      "Propagate the error with `?` or handle it with `match`/`unwrap_or_else` instead of `unwrap()`.",
      "Check why the operation failed for this input (the error value is shown above).",
    ],
  },
  {
    language: "rust",
    pattern: /index out of bounds: the len is (\d+) but the index is (\d+)/,
    kind: "rust-index-out-of-bounds",
    title: "Index out of bounds",
    explain: (m) => `The code read index ${m[2]} of a collection with only ${m[1]} element${m[1] === "1" ? "" : "s"}.`,
    nextSteps: [
      "Check where the index comes from and whether the collection can be shorter than expected.",
      "Use `.get(i)` and handle `None` when the index isn't guaranteed to be valid.",
    ],
  },
  {
    language: "rust",
    pattern: /(range (start|end) index .* out of range|slice index starts at .* but ends at)/,
    kind: "rust-slice-range",
    title: "Slice range out of bounds",
    explain: (m) => `A slice range was invalid: ${m[1]}.`,
    nextSteps: ["Check the range bounds against the slice length before slicing."],
  },
  {
    language: "rust",
    pattern: /attempt to (add|subtract|multiply|negate|shift left|shift right) with overflow/,
    kind: "rust-arithmetic-overflow",
    title: "Arithmetic overflow",
    explain: (m) => `An integer ${m[1] === "add" ? "addition" : m[1] === "subtract" ? "subtraction" : m[1] === "multiply" ? "multiplication" : m[1]} overflowed its type (this check runs in debug builds; release builds silently wrap).`,
    nextSteps: [
      "Use a wider type, or `checked_*`/`saturating_*` arithmetic where overflow is possible.",
      "Note: in release builds this would have wrapped silently, so look for wrong results there too.",
    ],
  },
  {
    language: "rust",
    pattern: /attempt to (divide|calculate the remainder) (by zero|with a divisor of zero)/,
    kind: "rust-divide-by-zero",
    title: "Divide by zero",
    explain: () => "An integer division or remainder used a zero divisor.",
    nextSteps: ["Check the divisor for zero (or use `checked_div`) before dividing."],
  },
  {
    language: "rust",
    pattern: /(RefCell )?already (mutably )?borrowed/,
    kind: "rust-refcell-borrow",
    title: "RefCell borrowed twice",
    explain: () => "A `RefCell` was borrowed while an incompatible borrow was still alive (e.g. two `borrow_mut()` at once).",
    nextSteps: ["Shorten the first borrow's scope (drop it before borrowing again), or restructure to avoid overlapping borrows."],
  },
  {
    language: "rust",
    pattern: /^assertion (`left (==|!=) right` failed|failed)/,
    kind: "rust-assertion",
    title: "Assertion failed",
    explain: () => "An `assert!`/`assert_eq!` condition was false.",
    nextSteps: ["Open the failing line: the assertion states the invariant that this input broke."],
  },
  {
    language: "rust",
    pattern: /is not a char boundary/,
    kind: "rust-char-boundary",
    title: "String sliced inside a character",
    explain: () => "A `&str` was sliced at a byte offset that falls inside a multi-byte UTF-8 character.",
    nextSteps: ["Slice using `char_indices()` boundaries instead of raw byte offsets."],
  },
];

function classifyPanic(panic: ParsedPanic): {
  kind: string;
  title: string;
  explanation: string;
  nextSteps: readonly string[];
  confidence: "high" | "medium";
} {
  for (const rule of RULES) {
    if (rule.language !== panic.language) continue;
    const match = rule.pattern.exec(panic.message);
    if (match !== null)
      return {
        kind: rule.kind,
        title: rule.title,
        explanation: rule.explain(match),
        nextSteps: rule.nextSteps,
        confidence: "high",
      };
  }
  if (panic.language === "go" && panic.header === "fatal error")
    return {
      kind: "go-fatal-error",
      title: "Fatal runtime error",
      explanation: `The Go runtime stopped the program: ${panic.message}.`,
      nextSteps: ["Search the Go runtime docs for this message; fatal errors cannot be recovered."],
      confidence: "medium",
    };
  return {
    kind: `${panic.language}-explicit-panic`,
    title: "Explicit panic",
    explanation:
      panic.language === "go"
        ? `The code called \`panic\` with: "${panic.message}".`
        : `The code panicked deliberately (\`panic!\`, \`expect\`, \`unreachable!\` or similar) with: "${panic.message}".`,
    nextSteps: [
      "Open the panicking line: the message describes the condition the code didn't expect.",
      "Decide whether this situation should be handled and returned as an error instead.",
    ],
    confidence: "medium",
  };
}

/** Express a parsed panic as a crashlens Issue. */
export function toPanicIssue(panic: ParsedPanic, input: string, text: string): Issue {
  const classification = classifyPanic(panic);
  const own = panic.frames.filter((frame) => frame.own && !frame.createdBy);
  const first = own[0] ?? null;
  const place = first ?? panic.frames.find((frame) => !frame.createdBy) ?? null;
  const where =
    place !== null
      ? place.function
      : panic.location !== null
        ? `${panic.location.file}:${panic.location.line}`
        : null;
  const sourceLine =
    panic.location !== null
      ? `${panic.location.file}:${panic.location.line}${panic.location.column === null ? "" : `:${panic.location.column}`}`
      : first !== null && first.file !== null
        ? `${first.file}:${first.line}`
        : null;
  const language = panic.language === "go" ? "Go" : "Rust";

  const warnings: string[] = [];
  if (panic.frames.length === 0)
    warnings.push(
      panic.language === "rust"
        ? "No stack trace in the output. Rerun with `RUST_BACKTRACE=1` to see which functions led here."
        : "No goroutine stack trace in the output; only the message was available.",
    );
  if (panic.otherGoroutines > 0)
    warnings.push(
      `Only the failing goroutine is shown; ${panic.otherGoroutines} other goroutine${panic.otherGoroutines === 1 ? " was" : "s were"} in the output.`,
    );

  return {
    source: panic.language === "go" ? "go-panic" : "rust-panic",
    kind: classification.kind,
    title: classification.title,
    where,
    summary: `A ${language} program ${panic.header === "fatal error" ? "hit a fatal runtime error" : "panicked"}: **${lowerFirst(classification.title)}**${where === null ? "" : ` in \`${where}\``}${sourceLine === null || where === sourceLine ? "" : ` (\`${sourceLine}\`)`}. ${classification.explanation}`,
    facts: [
      { label: "Language", value: language },
      { label: "Message", value: code(truncate(panic.message, 200)) },
      ...(panic.context === null ? [] : [{ label: panic.language === "go" ? "Goroutine" : "Thread", value: `\`${panic.context}\`` }]),
      ...(sourceLine === null ? [] : [{ label: "Source", value: `\`${sourceLine}\`` }]),
      ...(panic.signal === null ? [] : [{ label: "Signal", value: `\`${panic.signal.replace(/^\[|\]$/g, "")}\`` }]),
    ],
    sections:
      panic.frames.length === 0
        ? []
        : [
            {
              heading: "Stack trace",
              kind: "code",
              language: "",
              lines: [
                ...panic.frames.map(frameLine),
                "",
                "→ marks frames in your code",
              ],
            },
          ],
    cause: classification.explanation,
    nextSteps: classification.nextSteps,
    confidence: classification.confidence,
    warnings,
    evidence: [
      `Input: \`${input}\` (sha256 \`${createHash("sha256").update(text).digest("hex")}\`)`,
      `Parsed as ${language} ${panic.header} output; ${panic.frames.length} frame${panic.frames.length === 1 ? "" : "s"}, ${own.length} in your code.`,
    ],
    limitations: [
      "Parsed from panic text only; no binary or core dump was examined.",
      "\"Your code\" is decided by package/crate name and file path, not by build metadata.",
    ],
    signature: signature(classification.kind, own, panic),
    footer: "Generated by crashlens from panic output; the program was not executed.",
  };
}

function frameLine(frame: PanicFrame, index: number): string {
  const marker = frame.own && !frame.createdBy ? "→" : " ";
  const name = frame.createdBy ? `created by ${frame.function}` : frame.function;
  const at =
    frame.file === null
      ? ""
      : `  at ${frame.file}:${frame.line}${frame.column === null ? "" : `:${frame.column}`}`;
  return `${marker} #${index} ${name}${at}`;
}

/**
 * Crash kind + top three frames in the user's code. Falls back to the
 * panic location's file name and line (never directories, which differ
 * between machines).
 */
function signature(kind: string, own: readonly PanicFrame[], panic: ParsedPanic): string {
  const parts =
    own.length > 0
      ? own.slice(0, 3).map((frame) => frame.function)
      : panic.location !== null
        ? [`${basename(panic.location.file)}:${panic.location.line}`]
        : [];
  return createHash("sha256").update([kind, ...parts].join("|")).digest("hex").slice(0, 12);
}

/** "Nil pointer" → "nil pointer", but keep names like "RefCell" intact. */
function lowerFirst(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text;
}

/** Inline code that survives backticks inside the text. */
function code(text: string): string {
  return text.includes("`") ? `\`\` ${text} \`\`` : `\`${text}\``;
}

function truncate(text: string, max: number): string {
  const single = text.replace(/\s+/g, " ");
  return single.length > max ? `${single.slice(0, max - 1)}…` : single;
}
