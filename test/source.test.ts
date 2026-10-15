import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import type { Issue } from "../src/issue.js";
import { attachSource } from "../src/source.js";

const work = mkdtempSync(join(tmpdir(), "crashlens-source-"));
after(() => rmSync(work, { recursive: true, force: true }));

function issueAt(locations: Issue["locations"]): Issue {
  return {
    source: "python-exception", kind: "k", title: "t", where: null, summary: "", facts: [],
    sections: [{ heading: "Stack trace", kind: "code", language: "", lines: [] }],
    locations, cause: "", nextSteps: [], confidence: "high", warnings: [], evidence: [],
    limitations: [], signature: "s", footer: "",
  };
}

function repo(name: string): string {
  const dir = join(work, name);
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "orders.py"), ["def load(i):", "    return None", "", "def total(o):", '    return sum(o["items"])', ""].join("\n"));
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Dana Dev", "-c", "user.email=dana@example.com", ...args], { cwd: dir });
  git("init", "-q");
  git("add", "-A");
  git("commit", "-qm", "Add order totals");
  return dir;
}

describe("attachSource", () => {
  it("maps a production path onto the repo and shows the line with git blame", async () => {
    const root = repo("shop");
    const issue = await attachSource(
      issueAt([{ file: "/srv/deploy/releases/42/app/orders.py", line: 5, function: "total", own: true }]),
      root,
    );
    const code = issue.sections.find((s) => s.heading === "Code: app/orders.py:5 (total)");
    assert.ok(code && code.kind === "code");
    assert.equal(code.language, "python");
    assert.ok(code.lines.includes('> 5 |     return sum(o["items"])'));
    const blame = issue.sections.find((s) => s.heading === "Last change to these lines");
    assert.ok(blame && blame.kind === "list");
    assert.match(blame.items[0] ?? "", /^`app\/orders\.py:5`: Dana Dev, \d{4}-\d{2}-\d{2}, `[0-9a-f]{8}` "Add order totals"$/);
    // Code is placed right after the stack trace.
    assert.equal(issue.sections[1]?.heading, "Code: app/orders.py:5 (total)");
  });

  it("finds a file by name when the stack only has a bare file name", async () => {
    const root = repo("bare");
    const issue = await attachSource(issueAt([{ file: "orders.py", line: 2, function: "load", own: true }]), root);
    assert.ok(issue.sections.some((s) => s.heading === "Code: app/orders.py:2 (load)"));
  });

  it("never reads outside the source folder, even through a symlink", async () => {
    const root = join(work, "jail");
    mkdirSync(root);
    const secret = join(work, "secret.txt");
    writeFileSync(secret, "top secret\n");
    symlinkSync(secret, join(root, "secret.txt"));
    const issue = await attachSource(
      issueAt([
        { file: secret, line: 1, function: "f", own: true },
        { file: "secret.txt", line: 1, function: "g", own: true },
        { file: "../secret.txt", line: 1, function: "h", own: true },
      ]),
      root,
    );
    assert.ok(!JSON.stringify(issue.sections).includes("top secret"));
    assert.match(issue.warnings.at(-1) ?? "", /No failing line could be found/);
  });

  it("skips library frames and works without git", async () => {
    const root = join(work, "plain");
    mkdirSync(root);
    writeFileSync(join(root, "main.go"), "package main\n\nfunc main() {\n\tpanic(1)\n}\n");
    const issue = await attachSource(
      issueAt([
        { file: "/usr/local/go/src/runtime/panic.go", line: 1, function: "runtime.gopanic", own: false },
        { file: "/build/main.go", line: 4, function: "main.main", own: true },
      ]),
      root,
    );
    assert.deepEqual(
      issue.sections.map((s) => s.heading),
      ["Stack trace", "Code: main.go:4 (main.main)"],
    );
  });
});
