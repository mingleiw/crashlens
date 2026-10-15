import type { FailureLanguage, ParsedFailure } from "./failure.js";

export interface Classification {
  readonly kind: string;
  readonly title: string;
  readonly explanation: string;
  readonly nextSteps: readonly string[];
  readonly confidence: "high" | "medium";
}

export interface FailureRule {
  readonly language: FailureLanguage;
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
const RULES: readonly FailureRule[] = [
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

  // Python
  rule("python", /^(?:AttributeError: 'NoneType' object has no attribute '(\w+)'|TypeError: 'NoneType' object is not (subscriptable|iterable|callable))/, "python-none", "Value was None",
    (m) => m[1] !== undefined ? `The code accessed \`.${m[1]}\` on a value that was \`None\`.` : `The code used \`None\` as if it were a real value (it is not ${m[2]}).`,
    NIL_STEPS),
  rule("python", /^KeyError: (.*)/, "python-key-error", "Missing dictionary key",
    (m) => `The code looked up key ${m[1]} in a dict that doesn't contain it.`,
    ["Check where the dict is built and whether this key is optional.", "Use `.get(key)` with a default, or validate the input that should contain it."]),
  rule("python", /^IndexError: (.*)/, "python-index-error", "Index out of range",
    (m) => `A list or sequence was indexed past its end (${m[1]}).`,
    ["Check the index against `len(...)` and whether the sequence can be empty."]),
  rule("python", /^ZeroDivisionError/, "python-zero-division", "Division by zero",
    () => "A division or modulo used zero as the divisor.",
    ["Check the divisor before dividing, or validate the input that produces it."]),
  rule("python", /^RecursionError/, "python-recursion", "Infinite recursion",
    () => "A function kept calling itself until Python's recursion limit was hit.",
    ["Find the repeating frame in the stack trace and check its base case."]),
  rule("python", /^(?:json\.decoder\.)?JSONDecodeError: (.*)/, "python-json-decode", "Invalid JSON",
    (m) => `The code tried to parse text that isn't valid JSON (${m[1]}).`,
    ["Log or inspect the raw text being parsed (often an HTML error page or an empty response).", "Handle the decode error where untrusted input is parsed."]),
  rule("python", /^(FileNotFoundError|PermissionError|IsADirectoryError): (.*)/, "python-file-error", "File not accessible",
    (m) => `A file operation failed: ${m[2]}.`,
    ["Check the path and working directory the program runs with (configs often differ between machines).", "Fail with a clear message if a required file is missing."]),
  rule("python", /^(ConnectionRefusedError|ConnectionResetError|TimeoutError|socket\.timeout|requests\.exceptions\.\w+|urllib3\.exceptions\.\w+|httpx\.\w+Error): (.*)/, "python-network", "Network call failed",
    (m) => `A network call failed with ${m[1]}: ${m[2]}.`,
    ["Check that the service it calls is up and reachable from where this ran.", "Add a timeout, retry with backoff, or a clear error for this call."]),
  rule("python", /^(ModuleNotFoundError|ImportError): (.*)/, "python-import", "Import failed",
    (m) => `A module could not be imported: ${m[2]}.`,
    ["Check that the dependency is installed in the environment that ran this (virtualenv, container image)."]),
  rule("python", /^UnboundLocalError: (.*)/, "python-unbound-local", "Variable used before assignment",
    (m) => `A local variable was read before any branch assigned it (${m[1]}).`,
    ["Make sure every code path assigns the variable, or initialize it before the branches."]),
  rule("python", /^AssertionError/, "python-assertion", "Assertion failed",
    () => "An `assert` condition was false.",
    ["Open the failing line: the assertion states the invariant that this input broke."]),
  rule("python", /^ValueError: (.*)/, "python-value-error", "Invalid value",
    (m) => `A function received a value it can't handle: ${m[1]}.`,
    ["Check where this value comes from (often user input or a config file) and validate it there."]),

  // Java
  rule("java", /NullPointerException(?:: (.*))?$/, "java-null-pointer", "Null pointer",
    (m) => m[1] ? `A null value was used: ${m[1]}.` : "A null reference was used as if it pointed to an object.",
    NIL_STEPS),
  rule("java", /(?:ArrayIndexOutOfBounds|StringIndexOutOfBounds|IndexOutOfBounds)Exception(?:: (.*))?$/, "java-index-out-of-bounds", "Index out of bounds",
    (m) => `An array, list or string was indexed outside its bounds${m[1] ? ` (${m[1]})` : ""}.`,
    ["Check the index against the collection's size and whether it can be empty."]),
  rule("java", /ClassCastException(?:: (.*))?$/, "java-class-cast", "Invalid cast",
    (m) => `An object was cast to a type it isn't${m[1] ? `: ${m[1]}` : ""}.`,
    ["Check the object's real type with `instanceof` (or pattern matching) before casting."]),
  rule("java", /NumberFormatException: (.*)$/, "java-number-format", "Text is not a number",
    (m) => `Text that isn't a valid number was parsed as one (${m[1]}).`,
    ["Validate the input (often config or user input) before parsing, and report a clear error."]),
  rule("java", /ConcurrentModificationException/, "java-concurrent-modification", "Collection modified while iterating",
    () => "A collection was changed while a loop (or another thread) was iterating over it.",
    ["Use `Iterator.remove()` or `removeIf`, collect changes and apply them after the loop, or use a concurrent collection."]),
  rule("java", /ArithmeticException: \/ by zero/, "java-divide-by-zero", "Division by zero",
    () => "An integer division used zero as the divisor.",
    ["Check the divisor before dividing."]),
  rule("java", /StackOverflowError/, "java-stack-overflow", "Stack overflow",
    () => "A method kept calling itself (directly or indirectly) until the thread's stack ran out.",
    ["Find the repeating frames in the stack trace and check the recursion's base case."]),
  rule("java", /OutOfMemoryError(?:: (.*))?$/, "java-out-of-memory", "Out of memory",
    (m) => `The JVM ran out of memory${m[1] ? ` (${m[1]})` : ""}.`,
    ["Check for unbounded caches or collections; capture a heap dump with -XX:+HeapDumpOnOutOfMemoryError."]),
  rule("java", /NoSuchElementException(?:: (.*))?$/, "java-no-such-element", "Missing element",
    (m) => `An empty Optional, iterator or collection was asked for a value${m[1] ? ` (${m[1]})` : ""}.`,
    ["Check `isPresent()`/`hasNext()`, or use `orElse`/`orElseThrow` with a clear message."]),
  rule("java", /UnsupportedOperationException/, "java-unsupported-operation", "Unsupported operation",
    () => "An operation was called that the object doesn't support, most often modifying an immutable collection (`List.of`, `Collections.unmodifiable…`).",
    ["Copy into a mutable collection (`new ArrayList<>(...)`) before modifying it."]),
  rule("java", /(?:FileNotFoundException|NoSuchFileException|AccessDeniedException)(?:: (.*))?$/, "java-file-error", "File not accessible",
    (m) => `A file operation failed${m[1] ? `: ${m[1]}` : ""}.`,
    ["Check the path and working directory the program runs with."]),
  rule("java", /(?:SocketTimeoutException|ConnectException|UnknownHostException|SSLHandshakeException)(?:: (.*))?$/, "java-network", "Network call failed",
    (m) => `A network call failed${m[1] ? `: ${m[1]}` : ""}.`,
    ["Check that the service it calls is reachable from where this ran.", "Add a timeout, retries with backoff, or a clear error for this call."]),
  rule("java", /(Illegal(?:State|Argument)Exception)(?:: (.*))?$/, "java-illegal-state", "Precondition failed",
    (m) => `The code rejected a ${m[1]?.startsWith("IllegalState") ? "state" : "argument"} it doesn't accept${m[2] ? `: ${m[2]}` : ""}.`,
    ["Check the caller and the data it passed; the message names the condition that failed."]),

  // Node.js
  rule("node", /^TypeError: Cannot read properties of (undefined|null)(?: \(reading '(.*)'\))?/, "node-undefined-access", "Read from undefined",
    (m) => `The code read ${m[2] !== undefined ? `\`.${m[2]}\`` : "a property"} from a value that was \`${m[1]}\`.`,
    NIL_STEPS),
  rule("node", /^TypeError: Cannot set properties of (undefined|null)(?: \(setting '(.*)'\))?/, "node-undefined-write", "Write to undefined",
    (m) => `The code set ${m[2] !== undefined ? `\`.${m[2]}\`` : "a property"} on a value that was \`${m[1]}\`.`,
    NIL_STEPS),
  rule("node", /^TypeError: (.+?) is not a function/, "node-not-a-function", "Not a function",
    (m) => `\`${m[1]}\` was called, but it isn't a function (a typo, a missing method, or an import that is undefined).`,
    ["Check the object actually has this method, and that the import or require returned what you expect."]),
  rule("node", /^ReferenceError: (.+?) is not defined/, "node-reference-error", "Undefined variable",
    (m) => `The code used \`${m[1]}\`, which isn't declared in scope.`,
    ["Check for a typo or a missing import/declaration."]),
  rule("node", /^RangeError: Maximum call stack size exceeded/, "node-stack-overflow", "Stack overflow",
    () => "A function kept calling itself until the call stack ran out.",
    ["Find the repeating frames in the stack trace and check the recursion's base case."]),
  rule("node", /^SyntaxError: (.*JSON.*)/, "node-json-parse", "Invalid JSON",
    (m) => `The code tried to parse text that isn't valid JSON (${m[1]}).`,
    ["Log or inspect the raw text being parsed (often an HTML error page or an empty body).", "Wrap untrusted JSON.parse calls and report a clear error."]),
  rule("node", /^Error: (ENOENT|EACCES|EISDIR|ENOTDIR): (.*)/, "node-file-error", "File not accessible",
    (m) => `A file operation failed (${m[1]}): ${m[2]}.`,
    ["Check the path and working directory the program runs with.", "Fail with a clear message if a required file is missing."]),
  rule("node", /^Error: (connect ECONNREFUSED|getaddrinfo ENOTFOUND|read ECONNRESET|connect ETIMEDOUT|socket hang up)(.*)/, "node-network", "Network call failed",
    (m) => `A network call failed: ${m[1]}${m[2]}.`,
    ["Check that the service it calls is up and reachable from where this ran.", "Add a timeout, retry with backoff, or a clear error for this call."]),

  // Sanitizers (C, C++, Rust, Go with -fsanitize)
  rule("sanitizer", /^heap-use-after-free/, "asan-use-after-free", "Use after free",
    () => "Memory was used after it had been freed. The report shows where it was freed and where it was allocated.",
    ["Compare the 'freed by' and the crashing stack: who frees this object, and who still holds a pointer to it?", "Clear or invalidate the pointer when freeing, or make ownership explicit."]),
  rule("sanitizer", /^(heap|stack|global)-buffer-overflow/, "asan-buffer-overflow", "Buffer overflow",
    (m) => `The code read or wrote past the end of a ${m[1]} buffer.`,
    ["Check loop bounds (`<` vs `<=`) and size calculations for this buffer.", "The 'allocated by' stack shows how big the buffer was made."]),
  rule("sanitizer", /^(stack-use-after-return|stack-use-after-scope)/, "asan-stack-use-after-scope", "Use of expired stack memory",
    () => "The code used a pointer to a local variable after its function returned or its scope ended.",
    ["Don't return or store pointers to locals; allocate on the heap or copy the value."]),
  rule("sanitizer", /^(double-free|attempting double-free)/, "asan-double-free", "Double free",
    () => "The same memory was freed twice.",
    ["Find both free calls in the stacks and decide which one owns the memory; set the pointer to NULL after freeing."]),
  rule("sanitizer", /^(bad-free|attempting free on address which was not malloc|alloc-dealloc-mismatch)/, "asan-bad-free", "Invalid free",
    () => "Memory was freed with the wrong function or wasn't heap memory at all (e.g. `delete` on `malloc`ed memory).",
    ["Match each allocation with its deallocator (malloc/free, new/delete, new[]/delete[])."]),
  rule("sanitizer", /^SEGV on unknown address (0x0+\b|\(nil\)|0x0*[0-9a-f]{1,3}\b)/, "asan-null-dereference", "NULL pointer dereference",
    () => "The program read or wrote through a NULL (or nearly NULL) pointer.",
    NIL_STEPS),
  rule("sanitizer", /^SEGV on unknown address/, "asan-segv", "Invalid memory access",
    () => "The program accessed an address that isn't mapped: a wild, freed or uninitialized pointer.",
    ["Check where the pointer used in the first frame comes from."]),
  rule("sanitizer", /^detected memory leaks/, "asan-memory-leak", "Memory leak",
    () => "Memory was allocated and never freed. The stack shows where it was allocated.",
    ["Find who should own this allocation and free it on every path (including error paths)."]),
  rule("sanitizer", /^data race/, "tsan-data-race", "Data race",
    () => "Two threads accessed the same memory at the same time, at least one writing, without synchronization.",
    ["Protect the shared data with a lock or atomic, or give each thread its own copy."]),
  rule("sanitizer", /^use-of-uninitialized-value/, "msan-uninitialized", "Uninitialized memory used",
    () => "A value was used before it was ever set.",
    ["Initialize the variable or buffer before use."]),
  rule("sanitizer", /^undefined-behavior: (signed integer overflow.*)/, "ubsan-integer-overflow", "Integer overflow",
    (m) => `${upperFirst(m[1] ?? "")}.`,
    ["Use a wider type or check the operands before the arithmetic."]),
  rule("sanitizer", /^undefined-behavior: (.*null pointer.*)/, "ubsan-null", "NULL pointer misuse",
    (m) => `${upperFirst(m[1] ?? "")}.`,
    NIL_STEPS),
  rule("sanitizer", /^undefined-behavior: (.*)/, "ubsan-undefined-behavior", "Undefined behavior",
    (m) => `${upperFirst(m[1] ?? "")}.`,
    ["Fix the operation at the reported line; undefined behavior can silently produce wrong results in release builds."]),

];

