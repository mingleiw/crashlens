import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { parseFailure } from "../src/failure.js";
import { toFailureIssue } from "../src/failureIssue.js";
import { renderIssueMarkdown } from "../src/issue.js";

/**
 * Real output captured from Python 3.13, OpenJDK 21, Node 22 and GCC 13
 * AddressSanitizer/UBSan programs (paths anonymized).
 */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "failures");
const fixture = (name: string) => readFileSync(join(fixtures, `${name}.txt`), "utf8");

function analyze(name: string) {
  const text = fixture(name);
  const parsed = parseFailure(text);
  assert.ok(parsed.ok, `${name} should parse`);
  return { failure: parsed.value, issue: toFailureIssue(parsed.value, name, text) };
}

/** [fixture, language, kind, where] for every captured sample. */
const CASES: readonly [string, string, string, string][] = [
  ["py-none", "python", "python-none", "total"],
  ["py-key", "python", "python-key-error", "main"],
  ["py-index", "python", "python-index-error", "main"],
  ["py-div", "python", "python-zero-division", "ratio"],
  ["py-json", "python", "python-json-decode", "main"],
  ["py-recurse", "python", "python-recursion", "recurse"],
  ["py-file", "python", "python-file-error", "main"],
  ["py-chain", "python", "python-value-error", "main"],
  ["java-npe", "java", "java-null-pointer", "com.shop.Main.name"],
  ["java-null", "java", "java-null-pointer", "com.shop.Main.total"],
  ["java-index", "java", "java-index-out-of-bounds", "com.shop.Main.main"],
  ["java-cast", "java", "java-class-cast", "com.shop.Main.main"],
  ["java-cause", "java", "java-number-format", "com.shop.Main.parse"],
  ["java-cme", "java", "java-concurrent-modification", "com.shop.Main.main"],
  ["java-div", "java", "java-divide-by-zero", "com.shop.Main.main"],
  ["java-so", "java", "java-stack-overflow", "com.shop.Main.main"],
  ["node-undef", "node", "node-undefined-access", "total"],
  ["node-notfn", "node", "node-not-a-function", "Object.<anonymous>"],
  ["node-ref", "node", "node-reference-error", "Object.<anonymous>"],
  ["node-json", "node", "node-json-parse", "Object.<anonymous>"],
  ["node-recurse", "node", "node-stack-overflow", "recurse"],
  ["node-enoent", "node", "node-file-error", "Object.<anonymous>"],
  ["node-reject", "node", "node-error", "fetchUser"],
  ["asan-uaf", "sanitizer", "asan-use-after-free", "cost"],
  ["asan-overflow", "sanitizer", "asan-buffer-overflow", "sum"],
  ["asan-double", "sanitizer", "asan-double-free", "release"],
  ["asan-leak", "sanitizer", "asan-memory-leak", "leak"],
  ["asan-ubsan", "sanitizer", "ubsan-integer-overflow", "order.c:11"],
];

describe("every captured failure", () => {
  for (const [name, language, kind, where] of CASES)
    it(`${name}: ${kind} in ${where}`, () => {
      const { failure, issue } = analyze(name);
      assert.equal(failure.language, language);
      assert.equal(issue.kind, kind);
      assert.equal(issue.where, where);
    });
});

describe("Python", () => {
  it("reports the root cause of `raise ... from e` and lists the wrapper", () => {
    const { failure, issue } = analyze("py-chain");
    assert.equal(failure.errorType, "ValueError");
    assert.deepEqual(failure.wrappedBy, ["RuntimeError: could not parse quantity"]);
    assert.match(renderIssueMarkdown(issue), /\| Wrapped by \| `RuntimeError: could not parse quantity` \|/);
  });

  it("keeps the source line but drops the ~~^^ markers, most recent call first", () => {
    const { failure } = analyze("py-none");
    assert.deepEqual(
      failure.frames.map((f) => [f.function, f.line, f.code]),
      [
        ["total", 9, 'return sum(order["items"])'],
        ["main", 21, "print(total(load_order(1234)))"],
        ["<module>", 40, "main(sys.argv[1])"],
      ],
    );
  });
});

