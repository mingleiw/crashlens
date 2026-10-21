// Regressions for the security and correctness review findings.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, describe, it } from "node:test";
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
