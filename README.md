# crashlens

**Logs tell you where your program was. crashlens tells you why it died.**

When a native program crashes, the logs usually just stop. crashlens reads what
the crash left behind, the core dump and the binary, and writes a bug report
you can paste into an issue. It never runs your program, needs no SDK, and
doesn't need your source code.

```bash
crashlens ./core ./parser > crash.md
```

~~~markdown
# Crash: NULL pointer dereference in `sum+0x31`

`parser` crashed with **SIGSEGV**: null pointer dereference at `sum+0x31`.
The program read or wrote through a NULL pointer.

| Field         | Value                      |
| ------------- | -------------------------- |
| Signal        | SIGSEGV (code 1)           |
| Fault address | `0x0`                      |
| Location      | `sum+0x31 (parser+0x11da)` |
| Signature     | `7a6c9d31052c`             |

## Backtrace
```
#0 0x556fdda1b1da     sum+0x31  [parser]
#1 0x556fdda1b26a     main+0x75  [parser]
```

## Instructions at the fault
```asm
=> 0x556fdda1b1da <sum+49>:	mov    (%rax),%eax
```

## Registers used by the faulting instruction
- `rax` = `0x0` ← NULL

## Suggested next steps
- [ ] Find where the pointer used by the faulting instruction is assigned and why it can be NULL.
~~~

> **Status:** early prototype. Linux x86-64 core dumps from native programs
> (C, C++, Rust, Go). Got a crash that stumped you? Open an issue. Real
> crashes are the best test cases.

## What it recognizes

- NULL and near-NULL pointer dereferences
- stack overflow (runaway recursion, huge stack buffers)
- invalid memory access, writes to read-only memory, jumps to non-executable memory
- general protection faults (garbage pointers)
- failed `assert()`, uncaught C++ exceptions, glibc heap-corruption aborts
- divide by zero, illegal instruction, bus error, trap

If the crash happens inside a library, say `strlen(NULL)` in libc, the report
points at **your** function that called it.

Every report has a **signature** built from the crash type and top frame names
(never addresses), so the same bug groups together across runs and machines.

## How it works

crashlens is built on [REA](https://github.com/morluto/rea), an open-source
reverse-engineering toolkit. Instead of relying on what you chose to log, it
reads the program itself:

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
crashlens <core> <binary> [--json] [-o FILE] [--no-gdb] [--gdb PATH]
```

| Option | Meaning |
| --- | --- |
| `--json` | machine-readable output instead of Markdown |
| `-o FILE` | write the report to a file |
| `--no-gdb` | skip gdb (no backtrace or disassembly) |
| `--gdb PATH` | use a specific gdb |

Environment: `CRASHLENS_REA` points at a specific REA (a `rea` executable or a
`scripts/rea.mjs` checkout). `REA_PWNTOOLS_PYTHON` is required by REA.

Exit codes: `0` report produced, `1` triage failed, `2` invalid arguments.

## Safety and limits

- **Your program is never executed.** REA only reads files, and gdb loads the
  core with script auto-loading and debuginfod (network) turned off.
- The binary is matched to the core **by file name**. Pass the exact build that
  crashed. If gdb detects a mismatch, the report shows a warning.
- Without gdb there's no backtrace, only the faulting frame.
- Crash types are heuristics and say how confident they are.
- Reports include local paths and register values. Review before posting publicly.

## Roadmap

- [ ] Group a folder of crashes by signature (`--batch`)
- [ ] Go and Rust panic text, JS/Node exceptions with source maps
- [ ] Error-tracker integrations (Sentry, OpenTelemetry)
- [ ] Opt-in reproduction: rerun your own build to confirm a crash and verify a
      fix (design only; today crashlens is strictly read-only)

## Development

```bash
npm install
npm test   # unit tests; the end-to-end test also runs when gcc, gdb,
           # CRASHLENS_REA and REA_PWNTOOLS_PYTHON are available
```

## License

MIT. crashlens uses [REA](https://github.com/morluto/rea) (MIT) through its
public CLI.
