import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { Pr, Runtime } from "../types";
import { DEFAULT_RUNTIME } from "../lib/pack";
import {
  fillAhaWorkflowPrompt,
  ahaCommand,
  AHA_CODE_CONTEXT_PROMPT,
  AHA_FRAGMENT_LIST,
  AHA_FULL_WORKFLOW_INIT_PROMPT,
  AHA_FULL_WORKFLOW_UPDATE_PROMPT,
  AHA_REVIEW_JUDGMENT_PROMPT,
  AHA_REVIEW_SIGNALS_PROMPT,
  AHA_UPDATE_REPAIR_PROMPT,
} from "../prompts.js";

// Shared utility string for both .copy-text-button and .workflow-copy-button:
// same box, hover -> blue, data-copied=true -> pine.
const COPY_BUTTON_CLASS =
  "h-[22px] px-2 border-0 rounded-[4px] bg-surface text-ink-3 font-mono text-[10px] cursor-pointer " +
  "hover:text-blue-ink hover:bg-blue-soft " +
  "data-[copied=true]:text-pine-ink data-[copied=true]:bg-pine-soft";

export function CopyTextButton({
  text,
  className = COPY_BUTTON_CLASS,
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

export function WorkflowModal({ pr, runtime = DEFAULT_RUNTIME, onClose }: { pr: Pr; runtime?: Runtime; onClose: () => void }) {
  const commands = workflowCommands(pr, runtime);
  const prompts = workflowPrompts(pr, runtime);

  return (
    <div
      className="fixed inset-0 z-[60] grid place-items-center p-6 bg-[color-mix(in_oklab,var(--color-ink)_22%,transparent)]"
      role="presentation"
      onMouseDown={onClose}
    >
      <section
        className="w-[min(980px,100%)] max-h-[min(860px,calc(100vh-48px))] grid grid-rows-[auto_minmax(0,1fr)] border border-line-2 rounded-lg bg-surface shadow-[0_24px_80px_color-mix(in_oklab,var(--color-ink)_22%,transparent)] overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="aha commands and prompts"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="flex items-center justify-between gap-4 px-4 py-[14px] border-b border-line bg-bg-2">
          <div>
            <div className="font-mono text-[10px] text-ink-4 uppercase tracking-[0.04em]">aha workflow</div>
            <h2 className="mt-0.5 mb-0 text-base leading-[1.2] font-semibold">Commands &amp; prompts</h2>
          </div>
          <button
            className="w-7 h-7 border-0 rounded-[5px] bg-transparent text-ink-3 text-[20px] leading-none cursor-pointer hover:bg-bg-3 hover:text-ink"
            type="button"
            onClick={onClose}
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="min-h-0 overflow-auto px-4 pt-[14px] pb-[18px] grid gap-[18px]">
          <section className="grid gap-2">
            <h3 className="m-0 text-ink-2 text-xs font-semibold uppercase tracking-[0.04em]">Commands</h3>
            {commands.map((item) => (
              <WorkflowCopyBlock key={item.key} title={item.title} text={item.text} />
            ))}
          </section>

          <section className="grid gap-2">
            <h3 className="m-0 text-ink-2 text-xs font-semibold uppercase tracking-[0.04em]">AI prompts</h3>
            {prompts.map((item) => (
              <WorkflowCopyBlock key={item.key} title={item.title} text={item.text} tall />
            ))}
          </section>
        </div>
      </section>
    </div>
  );
}

export function WorkflowCopyBlock({
  title,
  text,
  tall = false,
  blockClassName = "bg-bg-2",
}: {
  title: string;
  text: string;
  tall?: boolean;
  // .onb-manual-body .workflow-copy-block overrides background to var(--surface)
  blockClassName?: string;
}) {
  return (
    <article
      className={"border border-line rounded-[7px] overflow-hidden " + blockClassName}
      data-tall={tall}
    >
      <div className="flex items-center justify-between gap-2.5 px-2.5 py-2 border-b border-line text-xs font-medium">
        <span>{title}</span>
        <CopyTextButton text={text} />
      </div>
      <pre
        className={
          "m-0 overflow-auto p-2.5 bg-surface text-ink-2 font-mono text-[11px] leading-[1.45] whitespace-pre-wrap break-words " +
          (tall ? "max-h-[240px]" : "max-h-[150px]")
        }
      >
        {text}
      </pre>
    </article>
  );
}

interface WorkflowItem {
  key: string;
  title: string;
  text: string;
}

export function workflowCommands(pr: Pr, runtime: Runtime = DEFAULT_RUNTIME): WorkflowItem[] {
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

export function workflowPrompts(pr: Pr, runtime: Runtime = DEFAULT_RUNTIME): WorkflowItem[] {
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
