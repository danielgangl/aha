import React, { useState, useEffect, useRef, useCallback, useMemo } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import Prism from "prismjs";
import "prismjs/components/prism-javascript.js";
import "prismjs/components/prism-jsx.js";
import "prismjs/components/prism-typescript.js";
import "prismjs/components/prism-tsx.js";
import "prismjs/components/prism-json.js";
import { DecisionCard } from "./decisions.js";
import {
  fillAhaWorkflowPrompt,
  ahaCommand,
  AHA_CODE_CONTEXT_PROMPT,
  AHA_FRAGMENT_LIST,
  AHA_FULL_WORKFLOW_INIT_PROMPT,
  AHA_FULL_WORKFLOW_UPDATE_PROMPT,
  AHA_LOCAL_CLI_FALLBACK,
  AHA_REVIEW_JUDGMENT_PROMPT,
  AHA_REVIEW_SIGNALS_PROMPT,
  AHA_UPDATE_REPAIR_PROMPT,
} from "./prompts.js";
import type {
  CanonicalFileId,
  CodeView,
  CodeViewGroup,
  CopyBlock,
  Decisions,
  DiffContent,
  DiffLine,
  DiffRowData,
  FileNote,
  FileSignal,
  Overview,
  PackFile,
  PackSymbol,
  Pr,
  PersistedReviewState,
  ReadingOrder,
  RangeAnchor,
  Relevance,
  ReviewSignalPattern,
  ReviewSignals,
  ReviewState,
  RichPart,
  RichRef,
  RichText as RichTextValue,
  Runtime,
  SideAnchor,
  SignalRange,
  SignalScope,
  SymbolCaller,
  SymbolMap,
  SystemMap,
  TreeNode,
  TriageStatus,
  ViewedFileEntry,
} from "./types";
import "./styles/global.css";

// v2/app.jsx — file-based PR reader.
// Single document scroll. Each file: header → tiny "what this file does"
// note → diff with inline AI margin notes. Clicking any symbol opens the
// right-rail call-sites panel.

configurePrism();

type DiffSide = "left" | "right";

const DEFAULT_RUNTIME: Runtime = {
  ahaCli: AHA_LOCAL_CLI_FALLBACK,
};

function configurePrism() {
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

type SymbolHandler = (id: string) => void;
type FileJumpHandler = (fileId: string, line?: number) => void;

// ── Diff line renderer ─────────────────────────────────────────
function callerLabel(symbol: PackSymbol | undefined) {
  const count = Array.isArray(symbol?.callers) ? symbol.callers.length : 0;
  return `${count} ${count === 1 ? "caller" : "callers"}`;
}

function CodeChunks({
  c,
  language,
  onSymbol,
  activeSym,
  symbols,
}: {
  c: DiffContent;
  language: string;
  onSymbol: SymbolHandler;
  activeSym: string | null;
  symbols: SymbolMap | undefined;
}) {
  const ch = (c: DiffContent): ReactNode => {
    if (typeof c === "string") return <HighlightedCode code={c} language={language} />;
    if (Array.isArray(c)) {
      return c.map((part, i) => {
        if (typeof part === "string") return <HighlightedCode key={i} code={part} language={language} />;
        if (part && (part.__sym || part.type === "symbol")) {
          const symbol = symbols?.[part.id];
          const callLabel = callerLabel(symbol);
          return (
            <span
              key={i}
              className="sym"
              data-active={activeSym === part.id}
              data-callers={callLabel}
              data-kind={symbolKindForToken(symbol)}
              onClick={(e) => { e.stopPropagation(); onSymbol(part.id); }}
              title={`${callLabel} · show call sites for ${part.label}`}
            >
              {part.label}
            </span>
          );
        }
        return null;
      });
    }
    return c;
  };

  return ch(c);
}

function symbolKindForToken(symbol: PackSymbol | undefined) {
  if (symbol?.kind === "function" || symbol?.kind === "method") return "function";
  if (symbol?.kind === "class") return "class";
  return "symbol";
}

function DiffCell({
  ln,
  side,
  language,
  onSymbol,
  activeSym,
  symbols,
  copyBlock,
  copyVisible,
  setOutlinedCopyBlock,
}: {
  ln: DiffLine | null | undefined;
  side: DiffSide;
  language: string;
  onSymbol: SymbolHandler;
  activeSym: string | null;
  symbols: SymbolMap | undefined;
  copyBlock: CopyBlock | null;
  copyVisible: boolean;
  setOutlinedCopyBlock: (id: string | null) => void;
}) {
  if (!ln) {
    return (
      <>
        <span className="ln" />
        <span className="code empty" />
      </>
    );
  }
  const canCopy = ln.k === "add" || ln.k === "del";

  return (
    <>
      <span className="ln">{side === "left" ? ln.L ?? "" : ln.R ?? ""}</span>
      <span className="code">
        <span className="sig">{ln.k === "add" ? "+" : ln.k === "del" ? "−" : " "}</span>
        <CodeChunks c={ln.c} language={language} onSymbol={onSymbol} activeSym={activeSym} symbols={symbols} />
        {canCopy && copyBlock?.isStart && (
          <CopyDiffLineButton
            text={copyBlock.text}
            label={`Copy ${ln.k === "add" ? "added" : "deleted"} block`}
            visible={copyVisible}
            onOutlineStart={() => setOutlinedCopyBlock(copyBlock.id)}
            onOutlineEnd={() => setOutlinedCopyBlock(null)}
          />
        )}
      </span>
    </>
  );
}

function CopyDiffLineButton({
  text,
  label,
  visible,
  onOutlineStart,
  onOutlineEnd,
}: {
  text: string;
  label: string;
  visible: boolean;
  onOutlineStart: () => void;
  onOutlineEnd: () => void;
}) {
  const resetRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (resetRef.current) window.clearTimeout(resetRef.current);
  }, []);

  return (
    <button
      className="copy-diff-line"
      type="button"
      aria-label={label}
      title={label}
      data-copied={copied}
      data-visible={visible || copied}
      onMouseEnter={onOutlineStart}
      onMouseLeave={onOutlineEnd}
      onFocus={onOutlineStart}
      onBlur={onOutlineEnd}
      onClick={(event) => {
        event.stopPropagation();
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (resetRef.current) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1000);
        }).catch(() => {});
      }}
    >
      {copied ? "copied" : "copy"}
    </button>
  );
}

function diffLineText(value: DiffContent | undefined): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return String(value ?? "");
  return value.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object") return part.label || "";
    return "";
  }).join("");
}

