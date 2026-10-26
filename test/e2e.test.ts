import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

const cli = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src",
  "cli.js",
);

const has = (tool: string) =>
  spawnSync("sh", ["-c", `command -v ${tool}`]).status === 0;
const missing = [
  ...(process.platform === "linux" && process.arch === "x64"
    ? []
    : ["linux-x64"]),
  ...["gcc", "gdb"].filter((tool) => !has(tool)),
  ...(process.env["CRASHLENS_REA"] ? [] : ["CRASHLENS_REA"]),
  ...(process.env["REA_PWNTOOLS_PYTHON"] ? [] : ["REA_PWNTOOLS_PYTHON"]),
];

const SOURCE = `
#include <string.h>
struct record { char name[16]; int *values; int count; };
static int sum(const struct record *r) {
  int total = 0;
  for (int i = 0; i < r->count; i++) total += r->values[i];
  return total;
}
int main(void) { struct record r; memset(&r, 0, sizeof r); r.count = 3; return sum(&r); }
`;

describe(
  "crashlens end to end",
  { skip: missing.length > 0 && `needs ${missing.join(", ")}` },
  () => {
    it("turns a real NULL-dereference core into an issue naming the function", () => {
      const work = mkdtempSync(join(tmpdir(), "crashlens-"));
      try {
        writeFileSync(join(work, "crasher.c"), SOURCE);
        execFileSync("gcc", ["-O0", "-o", "crasher", "crasher.c"], {
          cwd: work,
        });
        // The kernel writes ./core when core_pattern is the default "core".
        spawnSync("sh", ["-c", "ulimit -c unlimited; ./crasher"], {
          cwd: work,
        });
        const core = join(work, "core");
        if (!existsSync(core)) {
          console.warn(
            "skipping assertions: the kernel did not write ./core (check core_pattern)",
          );
          return;
        }
        const markdown = execFileSync(
          process.execPath,
          [cli, core, join(work, "crasher")],
          {
            encoding: "utf8",
          },
        );
        assert.match(
          markdown,
          /^# Crash: NULL pointer dereference in `sum\+0x[0-9a-f]+`/,
        );
        assert.match(markdown, /main\+0x[0-9a-f]+/);
        assert.match(markdown, /← NULL/);
        assert.match(markdown, /the program was not executed/);
        assert.match(markdown, /\| Build ID \| matches the core/);

        // Same core, stripped copy of the binary: names come from .eh_frame and
        // the build ID still matches, because strip keeps the note.
        mkdirSync(join(work, "stripped"));
        execFileSync("strip", ["--strip-all", "-o", "stripped/crasher", "crasher"], { cwd: work });
        const strippedMd = execFileSync(process.execPath, [cli, core, join(work, "stripped", "crasher")], {
          encoding: "utf8",
        });
        assert.match(strippedMd, /^# Crash: NULL pointer dereference in `sub_[0-9a-f]+\+0x[0-9a-f]+`/);
        assert.match(strippedMd, /\| Build ID \| matches the core/);
        assert.match(strippedMd, /## Function around the fault: `sub_[0-9a-f]+`/);
        assert.match(strippedMd, /no symbol; boundaries from \.eh_frame/);

        // A rebuilt binary with different code: the build ID check must catch it.
        mkdirSync(join(work, "rebuilt"));
        writeFileSync(join(work, "rebuilt", "crasher.c"), SOURCE.replace("int total = 0;", "int total = 1;"));
        execFileSync("gcc", ["-O0", "-o", "crasher", "crasher.c"], { cwd: join(work, "rebuilt") });
        const rebuiltMd = execFileSync(process.execPath, [cli, core, join(work, "rebuilt", "crasher")], {
          encoding: "utf8",
        });
        assert.match(rebuiltMd, /Build ID mismatch/);
        assert.match(rebuiltMd, /\| Build ID \| \*\*mismatch\*\*/);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  },
);

// A per-target table with neither handler set and a fallback that calls without checking (binutils PR 31872).
const HOOKS_SOURCE = `
#include <stddef.h>
struct backend { const char *name; int machine; int (*convert)(int); int (*convert_rel)(int); };
static int twice(int x) { return 2 * x; }
static const struct backend backends[] = {
  { "generic", 1, twice, NULL },
  { "gpu", 224, NULL, NULL },
};
__attribute__((noinline)) static int convert(const struct backend *b, int x) {
  int r = b->convert_rel != NULL ? b->convert_rel(x) : b->convert(x);
  return r + b->machine;
}
int main(int argc, char **argv) { (void)argv; return convert(&backends[argc], 3); }
`;

describe(
  "crashlens end to end: NULL function pointer",
  { skip: missing.length > 0 && `needs ${missing.join(", ")}` },
  () => {
    it("traces a NULL call target to the table built into the binary", () => {
      const work = mkdtempSync(join(tmpdir(), "crashlens-"));
      try {
        writeFileSync(join(work, "hooks.c"), HOOKS_SOURCE);
        execFileSync("gcc", ["-O2", "-o", "hooks", "hooks.c"], { cwd: work });
        spawnSync("sh", ["-c", "ulimit -c unlimited; ./hooks"], { cwd: work });
        const core = join(work, "core");
        if (!existsSync(core)) {
          console.warn("skipping assertions: the kernel did not write ./core (check core_pattern)");
          return;
        }
        const markdown = execFileSync(process.execPath, [cli, core, join(work, "hooks")], { encoding: "utf8" });
        assert.match(markdown, /^# Crash: Call through a NULL function pointer in `convert/);
        assert.match(markdown, /NULL function pointer from a table built into the binary/);
        assert.match(markdown, /\.data\.rel\.ro at link address 0x[0-9a-f]+ \(`backends\+0x20` from hooks\.c\)/);
        assert.match(markdown, /is 0 \(NULL\) in the core/);

        // Stripped: no data symbol, but the section and the core's slot value remain.
        execFileSync("strip", ["--strip-all", "-o", "hooks-stripped", "hooks"], { cwd: work });
        const stripped = execFileSync(process.execPath, [cli, core, join(work, "hooks-stripped")], { encoding: "utf8" });
        assert.match(stripped, /points into the binary's \.data\.rel\.ro at link address 0x[0-9a-f]+;/);
        assert.match(stripped, /is 0 \(NULL\) in the core/);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  },
);

const GO_SOURCE = `package main

type Order struct{ Items []int }

func total(o *Order) int { return len(o.Items) }

func main() {
	var o *Order
	println(total(o))
}
`;

describe(
  "crashlens end to end: Go panic from stdin",
  { skip: !has("go") && "needs go" },
  () => {
    it("turns piped panic output into an issue naming the function", () => {
      const work = mkdtempSync(join(tmpdir(), "crashlens-go-"));
      try {
        writeFileSync(join(work, "main.go"), GO_SOURCE);
        writeFileSync(join(work, "go.mod"), "module example.com/e2e\n\ngo 1.21\n");
        // Inlining would fold total() into main(); keep the frame.
        execFileSync("go", ["build", "-gcflags=all=-l", "-o", "app", "."], { cwd: work });
        const run = spawnSync(join(work, "app"), { cwd: work, encoding: "utf8" });
        assert.notEqual(run.status, 0);
        const markdown = execFileSync(process.execPath, [cli, "-"], {
          input: run.stderr,
          encoding: "utf8",
        });
        assert.match(markdown, /^# Panic: Nil pointer dereference in `main.total`/);
        assert.match(markdown, /→ #0 main.total/);
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  },
);
