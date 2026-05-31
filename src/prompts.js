export const AHA_CLI_PLACEHOLDER = "<aha-cli>";
export const AHA_LOCAL_CLI_FALLBACK = "aha";
export const AHA_TARGET_REPO_PLACEHOLDER = "<target-repo>";
export const AHA_PR_PLACEHOLDER = "<pr-number>";
export const AHA_PACK_PLACEHOLDER = "<aha.json>";
export const AHA_FRAGMENT_PATHS = [
  "$FRAGMENTS_DIR/code-context.json",
  "$FRAGMENTS_DIR/review-signals.json",
  "$FRAGMENTS_DIR/review-judgment.json",
];
export const AHA_FRAGMENT_LIST = AHA_FRAGMENT_PATHS.join(",");

export function ahaCommand(kind, options = {}) {
  const cli = options.cliCommand || AHA_CLI_PLACEHOLDER;
  const pr = options.prNumber || AHA_PR_PLACEHOLDER;
  const pack = options.packPath || AHA_PACK_PLACEHOLDER;
  const port = options.port || "4173";
  const fragments = options.fragments || AHA_FRAGMENT_LIST;

  if (kind === "generate") return `${cli} generate --pr ${pr} --out ${pack}`;
  if (kind === "generate-auto") return `${cli} generate --pr ${pr}`;
  if (kind === "update") return `${cli} update --pr ${pr} --pack ${pack}`;
  if (kind === "merge") return `${cli} merge --pack ${pack} --fragments ${fragments}`;
  if (kind === "normalize") return `${cli} normalize --pack ${pack}`;
  if (kind === "review") return `${cli} review --pack ${pack}`;
  if (kind === "serve") return `${cli} serve --pack ${pack} --port ${port} --host 127.0.0.1`;
  if (kind === "start") return `${cli} start --port ${port}`;
  if (kind === "serve-background") {
    return `${cli} serve --pack ${pack} --port ${port} --host 127.0.0.1`;
  }
  throw new Error(`Unknown aha command: ${kind}`);
}

export function fillAhaWorkflowPrompt(template, options = {}) {
  return template
    .replaceAll(AHA_CLI_PLACEHOLDER, options.cliCommand || AHA_CLI_PLACEHOLDER)
    .replaceAll(AHA_TARGET_REPO_PLACEHOLDER, options.targetRepo ?? "")
    .replaceAll(AHA_PR_PLACEHOLDER, options.prNumber == null ? "" : String(options.prNumber))
    .replaceAll(AHA_PACK_PLACEHOLDER, options.packPath || "/absolute/path/to/aha-repo/packs/<repo>/<pr>/aha-<branch>-<pr>.json");
}

