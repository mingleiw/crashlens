import { open, type FileHandle } from "node:fs/promises";

/**
 * Small, bounded ELF64 little-endian readers for facts REA's CLI does not
 * expose: the GNU build ID (of a binary, and of the copy mapped in a core) and
 * function boundaries from .eh_frame_hdr, which survive `strip`. Files are only
 * read, at the offsets their headers name.
 */

export interface ProgramHeader {
  readonly type: number;
  readonly offset: bigint;
  readonly vaddr: bigint;
  readonly fileSize: bigint;
  readonly memSize: bigint;
}

export interface FunctionRange {
  /** Link-time start address. */
  readonly start: bigint;
  /** Exclusive end, when the FDE's range could be decoded. */
  readonly end: bigint | null;
}

const PT_LOAD = 1;
const PT_NOTE = 4;
const PT_GNU_EH_FRAME = 0x6474e550;
const NT_GNU_BUILD_ID = 3;
const MAX_PHDRS = 4096;
const MAX_NOTE_BYTES = 1 << 20;
const MAX_FDES = 1 << 20;

async function readAt(file: FileHandle, offset: bigint, length: number): Promise<Buffer> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await file.read(buffer, 0, length, Number(offset));
  return buffer.subarray(0, bytesRead);
}

/** e_type and program headers, or null if this is not ELF64 little-endian. */
async function readHeaders(file: FileHandle): Promise<{ type: number; phdrs: ProgramHeader[] } | null> {
  const header = await readAt(file, 0n, 64);
  if (header.length < 64 || header.readUInt32BE(0) !== 0x7f454c46 || header[4] !== 2 || header[5] !== 1) return null;
  const type = header.readUInt16LE(16);
  const phoff = header.readBigUInt64LE(32);
  const phentsize = header.readUInt16LE(54);
  const phnum = header.readUInt16LE(56);
  if (phentsize < 56 || phnum > MAX_PHDRS) return null;
  const table = await readAt(file, phoff, phentsize * phnum);
  const phdrs: ProgramHeader[] = [];
  for (let i = 0; i + 1 <= phnum && (i + 1) * phentsize <= table.length; i++) {
    const base = i * phentsize;
    phdrs.push({
      type: table.readUInt32LE(base),
      offset: table.readBigUInt64LE(base + 8),
      vaddr: table.readBigUInt64LE(base + 16),
      fileSize: table.readBigUInt64LE(base + 32),
      memSize: table.readBigUInt64LE(base + 40),
    });
  }
  return { type, phdrs };
}

/** The GNU build ID from note bytes, as lowercase hex. */
function buildIdFromNotes(notes: Buffer): string | null {
  let pos = 0;
  while (pos + 12 <= notes.length) {
    const nameSize = notes.readUInt32LE(pos);
    const descSize = notes.readUInt32LE(pos + 4);
    const type = notes.readUInt32LE(pos + 8);
    const nameStart = pos + 12;
    const descStart = nameStart + ((nameSize + 3) & ~3);
    const next = descStart + ((descSize + 3) & ~3);
    if (descStart + descSize > notes.length) return null;
    const name = notes.subarray(nameStart, nameStart + nameSize).toString("latin1");
    if (type === NT_GNU_BUILD_ID && name === "GNU\0") return notes.subarray(descStart, descStart + descSize).toString("hex");
    pos = next;
  }
  return null;
}

/** True for position-independent images (ET_DYN), which Ghidra loads at 0x100000. */
export async function isPositionIndependent(path: string): Promise<boolean> {
  const file = await open(path, "r");
  try {
    return (await readHeaders(file))?.type === 3;
  } finally {
    await file.close();
  }
}

/** Build ID of an executable or library on disk. */
export async function binaryBuildId(path: string): Promise<string | null> {
  const file = await open(path, "r");
  try {
    const headers = await readHeaders(file);
    if (headers === null) return null;
    for (const ph of headers.phdrs) {
      if (ph.type !== PT_NOTE || ph.fileSize > BigInt(MAX_NOTE_BYTES)) continue;
      const id = buildIdFromNotes(await readAt(file, ph.offset, Number(ph.fileSize)));
      if (id !== null) return id;
    }
    return null;
  } finally {
    await file.close();
  }
}

/** Map a runtime address to bytes recorded in the core, if that memory was dumped. */
async function readCoreMemory(file: FileHandle, loads: readonly ProgramHeader[], address: bigint, length: number): Promise<Buffer | null> {
  const segment = loads.find((ph) => address >= ph.vaddr && address + BigInt(length) <= ph.vaddr + ph.fileSize);
  if (segment === undefined) return null;
  const bytes = await readAt(file, segment.offset + (address - segment.vaddr), length);
  return bytes.length === length ? bytes : null;
}

/**
 * Build ID of the image mapped at `imageBase` in the crashed process, read from
 * the core's copy of its ELF headers. Linux dumps the first page of each
 * mapped ELF file by default (coredump_filter bit 4), which is where the note
 * usually lives. Returns null when that memory was not recorded.
 */
