
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