export const AHA_CODE_CONTEXT_PROMPT = String.raw({ raw: [`You are working inside the target repository for this PR.

Task:
Create the code-context fragment for an existing aha, without changing the deterministic diff.

Input:
- Read the generated aha file provided by the orchestrator.
- Write only this fragment file:
  $FRAGMENTS_DIR/code-context.json

Important constraints:
- Do not change files[].diff.
- Do not change line numbers.
- Do not change file paths, additions, deletions, or patch content.
- Do not invent code that is not present in the repo.
- Do not write GitHub comments.
- Do not push.
- Do not run mutation commands.
- Do not edit the main aha JSON file.
- Only write $FRAGMENTS_DIR/code-context.json.

You may inspect the repository source code to understand callsites, ownership boundaries, tests, and behavior.

Language:
- Write all user-facing generated text in German.
- This includes file.note, file.notes[].html, reading-order labels, and reading-order why text.
- Keep schema keys, enum values, ids, file paths, code identifiers, code snippets, and diff content exactly as required; do not translate technical identifiers or JSON field names.
- It is fine to use concise German engineering language with English code terms when those terms are idiomatic in the codebase.

Wording:
- UI text soll mit lowest cognitive friction auffassbar für Menschen wie möglich sein, sodass auch komplexe Sachverhalte extrem schnell verstanden werden.
- Verb vor Nomen, parallele Listenform statt verschachtelter Sätze, konkrete Zustände statt abstrakter Substantivketten.

The fragment may contain these fields only:

1. file.note
   Add a compact HTML mini-summary of this file's functional delta in the PR.
   This should help the reviewer understand the real behavior change before reading a visually large or noisy diff.
   Use either:
   - 1-2 short HTML paragraphs, or
   - a tight value-only low-mental-friction bullet list with <ul><li>...</li></ul>.
   Prefer bullets when the diff contains several visual changes but only a small functional change.
   Say concretely what changed functionally and what is only refactor, formatting, move/extraction, or diff noise.
   Do not add a separate review-focus or checklist bullet.
   Avoid generic umbrella labels; prefer concrete labels such as "Refactor", "Formatierung", "Imports", "Move/Extraction", "Diff-Noise", or "Kein Verhaltensdelta".
   Do not summarize imports, formatting, or file structure unless that is the only meaningful change.
   Keep it factual, specific, and German.
   Good shapes:
   - "<p>Funktional ändert diese Datei nur den Skip-Guard; der restliche Diff ist Reflow der bestehenden Branches.</p>"
   - "<ul><li>Funktional: <code>listShops</code> kann unzugängliche Shops jetzt ausschließen; <code>wydd.server</code> und <code>train.server</code> nutzen das gegen aufgeblähte Training-Daten.</li><li>Refactor: Props extrahiert und Namen bereinigt; kein eigenes Verhaltensdelta.</li></ul>"
   Bad:
   - "<p>This file handles validation.</p>"
   - "<p>Viele Änderungen in dieser Datei.</p>"
   - "<ul><li>Funktional: ...</li><li>Bitte prüfen: ...</li></ul>"

1b. file.changedNote
   Optional delta since the reviewer last viewed this file (shown only when the file is marked CHANGED in the viewer).
   Write only for files whose diff changed after the reviewer's last viewed fingerprint.
   Summarize what is NEW in the diff since that prior view — not the full PR delta (file.note covers that).
   Keep it short: one paragraph or 2–3 bullets max.
   German, same tone as file.note.
   Do not prefix it with a "seit deinem letzten Blick" / "since last viewed" phrase — the viewer already labels this block. Start straight with the delta.
   Good:
   - "<p><code>frontPlacement</code> wird an <code>CapacityTicketFace</code> durchgereicht — Layout-Messphase vs. gestapelte Karte.</p>"
   - "<ul><li>Forest-Palette: hardcodierte Grüntöne → <code>forest-*</code>-Utilities.</li><li>Kein Verhaltensdelta.</li></ul>"
   Bad:
   - Repeating the entire file.note verbatim.
   - Generic "Datei wurde aktualisiert."

2. file.notes
   Add inline AI notes anchored to existing diff lines:
   {
     "afterR": 123,
     "src": "kontext · ai",
     "type": "risk",
     "html": "..."
   }

   or for deleted-only context:
   {
     "afterL": 123,
     "src": "kontext · ai",
     "html": "..."
   }

   Rules:
   - Anchor only to line numbers that already exist in that file's diff.
   - Use afterR for added/context right-side lines.
   - Use afterL for deleted left-side lines.
   - type is optional. Omit it for normal explanatory notes.
   - Use "type": "risk" only when the exact changed line may introduce a bug, brittle behavior, missing guard, invariant break, data drift, permission issue, lifecycle issue, or test confidence problem.
   - Use "type": "code-smell" only for maintainability concerns such as poorly abstracted functions, avoidable duplication, tight coupling, unclear ownership boundaries, or hard-to-change control flow.
   - Do not label ordinary mental-model notes as risk or code-smell.
   - Do not use risk/code-smell as generic emphasis; the type must change how a senior reviewer triages the line.
   - Optimize for senior-review time saved, not for a low note count.
   - Prefer hidden mental-model deltas, invariant drift, missing guards, lifecycle issues, test gaps, and non-obvious before/after behavior.
   - Do not add generic summary notes.

   Inline AI notes style:
   Add inline AI notes only where they reduce senior-review cognition time.
   These are not summaries and not generic guidance. Each note should explain the
   non-obvious dependency, invariant, boundary, or review implication of the exact
   changed code line it is anchored to.

   Use this tone and shape:
   - Short HTML paragraph.
   - No label/prefix like "Review map" or "Code context".
   - Anchor to concrete changed code, not imports, formatting, or file headers.
   - Prefer new fields, discriminators, DTO/schema branches, guards, lifecycle
     helpers, allocation math, mapper branches, server trust boundaries, and UI
     state handoff points.
   - Do not explain what the line literally does.
   - Explain what a senior reviewer would otherwise only realize after reading
     several nearby files.

   Reviewer-value rule:
   - Before omitting a note, ask: "Would a senior reviewer likely spend 2+ minutes reconstructing this from nearby files, tests, or old behavior?"
   - If yes and the exact semantic anchor exists in the diff, add a concise note.
   - If no, omit it.
   - Keep notes dense where the code is conceptually dense, and absent where the diff is mechanically obvious.
   - State only what repo evidence supports. If the note is about risk, phrase it as what to check, not as a confirmed bug.

   Mental-model notes:
   - Prefer notes that make the reviewer understand the changed model faster than reading surrounding files.
   - It is good for a note to include a short "why", not only a "what".
   - When a line introduces an explicit field, fallback, discriminator, mode, or helper, explain the old implicit assumption and the new explicit contract.
   - When old behavior is preserved through a default/fallback, say that concretely.
   - When code is moved into a new branch/scope, explain the new scope and what stayed unchanged.
   - If the aha supports reviewSignals context ranges, prefer those for moved unchanged blocks, including cross-file extractions and scope/context changes. Use inline notes only for behavior implications at specific changed lines.
   - For pricing/data-model changes, explain the old formula or old assumption in one short clause, the new explicit channel/field in one short clause, and what drift it prevents.
   - If the change affects both legacy and new flows, say which part stays legacy-compatible and which part enables the new flow.

   Good examples:
   - "<p>Vorher war Material-Base hart <code>listSum / 1.15</code>; <code>materialBaseSum</code> macht die Basis pro Line überschreibbar, sodass DSM den Default behält und ModuLine eigene VK-Regeln nutzen kann.</p>"
   - "<p>Ändere beim Section-Wechsel nur die Referenz; <code>reconcileGateUpdate</code> entscheidet danach, ob DSM-Details bleiben oder ModuLine-Defaults entstehen.</p>"
   - "<p>Der DTO-Mapper leitet ModuLine-Gate-Höhe aus der Section ab; persistierter Gate-Height-State ist nicht mehr die Quelle der Wahrheit.</p>"
   - type "risk": "<p>Diese Guard-Branch entscheidet jetzt, ob externe Training-Daten anwachsen; prüfe, ob alle Caller bewusst inaccessible Shops ausschließen.</p>"
   - type "code-smell": "<p>Die neue Fallunterscheidung dupliziert dieselbe Shop-Filterlogik in zwei Callern; wenn weitere Trainingspfade dazukommen, driftet die Policy leicht auseinander.</p>"

   Bad examples:
   - "<p>This file handles validation.</p>"
   - "<p>This imports the helper used below.</p>"
   - "<p>Review this for edge cases.</p>"
   - "<p>This test documents behavior.</p>"
   - "<p>Führe einen Base-/Listenpreis-Kanal ein.</p>"
   - "<p>This adds base price aggregation.</p>"
   - Any note that could apply equally to many files.

   Density:
   - Do not optimize for a low note count. Optimize for reviewer time saved.
   - Add a note for every changed code point where a senior reviewer would otherwise need to inspect another file, reconstruct a before/after invariant, or infer why a new branch/field/default exists.
   - Keep each note high-signal, but do not be artificially sparse.
   - A complex orchestration file may need many notes if it introduces several independent concepts, branches, lifecycle transitions, or state handoffs.
   - A small file may need zero notes, one note, or several notes depending on how many non-obvious review decisions are encoded there.
   - Diff slices with only imports/formatting/context should get no note.
   - Avoid filler notes. A note earns its place if it explains one of:
     - why this changed line exists
     - what invariant it protects
     - what old behavior it preserves
     - what new behavior it enables
     - what downstream code now depends on it
     - what a reviewer should check because of this exact line

   Anchoring:
   - Use \`afterR\` only on added or context right-side lines that exist in the diff.
   - Use \`afterL\` only for deleted-only context.
   - Prefer added/deleted lines over unchanged context lines.
   - Use context lines only when the exact semantic handoff is unchanged but newly relevant because of surrounding changes.
   - Anchor on the smallest diff line that creates, checks, transforms, or passes on the exact thing described by the note.
   - Prefer anchoring to the line where the invariant is introduced, checked, or handed off:
     - function declaration
     - discriminator/schema branch
     - guard call
     - lifecycle helper call
     - allocation calculation
     - mapper branch
     - server trust boundary
     - UI state handoff
     - test case title or expectation, only when the test pins a non-obvious contract
   - For lifecycle/helper notes, anchor to the exact callsite or branch, such as \`getGateKindChangePatch(...)\`, \`reconcileGateForSection(...)\`, or \`assertSupportedFenceConfiguration(...)\`, not to a nearby UI/scaffolding line.
   - Anchor explicit-field/default/fallback notes on the line where that field/default/fallback is introduced. For example, anchor a pricing invariant note on \`materialBaseSum = listSum / 1.15\`, not merely on \`type Bucket\`.
   - Do not anchor notes to imports, blank lines, file headers, closing braces, closing parentheses, object endings, parameter-list-only lines, or generic scaffolding unless the note is specifically about that exact structure.
   - Do not anchor a note to a nearby line only because it is in the same hunk. If the exact semantic line is not in the diff, omit the note.
   - After writing or rewriting a note, re-check the final text against the chosen code line. If the note describes a value being resolved, guarded, transformed, or passed on, the anchor must be the line where that happens.

   Validation:
   - Every note must point to an existing diff line.
   - Every note must semantically match its anchor line, not just the surrounding hunk.
   - Do not change \`files[].diff\`.
   - Do not change line numbers.

3. readingOrders
   Add or replace optional \`readingOrders\` only when it materially improves review flow.
   This is the low-cognitive-friction path through the changed files, not a new product mode.

   Shape:
   {
     "readingOrders": [
       {
         "key": "low-friction",
         "label": "Low cognitive friction",
         "why": "start with contracts, then behavior, then evidence",
         "groups": [
           {
             "key": "foundation",
             "label": "Foundation",
             "why": "start with requirements, package impact, DTOs, and validation contracts",
             "files": ["existing/files/path.ts"]
           }
         ]
       }
     ]
   }

   Rules:
   - Use only existing \`files[].path\` values in \`groups[].files\`.
   - Include every changed file exactly once unless there is a concrete reason to omit a mechanically irrelevant file.
   - Order files so a human reviewer has the lowest possible mental friction.
   - Do not duplicate overview/high-level content.
   - Keep labels and why text short, concrete, and German.

Output:
- Save only $FRAGMENTS_DIR/code-context.json.
- Do not print the full JSON.
- Reply only with:
  - fragment file path
  - number of file notes
  - number of inline notes
  - readingOrders count
  - anything skipped because evidence was insufficient
`] });

