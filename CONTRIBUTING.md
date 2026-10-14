# Contributing to crashlens

Thanks for helping! crashlens is an early prototype, so the most valuable
contributions right now are **real crashes** and **honest feedback** about
whether a report actually helped.

## Ways to contribute

### 1. Share a crash (no code needed)

Open an issue with:

- the crashlens report (`crashlens ./core ./binary > crash.md`)
- what the real cause turned out to be, if you know
- whether the report helped, missed something, or was wrong

If you can share the core dump and binary, that's even better: they become
regression tests. **Core dumps contain your program's memory**, which can
include secrets, tokens or user data. Only share cores from test programs or
environments where that's safe.

### 2. Report a bug in crashlens

Include the crashlens version (`git rev-parse --short HEAD`), your distro,
`gdb --version`, `rea --version`, and the full error output. If triage failed,
`--json` output helps.

### 3. Send a pull request

Good first areas:

- new crash classes in `src/classify.ts` or panic rules in `src/panicIssue.ts`
  (with a test; for panics, add real captured output to `test/fixtures/panics/`)
- clearer explanations or next steps in reports
- new inputs from the [roadmap](README.md#roadmap), e.g. Python or Node tracebacks
- docs: getting core dumps on different distros and containers

For larger changes, open an issue first so we can agree on the approach.

## Development setup

You need Linux x86-64, Node.js 22.19+ or 24.11+, and Python 3. For the
end-to-end test you also need `gcc`, `gdb`, REA and pwntools:

```bash
git clone https://github.com/mingleiw/crashlens && cd crashlens
npm install

# For the end-to-end test
npm install -g rea-agents
python3 -m venv ~/.rea-pwn
~/.rea-pwn/bin/pip install pwntools==4.15.0 pyelftools==0.33 unicorn==2.1.2
export REA_PWNTOOLS_PYTHON=~/.rea-pwn/bin/python
export CRASHLENS_REA="$(command -v rea)"
ulimit -c unlimited   # the e2e test needs the kernel to write ./core

npm test
```

Without REA and pwntools the unit tests still run and the end-to-end test is
skipped with a message saying what's missing.

## How the code is organized

```
src/
  cli.ts          modes (core, panic text, --batch), output, exit codes
  issue.ts        the shared Issue model + Markdown/JSON rendering
  batch.ts        find crashes in a folder, triage, group by signature

  # core dumps
  triage.ts       combines REA, symbols and gdb into one core report
  coreIssue.ts    core report → Issue
  rea.ts          runs the REA CLI and parses the facts we use
  ntFile.ts       parses the core's list of mapped files (NT_FILE)
  symbolize.ts    load bias + symbols: runtime address → function+offset
  gdb.ts          optional gdb backtrace and disassembly (core file only)
  classify.ts     signal → crash type, explanation, next steps, confidence

  # panics
  panic.ts        parses Go and Rust panic output into frames
  panicIssue.ts   panic rules (message → diagnosis) and panic → Issue
test/
  unit.test.ts    core-dump logic, using fixtures shaped like real REA/gdb output
  panic.test.ts   panics and batch, using real Go 1.24 / Rust 1.97 output
  fixtures/       captured panic output (paths anonymized)
  e2e.test.ts     compiles, crashes and triages real C and Go programs

To add a new input type (say, Python tracebacks), parse it into frames and
build an `Issue`. Rendering, JSON and batch grouping then work unchanged.
```

## Principles

These keep crashlens trustworthy. PRs should preserve them.

- **Never execute the target.** crashlens reads the core and binary only.
  gdb must stay in core-file mode with auto-load and debuginfod off. Features
  that run the program (like the planned `--reproduce`) must be explicit
  opt-ins and discussed in an issue first.
- **Evidence over guesses.** Keep recorded facts (registers, signal),
  computed facts (function+offset) and heuristics (crash type) distinguishable.
  Every heuristic states a confidence level.
- **Unknown is not absent.** If something can't be determined (no mapping,
  no gdb, an inlined frame with no address), say so in the report instead of
  guessing or silently dropping it.
- **Use REA through its public CLI.** Don't depend on REA internals. If REA
  doesn't expose something, parse it in one place here (like `ntFile.ts`) or
  propose it upstream.
- **Stable signatures.** Signatures must not include addresses, paths or
  anything else that changes between runs.

## Pull request checklist

- [ ] `npm test` passes (and the e2e test, if you can run it)
- [ ] `npm run typecheck` passes
- [ ] New behavior has a test, including the failure path where relevant
- [ ] Report output changes include a before/after example in the PR
- [ ] No core dumps, binaries or secrets committed

Commit messages and PR titles use
[Conventional Commits](https://www.conventionalcommits.org/) (`feat:`, `fix:`,
`docs:`, `test:` …).

## License

By contributing, you agree that your contributions are licensed under the
[MIT License](LICENSE).
