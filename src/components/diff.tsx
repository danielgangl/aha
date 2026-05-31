import { useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  CopyBlock,
  DiffContent,
  DiffLine,
  DiffRowData,
  DiffSide,
  FileJumpHandler,
  FileNote,
  PackFile,
  ReviewSignalPattern,
  SignalRange,
  SymbolHandler,
  SymbolMap,
} from "../types";
import {
  callerLabel,
  contextRangeAttrs,
  copyBlockAttrs,
  formatAnchorRange,
  highlightCode,
  languageForPath,
  symbolKindForToken,
} from "../lib/diff";

// ── Shared utility fragments ───────────────────────────────────
// Line-number gutter cell (.ln)
const LN_CLS =
  "text-right px-2 text-[var(--ink-4)] select-none text-[11px] [font-variant-numeric:tabular-nums]";

// Code cell (.code) — base styling. State-dependent rules (add/del/ctx,
// copy-block, context-range) are layered via group-data variants keyed off
// the parent .side (group/side). The element renders inside DiffCell.
const CODE_BASE =
  "relative min-w-0 px-[14px] pl-[24px] [white-space:pre-wrap] [word-break:break-word] text-[var(--ink-2)]";
const CODE_SIDE_STATE = [
  // .side.add .code / .side.del .code → text-ink + extra right padding
  "group-data-[k=add]/side:text-[var(--ink)] group-data-[k=add]/side:pr-[56px]",
  "group-data-[k=del]/side:text-[var(--ink)] group-data-[k=del]/side:pr-[56px]",
  // .side.ctx .code → ink-2 (already base, but explicit for parity)
  "group-data-[k=ctx]/side:text-[var(--ink-2)]",
  // .side[data-copy-block] .code → blue rail gradient
  "group-data-[copy-block=true]/side:bg-[linear-gradient(90deg,color-mix(in_oklab,var(--blue)_72%,var(--surface))_0_2px,color-mix(in_oklab,var(--blue)_7%,transparent)_2px_calc(100%-2px),color-mix(in_oklab,var(--blue)_72%,var(--surface))_calc(100%-2px)_100%)]",
  // .side[data-copy-start] .code → top border + radius
  "group-data-[copy-start=true]/side:border-t group-data-[copy-start=true]/side:border-t-[color-mix(in_oklab,var(--blue)_58%,var(--line))] group-data-[copy-start=true]/side:rounded-t-[5px]",
  // .side[data-copy-end] .code → bottom border + radius
  "group-data-[copy-end=true]/side:border-b group-data-[copy-end=true]/side:border-b-[color-mix(in_oklab,var(--blue)_58%,var(--line))] group-data-[copy-end=true]/side:rounded-b-[5px]",
  // .side[data-context-range] .code → violet rail gradient
  "group-data-[context-range=true]/side:bg-[linear-gradient(90deg,color-mix(in_oklab,#8b5cf6_72%,var(--surface))_0_2px,color-mix(in_oklab,#8b5cf6_5%,transparent)_2px_100%)]",
  // .side[data-context-start] .code → top radius
  "group-data-[context-start=true]/side:rounded-t-[5px]",
  // .side[data-context-end] .code → bottom border + radius
  "group-data-[context-end=true]/side:border-b group-data-[context-end=true]/side:border-b-[color-mix(in_oklab,#8b5cf6_58%,var(--line))] group-data-[context-end=true]/side:rounded-b-[5px]",
].join(" ");
const CODE_CLS = `${CODE_BASE} ${CODE_SIDE_STATE}`;

// .sig change marker (+/−), positioned absolutely inside .code
const SIG_CLS =
  "absolute left-[7px] text-[var(--ink-4)] text-[11.5px] select-none group-data-[k=add]/side:text-[var(--add-mark)] group-data-[k=del]/side:text-[var(--del-mark)]";

// .side cell — line-number + code grid; carries group/side for descendant state
const SIDE_BASE =
  "group/side grid grid-cols-[42px_minmax(0,1fr)] items-baseline min-w-0";

