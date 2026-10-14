/**
 * Parser for the Linux NT_FILE core note (mapped files).
 *
 * REA preserves this note's descriptor bytes but does not interpret them, so
 * this package owns that interpretation. Layout for 64-bit cores:
 *   u64 count, u64 page_size, count * (u64 start, u64 end, u64 page_offset),
 *   then count NUL-terminated paths.
 */
export interface FileMapping {
  readonly start: bigint;
  readonly end: bigint;
  /** Byte offset into the file (page_offset * page_size). */
  readonly fileOffset: bigint;
  readonly path: string;
}

export type NtFileParse =
  | { readonly ok: true; readonly mappings: readonly FileMapping[] }
  | { readonly ok: false; readonly reason: string };

const HEADER_BYTES = 16;
const ENTRY_BYTES = 24;
/** A real process has far fewer mappings; this bounds allocation on bad input. */
const MAX_ENTRIES = 1 << 20;

export function parseNtFile(descriptor: Uint8Array): NtFileParse {
  if (descriptor.byteLength < HEADER_BYTES)
    return { ok: false, reason: "descriptor shorter than its header" };
  const view = new DataView(
    descriptor.buffer,
    descriptor.byteOffset,
    descriptor.byteLength,
  );
  const count = view.getBigUint64(0, true);
  const pageSize = view.getBigUint64(8, true);
  if (count > BigInt(MAX_ENTRIES))
    return { ok: false, reason: `implausible mapping count ${count}` };
  const entries = Number(count);
  const namesStart = HEADER_BYTES + entries * ENTRY_BYTES;
  if (namesStart > descriptor.byteLength)
    return { ok: false, reason: "mapping table extends past descriptor" };

  const names = new TextDecoder("utf-8", { fatal: false })
    .decode(descriptor.subarray(namesStart))
    .split("\0");
  if (names.length < entries)
    return { ok: false, reason: "fewer paths than mapping entries" };

  const mappings: FileMapping[] = [];
  for (let index = 0; index < entries; index++) {
    const base = HEADER_BYTES + index * ENTRY_BYTES;
    mappings.push({
      start: view.getBigUint64(base, true),
      end: view.getBigUint64(base + 8, true),
      fileOffset: view.getBigUint64(base + 16, true) * pageSize,
      path: names[index] ?? "",
    });
  }
  return { ok: true, mappings };
}
