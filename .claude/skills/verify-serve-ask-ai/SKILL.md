---
name: verify-serve-ask-ai
description: Model-check "Ask AI for a fix" in crashlens serve (POST /api/ai, its button in src/web/page.ts, and POST /api/clear) with TLA+. Use when a change touches the /api/ai route, the `asking` set, how a report is found, stored or cleared in src/server.ts, or the Ask AI button and busy state in src/web/page.ts.
---

# Verify "Ask AI for a fix" (crashlens serve --ai)

## What is verified

Two promises, for one report, with two browser tabs, each able to press the
button up to twice while a request is out (Enter on the focused button works
while the page is busy, because busy only blocks the pointer):

- **OneSuggestion**: a report gets at most one AI suggestion. Harm if broken:
  the report shows two different AI fixes, and the copied Markdown has both.
- **OneApiCall**: a report is sent to the Anthropic API at most once. Harm if
  broken: the user pays for the same answer twice.

The model also covers Clear all while a request is out (the reply is dropped
with 409, `analyzed.includes(entry)`) and a tab reloading (`GET /api/state`).

Not covered: two different reports, the API failing and the user retrying
(that resets `asking`, and a retry is allowed), what the model's answer says,
and anything outside these routes. A pass covers this model at these bounds,
not the whole server.

## Run it

```sh
verification/serve-ai/check.sh
```

Exit 0: every rule holds. Exit 12: a rule breaks, and TLC prints the steps.
The script downloads TLC 1.7.4 once, checks its sha256, and caches it under
`~/.cache/crashlens/`. It needs Java 11+ and takes about a second. Set
`TLA2TOOLS` to use a jar you already have.

Read every result, failing or passing, with the pstack `/statechart` skill on
`verification/serve-ai/AskAi.tla` with the view `verification/serve-ai/view.ts`.
It tells a failure as its shortest path in plain words ("you press Ask AI and
confirm", "Claude answers"), and draws the chart.

## Coverage record

Last confirmed that the model describes the code at commit **f19c7a5**.

| Model (`verification/serve-ai/AskAi.tla`) | Code |
| --- | --- |
| `Press(t)`: checks, then `asking` + 1, `calls` + 1 | `src/server.ts` route `"POST /api/ai"`, from the start up to `await suggestFix(entry.issue)`: the 404 for an unlisted report, the 409 for an existing suggestion (`sections.some(kind === "markdown")`), the 409 for `asking.has(entry.id)`, then `asking.add` |
| `Reply(t)`: `asking` - 1, then a suggestion only if still listed | the same route after `suggestFix` returns: `finally { asking.delete }`, the `analyzed.includes(entry)` 409, `entry.issue = withSuggestion(...)` |
| `Clear(t)`: `listed` becomes FALSE | `src/server.ts` route `"POST /api/clear"` (`analyzed.length = 0`) |
| `Reload(t)` | `src/server.ts` route `"GET /api/state"`, and `load()` in `src/web/page.ts` |
| `shows[t] = "noAI"` guard on `Press` | `src/web/page.ts`: `var hasAi = ...` and `if (state.aiEnabled && !hasAi)` around the button |
| keyboard press while busy (`MaxPresses = 2` per tab) | `src/web/page.ts`: `.busy { pointer-events: none }` only blocks the pointer |

Each `Press` and `Reply` is one atomic step because Node runs the route
without interruption between its `await`s; `readJson` comes before any check
and changes nothing, so it is folded into `Press`.

The replay of the shortest failing path against the real server is the test
"crashlens serve --ai: Ask AI pressed twice" in `test/server.test.ts`.

## When a change touches the covered code

1. Run `git diff f19c7a5 -- src/server.ts src/web/page.ts` and read the
   covered parts named above.
2. If the behavior the table describes changed, change the matching action in
   `AskAi.tla` so the model says what the code now does. Keep each atomic step
   equal to the code between two `await`s.
3. Run `verification/serve-ai/check.sh`.
4. On exit 12, decide whether the code or the model is wrong: replay the
   printed steps on the real server (extend the test above). If the steps
   happen in the real server, it is a real bug: fix the code, not the rule.
   If they cannot happen, the model is wrong: fix the model to match the code.
   Never weaken `OneSuggestion` or `OneApiCall` to get a pass.
5. When the model matches the code and the check gives the expected result,
   move the commit in "Last confirmed" above to the new commit. Do not move it
   without doing steps 1 to 4.

If a change is meant to allow a second suggestion (for example a "Ask again"
button), say so in the rule: change `OneSuggestion` deliberately, and record
why in this file.