function sideClass(kind: string | undefined, isLeft: boolean) {
  const k = kind || "blank";
  return [
    SIDE_BASE,
    isLeft ? "border-r border-[var(--line)]" : "",
    // .side.add / .side.del backgrounds
    k === "add" ? "bg-[var(--add-bg)]" : "",
    k === "del" ? "bg-[var(--del-bg)]" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

// ── Diff line renderer ─────────────────────────────────────────
export function CodeChunks({
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
            <Symbol
              key={i}
              active={activeSym === part.id}
              callers={callLabel}
              kind={symbolKindForToken(symbol)}
              label={part.label}
              onClick={(e) => { e.stopPropagation(); onSymbol(part.id); }}
            />
          );
        }
        return null;
      });
    }
    return c;
  };

  return ch(c);
}

// Clickable inline symbol. The `sym` class is KEPT: its hover call-site tooltip
// is drawn with a CSS ::after pseudo-element (content: attr(data-callers)) that
// cannot be expressed as a utility, and the element's hover/active/kind states
// are coupled to that pseudo-art rule. Treated as the documented pseudo-art
// exception, so all of `.sym`'s styling stays in CSS.
function Symbol({
  active,
  callers,
  kind,
  label,
  onClick,
}: {
  active: boolean;
  callers: string;
  kind: string;
  label: string;
  onClick: (e: React.MouseEvent) => void;
}) {
  return (
    <span
      className="sym"
      data-active={active}
      data-callers={callers}
      data-kind={kind}
      onClick={onClick}
      title={`${callers} · show call sites for ${label}`}
    >
      {label}
    </span>
  );
}