export const AHA_AI_ENRICHMENT_PROMPT = AHA_CODE_CONTEXT_PROMPT;

export const AHA_REVIEW_JUDGMENT_PROMPT = String.raw({ raw: [`You are creating the review-judgment fragment for an existing aha.

Critical rules:
- Do not create, rewrite, or summarize the raw diff.
- Do not invent files, symbols, decisions, or refs.
- Only use references that already exist in the aha:
  - files[].path for file references
  - symbols keys / symbols[id].id
  - decisions.cards[].id
- Keep output concise.
- High Level is not a generic PR summary.
- High Level should help a reviewer understand the mental model before going into Code, Decisions, and readingOrders.
- Do not duplicate readingOrders.
- Do not include Scope Boundary.
- Do not edit the main aha JSON file.
- Only write $FRAGMENTS_DIR/review-judgment.json.

Language:
- Write all user-facing generated text in German.
- This includes mentalModelDelta, systemMap title/labels, modelDelta titles/before/after text, flow titles, ASCII-Art prose labels, assumption text, hotspot titles, hotspot why text, and token labels when they are not code identifiers.
- Keep schema keys, enum values, ids, file paths, code identifiers, code snippets, and diff content exactly as required; do not translate technical identifiers or JSON field names.
- It is fine to use concise German engineering language with English code terms when those terms are idiomatic in the codebase.

Wording:
- UI text soll mit lowest cognitive friction auffassbar für Menschen wie möglich sein, sodass auch komplexe Sachverhalte extrem schnell verstanden werden.
- Verb vor Nomen, parallele Listenform statt verschachtelter Sätze, konkrete Zustände statt abstrakter Substantivketten.

Text format (strict):
- Every text field in this fragment is PLAIN TEXT. Never emit HTML tags - no <code>, <p>, <ul>, <li>, <b>, <br>, no entities. This applies to: mentalModelDelta, modelDelta title/before/after, flow titles, systemMap title/labels, assumption text, hotspot title/why, and decision title/claim/whyItMatters, section desc, and check text.
- To mark a code identifier inline, write it bare (getMessage) or wrap it in single backticks (\`getMessage\`). The viewer renders backticks as inline code. Do not wrap it in <code>.
- HTML belongs only to file-note fields produced by a different step - not here.
Create a fragment containing \`overview\` and \`decisions\` only.
Add or refresh decisions only for concrete review decisions supported by repo evidence.

Goal:
Give the reviewer the lowest possible cognitive friction to get into this PR. Every item you include must earn its place by genuinely helping the reviewer build the right mental model faster than reading the diff would. If an item is filler, drop it.

Anti-duplication rule:
- Build the whole judgment as one coherent layer, not as independent repeated sections.
- Do not repeat the same claim in mentalModelDelta, modelDeltas, assumptions, hotspots, and decisions.
- If a point is needed only to understand the PR, put it in overview.
- If a point is something the reviewer must accept, flag, or block before merge, put it in decisions.
- If a decision covers a hotspot, do not also add that hotspot unless the hotspot is a broader inspection area with a different reviewer action.
- Before writing the fragment, scan titles and first sentences across overview and decisions. Merge or delete near-duplicates.

Ids (stable, concern-anchored):
- Give every triaged item - decision cards, assumptions, and hotspots - an explicit \`id\` that describes the concern, e.g. \`dc-token-revocation\`, \`assumption-tenant-isolation\`, \`hotspot-cache-invalidation\`. Lowercase, hyphenated, stable.
- The id identifies the *concern*, not its list position. Two genuinely different concerns get two different ids; never reuse an id for a different concern.
- These ids are the key the reviewer's triage state is stored under, so a positional or reshuffled id silently loses their decision later.
- If you are regenerating for an update and a previous pack exists, reuse the existing id for any concern that is still the same; only mint new ids for genuinely new concerns.

Judge the PR yourself:
- A large/complex PR may justify several flows, multiple assumptions, and several hotspots.
- A small/narrow PR may only need a mentalModelDelta and one hotspot - and that's fine.
- Counts don't matter. Value does. Never pad to hit a number, never trim something genuinely useful to stay small.

The overview may include:

1. \`mentalModelDelta\`
   One concise explanation of the conceptual shift in the PR. Almost always present.

2. \`systemMap\`
   A compact ASCII-Art map of the affected system. Include it when the PR connects several subsystems and the reviewer benefits from seeing the shape before reading code. Do not model this as nodes/edges. Draw the map directly with characters.

   System map rules:
   - Use 5-20 lines.
   - Prefer vertical data/control flow or a small subsystem map.
   - Keep it understandable without knowing code identifiers.
   - Use rich tokens sparingly for central files/symbols, but keep the ASCII-Art readable.
   - Omit systemMap for narrow PRs where a sentence is clearer.

3. \`modelDeltas\`
   High-density Before/After cards for concepts whose semantics changed. These are not file summaries. Use them for changed invariants, defaults, ownership, data source of truth, pricing formulas, permission semantics, lifecycle transitions, or DTO/API contracts.

   Model delta rules:
   - Each card explains one conceptual change.
   - \`before\` states the old assumption or model.
   - \`after\` states the new contract and any compatibility fallback.
   - Prefer modelDeltas over long prose when the PR changes several independent concepts.
   - Do not also create an assumption or hotspot that restates the same before/after change.

4. \`flows\`
   ASCII-Art flows. Include one only if it makes the reviewer-facing behavioral model click faster than prose would. Skip entirely if nothing in the PR warrants it.

   Flow quality rules:
   - Before/After flows are not code traces.
   - Add a flow only if the ASCII-Art is clearer than a one-sentence mentalModelDelta or a modelDelta card.
   - A good flow answers: "What changed in the system behavior or review model?"
   - A bad flow answers: "Which functions call which functions?"
   - Flows may be strict before/after flows, dataflow swimlanes, or current after-flow diagrams when the PR adds a complex data path.
   - For strict before/after flows, use \`before\` and \`after\`.
   - For dataflow/swimlane/current-flow diagrams, use \`lines\` instead of forcing a fake before/after.
   - Prefer flows for:
     - visible user journey
     - permission/access path
     - dataflow through multiple components
     - lifecycle/state transition
     - request/mutation path
     - old vs new ownership boundary
   - For UI/copy/content PRs, start flows from the user-visible surface.
   - Only mention internal helpers or symbols where they explain how visible behavior is wired.
   - Do not build flows from internal helper names unless the PR is primarily about that internal pipeline.
   - If a flow line mostly contains symbols, it is probably too implementation-centric.
   - Do not combine unrelated layers in one flow, such as UI behavior, locale validation, tests, and implementation helpers.
   - If the reader must know code identifiers to understand the flow, rewrite it in product/review language or omit it.

5. \`assumptions\`
   Load-bearing assumptions that must be true for correctness. Include the ones a reviewer would otherwise have to reconstruct themselves. Omit obvious or generic ones.
   Assumptions are "this must be true externally or across runtime state", not "this code changed".
   Do not duplicate modelDeltas or decisions.
   Like decisions, an assumption is a worklist item the reviewer triages. Give it the same payload a decision has: \`evidence\` (path + line + short desc pointing at where it is relied on) and \`check\` (the one concrete thing to verify). Omit \`evidence\`/\`check\` only when no real code anchor exists.

6. \`hotspots\`
   Specific areas worth extra scrutiny, tied to concrete symbols/files/decisions. Skip anything generic ("check edge cases", "review permissions") that isn't anchored to something real in this PR.
   Hotspots are "look here carefully", not "decide whether this is acceptable".
   Do not duplicate decision cards. If the same point is triage-worthy, prefer a decision card.
   Like decisions, a hotspot is a worklist item the reviewer triages. Give it \`evidence\` (path + line + short desc pointing at the exact spot) and \`check\` (the one concrete thing to confirm). Omit them only when there is genuinely no single anchor.

7. \`decisions\`
   Add decision cards only for real review decisions supported by repo evidence.
   These are the things a reviewer may accept, flag, or block. They are not style comments, generic risks, or duplicate overview prose.

   Decision card rules:
   - Each card must make one concrete claim.
   - Each evidence item must point to an existing file path and line when possible.
   - Risk is one of: "high", "med", "low".
   - Avoid style comments.
   - Avoid speculative architecture advice unless tied to concrete code evidence.
   - Prefer issues that affect correctness, authorization, data lifecycle, public API behavior, pricing/money, or test confidence.
   - Do not create a decision card for a point that is already fully covered by overview unless the reviewer must explicitly triage it.
   - If there are no concrete decisions, keep cards empty.

Schema:

{
  "overview": {
    "mentalModelDelta": "string or RichLine",
    "systemMap": {
      "title": "Affected system",
      "kind": "ascii",
      "lines": [
        ["Quote Config"],
        ["  sections: dsm | wpc | alu"],
        ["        ↓"],
        ["Validation / Guards"],
        ["        ↓"],
        ["Pricing"],
        ["        ↓"],
        ["DTO / GMZ payload"]
      ],
      "refs": [
        { "type": "file", "id": "existing/files/path.ts", "label": "Quote model" }
      ]
    },
    "modelDeltas": [
      {
        "title": "Material base price",
        "before": "Material base is implicit: listSum / 1.15.",
        "after": "Material base can be explicit per allocated material line; DSM keeps the legacy fallback.",
        "refs": [
          { "type": "symbol", "id": "existing-symbol-id" }
        ]
      }
    ],
    "flows": [
      {
        "title": "Short title",
        "kind": "before_after_ascii",
        "before": [
          ["ASCII-Art ", { "type": "symbol", "id": "existing-symbol-id", "label": "SymbolName" }]
        ],
        "after": [
          ["ASCII-Art line"]
        ]
      },
      {
        "title": "Current data path",
        "kind": "dataflow_ascii",
        "lines": [
          ["Input -> Mapper -> Persistence"]
        ]
      }
    ],
    "assumptions": [
      {
        "id": "assumption-short-concern-slug",
        "text": "Concise assumption",
        "refs": [
          { "type": "symbol", "id": "existing-symbol-id" }
        ],
        "evidence": [
          { "path": "existing/files/path.ts", "line": 42, "ref": "existing/files/path.ts:42", "desc": "where this assumption is relied on" }
        ],
        "check": "What concrete thing should the reviewer verify is true?"
      }
    ],
    "hotspots": [
      {
        "id": "hotspot-short-concern-slug",
        "title": "Concrete hotspot",
        "why": "Why this needs careful review",
        "refs": [
          { "type": "file", "id": "existing-file-id" }
        ],
        "evidence": [
          { "path": "existing/files/path.ts", "line": 42, "ref": "existing/files/path.ts:42", "desc": "the exact spot to inspect" }
        ],
        "check": "What concrete thing should the reviewer confirm here?"
      }
    ]
  }
}

Decision schema:

{
  "decisions": {
    "categories": [
      { "key": "truths", "label": "New Truths", "why": "what's now factually true post-merge" },
      { "key": "decisions", "label": "Decisions Made", "why": "shape-of-the-world choices to accept or reject" },
      { "key": "trust", "label": "Trust Boundary", "why": "who enforces auth, where" },
      { "key": "lifecycle", "label": "Data Lifecycle", "why": "old data, new data, copies, cleanup" },
      { "key": "asymmetry", "label": "Asymmetries", "why": "internal inconsistencies in the PR" },
      { "key": "coverage", "label": "Coverage", "why": "what tests prove vs what they don't" },
      { "key": "questions", "label": "Open Questions", "why": "answer before merge" }
    ],
    "cards": [
      {
        "id": "dc-concrete-claim-1",
        "category": "coverage",
        "risk": "med",
        "title": "Konkreter Review-Punkt",
        "claim": "Eine konkrete, prüfbare Aussage.",
        "whyItMatters": "Warum das vor Merge geklärt werden muss.",
        "sections": [
          {
            "kind": "evidence",
            "label": "Beleg",
            "items": [
              {
                "path": "existing/files/path.ts",
                "line": 42,
                "ref": "existing/files/path.ts:42",
                "desc": "kurzer konkreter Beleg"
              }
            ]
          },
          {
            "kind": "check",
            "label": "Check",
            "text": "Welche konkrete Frage soll der Reviewer entscheiden?"
          }
        ]
      }
    ],
    "questions": []
  }
}

Rich line tokens may be:
- { "type": "symbol", "id": "...", "label": "..." }
- { "type": "file", "id": "existing/files/path.ts", "label": "..." }
- { "type": "decision", "id": "...", "label": "..." }

Style:
- Be specific and concrete; always tie claims to existing symbols/files/decisions where possible.
- ASCII-Art flows are typically 3-8 lines; systemMap can be 5-20 lines. Long enough to show the shift, short enough to scan.
- Use refs to support claims, but do not let refs turn the overview into a symbol/call graph.
- Do not add compatibility lenses, Scope Boundary, or anything that duplicates readingOrders.
- If the aha lacks the information for a section, omit it rather than hallucinate.

Return:
- Save only $FRAGMENTS_DIR/review-judgment.json.
- Do not print the full JSON.
- Reply only with:
  - fragment file path
  - overview present: yes/no
  - decision cards count
  - anything skipped because evidence was insufficient`] });

