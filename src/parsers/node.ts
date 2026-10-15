import { failure, frame, lineStart, type FailureFrame, type ParsedFailure } from "../failure.js";

/** `TypeError: msg` or `Error [ERR_X]: msg`, directly followed by a stack frame. */
const HEADER = /^([A-Z][\w$]*)(?: \[([\w$]+)\])?: (.*)\n\s+at /m;
/** `at fn (file:1:2)`, `at file:1:2`, `at async fn (file:1:2)`, `at Array.map (<anonymous>)` */
const FRAME = /^\s+at (?:async )?(?:(.+?) \((.*)\)|(.*))$/;
const PLACE = /^(.*):(\d+):(\d+)$/;
/** Node prints `file:line`, the source line and a caret above uncaught errors. */
const SOURCE_PREAMBLE = /^(\S.*):(\d+)\n(.*)\n *\^+ *\n\n$/;

export function parseNode(text: string): ParsedFailure | null {
  const header = HEADER.exec(text);
  if (header === null) return null;
  let start = lineStart(text, header.index);

  // Up to four lines above the header: "server.js:2", code, caret, blank.
  const above = text.slice(0, start);
  const lines = above.split("\n");
  const preambleText = lines.slice(-5).join("\n");
  const preamble = SOURCE_PREAMBLE.exec(preambleText);
  if (preamble !== null) start = above.length - preambleText.length;

  const frames: FailureFrame[] = [];
  for (const line of text.slice(header.index).split("\n").slice(1)) {
    const match = FRAME.exec(line);
    if (match === null) break;
    const name = match[1] ?? null;
    const place = PLACE.exec(match[2] ?? match[3] ?? "");
    const file = place?.[1] ?? null;
    frames.push(
      frame({
        function: name ?? "<anonymous>",
        file,
        line: place ? Number(place[2]) : null,
        column: place ? Number(place[3]) : null,
        own: file !== null && isOwnNodeFile(file),
      }),
    );
  }

  // Attach the printed source line to the frame it belongs to.
  if (preamble !== null) {
    const index = frames.findIndex(
      (f) => f.file === preamble[1] && f.line === Number(preamble[2]),
    );
    const target = frames[index];
    if (target !== undefined) frames[index] = { ...target, code: (preamble[3] ?? "").trim() };
  }

  return failure({
    language: "node",
    header: "exception",
    errorType: header[2] === undefined ? (header[1] ?? "Error") : `${header[1]} [${header[2]}]`,
    message: header[3] ?? "",
    frames,
    start,
  });
}

function isOwnNodeFile(file: string): boolean {
  return !file.startsWith("node:") && !file.includes("/node_modules/") && !file.startsWith("internal/");
}
