// Regressions for the security and correctness review findings.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { analyzeFile } from "../src/analyze.js";
import { parseFailure } from "../src/failure.js";
import { logContext, toFailureIssue } from "../src/failureIssue.js";
import { renderIssueMarkdown } from "../src/issue.js";
import { nativeHypotheses } from "../src/nativeHints.js";
import { attachSource } from "../src/source.js";
import type { TriageReport } from "../src/triage.js";

const work = mkdtempSync(join(tmpdir(), "crashlens-review-"));
after(() => rmSync(work, { recursive: true, force: true }));

function project(name: string, files: Record<string, string[]>): string {
  const dir = join(work, name);
  for (const [file, lines] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, file)), { recursive: true });
    writeFileSync(join(dir, file), lines.join("\n"));
  }
  return dir;
}

function parse(output: string) {
  const parsed = parseFailure(output);
  assert.ok(parsed.ok, "parses");
  return parsed.value;
}

async function report(root: string, output: string): Promise<string> {
  return renderIssueMarkdown(await attachSource(toFailureIssue(parse(output), "err", output), root));
}

const hypotheses = (md: string) => /## Hypotheses to check first\n\n([\s\S]*?)\n## /.exec(md)?.[1] ?? "";
const node = (root: string, message: string, frames: string[]) =>
  [`TypeError: Cannot read properties of undefined (reading '${message}')`, ...frames.map((f) => `    at ${f.replaceAll("@", root)}`)].join("\n");
const py = (root: string, frames: [string, number, string, string][], error: string) =>
  ["Traceback (most recent call last):", ...frames.flatMap(([f, l, fn, code]) => [`  File "${root}/${f}", line ${l}, in ${fn}`, `    ${code}`]), error].join("\n");

describe("security", () => {
  it("never lets the analyzed repo's git config run a command", async () => {
    const root = project("evil-git", { "app.py": ["def f(x):", "    return x.name", "f(None)"] });
    const marker = join(work, "pwned");
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", ...a], { cwd: root });
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "x");
    writeFileSync(join(root, ".gitattributes"), "*.py diff=evil\n");
    git("config", "core.fsmonitor", `touch ${marker}; false`);
    git("config", "diff.evil.textconv", `sh -c 'touch ${marker}; cat "$0"'`);
    git("config", "filter.evil.clean", `sh -c 'touch ${marker}; cat'`);
    writeFileSync(join(root, ".gitattributes"), "*.py diff=evil filter=evil\n");
    const md = await report(root, py(root, [["app.py", 3, "<module>", "f(None)"], ["app.py", 2, "f", "return x.name"]], "AttributeError: 'NoneType' object has no attribute 'name'"));
    assert.equal(existsSync(marker), false, "no repo-configured command ran");
    assert.match(md, /Last change to these lines/, "blame still works");
  });

  it("does not quote dotfiles or non-source files named by a crafted frame", async () => {
    const root = project("secrets", { ".env": ["A=1", "AWS_SECRET_ACCESS_KEY=hunter2"], "notes.txt": ["x", "private"] });
    const md = await report(root, py(root, [[".env", 2, "<module>", "x"], ["notes.txt", 2, "f", "y"]], "ValueError: bad"));
    assert.doesNotMatch(md, /hunter2|private/);
  });

  it("stays fast on inputs built to make regexes backtrack", () => {
    const cases = [
      "TypeError: x\n    at " + " (".repeat(100_000),
      "a".repeat(10) + " ".repeat(100_000) + "x\nTraceback (most recent call last):\n  File \"a.py\", line 1, in f\n    x\nValueError: v",
      "Traceback (most recent call last):\n" + "\t".repeat(50_000) + "x\n  File \"a.py\", line 1, in f\nValueError: v",
      "thread 'a' panicked at '\n".repeat(20_000),
    ];
    for (const text of cases) {
      const started = performance.now();
      parseFailure(text);
      logContext(text, text.length);
      assert.ok(performance.now() - started < 1000, `took ${Math.round(performance.now() - started)} ms`);
    }
  });

  it("refuses non-regular and oversized input files", () => {
    const big = join(work, "big.log");
    writeFileSync(big, Buffer.alloc(9 * 1024 * 1024, 0x61));
    const tooBig = analyzeFile(big);
    assert.ok(!tooBig.ok && /larger than/.test(tooBig.message));
    const dir = analyzeFile(work);
    assert.ok(!dir.ok && /not a regular file/.test(dir.message));
  });

  it("keeps crash text from closing a Markdown code fence", async () => {
    const root = project("fence", { "app.js": ["function f(u) {", "  return `${u.name}` + '```';", "}", "f();"] });
    const md = await report(root, node(root, "name", ["f (@/app.js:2:13)", "Object.<anonymous> (@/app.js:4:1)"]));
    assert.match(md, /^````javascript$/m, "fence longer than the backtick run inside");
  });
});

