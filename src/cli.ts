#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { resolveReaCommand } from "./rea.js";
import { renderJson, renderMarkdown } from "./report.js";
import { triage } from "./triage.js";

const USAGE = `crashlens — turn a Linux core dump into a bug report, without running the program

Usage: crashlens <core> <binary> [options]

Arguments:
  core     Linux x86-64 ELF core file
  binary   The executable that crashed (same build as the one that produced the core)

Options:
  --json             Print the report as JSON instead of Markdown
  -o, --output FILE  Write the report to FILE instead of stdout
  --no-gdb           Do not use gdb (no backtrace or disassembly)
  --gdb PATH         gdb executable to use (default: gdb)
  -h, --help         Show this help

Environment:
  CRASHLENS_REA         REA executable or scripts/rea.mjs path (default: installed rea-agents, then rea)
  REA_PWNTOOLS_PYTHON   Python with pwntools, required by REA's core reader

Exit codes: 0 report produced, 1 triage failed, 2 invalid arguments.`;

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        output: { type: "string", short: "o" },
        "no-gdb": { type: "boolean", default: false },
        gdb: { type: "string", default: "gdb" },
        help: { type: "boolean", short: "h", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return 0;
  }
  const [core, binary] = positionals;
  if (core === undefined || binary === undefined || positionals.length > 2) {
    process.stderr.write(`Expected <core> and <binary>.\n\n${USAGE}\n`);
    return 2;
  }

  // REA requires absolute paths; resolve once at the boundary.
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(path));
  const result = await triage({
    corePath: absolute(core),
    binaryPath: absolute(binary),
    rea: resolveReaCommand(),
    gdb: values["no-gdb"] ? null : values.gdb,
  });
  if (!result.ok) {
    process.stderr.write(`crashlens: ${result.error.message}\n`);
    if (values.json)
      process.stdout.write(
        `${JSON.stringify({ error: result.error }, null, 2)}\n`,
      );
    return 1;
  }
  const text = values.json
    ? `${renderJson(result.value)}\n`
    : renderMarkdown(result.value);
  if (values.output === undefined) process.stdout.write(text);
  else writeFileSync(values.output, text);
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
