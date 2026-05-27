import type { ReactNode } from "react";
import type {
  DecisionHandler,
  Decisions,
  FileJumpHandler,
  Overview,
  PackFile,
  SetStatusHandler,
  StatusMap,
  SymbolHandler,
  TriageStatus,
} from "../types";
import { categoryLabel, hasOverviewContent } from "../lib/pack";
import { AsciiPanel, RefList, RichText } from "./rich";
import { DecisionCard } from "../decisions.js";

// ── Shared primitives (kept visually consistent with decisions.tsx) ──

// .cat-pill
function CatPill({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center h-5 px-2 rounded-[4px] bg-bg-3 text-ink-2 font-mono text-[10px] font-medium tracking-[0.03em] uppercase">
      {children}
    </span>
  );
}

// .overview-num
function OverviewNum({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex w-6 h-6 items-center justify-center rounded-[5px] bg-bg-3 text-ink-3 text-[11px] font-semibold font-mono">
      {children}
    </span>
  );
}

// .overview-section-head — shared section header (h2 + optional meta count)
function SectionHead({ title, meta }: { title: string; meta?: ReactNode }) {
  return (
    <div className="flex items-baseline gap-[10px] mb-[10px] pb-2 border-b border-line">
      <h2 className="m-0 font-sans text-base font-semibold tracking-[-0.005em] text-ink">{title}</h2>
      {meta != null && <span className="ml-auto font-mono text-[11px] text-ink-3">{meta}</span>}
    </div>
  );
}

// ── High-level overview renderer ───────────────────────────────
export function HighLevelLeftRail({
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
    // .rail-left
    <aside className="relative border-r border-line bg-rail overflow-y-auto text-xs">
      {/* .rl-h */}
      <div className="px-[14px] pt-3 pb-2 border-b border-line flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">High Level</span>
        <span className="font-mono text-[10.5px] text-ink-3">
          {triaged}/{actionIds.length} triaged
        </span>
      </div>
      {/* .rl-group (paddingTop: 8) */}
      <div className="pt-2">
        {/* .rl-group-title */}
        <div className="px-[14px] pt-[9px] pb-1 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[7px] gap-y-1 text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
          <span>Sections</span>
        </div>
        {sections.map((section) => (
          // .overview-nav (+ data-empty)
          <button
            key={section.key}
            className={`w-full border-0 bg-transparent grid grid-cols-[minmax(0,1fr)_auto] gap-[10px] items-center text-left px-[14px] py-2 cursor-pointer border-l-2 border-l-transparent hover:bg-surface hover:text-ink ${
              section.count === 0 ? "text-ink-4" : "text-ink-2"
            }`}
            type="button"
            data-empty={section.count === 0}
            onClick={() => onJump(section.key)}
          >
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs font-medium">
              {section.label}
            </span>
            <span className="font-mono text-[10.5px] text-ink-3">{section.count}</span>
          </button>
        ))}
      </div>
    </aside>
  );
}

