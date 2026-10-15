#!/usr/bin/env node
import { readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { renderBatchMarkdown, triageBatch } from "./batch.js";
import { coreDetails, toCoreIssue } from "./coreIssue.js";
import { renderIssueMarkdown, toJson, withLog, type Issue } from "./issue.js";
import { parseFailure } from "./failure.js";
import { logContext, toFailureIssue } from "./failureIssue.js";
import { resolveReaCommand } from "./rea.js";
import { attachSource } from "./source.js";
import { triage } from "./triage.js";

const USAGE = `crashlens: find out why your program crashed, without running it

Usage:
  crashlens <core> <binary>          Linux x86-64 core dump + the binary that crashed
  crashlens <error.log>              A saved log containing a Go/Rust panic, a Python,
                                     Java or Node exception, or a sanitizer report
  crashlens -                        ... or piped in:  python app.py 2>&1 | crashlens -
  crashlens --batch <dir> [binary]   every core dump and failure log under <dir>,
                                     grouped into distinct bugs

Options:
  --json             Print JSON instead of Markdown
  -o, --output FILE  Write the report to FILE instead of stdout
  --source DIR       Your source code: show the failing lines and who last changed them
  --log FILE         Application log to show next to a core dump report (last lines)
  --no-gdb           Do not use gdb for core dumps (no backtrace or disassembly)
  --gdb PATH         gdb executable to use (default: gdb)
  -h, --help         Show this help

Environment (core dumps only):
  CRASHLENS_REA         REA executable or scripts/rea.mjs path (default: installed rea-agents, then rea)
  REA_PWNTOOLS_PYTHON   Python with pwntools, required by REA's core reader

Exit codes: 0 report produced, 1 triage failed, 2 invalid arguments.`;

const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

type Output = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string };

async function main(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      allowPositionals: true,
      options: {
        json: { type: "boolean", default: false },
        output: { type: "string", short: "o" },
        batch: { type: "string" },
        log: { type: "string" },
        source: { type: "string" },
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
  // REA requires absolute paths; resolve once at the boundary.
  const absolute = (path: string) => (isAbsolute(path) ? path : resolve(path));
  const gdb = values["no-gdb"] ? null : values.gdb;

  const source = values.source === undefined ? null : absolute(values.source);
  const enrich = async (issue: Issue) => (source === null ? issue : attachSource(issue, source));

  let output: Output;
  if (values.batch !== undefined) {
    if (positionals.length > 1) return usage("--batch takes a directory and at most one binary.");
    const result = await triageBatch({
      directory: absolute(values.batch),
      binaryPath: positionals[0] === undefined ? null : absolute(positionals[0]),
      rea: resolveReaCommand(),
      gdb,
      enrich,
    });
    output = { ok: true, text: values.json ? `${toJson(result)}\n` : renderBatchMarkdown(result) };
  } else if (positionals.length === 2) {
    const [core, binary] = positionals as [string, string];
    const result = await triage({ corePath: absolute(core), binaryPath: absolute(binary), rea: resolveReaCommand(), gdb });
    if (result.ok) {
      let issue = await enrich(toCoreIssue(result.value));
      if (values.log !== undefined) {
        const log = readFileSync(values.log, "utf8");
        issue = withLog(issue, logContext(log, log.length));
      }
      output = {
        ok: true,
        text: values.json
          ? `${toJson({ issue, details: coreDetails(result.value) })}\n`
          : renderIssueMarkdown(issue),
      };
    } else output = { ok: false, message: result.error.message };
  } else if (positionals.length === 1) {
    const parsed = readFailure(positionals[0] as string);
    if (parsed.ok) {
      const issue = await enrich(parsed.issue);
      output = {
        ok: true,
        text: values.json ? `${toJson({ issue, details: parsed.details })}\n` : renderIssueMarkdown(issue),
      };
    } else output = parsed;
  } else {
    return usage("Expected <core> <binary>, a failure log, or --batch <dir>.");
  }

  if (!output.ok) {
    process.stderr.write(`crashlens: ${output.message}\n`);
    if (values.json) process.stdout.write(`${toJson({ error: output.message })}\n`);
    return 1;
  }
  if (values.output === undefined) process.stdout.write(output.text);
  else writeFileSync(values.output, output.text);
  return 0;
}

function readFailure(
  path: string,
): { ok: true; issue: Issue; details: unknown } | { ok: false; message: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path === "-" ? 0 : path);
  } catch (error) {
    return { ok: false, message: `Could not read ${path}: ${(error as Error).message}` };
  }
  if (bytes.subarray(0, 4).equals(ELF_MAGIC))
    return {
      ok: false,
      message: `${path} is an ELF file. For a core dump, also pass the binary that crashed: crashlens ${path} <binary>`,
    };
  const text = bytes.toString("utf8");
  const parsed = parseFailure(text);
  if (!parsed.ok) return { ok: false, message: parsed.error.message };
  return { ok: true, issue: toFailureIssue(parsed.value, path === "-" ? "stdin" : path, text), details: parsed.value };
}

function usage(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
