import { failure, frame, type FailureFrame, type ParsedFailure } from "../failure.js";

const BANNER = "Traceback (most recent call last):";
const FRAME = /^ {2}File "(.+)", line (\d+), in (.+)$/;
const EXCEPTION = /^([A-Za-z_][\w.]*)(?:: ?(.*))?$/;
/** Lines Python 3.11+ prints under code to point at the failing expression. */
const MARKERS = /^\s*[~^\s]+$/;
const DIRECT_CAUSE = "The above exception was the direct cause of the following exception:";

interface Block {
  readonly frames: FailureFrame[];
  readonly type: string;
  readonly message: string;
}

/**
 * Python tracebacks list the most recent call last; frames are returned most
 * recent first like every other parser. For chained exceptions, `raise X from
 * e` makes the earlier exception the root cause, so that one is reported and
 * the outer ones are listed as wrappers. "During handling of the above
 * exception, another exception occurred" means the later one is a new bug, so
 * the chain stops there.
 */
export function parsePython(text: string): ParsedFailure | null {
  const start = text.indexOf(BANNER);
  if (start === -1) return null;
  const lines = text.slice(start).split("\n");

  const blocks: Block[] = [];
  const directCause: boolean[] = [];
  let index = 0;
  while (index < lines.length) {
    if (lines[index] !== BANNER) {
      if ((lines[index] ?? "").trim() === DIRECT_CAUSE) directCause[blocks.length] = true;
      index++;
      continue;
    }
    index++;
    const frames: FailureFrame[] = [];
    while (index < lines.length) {
      const match = FRAME.exec(lines[index] ?? "");
      if (match === null) {
        const line = lines[index] ?? "";
        if (line.startsWith("  ") || MARKERS.test(line)) {
          index++;
          continue;
        }
        break;
      }
      const next = lines[index + 1] ?? "";
      const code = next.startsWith("    ") && !MARKERS.test(next) ? next.trim() : null;
      const file = match[1] ?? "";
      frames.push(
        frame({
          function: match[3] ?? "?",
          file,
          line: Number(match[2]),
          own: isOwnPythonFile(file),
          code,
        }),
      );
      index += code === null ? 1 : 2;
    }
    const exception = EXCEPTION.exec(lines[index] ?? "");
    if (exception === null) break;
    blocks.push({
      frames: frames.reverse(),
      type: exception[1] ?? "Exception",
      message: exception[2] ?? "",
    });
    index++;
  }
  if (blocks.length === 0) return null;

  let chosen = blocks.length - 1;
  while (chosen > 0 && directCause[chosen] === true) chosen--;
  const root = blocks[chosen] as Block;
  return failure({
    language: "python",
    header: "exception",
    errorType: root.type,
    message: root.message,
    frames: root.frames,
    wrappedBy: blocks
      .slice(chosen + 1)
      .map((block) => (block.message === "" ? block.type : `${block.type}: ${block.message}`))
      .reverse(),
    start,
  });
}

function isOwnPythonFile(file: string): boolean {
  return !/(site-packages|dist-packages|\/lib\/python\d|^<frozen|^<string>)/.test(file);
}
