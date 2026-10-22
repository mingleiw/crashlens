---
name: crashlens
description: Use this first, before reading crash output by hand, whenever something failed with a stack trace, panic, exception, sanitizer report, segfault or core dump: one call returns where it failed in the user's code, why, and a stable bug signature. Especially for many or large logs (a CI artifacts folder, a crash directory: it groups them into distinct bugs with counts in under a second, instead of grepping), noisy logs, and core dumps. Covers Go/Rust panics, Python tracebacks and pytest failures, Java and Node.js stack traces, Sentry event JSON, ASan/LSan/UBSan reports and Linux core dumps.
license: MIT
compatibility: Text failures need only Node.js 22+. Core dumps need Linux x86-64, REA (npm install -g rea-agents) and REA_PWNTOOLS_PYTHON; gdb is optional.
---

# crashlens: explain a failure, then fix it

crashlens reads a failure (panic, exception, sanitizer report, or core dump +
binary) and returns a Markdown bug report: the first frame in **the user's
code**, the crash type with a confidence level, the log lines just before it,
what to check next, and a **signature** that stays the same for the same bug
across runs and machines. It never runs the program.

## How to call it

Prefer the MCP tools when they are available (the crashlens plugin provides them):

| Situation | Tool | Key arguments |
| --- | --- | --- |
| Failure output you have (test run, pasted trace) | `analyze_failure` | `text`, `source_dir` |
| A log file | `analyze_failure` | `path`, `source_dir` |
| A native crash | `analyze_core_dump` | `core_path`, `binary_path`, `log_path`, `source_dir` |
| Many failures (CI artifacts, crash dir) | `analyze_crash_folder` | `dir`, `binary_path`, `source_dir` |

Always pass `source_dir` = the repository root (absolute path): the report then
includes the failing lines and the last commit that touched them. Use absolute paths.

Without the MCP tools, use the CLI (`crashlens` on PATH, or `node <plugin dir>/crashlens.mjs`):

```bash
<command> 2>&1 | crashlens - --source "$PWD"   # failure output piped in
crashlens error.log --source "$PWD"              # a saved log
crashlens ./core ./app --source "$PWD"           # core dump + the exact binary
crashlens --batch ./crashes ./app                # a folder, grouped into bugs
```

Add `--json` when you want fields instead of Markdown. Do not pass `--ai`: you
are already the model reading the report.

## Workflow

1. **Capture the whole failure.** Rerun the failing command with stderr
   included (`2>&1`) and give crashlens all of it, including the log lines
   before the trace: they show which request or input triggered it. For Rust,
   set `RUST_BACKTRACE=1` first, or there is no stack. For pytest, add `-l`
   (`--showlocals`): crashlens then compares what the code read with what the
   variables really held.
2. **Analyze** with the right tool above.
3. **Read the report in this order:** "Hypotheses to check first" and "Where
   the bad value came from" when present (with `source_dir`), then the title
   (crash type and where), the "your code" frame, the likely cause and its
   confidence, the failing lines and blame, and the log context. Low
   confidence means verify before acting.
4. **State the hypothesis, then fix the root cause, not the line that blew
   up.** Before editing, say in one sentence where the bad value was
   *produced* and why, and check it against the code. The crash site is where
   it was *used*. The report's hypotheses (a missing `await`, a lookup key
   that differs in case, a field name the producer spells differently, an
   environment string used as a number, a use after free) are static guesses
   from the source or the core: confirm one in the code, then fix it where the
   value is produced. Do not add a `None`/`undefined`/NULL check, a default or
   a `try`/`except` at the crash site unless a missing value is genuinely
   valid there; a guard hides the bug and the next caller hits it.
5. **Verify.** Rerun the same command. The failure, and its signature, should be
   gone. If a different signature appears, it is a new bug: repeat.

When the user asks what went wrong rather than for a fix, answer from the report:
the crash type, the file:line in their code, the cause, and the signature.

## Many failures

Use `analyze_crash_folder` (or `--batch`). It groups by signature and ranks bugs
by count, so fix the top one first. Use signatures to say "these 40 CI failures
are 3 bugs", and to confirm a fix removed exactly the bug it targeted.

## Native crashes

- **Getting a core:** `ulimit -c unlimited` then rerun (writes `./core` when
  `/proc/sys/kernel/core_pattern` is `core`); on systemd hosts use
  `coredumpctl list` and `coredumpctl dump <pid> -o core`.
- The binary must be **the exact build that crashed**. The report checks the
  GNU build ID against the core: on "Build ID mismatch", stop and get the right
  binary instead of trusting the function names.
- **Stripped binaries and no source** (the usual production case): functions are
  named `sub_<address>` from the unwind tables, and the report shows the whole
  crashing function's disassembly. When Ghidra 12.1.x is in `GHIDRA_INSTALL_DIR`,
  REA + Ghidra pseudocode of that function is added automatically (force with
  `decompile: true` / `--decompile`; it can take minutes on large binaries). Read the load
  that produced the bad register in the disassembly or pseudocode (for example
  `*(param_1 + 8)` is a field at offset 8 of the first argument), then follow the
  caller: call `decompile_function` with the caller's `sub_<hex>` name from the
  backtrace to see where that value was set (freed, left NULL, computed as 0).
  Label pseudocode as decompiler output, not source.
- Source file and line numbers need a build with `-g`. Without them you still get
  `function+offset`, the faulting instruction and the bad register.
- For memory bugs, a sanitizer report is usually more precise than a core: if
  you can rebuild and rerun, use `-fsanitize=address,undefined -g` and analyze
  the ASan output.

## Care

- Core dumps are copies of process memory and can hold secrets, tokens and user
  data. Analyze them locally. Never paste their raw contents or upload them.
- Reports include local paths, log lines and register values. Point this out
  before the user posts one publicly.
- crashlens reads the core and binary only. Running the program to reproduce a
  crash is a separate decision: ask the user first.
