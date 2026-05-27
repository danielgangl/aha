import React from "react";
import type { FileJumpHandler, PackSymbol, SymbolCaller } from "../types";

// ── Reusable: caller context code block (.callsite-context) ────
export function CallsiteContext({ caller }: { caller: SymbolCaller }) {
  return (
    <div className="font-mono text-[11px] text-ink-2 bg-bg-2 py-[5px] rounded-[5px] border border-line overflow-x-auto [scrollbar-width:thin]">
      {caller.context.lines.map((line) => (
        <div
          className="grid grid-cols-[34px_minmax(0,1fr)] min-w-max data-[hit=true]:bg-blue-soft data-[hit=true]:text-blue-ink"
          data-hit={line.line === caller.line}
          key={line.line}
        >
          <span className="px-2 text-ink-4 text-right select-none">{line.line}</span>
          <span className="pr-2 whitespace-pre">{line.c}</span>
        </div>
      ))}
    </div>
  );
}

// ── Reusable: section header with count (.rr-section-title) ────
function SectionTitle({ label, count }: { label: string; count: number }) {
  return (
    <div className="px-3.5 pt-3 pb-1.5 flex items-center justify-between text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
      <span>{label}</span>
      <span className="font-mono text-ink-3 tracking-normal normal-case font-medium">{count}</span>
    </div>
  );
}

// ── Reusable: caller tag pill (.caller .tag[.variant]) ─────────
type TagTone = "default" | "touched" | "untouched" | "test";
function Tag({ tone = "default", children }: { tone?: TagTone; children: React.ReactNode }) {
  const toneCls =
    tone === "touched"
      ? "bg-pine-soft text-pine-ink"
      : tone === "untouched"
        ? "bg-amber-soft text-amber-ink"
        : // default + test share bg-3 / ink-3
          "bg-bg-3 text-ink-3";
  return (
    <span
      className={`font-mono text-[9.5px] px-[5px] py-px rounded-[3px] font-medium tracking-[0.03em] ${toneCls}`}
    >
      {children}
    </span>
  );
}

// ── Reusable: a single caller row (.caller) ────────────────────
function CallerRow({
  caller,
  onJumpToFile,
  line,
  children,
}: {
  caller: SymbolCaller;
  onJumpToFile: FileJumpHandler;
  line: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div
      className="px-3.5 py-2.5 border-b border-line flex flex-col gap-1.5 cursor-pointer hover:bg-bg-3"
      onClick={() => caller.path && onJumpToFile(caller.path)}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[11.5px] text-ink overflow-hidden text-ellipsis whitespace-nowrap">
          {caller.path}
        </span>
        <span className="font-mono text-[10.5px] text-ink-3 shrink-0">:{line}</span>
      </div>
      {children}
    </div>
  );
}