export const AHA_HIGH_LEVEL_OVERVIEW_PROMPT = AHA_REVIEW_JUDGMENT_PROMPT;

export const AHA_REVIEW_SIGNALS_PROMPT = String.raw({ raw: [`You are creating the review-signals fragment for an existing aha.

Input:
- Read the generated aha file provided by the orchestrator.
- Write only this fragment file:
  $FRAGMENTS_DIR/review-signals.json

Task:
- Inspect the exact aha JSON file.
- Create a fragment containing only the top-level \`reviewSignals\` field.
- Do not edit the main aha JSON file.
- After writing, parse the file again to confirm it is valid JSON.

Goal:
Reduce review noise without hiding meaningful behavior changes.

Classify only mechanically review-irrelevant changes as noise, plus non-reference locale translation duplicates covered by the locale rule below. If a change might affect behavior, correctness, data, permissions, UI behavior, public contracts, or tests-as-spec, do not classify it as noise.

Use this schema. \`patterns\` is optional and must only be present when the user provided a mechanical pattern. \`patternId\` is optional and must only be present on ranges classified because of such a user-provided pattern.

{
  "reviewSignals": {
    "version": 1,
    "patterns": {
      "user-field-object-to-array-tests": {
        "id": "user-field-object-to-array-tests",
        "label": "field object -> array in tests",
        "source": "user",
        "description": "In test files, classify only changes where \`field: {...}\` became \`field: [{...}]\` and nothing else behavior-relevant changed."
      }
    },
    "files": {
      "old/path/file.tsx": {
        "relevance": "normal",
        "source": "ai",
        "hideByDefault": false,
        "categories": [],
        "reason": "",
        "ranges": [
          {
            "id": "noise-path-to-existing-file-1",
            "relevance": "noise",
            "source": "ai",
            "kind": "mechanical-pattern",
            "hideByDefault": true,
            "reason": "Kurzer konkreter deutscher Grund.",
            "patternId": "user-field-object-to-array-tests",
            "anchor": {
              "right": { "start": 1, "end": 5 }
            }
          },
          {
            "id": "context-path-to-existing-file-1",
            "relevance": "context",
            "source": "ai",
            "kind": "moved-unchanged",
            "hideByDefault": false,
            "reason": "Unveränderter Block liegt jetzt in neuem Render-Scope; prüfe die neue Ausführungsbedingung.",
            "anchor": {
              "left": { "start": 123, "end": 145 },
              "right": { "start": 456, "end": 478 }
            },
            "scope": {
              "before": "direkt im Gate-Layout",
              "after": "!isModuline"
            }
          },
          {
            "id": "context-cross-file-dsm-fields-1",
            "relevance": "context",
            "source": "ai",
            "kind": "moved-unchanged",
            "hideByDefault": false,
            "reason": "DSM-Felder bleiben fachlich gleich, liegen jetzt aber in einer extrahierten DSM-Komponente.",
            "anchor": {
              "left": {
                "start": 198,
                "end": 480
              },
              "right": {
                "path": "new/path/file.tsx",
                "start": 35,
                "end": 291
              }
            },
            "scope": {
              "before": "inline in FenceSections",
              "after": "DsmFenceSectionFields im DSM-Branch"
            }
          }
        ]
      }
    }
  }
}

When to add a file-level signal:
- Add a file entry only if the whole file diff is mechanically review-irrelevant.
- Use only existing \`files[].path\` values as keys in \`reviewSignals.files\`.
- Do not key \`reviewSignals.files\` by legacy file identifiers.
- If only part of a file is noise, do not classify the whole file. Add only range-level entries under that file.

When to add a range-level signal:
- Allowed \`relevance\` values are \`noise\`, \`normal\`, and \`context\`.
- Use ranges for mechanically irrelevant parts inside otherwise relevant files.
- Use \`relevance: "context"\` for moved unchanged blocks that help review by connecting the old and new location.
- Moved unchanged blocks may stay in the same file or move across files.
- Anchor only to existing diff line numbers.
- For same-file ranges, omit \`anchor.left.path\` and \`anchor.right.path\`.
- For cross-file ranges, include \`path\` on the side that points at another changed file. The path must be an existing \`files[].path\`.
- Store each cross-file range under one of the two involved \`reviewSignals.files\` paths, not under an unrelated file.
- Use \`right\` anchors for added/context right-side lines.
- Use \`left\` anchors for deleted left-side lines.
- For replaced lines, include both \`left\` and \`right\` anchors when both sides belong to the irrelevant change.
- For moved unchanged context, anchor both old left range and new right range when both sides exist in the diff.
- Keep ranges tight. Do not include nearby relevant lines.
- Do not create overlapping ranges.

Mandatory mechanical-noise pass:
- Before judging behavior, scan every changed file for mechanically review-irrelevant ranges.
- Add range-level noise for these ranges even when the surrounding file is behavior-relevant.
- Do not skip import/formatting ranges just because the file also contains important logic.

Import noise rules:
- Classify top-of-file import-only hunks as \`imports-only\` when the changed lines only add, remove, reorder, split, merge, or retarget imports.
- This includes imports needed by new logic; the import lines themselves are still mechanically low-value for review.
- Keep the range limited to the import lines only. Do not include the first usage, type definition, function, test body, or runtime branch below it.
- Do not classify an import as noise only if the import itself has runtime side effects, e.g. bare imports like \`import "./setup"\` or CSS/global polyfill imports.

Formatting noise rules:
- Classify line wrapping, prettier reflow, object/array indentation, trailing comma churn, and one-line-to-multiline rewrites as \`formatting-only\` when rendered code semantics are unchanged.
- For replaced formatting, anchor both the deleted left range and added right range.
- Keep formatting ranges tight; do not include nearby changed expressions or values.

Move/rename noise rules:
- Classify pure moved code as \`rename-only\` only when the moved content is semantically identical and the old/new locations are both present in the aha diff.
- Do not classify a move as noise if names, visibility, exports, call order, lifecycle, parent condition, render branch, permission scope, callback scope, or ownership boundaries changed.
- If the moved block body is unchanged but the review context changed, add a \`context\` range with kind \`moved-unchanged\` instead of classifying the whole move as noise.
- Use \`moved-unchanged\` for same-file moves, cross-file moves, extracted unchanged blocks, and moved blocks whose parent scope changed.
- \`moved-unchanged-scope-change\` is accepted only for backwards compatibility; prefer \`moved-unchanged\` in new output.
- For \`moved-unchanged\`, set \`hideByDefault: false\` because the new location/context still needs review.
- The reason must explain what stayed unchanged and what context now matters.
- Use optional \`scope.before\` / \`scope.after\` when it makes the changed context faster to understand.
- Optionally add a second tight \`moved-only\` noise range for only the unchanged inner body, excluding the context-changing lines.
- Do not include the new parent condition, branch line, lifecycle call, permission check, or callback registration in a noise range.

Test-file exception:
- Tests can define important expected behavior, but mechanically irrelevant ranges inside tests still count as noise.
- In tests, classify imports, fixture path wrapping, formatting-only rewrites, and purely mechanical pattern ranges as noise.
- Do not classify assertions, input values, expected outputs, mocks, setup semantics, or test names as noise unless they exactly match a user-provided mechanical pattern.

For files that only have range-level noise:
- Use a normal file entry:
  {
    "relevance": "normal",
    "source": "ai",
    "hideByDefault": false,
    "categories": [],
    "reason": "",
    "ranges": [...]
  }
- Do not mark the whole file as noise unless every changed line in that file is mechanically irrelevant.

When the user provides a mechanical pattern:
- Store the pattern definition once under \`reviewSignals.patterns\`.
- Use a stable slug id for the pattern, for example \`user-field-object-to-array-tests\`.
- Pattern definitions are metadata only. They do not mean reviewed, accepted, or approved.
- For every range classified because of that pattern, set:
  - \`kind\`: \`mechanical-pattern\`
  - \`patternId\`: the pattern id
  - \`reason\`: a concrete German reason tied to the exact diff range
- Only apply the pattern where the diff exactly matches it and no nearby lines in the same hunk change behavior outside the pattern.
- If a range is not caused by a user pattern, omit \`patternId\` and use the normal noise kind.

When the user does not provide a mechanical pattern:
- Do not write \`reviewSignals.patterns\`.
- Do not invent pattern ids.
- Do not set \`patternId\` on ranges.
- Use normal range kinds such as \`imports-only\`, \`formatting-only\`, \`generated\`, or \`rename-only\`.

Classify as noise only for:
- imports-only changes
- formatting-only changes
- generated output
- lockfile churn
- snapshot churn
- fixture-only churn
- pure rename/move with no behavior change
- comment-only changes that cannot affect runtime behavior
- copy-only text changes that cannot affect product behavior

Special case: locale translation duplicates
- Treat \`en\` as the review source of truth for locale copy unless another reference locale is explicit. If a non-\`en\` locale JSON change is only a faithful translation of the same changed \`en\` keys, with matching JSON shape, placeholders, interpolation variables, and HTML tags, classify it as \`noise\` / \`copy-only\`; keep \`en\` visible.
- Do not classify translations as noise when they add/remove meaning, change placeholders/tags, lack a changed reference key, or include locale-specific legal/business wording. This special case overrides the general user-visible behavior restriction only for faithful non-reference locale duplicates.

Never classify behavior-bearing lines as noise if the change touches or could affect:
- auth
- permissions
- DB schema or migrations
- query semantics
- API contracts
- mutations/writes
- serialization/parsing
- data lifecycle
- pricing/money
- feature flags
- user-visible behavior
- UI state or interaction behavior
- tests that define important expected behavior

This restriction applies to behavior-bearing lines, not to isolated mechanical ranges.
Even in files touching pricing, UI, serialization, or tests, still classify tightly scoped import-only, formatting-only, generated, fixture, or rename-only ranges when those exact lines are mechanically irrelevant.

Allowed \`kind\` and \`categories\` values:
- \`imports-only\`
- \`formatting-only\`
- \`generated\`
- \`lockfile\`
- \`snapshot\`
- \`fixture\`
- \`rename-only\`
- \`moved-only\`
- \`moved-unchanged\`
- \`moved-unchanged-scope-change\`
- \`comment-only\`
- \`copy-only\`
- \`mechanical-pattern\`

Style:
- User-facing reasons must be German.
- Reasons should be short, concrete, and tied to the actual diff.
- Avoid generic reasons.
- Avoid words like “safe”, “confidence”, “99%”, or percentages.

Output:
- Save only $FRAGMENTS_DIR/review-signals.json.
- Do not print the full JSON.
- Reply only with:
  - fragment file path
  - number of file-level noise classifications
  - number of range-level noise classifications
  - anything you deliberately left unclassified because it might affect behavior`] });

