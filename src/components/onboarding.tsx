import { useEffect, useRef, useState } from "react";
import type { Runtime } from "../types";
import { DEFAULT_RUNTIME } from "../lib/pack";
import { WorkflowCopyBlock } from "./workflow";
import {
  fillAhaWorkflowPrompt,
  ahaCommand,
  AHA_FULL_WORKFLOW_INIT_PROMPT,
  AHA_FULL_WORKFLOW_UPDATE_PROMPT,
} from "../prompts.js";

type StepState = "active" | "upcoming" | "done";

// .onb-step-line — vertical rail segment. Default line-2; pine-ink when its
// adjacent step is done (data-rail-down / data-rail-up). The "up" segment that
// turns done carries an extra .18s transition-delay (matched here).
function StepRail({
  state,
  num,
  hideUp = false,
  hideDown = false,
  upDone = false,
  downDone = false,
}: {
  state: StepState;
  num: number;
  hideUp?: boolean;
  hideDown?: boolean;
  upDone?: boolean;
  downDone?: boolean;
}) {
  const lineBase =
    "flex-auto w-px min-h-[10px] transition-[background] duration-[0.4s] ease-[ease]";

  // .onb-step-num + state variants
  const numBase =
    "relative z-[1] flex-none w-8 h-8 grid place-items-center rounded-full border font-mono text-[12.5px] font-semibold " +
    "transition-[background,border-color,color,box-shadow] duration-300 ease-[ease]";
  const numState =
    state === "active"
      ? "border-blue text-blue-ink bg-blue-soft shadow-[0_0_0_4px_color-mix(in_oklab,var(--color-blue)_13%,transparent)]"
      : state === "done"
        ? "border-pine-ink text-bg bg-pine-ink shadow-[0_6px_16px_-10px_color-mix(in_oklab,var(--color-pine-ink)_90%,transparent)]"
        : "border-line-2 bg-surface text-ink-4 shadow-[0_1px_0_color-mix(in_oklab,var(--color-surface)_60%,#fff)]";

  return (
    <div className="relative w-8 flex flex-col items-center">
      <span
        className={
          lineBase +
          " " +
          (hideUp ? "invisible " : "") +
          (upDone ? "bg-pine-ink delay-[0.18s]" : "bg-line-2")
        }
      />
      <span className={numBase + " " + numState}>
        <span
          className={
            "[transition:opacity_.2s_ease,transform_.26s_cubic-bezier(.2,.8,.2,1)] " +
            (state === "done" ? "opacity-0 scale-50" : "")
          }
        >
          {num}
        </span>
        {/* .onb-step-check — checkmark drawn with two borders; fades/scales in when done */}
        <span
          aria-hidden="true"
          className={
            "absolute left-1/2 top-1/2 w-[11px] h-[6px] border-l-2 border-b-2 border-current rounded-bl-[1px] " +
            "[transition:opacity_.2s_ease,transform_.32s_cubic-bezier(.2,.9,.25,1.45)] " +
            (state === "done"
              ? "opacity-100 [transform:translate(-50%,-62%)_rotate(-45deg)_scale(1)]"
              : "opacity-0 [transform:translate(-50%,-62%)_rotate(-45deg)_scale(.4)]")
          }
        />
      </span>
      <span
        className={
          lineBase +
          " " +
          (hideDown ? "invisible " : "") +
          (downDone ? "bg-pine-ink" : "bg-line-2")
        }
      />
    </div>
  );
}

// .onb-step-main — label + hint text block shared by steps 2 & 3.
function StepInfo({ label, hint }: { label: string; hint: string }) {
  return (
    <div className="min-w-0 py-[9px] grid gap-2.5 content-center">
      <div className="grid gap-[3px] min-w-0">
        <span className="text-sm font-semibold leading-[1.3] tracking-[-0.006em] text-ink">{label}</span>
        <span className="font-mono text-[11px] leading-[1.4] text-ink-3">{hint}</span>
      </div>
    </div>
  );
}

