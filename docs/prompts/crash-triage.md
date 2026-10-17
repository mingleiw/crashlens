# Crash triage prompt (REA + Claude)

Paste into Claude Code (or any agent) with the REA MCP server connected
(`npx rea-agents@latest setup`). Replace the two paths. The agent reads the
core dump and the binary, never runs your program, and hands back a bug report.

```xml
<prompt>
<goal>
My program crashed and left a core dump. Tell me where it died, why, and what
to fix, with evidence behind every claim.
core: {{/abs/path/to/core}}
binary: {{/abs/path/to/the/exact/binary/that/crashed}}
</goal>

<rules>
Never run the program, not even to "reproduce" it. If reproducing would help,
show me the exact command and wait. Read files only. Cores hold process memory:
never paste raw memory or upload the core.
</rules>

<read_the_crash>
REA inspect_recorded_crash on the core: signal, si_code, fault address, the
registers of the thread that took the signal, every thread. Keep the Evidence ID.
</read_the_crash>

<place_the_pc>
Decode the core's NT_FILE note (mapped files). Load bias = runtime base of the
binary minus its link-time base. linked = pc - bias. REA inspect_binary_layout
on the binary: the function with value <= linked < value + size is where it died.
If the pc is in libc, the bug is the first frame in my binary that called it.
Stripped binary (no symbols)? Function boundaries are in .eh_frame; name them
sub_<address>. If REA has a decompiler (Ghidra), decompile the crashing function
and its caller (REA decompile, PIE addresses + 0x100000) and label it as
decompiler output.
gdb, if installed, in core-file mode only:
gdb -nx -batch -iex 'set auto-load off' -iex 'set debuginfod enabled off'
    -ex bt -ex 'info registers' -ex 'x/8i $pc' -- BINARY CORE
</place_the_pc>

<classify>
SIGSEGV, fault < 0x1000        NULL pointer dereference
SIGSEGV, fault < ~64 KiB       field read through a NULL struct pointer
fault just below rsp           stack overflow (runaway recursion)
SEGV code 2 on read-only map   write to read-only memory
pc == fault address            call through a bad function pointer
SI_KERNEL, no fault address    garbage pointer (use after free?)
SIGABRT                        assert, uncaught C++ exception, heap check
SIGFPE                         integer divide by zero
State a confidence for every heuristic.
</classify>

<root_cause>
Check the binary's GNU build ID matches the image in the core first; if not, stop.
The crash site is where a bad value was used. Find where it was produced: which
register held it, where it was loaded from, who set it. Fix it there.
</root_cause>

<report>
GitHub Markdown: "Crash: <type> in <function+offset>", summary, crash details
table, backtrace, faulting instruction + registers, likely cause + confidence,
next steps, and evidence: recorded vs computed vs inferred, REA Evidence IDs,
"the program was not executed".
</report>
</prompt>
```

Prefer a tool? [crashlens](https://github.com/mingleiw/crashlens) does all of
this in one command: `crashlens ./core ./binary`.