export const AHA_UPDATE_REPAIR_PROMPT = String.raw({ raw: [`You are working inside the target repository for this PR.

Task:
Repair and refresh an already-enriched aha after the deterministic base was updated.

Input:
- The user will provide the exact aha JSON file path.
- A deterministic update was already run with:
  ${ahaCommand("update")}
- That command wrote an update report next to the pack:
  <aha basename>.update-report.json

Critical constraints:
- Do not change files[].diff.
- Do not change line numbers.
- Do not change file paths, additions, deletions, or patch content.
- Do not invent files, symbols, decisions, or refs.
- Do not write GitHub comments.
- Do not push.
- Do not run mutation commands.
- Only update the aha JSON file.

What the deterministic update already did:
- Regenerated the current PR diff.
- Preserved enrichment that still matched deterministic anchors.
- Moved inline notes and reviewSignals ranges when their anchor text fingerprint had exactly one new match.
- Dropped enrichment when it no longer matched safely.
- Wrote a report with added/removed/changed files, dropped/moved enrichment, and a backupPath for the pre-update pack.

Your job:
1. Open the aha JSON.
2. Open the sibling update report.
3. If dropped enrichment needs more context than the report contains, open updateReport.backupPath and inspect the previous pack.
4. Inspect the current repository code and the updated aha diff.
5. Focus on changed/added files and any dropped enrichment from the update report.
6. Repair or add only the user-facing AI context that is still correct for the current PR head:
   - file.note
   - file.notes
   - overview
   - reviewSignals
   - decisions, only if there is a concrete supported review decision
   - readingOrders, only if it materially improves review flow
7. Remove or rewrite stale AI context that no longer matches the current diff or repository behavior.
8. Save the aha JSON.
9. Run:
   ${ahaCommand("normalize")}
10. Parse the JSON again to confirm it is valid.

Triage id continuity (critical):
- The reviewer's triage state (accept / flag / block) is stored in a sidecar, keyed by item id, for decision cards, assumptions, and hotspots.
- When you refine, reword, or re-anchor an item that is still the SAME concern, KEEP its existing id from the previous pack (use updateReport.backupPath to read the old ids). A changed id silently drops the reviewer's decision.
- Mint a NEW id only for a genuinely new concern.
- Never reuse an existing id for a different concern. If a concern no longer applies, drop the item - its id simply retires.

How to use the update report:
- files.added: inspect for new review context.
- files.changed: re-check existing notes/signals and add new context where the new diff warrants it.
- files.removed: do not recreate context for removed files.
- enrichment.inlineNotes.dropped: decide whether the old idea still applies; if yes, re-anchor it to a real current diff line, otherwise leave it removed.
- enrichment.inlineNotes.moved: verify the moved note still semantically matches its new line.
- enrichment.reviewSignals.dropped: decide whether the signal still applies; if yes, recreate it against current anchors, otherwise leave it removed.
- enrichment.reviewSignals.moved: verify the moved range still describes the current anchor pair.
- backupPath: use this previous pack as the source of truth for old full HTML, file notes, ranges, overview, decisions, and readingOrders when the report summary is not enough.

Do not treat "dropped" as a bug by default. Dropped means "not safely preserved deterministically". Re-add only with current repo evidence.

Language:
- Write all user-facing generated text in German.
- Keep schema keys, enum values, ids, file paths, code identifiers, code snippets, and diff content exactly as required.

Output:
- Do not print the full JSON.
- Reply only with:
  - updated file path
  - update report path used
  - number of repaired inline notes
  - number of new inline notes
  - number of reviewSignals ranges changed
  - overview changed: yes/no
  - normalize command result
  - anything deliberately left unrepaired because it no longer applies`] });

