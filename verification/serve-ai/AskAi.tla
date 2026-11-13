---- MODULE AskAi ----
\* "Ask AI for a fix" in the local web UI (crashlens serve --ai), for one report.
\* Code: route "POST /api/ai" in src/server.ts; the button and its click handler
\* in src/web/page.ts (renderDetail: `hasAi`, `ask.addEventListener`).
\*
\* The page shows the button only while its copy of the report has no AI
\* section, and goes busy while it waits. Busy only blocks the pointer
\* (`.busy { pointer-events: none }`), so the same tab can press it again from
\* the keyboard, and a second tab on the same URL has its own copy.
\*
\* Atomic steps match the route's awaits:
\*   Press      = the route's checks, up to `await suggestFix(entry.issue)`
\*   Reply      = the route resumes after suggestFix, re-checks the report is
\*                still listed, then sets entry.issue = withSuggestion(entry.issue, ...)
EXTENDS Naturals

CONSTANTS Tabs, MaxPresses

VARIABLES
  listed,   \* the report is in `analyzed` (POST /api/clear empties it)
  ai,       \* AI sections on the server's report: withSuggestion appends one per reply
  calls,    \* suggestFix calls made for this report (each is a paid API request)
  asking,   \* asking[t]: requests from tab t still waiting for suggestFix
  shows     \* shows[t]: what tab t's copy says: "noAI", "hasAI" or "cleared"

vars == <<listed, ai, calls, asking, shows>>

Init == /\ listed = TRUE /\ ai = 0 /\ calls = 0
        /\ asking = [t \in Tabs |-> 0]
        /\ shows = [t \in Tabs |-> "noAI"]

\* Click (or Enter) on "Ask AI for a fix", confirm, POST /api/ai.
\* The button exists only while the tab's copy has no AI section (page.ts `!hasAi`).
\* The route turns the request away with no API call when the report is not
\* listed (404), already has a suggestion (409), or is already being asked
\* about (`asking`, 409). Otherwise it calls suggestFix.
Asking == \E t \in Tabs : asking[t] > 0
Press(t) ==
  /\ shows[t] = "noAI" /\ asking[t] < MaxPresses
  /\ IF listed /\ ai = 0 /\ ~Asking
       THEN asking' = [asking EXCEPT ![t] = @ + 1] /\ calls' = calls + 1
       ELSE UNCHANGED <<asking, calls>>
  /\ UNCHANGED <<listed, ai, shows>>

\* suggestFix returns. The route re-checks `analyzed.includes(entry)` (409 if
\* cleared), else appends the suggestion to whatever entry.issue is now.
Reply(t) ==
  /\ asking[t] > 0
  /\ asking' = [asking EXCEPT ![t] = @ - 1]
  /\ IF listed
       THEN ai' = ai + 1 /\ shows' = [shows EXCEPT ![t] = "hasAI"]
       ELSE UNCHANGED <<ai, shows>>
  /\ UNCHANGED <<listed, calls>>

\* Reload: GET /api/state gives the tab the server's current copy.
Reload(t) ==
  /\ shows' = [shows EXCEPT ![t] = IF ~listed THEN "cleared" ELSE IF ai > 0 THEN "hasAI" ELSE "noAI"]
  /\ UNCHANGED <<listed, ai, calls, asking>>

\* POST /api/clear from tab t.
Clear(t) ==
  /\ listed' = FALSE
  /\ shows' = [shows EXCEPT ![t] = "cleared"]
  /\ UNCHANGED <<ai, calls, asking>>

Next == \E t \in Tabs : Press(t) \/ Reply(t) \/ Reload(t) \/ Clear(t)

Spec == Init /\ [][Next]_vars

\* Rules a user would agree to.
\* A report gets at most one AI suggestion.
OneSuggestion == ai <= 1
\* Asking again for a report that already has (or is getting) a suggestion
\* does not send it to the API again.
OneApiCall == calls <= 1
====