// ── Right rail: call sites panel ───────────────────────────────
export function CallSitesPanel({
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
        <div className="px-3.5 py-3 border-b border-line flex items-center justify-between gap-2">
          <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
            Call sites · blast radius
          </span>
        </div>
        <div className="px-[18px] py-[22px] text-ink-3 text-[12px] leading-[1.55] text-center">
          <div className="font-mono text-[30px] text-ink-4 mb-2.5">↘</div>
          <div>Click any symbol in the diff to see where it's defined, who calls it, and how this PR changes the blast radius.</div>
          <div className="mt-3 p-2.5 rounded-[7px] bg-bg-2 text-left text-[11.5px]">
            Try clicking{" "}
            <code className="font-mono bg-bg-3 px-1 rounded-[3px] text-ink">canViewCV</code> on the
            file <em className="italic">canViewCV.ts</em> — it has callers in this PR{" "}
            <em className="italic">and</em> sibling readers that weren't touched.
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
      <div className="px-3.5 py-3 border-b border-line flex items-center justify-between gap-2">
        <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
          Symbol · call sites
        </span>
        <button
          className="border-0 bg-transparent text-ink-3 cursor-pointer w-[22px] h-[22px] rounded-[5px] text-[12px] inline-flex items-center justify-center hover:bg-bg-3 hover:text-ink"
          onClick={onClose}
          title="Close"
        >
          ✕
        </button>
      </div>
      <div className="px-3.5 pt-3 pb-3.5 border-b border-line">
        <div className="inline-flex items-center h-[18px] px-1.5 rounded-[4px] bg-bg-3 text-ink-2 font-mono text-[10px] font-medium mb-1.5">
          {symbol.kind}
        </div>
        <div className="font-mono text-[14px] font-medium text-ink">{symbol.name}</div>
        <div className="mt-1.5 font-mono text-[11.5px] text-ink-2 bg-bg-2 border border-line px-2.5 py-2 rounded-md whitespace-pre-wrap leading-[1.5] overflow-x-auto">
          {symbol.signature}
        </div>
        <div className="mt-2 text-[11px] text-ink-3 flex items-center gap-1.5">
          <span className="text-ink-4 font-mono [font-feature-settings:'ss02']">defined at</span>
          <span
            className="font-mono text-ink-2 cursor-pointer hover:text-blue-ink hover:underline"
            onClick={() => { if (definedPath) onJumpToFile(definedPath); }}
          >
            {symbol.defined.path || symbol.defined.file}:{symbol.defined.line}
          </span>
        </div>
        {symbol.summary && (
          <div className="text-ink-3 mt-2 text-[12px] leading-[1.5]">
            {symbol.summary}
          </div>
        )}
      </div>

      <div className="px-3.5 py-2.5 flex gap-3.5 border-b border-line text-[11px]">
        <Stat value={symbol.callers.length} label="total" />
        <Stat value={touchedCount} label="in PR" />
        <Stat value={untouchedCount} label="untouched" />
        <Stat value={testCount} label="tests" />
      </div>

      <div className="flex-1 overflow-y-auto">
        <SectionTitle label="Callers" count={symbol.callers.length} />
        {symbol.callers.map((c, i) => (
          <CallerRow key={i} caller={c} onJumpToFile={onJumpToFile} line={c.line || "—"}>
            <CallsiteContext caller={c} />
            <div className="flex gap-[5px] flex-wrap">
              {c.status === "touched" && <Tag tone="touched">touched by this PR</Tag>}
              {c.status === "untouched" && <Tag tone="untouched">untouched</Tag>}
              {c.status === "test" && <Tag tone="test">test</Tag>}
              {c.role === "read" && <Tag>reads</Tag>}
              {c.role === "write" && <Tag>writes</Tag>}
            </div>
          </CallerRow>
        ))}

        {symbol.notCallers && symbol.notCallers.length > 0 && (
          <>
            <SectionTitle label="Adjacent · not via this symbol" count={symbol.notCallers.length} />
            {symbol.notCallers.map((c, i) => (
              <CallerRow key={`nc-${i}`} caller={c} onJumpToFile={onJumpToFile} line={c.line}>
                <CallsiteContext caller={c} />
                <div className="flex gap-[5px] flex-wrap">
                  <Tag tone="untouched">does not call {symbol.name}</Tag>
                </div>
                {c.why && (
                  <div className="text-ink-3 text-[11.5px] mt-1 leading-[1.45]">
                    {c.why}
                  </div>
                )}
              </CallerRow>
            ))}
          </>
        )}
      </div>
    </>
  );
}

// ── Reusable: stat column (.rr-stat .stat) ─────────────────────
function Stat({ value, label }: { value: number; label: string }) {
  return (
    <div className="flex flex-col gap-px">
      <div className="font-mono text-[18px] font-medium text-ink tracking-[-0.01em] leading-none">
        {value}
      </div>
      <div className="text-[10px] text-ink-3 tracking-[0.04em] uppercase">{label}</div>
    </div>
  );
}