describe("value trace: no confident wrong hypotheses", () => {
  it("anonymous callbacks and TS methods with modifiers do not borrow another function's variables", async () => {
    const js = project("anon", {
      "store.js": ["async function fetchOwner(id) { return { name: 'root' }; }", "module.exports = { fetchOwner };"],
      "app.js": [
        'const { fetchOwner } = require("./store");',
        "async function audit() {",
        "  const u = fetchOwner(1);",
        "  return (await u).name;",
        "}",
        "function label(user) {",
        "  return user.name.toUpperCase();",
        "}",
        "[1, 2].map((id) => ({})[id]).forEach((u) => console.log(label(u)));",
      ],
    });
    const md = await report(js, node(js, "name", ["label (@/app.js:7:15)", "@/app.js:9:55", "Array.forEach (<anonymous>)", "Object.<anonymous> (@/app.js:9:28)"]));
    assert.equal(hypotheses(md), "");
    const ts = project("tsmethod", {
      "service.ts": [
        "export class UserService {",
        "  private cache = new Map<string, { name: string }>();",
        "  warm(ids: string[]): void {",
        "    for (const id of ids) { const user = this.cache.get(id); }",
        "  }",
        "  public label(user: { name: string } | undefined): string {",
        "    return user.name.toUpperCase();",
        "  }",
        "}",
      ],
    });
    const tsMd = await report(ts, node(ts, "name", ["UserService.label (@/service.ts:7:17)"]));
    assert.equal(hypotheses(tsMd), "");
  });

  it("resolves the imported function, not a same-named one elsewhere", async () => {
    const root = project("imports", {
      "api/client.js": ["async function getUser(id) { return (await fetch('/u/' + id)).json(); }", "module.exports = { getUser };"],
      "lib/users.js": ["const rows = { 1: { name: 'ada' } };", "function getUser(id) { return rows[id]; }", "module.exports = { getUser };"],
      "lib/handler.js": ['const { getUser } = require("./users");', "function show(id) {", "  const user = getUser(id);", "  return user.name;", "}", "show(2);"],
    });
    const md = await report(root, node(root, "name", ["show (@/lib/handler.js:4:15)", "Object.<anonymous> (@/lib/handler.js:6:1)"]));
    assert.doesNotMatch(md, /Missing `await`/);
    assert.match(md, /## Code: lib\/users\.js:2 \(getUser\)/);
  });

  it("never says missing await for a Python NoneType error", async () => {
    const root = project("pyawait", {
      "users.py": ["async def get_user(uid):", "    return None"],
      "app.py": ["from users import get_user", "def show(uid):", "    user = get_user(uid)", "    return user.name", "show(1)"],
    });
    const md = await report(root, py(root, [["app.py", 5, "<module>", "show(1)"], ["app.py", 4, "show", "return user.name"]], "AttributeError: 'NoneType' object has no attribute 'name'"));
    assert.doesNotMatch(md, /Missing `await`/);
  });

  it("maps TS generic parameters and Python keyword arguments to the right argument", async () => {
    const ts = project("generics", {
      "app.ts": [
        "function render(opts: Record<string, string>, user, theme?) {",
        "  return opts.x + user.name;",
        "}",
        "function page(current) {",
        "  return render({}, current, cache.get(id)?.name);",
        "}",
        "page(undefined);",
      ],
    });
    const tsMd = await report(ts, node(ts, "name", ["render (@/app.ts:2:25)", "page (@/app.ts:5:10)", "Object.<anonymous> (@/app.ts:7:1)"]));
    assert.match(tsMd, /`user` is a parameter of `render`, passed as `current`/);
    assert.doesNotMatch(tsMd, /lookup found nothing/);
    const pyRoot = project("kwargs", {
      "app.py": ["SETTINGS = {}", "def greet(user, theme=None):", "    return user.name", "def main(current):", '    return greet(theme=SETTINGS.get("theme"), user=current)', "main(None)"],
    });
    const pyMd = await report(pyRoot, py(pyRoot, [["app.py", 6, "<module>", "main(None)"], ["app.py", 5, "main", "return greet(...)"], ["app.py", 3, "greet", "return user.name"]], "AttributeError: 'NoneType' object has no attribute 'name'"));
    assert.match(pyMd, /`user` is a parameter of `greet`, passed as `current`/);
    assert.doesNotMatch(pyMd, /lookup found nothing/);
  });

  it("does not blame the environment for a value already converted, or flag ordinary literals as case mismatches", async () => {
    const env = project("envint", { "config.py": ["import os", 'TIMEOUT = int(os.environ.get("TIMEOUT", "30"))'], "app.py": ["import config", "def deadline(start):", "    return start + config.TIMEOUT", "deadline(None)"] });
    const envMd = await report(env, py(env, [["app.py", 4, "<module>", "deadline(None)"], ["app.py", 3, "deadline", "return start + config.TIMEOUT"]], "TypeError: unsupported operand type(s) for +: 'NoneType' and 'int'"));
    assert.doesNotMatch(envMd, /Environment value/);
    const lit = project("literal", {
      "log.js": ['function level(n) { return n > 2 ? "error" : "info"; }'],
      "app.js": ["const users = {};", "function show(id) {", "  const user = users[id];", '  console.log("Error", user.name);', "}", "show(3);"],
    });
    const litMd = await report(lit, node(lit, "name", ["show (@/app.js:4:29)", "Object.<anonymous> (@/app.js:6:1)"]));
    assert.doesNotMatch(litMd, /case mismatch/);
  });

  it("treats a loop variable as one element, not the collection", async () => {
    const root = project("loop", {
      "app.py": [
        "class Repo:",
        "    def filter(self, ids):",
        "        return [{1: 'ada'}.get(i) for i in ids]",
        "repo = Repo()",
        "def report(ids):",
        "    names = repo.filter(ids)",
        "    for name in names:",
        "        print(name.upper())",
        "report([1, 2])",
      ],
    });
    const md = await report(root, py(root, [["app.py", 9, "<module>", "report([1, 2])"], ["app.py", 8, "report", "print(name.upper())"]], "AttributeError: 'NoneType' object has no attribute 'upper'"));
    assert.match(md, /`name` is an element of `names`/);
    assert.doesNotMatch(md, /lookup found nothing/);
  });

  it("does not claim a field mismatch for this.* fields or for data parsed from JSON", async () => {
    const cls = project("thisfield", {
      "config.js": ["module.exports = { defaults: { timeout: 30, retries: 3 } };"],
      "session.js": ["class Session {", "  constructor(o) { this.timeout = o.timeout; this.retries = o.retries; }", "  greet() {", '    return "hi " + this.user.name;', "  }", "}", "new Session({}).greet();"],
    });
    const clsMd = await report(cls, node(cls, "name", ["Session.greet (@/session.js:4:30)", "Object.<anonymous> (@/session.js:7:17)"]));
    assert.doesNotMatch(clsMd, /Field name mismatch/);
    const json = project("jsonfield", {
      "report.py": ['def summary(users):', '    return {"emails": users, "count": len(users)}'],
      "app.py": ["import json", "def signup(raw):", "    payload = json.loads(raw)", '    return payload["email"].lower()', "signup('{}')"],
    });
    const jsonMd = await report(json, py(json, [["app.py", 5, "<module>", "signup('{}')"], ["app.py", 4, "signup", 'return payload["email"].lower()']], "KeyError: 'email'"));
    assert.doesNotMatch(jsonMd, /Field name mismatch/);
  });

  it("uses the column to pick which expression on the line failed", async () => {
    const root = project("column", {
      "app.js": ["function line(owner, user) {", "  return `${owner.name} -> ${user.name}`;", "}", "line({ name: 'a' }, undefined);"],
    });
    const md = await report(root, node(root, "name", ["line (@/app.js:2:35)", "Object.<anonymous> (@/app.js:4:1)"]));
    assert.match(md, /The bad value is `user` at/);
  });
});

describe("parsers and signatures", () => {
  const goNormal = "panic: runtime error: invalid memory address or nil pointer dereference\n\ngoroutine 1 [running]:\nmain.get(...)\n\t/src/app/main.go:5\nmain.main()\n\t/src/app/main.go:7 +0x10\n";
  const goSystem =
    "panic: runtime error: invalid memory address or nil pointer dereference\n\ngoroutine 1 gp=0xc000002380 m=0 mp=0x4f6d40 [running]:\nruntime.sigpanic()\n\t/usr/local/go1.24.7/src/runtime/signal_unix.go:925 +0x359 fp=0xc00004c730 sp=0xc00004c6d0 pc=0x460fb9\nmain.get(...)\n\t/src/app/main.go:5\nmain.main()\n\t/src/app/main.go:7 +0x10 fp=0xc00004c750 sp=0xc00004c730 pc=0x468ff0\n";

  it("reads GOTRACEBACK=system dumps with the same signature as a normal one", () => {
    const sys = parse(goSystem);
    assert.ok(sys.frames.some((f) => f.function === "main.get" && f.own));
    assert.equal(toFailureIssue(sys, "a", goSystem).signature, toFailureIssue(parse(goNormal), "b", goNormal).signature);
  });

  it("does not treat Go dependencies from the module cache as your code", () => {
    const text = "panic: boom\n\ngoroutine 1 [running]:\ngithub.com/redis/go-redis/v9.(*Client).Get(...)\n\t/home/u/go/pkg/mod/github.com/redis/go-redis/v9@v9.5.1/commands.go:12\ngithub.com/acme/shop.handler()\n\t/src/shop/handler.go:20 +0x10\n";
    const frames = parse(text).frames;
    assert.equal(frames[0]?.own, false);
    assert.equal(frames[1]?.own, true);
  });

  it("handles Java classloader prefixes and skips Suppressed: blocks", () => {
    const text = [
      "Exception in thread \"main\" java.lang.IllegalStateException: boom",
      "\tat app//com.acme.Main.run(Main.java:10)",
      "\tat app//org.junit.jupiter.api.Assertions.fail(Assertions.java:5)",
      "\tat app//com.acme.Main.main(Main.java:5)",
      "\tSuppressed: java.io.IOException: close failed",
      "\t\tat app//com.acme.Res.close(Main.java:20)",
      "\t\t... 1 more",
    ].join("\n");
    const parsed = parse(text);
    assert.deepEqual(parsed.frames.map((f) => [f.function, f.own]), [["com.acme.Main.run", true], ["org.junit.jupiter.api.Assertions.fail", false], ["com.acme.Main.main", true]]);
  });

  it("gives Windows paths a machine-independent signature and treats the stdlib as not yours", () => {
    const trace = (user: string) =>
      `Traceback (most recent call last):\n  File "C:\\Users\\${user}\\app\\main.py", line 3, in <module>\n    load()\n  File "C:\\Users\\${user}\\AppData\\Local\\Programs\\Python\\Python312\\Lib\\json\\decoder.py", line 355, in raw_decode\n    raise\njson.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)`;
    const a = parse(trace("ada"));
    assert.equal(toFailureIssue(a, "a", "").signature, toFailureIssue(parse(trace("bob")), "b", "").signature);
    assert.equal(a.frames[0]?.own, false, "Lib\\json is the standard library");
  });

  it("does not mangle paths when the source root is /", async () => {
    const root = project("slashroot", { "app.py": ["x = None", "x.name"] });
    const out = `Traceback (most recent call last):\n  File "${root}/app.py", line 2, in <module>\n    x.name\nAttributeError: 'NoneType' object has no attribute 'name'`;
    const md = renderIssueMarkdown(await attachSource(toFailureIssue(parse(out), "e", out), "/"));
    assert.match(md, /## Code: /, "the source was read");
    assert.ok(md.includes(`at ${root}/app.py:2`), "the stack trace keeps its path");
  });
});

describe("native hints", () => {
  it("does not report a use after free when the freeing branch returns first", () => {
    const out = nativeHypotheses({
      relevantRegisters: [],
      decompiled: [{ name: "f", role: "crash", pseudocode: "if (n < 0) {\n  free(__ptr);\n  return -1;\n}\n*(int *)(__ptr + 8) = n;" }],
    } as unknown as TriageReport);
    assert.deepEqual(out, []);
    const oneLine = nativeHypotheses({
      relevantRegisters: [],
      decompiled: [{ name: "f", role: "crash", pseudocode: "if (n < 0) { free(__ptr); return -1; }\n*(int *)(__ptr + 8) = n;" }],
    } as unknown as TriageReport);
    assert.deepEqual(oneLine, []);
  });
});

describe("runtime values", () => {
  it("masks secrets in printed values", async () => {
    const { maskValue } = await import("../src/trace.js");
    assert.equal(maskValue("api_token", "'abc'"), "***");
    assert.equal(maskValue("cfg", "{'password': 'hunter2', 'host': 'db'}"), "{'password': '***', 'host': 'db'}");
    assert.equal(maskValue("cfg", '{"session_id":"s1","user":"ada"}'), '{"session_id":"***","user":"ada"}');
    assert.equal(maskValue("u", "User(name='ada', auth_key='k-1')"), "User(name='ada', auth_key='***')");
    assert.equal(maskValue("h", "{'x': 'ghp_abcdefghijklmnop'}"), "{'x': '***'}");
    assert.ok(maskValue("big", `'${"a".repeat(500)}'`).length <= 200);
  });

  it("parses pytest --tb=short output and runs without --showlocals", () => {
    const short = [
      "_________________________________ test_export _________________________________",
      "test_export.py:6: in test_export",
      "    assert export(rows) == []",
      "export.py:6: in export",
      "    return [receipt_line(normalize(r)) for r in rows]",
      "receipts.py:4: in receipt_line",
      "    return customer.upper()",
      "E   AttributeError: 'NoneType' object has no attribute 'upper'",
      "=========================== short test summary info ============================",
    ].join("\n");
    const parsed = parse(short);
    assert.deepEqual(parsed.frames.map((f) => [f.function, f.file, f.line]), [["receipt_line", "receipts.py", 4], ["export", "export.py", 6], ["test_export", "test_export.py", 6]]);
    assert.equal(parsed.errorType, "AttributeError");
    assert.equal(parsed.frames[0]?.locals, undefined);
  });

  it("reads a pytest assertion failure as AssertionError", () => {
    const text = [
      "________________________________ test_total ________________________________",
      "",
      "    def test_total():",
      ">       assert total([1, 2]) == 4",
      "E       assert 3 == 4",
      "E        +  where 3 = total([1, 2])",
      "",
      "test_total.py:2: AssertionError",
    ].join("\n");
    const parsed = parse(text);
    assert.equal(parsed.errorType, "AssertionError");
    assert.equal(parsed.message, "assert 3 == 4");
  });
});

describe("second review", () => {
  it("keeps C++ gdb frames whose names hold spaces, templates or parentheses", async () => {
    const { parseGdbOutput } = await import("../src/gdb.js");
    const report = parseGdbOutput(
      [
        "@@crashlens@@bt",
        "#0  0x00007f3a in __memmove_avx_unaligned_erms () from /lib/x86_64-linux-gnu/libc.so.6",
        "#1  0x0000555 in std::vector<int, std::allocator<int> >::at (this=0x7ffd, __n=5) at /usr/include/c++/11/bits/stl_vector.h:1063",
        "#2  0x0000556 in (anonymous namespace)::Parser::parse (this=0x1) at parser.cc:42",
        "#3  0x0000557 in operator new (sz=16) at new_op.cc:50",
        "#4  0x0000558 in main () at main.cc:7",
      ].join("\n"),
      "",
    );
    assert.ok(report.status === "ok");
    assert.deepEqual(report.frames.map((f) => [f.function, f.source]), [
      ["__memmove_avx_unaligned_erms", "/lib/x86_64-linux-gnu/libc.so.6"],
      ["std::vector<int, std::allocator<int> >::at", "/usr/include/c++/11/bits/stl_vector.h:1063"],
      ["(anonymous namespace)::Parser::parse", "parser.cc:42"],
      ["operator new", "new_op.cc:50"],
      ["main", "main.cc:7"],
    ]);
  });

  it("blames the line as it is in the working copy, not the same line number in HEAD", async () => {
    const root = project("blame-shift", { "app.py": ["def total(o):", '    return o["x"]', "", "", "def other():", "    return 1"] });
    const git = (author: string, ...a: string[]) => execFileSync("git", ["-c", `user.name=${author}`, "-c", "user.email=a@example.invalid", ...a], { cwd: root });
    git("Old", "init", "-q");
    git("Old", "add", "-A");
    git("Old", "commit", "-qm", "Old writes everything");
    writeFileSync(join(root, "app.py"), ["def total(o):", '    return o["items"]', "", "", "def other():", "    return 1"].join("\n"));
    git("Dana", "commit", "-qam", "Dana changes line 2");
    // A local edit above the crash shifts it from line 2 (in HEAD) to line 3.
    writeFileSync(join(root, "app.py"), ["# local note", "def total(o):", '    return o["items"]', "", "", "def other():", "    return 1"].join("\n"));
    const out = ["Traceback (most recent call last):", `  File "${root}/app.py", line 3, in total`, '    return o["items"]', "KeyError: 'items'"].join("\n");
    const md = renderIssueMarkdown(await attachSource(toFailureIssue(parse(out), "e", out), root));
    assert.match(md, /`app\.py:3`: Dana, .*"Dana changes line 2"/);
    // A line changed only locally is reported as not committed.
    writeFileSync(join(root, "app.py"), ["def total(o):", '    return o["changed"]', "", "", "def other():", "    return 1"].join("\n"));
    const local = out.replace("line 3", "line 2").replaceAll('o["items"]', 'o["changed"]');
    const localMd = renderIssueMarkdown(await attachSource(toFailureIssue(parse(local), "e", local), root));
    assert.match(localMd, /not committed yet/);
  });

  it("skips an unreadable file in --batch instead of crashing the run", () => {
    const dir = mkdtempSync(join(tmpdir(), "crashlens-unreadable-"));
    chmodSync(dir, 0o755);
    writeFileSync(join(dir, "good.log"), "Traceback (most recent call last):\n  File \"a.py\", line 1, in <module>\n    x\nValueError: bad\n", { mode: 0o644 });
    writeFileSync(join(dir, "locked.log"), "secret", { mode: 0o000 });
    chmodSync(join(dir, "locked.log"), 0o000);
    const cli = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");
    // Root can read anything, so run as an unprivileged user when the tests run as root.
    const asUser = process.getuid?.() === 0 ? { uid: 65534, gid: 65534 } : {};
    const run = spawnSync(process.execPath, [cli, "--batch", dir, "--json"], { encoding: "utf8", ...asUser });
    rmSync(dir, { recursive: true, force: true });
    assert.equal(run.status, 0, run.stderr);
    const result = JSON.parse(run.stdout) as { failures: number; skipped: { file: string; reason: string }[] };
    assert.equal(result.failures, 1);
    assert.deepEqual(result.skipped.map((s) => s.file), ["locked.log"]);
    assert.match(result.skipped[0]?.reason ?? "", /could not read: .*EACCES/);
  });

  it("recognizes Node errors whose message spans several lines, like an assertion diff", () => {
    const text = [
      "node:assert:150",
      "  throw new AssertionError(obj);",
      "  ^",
      "",
      "AssertionError [ERR_ASSERTION]: Expected values to be strictly deep-equal:",
      "+ actual - expected",
      "",
      "  {",
      "    id: 1,",
      "+   name: 'Ada L'",
      "-   name: 'Ada'",
      "  }",
      "",
      "    at check (/srv/app/check.js:2:28)",
      "    at Object.<anonymous> (/srv/app/check.js:3:1)",
    ].join("\n");
    const parsed = parse(text);
    assert.equal(parsed.errorType, "AssertionError [ERR_ASSERTION]");
    assert.match(parsed.message, /^Expected values to be strictly deep-equal:[\s\S]*name: 'Ada L'/);
    assert.equal(parsed.frames[0]?.function, "check");
  });

  it("reports a Node error's [cause] as the root, with the outer error as its wrapper", () => {
    const text = [
      "Error: config failed to load",
      "    at start (/srv/app/cause.js:3:39)",
      "    at Object.<anonymous> (/srv/app/cause.js:5:1)",
      "    ... 5 lines matching cause stack trace ...",
      "    at node:internal/main/run_main_module:36:49 {",
      "  [cause]: SyntaxError: Expected property name or '}' in JSON at position 1",
      "      at JSON.parse (<anonymous>)",
      "      at load (/srv/app/cause.js:1:31)",
      "      at start (/srv/app/cause.js:3:9)",
      "}",
    ].join("\n");
    const parsed = parse(text);
    assert.equal(parsed.errorType, "SyntaxError");
    assert.deepEqual(parsed.wrappedBy, ["Error: config failed to load"]);
    assert.deepEqual(parsed.frames.filter((f) => f.own).map((f) => f.function), ["load", "start"]);
  });

  it("resolves TypeScript imports that name the emitted .js file", async () => {
    const root = project("ts-esm", {
      "db.ts": ["export async function getUser(id: number) {", "  return { name: 'Ada' };", "}"],
      "handler.ts": ['import { getUser } from "./db.js";', "export function profile(id: number) {", "  const user = getUser(id);", "  return user.name.toUpperCase();", "}", "profile(1);"],
    });
    const md = await report(root, node(root, "toUpperCase", ["profile (@/handler.ts:4:20)", "Object.<anonymous> (@/handler.ts:6:1)"]));
    assert.match(hypotheses(md), /Missing `await`.*`getUser` is `async`/);
  });
});

describe("blame line mapping", () => {
  it("maps working-copy lines onto the committed file", async () => {
    const { mapLine } = await import("../src/source.js");
    const committed = ["a", "b", "c", "d", "e"];
    assert.equal(mapLine(committed, ["x", "a", "b", "c", "d", "e"], 3), 2, "a line inserted above shifts it down");
    assert.equal(mapLine(committed, ["a", "c", "d", "e"], 2), 3, "a line deleted above shifts it up");
    assert.equal(mapLine(committed, ["a", "b", "C", "d", "e"], 3), null, "a changed line is not committed");
    assert.equal(mapLine(committed, ["a", "b", "new", "c", "d", "e"], 3), null, "an added line is not committed");
    assert.equal(mapLine(committed, ["a", "b", "new", "c", "d", "e"], 5), 4);
    assert.equal(mapLine(committed, committed, 5), 5);
  });
});
