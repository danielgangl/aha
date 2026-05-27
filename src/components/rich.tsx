import React from "react";
import type {
  RichHandlers,
  RichPart,
  RichRef,
  RichText as RichTextValue,
} from "../types";

export function AsciiPanel({
  label,
  lines,
  onSymbol,
  onFile,
  onDecision,
}: {
  label: string;
  lines: RichTextValue[] | undefined;
} & RichHandlers) {
  // `ascii-panel` class is KEPT: the only rules referencing it are the
  // adjacent-sibling separators `.ascii-panel + .ascii-panel` applied by the
  // parent `.flow-grid` layout (in another file). A sibling combinator across
  // sibling components can't be expressed as a utility here, so the marker class
  // stays. The panel has no own-element styling beyond that.
  return (
    <div className="ascii-panel">
      <div className="px-[12px] py-[7px] border-b border-[var(--line)] text-[var(--ink-3)] bg-[var(--bg-2)] font-mono text-[10px] font-semibold tracking-[0.04em] uppercase">
        {label}
      </div>
      <pre className="m-0 px-[12px] pt-[10px] pb-[12px] overflow-x-auto font-mono text-[12px] leading-[1.65] text-[var(--ink-2)] whitespace-pre">
        {(Array.isArray(lines) ? lines : []).map((line, index) => (
          <div className="min-h-[1.65em]" key={`${label}-${index}`}>
            <RichLine value={line} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
          </div>
        ))}
      </pre>
    </div>
  );
}

export function RefList({ refs, onSymbol, onFile, onDecision }: { refs: RichRef[] | undefined } & RichHandlers) {
  if (!Array.isArray(refs) || refs.length === 0) return null;
  // `overview-refs` class is KEPT: a parent-context rule in another file
  // (`.overview-system-map .overview-refs`) adds contextual padding that depends
  // on the ancestor and cannot be reproduced from inside this component. That
  // class also carries the base flex/wrap/gap layout (pixel-identical), so no
  // duplicate utilities are added here. The pill styling that used to come from
  // `.overview-refs .rich-token` is reproduced via the `pill` prop below.
  return (
    <div className="overview-refs">
      {refs.map((ref, index) => (
        <RichToken
          key={`${ref.type}-${ref.id}-${index}`}
          token={{ ...ref, label: ref.label || ref.id }}
          pill
          onSymbol={onSymbol}
          onFile={onFile}
          onDecision={onDecision}
        />
      ))}
    </div>
  );
}

export function RichText({ value, onSymbol, onFile, onDecision }: { value: RichTextValue | undefined } & RichHandlers) {
  if (Array.isArray(value)) {
    return <RichLine value={value} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />;
  }
  return <>{value || ""}</>;
}

export function RichLine({ value, onSymbol, onFile, onDecision }: { value: RichTextValue | undefined } & RichHandlers) {
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

// Base inline token (.rich-token). `pill` switches to the boxed variant that
// previously came from the `.overview-refs .rich-token` descendant rule.
// (`.rt-${type}` had no CSS rules and is dropped.)
const RICH_TOKEN_INLINE =
  "inline border-0 px-[2px] m-0 rounded-[3px] bg-transparent text-[var(--blue-ink)] font-[inherit] cursor-pointer underline decoration-dotted underline-offset-[3px] hover:bg-[var(--blue-soft)]";
const RICH_TOKEN_PILL =
  "inline-flex items-center h-[22px] px-[8px] m-0 rounded-[3px] border border-[var(--line-2)] bg-[var(--surface)] text-[var(--blue-ink)] font-mono text-[10.5px] cursor-pointer no-underline hover:bg-[var(--blue-soft)] hover:border-[var(--blue)]";

export function RichToken({
  token,
  pill,
  onSymbol,
  onFile,
  onDecision,
}: { token: RichRef; pill?: boolean } & RichHandlers) {
  const onClick = () => {
    if (token.type === "symbol") onSymbol(token.id);
    if (token.type === "file") onFile(token.id);
    if (token.type === "decision") onDecision(token.id);
  };
  return (
    <button
      className={pill ? RICH_TOKEN_PILL : RICH_TOKEN_INLINE}
      type="button"
      onClick={onClick}
      title={`Open ${token.type}: ${token.label || token.id}`}
    >
      {token.label || token.id}
    </button>
  );
}
