import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { renderBatchMarkdown, triageBatch } from "../src/batch.js";
import { renderIssueMarkdown } from "../src/issue.js";
import { parseFailure as parsePanic } from "../src/failure.js";
import { toFailureIssue as toPanicIssue } from "../src/failureIssue.js";

/** Real panic output captured from Go 1.24 and Rust 1.97 programs. */
const fixtures = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "test", "fixtures", "panics");
const fixture = (name: string) => readFileSync(join(fixtures, `${name}.txt`), "utf8");

function issueFor(name: string) {
  const text = fixture(name);
  const parsed = parsePanic(text);
  assert.ok(parsed.ok, `${name} should parse`);
  return { panic: parsed.value, issue: toPanicIssue(parsed.value, `${name}.txt`, text) };
}

describe("Go panics", () => {
  it("classifies runtime panics and names the first frame in the user's code", () => {
    const cases: [string, string, string][] = [
      ["go-nil", "go-nil-pointer", "main.total"],
      ["go-index", "go-index-out-of-range", "main.pick"],
      ["go-map", "go-nil-map-write", "main.main"],
      ["go-assert", "go-type-assertion", "main.main"],
      ["go-custom", "go-explicit-panic", "main.main"],
      ["go-deadlock", "go-deadlock", "main.main"],
      ["go-mapwrite", "go-concurrent-map-access", "main.main.func1"],
    ];
    for (const [name, kind, where] of cases) {
      const { issue } = issueFor(name);
      assert.equal(issue.kind, kind, name);
      assert.equal(issue.where, where, name);
    }
  });

  it("keeps runtime frames but marks only the program's own frames", () => {
    const { panic } = issueFor("go-mapwrite");
    assert.deepEqual(
      panic.frames.map((frame) => [frame.function, frame.own, frame.createdBy]),
      [
        ["internal/runtime/maps.fatal", false, false],
        ["main.main.func1", true, false],
        ["main.main", true, true],
      ],
    );
    assert.ok(panic.otherGoroutines > 0);
  });

  it("explains index errors with the actual numbers and records the signal", () => {
    assert.match(issueFor("go-index").issue.cause, /index 5 of a slice or array that only has 3 elements/);
    const { panic, issue } = issueFor("go-nil");
    assert.match(panic.signal ?? "", /SIGSEGV/);
    assert.equal(issue.facts.find((fact) => fact.label === "Source")?.value, "`/home/dev/shop/main.go:13`");
  });
});

describe("Rust panics", () => {
  it("reads modern headers with and without backtraces", () => {
    const withTrace = issueFor("rs-none-bt");
    assert.equal(withTrace.issue.kind, "rust-unwrap-none");
    assert.equal(withTrace.issue.where, "rsapp::find_user");

    const bare = issueFor("rs-none");
    assert.equal(bare.issue.kind, "rust-unwrap-none");
    assert.equal(bare.issue.where, "src/main.rs:5");
    assert.match(bare.issue.warnings[0] ?? "", /RUST_BACKTRACE=1/);
  });

  it("strips crate disambiguators and hashes from full backtraces", () => {
    const { panic, issue } = issueFor("rs-none-full");
    assert.equal(issue.where, "rsapp::find_user");
    assert.ok(panic.frames.every((frame) => !/\[[0-9a-f]{16}\]/.test(frame.function)));
    assert.equal(issue.signature, issueFor("rs-none-bt").issue.signature, "full and short traces group together");
  });

  it("classifies unwrap(Err), overflow, assertions and RefCell misuse", () => {
    assert.match(issueFor("rs-err-bt").issue.cause, /ParseIntError \{ kind: InvalidDigit \}/);
    assert.equal(issueFor("rs-overflow-bt").issue.kind, "rust-arithmetic-overflow");
    assert.equal(issueFor("rs-assert").issue.kind, "rust-assertion");
    assert.equal(issueFor("rs-borrow-bt").issue.kind, "rust-refcell-borrow");
  });

  it("still reads the pre-1.73 header format", () => {
    const parsed = parsePanic("thread 'main' panicked at 'called `Option::unwrap()` on a `None` value', src/lib.rs:42:9\n");
    assert.ok(parsed.ok);
    assert.equal(parsed.value.location?.line, 42);
    assert.equal(toPanicIssue(parsed.value, "x", "").kind, "rust-unwrap-none");
  });

  it("renders backtick-heavy messages safely inside the table", () => {
    const markdown = renderIssueMarkdown(issueFor("rs-none").issue);
    assert.match(markdown, /^# Panic: Unwrap on None in `src\/main\.rs:5`/);
    assert.match(markdown, /\| Message \| `` called `Option::unwrap\(\)` on a `None` value `` \|/);
  });
});

describe("parsePanic", () => {
  it("rejects text without a panic", () => {
    const parsed = parsePanic("all good\nexit 0\n");
    assert.equal(parsed.ok, false);
  });

  it("signatures ignore directories so the same bug groups across machines", () => {
    const original = fixture("go-nil");
    const moved = original.replaceAll("/home/dev/shop", "/srv/build/123/shop");
    const a = parsePanic(original);
    const b = parsePanic(moved);
    assert.ok(a.ok && b.ok);
    assert.equal(toPanicIssue(a.value, "a", original).signature, toPanicIssue(b.value, "b", moved).signature);
  });
});

describe("batch", () => {
  it("groups duplicates, ranks by count and explains what it skipped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "crashlens-batch-"));
    try {
      mkdirSync(join(dir, "api"));
      writeFileSync(join(dir, "api", "a.log"), fixture("go-nil"));
      writeFileSync(join(dir, "api", "b.log"), fixture("go-nil").replaceAll("/home/dev", "/opt"));
      writeFileSync(join(dir, "worker.log"), fixture("rs-err-bt"));
      writeFileSync(join(dir, "notes.txt"), "nothing to see\n");
      // ELF header with e_type = ET_CORE (4); no binary given, so it is skipped.
      const core = Buffer.alloc(64);
      core.writeUInt32BE(0x7f454c46, 0);
      core.writeUInt16LE(4, 16);
      writeFileSync(join(dir, "core.1"), core);
      writeFileSync(join(dir, ".hidden.log"), fixture("go-nil"));

      const result = await triageBatch({ directory: dir, binaryPath: null, rea: { file: "rea", args: [] }, gdb: null });
      assert.equal(result.failures, 3);
      assert.deepEqual(result.groups.map((g) => [g.issue.kind, g.files.length]), [
        ["go-nil-pointer", 2],
        ["rust-unwrap-err", 1],
      ]);
      assert.deepEqual(result.skipped.map((s) => s.file), ["core.1", "notes.txt"]);
      assert.match(result.skipped[0]?.reason ?? "", /needs the crashed binary/);

      const markdown = renderBatchMarkdown(result);
      assert.match(markdown, /^# crashlens: 3 failures, 2 distinct bugs/);
      assert.match(markdown, /\| 1 \| Nil pointer dereference \| `main.total` \| \*\*2\*\* \|/);
      assert.match(markdown, /### Panic: Nil pointer dereference in `main.total`/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