function diffBlockAt(rows: DiffRowData[], index: number, side: DiffSide, filePath: string): CopyBlock | null {
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

interface CopyBlockPair {
  left: CopyBlock | null;
  right: CopyBlock | null;
}

function DiffRow({
  row,
  filePath,
  language,
  contextRanges,
  onSymbol,
  activeSym,
  symbols,
  copyBlock,
  hoveredCopyBlock,
  setHoveredCopyBlock,
  outlinedCopyBlock,
  setOutlinedCopyBlock,
}: {
  row: DiffRowData;
  filePath: string;
  language: string;
  contextRanges: SignalRange[] | undefined;
  onSymbol: SymbolHandler;
  activeSym: string | null;
  symbols: SymbolMap | undefined;
  copyBlock: CopyBlockPair | null;
  hoveredCopyBlock: string | null;
  setHoveredCopyBlock: (id: string | null) => void;
  outlinedCopyBlock: string | null;
  setOutlinedCopyBlock: (id: string | null) => void;
}) {
  if (row.kind === "hunk") {
    return (
      <div className="dl2 hunk">
        <span className="ln" />
        <span className="code">
          <span className="sig">…</span>
          <CodeChunks c={row.line!.c} language={language} onSymbol={onSymbol} activeSym={activeSym} symbols={symbols} />
        </span>
      </div>
    );
  }

  return (
    <div className={`dl2 ${row.kind}`}>
      <div
        className={`side left ${row.left?.k || "blank"}`}
        {...contextRangeAttrs(row.left, contextRanges, "left", filePath)}
        {...copyBlockAttrs(copyBlock?.left, outlinedCopyBlock)}
        onMouseEnter={copyBlock?.left ? () => setHoveredCopyBlock(copyBlock.left!.id) : undefined}
        onMouseLeave={copyBlock?.left ? () => setHoveredCopyBlock(null) : undefined}
      >
        <DiffCell ln={row.left} side="left" language={language} onSymbol={onSymbol} activeSym={activeSym} symbols={symbols} copyBlock={copyBlock?.left ?? null} copyVisible={hoveredCopyBlock === copyBlock?.left?.id} setOutlinedCopyBlock={setOutlinedCopyBlock} />
      </div>
      <div
        className={`side right ${row.right?.k || "blank"}`}
        {...contextRangeAttrs(row.right, contextRanges, "right", filePath)}
        {...copyBlockAttrs(copyBlock?.right, outlinedCopyBlock)}
        onMouseEnter={copyBlock?.right ? () => setHoveredCopyBlock(copyBlock.right!.id) : undefined}
        onMouseLeave={copyBlock?.right ? () => setHoveredCopyBlock(null) : undefined}
      >
        <DiffCell ln={row.right} side="right" language={language} onSymbol={onSymbol} activeSym={activeSym} symbols={symbols} copyBlock={copyBlock?.right ?? null} copyVisible={hoveredCopyBlock === copyBlock?.right?.id} setOutlinedCopyBlock={setOutlinedCopyBlock} />
      </div>
    </div>
  );
}

function copyBlockAttrs(block: CopyBlock | null | undefined, hoveredCopyBlock: string | null): Record<string, string | undefined> {
  if (!block || hoveredCopyBlock !== block.id) return {};
  return {
    "data-copy-block": "true",
    "data-copy-start": block.isStart ? "true" : undefined,
    "data-copy-end": block.isEnd ? "true" : undefined,
  };
}

function contextRangeAttrs(
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

function NoiseBlock({
  count,
  signal,
  pattern,
  onShow,
}: {
  count: number;
  signal: SignalRange | null;
  pattern: ReviewSignalPattern | undefined;
  onShow: () => void;
}) {
  return (
    <div className="noise-block">
      <span className="noise-block-count mono">{count}</span>
      <span className="noise-block-label">hidden noise lines</span>
      {signal?.reason && <span className="noise-block-reason">{signal.reason}</span>}
      <span className="noise-block-kind">{signal?.kind || "likely noise"}</span>
      {pattern?.label && <span className="noise-block-pattern">{pattern.label}</span>}
      <button type="button" onClick={onShow}>show</button>
    </div>
  );
}

function formatAnchorRange(anchor: SideAnchor | null | undefined, prefix: string): string {
  if (!anchor) return "";
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "";
  const range = start === end ? `${prefix}${start}` : `${prefix}${start}-${prefix}${end}`;
  return anchor.path ? `${anchor.path}:${range}` : range;
}

function ContextSignalMarker({ signal, side }: { signal: SignalRange; side: DiffSide }) {
  const ownAnchor = signal?.anchor?.[side];
  const pairAnchor = signal?.anchor?.[side === "left" ? "right" : "left"];
  const own = formatAnchorRange(ownAnchor, side === "left" ? "L" : "R");
  const pair = formatAnchorRange(pairAnchor, side === "left" ? "R" : "L");
  const before = signal?.scope?.before;
  const after = signal?.scope?.after;
  const scope = before || after ? `${before || "before"} → ${after || "after"}` : "";
  return (
    <div className="context-signal-marker" data-side={side} title={signal?.reason || ""}>
      <div className="context-signal-body">
        <span className="context-signal-kind">
          {side === "left" ? "moved" : "moved here"}
        </span>
        <span className="context-signal-pair">
          {side === "left" ? `${own} → ${pair}` : `${pair} → ${own}`}
        </span>
        {scope && <span className="context-signal-scope">{scope}</span>}
      </div>
    </div>
  );
}

function buildSideBySideRows(diff: DiffLine[]): DiffRowData[] {
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

function signalForRow(row: DiffRowData, ranges: SignalRange[] | undefined, filePath: string): SignalRange | null {
  if (!Array.isArray(ranges) || ranges.length === 0) return null;
  return ranges.find((range) => (
    isNoiseSignal(range) &&
    range.hideByDefault !== false &&
    (lineMatchesRange(row.left, range, "left", filePath) || lineMatchesRange(row.right, range, "right", filePath))
  )) || null;
}

interface ContextMarker { signal: SignalRange; side: DiffSide; }

function contextSignalMarkersForRow(row: DiffRowData, ranges: SignalRange[] | undefined, filePath: string): ContextMarker[] {
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

function contextRangeMatch(line: DiffLine | null | undefined, ranges: SignalRange[] | undefined, side: DiffSide, filePath: string): RangeState | null {
  if (!Array.isArray(ranges) || ranges.length === 0 || !line) return null;
  return ranges
    .filter(isContextSignal)
    .map((range) => lineRangeState(line, range, side, filePath))
    .find((state): state is RangeState => Boolean(state)) || null;
}

function lineRangeState(line: DiffLine, range: SignalRange, side: DiffSide, filePath: string): RangeState | null {
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

function lineMatchesRange(line: DiffLine | null | undefined, range: SignalRange, side: DiffSide, filePath: string): boolean {
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

function lineStartsRange(line: DiffLine | null | undefined, range: SignalRange, side: DiffSide, filePath: string): boolean {
  if (!line) return false;
  const anchor = range?.anchor?.[side];
  if (!anchor) return false;
  if (!anchorMatchesFile(anchor, filePath)) return false;
  const value = side === "left" ? line.L : line.R;
  if (value == null) return false;
  const start = Number(anchor.start);
  return Number.isFinite(start) && value === start;
}

function anchorMatchesFile(anchor: SideAnchor | null | undefined, filePath: string): boolean {
  return !anchor?.path || !filePath || anchor.path === filePath;
}

function HighlightedCode({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  return <span className="syntax" dangerouslySetInnerHTML={{ __html: html }} />;
}

function highlightCode(code: string, language: string): string {
  try {
    const grammar = Prism.languages[language] || Prism.languages.typescript;
    return Prism.highlight(code, grammar, language || "typescript");
  } catch {
    return escapeHtml(code);
  }
}

function languageForPath(filePath: string | undefined): string {
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

function escapeHtml(value: string): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// ── Inline AI note that anchors to a specific line ─────────────
function AiNote({
  note,
  side,
  onJumpToFile,
  onJumpToSymbol,
}: {
  note: FileNote;
  side: DiffSide;
  onJumpToFile: FileJumpHandler;
  onJumpToSymbol: SymbolHandler;
}) {
  const ref = useRef<HTMLSpanElement | null>(null);
  // Intercept clicks on jump-anchors inside the HTML payload.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement | null;
      const a = target?.closest("a.jump") as HTMLElement | null;
      if (!a) return;
      e.preventDefault();
      const f = a.dataset.file;
      const s = a.dataset.symbol;
      if (f) onJumpToFile(f);
      if (s) onJumpToSymbol(s);
    };
    el.addEventListener("click", onClick);
    return () => el.removeEventListener("click", onClick);
  }, [onJumpToFile, onJumpToSymbol]);

  return (
    <div className="ai-note" data-side={side}>
      <div className="body">
        <span ref={ref} className="text" dangerouslySetInnerHTML={{ __html: note.html }} />
        <span className="src">{note.src}</span>
      </div>
    </div>
  );
}

type StatusMap = Record<string, TriageStatus>;
type DecisionHandler = (id: string) => void;
type SetStatusHandler = (status: TriageStatus | null) => void;

// ── High-level overview renderer ───────────────────────────────
function HighLevelLeftRail({
  overview,
  decisions,
  statusMap,
  onJump,
}: {
  overview: Overview | null;
  decisions: Decisions;
  statusMap: StatusMap;
  onJump: (key: string) => void;
}) {
  const sections = [
    { key: "mental-model", label: "Mental Model", count: overview?.mentalModelDelta ? 1 : 0 },
    { key: "system-map", label: "System Map", count: overview?.systemMap ? 1 : 0 },
    { key: "model-deltas", label: "Model Deltas", count: overview?.modelDeltas?.length || 0 },
    { key: "flows", label: "Flows", count: overview?.flows?.length || 0 },
    { key: "assumptions", label: "Assumptions", count: overview?.assumptions?.length || 0 },
    { key: "hotspots", label: "Hotspots", count: overview?.hotspots?.length || 0 },
    { key: "decisions", label: "Decisions", count: decisions?.cards?.length || 0 },
  ];
  const actionIds = [
    ...(overview?.assumptions || []).map((item) => item.id),
    ...(overview?.hotspots || []).map((item) => item.id),
    ...(decisions?.cards || []).map((item) => item.id),
  ].filter(Boolean);
  const triaged = actionIds.filter((id) => statusMap?.[id]).length;
  return (
    <aside className="rail-left">
      <div className="rl-h">
        <span className="label">High Level</span>
        <span className="count">{triaged}/{actionIds.length} triaged</span>
      </div>
      <div className="rl-group" style={{ paddingTop: 8 }}>
        <div className="rl-group-title">
          <span>Sections</span>
        </div>
        {sections.map((section) => (
          <button
            key={section.key}
            className="overview-nav"
            type="button"
            data-empty={section.count === 0}
            onClick={() => onJump(section.key)}
          >
            <span className="overview-nav-name">{section.label}</span>
            <span className="overview-nav-count mono">{section.count}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

function HighLevelView({
  overview,
  decisions,
  files,
  statusMap,
  setStatus,
  flashId,
  onSymbol,
  onFile,
  onDecision,
}: {
  overview: Overview | null;
  decisions: Decisions;
  files: PackFile[];
  statusMap: StatusMap;
  setStatus: (id: string, status: TriageStatus | null) => void;
  flashId: string | null;
  onSymbol: SymbolHandler;
  onFile: FileJumpHandler;
  onDecision: DecisionHandler;
}) {
  const hasOverview = overview && hasOverviewContent(overview);
  const hasDecisions = (decisions?.cards?.length ?? 0) > 0;
  if (!hasOverview && !hasDecisions) {
    return (
      <div className="overview-doc">
        <div className="briefing-strip">
          <div className="what">
            <div className="icon">◇</div>
            <div>
              <h1>High Level</h1>
              <div className="desc">No orientation layer is included in this pack yet.</div>
            </div>
          </div>
        </div>
        <div className="overview-wrap">
          <div className="overview-empty">
            <div className="overview-empty-title">No high-level context</div>
            <div className="overview-empty-text">
              Generated packs can still be reviewed from the Code tab without this optional section.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="overview-doc">
      <div className="briefing-strip">
        <div className="what">
          <div className="icon">◇</div>
          <div>
            <h1>High Level</h1>
            <div className="desc">A compact orientation layer before reading detailed diff evidence.</div>
          </div>
        </div>
      </div>

      <div className="overview-wrap">
        {overview?.mentalModelDelta && (
          <section className="overview-section" id="mental-model">
            <div className="overview-section-head">
              <h2>Mental Model Delta</h2>
            </div>
            <div className="overview-card overview-lede">
              <RichText value={overview.mentalModelDelta} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
            </div>
          </section>
        )}

        {overview?.systemMap && (
          <section className="overview-section" id="system-map">
            <div className="overview-section-head">
              <h2>System Map</h2>
            </div>
            <article className="overview-flow overview-system-map">
              <h3>{overview.systemMap.title || "Affected system"}</h3>
              <AsciiPanel
                label={overview.systemMap.kind === "ascii" ? "ASCII-Art" : overview.systemMap.kind || "ASCII-Art"}
                lines={overview.systemMap.lines}
                onSymbol={onSymbol}
                onFile={onFile}
                onDecision={onDecision}
              />
              <RefList refs={overview.systemMap.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
            </article>
          </section>
        )}

        {(overview?.modelDeltas || []).length > 0 && (
          <section className="overview-section" id="model-deltas">
            <div className="overview-section-head">
              <h2>Model Deltas</h2>
              <span className="overview-section-meta mono">{overview?.modelDeltas.length}</span>
            </div>
            <div className="overview-model-list">
              {(overview?.modelDeltas || []).map((item, index) => (
                <article className="overview-card overview-model-delta" key={item.id || index}>
                  <h3><RichText value={item.title} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} /></h3>
                  <div className="model-delta-grid">
                    <div className="model-delta-cell">
                      <div className="model-delta-label">Before</div>
                      <div className="model-delta-text">
                        <RichText value={item.before} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      </div>
                    </div>
                    <div className="model-delta-cell">
                      <div className="model-delta-label">After</div>
                      <div className="model-delta-text">
                        <RichText value={item.after} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      </div>
                    </div>
                  </div>
                  <RefList refs={item.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                </article>
              ))}
            </div>
          </section>
        )}

        {(overview?.flows || []).length > 0 && (
          <section className="overview-section" id="flows">
            <div className="overview-section-head">
              <h2>Before / After Flow(s)</h2>
              <span className="overview-section-meta mono">{overview?.flows.length}</span>
            </div>
            <div className="overview-flow-list">
              {(overview?.flows || []).map((flow, index) => (
                <article className="overview-flow" key={`${flow.title || "flow"}-${index}`}>
                  <h3>{flow.title || `Flow ${index + 1}`}</h3>
                  {(flow.lines?.length || 0) > 0 ? (
                    <AsciiPanel label={flow.kind === "swimlane_ascii" ? "Swimlane" : "Flow"} lines={flow.lines} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                  ) : (
                    <div className="flow-grid">
                      <AsciiPanel label="Before" lines={flow.before} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      <AsciiPanel label="After" lines={flow.after} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </div>
                  )}
                </article>
              ))}
            </div>
          </section>
        )}

        {(overview?.assumptions || []).length > 0 && (
          <section className="overview-section" id="assumptions">
            <div className="overview-section-head">
              <h2>Load-Bearing Assumptions</h2>
              <span className="overview-section-meta mono">{overview?.assumptions.length}</span>
            </div>
            <div className="overview-list">
              {(overview?.assumptions || []).map((item, index) => (
                statusMap[item.id] ? (
                  <CompactReviewCard
                    key={item.id}
                    id={item.id}
                    kind="assumption"
                    number={index + 1}
                    title={<RichText value={item.text} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />}
                    status={statusMap[item.id]}
                    onSetStatus={(status) => setStatus(item.id, status)}
                  />
                ) : (
                  <OverviewActionCard
                    key={item.id}
                    id={item.id}
                    kind="assumption"
                    number={index + 1}
                    status={statusMap[item.id]}
                    onSetStatus={(status) => setStatus(item.id, status)}
                  >
                    <div className="overview-list-body">
                      <RichText value={item.text} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      <RefList refs={item.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </div>
                  </OverviewActionCard>
                )
              ))}
            </div>
          </section>
        )}

        {(overview?.hotspots || []).length > 0 && (
          <section className="overview-section" id="hotspots">
            <div className="overview-section-head">
              <h2>Risk Hotspots</h2>
              <span className="overview-section-meta mono">{overview?.hotspots.length}</span>
            </div>
            <div className="overview-list">
              {(overview?.hotspots || []).map((item, index) => (
                statusMap[item.id] ? (
                  <CompactReviewCard
                    key={item.id}
                    id={item.id}
                    kind="hotspot"
                    number={index + 1}
                    title={<RichText value={item.title} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />}
                    status={statusMap[item.id]}
                    onSetStatus={(status) => setStatus(item.id, status)}
                  />
                ) : (
                  <OverviewActionCard
                    key={item.id}
                    id={item.id}
                    kind="hotspot"
                    number={index + 1}
                    status={statusMap[item.id]}
                    onSetStatus={(status) => setStatus(item.id, status)}
                  >
                    <div className="overview-hotspot-content">
                      <h3><RichText value={item.title} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} /></h3>
                      <div className="overview-hotspot-why">
                        <RichText value={item.why} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      </div>
                      <RefList refs={item.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </div>
                  </OverviewActionCard>
                )
              ))}
            </div>
          </section>
        )}

        {hasDecisions && (
          <section className="overview-section" id="decisions">
            <div className="overview-section-head">
              <h2>Decisions</h2>
              <span className="overview-section-meta mono">{decisions.cards.length}</span>
            </div>
            <div className="overview-list">
              {decisions.cards.map((card) => (
                statusMap[card.id] ? (
                  <CompactReviewCard
                    key={card.id}
                    id={card.id}
                    kind="decision"
                    category={categoryLabel(card.category, decisions.categories)}
                    risk={card.risk}
                    title={card.title}
                    status={statusMap[card.id]}
                    onSetStatus={(status) => setStatus(card.id, status)}
                    flash={flashId === card.id}
                  />
                ) : (
                  <DecisionCard
                    key={card.id}
                    card={card}
                    categories={decisions.categories}
                    files={files}
                    onJump={onFile}
                    status={statusMap[card.id]}
                    onSetStatus={(status) => setStatus(card.id, status)}
                    flash={flashId === card.id}
                  />
                )
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function OverviewActionCard({
  id,
  kind,
  number,
  status,
  onSetStatus,
  children,
}: {
  id: string;
  kind: string;
  number?: number;
  status: TriageStatus | undefined;
  onSetStatus: SetStatusHandler;
  children: ReactNode;
}) {
  return (
    <article className={`overview-card overview-action overview-${kind} dc-status-${status || "open"}`} id={id}>
      <header className="dc-head overview-action-head">
        <div className="dc-tags">
          <span className="cat-pill">{kind}</span>
          {number && <span className="overview-num mono">{number}</span>}
          {status && <DecisionStatusPill status={status} />}
        </div>
        <DecisionTriage status={status} onSetStatus={onSetStatus} />
      </header>
      {children}
    </article>
  );
}

function CompactReviewCard({
  id,
  kind,
  number,
  category,
  risk,
  title,
  status,
  onSetStatus,
  flash,
}: {
  id: string;
  kind: string;
  number?: number;
  category?: string;
  risk?: string;
  title: ReactNode;
  status: TriageStatus | undefined;
  onSetStatus: SetStatusHandler;
  flash?: boolean;
}) {
  return (
    <article className={`overview-card overview-action overview-action-compact overview-${kind} dc-status-${status || "open"} ${flash ? "flash" : ""}`} id={id}>
      <div className="overview-action-main">
        <div className="overview-action-tags">
          <span className="cat-pill">{kind}</span>
          {category && <span className="cat-pill">{category}</span>}
          {risk && <OverviewRiskPill risk={risk} />}
          {number && <span className="overview-num mono">{number}</span>}
          {status && <DecisionStatusPill status={status} />}
        </div>
        <h3 className="overview-action-title">{title}</h3>
      </div>
      <div className="overview-action-controls">
        <DecisionTriage status={status} onSetStatus={onSetStatus} />
      </div>
    </article>
  );
}

function OverviewRiskPill({ risk }: { risk: string }) {
  return <span className={`risk-pill risk-${risk}`}>{risk}</span>;
}

function categoryLabel(category: string | undefined, categories: Decisions["categories"] = []) {
  const match = categories.find((item) => item?.key === category);
  return match?.label || category;
}

function DecisionStatusPill({ status }: { status: TriageStatus }) {
  return (
    <span className={`dc-status-pill st-${status}`}>
      {status === "accept" && "✓ Accepted"}
      {status === "flag" && "? Flagged for discussion"}
      {status === "block" && "✗ Blocker"}
    </span>
  );
}

function DecisionTriage({ status, onSetStatus }: { status: TriageStatus | undefined; onSetStatus: SetStatusHandler }) {
  return (
    <div className="dc-triage">
      <button
        className={`dc-tri ok ${status === "accept" ? "on" : ""}`}
        onClick={() => onSetStatus(status === "accept" ? null : "accept")}
        title="Accept"
      >
        ✓
      </button>
      <button
        className={`dc-tri flag ${status === "flag" ? "on" : ""}`}
        onClick={() => onSetStatus(status === "flag" ? null : "flag")}
        title="Flag for discussion"
      >
        ?
      </button>
      <button
        className={`dc-tri block ${status === "block" ? "on" : ""}`}
        onClick={() => onSetStatus(status === "block" ? null : "block")}
        title="Mark as blocker"
      >
        ✗
      </button>
    </div>
  );
}

interface RichHandlers {
  onSymbol: SymbolHandler;
  onFile: FileJumpHandler;
  onDecision: DecisionHandler;
}

function AsciiPanel({
  label,
  lines,
  onSymbol,
  onFile,
  onDecision,
}: {
  label: string;
  lines: RichTextValue[] | undefined;
} & RichHandlers) {
  return (
    <div className="ascii-panel">
      <div className="ascii-label">{label}</div>
      <pre className="ascii-lines">
        {(Array.isArray(lines) ? lines : []).map((line, index) => (
          <div className="ascii-line" key={`${label}-${index}`}>
            <RichLine value={line} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
          </div>
        ))}
      </pre>
    </div>
  );
}

function RefList({ refs, onSymbol, onFile, onDecision }: { refs: RichRef[] | undefined } & RichHandlers) {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  return (
    <div className="overview-refs">
      {refs.map((ref, index) => (
        <RichToken
          key={`${ref.type}-${ref.id}-${index}`}
          token={{ ...ref, label: ref.label || ref.id }}
          onSymbol={onSymbol}
          onFile={onFile}
          onDecision={onDecision}
        />
      ))}
    </div>
  );
}

function RichText({ value, onSymbol, onFile, onDecision }: { value: RichTextValue | undefined } & RichHandlers) {
  if (Array.isArray(value)) {
    return <RichLine value={value} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />;
  }
  return <>{value || ""}</>;
}

function RichLine({ value, onSymbol, onFile, onDecision }: { value: RichTextValue | undefined } & RichHandlers) {
  if (typeof value === "string") return <>{value}</>;
  if (!Array.isArray(value)) return null;
  return (
    <>
      {value.map((part: RichPart, index) => {
        if (typeof part === "string") return <React.Fragment key={index}>{part}</React.Fragment>;
        return (
          <RichToken
            key={`${part.type || "token"}-${part.id || index}-${index}`}
            token={part}
            onSymbol={onSymbol}
            onFile={onFile}
            onDecision={onDecision}
          />
        );
      })}
    </>
  );
}

function RichToken({ token, onSymbol, onFile, onDecision }: { token: RichRef } & RichHandlers) {
  const onClick = () => {
    if (token.type === "symbol") onSymbol(token.id);
    if (token.type === "file") onFile(token.id);
    if (token.type === "decision") onDecision(token.id);
  };
  return (
    <button
      className={`rich-token rt-${token.type}`}
      type="button"
      onClick={onClick}
      title={`Open ${token.type}: ${token.label || token.id}`}
    >
      {token.label || token.id}
    </button>
  );
}

function CopyTextButton({
  text,
  className = "copy-text-button",
  children = "copy",
}: {
  text: string;
  className?: string;
  children?: ReactNode;
}) {
  const resetRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (resetRef.current) window.clearTimeout(resetRef.current);
  }, []);

  return (
    <button
      className={className}
      type="button"
      data-copied={copied}
      onClick={() => {
        navigator.clipboard?.writeText(text).then(() => {
          setCopied(true);
          if (resetRef.current) window.clearTimeout(resetRef.current);
          resetRef.current = window.setTimeout(() => setCopied(false), 1000);
        }).catch(() => {});
      }}
    >
      {copied ? "copied" : children}
    </button>
  );
}

function WorkflowModal({ pr, runtime = DEFAULT_RUNTIME, onClose }: { pr: Pr; runtime?: Runtime; onClose: () => void }) {
  const commands = workflowCommands(pr, runtime);
  const prompts = workflowPrompts(pr, runtime);

  return (
    <div className="workflow-modal-backdrop" role="presentation" onMouseDown={onClose}>
      <section
        className="workflow-modal"
        role="dialog"
        aria-modal="true"
        aria-label="aha commands and prompts"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="workflow-modal-head">
          <div>
            <div className="eyebrow">aha workflow</div>
            <h2>Commands & prompts</h2>
          </div>
          <button className="workflow-close" type="button" onClick={onClose} aria-label="Close">×</button>
        </header>

        <div className="workflow-modal-body">
          <section className="workflow-section">
            <h3>Commands</h3>
            {commands.map((item) => (
              <WorkflowCopyBlock key={item.key} title={item.title} text={item.text} />
            ))}
          </section>

          <section className="workflow-section">
            <h3>AI prompts</h3>
            {prompts.map((item) => (
              <WorkflowCopyBlock key={item.key} title={item.title} text={item.text} tall />
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}

function WorkflowCopyBlock({ title, text, tall = false }: { title: string; text: string; tall?: boolean }) {
  return (
    <article className="workflow-copy-block" data-tall={tall}>
      <div className="workflow-copy-head">
        <span>{title}</span>
        <CopyTextButton text={text} className="workflow-copy-button" />
      </div>
      <pre>{text}</pre>
    </article>
  );
}

function EmptyOnboarding({ runtime = DEFAULT_RUNTIME }: { runtime?: Runtime }) {
  const cliCommand = runtime.ahaCli || DEFAULT_RUNTIME.ahaCli;
  const packPath = ".aha/aha-<branch>-<pr-number>.json";
  const openExistingCommand = ahaCommand("review", { cliCommand, packPath: "/absolute/path/to/aha.json" });
  const generateCommand = `PR_NUMBER="$(gh pr view --json number -q .number)"\n${ahaCommand("generate-auto", { cliCommand, prNumber: '"$PR_NUMBER"' })}`;
  const generateAndServeCommand = `AHA_CLI=${cliCommand}\nPR_NUMBER="$(gh pr view --json number -q .number)"\nPACK_PATH="$("$AHA_CLI" generate --pr "$PR_NUMBER" | tail -n 1)"\n"$AHA_CLI" serve --pack "$PACK_PATH" --port 4173 --host 127.0.0.1`;
  const fullWorkflowPrompt = fillAhaWorkflowPrompt(AHA_FULL_WORKFLOW_INIT_PROMPT, {
    cliCommand,
    targetRepo: "",
    prNumber: "",
    packPath,
  });

  const [done, setDone] = useState(false);
  const stepState = (step: number): "active" | "upcoming" | "done" => {
    if (!done) return step === 1 ? "active" : "upcoming";
    if (step === 1) return "done";
    return step === 2 ? "active" : "upcoming";
  };

  return (
    <main className="onb">
      <div className="onb-stage">
        <div className="onb-mark" aria-hidden="true">◇</div>
        <h1 className="onb-title">Your agent will set everything up for you.</h1>
        <p className="onb-sub">
          Hand one prompt to your coding agent. It generates the pack, enriches
          the review, and opens it right here.
        </p>

        <ol className="onb-steps" aria-label="Setup steps">
          <li className="onb-step" data-state={stepState(1)} data-rail-down={done ? "done" : "todo"}>
            <div className="onb-step-rail">
              <span className="onb-step-line up" />
              <span className="onb-step-num">
                <span className="onb-step-digit">1</span>
                <span className="onb-step-check" aria-hidden="true" />
              </span>
              <span className="onb-step-line down" />
            </div>
            <OnboardingPromptAction
              prompt={fullWorkflowPrompt}
              active={stepState(1) === "active"}
              onCopied={() => setDone(true)}
            />
          </li>
          <li className="onb-step" data-state={stepState(2)} data-rail-up={done ? "done" : "todo"}>
            <div className="onb-step-rail">
              <span className="onb-step-line up" />
              <span className="onb-step-num">
                <span className="onb-step-digit">2</span>
                <span className="onb-step-check" aria-hidden="true" />
              </span>
              <span className="onb-step-line down" />
            </div>
            <div className="onb-step-body">
              <div className="onb-step-main">
                <span className="onb-step-label">Paste it into your coding agent</span>
                <span className="onb-step-hint">Give it the target repo path and PR</span>
              </div>
            </div>
          </li>
          <li className="onb-step" data-state={stepState(3)}>
            <div className="onb-step-rail">
              <span className="onb-step-line up" />
              <span className="onb-step-num">
                <span className="onb-step-digit">3</span>
                <span className="onb-step-check" aria-hidden="true" />
              </span>
              <span className="onb-step-line down" />
            </div>
            <div className="onb-step-body">
              <div className="onb-step-main">
                <span className="onb-step-label">Your review opens right here</span>
                <span className="onb-step-hint">It generates, enriches, and loads it for you</span>
              </div>
            </div>
          </li>
        </ol>

        <details className="onb-manual">
          <summary>Rather run the steps yourself?</summary>
          <div className="onb-manual-body">
            <WorkflowCopyBlock title="Open an existing pack" text={openExistingCommand} />
            <WorkflowCopyBlock title="Generate the deterministic base" text={generateCommand} />
            <WorkflowCopyBlock title="Generate and serve in this terminal" text={generateAndServeCommand} />
          </div>
        </details>
      </div>
    </main>
  );
}

function OnboardingPromptAction({
  prompt,
  active = false,
  onCopied,
}: {
  prompt: string;
  active?: boolean;
  onCopied?: () => void;
}) {
  const resetRef = useRef<number | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => {
    if (resetRef.current) window.clearTimeout(resetRef.current);
  }, []);

  const firstLine = (prompt.split("\n").find((line) => line.trim()) || prompt).trim();

  const copy = () => {
    navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true);
      onCopied?.();
      if (resetRef.current) window.clearTimeout(resetRef.current);
      resetRef.current = window.setTimeout(() => setCopied(false), 2400);
    }).catch(() => {});
  };

  return (
    <button
      className="onb-step1"
      type="button"
      data-copied={copied}
      onClick={copy}
      aria-label={copied ? "Instructions copied to clipboard" : "Copy the setup instructions for your coding agent"}
    >
      <span className="onb-step1-head">
        <span className="onb-step-label">Copy instructions</span>
        <span className="onb-step1-cta">
          {active && !copied && <span className="onb-peek-arrow" aria-hidden="true" />}
          <span className="onb-step1-cta-label">{copied ? "Copied" : "Copy"}</span>
        </span>
      </span>
      <code className="onb-peek-line" title={firstLine}>{firstLine}</code>
    </button>
  );
}

interface WorkflowItem {
  key: string;
  title: string;
  text: string;
}

function workflowCommands(pr: Pr, runtime: Runtime = DEFAULT_RUNTIME): WorkflowItem[] {
  const prNumber = pr.number || "<pr>";
  const cliCommand = runtime.ahaCli || DEFAULT_RUNTIME.ahaCli;
  const packPath = "/absolute/path/to/aha.json";
  return [
    {
      key: "generate",
      title: "Generate deterministic base",
      text: `cd /path/to/target-repo\n${ahaCommand("generate-auto", { cliCommand, prNumber })}`,
    },
    {
      key: "start-empty",
      title: "Start empty viewer",
      text: ahaCommand("start", { cliCommand }),
    },
    {
      key: "generate-out",
      title: "Generate with explicit output",
      text: `cd /path/to/target-repo\n${ahaCommand("generate", { cliCommand, prNumber, packPath: `.aha/aha-base-${prNumber}.json` })}`,
    },
    {
      key: "review",
      title: "Open a finished pack",
      text: ahaCommand("review", { cliCommand, packPath }),
    },
    {
      key: "serve",
      title: "Serve finished pack",
      text: `cd /path/to/target-repo\n${ahaCommand("serve", { cliCommand, packPath })}`,
    },
    {
      key: "update",
      title: "Update existing pack",
      text: `cd /path/to/target-repo\n${ahaCommand("update", { cliCommand, prNumber, packPath })}`,
    },
    {
      key: "normalize",
      title: "Normalize after AI edits",
      text: ahaCommand("normalize", { cliCommand, packPath }),
    },
    {
      key: "merge-fragments",
      title: "Merge AI fragments",
      text: `cd /path/to/target-repo\n${ahaCommand("merge", { cliCommand, packPath, fragments: AHA_FRAGMENT_LIST })}`,
    },
  ];
}

function workflowPrompts(pr: Pr, runtime: Runtime = DEFAULT_RUNTIME): WorkflowItem[] {
  const prNumber = pr?.number || "<pr>";
  const cliCommand = runtime.ahaCli || DEFAULT_RUNTIME.ahaCli;
  const packPath = "/absolute/path/to/aha.json";
  const prefix = `You are in /path/to/target-repo.\n\nUse this aha file:\n/absolute/path/to/aha.json\n\nApply the following prompt exactly:\n\n`;
  return [
    {
      key: "full-workflow-init",
      title: "Full workflow: init",
      text: fillAhaWorkflowPrompt(AHA_FULL_WORKFLOW_INIT_PROMPT, {
        cliCommand,
        prNumber,
        targetRepo: "/path/to/target-repo",
        packPath,
      }),
    },
    {
      key: "full-workflow-update",
      title: "Full workflow: update",
      text: fillAhaWorkflowPrompt(AHA_FULL_WORKFLOW_UPDATE_PROMPT, {
        cliCommand,
        prNumber,
        targetRepo: "/path/to/target-repo",
        packPath,
      }),
    },
    {
      key: "code-context",
      title: "1. Code context",
      text: `${prefix}${AHA_CODE_CONTEXT_PROMPT}`,
    },
    {
      key: "review-signals",
      title: "2. Review signals",
      text: `${prefix}${AHA_REVIEW_SIGNALS_PROMPT}`,
    },
    {
      key: "review-judgment",
      title: "3. Review judgment",
      text: `${prefix}${AHA_REVIEW_JUDGMENT_PROMPT}`,
    },
    {
      key: "update-repair",
      title: "Update repair only",
      text: `${prefix}${fillAhaWorkflowPrompt(AHA_UPDATE_REPAIR_PROMPT, { cliCommand, prNumber, packPath })}\n\nReference prompt sections to apply while repairing:\n\n--- CODE CONTEXT ---\n${AHA_CODE_CONTEXT_PROMPT}\n\n--- REVIEW SIGNALS ---\n${AHA_REVIEW_SIGNALS_PROMPT}\n\n--- REVIEW JUDGMENT ---\n${AHA_REVIEW_JUDGMENT_PROMPT}`,
    },
  ];
}

function hasOverviewContent(overview: Overview | null | undefined): boolean {
  return !!(
    overview?.mentalModelDelta ||
    overview?.systemMap ||
    overview?.modelDeltas?.length ||
    overview?.flows?.length ||
    overview?.assumptions?.length ||
    overview?.hotspots?.length
  );
}

function hasReviewSignals(reviewSignals: ReviewSignals | undefined): boolean {
  return !!(
    reviewSignals &&
    Object.keys(reviewSignals.files || {}).length > 0 &&
    ((reviewSignals.summary?.noiseFiles || 0) > 0 || (reviewSignals.summary?.noiseLines || 0) > 0)
  );
}

type RelevanceCarrier = { relevance: Relevance } | null | undefined;

function isNoiseSignal(signal: RelevanceCarrier): boolean {
  return !!signal && signal.relevance === "noise";
}

function isContextSignal(signal: RelevanceCarrier): boolean {
  return !!signal && signal.relevance === "context";
}

type NoiseMode = "focus" | "all" | "expanded";

// ── File card ──────────────────────────────────────────────────
function FileCard({
  file,
  order,
  signal,
  patterns,
  symbols,
  noiseMode,
  onSymbol,
  activeSym,
  reviewed,
  onToggleReviewed,
  onJumpToFile,
  onJumpToSymbol,
  flash,
  collapsed,
  onToggleCollapsed,
  scrollRoot,
}: {
  file: PackFile;
  order: number;
  signal: FileSignal | undefined;
  patterns: Record<string, ReviewSignalPattern> | undefined;
  symbols: SymbolMap | undefined;
  noiseMode: NoiseMode;
  onSymbol: SymbolHandler;
  activeSym: string | null;
  reviewed: boolean;
  onToggleReviewed: (file: PackFile) => void;
  onJumpToFile: FileJumpHandler;
  onJumpToSymbol: SymbolHandler;
  flash: boolean;
  collapsed: boolean;
  onToggleCollapsed: (file: PackFile) => void;
  scrollRoot: React.RefObject<HTMLElement | null>;
}) {
  const fileRef = useRef<HTMLElement | null>(null);
  const copyResetRef = useRef<number | null>(null);
  const [diffReady, setDiffReady] = useState(false);
  const [showLocalNoise, setShowLocalNoise] = useState(false);
  const [copiedPath, setCopiedPath] = useState(false);
  const [hoveredCopyBlock, setHoveredCopyBlock] = useState<string | null>(null);
  const [outlinedCopyBlock, setOutlinedCopyBlock] = useState<string | null>(null);
  const showNoiseDetails = noiseMode === "expanded" || showLocalNoise;
  const isNoiseFile = isNoiseSignal(signal);
  const language = useMemo(() => languageForPath(file.path), [file.path]);

  useEffect(() => () => {
    if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
  }, []);

  const copyFilePath = useCallback(async (event: React.MouseEvent) => {
    event.stopPropagation();
    try {
      await navigator.clipboard.writeText(file.path);
      setCopiedPath(true);
      if (copyResetRef.current) window.clearTimeout(copyResetRef.current);
      copyResetRef.current = window.setTimeout(() => setCopiedPath(false), 1200);
    } catch {
      setCopiedPath(false);
    }
  }, [file.path]);

  useEffect(() => {
    if (collapsed || diffReady) return;
    const el = fileRef.current;
    const root = scrollRoot?.current;
    if (!el || !root || typeof IntersectionObserver === "undefined") {
      setDiffReady(true);
      return;
    }
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setDiffReady(true);
          observer.disconnect();
        }
      },
      { root, rootMargin: "1400px 0px" }
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [collapsed, diffReady, scrollRoot]);

  // Build a flat list of elements: each diff line, with any matching notes
  // inserted directly after.
  const items = useMemo<ReactNode[] | null>(() => {
    if (!diffReady || collapsed) return null;
    const rendered: ReactNode[] = [];
    const rows = buildSideBySideRows(file.diff);
    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i];
      const rangeSignal = showNoiseDetails ? null : signalForRow(row, signal?.ranges, file.path);
      if (rangeSignal) {
        let count = 1;
        while (i + count < rows.length && signalForRow(rows[i + count], signal?.ranges, file.path)) count += 1;
        rendered.push(
          <NoiseBlock
            key={`noise-${i}`}
            count={count}
            signal={rangeSignal}
            pattern={rangeSignal.patternId ? patterns?.[rangeSignal.patternId] : undefined}
            onShow={() => setShowLocalNoise(true)}
          />
        );
        i += count - 1;
        continue;
      }
      const contextMarkers = contextSignalMarkersForRow(row, signal?.ranges, file.path);
      for (const marker of contextMarkers) {
        rendered.push(
          <ContextSignalMarker
            key={`context-${marker.side}-${marker.signal.id || i}`}
            signal={marker.signal}
            side={marker.side}
          />
        );
      }
      rendered.push(
        <DiffRow
          key={`l-${i}`}
          row={row}
          filePath={file.path}
          language={language}
          contextRanges={signal?.ranges}
          onSymbol={onSymbol}
          activeSym={activeSym}
          symbols={symbols}
          copyBlock={{
            left: diffBlockAt(rows, i, "left", file.path),
            right: diffBlockAt(rows, i, "right", file.path),
          }}
          hoveredCopyBlock={hoveredCopyBlock}
          setHoveredCopyBlock={setHoveredCopyBlock}
          outlinedCopyBlock={outlinedCopyBlock}
          setOutlinedCopyBlock={setOutlinedCopyBlock}
        />
      );
      if (file.notes) {
        file.notes.forEach((n, j) => {
          const side = n.afterR != null ? "right" : "left";
          const targetLine = side === "right" ? row.right : row.left;
          const lineNum = side === "right" ? targetLine?.R : targetLine?.L;
          const target = side === "right" ? n.afterR : n.afterL;
          if (lineNum === target && lineNum != null) {
            rendered.push(
              <AiNote key={`n-${i}-${j}`} note={n}
                      side={side}
                      onJumpToFile={onJumpToFile}
                      onJumpToSymbol={onJumpToSymbol} />
            );
          }
        });
      }
    }
    return rendered;
  }, [activeSym, collapsed, diffReady, file.diff, file.notes, file.path, hoveredCopyBlock, outlinedCopyBlock, language, onJumpToFile, onJumpToSymbol, onSymbol, patterns, showNoiseDetails, signal, symbols]);

  return (
    <section className={`file ${flash ? "flash" : ""}`} data-collapsed={collapsed} data-noise={isNoiseFile} id={file.id} ref={fileRef}>
      <header className="file-head">
        <div className="file-title-row">
          <button
            className="file-title"
            type="button"
            onClick={() => onToggleCollapsed(file)}
            title={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
          >
            <span className="collapse-mark">›</span>
            <span className="order-num">{order}</span>
            <span className="path" title={file.path}>{file.path}</span>
          </button>
          <button
            className="copy-path"
            type="button"
            onClick={copyFilePath}
            title={`Copy path: ${file.path}`}
            aria-label={`Copy path ${file.path}`}
            data-copied={copiedPath}
          >
            <span className={copiedPath ? "check-icon" : "copy-icon"} aria-hidden="true" />
          </button>
        </div>
        <div className="actions">
          <div
            className="checkbox viewed"
            data-on={reviewed}
            onClick={(event) => {
              event.stopPropagation();
              onToggleReviewed(file);
            }}
          >
            <span className="box" /> <span>Viewed</span>
          </div>
          {file.tag !== "modified" && (
            <span className={`file-tag ${file.tag === "new" ? "" : file.tag}`}>
              {file.tag === "new" ? "NEW" : "UNCHANGED"}
            </span>
          )}
          {isNoiseFile && (
            <span className="file-tag noise" title={signal?.reason || "Likely review-irrelevant change"}>
              likely noise
            </span>
          )}
          {(file.add ?? 0) > 0 || (file.del ?? 0) > 0 ? (
            <span className="file-stat">
              {(file.add ?? 0) > 0 && <span className="add">+{file.add}</span>}
              {(file.add ?? 0) > 0 && (file.del ?? 0) > 0 && " "}
              {(file.del ?? 0) > 0 && <span className="del">−{file.del}</span>}
            </span>
          ) : (
            <span className="file-stat">read-only</span>
          )}
        </div>
      </header>

      {!collapsed && file.note && (
        <div className="file-note">
          <span className="file-note-text" dangerouslySetInnerHTML={{ __html: file.note || "" }} />
        </div>
      )}

      {!collapsed && isNoiseFile && signal?.reason && (
        <div className="file-noise-note">
          <span className="mono">{signal.source || "signal"}</span>
          <span>{signal.reason}</span>
        </div>
      )}

      {!collapsed && (diffReady ? (
        <div className="diff">{items}</div>
      ) : (
        <div className="diff-placeholder">
          <span className="mono">{file.diff.length}</span> diff lines load when this file nears the viewport
        </div>
      ))}

      {!collapsed && <footer className="file-foot">
        <span className="muted" style={{ marginLeft: "auto" }}>
          {file.diff.filter(d => d.k === "add").length} added · {file.diff.filter(d => d.k === "del").length} removed
        </span>
      </footer>}
    </section>
  );
}

function buildFileTree(files: PackFile[]): TreeNode {
  const root: TreeNode = { name: "", path: "", folders: new Map(), files: [] };
  for (const file of files) {
    const parts = String(file.path || "").split("/").filter(Boolean);
    parts.pop();
    let node = root;
    let acc = "";
    for (const part of parts) {
      acc = acc ? `${acc}/${part}` : part;
      if (!node.folders.has(part)) {
        node.folders.set(part, { name: part, path: acc, folders: new Map(), files: [] });
      }
      node = node.folders.get(part)!;
    }
    node.files.push(file);
  }
  for (const child of root.folders.values()) compressTreeFolder(child);
  return root;
}

// Collapse single-child folder chains (src → components → ...) into one row.
function compressTreeFolder(folder: TreeNode) {
  for (const child of folder.folders.values()) compressTreeFolder(child);
  while (folder.files.length === 0 && folder.folders.size === 1) {
    const child = folder.folders.values().next().value as TreeNode;
    folder.name = `${folder.name}/${child.name}`;
    folder.path = child.path;
    folder.files = child.files;
    folder.folders = child.folders;
  }
}

function countTreeFiles(node: TreeNode): number {
  let count = node.files.length;
  for (const child of node.folders.values()) count += countTreeFiles(child);
  return count;
}

interface RlFileProps {
  activeId: string | null;
  reviewedSet: Set<string>;
  changedViewedSet: Set<string>;
  reviewSignals: ReviewSignals | undefined;
  onJump: FileJumpHandler;
}

function RlFileRow({
  file,
  depth,
  activeId,
  reviewedSet,
  changedViewedSet,
  reviewSignals,
  onJump,
}: { file: PackFile; depth?: number } & RlFileProps) {
  const noise = isNoiseSignal(reviewSignals?.files?.[fileSignalKey(file)]);
  const changed = changedViewedSet?.has(fileReviewKey(file));
  return (
    <div
      className="rl-file"
      style={depth != null ? { paddingLeft: 10 + depth * 14 } : undefined}
      data-active={activeId === file.id}
      data-noise={noise}
      data-read={reviewedSet.has(fileReviewKey(file))}
      data-changed-viewed={changed}
      onClick={() => onJump(file.id)}
      title={file.path}
    >
      <span className="dot" />
      <span className="rl-file-name">{basename(file.path)}</span>
      {file.tag === "new" && <span className="badge">NEW</span>}
      {file.tag === "unchanged" && <span className="badge unchanged">CTX</span>}
      {changed && <span className="badge changed">CHANGED</span>}
      {noise && <span className="badge noise">NOISE</span>}
      {(file.add ?? 0) > 0 || (file.del ?? 0) > 0 ? (
        <span className="stat">
          {(file.add ?? 0) > 0 && <span className="add">+{file.add}</span>}
          {(file.del ?? 0) > 0 && <span className="del">−{file.del}</span>}
        </span>
      ) : null}
    </div>
  );
}

function RlTreeNode({
  node,
  depth,
  collapsed,
  forceOpen,
  toggleFolder,
  fileProps,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  forceOpen: boolean;
  toggleFolder: (path: string) => void;
  fileProps: RlFileProps;
}) {
  return (
    <>
      {Array.from(node.folders.values()).map((folder) => {
        const open = forceOpen || !collapsed.has(folder.path);
        return (
          <React.Fragment key={folder.path}>
            <div
              className="rl-folder"
              data-open={open}
              style={{ paddingLeft: 10 + depth * 14 }}
              onClick={() => toggleFolder(folder.path)}
              title={folder.path}
            >
              <span className="rl-folder-caret" aria-hidden="true" />
              <span className="rl-folder-ico" aria-hidden="true" />
              <span className="rl-folder-name">{folder.name}</span>
              <span className="rl-folder-count">{countTreeFiles(folder)}</span>
            </div>
            {open && (
              <RlTreeNode
                node={folder}
                depth={depth + 1}
                collapsed={collapsed}
                forceOpen={forceOpen}
                toggleFolder={toggleFolder}
                fileProps={fileProps}
              />
            )}
          </React.Fragment>
        );
      })}
      {node.files.map((file) => (
        <RlFileRow key={file.id} file={file} depth={depth} {...fileProps} />
      ))}
    </>
  );
}

// ── Left rail: file list grouped by reading-order phase ────────
function LeftRail({
  files,
  groups,
  activeId,
  reviewedSet,
  changedViewedSet,
  onJump,
  readingOrders,
  readingMode,
  onReadingModeChange,
  reviewSignals,
  noiseMode,
  onNoiseModeChange,
}: {
  files: PackFile[];
  groups: CodeViewGroup[];
  activeId: string | null;
  reviewedSet: Set<string>;
  changedViewedSet: Set<string>;
  onJump: FileJumpHandler;
  readingOrders: ReadingOrder[];
  readingMode: string;
  onReadingModeChange: (mode: string) => void;
  reviewSignals: ReviewSignals | undefined;
  noiseMode: NoiseMode;
  onNoiseModeChange: (mode: NoiseMode) => void;
}) {
  const [fileQuery, setFileQuery] = useState("");
  const reviewedCount = files.filter((file) => reviewedSet.has(fileReviewKey(file))).length;
  const reviewedPct = files.length > 0 ? (reviewedCount / files.length) * 100 : 0;
  const hasAiOrder = readingOrders.length > 0;
  const activeOrder = readingOrders.find((order) => order.key === readingMode);
  const noiseSummary = reviewSignals?.summary;
  const normalizedQuery = normalizeFileSearch(fileQuery);
  const visibleGroups = useMemo(() => {
    if (!normalizedQuery) return groups;
    return groups
      .map((group) => ({
        ...group,
        files: group.files.filter((file) => fileMatchesSearch(file, normalizedQuery)),
      }))
      .filter((group) => group.files.length > 0);
  }, [groups, normalizedQuery]);
  const visibleFileCount = visibleGroups.reduce((sum, group) => sum + group.files.length, 0);
  const firstSearchMatch = normalizedQuery ? visibleGroups[0]?.files[0] : null;

  const isFilesystem = readingMode === "default";
  const [collapsedFolders, setCollapsedFolders] = useState<Set<string>>(() => new Set());
  const toggleFolder = useCallback((path: string) => {
    setCollapsedFolders((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);
  const visibleFiles = useMemo(
    () => (normalizedQuery ? files.filter((file) => fileMatchesSearch(file, normalizedQuery)) : files),
    [files, normalizedQuery]
  );
  const fileTree = useMemo(() => buildFileTree(visibleFiles), [visibleFiles]);

  return (
    <aside className="rail-left">
      <div className="rl-h">
        <span className="label">Files in this PR</span>
        <span className="count">{normalizedQuery ? `${visibleFileCount}/${files.length}` : files.length}</span>
      </div>
      <div className="rl-search">
        <input
          value={fileQuery}
          placeholder="Search file name or path"
          onChange={(event) => setFileQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && firstSearchMatch) {
              event.preventDefault();
              onJump(firstSearchMatch.id);
            }
            if (event.key === "Escape" && fileQuery) {
              event.preventDefault();
              setFileQuery("");
            }
          }}
        />
      </div>
      <div className="reading-order-switch">
        <button
          type="button"
          data-active={readingMode === "default"}
          onClick={() => onReadingModeChange("default")}
        >
          Filesystem
        </button>
        <button
          type="button"
          disabled={!hasAiOrder}
          data-active={readingMode !== "default"}
          onClick={() => hasAiOrder && onReadingModeChange(readingOrders[0].key)}
          title={hasAiOrder ? activeOrder?.why || readingOrders[0].why : "AI reading order unavailable"}
        >
          AI order
        </button>
      </div>
      <div className="reading-order-hint" data-available={hasAiOrder}>
        {hasAiOrder
          ? `${activeOrder?.label || readingOrders[0].label} available`
          : "AI reading order unavailable"}
      </div>
      <div className="noise-switch">
        <button type="button" data-active={noiseMode === "focus"} onClick={() => onNoiseModeChange("focus")}>
          Review focus
        </button>
        <button type="button" data-active={noiseMode === "all"} onClick={() => onNoiseModeChange("all")}>
          All files
        </button>
        <button type="button" data-active={noiseMode === "expanded"} onClick={() => onNoiseModeChange("expanded")}>
          Show noise
        </button>
      </div>
      <div className="noise-hint" data-active={hasReviewSignals(reviewSignals)}>
        {hasReviewSignals(reviewSignals)
          ? `${noiseSummary?.noiseFiles || 0} files · ${noiseSummary?.noiseLines || 0} hidden noise lines`
          : "No noise signals available"}
      </div>

      {isFilesystem ? (
        <div className="rl-tree">
          <RlTreeNode
            node={fileTree}
            depth={0}
            collapsed={collapsedFolders}
            forceOpen={!!normalizedQuery}
            toggleFolder={toggleFolder}
            fileProps={{ activeId, reviewedSet, changedViewedSet, reviewSignals, onJump }}
          />
        </div>
      ) : (
        visibleGroups.map((g, gi) => {
          if (!g.files.length) return null;
          return (
            <div className="rl-group" key={g.key}>
              <div className="rl-group-title">
                <span className="num">{gi + 1}</span>
                <span>{g.label}</span>
                <span className="why">{g.why}</span>
              </div>
              {g.files.map((f) => (
                <RlFileRow
                  key={f.id}
                  file={f}
                  activeId={activeId}
                  reviewedSet={reviewedSet}
                  changedViewedSet={changedViewedSet}
                  reviewSignals={reviewSignals}
                  onJump={onJump}
                />
              ))}
            </div>
          );
        })
      )}

      {normalizedQuery && visibleFileCount === 0 && (
        <div className="rl-empty">No files match "{fileQuery.trim()}"</div>
      )}

      <div className="rl-prog">
        <span className="num">{reviewedCount}/{files.length}</span>
        <span className="track">
          <span className="fill" style={{ width: `${reviewedPct}%` }} />
        </span>
      </div>
    </aside>
  );
}

function basename(p: string): string { return p.split("/").slice(-1)[0]; }

function dirname(p: string | undefined): string {
  const parts = String(p || "").split("/").filter(Boolean);
  parts.pop();
  return parts.join("/");
}

function normalizeFileSearch(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function fileMatchesSearch(file: PackFile, query: string): boolean {
  if (!query) return true;
  const pathText = String(file?.path || "").toLowerCase();
  const baseText = basename(pathText);
  return pathText.includes(query) || baseText.includes(query);
}

function CallsiteContext({ caller }: { caller: SymbolCaller }) {
  return (
    <div className="callsite-context">
      {caller.context.lines.map((line) => (
        <div className="ctx-line" data-hit={line.line === caller.line} key={line.line}>
          <span className="ctx-ln">{line.line}</span>
          <span className="ctx-code">{line.c}</span>
        </div>
      ))}
    </div>
  );
}

// ── Right rail: call sites panel ───────────────────────────────
function CallSitesPanel({
  symbol,
  onClose,
  onJumpToFile,
}: {
  symbol: PackSymbol | null;
  onClose: () => void;
  onJumpToFile: FileJumpHandler;
}) {
  if (!symbol) {
    return (
      <>
        <div className="rr-h">
          <span className="eyebrow">Call sites · blast radius</span>
        </div>
        <div className="rr-empty">
          <div className="icon">↘</div>
          <div>Click any symbol in the diff to see where it's defined, who calls it, and how this PR changes the blast radius.</div>
          <div className="hint">
            Try clicking <code>canViewCV</code> on the file <em>canViewCV.ts</em> — it has callers in this PR <em>and</em> sibling readers that weren't touched.
          </div>
        </div>
      </>
    );
  }

  const touchedCount = symbol.callers.filter(c => c.status === "touched").length;
  const untouchedCount = symbol.callers.filter(c => c.status === "untouched").length;
  const testCount = symbol.callers.filter(c => c.status === "test").length;
  const definedPath = symbol.defined.path || symbol.defined.file || symbol.defined.fileId;

  return (
    <>
      <div className="rr-h">
        <span className="eyebrow">Symbol · call sites</span>
        <button className="close" onClick={onClose} title="Close">✕</button>
      </div>
      <div className="rr-sym">
        <div className="kind">{symbol.kind}</div>
        <div className="name">{symbol.name}</div>
        <div className="sig">{symbol.signature}</div>
        <div className="defined">
          <span className="faint mono">defined at</span>
          <span
            className="path"
            onClick={() => { if (definedPath) onJumpToFile(definedPath); }}
          >
            {symbol.defined.path || symbol.defined.file}:{symbol.defined.line}
          </span>
        </div>
        {symbol.summary && (
          <div className="muted" style={{ marginTop: 8, fontSize: 12, lineHeight: 1.5 }}>
            {symbol.summary}
          </div>
        )}
      </div>

      <div className="rr-stat">
        <div className="stat"><div className="v">{symbol.callers.length}</div><div className="l">total</div></div>
        <div className="stat"><div className="v">{touchedCount}</div><div className="l">in PR</div></div>
        <div className="stat"><div className="v">{untouchedCount}</div><div className="l">untouched</div></div>
        <div className="stat"><div className="v">{testCount}</div><div className="l">tests</div></div>
      </div>

      <div className="rr-callers">
        <div className="rr-section-title">
          <span>Callers</span>
          <span className="ct">{symbol.callers.length}</span>
        </div>
        {symbol.callers.map((c, i) => (
          <div className="caller" key={i} onClick={() => c.path && onJumpToFile(c.path)}>
            <div className="top">
              <span className="path">{c.path}</span>
              <span className="ln">:{c.line || "—"}</span>
            </div>
            <CallsiteContext caller={c} />
            <div className="tags">
              {c.status === "touched" && <span className="tag touched">touched by this PR</span>}
              {c.status === "untouched" && <span className="tag untouched">untouched</span>}
              {c.status === "test" && <span className="tag test">test</span>}
              {c.role === "read" && <span className="tag">reads</span>}
              {c.role === "write" && <span className="tag">writes</span>}
            </div>
          </div>
        ))}

        {symbol.notCallers && symbol.notCallers.length > 0 && (
          <>
            <div className="rr-section-title">
              <span>Adjacent · not via this symbol</span>
              <span className="ct">{symbol.notCallers.length}</span>
            </div>
            {symbol.notCallers.map((c, i) => (
              <div className="caller" key={`nc-${i}`} onClick={() => c.path && onJumpToFile(c.path)}>
                <div className="top">
                  <span className="path">{c.path}</span>
                  <span className="ln">:{c.line}</span>
                </div>
                <CallsiteContext caller={c} />
                <div className="tags">
                  <span className="tag untouched">does not call {symbol.name}</span>
                </div>
                {c.why && (
                  <div className="muted" style={{ fontSize: 11.5, marginTop: 4, lineHeight: 1.45 }}>
                    {c.why}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

type Mode = "code" | "high-level";
interface FlashKey { fileId: string; line?: number; t: number; }

// ── App shell ──────────────────────────────────────────────────
function App({
  pr,
  runtime = DEFAULT_RUNTIME,
  initialReviewState,
  initialReviewStateAvailable,
}: {
  pr: Pr;
  runtime?: Runtime;
  initialReviewState: ReviewState | null;
  initialReviewStateAvailable: boolean;
}) {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const initialReadingMode = pr.readingOrders[0]?.key || "default";
  const initialCodeView = useMemo(() => buildCodeView(pr, initialReadingMode), [pr, initialReadingMode]);

  const [activeSymId, setActiveSymId] = useState<string | null>(null);
  const [activeFileId, setActiveFileId] = useState<string | null>(initialCodeView.files[0]?.id || pr.files[0]?.id || null);
  const reviewStateKey = useMemo(() => `aha:${reviewStateScope(pr)}:review-state`, [pr]);
  const legacyReviewStateStorageKey = useMemo(() => `aha:${pr.number || pr.title}:review-state`, [pr.number, pr.title]);
  const legacyStatusStorageKey = useMemo(() => `aha:${pr.number || pr.title}:decision-status`, [pr.number, pr.title]);
  const startingReviewState = useMemo(
    () => initialReviewStateAvailable
      ? normalizeReviewState(initialReviewState, pr)
      : readLocalReviewState(pr, reviewStateKey, legacyReviewStateStorageKey, legacyStatusStorageKey),
    [initialReviewState, initialReviewStateAvailable, legacyReviewStateStorageKey, legacyStatusStorageKey, pr, reviewStateKey]
  );
  const startingCollapsedFiles = useMemo(() => {
    const next = new Set(startingReviewState.viewed);
    for (const file of pr.files) {
      const signal = pr.reviewSignals.files[fileSignalKey(file)];
      if (isNoiseSignal(signal) && signal && signal.hideByDefault !== false) next.add(fileReviewKey(file));
    }
    return next;
  }, [pr.files, pr.reviewSignals.files, startingReviewState.viewed]);
  const [reviewed, setReviewed] = useState<Set<string>>(() => new Set(startingReviewState.viewed));
  const [viewedFileMap, setViewedFileMap] = useState<Record<string, ViewedFileEntry>>(() => startingReviewState.viewedFiles);
  const [changedViewedFiles, setChangedViewedFiles] = useState<Set<string>>(() => new Set(startingReviewState.changedViewed));
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => startingCollapsedFiles);
  const [panelOpen, setPanelOpen] = useState(false);
  const [leftRailWidth, setLeftRailWidth] = useState(() => readStoredNumber("aha:left-rail-width", defaultLeftRailWidth()));
  const [rightRailWidth, setRightRailWidth] = useState(() => readStoredNumber("aha:right-rail-width", defaultRightRailWidth()));
  // Mode switch: "high-level" (orientation + review decisions) vs "code" (diff reader).
  const [mode, setMode] = useState<Mode>("code");
  // Triage state per decision card. null = open; "accept" | "flag" | "block".
  const [decisionStatus, setDecisionStatus] = useState<StatusMap>(() => startingReviewState.decisions);
  const [readingMode, setReadingMode] = useState(initialReadingMode);
  const [noiseMode, setNoiseMode] = useState<NoiseMode>("focus");
  const [workflowOpen, setWorkflowOpen] = useState(false);
  // Transient flash highlight when jumping from a decision card to a diff line.
  const [flashKey, setFlashKey] = useState<FlashKey | null>(null);
  const [decisionFlashId, setDecisionFlashId] = useState<string | null>(null);
  const hasHydratedPersistRef = useRef(false);
  const skipNextPersistRef = useRef(false);

  const symbol = activeSymId ? pr.symbols[activeSymId] : null;
  const baseCodeView = useMemo(
    () => readingMode === initialReadingMode ? initialCodeView : buildCodeView(pr, readingMode),
    [initialCodeView, initialReadingMode, pr, readingMode]
  );
  const codeView = useMemo(
    () => applyNoiseModeToCodeView(baseCodeView, pr.reviewSignals, noiseMode),
    [baseCodeView, noiseMode, pr.reviewSignals]
  );

  useEffect(() => {
    if (readingMode !== "default" && !pr.readingOrders.some((order) => order.key === readingMode)) {
      const fallbackReadingMode = pr.readingOrders[0]?.key || "default";
      setReadingMode(fallbackReadingMode);
      setActiveFileId(buildCodeView(pr, fallbackReadingMode).files[0]?.id || pr.files[0]?.id || null);
    }
  }, [pr, pr.readingOrders, readingMode]);

  // Apply theme tweak
  useEffect(() => {
    document.body.classList.toggle("theme-dark", t.theme === "dark");
  }, [t.theme]);

  useEffect(() => {
    if (!hasHydratedPersistRef.current) {
      hasHydratedPersistRef.current = true;
      return;
    }
    if (skipNextPersistRef.current) {
      skipNextPersistRef.current = false;
      return;
    }
    const state: PersistedReviewState = {
      schemaVersion: "0.2",
      viewed: Array.from(reviewed),
      viewedFiles: viewedFileMap,
      decisions: decisionStatus,
      updatedAt: new Date().toISOString(),
    };
    persistReviewState(reviewStateKey, state);
  }, [decisionStatus, reviewed, viewedFileMap, reviewStateKey]);

  const onSymbol = useCallback((id: string) => {
    setActiveSymId(id);
    setPanelOpen(true);
  }, []);

  const onJumpToFile = useCallback((fileId: string, line?: number) => {
    const targetFileId = pr._fileAliasById?.[fileId] || fileId;
    // If we're in decisions mode, switch back to code first so the file is
    // mounted in the DOM, then scroll on next frame.
    const doScroll = () => {
      const el = document.getElementById(targetFileId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setActiveFileId(targetFileId);
        // Flash the line / file as the reviewer arrives.
        setFlashKey({ fileId: targetFileId, line, t: Date.now() });
        setTimeout(() => setFlashKey((k) => (k && k.t === flashKey?.t ? null : k)), 1800);
      }
    };
    if (mode !== "code") {
      setMode("code");
      requestAnimationFrame(() => requestAnimationFrame(doScroll));
    } else {
      doScroll();
    }
  }, [mode, flashKey, pr._fileAliasById]);

  const onJumpToDecision = useCallback((decisionId: string) => {
    const doScroll = () => {
      const el = document.getElementById(decisionId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        setDecisionFlashId(decisionId);
        setTimeout(() => setDecisionFlashId((id) => (id === decisionId ? null : id)), 1800);
      }
    };
    setMode("high-level");
    requestAnimationFrame(() => requestAnimationFrame(doScroll));
  }, []);

  const onJumpToOverviewSection = useCallback((sectionId: string) => {
    const el = document.getElementById(sectionId);
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, []);

  const onToggleReviewed = useCallback((file: PackFile) => {
    const key = fileReviewKey(file);
    const shouldScrollToNext = !reviewed.has(key);
    const viewedAt = new Date().toISOString();
    setReviewed(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        setCollapsedFiles((collapsed) => {
          const collapsedNext = new Set(collapsed);
          collapsedNext.add(key);
          return collapsedNext;
        });
      }
      return next;
    });
    setViewedFileMap((prev) => {
      const next = { ...prev };
      if (!shouldScrollToNext) {
        delete next[key];
        return next;
      }
      next[key] = {
        diffFingerprint: file.diffFingerprint || diffFingerprintForFile(file),
        viewedAt,
      };
      return next;
    });
    setChangedViewedFiles((prev) => {
      if (!prev.has(key)) return prev;
      const next = new Set(prev);
      next.delete(key);
      return next;
    });
    if (shouldScrollToNext) {
      requestAnimationFrame(() => requestAnimationFrame(() => scrollToViewedFileHeader(file, centerRef.current)));
    }
  }, [reviewed]);

  const onToggleCollapsed = useCallback((file: PackFile) => {
    const key = fileReviewKey(file);
    setCollapsedFiles(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const setStatus = useCallback((cardId: string, s: TriageStatus | null) => {
    setDecisionStatus((prev) => {
      const next = { ...prev };
      if (s) next[cardId] = s;
      else delete next[cardId];
      return next;
    });
  }, []);

  const resetReviewState = useCallback(() => {
    skipNextPersistRef.current = true;
    setReviewed(new Set());
    setViewedFileMap({});
    setChangedViewedFiles(new Set());
    setDecisionStatus({});
    localStorage.removeItem(reviewStateKey);
    localStorage.removeItem(legacyReviewStateStorageKey);
    localStorage.removeItem(legacyStatusStorageKey);
    fetch("/aha-state.json", { method: "DELETE" }).catch(() => {});
  }, [legacyReviewStateStorageKey, legacyStatusStorageKey, reviewStateKey]);

  const onRailResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = leftRailWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampRailWidth(startWidth + moveEvent.clientX - startX);
      setLeftRailWidth(nextWidth);
      localStorage.setItem("aha:left-rail-width", String(nextWidth));
    };
    const onUp = () => {
      document.body.classList.remove("resizing-rail");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    document.body.classList.add("resizing-rail");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [leftRailWidth]);

  const onRightRailResizeStart = useCallback((event: React.PointerEvent) => {
    event.preventDefault();
    const startX = event.clientX;
    const startWidth = rightRailWidth;

    const onMove = (moveEvent: PointerEvent) => {
      const nextWidth = clampRailWidth(startWidth + startX - moveEvent.clientX);
      setRightRailWidth(nextWidth);
      localStorage.setItem("aha:right-rail-width", String(nextWidth));
    };
    const onUp = () => {
      document.body.classList.remove("resizing-rail");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    document.body.classList.add("resizing-rail");
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }, [rightRailWidth]);

  // Update active file on scroll based on which file header is closest to top
  const centerRef = useRef<HTMLElement | null>(null);
  const briefingRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (mode !== "code") return;
    const root = centerRef.current;
    const briefing = briefingRef.current;
    if (!root || !briefing) return;
    const update = () => {
      root.style.setProperty("--file-head-sticky-top", `${briefing.offsetHeight}px`);
    };
    update();
    const observer = typeof ResizeObserver !== "undefined" ? new ResizeObserver(update) : null;
    observer?.observe(briefing);
    window.addEventListener("resize", update);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [mode, codeView.groups]);

  useEffect(() => {
    if (mode !== "code") return;
    const root = centerRef.current;
    if (!root) return;
    const onScroll = () => {
      const top = root.scrollTop + 150;
      let best = codeView.files[0]?.id || null;
      for (const f of codeView.files) {
        const el = document.getElementById(f.id);
        if (el && el.offsetTop <= top) best = f.id;
      }
      setActiveFileId(best);
    };
    root.addEventListener("scroll", onScroll);
    return () => root.removeEventListener("scroll", onScroll);
  }, [codeView.files, mode]);

  const reviewedCount = reviewed.size;
  const repositoryName = pr.repositoryName || pr.repository?.name || "aha";

  if (pr.files.length === 0) {
    return (
      <div className="app app-onboarding">
        <EmptyOnboarding runtime={runtime} />
      </div>
    );
  }

  return (
    <div className={`app density-${t.density}`}>
      {/* TOPBAR */}
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" />
          <span>aha</span>
        </div>
        <div className="crumbs">
          <span className="repo">{repositoryName}</span>
          <span className="sep">/</span>
          <span className="pr">#{pr.number}</span>
          <span className="sep">·</span>
          <span className="title">{pr.title}</span>
        </div>

        <span className="branch-pill">{pr.branch} → {pr.base}</span>

        {/* Mode switch — High Level orientation vs Code diff reader */}
        <div className="mode-switch">
          <button
            className="mode-tab"
            data-active={mode === "high-level"}
            onClick={() => setMode("high-level")}
            title="Review orientation"
          >
            <span className="mk">◇</span> High Level
          </button>
          <button
            className="mode-tab"
            data-active={mode === "code"}
            onClick={() => setMode("code")}
            title="Read the diff (default)"
          >
            <span className="mk">¶</span> Code
          </button>
        </div>

        <div className="topbar-spacer" />

        <button
          className="workflow-open"
          type="button"
          onClick={() => setWorkflowOpen(true)}
          title="Copy aha commands and AI prompts"
        >
          cmd
        </button>

        <div className="author-bar">
          <span className="mono">{pr.filesChanged} files</span>
          <span className="muted mono">
            <span style={{ color: "var(--pine-ink)" }}>+{pr.added}</span>{" "}
            <span style={{ color: "var(--rose-ink)" }}>−{pr.removed}</span>
          </span>
        </div>

      </header>

      {workflowOpen && <WorkflowModal pr={pr} runtime={runtime} onClose={() => setWorkflowOpen(false)} />}

      <div
        className={`workspace ${panelOpen ? "" : "no-right"} mode-${mode}`}
        style={{
          "--left-rail-width": `${leftRailWidth}px`,
          "--right-rail-width": `${rightRailWidth}px`,
        } as React.CSSProperties}
      >
        {mode === "code" ? (
          <LeftRail
            files={codeView.files}
            groups={codeView.groups}
            activeId={activeFileId}
            reviewedSet={reviewed}
            changedViewedSet={changedViewedFiles}
            onJump={onJumpToFile}
            readingOrders={pr.readingOrders}
            readingMode={readingMode}
            onReadingModeChange={setReadingMode}
            reviewSignals={pr.reviewSignals}
            noiseMode={noiseMode}
            onNoiseModeChange={setNoiseMode}
          />
        ) : mode === "high-level" ? (
          <HighLevelLeftRail
            overview={pr.overview}
            decisions={pr.decisions}
            statusMap={decisionStatus}
            onJump={onJumpToOverviewSection}
          />
        ) : (
          null
        )}

        <div
          className="workspace-rail-resizer"
          role="separator"
          aria-orientation="vertical"
          title="Resize sidebar"
          onPointerDown={onRailResizeStart}
        />

        <div
          className="workspace-rail-resizer right"
          role="separator"
          aria-orientation="vertical"
          title="Resize call sites sidebar"
          onPointerDown={onRightRailResizeStart}
        />

        <main className="center" ref={centerRef}>
          {mode === "high-level" ? (
            <HighLevelView
              overview={pr.overview}
              decisions={pr.decisions}
              files={pr.files}
              statusMap={decisionStatus}
              setStatus={setStatus}
              flashId={decisionFlashId}
              onSymbol={onSymbol}
              onFile={onJumpToFile}
              onDecision={onJumpToDecision}
            />
          ) : (
            <>
              {/* Briefing strip — minimal, code-author-voice */}
              <div className="briefing-strip" ref={briefingRef}>
                <div className="what">
                  <div className="icon">¶</div>
                  <div>
                    <h1>{pr.title}</h1>
                    <div className="desc">{pr.oneLiner}</div>
                  </div>
                </div>
              </div>

              <div className="diff-doc">
                {codeView.files.map((f, i) => (
                  <FileCard
                    key={f.id}
                    file={f}
                    order={i + 1}
                    signal={pr.reviewSignals.files[fileSignalKey(f)]}
                    patterns={pr.reviewSignals.patterns}
                    symbols={pr.symbols}
                    noiseMode={noiseMode}
                    onSymbol={onSymbol}
                    activeSym={activeSymId}
                    reviewed={reviewed.has(fileReviewKey(f))}
                    onToggleReviewed={onToggleReviewed}
                    collapsed={collapsedFiles.has(fileReviewKey(f))}
                    onToggleCollapsed={onToggleCollapsed}
                    scrollRoot={centerRef}
                    onJumpToFile={onJumpToFile}
                    onJumpToSymbol={onSymbol}
                    flash={!!flashKey && flashKey.fileId === f.id}
                  />
                ))}

                <div style={{ marginTop: 28, padding: 18, border: "1px dashed var(--line-2)", borderRadius: 10, textAlign: "center", color: "var(--ink-3)" }}>
                  You've reached the end of {codeView.files.length} files. <strong>{reviewedCount}</strong> marked as reviewed.{" "}
                  <button className="btn primary" style={{ marginLeft: 12 }}>Submit review</button>
                </div>
              </div>
            </>
          )}
        </main>

        <aside className={`rail-right ${panelOpen ? "" : "collapsed"}`}>
          {panelOpen ? (
            <CallSitesPanel
              symbol={symbol}
              onClose={() => setPanelOpen(false)}
              onJumpToFile={onJumpToFile}
            />
          ) : (
            <button className="rr-toggle" onClick={() => setPanelOpen(true)} title="Open call sites panel">
              Call sites →
            </button>
          )}
        </aside>
      </div>

      {/* Tweaks panel */}
      <TweaksPanel title="Tweaks">
        <TweakSection label="Appearance">
          <TweakRadio
            label="Theme"
            value={t.theme}
            options={["light", "dark"]}
            onChange={(v) => setTweak("theme", v)}
          />
        </TweakSection>
        <TweakSection label="AI margin notes">
          <TweakToggle
            label="Show inline notes"
            value={t.showAiNotes}
            onChange={(v) => {
              setTweak("showAiNotes", v);
              document.body.classList.toggle("hide-ai-notes", !v);
            }}
          />
        </TweakSection>
        <TweakSection label="Reading">
          <TweakRadio
            label="Density"
            value={t.density}
            options={["cozy", "default", "dense"]}
            onChange={(v) => setTweak("density", v)}
          />
        </TweakSection>
        <TweakSection label="Review state">
          <button className="tweak-button" type="button" onClick={resetReviewState}>
            Reset viewed/actions
          </button>
        </TweakSection>
      </TweaksPanel>
    </div>
  );
}

interface Tweaks {
  theme: string;
  showAiNotes: boolean;
  density: string;
}

const TWEAK_DEFAULTS: Tweaks = /*EDITMODE-BEGIN*/{
  "theme": "light",
  "showAiNotes": true,
  "density": "default"
}/*EDITMODE-END*/;

interface ReviewStateResult {
  available: boolean;
  data: unknown;
}

type LoaderState =
  | { status: "loading" }
  | { status: "ready"; pr: Pr; runtime: Runtime; reviewState: ReviewState | null; reviewStateAvailable: boolean }
  | { status: "error"; error: Error };

function AhaLoader() {
  const [state, setState] = useState<LoaderState>({ status: "loading" });

  useEffect(() => {
    let alive = true;
    const packRequest = fetch("/aha.json", { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Failed to load aha.json (${res.status})`);
        return res.json();
      });
    const stateRequest: Promise<ReviewStateResult> = fetch("/aha-state.json", { cache: "no-store" })
      .then((res) => (res.ok
        ? res.json().then((data: unknown) => ({ available: true, data }))
        : { available: false, data: null }))
      .catch(() => ({ available: false, data: null }));
    const runtimeRequest = fetch("/aha-runtime.json", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : DEFAULT_RUNTIME))
      .catch(() => DEFAULT_RUNTIME);

    Promise.all([packRequest, stateRequest, runtimeRequest])
      .then(([pack, reviewStateResult, runtime]) => {
        const pr = normalizeAhaPack(pack);
        if (alive) {
          setState({
            status: "ready",
            pr,
            runtime: normalizeRuntime(runtime),
            reviewState: reviewStateResult.available ? normalizeReviewState(reviewStateResult.data, pr) : null,
            reviewStateAvailable: reviewStateResult.available,
          });
        }
      })
      .catch((error: unknown) => {
        if (alive) {
          setState({
            status: "error",
            error: error instanceof Error ? error : new Error(String(error)),
          });
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  if (state.status === "loading") {
    return <div className="load-state">Loading aha.json…</div>;
  }

  if (state.status === "error") {
    return (
      <div className="load-state error">
        <strong>Could not load aha.json.</strong>
        <span>{state.error.message}</span>
      </div>
    );
  }

  return (
    <App
      pr={state.pr}
      runtime={state.runtime}
      initialReviewState={state.reviewState}
      initialReviewStateAvailable={state.reviewStateAvailable}
    />
  );
}

function normalizeRuntime(runtime: unknown): Runtime {
  const r = runtime as { ahaCli?: unknown } | null | undefined;
  const ahaCli = typeof r?.ahaCli === "string" && r.ahaCli.trim()
    ? r.ahaCli.trim()
    : DEFAULT_RUNTIME.ahaCli;
  return { ahaCli };
}

function normalizeAhaPack(pack: any): Pr {
  const deduped = dedupeFilesByPath(Array.isArray(pack.files) ? pack.files : []);
  const files = deduped.files.map((file) => ({
    ...file,
    diffFingerprint: typeof file.diffFingerprint === "string" && file.diffFingerprint
      ? file.diffFingerprint
      : diffFingerprintForFile(file),
  }));
  const fileAliasById = deduped.fileAliasById;
  const decisions = pack.decisions || { categories: [], cards: [], questions: [] };
  const canonicalFileId = canonicalFileIdFor(files, fileAliasById);
  const decisionCards = normalizeDecisionCards(decisions.cards, canonicalFileId);
  const readingOrders = normalizeReadingOrders(pack.readingOrders, files, fileAliasById);
  const reviewSignals = normalizeReviewSignals(pack.reviewSignals, files, fileAliasById);
  const normalizedDecisions = {
    categories: Array.isArray(decisions.categories) ? decisions.categories : [],
    cards: decisionCards,
    questions: normalizeDecisionQuestions(decisions.questions, canonicalFileId),
  };
  return {
    ...pack,
    schemaVersion: pack.schemaVersion || "0.1",
    files,
    _fileAliasById: fileAliasById,
    symbols: normalizeSymbols(pack.symbols, canonicalFileId),
    groups: Array.isArray(pack.groups) ? pack.groups : [],
    readingOrders,
    overview: normalizeOverview(pack.overview, canonicalFileId),
    reviewSignals,
    decisions: normalizedDecisions,
    repositoryName: pack.repositoryName || pack.repoName || pack.repository?.name || "",
    author: pack.author || { name: "Unknown", initials: "?" },
    filesChanged: pack.filesChanged ?? files.length,
    added: pack.added ?? files.reduce((sum, file) => sum + (file.add || 0), 0),
    removed: pack.removed ?? files.reduce((sum, file) => sum + (file.del || 0), 0),
  };
}

function normalizeReviewSignals(reviewSignals: any, files: PackFile[], fileAliasById: Record<string, string> = {}): ReviewSignals {
  const fileById = new Map(files.map((file) => [file.id, file]));
  const fileByPath = new Map(files.map((file) => [file.path, file]));
  const patterns = normalizeReviewSignalPatterns(reviewSignals?.patterns);
  const inputFiles: Record<string, any> = reviewSignals?.files && typeof reviewSignals.files === "object" ? reviewSignals.files : {};
  const normalizedFiles: Record<string, FileSignal> = {};
  for (const [fileKey, signal] of Object.entries(inputFiles)) {
    const aliasPath = fileAliasById[fileKey];
    const file = fileByPath.get(fileKey) || fileById.get(fileKey) || (aliasPath ? fileByPath.get(aliasPath) : null);
    if (!file || !signal || typeof signal !== "object") continue;
    const canonicalKey = fileSignalKey(file);
    const normalizedSignal: FileSignal = {
      relevance: normalizeSignalRelevance(signal.relevance, "normal"),
      source: ["ai", "deterministic", "manual"].includes(signal.source) ? signal.source : "ai",
      hideByDefault: signal.hideByDefault !== false,
      categories: Array.isArray(signal.categories) ? signal.categories.filter(Boolean) : [],
      reason: typeof signal.reason === "string" ? signal.reason : "",
      ranges: normalizeSignalRanges(signal.ranges, patterns, file.path, fileByPath, fileAliasById),
    };
    mergeNormalizedSignal(normalizedFiles, canonicalKey, normalizedSignal);
    for (const range of normalizedSignal.ranges) {
      if (!isContextSignal(range)) continue;
      for (const path of signalRangePaths(range, file.path)) {
        if (path === canonicalKey || !fileByPath.has(path)) continue;
        mergeNormalizedSignal(normalizedFiles, path, {
          relevance: "normal",
          source: normalizedSignal.source,
          hideByDefault: false,
          categories: [],
          reason: "",
          ranges: [range],
        });
      }
    }
  }
  const noiseFiles = Object.values(normalizedFiles).filter(isNoiseSignal).length;
  const noiseLines = Object.values(normalizedFiles)
    .flatMap((signal) => signal.ranges || [])
    .filter((range) => isNoiseSignal(range) && range.hideByDefault !== false)
    .reduce((sum: number, range) => sum + rangeLineCount(range), 0);
  return {
    version: Number(reviewSignals?.version) || 1,
    patterns,
    summary: {
      noiseFiles,
      noiseLines,
      primaryFiles: Math.max(0, files.length - noiseFiles),
    },
    files: normalizedFiles,
  };
}

type IdentityFileId = (id: string) => string | null;
const identityFileId: IdentityFileId = (id) => id;

function normalizeSymbols(symbols: any, canonicalFileId: IdentityFileId = identityFileId): SymbolMap {
  if (!symbols || typeof symbols !== "object") return {};
  const normalized: SymbolMap = {};
  for (const [id, symbol] of Object.entries<any>(symbols)) {
    if (!symbol || typeof symbol !== "object") continue;
    normalized[id] = {
      ...symbol,
      defined: normalizeSymbolLocation(symbol.defined, canonicalFileId),
      callers: Array.isArray(symbol.callers)
        ? symbol.callers.map((caller: any) => normalizeSymbolLocation(caller, canonicalFileId))
        : [],
      notCallers: Array.isArray(symbol.notCallers)
        ? symbol.notCallers.map((caller: any) => normalizeSymbolLocation(caller, canonicalFileId))
        : [],
    };
  }
  return normalized;
}

function normalizeSymbolLocation(location: any, canonicalFileId: IdentityFileId = identityFileId): any {
  if (!location || typeof location !== "object") return location;
  const rawPath = typeof location.path === "string"
    ? location.path
    : typeof location.fileId === "string"
      ? location.fileId
      : typeof location.file === "string"
        ? location.file
        : "";
  if (!rawPath) return location;
  const path = canonicalFileId(rawPath) || rawPath;
  const next = { ...location, path };
  delete next.fileId;
  delete next.file;
  return next;
}

function mergeNormalizedSignal(target: Record<string, FileSignal>, key: string, signal: FileSignal): void {
  if (!target[key]) {
    target[key] = { ...signal, ranges: [] };
  }
  const existing = target[key];
  existing.ranges ||= [];
  const seen = new Set(existing.ranges.map((range) => range.id));
  for (const range of signal.ranges || []) {
    if (seen.has(range.id)) continue;
    existing.ranges.push(range);
    seen.add(range.id);
  }
}

function signalRangePaths(range: SignalRange, ownerPath: string): Set<string> {
  const paths = new Set<string>();
  for (const side of ["left", "right"] as const) {
    const anchor = range?.anchor?.[side];
    if (anchor) paths.add(anchor.path || ownerPath);
  }
  return paths;
}

function normalizeReviewSignalPatterns(patterns: any): Record<string, ReviewSignalPattern> {
  if (!patterns || typeof patterns !== "object" || Array.isArray(patterns)) return {};
  const normalized: Record<string, ReviewSignalPattern> = {};
  for (const [id, pattern] of Object.entries<any>(patterns)) {
    if (!id || !pattern || typeof pattern !== "object" || Array.isArray(pattern)) continue;
    if (pattern.id != null && pattern.id !== id) continue;
    if (typeof pattern.label !== "string" || !pattern.label.trim()) continue;
    normalized[id] = {
      id,
      label: pattern.label,
      source: ["user", "ai"].includes(pattern.source) ? pattern.source : "ai",
      description: typeof pattern.description === "string" ? pattern.description : "",
    };
  }
  return normalized;
}

function normalizeSignalRanges(
  ranges: any,
  patterns: Record<string, ReviewSignalPattern> = {},
  ownerPath = "",
  fileByPath: Map<string, PackFile> = new Map(),
  fileAliasById: Record<string, string> = {},
): SignalRange[] {
  if (!Array.isArray(ranges)) return [];
  return ranges
    .filter((range: any) => range && typeof range === "object")
    .map((range: any, index: number): SignalRange => {
      const patternId = typeof range.patternId === "string" && patterns[range.patternId] ? range.patternId : undefined;
      return {
        id: range.id || `noise-range-${index + 1}`,
        relevance: normalizeSignalRelevance(range.relevance, "noise"),
        source: ["ai", "deterministic", "manual"].includes(range.source) ? range.source : "ai",
        kind: range.kind || range.categories?.[0] || "likely-noise",
        hideByDefault: range.hideByDefault !== false,
        reason: typeof range.reason === "string" ? range.reason : "",
        scope: normalizeSignalScope(range.scope),
        ...(patternId ? { patternId } : {}),
        anchor: normalizeRangeAnchor(range.anchor, ownerPath, fileByPath, fileAliasById),
      };
    });
}

function normalizeSignalRelevance(value: unknown, fallback: Relevance): Relevance {
  if (value === "noise" || value === "normal" || value === "context") return value;
  if (value === "low") return "normal";
  return fallback;
}

function normalizeSignalScope(scope: any): SignalScope | null {
  if (!scope || typeof scope !== "object" || Array.isArray(scope)) return null;
  return {
    before: typeof scope.before === "string" ? scope.before : "",
    after: typeof scope.after === "string" ? scope.after : "",
  };
}

function normalizeRangeAnchor(
  anchor: any,
  ownerPath = "",
  fileByPath: Map<string, PackFile> = new Map(),
  fileAliasById: Record<string, string> = {},
): RangeAnchor {
  let left = normalizeSideAnchor(anchor?.left, ownerPath, fileByPath, fileAliasById);
  let right = normalizeSideAnchor(anchor?.right, ownerPath, fileByPath, fileAliasById);
  const isCrossFile = [left, right].some((side) => side?.path && side.path !== ownerPath);
  if (isCrossFile && ownerPath) {
    if (left && !left.path) left = { ...left, path: ownerPath };
    if (right && !right.path) right = { ...right, path: ownerPath };
  }
  return { left, right };
}

function normalizeSideAnchor(
  anchor: any,
  ownerPath = "",
  fileByPath: Map<string, PackFile> = new Map(),
  fileAliasById: Record<string, string> = {},
): SideAnchor | null {
  if (!anchor) return null;
  const start = Number(anchor.start);
  const end = Number(anchor.end ?? anchor.start);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const rawPath = typeof anchor.path === "string" ? anchor.path : "";
  const aliasPath = fileAliasById[rawPath];
  const path = rawPath && fileByPath.has(rawPath) ? rawPath : aliasPath && fileByPath.has(aliasPath) ? aliasPath : "";
  return path && path !== ownerPath ? { path, start, end } : { start, end };
}

function rangeLineCount(range: SignalRange): number {
  const counts = (["left", "right"] as const).map((side) => {
    const anchor = range.anchor?.[side];
    if (!anchor) return 0;
    return Math.abs(anchor.end - anchor.start) + 1;
  });
  return Math.max(...counts, 0);
}

function normalizeOverview(overview: any, canonicalFileId: IdentityFileId = identityFileId): Overview | null {
  if (!overview || typeof overview !== "object") return null;
  return {
    mentalModelDelta: normalizeRichText(overview.mentalModelDelta, canonicalFileId),
    systemMap: normalizeSystemMap(overview.systemMap, canonicalFileId),
    modelDeltas: Array.isArray(overview.modelDeltas)
      ? overview.modelDeltas.map((item: any, index: number) => ({
        id: normalizeOverviewItemId(item, "model-delta", index),
        title: normalizeRichText(item?.title, canonicalFileId),
        before: normalizeRichText(item?.before, canonicalFileId),
        after: normalizeRichText(item?.after, canonicalFileId),
        refs: normalizeRefs(item?.refs, canonicalFileId),
      })).filter((item: any) => item.title || item.before || item.after || item.refs.length)
      : [],
    flows: Array.isArray(overview.flows)
      ? overview.flows.map((flow: any) => ({
        title: flow?.title || "",
        kind: flow?.kind || "before_after_ascii",
        lines: normalizeRichLines(flow?.lines, canonicalFileId),
        before: normalizeRichLines(flow?.before, canonicalFileId),
        after: normalizeRichLines(flow?.after, canonicalFileId),
      })).filter((flow: any) => flow.lines.length || flow.before.length || flow.after.length)
      : [],
    assumptions: Array.isArray(overview.assumptions)
      ? overview.assumptions.map((item: any, index: number) => ({
        id: normalizeOverviewItemId(item, "assumption", index),
        text: normalizeRichText(item?.text, canonicalFileId),
        refs: normalizeRefs(item?.refs, canonicalFileId),
      }))
      : [],
    hotspots: Array.isArray(overview.hotspots)
      ? overview.hotspots.map((item: any, index: number) => ({
        id: normalizeOverviewItemId(item, "hotspot", index),
        title: normalizeRichText(item?.title, canonicalFileId),
        why: normalizeRichText(item?.why, canonicalFileId),
        refs: normalizeRefs(item?.refs, canonicalFileId),
      }))
      : [],
  };
}

function normalizeSystemMap(systemMap: any, canonicalFileId: IdentityFileId = identityFileId): SystemMap | null {
  if (!systemMap || typeof systemMap !== "object" || Array.isArray(systemMap)) return null;
  const lines = normalizeRichLines(systemMap.lines, canonicalFileId);
  const refs = normalizeRefs(systemMap.refs, canonicalFileId);
  const title = typeof systemMap.title === "string" && systemMap.title.trim() ? systemMap.title.trim() : "Affected system";
  const kind = typeof systemMap.kind === "string" && systemMap.kind.trim() ? systemMap.kind.trim() : "ascii";
  if (!lines.length && !refs.length) return null;
  return { title, kind, lines, refs };
}

function normalizeOverviewItemId(item: any, kind: string, index: number): string {
  if (typeof item?.id === "string" && item.id.trim()) return item.id.trim();
  return `overview-${kind}-${index + 1}`;
}

function normalizeRichText(value: any, canonicalFileId: IdentityFileId = identityFileId): RichTextValue {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((part) => normalizeRichPart(part, canonicalFileId)).filter(Boolean) as RichPart[];
  return "";
}

function normalizeRichLines(lines: any, canonicalFileId: IdentityFileId = identityFileId): RichTextValue[] {
  if (!Array.isArray(lines)) return [];
  return lines.map((line) => normalizeRichText(line, canonicalFileId)).filter((line) => line !== "");
}

function normalizeRefs(refs: any, canonicalFileId: IdentityFileId = identityFileId): RichRef[] {
  if (!Array.isArray(refs)) return [];
  return refs
    .map((ref: any) => normalizeRef(ref, canonicalFileId))
    .filter(Boolean) as RichRef[];
}

function normalizeRichPart(part: any, canonicalFileId: IdentityFileId = identityFileId): RichPart | null {
  if (typeof part === "string") return part;
  return normalizeRef(part, canonicalFileId);
}

function normalizeRef(ref: any, canonicalFileId: IdentityFileId = identityFileId): RichRef | null {
  if (!ref || !["symbol", "file", "decision"].includes(ref.type) || typeof ref.id !== "string") return null;
  if (ref.type !== "file") return ref;
  const id = canonicalFileId(ref.id);
  return id ? { ...ref, id } : null;
}

function normalizeDecisionCards(cards: any, canonicalFileId: IdentityFileId = identityFileId): any[] {
  if (!Array.isArray(cards)) return [];
  const used = new Set<string>();
  return cards.map((card: any, index: number) => {
    const fallback = `dc-${slugId(card?.category || "decision")}-${index + 1}`;
    const rawId = typeof card?.id === "string" && card.id.trim() ? card.id.trim() : fallback;
    let id = rawId;
    let suffix = 2;
    while (used.has(id)) {
      id = `${rawId}-${suffix}`;
      suffix += 1;
    }
    used.add(id);
    return {
      ...card,
      id,
      sections: normalizeDecisionSections(card?.sections, canonicalFileId),
    };
  });
}

function normalizeDecisionSections(sections: any, canonicalFileId: IdentityFileId = identityFileId): any {
  if (!Array.isArray(sections)) return [];
  return sections.map((section: any) => {
    if (!section || typeof section !== "object") return section;
    return {
      ...section,
      items: Array.isArray(section.items)
        ? section.items.map((item: any) => normalizeDecisionJump(item, canonicalFileId))
        : section.items,
    };
  });
}

function normalizeDecisionQuestions(questions: any, canonicalFileId: IdentityFileId = identityFileId): any[] {
  if (!Array.isArray(questions)) return [];
  return questions.map((question: any) => ({
    ...question,
    jumps: Array.isArray(question?.jumps)
      ? question.jumps.map((jump: any) => normalizeDecisionJump(jump, canonicalFileId))
      : question?.jumps,
  }));
}

function normalizeDecisionJump(item: any, canonicalFileId: IdentityFileId = identityFileId): any {
  if (!item || typeof item !== "object") return item;
  const rawPath = typeof item.path === "string" ? item.path : typeof item.fileId === "string" ? item.fileId : "";
  if (!rawPath) return item;
  const path = canonicalFileId(rawPath);
  if (!path) return item;
  const next = { ...item, path };
  delete next.fileId;
  return next;
}

function slugId(value: unknown): string {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function canonicalFileIdFor(files: PackFile[], fileAliasById: Record<string, string> = {}): CanonicalFileId {
  const fileIds = new Set(files.map((file) => file.id));
  const idByPath = new Map(files.map((file) => [file.path, file.id]));
  return (value: string) => {
    if (fileIds.has(value)) return value;
    if (idByPath.has(value)) return idByPath.get(value) ?? null;
    const aliasPath = fileAliasById[value];
    return aliasPath ? (idByPath.get(aliasPath) ?? null) : null;
  };
}

function dedupeFilesByPath(files: any[]): { files: PackFile[]; fileAliasById: Record<string, string> } {
  const byPath = new Map<string, PackFile>();
  const merged: PackFile[] = [];
  const fileAliasById: Record<string, string> = {};
  for (const [index, file] of files.entries()) {
    const path = file.path || file.id || `file-${index + 1}`;
    const id = file.id || `f-${index + 1}`;
    const existing = byPath.get(path);
    if (!existing) {
      const next = {
        ...file,
        id: path,
        path,
        notes: Array.isArray(file.notes) ? file.notes : [],
        diff: Array.isArray(file.diff) ? file.diff : [],
      };
      fileAliasById[id] = path;
      fileAliasById[path] = path;
      byPath.set(path, next);
      merged.push(next);
      continue;
    }
    fileAliasById[id] = existing.path;
    existing.add = (existing.add || 0) + (file.add || 0);
    existing.del = (existing.del || 0) + (file.del || 0);
    existing.diff.push(...(Array.isArray(file.diff) ? file.diff : []));
    existing.notes.push(...(Array.isArray(file.notes) ? file.notes : []));
  }
  return { files: merged, fileAliasById };
}

function diffFingerprintForFile(file: any): string {
  const payload = JSON.stringify({
    path: file?.path || "",
    tag: file?.tag || "",
    add: Number(file?.add) || 0,
    del: Number(file?.del) || 0,
    diff: Array.isArray(file?.diff)
      ? file.diff.map((line: DiffLine) => ({
        k: line.k,
        L: line.L ?? null,
        R: line.R ?? null,
        c: plainDiffContent(line.c),
      }))
      : [],
  });
  return `df1-${hashString(payload)}`;
}

function plainDiffContent(content: DiffContent | undefined): string {
  if (!Array.isArray(content)) return String(content ?? "");
  return content.map((part) => {
    if (typeof part === "string") return part;
    if (part && typeof part === "object" && typeof part.label === "string") return part.label;
    return "";
  }).join("");
}

function hashString(value: string): string {
  let h1 = 0xdeadbeef ^ value.length;
  let h2 = 0x41c6ce57 ^ value.length;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

function fileReviewKey(file: PackFile): string {
  return file?.path || file?.id;
}

function fileSignalKey(file: PackFile): string {
  return file?.path || file?.id;
}

function scrollToViewedFileHeader(file: PackFile, root: HTMLElement | null): void {
  if (!root || !file) return;
  const el = document.getElementById(file.id);
  if (!el) return;
  const stickyOffset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--file-head-sticky-top")) || 0;
  const targetTop = el.offsetTop - stickyOffset - 8;
  root.scrollTo({
    top: Math.max(0, targetTop),
    behavior: "smooth",
  });
}

function buildCodeView(pr: Pr, readingMode: string): CodeView {
  const fileById = new Map(pr.files.map((file) => [file.id, file]));
  const selectedOrder = pr.readingOrders.find((order) => order.key === readingMode);
  if (!selectedOrder) {
    return buildFilesystemCodeView(pr.files);
  }

  const used = new Set<string>();
  const groups: CodeViewGroup[] = selectedOrder.groups.map((group) => {
    const groupFiles = group.files
      .map((fileId) => fileById.get(fileId))
      .filter((file): file is PackFile => Boolean(file))
      .filter((file) => {
        if (used.has(file.id)) return false;
        used.add(file.id);
        return true;
      });
    return { ...group, files: groupFiles };
  });
  const missingFiles = pr.files.filter((file) => !used.has(file.id));
  if (missingFiles.length > 0) {
    groups.push({
      key: "remaining",
      label: "Remaining files",
      why: "files not placed in the selected reading order",
      files: missingFiles,
    });
  }
  return {
    files: groups.flatMap((group) => group.files),
    groups,
  };
}

function buildFilesystemCodeView(files: PackFile[]): CodeView {
  const sortedFiles = [...files].sort((a, b) => String(a.path || "").localeCompare(String(b.path || ""), undefined, {
    numeric: true,
    sensitivity: "base",
  }));
  const groupMap = new Map<string, CodeViewGroup>();
  for (const file of sortedFiles) {
    const folder = dirname(file.path) || "Root";
    if (!groupMap.has(folder)) {
      groupMap.set(folder, {
        key: `fs:${folder}`,
        label: folder,
        why: "",
        files: [],
      });
    }
    groupMap.get(folder)!.files.push(file);
  }
  const groups = Array.from(groupMap.values()).map((group) => ({
    ...group,
    why: `${group.files.length} ${group.files.length === 1 ? "file" : "files"}`,
  }));
  return { files: sortedFiles, groups };
}

function applyNoiseModeToCodeView(codeView: CodeView, reviewSignals: ReviewSignals | undefined, noiseMode: NoiseMode): CodeView {
  if (noiseMode !== "focus") return codeView;
  const isVisible = (file: PackFile) => !isNoiseSignal(reviewSignals?.files?.[fileSignalKey(file)]);
  const groups = codeView.groups
    .map((group) => ({
      ...group,
      files: group.files.filter(isVisible),
    }))
    .filter((group) => group.files.length > 0);
  return {
    files: codeView.files.filter(isVisible),
    groups,
  };
}

function normalizeReadingOrders(readingOrders: any, files: PackFile[], fileAliasById: Record<string, string> = {}): ReadingOrder[] {
  if (!Array.isArray(readingOrders)) return [];
  const fileIds = new Set(files.map((file) => file.id));
  const idByPath = new Map(files.map((file) => [file.path, file.id]));
  const canonicalFileId = (value: string): string | null => {
    if (fileIds.has(value)) return value;
    const aliasPath = fileAliasById[value];
    return aliasPath ? (idByPath.get(aliasPath) ?? null) : null;
  };
  return readingOrders
    .map((order: any, index: number): ReadingOrder => {
      const key = order?.key || `reading-order-${index + 1}`;
      const groups = Array.isArray(order?.groups) ? order.groups : [];
      return {
        key,
        label: order?.label || "AI reading order",
        why: order?.why || "low-friction path through the files",
        groups: groups.map((group: any, groupIndex: number) => ({
          key: group?.key || `${key}-${groupIndex + 1}`,
          label: group?.label || `Step ${groupIndex + 1}`,
          why: group?.why || "",
          files: Array.isArray(group?.files)
            ? Array.from(new Set(group.files.map(canonicalFileId).filter(Boolean))) as string[]
            : [],
        })),
      };
    })
    .filter((order) => order.groups.some((group) => group.files.length > 0));
}

function readStoredObject(key: string): Record<string, any> {
  try {
    return JSON.parse(localStorage.getItem(key) || "{}") || {};
  } catch {
    return {};
  }
}

function readStoredNumber(key: string, fallback: number): number {
  const raw = localStorage.getItem(key);
  if (raw == null) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? clampRailWidth(value) : fallback;
}

function defaultLeftRailWidth(): number {
  if (typeof window === "undefined") return 300;
  if (window.innerWidth <= 980) return 230;
  if (window.innerWidth <= 1180) return 260;
  return 300;
}

function defaultRightRailWidth(): number {
  if (typeof window === "undefined") return 340;
  if (window.innerWidth <= 1180) return 320;
  return 340;
}

function clampRailWidth(value: number): number {
  if (typeof window === "undefined") return Math.max(220, Math.min(460, value));
  const max = Math.min(520, Math.max(260, Math.floor(window.innerWidth * 0.5)));
  const min = window.innerWidth <= 980 ? 200 : 220;
  return Math.max(min, Math.min(max, Math.round(value)));
}

interface CanonicalReviewLookup {
  fileIds: Set<string>;
  filePaths: Set<string>;
  pathById: Map<string, string>;
}

function normalizeReviewState(input: any, pr: Pr): ReviewState {
  const fileIds = new Set(pr.files.map((file) => file.id));
  const filePaths = new Set(pr.files.map((file) => file.path));
  const filesByPath = new Map(pr.files.map((file) => [fileReviewKey(file), file]));
  const pathById = new Map<string, string>([
    ...pr.files.map((file) => [file.id, file.path] as [string, string]),
    ...Object.entries(pr._fileAliasById || {}),
  ]);
  const lookup: CanonicalReviewLookup = { fileIds, filePaths, pathById };
  const actionIds = new Set<string>([
    ...pr.decisions.cards.map((card) => card.id),
    ...(pr.overview?.assumptions || []).map((item) => item.id),
    ...(pr.overview?.hotspots || []).map((item) => item.id),
  ].filter(Boolean));
  const viewedFiles: Record<string, ViewedFileEntry> = {};
  const viewed = new Set<string>();
  const changedViewed = new Set<string>();
  const legacyViewed = Array.isArray(input?.viewed)
    ? input.viewed.map((value: unknown) => canonicalReviewPath(value, lookup)).filter((p: string | null): p is string => Boolean(p))
    : [];
  const inputViewedFiles: Record<string, any> = input?.viewedFiles && typeof input.viewedFiles === "object" ? input.viewedFiles : {};
  for (const [rawFileId, entry] of Object.entries(inputViewedFiles)) {
    const filePath = canonicalReviewPath(rawFileId, lookup);
    const file = filePath ? filesByPath.get(filePath) : null;
    if (!file || !filePath || !entry || typeof entry !== "object") continue;
    const diffFingerprint = typeof entry.diffFingerprint === "string" ? entry.diffFingerprint : "";
    if (!diffFingerprint) continue;
    viewedFiles[filePath] = {
      diffFingerprint,
      viewedAt: typeof entry.viewedAt === "string" ? entry.viewedAt : "",
    };
    if (diffFingerprint === (file.diffFingerprint || diffFingerprintForFile(file))) {
      viewed.add(filePath);
    } else {
      changedViewed.add(filePath);
    }
  }
  for (const filePath of legacyViewed) {
    if (viewedFiles[filePath]) continue;
    const file = filesByPath.get(filePath);
    if (!file) continue;
    viewed.add(filePath);
    viewedFiles[filePath] = {
      diffFingerprint: file.diffFingerprint || diffFingerprintForFile(file),
      viewedAt: typeof input?.updatedAt === "string" ? input.updatedAt : "",
    };
  }
  const decisions: Record<string, TriageStatus> = {};
  if (input?.decisions && typeof input.decisions === "object") {
    for (const [id, status] of Object.entries(input.decisions)) {
      if (actionIds.has(id) && (status === "accept" || status === "flag" || status === "block")) {
        decisions[id] = status;
      }
    }
  }
  return { viewed: Array.from(viewed), viewedFiles, changedViewed: Array.from(changedViewed), decisions };
}

function readLocalReviewState(pr: Pr, reviewStateKey: string, legacyReviewStateStorageKey: string, legacyStatusStorageKey: string): ReviewState {
  const primaryState = readStoredObject(reviewStateKey);
  const legacyState = legacyReviewStateStorageKey !== reviewStateKey ? readStoredObject(legacyReviewStateStorageKey) : {};
  const state = hasStoredReviewState(primaryState) ? primaryState : legacyState;
  const legacyDecisions = readStoredObject(legacyStatusStorageKey);
  return normalizeReviewState({
    viewed: state.viewed,
    viewedFiles: state.viewedFiles,
    decisions: { ...legacyDecisions, ...(state.decisions || {}) },
    updatedAt: state.updatedAt,
  }, pr);
}

function hasStoredReviewState(state: any): boolean {
  return Array.isArray(state?.viewed) || (state?.viewedFiles && typeof state.viewedFiles === "object") || (state?.decisions && typeof state.decisions === "object");
}

function canonicalReviewPath(value: unknown, { fileIds, filePaths, pathById }: CanonicalReviewLookup): string | null {
  if (typeof value !== "string") return null;
  if (filePaths.has(value)) return value;
  if (fileIds.has(value) || pathById.has(value)) return pathById.get(value) ?? null;
  return null;
}

function reviewStateScope(pr: Pr): string {
  const url = typeof pr.url === "string" && pr.url ? pr.url : extractUrl(pr.oneLiner);
  const raw = [
    url,
    pr.number || "",
    pr.branch || "",
    pr.base || "",
    pr.title || "",
  ].filter(Boolean).join("|") || "unknown";
  return slugForStorage(raw);
}

function extractUrl(value: unknown): string {
  return String(value || "").match(/https?:\/\/\S+/)?.[0] || "";
}

function slugForStorage(value: unknown): string {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 160) || "unknown";
}

function persistReviewState(key: string, state: PersistedReviewState): void {
  localStorage.setItem(key, JSON.stringify(state));
  fetch("/aha-state.json", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(state),
  }).catch(() => {});
}

type TweakValue = string | boolean;

function useTweaks(defaults: Tweaks): [Tweaks, (key: keyof Tweaks, value: TweakValue) => void] {
  const [values, setValues] = useState<Tweaks>(() => ({
    ...defaults,
    ...readStoredObject("aha:tweaks"),
  }));

  const setTweak = useCallback((key: keyof Tweaks, value: TweakValue) => {
    setValues((prev) => {
      const next = { ...prev, [key]: value };
      localStorage.setItem("aha:tweaks", JSON.stringify(next));
      return next;
    });
  }, []);

  return [values, setTweak];
}

function TweaksPanel({ children }: { title?: string; children: ReactNode }) {
  return <div className="tweaks-panel">{children}</div>;
}

function TweakSection({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section className="tweak-section">
      <div className="tweak-label">{label}</div>
      {children}
    </section>
  );
}

function TweakRadio({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (value: string) => void;
}) {
  return (
    <label className="tweak-control">
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option} value={option}>{option}</option>
        ))}
      </select>
    </label>
  );
}

function TweakToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="tweak-control">
      <span>{label}</span>
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

createRoot(document.getElementById("root")!).render(<AhaLoader />);