function rule(
  language: FailureLanguage,
  pattern: RegExp,
  kind: string,
  title: string,
  explain: (match: RegExpExecArray) => string,
  nextSteps: readonly string[],
): FailureRule {
  return { language, pattern, kind, title, explain, nextSteps };
}

function upperFirst(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** Text a rule's pattern is matched against. */
function subject(failure: ParsedFailure): string {
  // ASan/LSan/TSan messages already start with the bug type ("heap-use-after-free on ...").
  if (failure.language === "sanitizer" && failure.errorType !== "undefined-behavior")
    return failure.message;
  return failure.errorType === null ? failure.message : `${failure.errorType}: ${failure.message}`;
}

export function classifyFailure(failure: ParsedFailure): Classification {
  const text = subject(failure);
  for (const rule of RULES) {
    if (rule.language !== failure.language) continue;
    const match = rule.pattern.exec(text);
    if (match !== null)
      return {
        kind: rule.kind,
        title: rule.title,
        explanation: rule.explain(match),
        nextSteps: rule.nextSteps,
        confidence: "high",
      };
  }
  return fallback(failure);
}

const READ_THE_MESSAGE = "Open the first frame in your code: the message describes the condition it didn't expect.";

function fallback(failure: ParsedFailure): Classification {
  const quoted = failure.message === "" ? "" : ` with: "${failure.message}"`;
  switch (failure.language) {
    case "go":
      return failure.header === "fatal error"
        ? {
            kind: "go-fatal-error",
            title: "Fatal runtime error",
            explanation: `The Go runtime stopped the program: ${failure.message}.`,
            nextSteps: ["Search the Go runtime docs for this message; fatal errors cannot be recovered."],
            confidence: "medium",
          }
        : {
            kind: "go-explicit-panic",
            title: "Explicit panic",
            explanation: `The code called \`panic\`${quoted}.`,
            nextSteps: [READ_THE_MESSAGE, "Decide whether this situation should be returned as an error instead."],
            confidence: "medium",
          };
    case "rust":
      return {
        kind: "rust-explicit-panic",
        title: "Explicit panic",
        explanation: `The code panicked deliberately (\`panic!\`, \`expect\`, \`unreachable!\` or similar)${quoted}.`,
        nextSteps: [READ_THE_MESSAGE, "Decide whether this situation should be returned as an error instead."],
        confidence: "medium",
      };
    case "sanitizer":
      return {
        kind: `sanitizer-${(failure.errorType ?? "report").toLowerCase()}`,
        title: `${failure.header}: ${failure.errorType ?? "report"}`,
        explanation: `${failure.header} reported: ${failure.message}.`,
        nextSteps: ["Open the first frame in your code and check the memory it touches."],
        confidence: "medium",
      };
    default: {
      const type = failure.errorType ?? "Error";
      const short = type.slice(type.lastIndexOf(".") + 1);
      return {
        kind: `${failure.language}-${short.toLowerCase()}`,
        title: `Uncaught ${short}`,
        explanation: `The program raised \`${short}\`${quoted} and nothing handled it.`,
        nextSteps: [READ_THE_MESSAGE, "Decide whether this error should be caught and handled, or prevented earlier."],
        confidence: "medium",
      };
    }
  }
}
