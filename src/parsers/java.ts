import { failure, frame, lineStart, type FailureFrame, type ParsedFailure } from "../failure.js";

/** A throwable line followed by at least one `at` frame. */
const HEADER =
  /^(?:Exception in thread "([^"]*)" )?([a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)+)(?:: (.*))?\n\s+at /m;
const CAUSED_BY = /^Caused by: ([a-zA-Z_$][\w$.]*)(?:: (.*))?$/;
/** `at module@version/com.pkg.Class.method(File.java:12)` */
const FRAME = /^\s+at (?:[\w.-]+(?:@[\w.-]+)?\/)?([\w$.<>/-]+)\(([^)]*)\)$/;
const MORE = /^\s+\.\.\. (\d+) more$/;

interface Block {
  readonly type: string;
  readonly message: string;
  readonly frames: FailureFrame[];
}

const LIBRARY_PACKAGES =
  /^(java|javax|jdk|sun|com\.sun|kotlin|kotlinx|scala|org\.junit|org\.springframework|org\.apache|org\.hibernate|io\.netty|com\.fasterxml|reactor|okhttp3|com\.google\.common)\./;

/**
 * Reports the deepest "Caused by", which is where the problem started, and
 * lists the outer exceptions as wrappers. Frames elided with "... N more" are
 * restored from the enclosing exception's stack.
 */
export function parseJava(text: string): ParsedFailure | null {
  const header = HEADER.exec(text);
  if (header === null) return null;
  const start = lineStart(text, header.index);
  const lines = text.slice(header.index).split("\n");

  const blocks: Block[] = [
    { type: header[2] ?? "", message: header[3] ?? "", frames: [] },
  ];
  for (const line of lines.slice(1)) {
    const current = blocks[blocks.length - 1] as Block;
    const at = FRAME.exec(line);
    if (at !== null) {
      current.frames.push(javaFrame(at[1] ?? "", at[2] ?? ""));
      continue;
    }
    const more = MORE.exec(line);
    if (more !== null) {
      const outer = blocks[blocks.length - 2];
      if (outer !== undefined) current.frames.push(...outer.frames.slice(-Number(more[1])));
      continue;
    }
    const cause = CAUSED_BY.exec(line);
    if (cause !== null) {
      blocks.push({ type: cause[1] ?? "", message: cause[2] ?? "", frames: [] });
      continue;
    }
    // "Suppressed:" sections and their frames are indented; anything else ends the trace.
    if (!/^\s/.test(line)) break;
  }

  const root = blocks[blocks.length - 1] as Block;
  return failure({
    language: "java",
    header: "exception",
    errorType: root.type,
    message: root.message,
    context: header[1] === undefined ? null : `thread "${header[1]}"`,
    frames: root.frames,
    wrappedBy: blocks
      .slice(0, -1)
      .reverse()
      .map((block) => `${simpleName(block.type)}${block.message === "" ? "" : `: ${block.message}`}`),
    start,
  });
}

function javaFrame(method: string, place: string): FailureFrame {
  const location = /^(.+?):(\d+)$/.exec(place);
  return frame({
    function: method,
    file: location?.[1] ?? null,
    line: location ? Number(location[2]) : null,
    own: !LIBRARY_PACKAGES.test(method),
  });
}

function simpleName(type: string): string {
  return type.slice(type.lastIndexOf(".") + 1);
}
