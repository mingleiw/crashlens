import { basename } from "node:path";
import { rangeFor, type FunctionRange } from "./elf.js";
import type { FileMapping } from "./ntFile.js";
import type { BinaryLayout, LayoutSymbol } from "./rea.js";

const PAGE_MASK = ~0xfffn;

/** Where a runtime address falls, as precisely as the evidence allows. */
export type Location =
  | {
      readonly kind: "binary-function";
      readonly module: string;
      readonly moduleOffset: bigint;
      readonly symbol: LayoutSymbol;
      readonly symbolOffset: bigint;
    }
  | {
      readonly kind: "binary";
      readonly module: string;
      readonly moduleOffset: bigint;
    }
  | {
      readonly kind: "other-module";
      readonly module: string;
      /** Offset from the module's lowest recorded mapping; not a file offset. */
      readonly moduleOffset: bigint;
    }
  | { readonly kind: "unmapped" }
  /** No address to look up (e.g. an inlined frame). */
  | { readonly kind: "unknown" };

export interface Symbolizer {
  /** Load bias of the analyzed binary in the crashed process, if established. */
  readonly loadBias: bigint | null;
  readonly binaryFoundInCore: boolean;
  /** Runtime address where the binary's first page is mapped, if found. */
  readonly imageBase: bigint | null;
  locate(address: bigint): Location;
}

/**
 * Build a symbolizer from the core's mapped files and the binary's layout.
 * The binary is matched to core mappings by file name only; content identity
 * is not verified here.
 */
export function createSymbolizer(
  binaryPath: string,
  mappings: readonly FileMapping[],
  layout: BinaryLayout,
  /** Function boundaries from .eh_frame, used when the symbol table has no entry. */
  unwindRanges: readonly FunctionRange[] = [],
  /** Mapped file name of the binary in the core, when it differs from the local name (matched by build ID). */
  mappedName: string = basename(binaryPath),
): Symbolizer {
  const name = mappedName;
  const own = mappings.filter((mapping) => basename(mapping.path) === name);
  const loadBias = computeLoadBias(own, layout);
  const moduleBase = new Map<string, bigint>();
  for (const mapping of mappings) {
    const current = moduleBase.get(mapping.path);
    if (current === undefined || mapping.start < current)
      moduleBase.set(mapping.path, mapping.start);
  }

  return {
    loadBias,
    binaryFoundInCore: own.length > 0,
    imageBase: own.filter((m) => m.fileOffset === 0n).reduce<bigint | null>((min, m) => (min === null || m.start < min ? m.start : min), null),
    locate(address) {
      const mapping = mappings.find(
        (entry) => address >= entry.start && address < entry.end,
      );
      if (mapping === undefined) return { kind: "unmapped" };
      const module = basename(mapping.path);
      if (module !== name || loadBias === null)
        return {
          kind: "other-module",
          module,
          moduleOffset:
            address - (moduleBase.get(mapping.path) ?? mapping.start),
        };
      const linked = address - loadBias;
      const symbol = layout.functions.find(
        (entry) =>
          linked >= entry.value &&
          (linked < entry.value + entry.size ||
            (entry.size === 0n && linked === entry.value)),
      );
      const range = symbol === undefined ? rangeFor(unwindRanges, linked) : null;
      const found: LayoutSymbol | undefined =
        symbol ??
        (range === null
          ? undefined
          : { name: `sub_${range.start.toString(16)}`, value: range.start, size: range.end === null ? 0n : range.end - range.start, origin: "eh_frame" });
      return found === undefined
        ? { kind: "binary", module, moduleOffset: linked }
        : {
            kind: "binary-function",
            module,
            moduleOffset: linked,
            symbol: found,
            symbolOffset: linked - found.value,
          };
    },
  };
}

/**
 * Bias = runtime address - linked address. Derived from any mapping of the
 * binary and the PT_LOAD segment that covers the mapping's file offset.
 */
function computeLoadBias(
  own: readonly FileMapping[],
  layout: BinaryLayout,
): bigint | null {
  for (const mapping of own) {
    const segment = layout.loadSegments
      .filter((entry) => (entry.offset & PAGE_MASK) <= mapping.fileOffset)
      .sort((a, b) => (a.offset < b.offset ? 1 : -1))[0];
    if (segment === undefined) continue;
    const linkedPage =
      (segment.virtualAddress & PAGE_MASK) +
      (mapping.fileOffset - (segment.offset & PAGE_MASK));
    return mapping.start - linkedPage;
  }
  return null;
}

export function formatLocation(location: Location): string {
  switch (location.kind) {
    case "binary-function":
      return `${location.symbol.name}+${hex(location.symbolOffset)} (${location.module}+${hex(location.moduleOffset)})`;
    case "binary":
    case "other-module":
      return `${location.module}+${hex(location.moduleOffset)}`;
    case "unmapped":
      return "unmapped memory";
    case "unknown":
      return "unknown address";
  }
}

export const hex = (value: bigint): string => `0x${value.toString(16)}`;