export function EmptyOnboarding({ runtime = DEFAULT_RUNTIME }: { runtime?: Runtime }) {
  const cliCommand = runtime.ahaCli || DEFAULT_RUNTIME.ahaCli;
  const packPath = "/absolute/path/to/aha/packs/<repo>/<pr-number>/aha-<branch>-<pr-number>.json";
  const openExistingCommand = ahaCommand("review", { cliCommand, packPath });
  const generateCommand = `PR_NUMBER="$(gh pr view --json number -q .number)"\n${ahaCommand("generate-auto", { cliCommand, prNumber: '"$PR_NUMBER"' })}`;
  const generateAndServeCommand = `AHA_CLI=${cliCommand}\nPR_NUMBER="$(gh pr view --json number -q .number)"\nPACK_PATH="$("$AHA_CLI" generate --pr "$PR_NUMBER" | tail -n 1)"\n"$AHA_CLI" serve --pack "$PACK_PATH" --port 4173 --host 127.0.0.1`;
  const fullWorkflowPrompt = fillAhaWorkflowPrompt(AHA_FULL_WORKFLOW_INIT_PROMPT, {
    cliCommand,
    targetRepo: "",
    prNumber: "",
    packPath,
  });

  const [done, setDone] = useState(false);
  const stepState = (step: number): StepState => {
    if (!done) return step === 1 ? "active" : "upcoming";
    if (step === 1) return "done";
    return step === 2 ? "active" : "upcoming";
  };

  // .onb-rise entrance animation, staggered per element via animation-delay.
  const rise = "[animation:onb-rise_.58s_cubic-bezier(.2,.7,.2,1)_both] motion-reduce:animate-none";

  return (
    <main className="h-full overflow-y-auto grid place-items-center pt-14 px-6 pb-[72px] text-ink bg-[radial-gradient(112%_70%_at_50%_-8%,color-mix(in_oklab,var(--color-blue-soft)_58%,transparent),transparent_62%),var(--color-paper)]">
      <div className="w-[min(540px,100%)] flex flex-col items-center text-center">
        <div
          aria-hidden="true"
          className={
            "w-14 h-14 grid place-items-center mb-[26px] rounded-2xl bg-surface border border-line-2 text-ink text-[22px] leading-none " +
            "shadow-[0_1px_0_color-mix(in_oklab,var(--color-surface)_60%,#fff),0_22px_44px_-26px_color-mix(in_oklab,var(--color-blue)_60%,transparent)] " +
            rise +
            " [animation-delay:.02s]"
          }
        >
          ◇
        </div>
        <h1
          className={
            "m-0 max-w-[14ch] font-sans font-semibold text-[clamp(28px,4.6vw,40px)] leading-[1.08] tracking-[-0.022em] text-ink " +
            rise +
            " [animation-delay:.09s]"
          }
        >
          Your agent will set everything up for you.
        </h1>
        <p
          className={
            "mt-4 mb-0 max-w-[40ch] text-[15px] leading-[1.6] text-ink-3 " + rise + " [animation-delay:.17s]"
          }
        >
          Hand one prompt to your coding agent. It generates the pack, enriches
          the review, and opens it right here.
        </p>

        <ol
          className={
            "mt-[34px] mb-0 p-0 list-none w-[min(460px,100%)] text-left flex flex-col gap-0 " +
            rise +
            " [animation-delay:.25s]"
          }
          aria-label="Setup steps"
        >
          <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-[14px] items-stretch" data-state={stepState(1)}>
            <StepRail state={stepState(1)} num={1} hideUp downDone={done} />
            <OnboardingPromptAction
              prompt={fullWorkflowPrompt}
              active={stepState(1) === "active"}
              onCopied={() => setDone(true)}
            />
          </li>
          <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-[14px] items-stretch" data-state={stepState(2)}>
            <StepRail state={stepState(2)} num={2} upDone={done} />
            <StepInfo label="Paste it into your coding agent" hint="Give it the target repo path and PR" />
          </li>
          <li className="grid grid-cols-[32px_minmax(0,1fr)] gap-[14px] items-stretch" data-state={stepState(3)}>
            <StepRail state={stepState(3)} num={3} hideDown />
            <StepInfo label="Your review opens right here" hint="It generates, enriches, and loads it for you" />
          </li>
        </ol>

        <details
          className={
            "mt-[30px] w-full max-w-[440px] " + rise + " [animation-delay:.33s] group/manual"
          }
        >
          <summary className="list-none [&::-webkit-details-marker]:hidden cursor-pointer select-none px-2.5 py-[7px] rounded-[9px] text-[12.5px] text-ink-4 transition-[color,background] duration-[0.14s] ease-[ease] hover:text-ink-2 hover:bg-[color-mix(in_oklab,var(--color-bg-3)_60%,transparent)] after:content-['›'] after:ml-1.5 after:font-mono after:inline-block after:transition-transform after:duration-[0.16s] after:ease-[ease] group-open/manual:after:rotate-90">
            Rather run the steps yourself?
          </summary>
          <div className="mt-[14px] grid gap-2.5 text-left [animation:onb-rise_.32s_ease_both] motion-reduce:animate-none">
            <WorkflowCopyBlock title="Open an existing pack" text={openExistingCommand} blockClassName="bg-surface" />
            <WorkflowCopyBlock title="Generate the deterministic base" text={generateCommand} blockClassName="bg-surface" />
            <WorkflowCopyBlock title="Generate and serve in this terminal" text={generateAndServeCommand} blockClassName="bg-surface" />
          </div>
        </details>
      </div>
    </main>
  );
}

