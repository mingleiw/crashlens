#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { parseArgs } from "node:util";
import { analyzeCore, analyzeFile } from "./analyze.js";
import { renderBatchMarkdown, triageBatch } from "./batch.js";
import { renderIssueMarkdown, toJson, type Issue } from "./issue.js";
import { serveMcp } from "./mcp.js";
import { resolveReaCommand } from "./rea.js";
import { suggestFix, withSuggestion } from "./ai.js";
import { serve } from "./server.js";
import { attachSource } from "./source.js";

const USAGE = `crashlens: find out why your program crashed, without running it

Usage:
  crashlens <core> <binary>          Linux x86-64 core dump + the binary that crashed
  crashlens <error.log>              A saved log containing a Go/Rust panic, a Python,
                                     Java or Node exception, or a sanitizer report
  crashlens -                        ... or piped in:  python app.py 2>&1 | crashlens -
  crashlens serve [--port N]         Local web app: drag and drop crashes in your browser
  crashlens mcp                      MCP server on stdio, so coding agents can call crashlens
  crashlens --batch <dir> [binary]   every core dump and failure log under <dir>,
                                     grouped into distinct bugs

Options:
  --ai               Off by default. Send the report to the Anthropic API (Claude) for an
                     explanation and suggested fix; needs ANTHROPIC_API_KEY. With serve,
                     enables an "Ask AI" button that asks before sending each report.
  --json             Print JSON instead of Markdown
  -o, --output FILE  Write the report to FILE instead of stdout
  --source DIR       Your source code: show the failing lines and who last changed them
  --log FILE         Application log to show next to a core dump report (last lines)
  --decompile        Core dumps: always add REA + Ghidra pseudocode of the crashing function.
                     By default it is added only for stripped functions when GHIDRA_INSTALL_DIR
                     points at Ghidra 12.1.x. Can take minutes on large binaries.
  --no-decompile     Never decompile
  --no-gdb           Do not use gdb for core dumps (no backtrace or disassembly)
  --gdb PATH         gdb executable to use (default: gdb)
  -h, --help         Show this help

Environment (core dumps only):
  CRASHLENS_REA         REA executable or scripts/rea.mjs path (default: installed rea-agents, then rea)
  REA_PWNTOOLS_PYTHON   Python with pwntools, required by REA's core reader

Exit codes: 0 report produced, 1 triage failed, 2 invalid arguments.`;

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
        port: { type: "string" },
        ai: { type: "boolean", default: false },
        decompile: { type: "boolean" },
        "no-decompile": { type: "boolean", default: false },
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
  /** Only with --ai, only for single reports: the user asked for this one to be sent. */
  const advise = async (issue: Issue): Promise<Issue> => {
    if (!values.ai) return issue;
    process.stderr.write("crashlens: sending this report to the Anthropic API for a suggestion (--ai)…\n");
    const suggestion = await suggestFix(issue);
    if (suggestion.ok) return withSuggestion(issue, suggestion.value);
    process.stderr.write(`crashlens: AI suggestion unavailable: ${suggestion.error.message}\n`);
    return { ...issue, warnings: [...issue.warnings, `AI suggestion unavailable: ${suggestion.error.message}`] };
  };

  if (positionals[0] === "serve" && positionals.length === 1 && values.batch === undefined) {
    const port = values.port === undefined ? 7777 : Number(values.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) return usage("--port must be a number between 0 and 65535.");
    const server = await serve({ port, rea: resolveReaCommand(), gdb, sourceRoot: source, ai: values.ai });
    process.stdout.write(
      `crashlens is running at:\n\n  ${server.url}\n\nOpen that exact URL (it carries a private session token). Only this computer can connect.\nPress Ctrl+C to stop; uploaded files are deleted on exit.\n`,
    );
    await new Promise<void>((resolve) => {
      const stop = () => void server.close().then(resolve);
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    return 0;
  }

  if (positionals[0] === "mcp" && positionals.length === 1 && values.batch === undefined) {
    await serveMcp(process.stdin, process.stdout, { rea: resolveReaCommand(), gdb });
    return 0;
  }

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
    const parsed = await analyzeCore({
      corePath: absolute(core),
      binaryPath: absolute(binary),
      logPath: values.log,
      rea: resolveReaCommand(),
      gdb,
      decompile: values["no-decompile"] ? false : values.decompile ? true : "auto",
    });
    if (parsed.ok) {
      const issue = await advise(await enrich(parsed.issue));
      output = {
        ok: true,
        text: values.json ? `${toJson({ issue, details: parsed.details })}\n` : renderIssueMarkdown(issue),
      };
    } else output = parsed;
  } else if (positionals.length === 1) {
    const parsed = analyzeFile(positionals[0] as string);
    if (parsed.ok) {
      const issue = await advise(await enrich(parsed.issue));
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

function usage(message: string): number {
  process.stderr.write(`${message}\n\n${USAGE}\n`);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