describe("Java", () => {
  it("reports the deepest Caused by and restores frames elided with '... N more'", () => {
    const { failure } = analyze("java-cause");
    assert.equal(failure.errorType, "java.lang.NumberFormatException");
    assert.deepEqual(failure.wrappedBy, ["IllegalStateException: bad config value"]);
    const own = failure.frames.filter((f) => f.own).map((f) => f.function);
    assert.deepEqual(own, ["com.shop.Main.parse", "com.shop.Main.load", "com.shop.Main.main"]);
  });

  it("uses the JVM's helpful NPE message", () => {
    assert.match(analyze("java-npe").issue.cause, /because the return value of "java\.util\.Map\.get\(Object\)" is null/);
  });
});

describe("Node.js", () => {
  it("attaches the printed source line and ignores node: internals", () => {
    const { failure } = analyze("node-undef");
    assert.equal(failure.frames[0]?.code, "function total(order) { return order.items.reduce((a, b) => a + b, 0); }");
    assert.deepEqual(failure.frames.filter((f) => f.own).map((f) => f.function), ["total", "handle", "Object.<anonymous>"]);
    assert.match(analyze("node-undef").issue.cause, /read `\.items` from a value that was `undefined`/);
  });
});

describe("sanitizers", () => {
  it("keeps the freed-by and allocated-by stacks for use-after-free", () => {
    const { failure, issue } = analyze("asan-uaf");
    assert.deepEqual(failure.extraStacks.map((s) => s.title), [
      "freed by thread T0 here",
      "previously allocated by thread T0 here",
    ]);
    assert.equal(failure.extraStacks[0]?.frames.find((f) => f.own)?.function, "release");
    assert.equal(failure.context, "READ of 4 bytes at 0x502000000010 (thread T0)");
    assert.doesNotMatch(failure.message, / at pc /);
    assert.ok(issue.sections.some((s) => s.heading === "Freed by thread T0 here"));
  });

  it("treats libc, interceptors and the sanitizer runtime as not your code", () => {
    const { failure } = analyze("asan-leak");
    assert.deepEqual(failure.frames.filter((f) => f.own).map((f) => f.function), ["leak", "main"]);
  });
});

describe("log context", () => {
  it("shows the log lines printed before the failure, in every language", () => {
    for (const name of ["py-none", "java-npe", "node-undef", "asan-uaf"]) {
      const { issue } = analyze(name);
      const logs = issue.sections.find((s) => s.heading === "Log lines before the failure");
      assert.ok(logs && logs.kind === "code", name);
      assert.match(logs.lines.join("\n"), /processing order 1234/, name);
      assert.doesNotMatch(logs.lines.join("\n"), /Traceback|Exception in thread|TypeError|==ERROR/, name);
    }
  });

  it("has no log section when the failure is the first thing in the output", () => {
    const text = fixture("py-none").split("\n").filter((line) => !/ INFO /.test(line)).join("\n");
    const parsed = parseFailure(text);
    assert.ok(parsed.ok);
    const issue = toFailureIssue(parsed.value, "x", text);
    assert.ok(!issue.sections.some((s) => s.heading === "Log lines before the failure"));
  });
});

describe("signatures", () => {
  it("group the same bug across machines and separate different bugs", () => {
    const a = analyze("py-none").issue.signature;
    const moved = fixture("py-none").replaceAll("/srv/shop", "/home/ci/build/shop");
    const parsed = parseFailure(moved);
    assert.ok(parsed.ok);
    assert.equal(toFailureIssue(parsed.value, "y", moved).signature, a);
    assert.notEqual(analyze("py-key").issue.signature, a);
  });
});
