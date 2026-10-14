import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      } finally {
        rmSync(work, { recursive: true, force: true });
      }
    });
  },
);