export async function coreImageBuildId(corePath: string, imageBase: bigint): Promise<string | null> {
  const file = await open(corePath, "r");
  try {
    const headers = await readHeaders(file);
    if (headers === null || headers.type !== 4) return null;
    const loads = headers.phdrs.filter((ph) => ph.type === PT_LOAD);
    const ehdr = await readCoreMemory(file, loads, imageBase, 64);
    if (ehdr === null || ehdr.readUInt32BE(0) !== 0x7f454c46) return null;
    const phoff = ehdr.readBigUInt64LE(32);
    const phentsize = ehdr.readUInt16LE(54);
    const phnum = ehdr.readUInt16LE(56);
    if (phentsize < 56 || phnum > MAX_PHDRS) return null;
    const table = await readCoreMemory(file, loads, imageBase + phoff, phentsize * phnum);
    if (table === null) return null;
    // The first PT_LOAD of the image gives its link-time base (0 for PIE).
    let linkBase: bigint | null = null;
    const notes: { vaddr: bigint; size: number }[] = [];
    for (let i = 0; i < phnum; i++) {
      const base = i * phentsize;
      const type = table.readUInt32LE(base);
      const vaddr = table.readBigUInt64LE(base + 16);
      const size = table.readBigUInt64LE(base + 32);
      if (type === PT_LOAD && linkBase === null) linkBase = vaddr & ~0xfffn;
      if (type === PT_NOTE && size <= BigInt(MAX_NOTE_BYTES)) notes.push({ vaddr, size: Number(size) });
    }
    if (linkBase === null) return null;
    for (const note of notes) {
      const bytes = await readCoreMemory(file, loads, imageBase + (note.vaddr - linkBase), note.size);
      const id = bytes === null ? null : buildIdFromNotes(bytes);
      if (id !== null) return id;
    }
    return null;
  } finally {
    await file.close();
  }
}

/** Decode a DWARF EH pointer of the encodings compilers emit for x86-64 tables. */
function readEncoded(buf: Buffer, pos: number, encoding: number, fieldAddress: bigint, dataRel: bigint): { value: bigint; size: number } | null {
  const format = encoding & 0x0f;
  const application = encoding & 0x70;
  let value: bigint;
  let size: number;
  switch (format) {
    case 0x03: value = BigInt(buf.readUInt32LE(pos)); size = 4; break; // udata4
    case 0x0b: value = BigInt(buf.readInt32LE(pos)); size = 4; break; // sdata4
    case 0x04: value = buf.readBigUInt64LE(pos); size = 8; break; // udata8
    case 0x0c: value = buf.readBigInt64LE(pos); size = 8; break; // sdata8
    default: return null;
  }
  if (application === 0x10) value += fieldAddress; // pcrel
  else if (application === 0x30) value += dataRel; // datarel
  else if (application !== 0x00) return null;
  return { value: BigInt.asUintN(64, value), size };
}

/**
 * Function start (and, when decodable, end) addresses from .eh_frame_hdr's
 * sorted lookup table. Present in stripped binaries because unwinding needs it.
 */
export async function functionRanges(path: string): Promise<FunctionRange[]> {
  const file = await open(path, "r");
  try {
    const headers = await readHeaders(file);
    if (headers === null) return [];
    const hdrPh = headers.phdrs.find((ph) => ph.type === PT_GNU_EH_FRAME);
    if (hdrPh === undefined || hdrPh.fileSize < 12n || hdrPh.fileSize > BigInt(64 << 20)) return [];
    const hdr = await readAt(file, hdrPh.offset, Number(hdrPh.fileSize));
    const [version, framePtrEnc, countEnc, tableEnc] = [hdr[0], hdr[1], hdr[2], hdr[3]];
    if (version !== 1 || framePtrEnc === undefined || countEnc === undefined || tableEnc === undefined) return [];
    const hdrAddr = hdrPh.vaddr;
    const framePtr = readEncoded(hdr, 4, framePtrEnc, hdrAddr + 4n, hdrAddr);
    if (framePtr === null) return [];
    let pos = 4 + framePtr.size;
    const count = readEncoded(hdr, pos, countEnc, hdrAddr + BigInt(pos), hdrAddr);
    if (count === null || count.value > BigInt(MAX_FDES)) return [];
    pos += count.size;
    const fieldSize = (tableEnc & 0x0f) === 0x0b || (tableEnc & 0x0f) === 0x03 ? 4 : 8;
    const entries: { start: bigint; fde: bigint }[] = [];
    for (let i = 0n; i < count.value && pos + 2 * fieldSize <= hdr.length; i++) {
      const start = readEncoded(hdr, pos, tableEnc, hdrAddr + BigInt(pos), hdrAddr);
      const fde = readEncoded(hdr, pos + fieldSize, tableEnc, hdrAddr + BigInt(pos + fieldSize), hdrAddr);
      if (start === null || fde === null) return [];
      entries.push({ start: start.value, fde: fde.value });
      pos += 2 * fieldSize;
    }
    // FDE pc_range: GCC/Clang use pcrel|sdata4 for pc_begin; pc_range shares its format.
    const toOffset = (address: bigint) => {
      const seg = headers.phdrs.find((ph) => ph.type === PT_LOAD && address >= ph.vaddr && address < ph.vaddr + ph.fileSize);
      return seg === undefined ? null : seg.offset + (address - seg.vaddr);
    };
    const ranges: FunctionRange[] = [];
    for (const entry of entries) {
      let end: bigint | null = null;
      const offset = toOffset(entry.fde);
      if (offset !== null) {
        const fde = await readAt(file, offset, 16);
        if (fde.length === 16 && fde.readUInt32LE(0) !== 0xffffffff) {
          const begin = entry.fde + 8n + BigInt(fde.readInt32LE(8));
          if (BigInt.asUintN(64, begin) === entry.start) end = entry.start + BigInt(fde.readUInt32LE(12));
        }
      }
      ranges.push({ start: entry.start, end });
    }
    return ranges.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  } finally {
    await file.close();
  }
}

/** The range containing a link-time address. */
export function rangeFor(ranges: readonly FunctionRange[], linked: bigint): FunctionRange | null {
  let lo = 0;
  let hi = ranges.length - 1;
  let best: FunctionRange | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const range = ranges[mid] as FunctionRange;
    if (range.start <= linked) { best = range; lo = mid + 1; } else hi = mid - 1;
  }
  if (best === null) return null;
  if (best.end !== null) return linked < best.end ? best : null;
  return best;
}
