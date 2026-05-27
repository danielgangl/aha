import { useMemo, useState } from "react";
import type {
  DecisionCardData,
  DecisionCategory,
  DecisionJump,
  DecisionQuestion,
  DecisionSection,
  DiffContent,
  DiffLine,
  PackFile,
  Pr,
  TriageStatus,
} from "./types";

// v2/decisions.jsx — Decisions Mode.
// Decision Cards stacked vertically. Each card states a decision/claim,
// shows evidence rows that jump to the diff, and ends with one concrete
// check for the reviewer. Triage buttons (✓ / ? / ✗) make the cards
// actionable, not just informative.

type Status = TriageStatus | null | undefined;
type JumpHandler = (fileId: string, line?: number) => void;

const RISK_LABEL: Record<string, string> = { high: "High risk", med: "Med risk", low: "Low risk" };

// ── Shared pill / button primitives ─────────────────────────────
// (formerly .cat-pill / .risk-pill / .dc-status-pill / .dc-triage)

// .cat-pill
const CAT_PILL_CLASS =
  "inline-flex items-center h-5 px-2 rounded-[4px] bg-bg-3 text-ink-2 font-mono text-[10px] font-medium tracking-[0.03em] uppercase";

// .dc-status-pill (base, before .st-* color)
const STATUS_PILL_BASE =
  "inline-flex items-center h-5 px-2 rounded-[4px] font-mono text-[10px] font-semibold tracking-[0.03em]";

function CategoryPillBox({ children }: { children: React.ReactNode }) {
  return <span className={CAT_PILL_CLASS}>{children}</span>;
}

function RiskPill({ risk }: { risk?: string }) {
  // .risk-pill + .risk-{risk}
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
      <span className="w-[5px] h-[5px] rounded-full bg-current" />
      {(risk && RISK_LABEL[risk]) || risk}
    </span>
  );
}

function StatusPill({ status }: { status: TriageStatus }) {
  // .dc-status-pill.st-{status}
  const tone =
    status === "accept"
      ? "bg-pine-soft text-pine-ink"
      : status === "flag"
      ? "bg-amber-soft text-amber-ink"
      : "bg-rose-soft text-rose-ink";
  return (
    <span className={`${STATUS_PILL_BASE} ${tone}`}>
      {status === "accept" && "✓ Accepted"}
      {status === "flag" && "? Flagged for discussion"}
      {status === "block" && "✗ Blocker"}
    </span>
  );
}

function CategoryPill({ category, categories }: { category?: string; categories: DecisionCategory[] }) {
  const c = categories.find((c) => c.key === category);
  return <CategoryPillBox>{c?.label || category}</CategoryPillBox>;
}

