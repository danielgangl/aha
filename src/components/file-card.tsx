import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type {
  FileJumpHandler,
  FileSignal,
  NoiseMode,
  PackFile,
  ReviewSignalPattern,
  SymbolHandler,
  SymbolMap,
} from "../types";
import { isNoiseSignal } from "../lib/pack";
import {
  buildSideBySideRows,
  contextSignalMarkersForRow,
  diffBlockAt,
  languageForPath,
  signalForRow,
} from "../lib/diff";
import { AiNote, ContextSignalMarker, DiffRow, NoiseBlock } from "./diff";

// ── Reusable subcomponents (within-file) ───────────────────────

// `.copy-icon` / `.check-icon` — pseudo-element art reproduced as JSX.
// The two overlapping squares of the copy glyph and the check tick are
// drawn with positioned <span>s mirroring the original ::before/::after.
function CopyGlyph({ copied }: { copied: boolean }) {
  if (copied) {
    // .check-icon::before — rotated L (right+bottom borders)
    return (
      <span className="relative h-[12px] w-[12px]" aria-hidden="true">
        <span className="absolute left-[2px] top-[1px] h-[10px] w-[7px] rotate-[40deg] rounded-[1px] border-b-2 border-r-2 border-current" />
      </span>
    );
  }
  // .copy-icon::before (back square, .72 opacity) + ::after (front square)
  return (
    <span className="relative h-[12px] w-[12px]" aria-hidden="true">
      <span className="absolute left-[1px] top-[3px] h-[8px] w-[8px] rounded-[2px] border-[1.4px] border-current bg-transparent opacity-[0.72]" />
      <span className="absolute left-[4px] top-0 h-[8px] w-[8px] rounded-[2px] border-[1.4px] border-current bg-[var(--bg-2)] group-hover/copy:bg-[var(--blue-soft)]" />
    </span>
  );
}

// `.copy-path` button + its hover / data-copied states.
function CopyPathButton({
  path,
  copied,
  onCopy,
}: {
  path: string;
  copied: boolean;
  onCopy: (event: React.MouseEvent) => void;
}) {
  return (
    <button
      className="group/copy inline-flex h-[24px] w-[24px] flex-none cursor-pointer items-center justify-center rounded-[5px] border-0 bg-transparent p-0 text-[var(--ink-3)] hover:bg-[var(--blue-soft)] hover:text-[var(--blue-ink)] data-[copied=true]:bg-[var(--pine-soft)] data-[copied=true]:text-[var(--pine-ink)]"
      type="button"
      onClick={onCopy}
      title={`Copy path: ${path}`}
      aria-label={`Copy path ${path}`}
      data-copied={copied}
    >
      <CopyGlyph copied={copied} />
    </button>
  );
}

// `.file-tag` pill — base blue-soft, with `kind` overriding to the
// unchanged / modified / noise variants (all bg-3 + ink-3 except modified).
function FileTag({
  kind,
  title,
  children,
}: {
  kind?: "unchanged" | "modified" | "noise";
  title?: string;
  children: ReactNode;
}) {
  const variant =
    kind === "unchanged" || kind === "noise"
      ? "bg-[var(--bg-3)] text-[var(--ink-3)]"
      : "bg-[var(--blue-soft)] text-[var(--blue-ink)]";
  return (
    <span
      className={`rounded-[3px] px-[6px] py-[2px] font-mono text-[9.5px] font-semibold tracking-[0.03em] ${variant}`}
      title={title}
    >
      {children}
    </span>
  );
}

// `.file-stat` — the +add / −del counts (pine / rose) or a label.
function FileStat({ add, del }: { add: number; del: number }) {
  if (add <= 0 && del <= 0) {
    return (
      <span className="font-mono text-[11px] text-[var(--ink-3)]">read-only</span>
    );
  }
  return (
    <span className="font-mono text-[11px] text-[var(--ink-3)]">
      {add > 0 && <span className="font-medium text-[var(--pine-ink)]">+{add}</span>}
      {add > 0 && del > 0 && " "}
      {del > 0 && <span className="font-medium text-[var(--rose-ink)]">−{del}</span>}
    </span>
  );
}

// `.checkbox.viewed` — clickable pill with a 14px box that fills + shows
// a ✓ (via ::after) when `on`.
function ViewedCheckbox({
  on,
  onClick,
}: {
  on: boolean;
  onClick: (event: React.MouseEvent) => void;
}) {
  return (
    <div
      className="group/viewed inline-flex h-[22px] cursor-pointer select-none items-center gap-[6px] rounded-[5px] border border-[var(--line)] bg-[var(--surface)] px-[6px] text-[11px] text-[var(--ink-2)]"
      data-on={on}
      onClick={onClick}
    >
      <span className="inline-flex h-[14px] w-[14px] items-center justify-center rounded-[3px] border-[1.5px] border-[var(--line-3)] bg-[var(--surface)] font-sans text-[11px] font-bold leading-none group-data-[on=true]/viewed:border-[var(--ink)] group-data-[on=true]/viewed:bg-[var(--ink)] group-data-[on=true]/viewed:text-[var(--bg)] group-data-[on=true]/viewed:after:content-['✓']" />{" "}
      <span>Viewed</span>
    </div>
  );
}

