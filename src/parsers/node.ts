import { failure, frame, lineStart, type FailureFrame, type ParsedFailure } from "../failure.js";

/** `TypeError: msg` or `Error [ERR_X]: msg`: the first line of an error. */
const HEADER_LINE = /^([A-Z][\w$]*)(?: \[([\w$]+)\])?: (.*)$/;
/** Error types, so a message line like `Expected: 5` is not taken for the error's first line. */
const ERROR_TYPE = /(?:Error|Exception|Failure)$/;
/** How far above its first frame an error's first line can be (multi-line messages, assertion diffs). */
const MAX_MESSAGE_LINES = 60;
/** `  [cause]: SyntaxError: msg`, in the properties Node prints after the stack. */
const CAUSE = /^\s*\[cause\]: ([A-Z][\w$]*)(?: \[([\w$]+)\])?: (.*)$/;
const FRAME_START = /^\s+at (?:async )?/;

/** Split a frame line without backtracking: `name (place)` or a bare place. */
function frameParts(line: string): RegExpExecArray | null {
  const start = FRAME_START.exec(line);
  if (start === null) return null;
  const rest = line.slice(start[0].length);
  const open = rest.indexOf(" (");
  const parts = (rest.endsWith(")") && open > 0 ? [rest, rest.slice(0, open), rest.slice(open + 2, -1), undefined] : [rest, undefined, undefined, rest]) as unknown as RegExpExecArray;
  return parts;
}
const PLACE = /^(.*):(\d+):(\d+)$/;
/** Node prints `file:line`, the source line and a caret above uncaught errors. */
const SOURCE_PREAMBLE = /^(\S.*):(\d+)\n(.*)\n *\^+ *\n\n$/;

export function parseNode(text: string): ParsedFailure | null {
  const lines = text.split("\n");
  const found = findError(lines);
  if (found === null) return null;
  const offsets: number[] = [];
  lines.reduce((offset, line) => (offsets.push(offset), offset + line.length + 1), 0);
  let start = offsets[found.header] as number;

  // Up to four lines above the header: "server.js:2", code, caret, blank.
  const above = text.slice(0, start);
  const preambleText = above.split("\n").slice(-5).join("\n");
  const preamble = SOURCE_PREAMBLE.exec(preambleText);
  if (preamble !== null) start = above.length - preambleText.length;

  const frames = framesFrom(lines, found.frames);
  // Attach the printed source line to the frame it belongs to.
  if (preamble !== null) {
    const index = frames.findIndex((f) => f.file === preamble[1] && f.line === Number(preamble[2]));
    const target = frames[index];
    if (target !== undefined) frames[index] = { ...target, code: (preamble[3] ?? "").trim() };
  }

  const head = HEADER_LINE.exec(lines[found.header] as string) as RegExpExecArray;
  const type = head[2] === undefined ? (head[1] as string) : `${head[1]} [${head[2]}]`;
  const message = [head[3] ?? "", ...lines.slice(found.header + 1, found.frames)].join("\n").trim();

  // `new Error("...", { cause })`: the deepest cause with a stack is where it started.
  for (let i = lines.length - 1; i > found.frames; i--) {
    const cause = CAUSE.exec(lines[i] as string);
    if (cause === null) continue;
    const causeFrames = framesFrom(lines, i + 1);
    if (causeFrames.length === 0) continue;
    return failure({
      language: "node",
      header: "exception",
      errorType: cause[2] === undefined ? (cause[1] as string) : `${cause[1]} [${cause[2]}]`,
      message: (cause[3] ?? "").trim(),
      frames: causeFrames,
      wrappedBy: [`${type}: ${message.split("\n")[0]}`],
      start,
    });
  }

  return failure({ language: "node", header: "exception", errorType: type, message, frames, start });
}

/**
 * The first stack in the output and the error line that heads it: the nearest
 * line above the first frame that names an error type, within
 * MAX_MESSAGE_LINES (a message can span lines), else the line directly above.
 */
function findError(lines: readonly string[]): { header: number; frames: number } | null {
  for (let i = 1; i < lines.length; i++) {
    if (frameParts(lines[i] as string) === null || frameParts(lines[i - 1] as string) !== null) continue;
    for (let j = i - 1; j >= Math.max(0, i - MAX_MESSAGE_LINES); j--) {
      const head = HEADER_LINE.exec(lines[j] as string);
      if (head !== null && (ERROR_TYPE.test(head[1] as string) || j === i - 1)) return { header: j, frames: i };
    }
  }
  return null;
}

function framesFrom(lines: readonly string[], from: number): FailureFrame[] {
  const frames: FailureFrame[] = [];
  for (const line of lines.slice(from)) {
    const match = frameParts(line);
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
  return frames;
}

function isOwnNodeFile(file: string): boolean {
  return !file.startsWith("node:") && !file.includes("/node_modules/") && !file.startsWith("internal/");
}
