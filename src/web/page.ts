/**
 * The local web UI, served by `crashlens serve`. Plain HTML/CSS/JS with no
 * external resources, so it works offline and fits a strict CSP. Every piece
 * of crash content is inserted with textContent or escaped before use.
 *
 * Written with String.raw so regex backslashes survive; the browser code
 * avoids backticks and "${" for the same reason.
 */

export const INDEX_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>crashlens</title>
<link rel="stylesheet" href="/app.css">
<script src="/app.js" defer></script>
</head>
<body>
<header class="top">
  <div class="brand"><span class="mark" aria-hidden="true"></span>crashlens</div>
  <div class="tagline">Logs tell you where your program was. crashlens tells you why it died.</div>
  <div class="local" title="Files are processed by the crashlens process on this computer">Runs locally · nothing leaves this machine</div>
</header>
<main class="layout">
  <aside class="side">
    <section class="card drop" id="drop" tabindex="0" aria-label="Drop crash files here">
      <div class="drop-title">Drop a crash here</div>
      <div class="drop-sub">A log with a panic or exception, a sanitizer report, or a core dump with its binary</div>
      <label class="btn secondary">Choose files<input type="file" id="files" multiple hidden></label>
      <div id="pending" class="pending" hidden>
        <div id="pendingText"></div>
        <textarea id="coreLog" rows="3" placeholder="Optional: paste the app's log so the report shows what it was doing"></textarea>
        <button id="analyzeCore" class="btn" disabled>Analyze core dump</button>
      </div>
    </section>
    <section class="card">
      <textarea id="text" rows="7" spellcheck="false" placeholder="…or paste a stack trace, panic, traceback or log here"></textarea>
      <div class="row end"><button id="analyze" class="btn">Analyze</button></div>
    </section>
    <section class="card" id="sourceCard">
      <label class="label" for="source">Your source code <span class="muted">(optional)</span></label>
      <div class="row"><input id="source" placeholder="/absolute/path/to/your/repo" spellcheck="false"><button id="setSource" class="btn secondary">Set</button></div>
      <div class="hint" id="sourceHint">Shows the failing lines and who last changed them.</div>
    </section>
    <section class="bugs">
      <div class="bugs-head"><h2>Bugs</h2><button id="clear" class="link" hidden>Clear all</button></div>
      <ol id="bugs" class="bug-list"></ol>
      <p id="empty" class="hint">Nothing analyzed yet.</p>
    </section>
  </aside>
  <section class="detail" id="detail" aria-live="polite">
    <div class="welcome">
      <h1>What crashed?</h1>
      <p>Drop or paste any of these and crashlens explains where it failed and why, pointing at your code first.</p>
      <ul class="inputs">
        <li><b>Go / Rust</b> panics</li>
        <li><b>Python</b> tracebacks</li>
        <li><b>Java</b> stack traces</li>
        <li><b>Node.js</b> errors</li>
        <li><b>ASan / UBSan</b> reports</li>
        <li><b>Linux core dumps</b> + binary</li>
      </ul>
      <p class="muted">Logs printed before the failure are shown too, so you can see which request or order triggered it. The same bug from many files is grouped together.</p>
    </div>
  </section>
