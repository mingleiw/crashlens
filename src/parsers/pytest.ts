import { failure, frame, type FailureFrame, type ParsedFailure } from "../failure.js";
import { isOwnPythonFile } from "./python.js";

/** `____ test_name ____`: the start of one test's failure report. */
const TEST_HEADER = /^_{3,} (.+?) _{3,}$/;
/** `_ _ _ _`: between the frames of one failure. */
const FRAME_SEPARATOR = /^(?:_ ){4,}_?\s*$/;
/** `app.py:10: AttributeError` (long format) or `app.py:6: in normalize` (short format). */
const LOCATION = /^(\S[^:\n]*\.py):(\d+): ?(?:in (\S+))?.*$/;
/** `E       KeyError: 'db_url'` */
const ERROR_LINE = /^E\s+(.*)$/;
const EXCEPTION = /^([A-Za-z_][\w.]*(?:Error|Exception|Exit|Interrupt|Warning|Failed)|[A-Z][A-Za-z]+Error)(?:: ?(.*))?$/;
/** `order      = {'customerId': 'c-7'}`: a local variable printed by --showlocals. */
const LOCAL = /^([A-Za-z_]\w*)\s*= (.*)$/;

/**
 * A pytest failure report (`--tb=auto`, `long` or `short`), with the local
 * variables of each frame when it ran with `-l`/`--showlocals`. Only the
 * first failing test is read; frames are returned most recent first.
 */
export function parsePytest(text: string): ParsedFailure | null {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => TEST_HEADER.test(line));
  if (header === -1) return null;
  let end = lines.findIndex((line, i) => i > header && (TEST_HEADER.test(line) || /^={3,}/.test(line)));
  if (end === -1) end = lines.length;
  const section = lines.slice(header + 1, end);

  const blocks: string[][] = [[]];
  for (const line of section) {
    if (FRAME_SEPARATOR.test(line)) blocks.push([]);
    else (blocks[blocks.length - 1] as string[]).push(line);
  }

  // --tb=short prints every frame in one block, each starting with `file:line: in name`.
  const split = blocks.flatMap((block) => {
    const starts = block.flatMap((line, i) => (LOCATION.exec(line)?.[3] !== undefined ? [i] : []));
    if (starts.length < 2) return [block];
    return starts.map((start, n) => block.slice(n === 0 ? 0 : start, starts[n + 1] ?? block.length));
  });

  const frames: FailureFrame[] = [];
  let errorType: string | null = null;
  let message = "";
  for (const block of split) {
    const at = block.map((line) => LOCATION.exec(line)).find((m) => m !== null);
    if (at === undefined || at === null) continue;
    const file = at[1] as string;
    const name = at[3] ?? /^\s*(?:async\s+)?def (\w+)\(/m.exec(block.join("\n"))?.[1] ?? "?";
    const marked = block.find((line) => line.startsWith(">"));
    const short = block.indexOf(at[0]);
    const code = marked !== undefined ? marked.slice(1).trim() : (block[short + 1] ?? "").trim() || null;
    const locals: Record<string, string> = {};
    for (const line of block) {
      const local = LOCAL.exec(line);
      if (local !== null) locals[local[1] as string] = (local[2] as string).trim();
    }
    const errors = block.map((line) => ERROR_LINE.exec(line)?.[1]).filter((line): line is string => line !== undefined);
    if (errors.length > 0) {
      const first = errors.map((line) => EXCEPTION.exec(line.trim())).find((m) => m !== null);
      if (first !== undefined && first !== null) {
        errorType = first[1] as string;
        message = (first[2] ?? "").trim();
      } else if (errorType === null) {
        errorType = "AssertionError";
        message = (errors[0] as string).trim();
      }
    }
    frames.push(
      frame({
        function: name,
        file,
        line: Number(at[2]),
        own: isOwnPythonFile(file),
        code,
        ...(Object.keys(locals).length === 0 ? {} : { locals }),
      }),
    );
  }
  if (frames.length === 0 || errorType === null) return null;
  return failure({
    language: "python",
    header: "exception",
    errorType,
    message,
    frames: frames.reverse(),
    start: text.indexOf(lines[header] as string),
  });
}