// ── File card ──────────────────────────────────────────────────
export function FileCard({
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
  order: number | null;
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
    // `.file` — sticky-header host. flash via animate-[flashbg…]; data-collapsed
    // swaps surface→bg-2 and (below) the head border-radius / collapse caret.
    <section
      className={`group/file mb-[18px] overflow-visible rounded-[10px] border border-[var(--line)] bg-[var(--surface)] [scroll-margin-top:130px] data-[collapsed=true]:bg-[var(--bg-2)] ${flash ? "animate-[flashbg_1.6s_ease-out]" : ""}`}
      data-collapsed={collapsed}
      data-noise={isNoiseFile}
      id={file.id}
      ref={fileRef}
    >
      {/* `.file-head` — sticky top offset uses the --file-head-sticky-top var.
          Flash also animates the head (descendant selector) so it carries its
          own animate-[flashbg…] when flashing. */}
      <header
        className={`sticky top-[var(--file-head-sticky-top,74px)] z-[2] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[16px] rounded-t-[9px] border-b border-[var(--line)] bg-[var(--bg-2)] px-[14px] py-[10px] group-data-[collapsed=true]/file:rounded-[9px] group-data-[collapsed=true]/file:border-b-0 ${flash ? "animate-[flashbg_1.6s_ease-out]" : ""}`}
      >
        <div className="flex min-w-0 items-center gap-[6px]">
          <button
            className="grid min-h-[28px] min-w-0 max-w-[calc(100%-30px)] flex-[0_1_auto] cursor-pointer grid-cols-[18px_minmax(0,1fr)] items-center gap-[10px] border-0 bg-transparent py-[2px] text-left text-inherit"
            type="button"
            onClick={() => onToggleCollapsed(file)}
            title={collapsed ? `Expand ${file.path}` : `Collapse ${file.path}`}
          >
            {/* `.collapse-mark` — rotated 90deg expanded, 0deg when collapsed */}
            <span className="inline-flex h-[18px] w-[18px] rotate-90 items-center justify-center font-mono text-[var(--ink-3)] transition-transform duration-[120ms] [transition-timing-function:ease] group-data-[collapsed=true]/file:rotate-0">
              ›
            </span>
            {/* `.path` — prefixed with a plain "N. " only in grouped (AI) order */}
            <span
              className="overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[13px] font-medium leading-[1.35] text-[var(--ink)]"
              title={file.path}
            >
              {order != null && <span className="text-[var(--ink-3)] font-normal">{order}. </span>}
              {file.path}
            </span>
          </button>
          <CopyPathButton path={file.path} copied={copiedPath} onCopy={copyFilePath} />
        </div>
        {/* `.file-head .actions` */}
        <div className="inline-flex min-w-max flex-shrink-0 items-center gap-[8px]">
          <ViewedCheckbox
            on={reviewed}
            onClick={(event) => {
              event.stopPropagation();
              onToggleReviewed(file);
            }}
          />
          {file.tag !== "modified" && (
            <FileTag kind={file.tag === "new" ? undefined : (file.tag as "unchanged")}>
              {file.tag === "new" ? "NEW" : "UNCHANGED"}
            </FileTag>
          )}
          {isNoiseFile && (
            <FileTag kind="noise" title={signal?.reason || "Likely review-irrelevant change"}>
              likely noise
            </FileTag>
          )}
          <FileStat add={file.add ?? 0} del={file.del ?? 0} />
        </div>
      </header>

      {/* `.file-note` — left blue rule + leading bullet dot (::before) */}
      {!collapsed && file.note && (
        <div className="grid grid-cols-[6px_minmax(0,1fr)] items-start gap-[7px] border-b border-l-2 border-t border-b-[var(--line)] border-l-[var(--blue)] border-t-[color-mix(in_oklab,var(--line)_70%,transparent)] bg-[color-mix(in_oklab,var(--bg-3)_70%,var(--surface))] py-[6px] pl-[48px] pr-[16px] font-sans text-[12px] leading-[1.4] text-[var(--ink-2)] before:mt-[5px] before:h-[6px] before:w-[6px] before:rounded-full before:bg-[var(--blue)] before:content-['']">
          <span className="file-note-text min-w-0" dangerouslySetInnerHTML={{ __html: file.note || "" }} />
        </div>
      )}

      {/* `.file-noise-note` */}
      {!collapsed && isNoiseFile && signal?.reason && (
        <div className="flex items-baseline gap-[8px] border-b border-[var(--line)] bg-[color-mix(in_oklab,var(--bg-3)_70%,var(--surface))] py-[7px] pl-[48px] pr-[16px] text-[12px] leading-[1.45] text-[var(--ink-3)]">
          <span className="font-mono text-[10px] uppercase text-[var(--ink-3)]">{signal.source || "signal"}</span>
          <span>{signal.reason}</span>
        </div>
      )}

      {!collapsed && (diffReady ? (
        // `.diff`
        <div className="font-mono text-[12.5px] leading-[1.55] pb-[8px] pt-[6px]">{items}</div>
      ) : (
        // `.diff-placeholder`
        <div className="border-t border-[var(--line)] bg-[var(--surface)] px-[50px] py-[18px] text-[12px] text-[var(--ink-4)]">
          <span className="font-mono text-[var(--ink-2)]">{file.diff.length}</span> diff lines load when this file nears the viewport
        </div>
      ))}

      {/* `.file-foot` */}
      {!collapsed && (
        <footer className="flex items-center gap-[10px] border-t border-[var(--line)] bg-[var(--bg-2)] px-[14px] py-[9px] text-[11.5px] text-[var(--ink-3)]">
          <span className="ml-auto text-[var(--ink-3)]">
            {file.diff.filter(d => d.k === "add").length} added · {file.diff.filter(d => d.k === "del").length} removed
          </span>
        </footer>
      )}
    </section>
  );
}