export function DiffCell({
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
        <span className={LN_CLS} />
        <span className={`${CODE_CLS} min-h-[1.55em] bg-[color-mix(in_oklab,var(--bg-2)_70%,transparent)]`} />
      </>
    );
  }
  const canCopy = ln.k === "add" || ln.k === "del";

  return (
    <>
      <span className={LN_CLS}>{side === "left" ? ln.L ?? "" : ln.R ?? ""}</span>
      <span className={CODE_CLS}>
        <span className={SIG_CLS}>{ln.k === "add" ? "+" : ln.k === "del" ? "−" : " "}</span>
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

export function CopyDiffLineButton({
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
      className="absolute top-px right-[6px] w-max h-5 px-[6px] inline-flex items-center justify-center border-0 rounded-[4px] bg-transparent text-[var(--ink-3)] font-mono text-[9.5px] leading-none cursor-pointer opacity-0 translate-y-[-1px] transition-[opacity,background,color,border-color] duration-[120ms] focus-visible:opacity-100 hover:text-[var(--blue-ink)] hover:bg-[var(--blue-soft)] data-[visible=true]:opacity-100 data-[copied=true]:text-[var(--pine-ink)] data-[copied=true]:bg-[var(--pine-soft)]"
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

interface CopyBlockPair {
  left: CopyBlock | null;
  right: CopyBlock | null;
}

export function DiffRow({
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
    // .dl2.hunk — single full-width row
    return (
      <div className="grid grid-cols-[42px_minmax(0,1fr)] bg-[var(--bg-2)] text-[var(--ink-3)] [border-top:1px_dashed_var(--line-2)] [border-bottom:1px_dashed_var(--line-2)] my-[2px]">
        <span className={LN_CLS} />
        <span className="relative min-w-0 px-[14px] pl-[24px] [white-space:pre-wrap] [word-break:break-word] [grid-column:2/-1] text-[var(--ink-3)] text-[11px]">
          <span className="absolute left-[7px] text-[var(--ink-4)] text-[11.5px] select-none">…</span>
          <CodeChunks c={row.line!.c} language={language} onSymbol={onSymbol} activeSym={activeSym} symbols={symbols} />
        </span>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] items-stretch relative">
      <div
        className={sideClass(row.left?.k, true)}
        data-k={row.left?.k || "blank"}
        {...contextRangeAttrs(row.left, contextRanges, "left", filePath)}
        {...copyBlockAttrs(copyBlock?.left, outlinedCopyBlock)}
        onMouseEnter={copyBlock?.left ? () => setHoveredCopyBlock(copyBlock.left!.id) : undefined}
        onMouseLeave={copyBlock?.left ? () => setHoveredCopyBlock(null) : undefined}
      >
        <DiffCell ln={row.left} side="left" language={language} onSymbol={onSymbol} activeSym={activeSym} symbols={symbols} copyBlock={copyBlock?.left ?? null} copyVisible={hoveredCopyBlock === copyBlock?.left?.id} setOutlinedCopyBlock={setOutlinedCopyBlock} />
      </div>
      <div
        className={sideClass(row.right?.k, false)}
        data-k={row.right?.k || "blank"}
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

// ── Reusable diff excerpt ──────────────────────────────────────
// Renders a window of a file's REAL diff around an anchor line as a UNIFIED
// single column (full width, no empty side), with an opt-in "show full file
// diff". Lets code evidence live inline (e.g. inside decision cards) so the
// reviewer never has to jump away. Syntax highlight + clickable symbols are the
// same as the Code tab; the Code tab itself stays side-by-side.
export function DiffExcerpt({
  file,
  anchorLine,
  context,
  contextAbove,
  contextBelow,
  symbols,
  onSymbol,
  fontClass = "text-[11.5px]",
}: {
  file: PackFile;
  anchorLine?: number | null;
  // Symmetric window override; the per-side props win when set. Default is
  // asymmetric (more below than above) so the collapsed evidence shows enough
  // surrounding code to be understood without expanding.
  context?: number;
  contextAbove?: number;
  contextBelow?: number;
  symbols?: SymbolMap;
  onSymbol?: SymbolHandler;
  fontClass?: string;
}) {
  const above = contextAbove ?? context ?? 5;
  const below = contextBelow ?? context ?? 8;
  const [full, setFull] = useState(false);
  // Unified: walk the diff lines in order, skipping hunk markers.
  const lines = useMemo(() => file.diff.filter((line) => line.k !== "hunk"), [file.diff]);
  const language = useMemo(() => languageForPath(file.path), [file.path]);
  const anchorIdx = useMemo(() => {
    if (anchorLine == null) return -1;
    return lines.findIndex((line) => line.L === anchorLine || line.R === anchorLine);
  }, [lines, anchorLine]);

  const windowed = !full && anchorIdx >= 0;
  const start = windowed ? Math.max(0, anchorIdx - above) : 0;
  const end = windowed ? Math.min(lines.length, anchorIdx + below + 1) : lines.length;
  const slice = lines.slice(start, end);
  const hiddenAbove = start;
  const hiddenBelow = lines.length - end;
  const noop = () => {};
  const toggle = (event: React.MouseEvent) => { event.stopPropagation(); setFull((value) => !value); };
  const noteClass = "block w-full px-3 py-[3px] text-right bg-bg-2 text-[10px] text-ink-4 cursor-pointer hover:text-ink";

  return (
    <div className={`border border-line rounded-[6px] overflow-hidden bg-paper font-mono leading-[1.5] ${fontClass}`}>
      {(hiddenAbove > 0 || full) && (
        <button type="button" onClick={toggle} className={`${noteClass} border-b border-line`}>
          {full ? "▴ collapse" : `⋯ ${hiddenAbove} ${hiddenAbove === 1 ? "line" : "lines"} above`}
        </button>
      )}
      {slice.map((line, i) => {
        const isAnchor = start + i === anchorIdx;
        const tone = line.k === "add" ? "bg-add-bg" : line.k === "del" ? "bg-del-bg" : "";
        const sig = line.k === "add" ? "+" : line.k === "del" ? "−" : "";
        const sigTone = line.k === "add" ? "text-add-mark" : line.k === "del" ? "text-del-mark" : "text-ink-4";
        return (
          <div
            key={i}
            className={`grid grid-cols-[40px_16px_minmax(0,1fr)] items-baseline ${tone} ${
              isAnchor
                ? "relative before:absolute before:left-0 before:top-0 before:bottom-0 before:w-[2px] before:bg-blue before:content-['']"
                : ""
            }`}
          >
            <span className="pr-2 text-right text-ink-4 select-none [font-variant-numeric:tabular-nums]">
              {line.R ?? line.L ?? ""}
            </span>
            <span className={`text-center select-none ${sigTone}`}>{sig}</span>
            <span
              className={`pr-3 [white-space:pre-wrap] [word-break:break-word] ${
                line.k === "ctx" ? "text-ink-2" : "text-ink"
              }`}
            >
              <CodeChunks c={line.c} language={language} onSymbol={onSymbol || noop} activeSym={null} symbols={symbols} />
            </span>
          </div>
        );
      })}
      {(hiddenBelow > 0 || full) && (
        <button type="button" onClick={toggle} className={`${noteClass} border-t border-line`}>
          {full ? "▴ collapse" : `⋯ ${hiddenBelow} ${hiddenBelow === 1 ? "line" : "lines"} below`}
        </button>
      )}
    </div>
  );
}

export function NoiseBlock({
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
    <div className="grid grid-cols-[auto_auto_minmax(0,1fr)_auto_auto_auto] gap-2 items-center py-[5px] pr-[14px] pl-[42px] bg-[color-mix(in_oklab,var(--bg-3)_72%,var(--surface))] border-t border-b border-[var(--line)] text-[var(--ink-3)] font-sans text-[11.5px]">
      <span className="font-mono [font-feature-settings:'ss02'] text-[var(--ink-3)] text-[10.5px]">{count}</span>
      <span>hidden noise lines</span>
      {signal?.reason && <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{signal.reason}</span>}
      <span className="text-[var(--ink-2)] font-mono text-[10.5px] whitespace-nowrap">{signal?.kind || "likely noise"}</span>
      {pattern?.label && <span className="text-[var(--ink-2)] max-w-[220px] overflow-hidden text-ellipsis whitespace-nowrap">{pattern.label}</span>}
      <button
        type="button"
        onClick={onShow}
        className="justify-self-end w-max h-[22px] px-2 border border-[var(--line-2)] rounded-[4px] bg-[var(--surface)] text-[var(--ink-2)] cursor-pointer text-[11px] hover:border-[var(--line-3)] hover:text-[var(--ink)]"
      >
        show
      </button>
    </div>
  );
}

export function ContextSignalMarker({ signal, side }: { signal: SignalRange; side: DiffSide }) {
  const ownAnchor = signal?.anchor?.[side];
  const pairAnchor = signal?.anchor?.[side === "left" ? "right" : "left"];
  const own = formatAnchorRange(ownAnchor, side === "left" ? "L" : "R");
  const pair = formatAnchorRange(pairAnchor, side === "left" ? "R" : "L");
  const before = signal?.scope?.before;
  const after = signal?.scope?.after;
  const scope = before || after ? `${before || "before"} → ${after || "after"}` : "";
  return (
    <div
      className="grid grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)] max-[900px]:grid-cols-[42px_minmax(0,1fr)] my-[2px]"
      data-side={side}
      title={signal?.reason || ""}
    >
      <div
        className={`${side === "left" ? "[grid-column:2/3]" : "[grid-column:4/5]"} max-[900px]:[grid-column:2/-1] grid grid-cols-[auto_auto_minmax(0,1fr)] gap-[7px] items-center px-[10px] py-[5px] bg-[color-mix(in_oklab,var(--bg-3)_70%,var(--surface))] border border-[var(--line)] border-l-2 border-l-[color-mix(in_oklab,#8b5cf6_82%,var(--blue))] rounded-r-[6px] rounded-l-none text-[var(--ink-2)] font-sans text-[11.5px]`}
      >
        {/* .context-signal-kind — the leading dot is a ::before in CSS; rendered here as a real element for parity */}
        <span className="inline-flex items-center gap-[5px] font-mono text-[10.5px] whitespace-nowrap text-[var(--ink-2)]">
          <span className="w-[6px] h-[6px] rounded-full bg-[#8b5cf6] flex-[0_0_auto]" />
          {side === "left" ? "moved" : "moved here"}
        </span>
        <span className="font-mono text-[10.5px] whitespace-nowrap text-[var(--ink-2)]">
          {side === "left" ? `${own} → ${pair}` : `${pair} → ${own}`}
        </span>
        {scope && (
          <span className="min-w-0 font-mono text-[10.5px] text-[var(--ink-3)] overflow-hidden text-ellipsis whitespace-nowrap">
            {scope}
          </span>
        )}
      </div>
    </div>
  );
}

export function HighlightedCode({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  // `syntax` class kept intentionally: it (and `.token.*`) style Prism-generated
  // HTML injected via dangerouslySetInnerHTML; those rules cannot be expressed as
  // utilities on this wrapper.
  return <span className="syntax" dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Inline AI note that anchors to a specific line ─────────────
export function AiNote({
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
  const noteType = noteTypeFor(note);
  const noteSource = noteSourceFor(note, noteType);
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

  // `ai-note` + `text` classes are kept: the rules `.ai-note .text p|strong|
  // code|a.jump` style the markup injected via dangerouslySetInnerHTML (same
  // rationale as Prism's `.syntax`). The base `.ai-note` grid rule it also
  // carries is pixel-identical to the utilities below. All structural layout
  // (`.body` etc.) is driven by the utilities here, not bespoke CSS.
  return (
    <div
      className="ai-note grid grid-cols-[42px_minmax(0,1fr)_42px_minmax(0,1fr)] max-[900px]:grid-cols-[42px_minmax(0,1fr)] my-[2px]"
      data-side={side}
      data-note-type={noteType || undefined}
    >
      {/* leading dot drawn via ::before in CSS; rendered as a real element for parity */}
      <div
        className={`ai-note-body ${side === "left" ? "[grid-column:2/3] max-[900px]:[grid-column:2/-1]" : "[grid-column:4/5] max-[900px]:[grid-column:2/-1]"} px-[10px] py-[5px] grid grid-cols-[6px_minmax(0,1fr)_auto] gap-[7px] items-start max-w-none bg-[var(--ai-note-bg)] border border-[var(--line)] border-l-2 border-l-[var(--ai-note-accent)] rounded-r-[6px] rounded-l-none`}
      >
        <span className="ai-note-dot w-[6px] h-[6px] mt-[5px] rounded-full bg-[var(--ai-note-accent)]" />
        <span
          ref={ref}
          className="text font-sans text-[12px] text-[var(--ink-2)] leading-[1.4] min-w-0"
          dangerouslySetInnerHTML={{ __html: note.html }}
        />
        <span className="ai-note-src font-mono text-[10.5px] leading-[1.4] text-[var(--ai-note-label)] whitespace-nowrap">{noteSource}</span>
      </div>
    </div>
  );
}

function noteTypeFor(note: FileNote): "" | "risk" | "code-smell" {
  if (note.type === "risk" || note.type === "code-smell") return note.type;
  const source = String(note.src || "").trim().toLowerCase();
  if (/^risk(\s|·|:|-|$)/.test(source)) return "risk";
  if (/^(code-smell|code smell)(\s|·|:|-|$)/.test(source)) return "code-smell";
  return "";
}

function noteSourceFor(note: FileNote, noteType: "" | "risk" | "code-smell"): string {
  const source = String(note.src || "").trim();
  if (!noteType) return source;
  const displayType = noteType === "code-smell" ? "code smell" : "risk";
  const strippedSource = source
    .replace(/^(risk|code-smell|code smell)\s*(·|:|-)?\s*/i, "")
    .trim();
  return [displayType, strippedSource].filter(Boolean).join(" · ");
}
