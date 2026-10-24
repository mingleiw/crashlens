# How to make your agent a better debugger than everyone else's agent

![How to make your agent a better debugger than everyone else's agent: 69/81 vs 81/81 root-cause fixes](img/banner-header.png)

Give a coding agent a stack trace and it will fix the line in the stack trace.
That sounds like the job. Most of the time it is the wrong fix.

Here is one case from our benchmark. An orders service crashes while
building a receipt email:

```text
  File "./notifier.py", line 8, in receipt_email
    f"Hi {customer.name},\n"
          ^^^^^^^^^^^^^
AttributeError: 'NoneType' object has no attribute 'name'
```

A comment next to the crash says the customer "can be missing for guest
checkouts". Given only that error, Claude Code produced this in 12 of 18 runs:

```diff
  customer = repository.get_customer(order.customer_ref)
+ if customer is None:
+     # Guest checkout or deleted account: there is no address to send a receipt to.
+     log.warning("no customer for order %s; skipping receipt", order.id)
+     return
```

The crash is gone. So are all the receipts, forever. The real bug is three
files away: the API sends `customerId` and `models.py` reads `customer_id`.
Every order looks like a guest checkout now.

The agent did nothing dumb. It read the code it was shown, trusted the comment
and made the error go away. The problem is what it was shown. The crash line
is where a bad value was *used*. The bug is where it was *made*. Nothing in a
stack trace tells you where a value was made.

We built [crashlens](https://github.com/mingleiw/crashlens)
around that one idea, on top of [REA](https://github.com/morluto/rea)
(Reverse Engineer Anything) for the native side. Below is what made agents
better at debugging, what didn't, and the numbers, including the ones that
don't flatter it.

## 1. Give it provenance, not more logs

The instinct when an agent fails is to give it more: more log lines, more
files, a bigger context. That didn't fix the receipt bug. The comment was the
most convincing thing in the context, and more context only adds more
plausible comments.

![The crash line is where the value was used. Find where it was made.](img/banner-trace.png)

What worked was a short chain: where the bad value came from, step by step,
across frames and files. This is what crashlens prints for that crash, from a
static reading of the repo:

```markdown
## Where the bad value came from
- The bad value is `customer` at `notifier.py:8`.
- `customer` is a parameter of `receipt_email`, passed as `customer` at `service.py:13`.
- `customer` is assigned at `service.py:12`: `customer = repository.get_customer(order.customer_ref)`
- `order` is a parameter of `process`, passed as `Order.from_dict(raw)` at `main.py:10`.
- `customer_ref` is set from `data.get("customer_id")` at `models.py:23`.
```

No execution, no SDK, no logging changes. Follow assignments back, and when
the value is a parameter, go up one frame and read the argument the caller
passed. The stack trace already lists the frames. It just doesn't connect
them.

With that trace in the prompt (plus one line: "the lookup found nothing,
check the key before guarding the crash site"), root-cause fixes went from
**6/18 to 13/18**.

## 2. Name the cause. Pointing is not enough

13/18 is better, not good. The trace pointed at `models.py:23`, and the agent
still had to notice that `customer_id` was the wrong spelling.

So the next version checks the key against the project's own data: JSON
fixtures, OpenAPI schemas, API client code. If the code reads a field that no
sample has, and a sample has a near miss, it says so:

```markdown
- **Field name mismatch.** `customer_ref` is read from `data.get("customer_id")`
  at `models.py:23`, but no data sample in the project has `customer_id`; it
  has `customerId` (`api_client.py:5`). If that is this data, read the key it
  actually uses rather than defaulting the missing value.
```

That moved the numbers more than anything else we tried. On four new cases where
code reads a payload field under the wrong name, the error alone got 5/20 root
fixes (10/40 over two batches). The report that traced the value but did not
name the key got **9/20**. The report that names the key got **20/20**.

That is the most useful thing we learned: **an agent with a pointer still
guesses; an agent with a named hypothesis checks it.** "Look here" leaves room
for the comment to win. "This key is `customerId` in the data and
`customer_id` in the code" doesn't.

The same goes for keys the code computes. A `KeyError` from
`record[prefix + "_ref"]` used to get no trace, because the key isn't a
literal in the source. Python prints the evaluated key in the error message
(`'billing_ref'`), so crashlens takes it from there and checks it like any
other. Previous report 1/5, new one 5/5.

## 3. Go where values hide: config merges

The bugs that waste the most time are the ones where the value passed through
something that looks harmless. Config loading is the classic:

```text
TypeError: Cannot read properties of undefined (reading 'max')
    at createPool (./db/pool.js:3:30)
```

`dbConfig.pool` is undefined because `Object.assign({}, defaults, overrides)`
replaces the whole `db` object, and the production override sets `db` without
`pool`. The crash is two files from the merge, and the trace used to stop at
`config.db`, a field of something returned from a function.

Following values *through* objects (`loadConfig(...).db.pool` is the `pool`
field of the `db` field of whatever `loadConfig` returns) gets you to the
merge, and from there it's mechanical: read the shape of each source and look
for a later source that sets a top-level key without a nested key an earlier
one had.

```markdown
- **Shallow merge drops a nested key.** `Object.assign({}, defaults, overrides)`
  at `config/index.js:5` replaces whole top-level values. The source at
  `config/production.js:2` sets `db` without `pool`, so `db.pool` from
  `config/defaults.js:3` is lost. Merge nested objects deeply, or set `pool`
  in that override.
```

On three merge cases (JS `Object.assign`, JS spread, Python `{**a, **b}`), the
smaller model (Haiku) got **1/15** root fixes from the error alone, **10/15**
with the previous report and **15/15** with this one. On the Python case the
previous report stopped at `settings["cache"]` and Haiku guarded the crash
site in 5 of 5 runs.

## 4. Use what the runtime already tells you

Runtimes are better at saying what went wrong than most tools give them
credit for. Since JDK 15 (JEP 358, on by default), the JVM's NullPointerException
message names the null:

```text
java.lang.NullPointerException: Cannot invoke "com.acme.Customer.tier()" because "<local2>" is null
	at com.acme.InvoiceService.invoiceLine(InvoiceService.java:16)
```

That's a slot number, because this class was compiled without `-g`. javac
numbers slots predictably: `this`, then the parameters (`long` and `double`
take two), then locals in declaration order, reusing a block's slots once it
closes. So you can map `<local2>` back to a name, check it against the type in
the message (`Customer`), and keep tracing:

```markdown
- `<local2>` in the message is the local variable `customer` (slot 2; the class
  was compiled without `-g`, so the JVM only knows the slot).
- `customer` is assigned `customers.find(order.email())` at `InvoiceService.java:13`.
- `find(...)` returns `byEmail.get(email)` at `CustomerRepository.java:15`.

- **Key normalized on write, not on read.** `CustomerRepository.java:11` stores
  entries under `customer.email().toLowerCase(Locale.ROOT)`, but
  `byEmail.get(email)` looks up the key as given, without `toLowerCase()`.
```

Don't trust a mapping like that on vibes. We compiled 13 method layouts with
and without `-g` and compared crashlens's answer with the real variable name.
That caught a real wrong answer (in `String a = "a", b = null;` it named `a`
instead of `b`) and one where it gave up when it shouldn't have (an
anonymous class inside the method). All 13
match now, and when the slot and the type disagree it names nothing.

On four Java cases with the bug in another file, Haiku fixed the root cause in
**11/20** and **12/20** runs from the error alone (two batches), **12/20**
with the previous report and **20/20** with the new one. The clearest single
case: code reads `region.default`, and `app.properties` has `default.region`.
Without the hypothesis, Haiku guarded the crash site in 5 of 5 runs. One of
them:

```diff
-        String region = settings.get("region.default").trim();
+        String region = settings.get("region.default");
+        if (region == null || region.isBlank()) {
+            region = "us-east-1";
+        }
```

With it, 5 of 5 changed the key to `default.region`. (Some kept a fallback
too. Fine.)

## 5. When there's no source: read the program itself

Native crashes are where agents are weakest, because a core dump is not text.
For that side crashlens is built on REA, which reads the recorded crash
(signal, fault address, registers, mapped files) and the binary's layout.
Three things mattered:

- **Check the binary is the one that crashed.** The binary's GNU build ID is
  compared with the image the process actually ran. A rebuilt binary gives
  confident, wrong answers otherwise.
- **Name every function, even stripped.** Function boundaries come from
  `.eh_frame`, which every binary keeps for unwinding, so a stripped address
  becomes `sub_120a+0x31` instead of a hex number.
- **Decompile the crash and its caller.** With Ghidra installed, REA
  decompiles both, labeled as decompiler output, not your source:

```c
// Decompiled caller `sub_11f8` (REA + ghidra: decompiler output, not your source)
__ptr = malloc(0x20);
*__ptr = FUN_001011a9;
free(__ptr);
__s = malloc(0x20);
memset(__s,0x41,0x20);
FUN_001011d4(__ptr,7);        // calls through the freed pointer: use after free
```

With the decoded core and pseudocode, the agent went from 4 turns to 1 to
reach the root cause and cost dropped by about a third. On 7 kinds of crashes
with stripped binaries and no source, agents using crashlens found the right
root cause in 6 and narrowed the 7th (a divide by zero) to the caller that
passed the zero.

## 6. Say nothing when you don't know

A hypothesis tool that's wrong 10% of the time is worse than none, because
agents believe it. Every check in crashlens has guards that keep it quiet:

- No "no code writes this key" claim when the data comes from `json.loads`
  or a request, since its keys come from outside the codebase.
- No "shallow merge" when the merge is deep, the override keeps the key, or a
  source is loaded at runtime and can't be read statically.
- No "field never assigned" when the field is injected (`@Autowired`,
  `@Inject`, Lombok) or isn't private.
- No property-key hypothesis unless the class names the file it loads, and
  only key names in the output, never values.

Each new check also gets an old-vs-new diff of the full report on every
existing bench case. For the Java work, all 21 Python and JavaScript reports
came out byte-identical. And every hypothesis is labeled as a static reading:
"verify before acting".

## The scoreboard

The harness is in the repo (`bench/`). Each case is a small project that
crashes. The agent (Claude Code, headless) gets the error output (A), or the
error plus the crashlens report (B), and edits a fresh copy. Each diff is
scored as a root-cause fix or a symptom guard.

![Root-cause fixes with the error alone vs with the crashlens report](img/results.png)

| Benchmark | Error only | With crashlens |
| --- | --- | --- |
| Misleading comment, bug 3 files away (18 runs) | 6/18 | **13/18** |
| Payload field read under the wrong name (4 cases) | 5/20 (10/40 over two batches) | **20/20** |
| Nested config key dropped by a shallow merge, Haiku (3 cases) | 1/15 | **15/15** |
| Java NullPointerException, bug in another file, Haiku (4 cases) | 11/20, 12/20 | **20/20** |
| Case-mismatched id, smaller model (3 runs) | 0/3 | **3/3** |
| Stripped binary + core dump: turns to the root cause | 4 | **1** |
| **All 27 cases × 3, default model** | **69/81** | **81/81** |

All 12 misses in that last row are symptom guards: a null check or a default
at the crash site, which is exactly the fix from the top of this article.

## What we're not claiming

**We wrote the cases.** 27 small repos, each with one bug and usually a
misleading comment. 19 are "held out", meaning written before the check they
test existed, but we've looked at the reports on most of them since.
This is a regression suite for an idea, not a study.

**The strong model mostly doesn't need it.** On the four Java cases the
default model fixed all 20 runs with or without the new report; the report
only cut turns (6.9 to 4.4 on average). On the merge cases it got 14/15
alone. The big swings are on Haiku, and on cases built to mislead.

**It didn't help on Java cases we didn't build for.** After the Java trace was
done we wrote two more cases and didn't tune on them: an enum name against a
wire-format string, and a constructor overload that never sets a field.
Haiku got 6/10 with the previous report and 5/10 with the new one. The strong
model got 10/10 with both. When the cause isn't one the trace can name, you
get a trace and nothing more.

**Batches vary a lot.** The same no-crashlens condition got 1/5 in one batch
and 4/5 in another on the computed-key case. Five runs per cell is enough to
see a 1/15 vs 15/15 gap, not a 4/5 vs 5/5 one.

**Scoring is regex, and we got it wrong twice.** One root-cause pattern used
`(?m)`, which JavaScript doesn't support, and crashed a run mid-batch. Another
was too narrow and scored real fixes as guards in both conditions. After
widening it we read the diffs and rescored every run of that case with the same
pattern. Read the diffs before you quote numbers, including ours.

**Some things didn't move at all.** When the failure output already prints
the variables (pytest `--showlocals`, a Sentry event), the agent got 5/5
without crashlens: with the values on screen, it reads them itself. On
single-file bugs, the report only added tokens.

## If you're building this into your own agent

1. **Trace backward from the crash line.** Assignments, then the caller's
   argument, across files. Stop and say nothing when scope gets unclear.
2. **Turn traces into named hypotheses** that point at a line on each side:
   "written as X here, read as Y there".
3. **Check against the repo's own data.** Fixtures, schemas and properties
   files are ground truth the agent ignores unless you put them in front of it.
4. **Read the runtime's own words.** Evaluated keys in `KeyError`, the NPE
   message, the build ID in a core. They're more precise than your parser.
5. **Verify your inference against a compiler.** If you map slots, offsets or
   frames, test the mapping against a build with debug info.
6. **Keep a benchmark with misleading comments,** score root cause vs guard,
   and keep the runs you wish hadn't happened.

crashlens is MIT-licensed, never runs your program, and works offline. Try it
in Claude Code:

```text
/plugin install crashlens --marketplace mingleiw/crashlens
```

or paste a stack trace into the [live demo](https://mingleiw.github.io/crashlens/).
If you have a crash that stumped your agent, open an issue. Real crashes make
better test cases than ours.
