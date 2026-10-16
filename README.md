# crashlens

[![CI](https://github.com/mingleiw/crashlens/actions/workflows/ci.yml/badge.svg)](https://github.com/mingleiw/crashlens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Logs tell you where your program was. crashlens tells you why it died.**

**[▶ Try the live demo](https://mingleiw.github.io/crashlens/)**: paste a stack trace and see the report, right in your browser.

When a program crashes, the logs usually just stop. crashlens reads what the
crash left behind (a core dump, a panic, an exception, a sanitizer report) and
writes a bug report you can paste into an issue: where it died, why, the log
lines right before it, and, if you point it at your repo, the failing code and
who last changed it. It never runs your program and needs no SDK.

![Logs stop at "calculating total". crashlens says: NULL pointer dereference in sum+0x31, rax = 0x0](docs/images/before-after.svg)

```bash
crashlens ./core ./parser > crash.md
```

<details open>
<summary><b>A real report</b>, generated from a crashed C program (paste it straight into a GitHub issue)</summary>
<br>
<img src="docs/images/report.png" alt="crashlens report: NULL pointer dereference in sum+0x31, with crash details, backtrace, faulting instruction, registers and next steps" width="640">
</details>

> **Status:** early prototype. Reads Linux x86-64 core dumps, Go/Rust panics,
> Python tracebacks, Java and Node.js stack traces, and ASan/LSan/UBSan reports. Got a crash that stumped you? Open an issue. Real
> crashes are the best test cases.

## Use it in your browser

The [live demo](https://mingleiw.github.io/crashlens/) runs the same interface
with sample bugs, plus a **Try a sample core dump** button that walks through a
real native crash. Pasted text is analyzed in your browser and never uploaded.
To analyze core dumps, read your source code or watch live logs, run it
locally:

```bash
crashlens serve
```

Open the URL it prints, then drag in logs, sanitizer reports, or a core dump
with its binary, or paste a stack trace. Every bug gets a report you can copy
as Markdown, and the same bug from many files is grouped with a count.

![crashlens in the browser: a Python "Value was None" bug seen 3 times, with the stack trace, the failing code and a list of other bugs](docs/images/app.png)

The app runs on `127.0.0.1` only, needs the private token in the URL it
prints, loads nothing from the internet, and deletes uploaded files when it
stops.

## Or from the command line

```bash
crashlens ./core ./app                     # a native crash: core dump + the binary
python app.py 2>&1 | crashlens -           # any supported failure, piped in
crashlens error.log --source ~/code/shop   # ...and show the failing code + git blame
crashlens --batch ./crashes ./app          # a folder of crashes, grouped into bugs
```

## Use it from coding agents

crashlens ships as a Claude Code plugin: a skill that teaches the agent when
to use it and how to fix the root cause, plus an MCP server with three
read-only tools (`analyze_failure`, `analyze_core_dump`, `analyze_crash_folder`).

```text
/plugin marketplace add mingleiw/crashlens
/plugin install crashlens@crashlens
```

Then just work as usual. When a test panics or a service throws, the agent
passes the output to crashlens, gets the failing frame in your code, the cause
and a stable signature, fixes the root cause, and reruns to check the signature
is gone. The plugin bundles crashlens into one file, so it needs nothing but
Node.js. Core dumps also need REA and `REA_PWNTOOLS_PYTHON` (see
[Install](#install)).

Other MCP clients (Cursor, Codex, Claude Desktop, ...) can run the same server
from a checkout:

```json
{ "mcpServers": { "crashlens": { "command": "node", "args": ["/path/to/crashlens/plugin/crashlens.mjs", "mcp"] } } }
```

The skill itself ([plugin/skills/crashlens/SKILL.md](plugin/skills/crashlens/SKILL.md))
uses only portable frontmatter, so it also works as a standalone Agent Skill.

## What it recognizes

**Native crashes (core dumps)**

- NULL and near-NULL pointer dereferences
- stack overflow (runaway recursion, huge stack buffers)
- invalid memory access, writes to read-only memory, jumps to non-executable memory
- general protection faults (garbage pointers)
- failed `assert()`, uncaught C++ exceptions, glibc heap-corruption aborts
- divide by zero, illegal instruction, bus error, trap

**Go panics**: nil pointer dereference, index/slice out of range, write to nil
map, divide by zero, failed type assertion, concurrent map access, deadlock,
closed-channel misuse, stack overflow, explicit `panic(...)`

**Python**: `None` used as a value, missing dict key, index errors, bad JSON,
missing files, network errors, import errors, recursion, and chained exceptions
(reports the root cause of `raise ... from e`)

**Java**: NullPointerException (with the JVM's "because ... is null" detail),
index out of bounds, bad casts, NumberFormatException,
ConcurrentModificationException, stack overflow, out of memory, and the
deepest `Caused by:` in a chain

**Node.js**: `Cannot read properties of undefined`, "is not a function",
undefined variables, bad JSON, `ENOENT`/`ECONNREFUSED`, stack overflow

**Sanitizers** (ASan, LSan, UBSan): use after free (with the "freed by" and
"allocated by" stacks), buffer overflows, double free, memory leaks, NULL
dereference, integer overflow and other undefined behavior

**Rust panics**: `unwrap()` on `None`/`Err` (with the error value), index and
slice out of bounds, arithmetic overflow, divide by zero, `RefCell` borrowed
twice, failed `assert!`, string sliced inside a character, explicit `panic!`/`expect`

The report always points at **your** code first: for a native crash inside libc
(say `strlen(NULL)`) it names your function that called it, and for panics it
skips runtime and standard-library frames.

Every report has a **signature** built from the crash type and top frame names
(never addresses or directories), so the same bug groups together across runs
and machines.

## What's in a report

- **Where it died**: the first frame in *your* code, with the stack trace
  (your frames marked) and, for core dumps, the faulting instruction and the
  register that was NULL.
- **Why**: the crash type in plain language and what to check next.
- **What it was doing**: the log lines printed just before the failure (or
  your app log via `--log app.log` for core dumps), so you can see which
  request, order or user triggered it.
- **Your code**: with `--source DIR`, the failing lines from your repo and the
  last commit that touched them. Production paths like
  `/srv/releases/42/app/orders.py` are matched to `app/orders.py`; Java files
  are found by package. Only files inside that folder are read.
- **Evidence**: hashes of every input and how each fact was obtained.
- **Optional AI fix** (off by default): with `--ai`, Claude reads the report
  and suggests a fix, clearly labeled as AI-generated. See below.

## Optional: ask AI for a fix

crashlens works fully offline. If you want a second opinion, `--ai` sends the
report (the same Markdown you can read, including any code snippets and log
lines in it) to the Anthropic API and adds an explanation and suggested fix:

```bash
export ANTHROPIC_API_KEY=...
crashlens error.log --source ~/code/shop --ai
crashlens serve --ai          # adds an "Ask AI for a fix" button
```

Nothing is sent without `--ai`. In the web app, each report is sent only when
you click the button and confirm. The default model is `claude-opus-5-5`
(override with `CRASHLENS_AI_MODEL`); if it declines a request, the API's
server-side fallback answers with another model. AI suggestions are never
part of batch mode.

## Batch: a folder of crashes, ranked

```bash
crashlens --batch ./crashes ./app > crashes.md
```

crashlens finds every core dump and panic log under the folder (by content, not
file name), triages each one, and groups them by signature:

```markdown
# crashlens: 9 failures, 5 distinct bugs

| # | Bug                      | Where               | Count | Signature      |
| - | ------------------------ | ------------------- | ----- | -------------- |
| 1 | NULL pointer dereference | `name_length+0x1b`  | **3** | `2f70bec8d691` |
| 2 | Integer divide by zero   | `ratio+0x12`        | **2** | `e602c2811b65` |
| 3 | Nil pointer dereference  | `main.total`        | **2** | `46dd5b7c6285` |
| 4 | Assertion failure        | `main+0xfe`         | **1** | `49a54a814e72` |
| 5 | Unwrap on Err            | `rsapp::parse_port` | **1** | `553fb510e0f8` |
```

Each bug then gets a section with the affected files and the full report.
Files it can't use are listed with the reason. The binary is only needed when
the folder contains core dumps.

## How it works

crashlens is built on [REA](https://github.com/morluto/rea), an open-source
reverse-engineering toolkit. Instead of relying on what you chose to log, it
reads the program itself:

![core dump and binary are read by REA and optionally gdb; crashlens works out why and writes a bug report](docs/images/how-it-works.svg)

| Step | Tool | What it learns |
| --- | --- | --- |
| 1 | `rea inspect-recorded-crash` | signal, fault address, registers, mapped files |
| 2 | `rea inspect-binary-layout` | function symbols, segments, build hardening |
| 3 | crashlens | where the binary was loaded, so any address becomes `function+offset` |
| 4 | `gdb` (optional, core file only) | backtrace, inlined frames, source lines, disassembly |
| 5 | crashlens | crash type, relevant registers, signature, Markdown report |

Every claim traces back to evidence. The report lists the sha256 of the core
and binary and REA's evidence IDs, and separates what was recorded, what was
computed, and what is a best guess (with a confidence level).

## Install

Requirements: Linux x86-64, Node.js 22.19+ (or 24.11+), and Python 3.

```bash
# 1. REA
npm install -g rea-agents

# 2. pwntools for REA's core reader (REA never installs Python packages itself)
python3 -m venv ~/.rea-pwn
~/.rea-pwn/bin/pip install pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2
export REA_PWNTOOLS_PYTHON=~/.rea-pwn/bin/python

# 3. crashlens
git clone https://github.com/mingleiw/crashlens && cd crashlens
npm install && npm run build && npm link

# Optional: gdb for backtraces and disassembly
sudo apt install gdb
```

## Getting a core dump

```bash
ulimit -c unlimited          # allow core files in this shell
./your-program               # crashes and writes ./core
crashlens ./core ./your-program
```

On systemd distros cores often go to systemd-coredump instead:
`coredumpctl dump <pid> -o core`.

## Usage

```
crashlens serve [--port 7777]      [--source DIR]
crashlens mcp                      MCP server on stdio, for coding agents
crashlens <core> <binary>          [options]
crashlens <error.log | ->          [options]
crashlens --batch <dir> [binary]   [options]
```

| Option | Meaning |
| --- | --- |
| `--source DIR` | show the failing lines from your code and who last changed them |
| `--log FILE` | attach your app log to a core dump report |
| `--ai` | off by default: send the report to Claude for an explanation and fix |
| `--json` | machine-readable output instead of Markdown |
| `-o FILE` | write the report to a file |
| `--no-gdb` | skip gdb (no backtrace or disassembly) |
| `--gdb PATH` | use a specific gdb |

Text inputs (panics, exceptions, sanitizer reports) need nothing else installed. For core dumps: `CRASHLENS_REA` points at a specific REA (a `rea` executable or a
`scripts/rea.mjs` checkout). `REA_PWNTOOLS_PYTHON` is required by REA.

Exit codes: `0` report produced, `1` triage failed, `2` invalid arguments.

## Safety and limits

- **Your program is never executed.** REA only reads files, and gdb loads the
  core with script auto-loading and debuginfod (network) turned off.
- The binary is matched to the core **by file name**. Pass the exact build that
  crashed. If gdb detects a mismatch, the report shows a warning.
- Without gdb there's no backtrace, only the faulting frame.
- Panics are read from text only. "Your code" is decided by package and crate
  names, and Rust needs `RUST_BACKTRACE=1` for a stack trace.
- Crash types are heuristics and say how confident they are.
- `--source` reads only regular files inside the folder you give it (symlinks
  and `../` paths that leave it are rejected) and runs `git blame` there.
- `crashlens serve` listens on 127.0.0.1 only, requires the session token from
  the printed URL, rejects other `Host`/`Origin` headers, sets a strict Content
  Security Policy, and keeps uploads in a private temp folder deleted on exit.
- Reports include local paths, log lines and register values. Review before
  posting publicly.

## Roadmap

- [x] Group a folder of crashes by signature (`--batch`)
- [x] Go and Rust panic text
- [x] Python, Java and Node.js exceptions; ASan/LSan/UBSan reports
- [x] Log context, source snippets and git blame
- [x] Local web app (`crashlens serve`)
- [x] Optional AI explanation and fix suggestion (off by default)
- [x] Agent plugin: skill + MCP server (`crashlens mcp`)
- [ ] Windows minidumps and macOS crash reports
- [ ] Verify the binary matches the core by build ID
- [ ] Error-tracker integrations (Sentry, OpenTelemetry)
- [ ] Opt-in reproduction: rerun your own build to confirm a crash and verify a
      fix (design only; today crashlens is strictly read-only)

## Contributing

Real crashes are the most useful contribution: open an issue with the report
(or the core and binary, if you can share them). See
[CONTRIBUTING.md](CONTRIBUTING.md) for development setup and guidelines.

## License

MIT. crashlens uses [REA](https://github.com/morluto/rea) (MIT) through its
public CLI.