const AHA_FULL_WORKFLOW_SHARED = String.raw({ raw: [`You are the orchestrator for creating a finished aha.

Core rule:
- The deterministic diff is truth.
- Subagents write JSON fragment files only. They must not write the main aha.
- Only the merge command writes the final aha JSON.
- Do not let parallel agents edit the same file.
- Do not change files[].diff, line numbers, file paths, additions, deletions, or patch content.
- Do not write GitHub comments.
- Do not push.
- Do not run GitHub mutation commands.

Pass structure:
1. Code Context Pass
   Owns only:
   - file.note
   - file.notes
   - readingOrders

2. Review Signals Pass
   Owns only:
   - reviewSignals

3. Review Judgment Pass
   Owns only:
   - overview
   - decisions

Section index:
- --- FRAGMENT MERGE CONTRACT ---
- --- CODE CONTEXT PASS ---
  Save only $FRAGMENTS_DIR/code-context.json.
- --- REVIEW SIGNALS PASS ---
  Save only $FRAGMENTS_DIR/review-signals.json.
- --- REVIEW JUDGMENT PASS ---
  Save only $FRAGMENTS_DIR/review-judgment.json.

Workflow:
0. Default to the current working repository and the current branch PR.
   - If the user gave a repo path, use it.
   - Otherwise use \`pwd\` as the target repo.
   - If the user gave a PR number, use it.
   - Otherwise infer it with \`gh pr view --json number -q .number\`.
   - Ask the user only if repo/PR inference fails, or if update mode has no aha path.
1. Run the deterministic command for this mode. It sets \`PACK_PATH\`.
2. Parse \`$PACK_PATH\`.
3. Set \`PACK_DIR="$(dirname "$PACK_PATH")"\`, \`FRAGMENTS_DIR="$PACK_DIR/fragments"\`, and \`FRAGMENT_LIST="$FRAGMENTS_DIR/code-context.json,$FRAGMENTS_DIR/review-signals.json,$FRAGMENTS_DIR/review-judgment.json"\`. Create \`$FRAGMENTS_DIR\`.
4. If subagents are available, ask each pass in parallel. Give each subagent the matching pass prompt below 1:1 together with the exact \`PACK_PATH\` and \`FRAGMENTS_DIR\` values; do not summarize, rewrite, or shorten it. If subagents are not available, run the passes sequentially yourself.
5. Each pass writes exactly one fragment file:
${AHA_FRAGMENT_PATHS.map((fragmentPath) => `   - ${fragmentPath}`).join("\n")}
6. Merge fragments with:
   "$AHA_CLI" merge --pack "$PACK_PATH" --fragments "$FRAGMENT_LIST"
7. Run:
   "$AHA_CLI" normalize --pack "$PACK_PATH"
8. Parse the JSON again.
9. If the user explicitly asks, you can start the viewer in a persistent terminal/session:
   "$AHA_CLI" serve --pack "$PACK_PATH" --port 4173 --host 127.0.0.1
   - Keep this process running. In Codex-like tool environments, do not use \`nohup ... &\`; short-lived shell background processes may be cleaned up when the tool call exits.
   - If port 4173 is busy, use the URL printed by the server.
10. Summarize:
   - aha path
   - mode used
   - inline notes count
   - reviewSignals noise ranges count
   - reviewSignals context ranges count
   - overview present: yes/no
   - decision cards count
   - readingOrders count
   - normalize result
   - anything skipped because evidence was insufficient

Language:
- Write all user-facing generated text in German.
- Keep schema keys, enum values, ids, file paths, code identifiers, code snippets, and diff content exactly as required.
- Use normal German, including umlauts, unless you are quoting code or JSON keys.`] });