</main>
<div id="toast" class="toast" role="status" hidden></div>
</body>
</html>`;

export const APP_CSS = String.raw`
:root {
  --bg: #f6f7f9; --panel: #ffffff; --text: #1f2328; --muted: #656d76; --line: #d8dee4;
  --accent: #6639ba; --accent-soft: #f1ebfc; --own: #fff8c5; --danger: #cf222e; --ok: #1a7f37;
  --code-bg: #f6f8fa; --shadow: 0 1px 2px rgba(31,35,40,.06), 0 4px 16px rgba(31,35,40,.06);
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0d1117; --panel: #161b22; --text: #e6edf3; --muted: #8d96a0; --line: #30363d;
    --accent: #b083f0; --accent-soft: #2a1f3d; --own: #3b2e00; --danger: #ff7b72; --ok: #3fb950;
    --code-bg: #0d1117; --shadow: none; color-scheme: dark;
  }
}
* { box-sizing: border-box; }
[hidden] { display: none !important; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, Arial, sans-serif; }
code, pre, textarea, input { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
.top { display: flex; align-items: center; gap: 20px; padding: 14px 24px; background: var(--panel);
  border-bottom: 1px solid var(--line); flex-wrap: wrap; }
.brand { font-weight: 800; font-size: 19px; display: flex; align-items: center; gap: 9px; letter-spacing: -.3px; }
.mark { width: 18px; height: 18px; border-radius: 50%; border: 3px solid var(--accent); box-shadow: inset 0 0 0 3px var(--panel), inset 0 0 0 9px var(--accent); }
.tagline { color: var(--muted); flex: 1; min-width: 200px; }
.local { font-size: 13px; color: var(--ok); border: 1px solid currentColor; border-radius: 999px; padding: 2px 10px; }
.layout { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: 20px; padding: 20px 24px; max-width: 1500px; margin: 0 auto; }
@media (max-width: 860px) { .layout { grid-template-columns: 1fr; padding: 16px; } }
.side { display: flex; flex-direction: column; gap: 14px; min-width: 0; }
.card { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 14px; box-shadow: var(--shadow); }
.drop { border: 2px dashed var(--line); text-align: center; padding: 22px 14px; transition: border-color .15s, background .15s; }
.drop.over { border-color: var(--accent); background: var(--accent-soft); }
.drop-title { font-weight: 700; font-size: 17px; }
.drop-sub { color: var(--muted); font-size: 13px; margin: 4px 0 12px; }
.pending { margin-top: 12px; text-align: left; display: flex; flex-direction: column; gap: 8px; font-size: 14px; }
textarea, input { width: 100%; border: 1px solid var(--line); border-radius: 8px; background: var(--code-bg); color: var(--text); padding: 8px 10px; font-size: 13px; }
textarea { resize: vertical; }
textarea:focus, input:focus { outline: 2px solid var(--accent); outline-offset: -1px; }
.row { display: flex; gap: 8px; margin-top: 8px; }
.row.end { justify-content: flex-end; }
.label { font-weight: 600; font-size: 14px; }
.hint, .muted { color: var(--muted); font-size: 13px; }
.hint { margin: 6px 0 0; }
.btn { background: var(--accent); color: #fff; border: 0; border-radius: 8px; padding: 7px 14px; font: inherit; font-weight: 600; cursor: pointer; white-space: nowrap; }
.btn:disabled { opacity: .5; cursor: default; }
.btn.secondary { background: transparent; color: var(--accent); border: 1px solid var(--accent); display: inline-block; }
.link { background: none; border: 0; color: var(--muted); cursor: pointer; font: inherit; font-size: 13px; }
.link:hover { color: var(--danger); }
.bugs-head { display: flex; justify-content: space-between; align-items: baseline; }
.bugs h2 { font-size: 15px; margin: 4px 0 8px; }
.bug-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; }
.bug { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px; cursor: pointer; display: grid; grid-template-columns: 1fr auto; gap: 2px 10px; }
.bug:hover { border-color: var(--accent); }
.bug.selected { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent); }
.bug-title { font-weight: 600; font-size: 14px; }
.bug-where { grid-column: 1; color: var(--muted); font-size: 12.5px; overflow-wrap: anywhere; }
.count { grid-row: 1 / span 2; grid-column: 2; align-self: center; background: var(--accent-soft); color: var(--accent); border-radius: 999px; padding: 1px 9px; font-weight: 700; font-size: 13px; }
.chip { display: inline-block; font-size: 11.5px; font-weight: 600; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); border: 1px solid var(--line); border-radius: 6px; padding: 0 6px; margin-right: 6px; }
.detail { min-width: 0; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 24px 28px; box-shadow: var(--shadow); align-self: start; }
.welcome h1 { margin-top: 0; }
.inputs { display: grid; grid-template-columns: repeat(auto-fill, minmax(170px, 1fr)); gap: 8px; padding: 0; list-style: none; }
.inputs li { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; }
.issue-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; flex-wrap: wrap; }
.issue-head h1 { font-size: 22px; margin: 4px 0 6px; overflow-wrap: anywhere; }
.actions { display: flex; gap: 8px; }
.seen { color: var(--muted); font-size: 13px; margin-bottom: 10px; overflow-wrap: anywhere; }
.summary { font-size: 15.5px; }
.detail h2 { font-size: 15px; margin: 22px 0 8px; padding-bottom: 4px; border-bottom: 1px solid var(--line); }
table { border-collapse: collapse; width: 100%; font-size: 14px; }
td { border-top: 1px solid var(--line); padding: 6px 8px; vertical-align: top; overflow-wrap: anywhere; }
td:first-child { color: var(--muted); width: 190px; white-space: nowrap; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 10px 0; overflow-x: auto; font-size: 12.5px; line-height: 1.55; margin: 0; }
pre .ln { display: block; padding: 0 12px; white-space: pre; }
pre .ln.own { background: var(--own); }
code { background: var(--code-bg); border: 1px solid var(--line); border-radius: 5px; padding: 0 4px; font-size: .9em; }
pre code { border: 0; padding: 0; background: none; }
.steps { list-style: none; padding: 0; }
.steps li { display: flex; gap: 8px; align-items: baseline; margin: 4px 0; }
.warn { background: color-mix(in srgb, var(--danger) 10%, transparent); border: 1px solid color-mix(in srgb, var(--danger) 40%, transparent); border-radius: 8px; padding: 8px 12px; margin-top: 14px; font-size: 14px; }
details { margin-top: 18px; font-size: 13.5px; color: var(--muted); }
details li { overflow-wrap: anywhere; }
.ai { border: 1px solid var(--accent); border-radius: 10px; padding: 4px 16px 10px; background: var(--accent-soft); }
.ai h3 { font-size: 14.5px; margin: 14px 0 6px; }
.ai pre { margin: 8px 0; }
.ai-note { font-size: 13px; color: var(--muted); margin: 8px 0 0; }
.toast { position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%); background: var(--text); color: var(--panel); padding: 9px 16px; border-radius: 8px; font-size: 14px; max-width: min(90vw, 640px); box-shadow: var(--shadow); }
.toast.error { background: var(--danger); color: #fff; }
.busy { opacity: .6; pointer-events: none; }
`;

export const APP_JS = String.raw`
"use strict";
(function () {
  // The session token arrives in the URL fragment (never sent to servers or logs).
  var token = "";
  var match = /token=([0-9a-f]+)/.exec(location.hash);
  try {
    if (match) { token = match[1]; sessionStorage.setItem("crashlens-token", token); }
    else { token = sessionStorage.getItem("crashlens-token") || ""; }
  } catch (e) { if (match) token = match[1]; }
  if (match) history.replaceState(null, "", location.pathname);

  var $ = function (id) { return document.getElementById(id); };
  var state = { issues: [], selected: null, core: null, binary: null, aiEnabled: false };

  function api(method, path, body, raw) {
    var headers = { "X-Crashlens-Token": token };
    if (!raw && body !== undefined) headers["Content-Type"] = "application/json";
    return fetch(path, { method: method, headers: headers, body: raw ? body : (body === undefined ? undefined : JSON.stringify(body)) })
      .then(function (res) {
        return res.json().then(function (data) {
          if (!res.ok) throw new Error(data.error || ("HTTP " + res.status));
          return data;
        });
      });
  }

  function toast(message, isError) {
    var el = $("toast");
    el.textContent = message;
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toast.timer);
    toast.timer = setTimeout(function () { el.hidden = true; }, isError ? 7000 : 2500);
  }

  function busy(on) { document.body.classList.toggle("busy", on); }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  // Minimal inline Markdown for crashlens' own strings: **bold**, code spans.
  // Input is untrusted crash text, so build DOM nodes instead of HTML.
  function inline(parent, text) {
    var re = /(\x60\x60 ([\s\S]+?) \x60\x60|\x60([^\x60]+)\x60|\*\*([^*]+)\*\*)/g;
    var last = 0, m;
    while ((m = re.exec(text))) {
      if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
      if (m[2] !== undefined || m[3] !== undefined) parent.appendChild(el("code", "", m[2] !== undefined ? m[2] : m[3]));
      else parent.appendChild(el("b", "", m[4]));
      last = re.lastIndex;
    }
    if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
    return parent;
  }

  function groups() {
    var bySig = {};
    var order = [];
    state.issues.forEach(function (entry) {
      var sig = entry.issue.signature;
      if (!bySig[sig]) { bySig[sig] = []; order.push(sig); }
      bySig[sig].push(entry);
    });
    return order.map(function (sig) { return bySig[sig]; })
      .sort(function (a, b) { return b.length - a.length; });
  }

  var LANG = { "core": "core dump", "go-panic": "go", "rust-panic": "rust", "python-exception": "python",
    "java-exception": "java", "node-exception": "node", "sanitizer": "sanitizer" };

  function renderList() {
    var list = $("bugs");
    list.textContent = "";
    var all = groups();
    $("empty").hidden = all.length > 0;
    $("clear").hidden = all.length === 0;
    all.forEach(function (entries) {
      var first = entries[0];
      var li = el("li", "bug" + (state.selected && state.selected.issue.signature === first.issue.signature ? " selected" : ""));
      li.tabIndex = 0;
      var title = el("div", "bug-title");
      title.appendChild(el("span", "chip", LANG[first.issue.source] || first.issue.source));
      title.appendChild(document.createTextNode(first.issue.title));
      li.appendChild(title);
      li.appendChild(el("div", "count", String(entries.length)));
      li.appendChild(el("div", "bug-where", first.issue.where || "unknown location"));
      var open = function () { state.selected = entries[entries.length - 1]; render(); };
      li.addEventListener("click", open);
      li.addEventListener("keydown", function (e) { if (e.key === "Enter") open(); });
      list.appendChild(li);
    });
  }

  function heading(parent, text) { parent.appendChild(el("h2", "", text)); }

  function renderDetail() {
    var root = $("detail");
    var entry = state.selected;
    if (!entry) return;
    var issue = entry.issue;
    var siblings = state.issues.filter(function (e) { return e.issue.signature === issue.signature; });
    root.textContent = "";

    var head = el("div", "issue-head");
    var titleBox = el("div");
    titleBox.appendChild(el("span", "chip", LANG[issue.source] || issue.source));
    var h1 = el("h1");
    inline(h1, issue.title + (issue.where ? " in \x60" + issue.where + "\x60" : ""));
    titleBox.appendChild(h1);
    head.appendChild(titleBox);
    var actions = el("div", "actions");
    var copy = el("button", "btn secondary", "Copy Markdown");
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(entry.markdown).then(function () { toast("Copied. Paste it into an issue."); },
        function () { toast("Copy failed; use Download instead.", true); });
    });
    var download = el("button", "btn secondary", "Download .md");
    download.addEventListener("click", function () {
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([entry.markdown], { type: "text/markdown" }));
      a.download = "crashlens-" + issue.signature + ".md";
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
    });
    var hasAi = issue.sections.some(function (s) { return s.kind === "markdown"; });
    if (state.aiEnabled && !hasAi) {
      var ask = el("button", "btn", "Ask AI for a fix");
      ask.addEventListener("click", function () {
        var okToSend = window.confirm("This sends the report shown here, including any code snippets and log lines, to the Anthropic API (Claude) to get an explanation and suggested fix. Continue?");
        if (!okToSend) return;
        busy(true);
        toast("Asking Claude… this can take a little while.");
        api("POST", "/api/ai", { id: entry.id }).then(function (updated) {
          state.issues = state.issues.map(function (e) { return e.id === updated.id ? updated : e; });
          state.selected = updated;
          render();
        }, function (err) { toast(err.message, true); }).then(function () { busy(false); });
      });
      actions.appendChild(ask);
    }
    actions.appendChild(copy);
    actions.appendChild(download);
    head.appendChild(actions);
    root.appendChild(head);

    root.appendChild(el("div", "seen", (siblings.length > 1 ? "Seen " + siblings.length + " times: " : "From: ") +
      siblings.map(function (e) { return e.name; }).join(", ")));
    root.appendChild(inline(el("p", "summary"), issue.summary));

    issue.warnings.forEach(function (w) { root.appendChild(inline(el("div", "warn"), w)); });

    heading(root, "Details");
    var table = el("table");
    issue.facts.concat([{ label: "Confidence", value: issue.confidence }, { label: "Signature", value: "\x60" + issue.signature + "\x60" }])
      .forEach(function (fact) {
        var tr = el("tr");
        tr.appendChild(el("td", "", fact.label));
        tr.appendChild(inline(el("td"), fact.value));
        table.appendChild(tr);
      });
    root.appendChild(table);

    issue.sections.forEach(function (section) {
      heading(root, section.heading);
      if (section.kind === "code") {
        var pre = el("pre");
        var code = el("code");
        section.lines.forEach(function (line) {
          var own = /^(→ #|> |=> )/.test(line);
          code.appendChild(el("span", "ln" + (own ? " own" : ""), line || " "));
        });
        pre.appendChild(code);
        root.appendChild(pre);
      } else if (section.kind === "markdown") {
        var box = el("div", "ai");
        markdown(box, section.markdown);
        box.appendChild(el("p", "ai-note", "Generated by AI from this report. Check it against your code before applying."));
        root.appendChild(box);
      } else {
        var ul = el("ul");
        section.items.forEach(function (item) { ul.appendChild(inline(el("li"), item)); });
        root.appendChild(ul);
      }
    });

    heading(root, "Likely cause");
    root.appendChild(inline(el("p"), issue.cause));
    heading(root, "Suggested next steps");
    var steps = el("ul", "steps");
    issue.nextSteps.forEach(function (step) {
      var li = el("li");
      var box = el("input");
      box.type = "checkbox";
      box.style.width = "auto";
      li.appendChild(box);
      li.appendChild(inline(el("span"), step));
      steps.appendChild(li);
    });
    root.appendChild(steps);

    var details = el("details");
    details.appendChild(el("summary", "", "Evidence and limitations"));
    var ev = el("ul");
    issue.evidence.concat(issue.limitations).forEach(function (line) { ev.appendChild(inline(el("li"), line)); });
    details.appendChild(ev);
    root.appendChild(details);
    root.appendChild(el("p", "muted", issue.footer));
  }

  // Small, safe Markdown renderer for AI answers: headings, lists, code fences,
  // paragraphs. Everything becomes text nodes; no HTML is interpreted.
  function markdown(parent, text) {
    var lines = text.split("\n");
    var i = 0, list = null, para = [];
    function flush() {
      if (para.length) { parent.appendChild(inline(el("p"), para.join(" "))); para = []; }
    }
    while (i < lines.length) {
      var line = lines[i];
      var fence = /^\x60\x60\x60/.test(line);
      if (fence) {
        flush(); list = null;
        var pre = el("pre"), code = el("code");
        i++;
        while (i < lines.length && !/^\x60\x60\x60/.test(lines[i])) {
          var l = lines[i];
          code.appendChild(el("span", "ln" + (/^\+/.test(l) ? " own" : ""), l || " "));
          i++;
        }
        pre.appendChild(code); parent.appendChild(pre); i++; continue;
      }
      var h = /^#{1,6} (.*)$/.exec(line);
      var item = /^\s*(?:[-*]|\d+\.) (.*)$/.exec(line);
      if (h) { flush(); list = null; parent.appendChild(inline(el("h3"), h[1])); }
      else if (item) {
        flush();
        if (!list) { list = el(/^\s*\d+\./.test(line) ? "ol" : "ul"); parent.appendChild(list); }
        list.appendChild(inline(el("li"), item[1]));
      }
      else if (!line.trim()) { flush(); list = null; }
      else { list = null; para.push(line.trim()); }
      i++;
    }
    flush();
  }

  function render() { renderList(); renderDetail(); }

  function load() {
    return api("GET", "/api/state").then(function (data) {
      state.issues = data.issues;
      state.aiEnabled = data.aiEnabled === true;
      if (data.sourceRoot) { $("source").value = data.sourceRoot; $("sourceHint").textContent = "Using " + data.sourceRoot; }
      render();
    });
  }

  function added(entry) {
    state.issues.push(entry);
    state.selected = entry;
    render();
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  function updatePending() {
    var box = $("pending");
    box.hidden = !state.core && !state.binary;
    var parts = [];
    parts.push(state.core ? "Core dump: " + state.core.name : "Core dump: drop the core file");
    parts.push(state.binary ? "Binary: " + state.binary.name : "Binary: drop the program that crashed");
    $("pendingText").textContent = parts.join("  ·  ");
    $("analyzeCore").disabled = !(state.core && state.binary);
  }

  function uploadFiles(files) {
    if (!files.length) return;
    busy(true);
    var chain = Promise.resolve();
    Array.prototype.forEach.call(files, function (file) {
      chain = chain.then(function () {
        return api("PUT", "/api/upload?name=" + encodeURIComponent(file.name), file, true).then(function (data) {
          if (data.analyzed) added(data.analyzed);
          else if (data.upload.kind === "core") state.core = data.upload;
          else if (data.upload.kind === "binary") state.binary = data.upload;
          else toast(file.name + ": not a crash file crashlens can read.", true);
        }, function (err) { toast(file.name + ": " + err.message, true); });
      });
    });
    chain.then(function () { busy(false); updatePending(); });
  }

  $("analyze").addEventListener("click", function () {
    var text = $("text").value;
    if (!text.trim()) { toast("Paste a stack trace or log first.", true); return; }
    busy(true);
    api("POST", "/api/text", { text: text }).then(function (entry) { added(entry); $("text").value = ""; },
      function (err) { toast(err.message, true); }).then(function () { busy(false); });
  });

  $("analyzeCore").addEventListener("click", function () {
    busy(true);
    toast("Analyzing core dump… this can take a few seconds.");
    api("POST", "/api/core", { core: state.core.id, binary: state.binary.id, log: $("coreLog").value })
      .then(function (entry) { added(entry); state.core = null; $("coreLog").value = ""; updatePending(); },
        function (err) { toast(err.message, true); })
      .then(function () { busy(false); });
  });

  $("setSource").addEventListener("click", function () {
    api("POST", "/api/source", { path: $("source").value }).then(function (data) {
      $("sourceHint").textContent = data.sourceRoot ? "Using " + data.sourceRoot + " for new reports." : "Shows the failing lines and who last changed them.";
      toast(data.sourceRoot ? "Source folder set." : "Source folder cleared.");
    }, function (err) { toast(err.message, true); });
  });

  $("clear").addEventListener("click", function () {
    api("POST", "/api/clear").then(function () {
      state.issues = []; state.selected = null; state.core = null; state.binary = null;
      updatePending(); render();
      $("detail").textContent = "";
      $("detail").appendChild(el("p", "muted", "Cleared. Drop or paste a new crash."));
    });
  });

  var drop = $("drop");
  ["dragenter", "dragover"].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add("over"); });
  });
  ["dragleave", "drop"].forEach(function (type) {
    document.addEventListener(type, function (e) { e.preventDefault(); if (type === "drop" || e.target === document.documentElement) drop.classList.remove("over"); });
  });
  document.addEventListener("drop", function (e) { uploadFiles(e.dataTransfer.files); });
  $("files").addEventListener("change", function (e) { uploadFiles(e.target.files); e.target.value = ""; });

  if (!token) toast("Missing session token. Open the exact URL printed by crashlens serve.", true);
  else load().catch(function (err) { toast(err.message, true); });
})();
`;
