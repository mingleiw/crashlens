// Demo mode for the static site: stands in for `crashlens serve`'s HTTP API
// inside the browser, so the real UI (app.js) runs unchanged. Pasted text and
// dropped logs are analyzed locally by crashlens.js; nothing is uploaded.
"use strict";
(function () {
  try { sessionStorage.setItem("crashlens-token", "demo"); } catch (e) { /* app falls back to the hash */ }
  if (!/token=/.test(location.hash)) history.replaceState(null, "", "#token=demo");

  var preloaded = [];
  var session = [];
  var ready = fetch("demo-data.json").then(function (r) { return r.json(); }).then(function (data) { preloaded = data.issues; });
  var counter = 0;

  function json(status, body) {
    return new Response(JSON.stringify(body), { status: status, headers: { "Content-Type": "application/json" } });
  }
  function entry(name, result) {
    counter += 1;
    return { id: "demo-" + counter, name: name, at: new Date().toISOString(), issue: result.issue, markdown: result.markdown };
  }
  function analyzeText(name, text) {
    var result = window.crashlens.analyze(text, name);
    if (!result.ok) return { error: result.message };
    var e = entry(name, result);
    session.push(e);
    return { entry: e };
  }
  var LOCAL_ONLY = " This works in the local app: see the install steps on GitHub.";

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = new URL(typeof input === "string" ? input : input.url, location.href);
    if (url.origin !== location.origin || url.pathname.indexOf("/api/") === -1) return realFetch(input, init);
    var method = (init && init.method) || "GET";
    var route = method + " " + url.pathname.slice(url.pathname.indexOf("/api/"));
    return ready.then(function () {
      switch (route) {
        case "GET /api/state":
          return json(200, { sourceRoot: null, aiEnabled: false, issues: preloaded.concat(session), uploads: [] });
        case "POST /api/text": {
          var body = JSON.parse(init.body);
          var pasted = analyzeText(body.name || "pasted text", body.text || "");
          return pasted.error ? json(422, { error: pasted.error }) : json(200, pasted.entry);
        }
        case "PUT /api/upload": {
          var file = init.body;
          var name = url.searchParams.get("name") || "upload";
          return file.slice(0, 4).arrayBuffer().then(function (head) {
            var b = new Uint8Array(head);
            if (b[0] === 0x7f && b[1] === 0x45 && b[2] === 0x4c && b[3] === 0x46)
              return json(422, { error: "this is a core dump or binary. Core dumps are analyzed by REA on your own machine." + LOCAL_ONLY });
            if (file.size > 8 * 1024 * 1024) return json(413, { error: "larger than 8 MiB." });
            return file.text().then(function (text) {
              var dropped = analyzeText(name, text);
              if (dropped.error) return json(422, { error: dropped.error });
              // Same shape as the local server: the upload, plus its analysis for text files.
              return json(200, { upload: { id: dropped.entry.id, name: name, size: file.size, kind: "text" }, analyzed: dropped.entry });
            });
          });
        }
        case "POST /api/source":
          return json(400, { error: "Reading your source code needs files on disk." + LOCAL_ONLY });
        case "POST /api/core":
        case "POST /api/ai":
          return json(400, { error: "Not available in the demo." + LOCAL_ONLY });
        case "POST /api/clear":
          preloaded = [];
          session = [];
          return json(200, {});
        default:
          return json(404, { error: "Not found." });
      }
    });
  };
})();
