import { open, stat } from "node:fs/promises";

export type FileKind =
  | { readonly kind: "core" }
  | { readonly kind: "binary" }
  | { readonly kind: "text" }
  | { readonly kind: "other"; readonly reason: string };

/** Text files larger than this are not treated as failure logs. */
export const MAX_TEXT_BYTES = 8 * 1024 * 1024;
const ET_EXEC = 2;
const ET_DYN = 3;
const ET_CORE = 4;

/** Classify by content, never by name: ELF core, ELF executable, or small text. */
export async function detectFile(path: string): Promise<FileKind> {
  const handle = await open(path, "r");
  try {
    const head = Buffer.alloc(18);
    const { bytesRead } = await handle.read(head, 0, 18, 0);
    if (bytesRead >= 18 && head.readUInt32BE(0) === 0x7f454c46) {
      const type = head.readUInt16LE(16);
      if (type === ET_CORE) return { kind: "core" };
      if (type === ET_EXEC || type === ET_DYN) return { kind: "binary" };
      return { kind: "other", reason: "ELF file that is neither a core dump nor an executable" };
    }
    if ((await stat(path)).size > MAX_TEXT_BYTES)
      return { kind: "other", reason: "larger than 8 MiB and not a core dump" };
    if (head.subarray(0, bytesRead).includes(0))
      return { kind: "other", reason: "binary file that is not a core dump" };
    return { kind: "text" };
  } finally {
    await handle.close();
  }
}