const AHA_FRAGMENT_SCHEMA = String.raw({ raw: [`Fragment files:

Code Context fragment:
{
  "files": [
    {
      "path": "existing/files/path.ts",
      "note": "<ul><li>Funktional: kurze Delta-Summary dieser Datei.</li><li>Refactor: sichtbarer Umbau ohne eigenes Verhaltensdelta.</li></ul>",
      "notes": [
        { "afterR": 42, "src": "kontext · ai", "html": "<p>...</p>" }
      ]
    }
  ],
  "readingOrders": []
}

Review Signals fragment:
{
  "reviewSignals": {
    "version": 1,
    "files": {}
  }
}

Review Judgment fragment:
{
  "overview": {},
  "decisions": {
    "categories": [],
    "cards": [],
    "questions": []
  }
}

Fragment rules:
- Use only fields owned by that pass.
- Use existing files[].path values, not generated aliases.
- Do not include files[].diff or any deterministic file metadata.
- The merge command rejects deterministic diff changes and then normalizes anchors/fingerprints.`] });

export const AHA_FULL_WORKFLOW_INIT_PROMPT = `${String.raw({ raw: [`${AHA_FULL_WORKFLOW_SHARED}

Mode: init

Input:
- Target repository path: current working directory unless the user gave another repo
- PR number: current branch PR unless the user gave another PR