// .dc-triage + .dc-tri (the three triage toggle buttons, shared visual)
function TriageButtons({
  status,
  onSetStatus,
  acceptTitle = "Accept this decision",
}: {
  status: Status;
  onSetStatus: (status: TriageStatus | null) => void;
  acceptTitle?: string;
}) {
  // .dc-tri base
  const base =
    "appearance-none w-[26px] h-[26px] border border-line-2 bg-surface rounded-[6px] text-ink-3 text-[13px] font-semibold cursor-pointer inline-flex items-center justify-center font-mono hover:bg-bg-3 hover:text-ink";
  return (
    <div className="flex gap-1">
      <button
        className={`${base} ${status === "accept" ? "bg-pine! text-white! border-pine!" : ""}`}
        onClick={() => onSetStatus(status === "accept" ? null : "accept")}
        title={acceptTitle}
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

// .dc-head — shared card header shell (tags left, triage right)
function CardHead({ children }: { children: React.ReactNode }) {
  return <header className="flex items-center justify-between gap-3 mb-[6px]">{children}</header>;
}

function EvidenceRow({
  item,
  onJump,
  kind,
  files,
}: {
  item: DecisionJump;
  onJump: JumpHandler;
  kind?: string;
  files: PackFile[];
}) {
  const filePath = item?.path || item?.fileId;
  const isLink = !!filePath;
  const evidence = findEvidenceLines(item, files);
  const [expanded, setExpanded] = useState(false);

  // .ev-row .ev-mark tone by kind
  const markTone =
    kind === "gap"
      ? "text-rose-ink"
      : kind === "asymmetry"
      ? "text-amber-ink text-[13px] leading-none"
      : kind === "evidence"
      ? "text-pine-ink"
      : "text-ink-4";

  return (
    <div className="flex flex-col gap-[3px]">
      <div
        className={`grid grid-cols-[16px_auto_1fr_auto] gap-2 items-center px-2 py-[5px] rounded-[5px] text-xs group ${
          isLink ? "cursor-pointer hover:bg-bg-3" : ""
        }`}
        onClick={() => isLink && filePath && onJump(filePath, item.line)}
        title={isLink ? `Jump to ${item.ref}` : ""}
      >
        {evidence.length > 0 ? (
          <button
            className={`w-4 h-4 p-0 inline-flex items-center justify-center border border-line rounded-[4px] bg-surface text-ink-3 cursor-pointer font-mono text-[13px] leading-none transition-[transform,color,border-color] duration-[120ms] ease-out hover:border-ink-3 hover:text-ink ${
              expanded ? "rotate-90 text-ink!" : ""
            }`}
            data-open={expanded}
            onClick={(event) => {
              event.stopPropagation();
              setExpanded((value) => !value);
            }}
            title={expanded ? "Hide evidence" : "Show evidence inline"}
          >
            ›
          </button>
        ) : (
          <span className={`font-mono text-center text-[11px] ${markTone}`}>{kindMark(kind)}</span>
        )}
        <span
          className={`font-mono text-[11.5px] font-medium whitespace-nowrap ${
            isLink ? "text-blue-ink" : "text-ink"
          }`}
        >
          {item?.ref}
        </span>
        <span className="text-xs text-ink-2 min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          {item?.desc}
        </span>
        {isLink && (
          <span className="text-ink-4 font-mono text-[11px] group-hover:text-blue-ink">↗</span>
        )}
      </div>
      {expanded && evidence.length > 0 && (
        <div className="mx-2 mb-1 ml-6 border border-line rounded-[6px] overflow-hidden bg-paper">
          {evidence.map((line, index) => (
            <div
              className={`grid grid-cols-[42px_18px_1fr] gap-0 min-w-0 font-mono text-[11.5px] leading-[1.55] ${
                line.k === "add" ? "bg-add-bg" : line.k === "del" ? "bg-del-bg" : ""
              }`}
              key={`${line.k}-${line.L || ""}-${line.R || ""}-${index}`}
            >
              <span className="px-[7px] py-[2px] text-ink-4 text-right border-r border-line">
                {line.R ?? line.L ?? ""}
              </span>
              <span
                className={`py-[2px] text-center ${
                  line.k === "add" ? "text-add-mark" : line.k === "del" ? "text-del-mark" : "text-ink-3"
                }`}
              >
                {sigFor(line.k)}
              </span>
              <span className="py-[2px] pr-2 pl-0 text-ink overflow-hidden text-ellipsis whitespace-pre">
                {renderCodeText(line.c)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
function kindMark(k?: string) {
  const marks: Record<string, string> = { evidence: "→", gap: "✗", asymmetry: "⚖", alternative: "·", check: "?" };
  return (k && marks[k]) || "·";
}

function DecisionCard({
  card,
  categories,
  onJump,
  status,
  onSetStatus,
  files,
  flash,
  inOverview,
}: {
  card: DecisionCardData;
  categories: DecisionCategory[];
  onJump: JumpHandler;
  status: Status;
  onSetStatus: (status: TriageStatus | null) => void;
  files: PackFile[];
  flash?: boolean;
  // When rendered inside the High-Level overview, .overview-doc .dc[data-risk]
  // overrides the 3px risk accent with a flat 1px line.
  inOverview?: boolean;
}) {
  const sections = Array.isArray(card.sections) ? card.sections : [];

  // .dc base
  // .dc[data-risk] left border (overridden to 1px line inside .overview-doc).
  // Risk accent reproduced via inline left border below.
  const riskBorder = inOverview
    ? "border-l border-l-line"
    : card.risk === "high"
    ? "border-l-[3px] border-l-rose"
    : card.risk === "med"
    ? "border-l-[3px] border-l-amber"
    : card.risk === "low"
    ? "border-l-[3px] border-l-pine"
    : "";

  // .dc.dc-status-* gradient backgrounds
  const statusBg =
    status === "accept"
      ? "bg-[linear-gradient(180deg,var(--pine-soft)_0%,var(--surface)_30%)]"
      : status === "flag"
      ? "bg-[linear-gradient(180deg,var(--amber-soft)_0%,var(--surface)_30%)]"
      : status === "block"
      ? "bg-[linear-gradient(180deg,var(--rose-soft)_0%,var(--surface)_30%)]"
      : "bg-surface";

  return (
    <article
      className={`relative border border-line rounded-[12px] px-5 pt-[18px] pb-4 mb-[14px] scroll-mt-[130px] ${statusBg} ${riskBorder} ${
        flash ? "animate-[flashbg_1.6s_ease-out]" : ""
      }`}
      id={card.id}
      data-risk={card.risk}
    >
      <CardHead>
        <div className="flex gap-[6px] flex-wrap items-center">
          <CategoryPill category={card.category} categories={categories} />
          <RiskPill risk={card.risk} />
          {status && <StatusPill status={status} />}
        </div>
        <TriageButtons status={status} onSetStatus={onSetStatus} />
      </CardHead>

      <h3 className="font-sans font-semibold text-base leading-[1.3] tracking-[-0.008em] text-ink mt-[6px] mb-2">
        {card.title}
      </h3>
      <p className="text-[13.5px] leading-[1.55] text-ink mt-0 mb-[10px] [text-wrap:pretty]">{card.claim}</p>
      {card.whyItMatters && (
        <p className="text-[12.5px] leading-[1.55] text-ink-2 mt-0 mb-3 [text-wrap:pretty] pl-3 border-l-2 border-line-2">
          <span className="block text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3 mb-1">
            Why it matters
          </span>
          {card.whyItMatters}
        </p>
      )}

      {sections.map((sec: DecisionSection, i) => {
        if (sec.kind === "check") {
          return (
            <div
              className="mt-3 px-3 py-[10px] bg-bg-2 border border-line rounded-[7px] flex flex-col gap-[3px]"
              key={`${sec.kind || "section"}-${sec.label || i}`}
            >
              <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">Check</span>
              <span className="text-[13px] leading-[1.5] text-ink font-sans font-medium [text-wrap:pretty]">
                {sec.text}
              </span>
            </div>
          );
        }
        return (
          <SectionBlock kind={sec.kind} label={sec.label} key={`${sec.kind || "section"}-${sec.label || i}`}>
            {(Array.isArray(sec.items) ? sec.items : []).filter(Boolean).map((it, j) => (
              <EvidenceRow
                key={`${it.ref || "item"}-${it.path || it.fileId || "no-file"}-${it.line || j}`}
                item={it}
                kind={sec.kind}
                files={files}
                onJump={onJump}
              />
            ))}
          </SectionBlock>
        );
      })}
    </article>
  );
}

// .dc-section + .dc-section-label (with kind-specific ::before glyph)
function SectionBlock({
  kind,
  label,
  children,
}: {
  kind?: string;
  label?: string;
  children: React.ReactNode;
}) {
  // ::before glyph + color per kind (was .dc-section.dc-{kind} .dc-section-label::before)
  let glyph: React.ReactNode = null;
  if (kind === "gap") glyph = <span className="font-mono text-rose-ink">✗</span>;
  else if (kind === "asymmetry") glyph = <span className="text-amber-ink">⚖</span>;
  else if (kind === "evidence") glyph = <span className="font-mono text-pine-ink">→</span>;
  else if (kind === "alternative") glyph = <span className="font-mono text-[14px] text-ink-3">·</span>;

  return (
    <div className="mt-[10px] mb-2">
      <div className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3 mb-[6px] flex items-center gap-[6px]">
        {glyph}
        {label}
      </div>
      <div className="flex flex-col gap-[3px]">{children}</div>
    </div>
  );
}

function QuestionsList({ questions, onJump }: { questions: DecisionQuestion[]; onJump: JumpHandler }) {
  return (
    <ol className="list-none p-0 m-0 flex flex-col gap-2">
      {questions.map((q, i) => (
        <li
          key={q.id || `question-${i}`}
          className="grid grid-cols-[30px_1fr] gap-3 items-start px-[14px] py-3 bg-surface border border-line rounded-[9px]"
        >
          <span className="font-mono text-[13px] font-semibold text-ink bg-bg-3 rounded-[5px] w-[26px] h-[26px] inline-flex items-center justify-center">
            {i + 1}
          </span>
          <div className="flex flex-col gap-[7px]">
            <div className="text-[13.5px] leading-[1.5] text-ink font-sans [text-wrap:pretty]">{q.text}</div>
            <div className="flex gap-[6px] flex-wrap">
              {(Array.isArray(q.jumps) ? q.jumps : []).filter(Boolean).map((j, k) => (
                <button
                  key={`${j.path || j.fileId || "jump"}-${j.line || k}`}
                  className="inline-flex items-center gap-1 h-[22px] px-2 rounded-[4px] border border-line-2 bg-surface text-blue-ink font-mono text-[10.5px] cursor-pointer hover:bg-blue-soft"
                  onClick={() => onJump((j.path || j.fileId) as string, j.line)}
                  title={`Jump to file:${j.line}`}
                >
                  ↗ jump to diff
                </button>
              ))}
            </div>
          </div>
        </li>
      ))}
    </ol>
  );
}

function findEvidenceLines(item: DecisionJump, files: PackFile[]): DiffLine[] {
  const filePath = item?.path || item?.fileId;
  if (!filePath || item.line == null) return [];
  const file = files.find((file) => file.path === filePath || file.id === filePath);
  if (!file) return [];
  return file.diff.filter((line) => line.R === item.line || line.L === item.line);
}

function renderCodeText(content: DiffContent): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((part) => (typeof part === "string" ? part : part?.label || "")).join("");
}

function sigFor(kind: string): string {
  if (kind === "add") return "+";
  if (kind === "del") return "−";
  return " ";
}

// ── Left rail in Decisions mode ─────────────────────────────────
function DecisionsLeftRail({
  decisions,
  statusMap,
  activeCat,
  onPickCat,
}: {
  decisions: Pr["decisions"];
  statusMap: Record<string, TriageStatus>;
  activeCat: string;
  onPickCat: (key: string) => void;
}) {
  const counts = decisions.categories.map((c) => {
    if (c.key === "questions") return decisions.questions.length;
    return decisions.cards.filter((card) => card.category === c.key).length;
  });
  const triaged = decisions.cards.filter((c) => statusMap[c.id]).length;
  const total = decisions.cards.length;
  const progress = total > 0 ? (triaged / total) * 100 : 0;

  // .rl-left
  return (
    <aside className="relative border-r border-line bg-rail overflow-y-auto text-xs">
      {/* .rl-h */}
      <div className="px-[14px] pt-3 pb-2 border-b border-line flex items-center justify-between">
        <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">Review checklist</span>
        <span className="font-mono text-[10.5px] text-ink-3">{decisions.cards.length} decisions</span>
      </div>

      {/* .dec-summary */}
      <div className="px-[14px] py-3 border-b border-line flex flex-col gap-2">
        <div className="flex gap-2">
          <SummaryStat
            value={decisions.cards.filter((c) => statusMap[c.id] === "accept").length}
            label="accepted"
            tone="text-pine-ink"
          />
          <SummaryStat
            value={decisions.cards.filter((c) => statusMap[c.id] === "flag").length}
            label="flagged"
            tone="text-amber-ink"
          />
          <SummaryStat
            value={decisions.cards.filter((c) => statusMap[c.id] === "block").length}
            label="blocking"
            tone="text-rose-ink"
          />
        </div>
        {/* .ds-progress */}
        <div className="flex items-center gap-2">
          <div className="flex-1 h-1 bg-bg-3 rounded-[2px] overflow-hidden">
            <div className="h-full bg-ink rounded-[2px] transition-[width] duration-200" style={{ width: `${progress}%` }} />
          </div>
          <span className="font-mono text-[10.5px] text-ink-2">
            {triaged}/{total}
          </span>
        </div>
      </div>

      {/* .rl-group (paddingTop: 0) */}
      <div className="pt-0">
        {/* .rl-group-title */}
        <div className="px-[14px] pt-[9px] pb-1 grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-[7px] gap-y-1 text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">
          <span>Categories</span>
        </div>
        {decisions.categories.map((c, i) => (
          <div
            key={c.key || `category-${i}`}
            className={`relative pl-[14px] pr-3 py-2 grid grid-cols-[1fr_auto] gap-x-2 gap-y-[2px] cursor-pointer border-l-2 hover:bg-bg-3 ${
              activeCat === c.key ? "bg-surface border-l-ink" : "border-l-transparent"
            }`}
            onClick={() => onPickCat(c.key)}
            title={c.why}
          >
            <span className="text-xs font-medium text-ink">{c.label}</span>
            <span className="text-[10.5px] text-ink-3 [font-variant-numeric:tabular-nums] self-start font-mono">
              {counts[i]}
            </span>
            <span className="col-[1/-1] text-[11px] text-ink-3 mt-px">{c.why}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}

// .ds-stat
function SummaryStat({ value, label, tone }: { value: number; label: string; tone: string }) {
  return (
    <div className="flex-1 bg-surface border border-line rounded-[6px] px-2 py-[6px] flex flex-col gap-px">
      <div className={`font-mono text-base font-semibold leading-none ${tone}`}>{value}</div>
      <div className="text-[9.5px] tracking-[0.04em] uppercase text-ink-3">{label}</div>
    </div>
  );
}

// .dec-cat-head — shared category header (used in both branches below)
function CategoryHeader({ label, why, count }: { label?: string; why?: string; count: number }) {
  return (
    <div className="flex items-baseline gap-3 mb-3 pb-2 border-b border-line">
      <h2 className="font-sans font-semibold text-base tracking-[-0.005em] m-0 text-ink">{label}</h2>
      <span className="flex-1 text-xs text-ink-3">{why}</span>
      <span className="font-mono text-[11px] text-ink-3 [font-variant-numeric:tabular-nums]">{count}</span>
    </div>
  );
}

// ── Main view in Decisions mode ─────────────────────────────────
function DecisionsView({
  pr,
  statusMap,
  setStatus,
  onJump,
  flashId,
}: {
  pr: Pr;
  statusMap: Record<string, TriageStatus>;
  setStatus: (id: string, status: TriageStatus | null) => void;
  onJump: JumpHandler;
  flashId: string | null;
}) {
  const d = pr.decisions;
  const byCat = useMemo(() => {
    const m: Record<string, DecisionCardData[]> = {};
    for (const c of d.categories) m[c.key] = [];
    for (const card of d.cards) {
      if (!card.category) continue;
      if (!m[card.category]) m[card.category] = [];
      m[card.category].push(card);
    }
    return m;
  }, [d]);

  return (
    <div className="h-full">
      {/* Slim header — same shape as v2 briefing strip but a different role.
          .briefing-strip */}
      <div className="sticky top-0 z-[8] bg-paper border-b border-line px-6 py-[14px] flex flex-wrap gap-x-6 gap-y-4 items-start justify-between">
        <div className="flex gap-[14px] items-start min-w-0 flex-[1_1_360px]">
          <div className="w-[30px] h-[30px] rounded-[7px] bg-ink text-bg inline-flex items-center justify-center font-sans text-sm font-semibold shrink-0">
            ¶
          </div>
          <div>
            <h1 className="font-sans font-semibold text-base leading-[1.3] mt-0 mb-[3px] text-ink tracking-[-0.005em]">
              What does this PR actually decide?
            </h1>
            <div className="text-[12.5px] text-ink-2 leading-[1.5] max-w-[760px]">
              Each card is a single decision, claim, or asymmetry. Triage with ✓ accept / ? discuss / ✗ block. Every
              reference links back into the diff.
            </div>
          </div>
        </div>
        {/* .order */}
        <div className="flex flex-col gap-2">
          <span className="text-[10px] font-semibold tracking-[0.06em] uppercase text-ink-3">Jump to category</span>
          <div className="flex flex-wrap gap-[6px]">
            {d.categories.map((c, i) => (
              <button
                key={c.key || `category-${i}`}
                className="inline-flex items-center gap-[6px] h-[22px] px-2 rounded-[4px] border border-line-2 bg-surface text-ink-2 text-[11px] cursor-pointer hover:bg-bg-3"
                onClick={() => {
                  const el = document.getElementById(`cat-${c.key || i}`);
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                title={c.why}
              >
                <span className="font-mono text-[10px] text-ink-3">{i + 1}</span>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* .dec-wrap */}
      <div className="px-7 pt-[22px] pb-20 max-w-[920px] mx-auto max-[980px]:px-[18px] max-[980px]:pt-[18px]">
        {d.categories.map((cat, catIndex) => {
          if (cat.key === "questions") {
            return (
              <section
                className="mb-7 scroll-mt-[130px]"
                id={`cat-${cat.key || catIndex}`}
                key={cat.key || `category-${catIndex}`}
              >
                <CategoryHeader label={cat.label} why={cat.why} count={d.questions.length} />
                <QuestionsList questions={d.questions} onJump={onJump} />
              </section>
            );
          }
          const cards = byCat[cat.key];
          if (!cards || !cards.length) return null;
          return (
            <section
              className="mb-7 scroll-mt-[130px]"
              id={`cat-${cat.key || catIndex}`}
              key={cat.key || `category-${catIndex}`}
            >
              <CategoryHeader label={cat.label} why={cat.why} count={cards.length} />
              {cards.map((card, cardIndex) => (
                <DecisionCard
                  key={card.id || `${cat.key || "category"}-${cardIndex}`}
                  card={card}
                  categories={d.categories}
                  files={pr.files}
                  onJump={onJump}
                  status={statusMap[card.id]}
                  onSetStatus={(s) => setStatus(card.id, s)}
                  flash={flashId === card.id}
                />
              ))}
            </section>
          );
        })}

        {/* .dec-foot */}
        <div className="mt-6 px-[18px] py-4 border-t border-line flex items-center justify-between gap-3 text-xs">
          <span className="text-ink-3">
            When triage is complete, submit your review — flagged and blocking items become inline comments on the diff.
          </span>
          {/* .btn.primary */}
          <button className="h-7 px-[11px] border border-ink rounded-[7px] bg-ink text-bg text-xs font-medium cursor-pointer inline-flex items-center gap-[6px] hover:opacity-90">
            Submit review
          </button>
        </div>
      </div>
    </div>
  );
}

export { DecisionCard, DecisionsView, DecisionsLeftRail };
