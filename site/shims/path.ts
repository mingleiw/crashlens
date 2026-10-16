/** Browser stand-in for node:path basename (POSIX semantics, like crashlens on Linux). */
export function basename(path: string): string {
  const trimmed = path.replace(/\/+$/, "");
  return trimmed.slice(trimmed.lastIndexOf("/") + 1);
}