export function HighLevelView({
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
      // .overview-doc
      <div className="h-full">
        <BriefingStrip desc="No orientation layer is included in this pack yet." />
        {/* .overview-wrap */}
        <div className="px-7 pt-[22px] pb-20 max-w-[980px] mx-auto max-[980px]:px-[18px] max-[980px]:pt-[18px]">
          {/* .overview-empty */}
          <div className="border border-dashed border-line-2 rounded-[10px] px-[18px] py-7 text-center bg-surface">
            <div className="font-semibold text-ink mb-1">No high-level context</div>
            <div className="text-ink-3 text-[12.5px] leading-[1.5]">
              Generated packs can still be reviewed from the Code tab without this optional section.
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full">
      <BriefingStrip desc="A compact orientation layer before reading detailed diff evidence." />

      {/* .overview-wrap */}
      <div className="px-7 pt-[22px] pb-20 max-w-[980px] mx-auto max-[980px]:px-[18px] max-[980px]:pt-[18px]">
        {overview?.mentalModelDelta && (
          // .overview-section
          <section className="mb-[26px] scroll-mt-[130px]" id="mental-model">
            <SectionHead title="Mental Model Delta" />
            {/* .overview-card .overview-lede */}
            <div className="bg-surface border border-line rounded-[9px] px-4 py-[14px] text-sm leading-[1.6] text-ink">
              <RichText value={overview.mentalModelDelta} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
            </div>
          </section>
        )}

        {overview?.systemMap && (
          <section className="mb-[26px] scroll-mt-[130px]" id="system-map">
            <SectionHead title="System Map" />
            {/* .overview-flow .overview-system-map */}
            <article className="bg-surface border border-line rounded-[9px] overflow-hidden">
              {/* .overview-flow h3 */}
              <h3 className="m-0 font-sans text-sm leading-[1.35] font-semibold text-ink px-[14px] py-3 border-b border-line bg-bg-2">
                {overview.systemMap.title || "Affected system"}
              </h3>
              <AsciiPanel
                label={overview.systemMap.kind === "ascii" ? "ASCII-Art" : overview.systemMap.kind || "ASCII-Art"}
                lines={overview.systemMap.lines}
                onSymbol={onSymbol}
                onFile={onFile}
                onDecision={onDecision}
              />
              {/* .overview-system-map .overview-refs { padding: 0 14px 14px } */}
              <div className="px-[14px] pb-[14px]">
                <RefList refs={overview.systemMap.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
              </div>
            </article>
          </section>
        )}

        {(overview?.modelDeltas || []).length > 0 && (
          <section className="mb-[26px] scroll-mt-[130px]" id="model-deltas">
            <SectionHead title="Model Deltas" meta={overview?.modelDeltas.length} />
            {/* .overview-model-list */}
            <div className="grid gap-3">
              {(overview?.modelDeltas || []).map((item, index) => (
                // .overview-card .overview-model-delta
                <article
                  className="bg-surface border border-line rounded-[9px] px-4 py-[14px] grid gap-3"
                  key={item.id || index}
                >
                  {/* .overview-model-delta h3 */}
                  <h3 className="m-0 font-sans text-sm leading-[1.35] font-semibold text-ink">
                    <RichText value={item.title} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                  </h3>
                  {/* .model-delta-grid */}
                  <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-[10px] max-[900px]:grid-cols-[minmax(0,1fr)]">
                    <ModelDeltaCell label="Before">
                      <RichText value={item.before} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </ModelDeltaCell>
                    <ModelDeltaCell label="After">
                      <RichText value={item.after} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </ModelDeltaCell>
                  </div>
                  <RefList refs={item.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                </article>
              ))}
            </div>
          </section>
        )}

        {(overview?.flows || []).length > 0 && (
          <section className="mb-[26px] scroll-mt-[130px]" id="flows">
            <SectionHead title="Before / After Flow(s)" meta={overview?.flows.length} />
            {/* .overview-flow-list */}
            <div className="grid gap-3">
              {(overview?.flows || []).map((flow, index) => (
                // .overview-flow
                <article
                  className="bg-surface border border-line rounded-[9px] overflow-hidden"
                  key={`${flow.title || "flow"}-${index}`}
                >
                  <h3 className="m-0 font-sans text-sm leading-[1.35] font-semibold text-ink px-[14px] py-3 border-b border-line bg-bg-2">
                    {flow.title || `Flow ${index + 1}`}
                  </h3>
                  {(flow.lines?.length || 0) > 0 ? (
                    <AsciiPanel
                      label={flow.kind === "swimlane_ascii" ? "Swimlane" : "Flow"}
                      lines={flow.lines}
                      onSymbol={onSymbol}
                      onFile={onFile}
                      onDecision={onDecision}
                    />
                  ) : (
                    // .flow-grid (two AsciiPanels; .ascii-panel + .ascii-panel divider lives in rich.tsx CSS)
                    <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)] max-[900px]:grid-cols-[minmax(0,1fr)]">
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
          <section className="mb-[26px] scroll-mt-[130px]" id="assumptions">
            <SectionHead title="Load-Bearing Assumptions" meta={overview?.assumptions.length} />
            {/* .overview-list */}
            <div className="grid gap-3">
              {(overview?.assumptions || []).map((item, index) =>
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
                    {/* .overview-list-body */}
                    <div className="min-w-0 text-[13.5px] leading-[1.55] text-ink">
                      <RichText value={item.text} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      <RefList refs={item.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </div>
                  </OverviewActionCard>
                )
              )}
            </div>
          </section>
        )}

        {(overview?.hotspots || []).length > 0 && (
          <section className="mb-[26px] scroll-mt-[130px]" id="hotspots">
            <SectionHead title="Risk Hotspots" meta={overview?.hotspots.length} />
            <div className="grid gap-3">
              {(overview?.hotspots || []).map((item, index) =>
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
                    {/* .overview-hotspot-content (plain grid container, no own rule) */}
                    <div>
                      {/* .overview-hotspot h3 */}
                      <h3 className="m-0 font-sans text-sm leading-[1.35] font-semibold text-ink">
                        <RichText value={item.title} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      </h3>
                      {/* .overview-hotspot-why */}
                      <div className="text-[13px] leading-[1.55] text-ink-2">
                        <RichText value={item.why} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                      </div>
                      <RefList refs={item.refs} onSymbol={onSymbol} onFile={onFile} onDecision={onDecision} />
                    </div>
                  </OverviewActionCard>
                )
              )}
            </div>
          </section>
        )}

        {hasDecisions && (
          <section className="mb-[26px] scroll-mt-[130px]" id="decisions">
            <SectionHead title="Decisions" meta={decisions.cards.length} />
            <div className="grid gap-3">
              {decisions.cards.map((card) =>
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
                    inOverview
                  />
                )
              )}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

// .briefing-strip — shared header strip
function BriefingStrip({ desc }: { desc: string }) {
  return (
    <div className="sticky top-0 z-[8] bg-paper border-b border-line px-6 py-[14px] flex flex-wrap gap-x-6 gap-y-4 items-start justify-between">
      {/* .what */}
      <div className="flex gap-[14px] items-start min-w-0 flex-[1_1_360px]">
        {/* .icon */}
        <div className="w-[30px] h-[30px] rounded-[7px] bg-ink text-bg inline-flex items-center justify-center font-sans text-sm font-semibold shrink-0">
          ◇
        </div>
        <div>
          <h1 className="font-sans font-semibold text-base leading-[1.3] mt-0 mb-[3px] text-ink tracking-[-0.005em]">
            High Level
          </h1>
          <div className="text-[12.5px] text-ink-2 leading-[1.5] max-w-[760px]">{desc}</div>
        </div>
      </div>
    </div>
  );
}

// .model-delta-cell + label + text
function ModelDeltaCell({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0 border border-line rounded-[7px] bg-bg-2 overflow-hidden">
      <div className="px-[9px] py-[6px] border-b border-line text-ink-3 font-mono text-[10px] font-semibold tracking-[0.04em] uppercase">
        {label}
      </div>
      <div className="px-[10px] py-[9px] text-ink-2 text-[13px] leading-[1.5]">{children}</div>
    </div>
  );
}

export function OverviewActionCard({
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
  // .overview-card .overview-action .dc-status-{status}
  return (
    <article
      className={`${OVERVIEW_CARD_BASE} grid gap-[10px] scroll-mt-[130px] ${statusGradient(status)}`}
      id={id}
    >
      {/* .dc-head .overview-action-head (margin-bottom 0) */}
      <header className="flex items-center justify-between gap-3 mb-0">
        {/* .dc-tags */}
        <div className="flex gap-[6px] flex-wrap items-center">
          <CatPill>{kind}</CatPill>
          {number && <OverviewNum>{number}</OverviewNum>}
          {status && <DecisionStatusPill status={status} />}
        </div>
        <DecisionTriage status={status} onSetStatus={onSetStatus} />
      </header>
      {children}
    </article>
  );
}

export function CompactReviewCard({
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
  // .overview-card .overview-action .overview-action-compact .dc-status-{status} [.flash]
  return (
    <article
      className={`${OVERVIEW_CARD_BASE} scroll-mt-[130px] grid grid-cols-[minmax(0,1fr)_auto] items-center gap-[14px] px-3 py-[11px] ${statusGradient(
        status
      )} ${flash ? "animate-[flashbg_1.6s_ease-out]" : ""}`}
      id={id}
    >
      {/* .overview-action-main */}
      <div className="min-w-0 grid gap-[6px]">
        {/* .overview-action-tags */}
        <div className="flex items-center flex-wrap gap-[6px]">
          <CatPill>{kind}</CatPill>
          {category && <CatPill>{category}</CatPill>}
          {risk && <OverviewRiskPill risk={risk} />}
          {number && <OverviewNum>{number}</OverviewNum>}
          {status && <DecisionStatusPill status={status} />}
        </div>
        {/* .overview-action-title */}
        <h3 className="m-0 font-sans text-[13.5px] leading-[1.35] font-semibold text-ink [text-wrap:pretty]">{title}</h3>
      </div>
      {/* .overview-action-controls */}
      <div className="self-center">
        <DecisionTriage status={status} onSetStatus={onSetStatus} />
      </div>
    </article>
  );
}

// .overview-card base shared by both action cards
const OVERVIEW_CARD_BASE = "bg-surface border border-line rounded-[9px] px-4 py-[14px]";

// .overview-action.dc-status-{status} gradient backgrounds (overrides bg-surface)
function statusGradient(status: TriageStatus | undefined) {
  if (status === "accept") return "bg-[linear-gradient(180deg,var(--pine-soft)_0%,var(--surface)_30%)]";
  if (status === "flag") return "bg-[linear-gradient(180deg,var(--amber-soft)_0%,var(--surface)_30%)]";
  if (status === "block") return "bg-[linear-gradient(180deg,var(--rose-soft)_0%,var(--surface)_30%)]";
  return "";
}

export function OverviewRiskPill({ risk }: { risk: string }) {
  // .risk-pill.risk-{risk} (note: no leading dot, unlike decisions' RiskPill)
  const tone =
    risk === "high"
      ? "bg-rose-soft text-rose-ink"
      : risk === "med"
      ? "bg-amber-soft text-amber-ink"
      : risk === "low"
      ? "bg-pine-soft text-pine-ink"
      : "";
  return (
    <span
      className={`inline-flex items-center gap-[5px] h-5 px-2 rounded-[4px] font-mono text-[10px] font-medium tracking-[0.03em] ${tone}`}
    >
      {risk}
    </span>
  );
}

export function DecisionStatusPill({ status }: { status: TriageStatus }) {
  // .dc-status-pill.st-{status}
  const tone =
    status === "accept"
      ? "bg-pine-soft text-pine-ink"
      : status === "flag"
      ? "bg-amber-soft text-amber-ink"
      : "bg-rose-soft text-rose-ink";
  return (
    <span
      className={`inline-flex items-center h-5 px-2 rounded-[4px] font-mono text-[10px] font-semibold tracking-[0.03em] ${tone}`}
    >
      {status === "accept" && "✓ Accepted"}
      {status === "flag" && "? Flagged for discussion"}
      {status === "block" && "✗ Blocker"}
    </span>
  );
}

export function DecisionTriage({ status, onSetStatus }: { status: TriageStatus | undefined; onSetStatus: SetStatusHandler }) {
  // .dc-triage + .dc-tri (shared with decisions.tsx TriageButtons)
  const base =
    "appearance-none w-[26px] h-[26px] border border-line-2 bg-surface rounded-[6px] text-ink-3 text-[13px] font-semibold cursor-pointer inline-flex items-center justify-center font-mono hover:bg-bg-3 hover:text-ink";
  return (
    <div className="flex gap-1">
      <button
        className={`${base} ${status === "accept" ? "bg-pine! text-white! border-pine!" : ""}`}
        onClick={() => onSetStatus(status === "accept" ? null : "accept")}
        title="Accept"
      >
        ✓
      </button>
      <button
        className={`${base} ${status === "flag" ? "bg-amber! text-ink! border-amber!" : ""}`}
        onClick={() => onSetStatus(status === "flag" ? null : "flag")}
        title="Flag for discussion"
      >
        ?
      </button>
      <button
        className={`${base} ${status === "block" ? "bg-rose! text-white! border-rose!" : ""}`}
        onClick={() => onSetStatus(status === "block" ? null : "block")}
        title="Mark as blocker"
      >
        ✗
      </button>
    </div>
  );
}
