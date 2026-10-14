# crashlens

[![CI](https://github.com/mingleiw/crashlens/actions/workflows/ci.yml/badge.svg)](https://github.com/mingleiw/crashlens/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**Logs tell you where your program was. crashlens tells you why it died.**

When a program crashes, the logs usually just stop. crashlens reads what the
crash left behind (a core dump, or a Go/Rust panic message) and writes a bug
report you can paste into an issue. It never runs your program and needs no SDK.
Point it at a folder of crashes and it groups them into distinct bugs.

![Logs stop at "calculating total". crashlens says: NULL pointer dereference in sum+0x31, rax = 0x0](docs/images/before-after.svg)

```bash
crashlens ./core ./parser > crash.md
```

<details open>
<summary><b>A real report</b>, generated from a crashed C program (paste it straight into a GitHub issue)</summary>
<br>
<img src="docs/images/report.png" alt="crashlens report: NULL pointer dereference in sum+0x31, with crash details, backtrace, faulting instruction, registers and next steps" width="640">
</details>

> **Status:** early prototype. Reads Linux x86-64 core dumps (C, C++, Rust, Go)
> and Go/Rust panic output. Got a crash that stumped you? Open an issue. Real
> crashes are the best test cases.

## Three ways to use it

```bash
crashlens ./core ./app                 # a native crash: core dump + the binary
go run . 2>&1 | crashlens -            # a Go or Rust panic, piped in (or saved to a file)
crashlens --batch ./crashes ./app      # a folder of crashes, grouped into distinct bugs
```

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

**Rust panics**: `unwrap()` on `None`/`Err` (with the error value), index and
slice out of bounds, arithmetic overflow, divide by zero, `RefCell` borrowed
twice, failed `assert!`, string sliced inside a character, explicit `panic!`/`expect`

The report always points at **your** code first: for a native crash inside libc
(say `strlen(NULL)`) it names your function that called it, and for panics it
skips runtime and standard-library frames.

Every report has a **signature** built from the crash type and top frame names
(never addresses or directories), so the same bug groups together across runs
and machines.

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
crashlens <core> <binary>          [options]
crashlens <panic.txt | ->          [options]
crashlens --batch <dir> [binary]   [options]
```

| Option | Meaning |
| --- | --- |
| `--json` | machine-readable output instead of Markdown |
| `-o FILE` | write the report to a file |
| `--no-gdb` | skip gdb (no backtrace or disassembly) |
| `--gdb PATH` | use a specific gdb |

Panic text needs nothing else installed. For core dumps: `CRASHLENS_REA` points at a specific REA (a `rea` executable or a
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
- Reports include local paths and register values. Review before posting publicly.

## Roadmap

- [x] Group a folder of crashes by signature (`--batch`)
- [x] Go and Rust panic text
- [ ] JS/Node, Python and Java exceptions
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