First command:
AHA_CLI=<aha-cli>
if [ "$AHA_CLI" = "aha" ] && ! command -v aha >/dev/null 2>&1; then
  AHA_CLI="${AHA_LOCAL_CLI_FALLBACK}"
fi
if [ ! -x "$AHA_CLI" ] && ! command -v "$AHA_CLI" >/dev/null 2>&1; then
  echo "aha CLI not found: $AHA_CLI" >&2
  exit 1
fi
TARGET_REPO="<target-repo>"
PR_NUMBER="<pr-number>"
if [ -z "$TARGET_REPO" ]; then TARGET_REPO="$(pwd)"; fi
if [ -z "$PR_NUMBER" ]; then PR_NUMBER="$(gh pr view --json number -q .number)"; fi
cd "$TARGET_REPO"
PACK_PATH="$("$AHA_CLI" generate --pr "$PR_NUMBER" | tail -n 1)"
PACK_DIR="$(dirname "$PACK_PATH")"
FRAGMENTS_DIR="$PACK_DIR/fragments"
FRAGMENT_LIST="$FRAGMENTS_DIR/code-context.json,$FRAGMENTS_DIR/review-signals.json,$FRAGMENTS_DIR/review-judgment.json"
mkdir -p "$FRAGMENTS_DIR"
echo "$PACK_PATH"
echo "$FRAGMENTS_DIR"

Use \`$PACK_PATH\` for every later merge, normalize, and serve command.

After generate, run the three passes below. Subagents must not write the pack; they write fragment files only.`] })}

--- FRAGMENT MERGE CONTRACT ---
${AHA_FRAGMENT_SCHEMA}

--- CODE CONTEXT PASS ---
${AHA_CODE_CONTEXT_PROMPT}

--- REVIEW SIGNALS PASS ---
${AHA_REVIEW_SIGNALS_PROMPT}

--- REVIEW JUDGMENT PASS ---
${AHA_REVIEW_JUDGMENT_PROMPT}`;

export const AHA_FULL_WORKFLOW_UPDATE_PROMPT = `${String.raw({ raw: [`${AHA_FULL_WORKFLOW_SHARED}

Mode: update

Input:
- Target repository path: current working directory unless the user gave another repo
- PR number: current branch PR unless the user gave another PR
- Existing enriched aha path: <aha.json>

First command:
AHA_CLI=<aha-cli>
if [ "$AHA_CLI" = "aha" ] && ! command -v aha >/dev/null 2>&1; then
  AHA_CLI="${AHA_LOCAL_CLI_FALLBACK}"
fi
if [ ! -x "$AHA_CLI" ] && ! command -v "$AHA_CLI" >/dev/null 2>&1; then
  echo "aha CLI not found: $AHA_CLI" >&2
  exit 1
fi
TARGET_REPO="<target-repo>"
PR_NUMBER="<pr-number>"
PACK_PATH="<aha.json>"
if [ -z "$TARGET_REPO" ]; then TARGET_REPO="$(pwd)"; fi
if [ -z "$PR_NUMBER" ]; then PR_NUMBER="$(gh pr view --json number -q .number)"; fi
cd "$TARGET_REPO"
"$AHA_CLI" update --pr "$PR_NUMBER" --pack "$PACK_PATH"
PACK_DIR="$(dirname "$PACK_PATH")"
FRAGMENTS_DIR="$PACK_DIR/fragments"
FRAGMENT_LIST="$FRAGMENTS_DIR/code-context.json,$FRAGMENTS_DIR/review-signals.json,$FRAGMENTS_DIR/review-judgment.json"
mkdir -p "$FRAGMENTS_DIR"

Then open:
- <aha basename>.update-report.json
- updateReport.backupPath when dropped enrichment needs old context

Use the update report:
- files.added: inspect for new review context.
- files.changed: re-check existing context and add new context where the new diff warrants it.
- files.removed: do not recreate context for removed files.
- enrichment.inlineNotes.dropped: re-add only if still correct and re-anchor to a current diff line.
- enrichment.inlineNotes.moved: verify the moved note still semantically matches its new line.
- enrichment.reviewSignals.dropped: re-add only if still correct and re-anchor to current ranges.
- enrichment.reviewSignals.moved: verify the moved range still describes the current anchor pair.

After update, run the three passes below. Subagents must not write the pack; they write fragment files only.`] })}

--- FRAGMENT MERGE CONTRACT ---
${AHA_FRAGMENT_SCHEMA}

--- CODE CONTEXT PASS ---
${AHA_CODE_CONTEXT_PROMPT}

--- REVIEW SIGNALS PASS ---
${AHA_REVIEW_SIGNALS_PROMPT}

--- REVIEW JUDGMENT PASS ---
${AHA_REVIEW_JUDGMENT_PROMPT}`;