export function OnboardingPromptAction({
  prompt,
  active = false,
  onCopied,
  label = "Copy instructions",
}: {
  prompt: string;
  active?: boolean;
  onCopied?: () => void;
  label?: string;
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
      // .onb-step1 — interactive step-1 card. data-copied=true freezes hover lift.
      className={
        "w-full min-w-0 my-1.5 grid grid-cols-[minmax(0,1fr)] gap-[9px] px-[13px] py-[11px] border border-line-2 rounded-[11px] bg-bg-2 text-left cursor-pointer " +
        "shadow-[inset_0_1px_0_color-mix(in_oklab,#fff_45%,transparent)] transition-[border-color,box-shadow,transform] duration-200 ease-[ease] " +
        "hover:border-line-3 hover:-translate-y-px hover:shadow-[0_12px_24px_-20px_color-mix(in_oklab,var(--color-ink)_80%,transparent)] " +
        "active:translate-y-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue focus-visible:outline-offset-2 " +
        "data-[copied=true]:cursor-default data-[copied=true]:transform-none data-[copied=true]:border-line-2 data-[copied=true]:shadow-[inset_0_1px_0_color-mix(in_oklab,#fff_45%,transparent)]"
      }
      type="button"
      data-copied={copied}
      onClick={copy}
      aria-label={copied ? "Copied to clipboard" : label}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="text-sm font-semibold leading-[1.3] tracking-[-0.006em] text-ink">{label}</span>
        <span
          className={
            "inline-flex items-center gap-[7px] flex-none text-[11.5px] font-semibold tracking-[-0.003em] transition-[color] duration-200 ease-[ease] " +
            (copied ? "text-ink-4" : "text-blue-ink")
          }
        >
          {/* .onb-peek-arrow — wandering chevron drawn with two borders, animated. */}
          {active && !copied && (
            <span
              aria-hidden="true"
              className="flex-none w-1.5 h-1.5 border-t-[1.5px] border-r-[1.5px] border-blue rounded-tr-[2px] [transform:translateX(-3px)_rotate(45deg)] [animation:onb-arrow-wander_1.4s_cubic-bezier(.45,0,.55,1)_infinite] pointer-events-none motion-reduce:animate-none motion-reduce:opacity-70 motion-reduce:[transform:rotate(45deg)]"
            />
          )}
          <span className="leading-none">{copied ? "Copied" : "Copy"}</span>
        </span>
      </span>
      <code
        className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[11px] text-ink-3"
        title={firstLine}
      >
        {firstLine}
      </code>
    </button>
  );
}

// Update modal — onboarding-style: show the full update prompt with a single
// copy action and a "paste it into your agent" hint.
export function UpdateModal({ runtime = DEFAULT_RUNTIME, onClose }: { runtime?: Runtime; onClose: () => void }) {
  const cliCommand = runtime.ahaCli || DEFAULT_RUNTIME.ahaCli;
  const updatePrompt = fillAhaWorkflowPrompt(AHA_FULL_WORKFLOW_UPDATE_PROMPT, {
    cliCommand,
    targetRepo: "",
    prNumber: "",
    packPath: "/absolute/path/to/aha/packs/<repo>/<pr-number>/aha-<branch>-<pr-number>.json",
  });

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center p-6 bg-[color-mix(in_oklab,var(--color-ink)_22%,transparent)]"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="relative w-[min(520px,100%)] rounded-2xl border border-line-2 bg-surface p-7 shadow-[0_24px_80px_color-mix(in_oklab,var(--color-ink)_22%,transparent)]"
        role="dialog"
        aria-modal="true"
        aria-label="Update this review"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <button
          className="absolute top-3 right-3 w-7 h-7 border-0 rounded-[5px] bg-transparent text-ink-3 text-[20px] leading-none cursor-pointer hover:bg-bg-3 hover:text-ink"
          type="button"
          onClick={onClose}
          aria-label="Close"
        >
          ×
        </button>
        <div className="flex flex-col items-center text-center">
          <div
            aria-hidden="true"
            className="w-14 h-14 grid place-items-center mb-[22px] rounded-2xl bg-surface border border-line-2 text-ink text-[22px] leading-none shadow-[0_1px_0_color-mix(in_oklab,var(--color-surface)_60%,#fff),0_22px_44px_-26px_color-mix(in_oklab,var(--color-blue)_60%,transparent)]"
          >
            ↻
          </div>
          <h2 className="m-0 font-sans font-semibold text-[22px] leading-[1.1] tracking-[-0.018em] text-ink">
            Update this review
          </h2>
          <p className="mt-3 mb-0 max-w-[42ch] text-[14px] leading-[1.55] text-ink-3">
            Hand this prompt to your coding agent to refresh the pack against the latest PR state.
          </p>
          <div className="w-full mt-5 text-left">
            <OnboardingPromptAction prompt={updatePrompt} active label="Copy update prompt" />
          </div>
          <p className="mt-3 mb-0 font-mono text-[11px] leading-[1.4] text-ink-4">
            Then paste it into your coding agent.
          </p>
        </div>
      </section>
    </div>
  );
}
