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

function RiskPill({ risk }: { risk?: string }) {
  return (
    <span className={`risk-pill risk-${risk}`}>
      <span className="dot" />
      {(risk && RISK_LABEL[risk]) || risk}
    </span>
  );
}

function CategoryPill({ category, categories }: { category?: string; categories: DecisionCategory[] }) {
  const c = categories.find((c) => c.key === category);
  return <span className="cat-pill">{c?.label || category}</span>;
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
  return (
    <div className="ev-wrap">
      <div
        className={`ev-row ${kind} ${isLink ? "is-link" : ""}`}
        onClick={() => isLink && filePath && onJump(filePath, item.line)}
        title={isLink ? `Jump to ${item.ref}` : ""}
      >
        {evidence.length > 0 ? (
          <button
            className="ev-expand"
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
          <span className="ev-mark">{kindMark(kind)}</span>
        )}
        <span className="ev-ref">{item?.ref}</span>
        <span className="ev-desc">{item?.desc}</span>
        {isLink && <span className="ev-arrow">↗</span>}
      </div>
      {expanded && evidence.length > 0 && (
        <div className="ev-inline">
          {evidence.map((line, index) => (
            <div className={`ev-code ev-code-${line.k}`} key={`${line.k}-${line.L || ""}-${line.R || ""}-${index}`}>
              <span className="ev-ln">{line.R ?? line.L ?? ""}</span>
              <span className="ev-sig">{sigFor(line.k)}</span>
              <span className="ev-code-text">{renderCodeText(line.c)}</span>
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
}: {
  card: DecisionCardData;
  categories: DecisionCategory[];
  onJump: JumpHandler;
  status: Status;
  onSetStatus: (status: TriageStatus | null) => void;
  files: PackFile[];
  flash?: boolean;
}) {
  const sections = Array.isArray(card.sections) ? card.sections : [];
  return (
    <article
      className={`dc dc-status-${status || "open"} ${flash ? "flash" : ""}`}
      id={card.id}
      data-risk={card.risk}
    >
      <header className="dc-head">
        <div className="dc-tags">
          <CategoryPill category={card.category} categories={categories} />
          <RiskPill risk={card.risk} />
          {status && (
            <span className={`dc-status-pill st-${status}`}>
              {status === "accept" && "✓ Accepted"}
              {status === "flag"   && "? Flagged for discussion"}
              {status === "block"  && "✗ Blocker"}
            </span>
          )}
        </div>
        <div className="dc-triage">
          <button
            className={`dc-tri ok ${status === "accept" ? "on" : ""}`}
            onClick={() => onSetStatus(status === "accept" ? null : "accept")}
            title="Accept this decision"
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
      </header>

      <h3 className="dc-title">{card.title}</h3>
      <p className="dc-claim">{card.claim}</p>
      {card.whyItMatters && (
        <p className="dc-why">
          <span className="dc-why-label">Why it matters</span>
          {card.whyItMatters}
        </p>
      )}

      {sections.map((sec: DecisionSection, i) => {
        if (sec.kind === "check") {
          return (
            <div className="dc-check" key={`${sec.kind || "section"}-${sec.label || i}`}>
              <span className="dc-check-label">Check</span>
              <span className="dc-check-text">{sec.text}</span>
            </div>
          );
        }
        return (
          <div className={`dc-section dc-${sec.kind}`} key={`${sec.kind || "section"}-${sec.label || i}`}>
            <div className="dc-section-label">{sec.label}</div>
            <div className="dc-section-items">
              {(Array.isArray(sec.items) ? sec.items : []).filter(Boolean).map((it, j) => (
                <EvidenceRow
                  key={`${it.ref || "item"}-${it.path || it.fileId || "no-file"}-${it.line || j}`}
                  item={it}
                  kind={sec.kind}
                  files={files}
                  onJump={onJump}
                />
              ))}
            </div>
          </div>
        );
      })}
    </article>
  );
}

function QuestionsList({ questions, onJump }: { questions: DecisionQuestion[]; onJump: JumpHandler }) {
  return (
    <ol className="dc-questions">
      {questions.map((q, i) => (
        <li key={q.id || `question-${i}`} className="dc-question">
          <span className="num">{i + 1}</span>
          <div className="body">
            <div className="text">{q.text}</div>
            <div className="jumps">
              {(Array.isArray(q.jumps) ? q.jumps : []).filter(Boolean).map((j, k) => (
                <button
                  key={`${j.path || j.fileId || "jump"}-${j.line || k}`}
                  className="jump-chip"
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

  return (
    <aside className="rail-left">
      <div className="rl-h">
        <span className="label">Review checklist</span>
        <span className="count">{decisions.cards.length} decisions</span>
      </div>

      <div className="dec-summary">
        <div className="ds-row">
          <div className="ds-stat ok">
            <div className="v">{decisions.cards.filter((c) => statusMap[c.id] === "accept").length}</div>
            <div className="l">accepted</div>
          </div>
          <div className="ds-stat flag">
            <div className="v">{decisions.cards.filter((c) => statusMap[c.id] === "flag").length}</div>
            <div className="l">flagged</div>
          </div>
          <div className="ds-stat block">
            <div className="v">{decisions.cards.filter((c) => statusMap[c.id] === "block").length}</div>
            <div className="l">blocking</div>
          </div>
        </div>
        <div className="ds-progress">
          <div className="ds-track">
            <div className="ds-fill" style={{ width: `${progress}%` }} />
          </div>
          <span className="ds-num mono">{triaged}/{total}</span>
        </div>
      </div>

      <div className="rl-group" style={{ paddingTop: 0 }}>
        <div className="rl-group-title">
          <span>Categories</span>
        </div>
        {decisions.categories.map((c, i) => (
          <div
            key={c.key || `category-${i}`}
            className="rl-cat"
            data-active={activeCat === c.key}
            onClick={() => onPickCat(c.key)}
            title={c.why}
          >
            <span className="rl-cat-name">{c.label}</span>
            <span className="rl-cat-why">{c.why}</span>
            <span className="rl-cat-ct mono">{counts[i]}</span>
          </div>
        ))}
      </div>
    </aside>
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
    <div className="dec-doc">
      {/* Slim header — same shape as v2 briefing strip but a different role */}
      <div className="briefing-strip">
        <div className="what">
          <div className="icon">¶</div>
          <div>
            <h1>What does this PR actually decide?</h1>
            <div className="desc">
              Each card is a single decision, claim, or asymmetry. Triage with ✓ accept / ? discuss / ✗ block. Every reference links back into the diff.
            </div>
          </div>
        </div>
        <div className="order">
          <span className="label">Jump to category</span>
          <div className="order-chips">
            {d.categories.map((c, i) => (
              <button
                key={c.key || `category-${i}`}
                className="order-chip"
                onClick={() => {
                  const el = document.getElementById(`cat-${c.key || i}`);
                  if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
                }}
                title={c.why}
              >
                <span className="n">{i + 1}</span>
                {c.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="dec-wrap">
        {d.categories.map((cat, catIndex) => {
          if (cat.key === "questions") {
            return (
              <section className="dec-cat" id={`cat-${cat.key || catIndex}`} key={cat.key || `category-${catIndex}`}>
                <div className="dec-cat-head">
                  <h2 className="dec-cat-title">{cat.label}</h2>
                  <span className="dec-cat-why">{cat.why}</span>
                  <span className="dec-cat-count mono">{d.questions.length}</span>
                </div>
                <QuestionsList questions={d.questions} onJump={onJump} />
              </section>
            );
          }
          const cards = byCat[cat.key];
          if (!cards || !cards.length) return null;
          return (
            <section className="dec-cat" id={`cat-${cat.key || catIndex}`} key={cat.key || `category-${catIndex}`}>
              <div className="dec-cat-head">
                <h2 className="dec-cat-title">{cat.label}</h2>
                <span className="dec-cat-why">{cat.why}</span>
                <span className="dec-cat-count mono">{cards.length}</span>
              </div>
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

        <div className="dec-foot">
          <span className="muted">
            When triage is complete, submit your review — flagged and blocking items become inline comments on the diff.
          </span>
          <button className="btn primary">Submit review</button>
        </div>
      </div>
    </div>
  );
}

export { DecisionCard, DecisionsView, DecisionsLeftRail };
