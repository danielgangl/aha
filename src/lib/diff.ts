import Prism from "prismjs";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import type {
  CopyBlock,
  DiffContent,
  DiffLine,
  DiffRowData,
  DiffSide,
  PackSymbol,
  SideAnchor,
  SignalRange,
} from "../types";
import { isContextSignal, isNoiseSignal } from "./pack";

export function configurePrism() {
  const ts = Prism.languages.typescript as Record<string, unknown> | undefined;
  if (!ts || ts["type-reference"]) return;

  Prism.languages.insertBefore("typescript", "keyword", {
    "declared-variable": {
      pattern: /(\b(?:const|let|var)\s+)[A-Za-z_$][\w$]*/,
      lookbehind: true,
    },
  });

  Prism.languages.insertBefore("typescript", "function", {
    "object-key": {
      pattern: /(^\s*)[A-Za-z_$][\w$]*(?=\s*:)/,
      lookbehind: true,
    },
    "property-access": {
      pattern: /(\.)[A-Za-z_$][\w$]*(?!(?:[\w$]|\s*\())/,
      lookbehind: true,
    },
    "type-reference": [
      {
        pattern: /(:\s*)[A-Z_$][\w$]*(?:\[\])?(?:<[^>\n]+>)?/,
        lookbehind: true,
      },
      {
        pattern: /(\bas\s+)[A-Z_$][\w$]*(?:\[\])?(?:<[^>\n]+>)?/,
        lookbehind: true,
      },
      {
        pattern: /(\b(?:type|interface)\s+)[A-Z_$][\w$]*/,
        lookbehind: true,
      },
    ],
  });
}

configurePrism();

export function callerLabel(symbol: PackSymbol | undefined) {
  const count = Array.isArray(symbol?.callers) ? symbol.callers.length : 0;
  return `${count} ${count === 1 ? "caller" : "callers"}`;
}

export function symbolKindForToken(symbol: PackSymbol | undefined) {
  if (symbol?.kind === "function" || symbol?.kind === "method") return "function";
  if (symbol?.kind === "class") return "class";
  return "symbol";
}

export function diffLineText(value: DiffContent | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value ?? "");
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") return part.label || "";
    return "";
  }).join("");
}

export function diffBlockAt(rows: DiffRowData[], index: number, side: DiffSide, filePath: string): CopyBlock | null {
  const line = rows[index]?.[side];
  if (!line || !["add", "del"].includes(line.k)) return null;
  let start = index;
  let end = index;
  while (start > 0 && rows[start - 1]?.[side]?.k === line.k) start -= 1;
  while (end + 1 < rows.length && rows[end + 1]?.[side]?.k === line.k) end += 1;
  const block = rows
    .slice(start, end + 1)
    .map((row) => `${line.k === "add" ? "+" : "-"}${diffLineText(row[side]?.c)}`)
    .join("\n");
  return {
    id: `${side}-${line.k}-${start}-${end}`,
    isStart: index === start,
    isEnd: index === end,
    text: `${filePath}:\n${block}`,
  };
}

export function copyBlockAttrs(block: CopyBlock | null | undefined, hoveredCopyBlock: string | null): Record<string, string | undefined> {
  if (!block || hoveredCopyBlock !== block.id) return {};
  return {
    "data-copy-block": "true",
    "data-copy-start": block.isStart ? "true" : undefined,
    "data-copy-end": block.isEnd ? "true" : undefined,
  };
}

export function contextRangeAttrs(
  line: DiffLine | null | undefined,
  ranges: SignalRange[] | undefined,
  side: DiffSide,
  filePath: string,
): Record<string, string | undefined> {
  const match = contextRangeMatch(line, ranges, side, filePath);
  if (!match) return {};
  return {
    "data-context-range": "true",
    "data-context-start": match.isStart ? "true" : undefined,
    "data-context-end": match.isEnd ? "true" : undefined,
  };
}

export function formatAnchorRange(anchor: SideAnchor | null | undefined, prefix: string): string {
  if (!anchor) return "";
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const range = start === end ? `${prefix}${start}` : `${prefix}${start}-${prefix}${end}`;
  return anchor.path ? `${anchor.path}:${range}` : range;
}

export function buildSideBySideRows(diff: DiffLine[]): DiffRowData[] {
  const rows: DiffRowData[] = [];
  let i = 0;
  while (i < diff.length) {
    const ln = diff[i];
    if (ln.k === "hunk") {
      rows.push({ kind: "hunk", line: ln });
      i += 1;
      continue;
    }

    if (ln.k === "ctx") {
      rows.push({ kind: "ctx", left: ln, right: ln });
      i += 1;
      continue;
    }

    if (ln.k === "del" || ln.k === "add") {
      const dels: DiffLine[] = [];
      const adds: DiffLine[] = [];
      while (i < diff.length && (diff[i].k === "del" || diff[i].k === "add")) {
        if (diff[i].k === "del") dels.push(diff[i]);
        if (diff[i].k === "add") adds.push(diff[i]);
        i += 1;
      }
      const max = Math.max(dels.length, adds.length);
      for (let j = 0; j < max; j += 1) {
        rows.push({ kind: "change", left: dels[j] || null, right: adds[j] || null });
      }
      continue;
    }

    rows.push({ kind: ln.k || "ctx", left: ln, right: ln });
    i += 1;
  }
  return rows;
}

export function signalForRow(row: DiffRowData, ranges: SignalRange[] | undefined, filePath: string): SignalRange | null {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  return ranges.find((range) => (
    isNoiseSignal(range) &&
    range.hideByDefault !== false &&
    (lineMatchesRange(row.left, range, "left", filePath) || lineMatchesRange(row.right, range, "right", filePath))
  )) || null;
}

export interface ContextMarker { signal: SignalRange; side: DiffSide; }

export function contextSignalMarkersForRow(row: DiffRowData, ranges: SignalRange[] | undefined, filePath: string): ContextMarker[] {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const markers: ContextMarker[] = [];
  for (const range of ranges) {
    if (!isContextSignal(range)) continue;
    if (lineStartsRange(row.left, range, "left", filePath)) markers.push({ signal: range, side: "left" });
    if (lineStartsRange(row.right, range, "right", filePath)) markers.push({ signal: range, side: "right" });
  }
  return markers;
}

interface RangeState { isStart: boolean; isEnd: boolean; }

export function contextRangeMatch(line: DiffLine | null | undefined, ranges: SignalRange[] | undefined, side: DiffSide, filePath: string): RangeState | null {
  if (!Array.isArray(ranges) || ranges.length === 0 || !line) return null;
  return ranges
    .filter(isContextSignal)
    .map((range) => lineRangeState(line, range, side, filePath))
    .find((state): state is RangeState => Boolean(state)) || null;
}

export function lineRangeState(line: DiffLine, range: SignalRange, side: DiffSide, filePath: string): RangeState | null {
  const anchor = range?.anchor?.[side];
  if (!anchor) return null;
  if (!anchorMatchesFile(anchor, filePath)) return null;
  const value = side === "left" ? line.L : line.R;
  if (value == null) return null;
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const min = Math.min(start, end);
  const max = Math.max(start, end);
  if (value < min || value > max) return null;
  return {
    isStart: value === start,
    isEnd: value === end,
  };
}

export function lineMatchesRange(line: DiffLine | null | undefined, range: SignalRange, side: DiffSide, filePath: string): boolean {
  if (!line) return false;
  const anchor = range?.anchor?.[side];
  if (!anchor) return false;
  if (!anchorMatchesFile(anchor, filePath)) return false;
  const value = side === "left" ? line.L : line.R;
  if (value == null) return false;
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return false;
  return value >= Math.min(start, end) && value <= Math.max(start, end);
}

export function lineStartsRange(line: DiffLine | null | undefined, range: SignalRange, side: DiffSide, filePath: string): boolean {
  if (!line) return false;
  const anchor = range?.anchor?.[side];
  if (!anchor) return false;
  if (!anchorMatchesFile(anchor, filePath)) return false;
  const value = side === "left" ? line.L : line.R;
  if (value == null) return false;
  const start = Number(anchor.start);
  return Number.isFinite(start) && value === start;
}

export function anchorMatchesFile(anchor: SideAnchor | null | undefined, filePath: string): boolean {
  return !anchor?.path || !filePath || anchor.path === filePath;
}

export function highlightCode(code: string, language: string): string {
  try {
    const grammar = Prism.languages[language] || Prism.languages.typescript;
    return Prism.highlight(code, grammar, language || "typescript");
  } catch {
    return escapeHtml(code);
  }
}

export function languageForPath(filePath: string | undefined): string {
  const lower = String(filePath || "").toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".ts")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) return "javascript";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".css")) return "css";
  if (lower.endsWith(".html") || lower.endsWith(".xml") || lower.endsWith(".svg")) return "markup";
  return "typescript";
}

export function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function plainDiffContent(content: DiffContent | undefined): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.label === "string") return part.label;
    return "";
  }).join("");
}
