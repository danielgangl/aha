# End-to-End Testing

This document describes a real-life, BDD-style workflow test for `aha`.
It is intentionally not a pure unit test. The goal is to exercise the product
the way it is actually used:

1. create a real target repo and PR,
2. generate a deterministic aha,
3. let an external AI enrich the pack,
4. create local review state,
5. change the PR,
6. let an external AI run the update-repair workflow,
7. verify that diff truth, AI context, and local review state still line up.

Use this when changing `generate`, `update`, `normalize`, review-state handling,
AI prompts, anchor fingerprints, `reviewSignals`, or path-only file references.

The code-only core of this flow is covered by:

```sh
npm test
```

Those tests use a fake `gh` binary and temporary local repos. They are blackbox
value tests for the CLI. They do not replace this runbook, because this runbook
also covers real GitHub PRs and external AI behavior.

The re-review path specifically — a reviewer's triage + content baselines
surviving an `update`, stable item ids across regeneration, and the
baseline-driven `A -> C` re-review classification — is exercised hermetically by:

```sh
npm run e2e:rereview
```

It walks generate -> simulated init enrichment -> triage + baselines -> update ->
simulated re-enrichment, then runs the real client `buildReviewFocus` and asserts
that changed items resurface as re-review, unchanged stay resolved, and a new
concern is open. It also runs as part of `npm test`.

## Preconditions

- GitHub CLI is installed and authenticated.
- `rg` is installed if symbol/callsite behavior should be covered.
- The local `aha` checkout is available at:

```sh
<path-to-aha>
```

- The test may create a private GitHub repository under the authenticated
  account. Use a disposable repo name and clean it up manually if desired.

## Feature: Aha Survives A Real AI Update Flow

### Scenario

Given a target repository with a small TypeScript PR
And a generated `aha.json`
And an external AI has enriched that pack with notes, overview, reading order,
review signals, and decisions
And the reviewer has local viewed/decision state
When the PR changes after that enrichment
And another external AI runs the `aha update` repair workflow
Then the deterministic diff is regenerated from GitHub
And still-existing AI context is preserved or repaired
And stale AI context is dropped or rewritten
And `files[].diff` still matches a fresh deterministic generate
And generated files do not include legacy `files[].id`
And path-keyed `reviewSignals.files` are preserved
And the sibling `.state.json` file is not changed
And the viewer can serve both `/aha.json` and `/aha-state.json`.

## Step 1: Create A Disposable Target Repo And PR

Create a minimal repo with a behavior-bearing change. The example below uses
pricing because it naturally creates useful inline notes.

```sh
STAMP=$(date +%Y%m%d-%H%M%S)
ROOT="/tmp/aha-realflow-$STAMP"
REPO_NAME="aha-realflow-$STAMP"
OWNER=$(gh api user --jq .login)

mkdir -p "$ROOT"
cd "$ROOT"
git init -b main
git config user.name "Aha E2E"
git config user.email "aha-e2e@example.com"

mkdir -p src test
cat > package.json <<'JSON'
{
  "name": "aha-realflow-fixture",
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "node test/pricing.test.mjs"
  }
}
JSON

cat > src/pricing.ts <<'TS'
export type QuoteLine = {
  sku: string
  listSum: number
  purchaseSum: number
}

export type QuoteSummary = {
  listSum: number
  purchaseSum: number
  materialBase: number
}

export function summarizeQuote(lines: QuoteLine[]): QuoteSummary {
  const listSum = lines.reduce((sum, line) => sum + line.listSum, 0)
  const purchaseSum = lines.reduce((sum, line) => sum + line.purchaseSum, 0)

  return {
    listSum,
    purchaseSum,
    materialBase: listSum / 1.15,
  }
}
TS

cat > test/pricing.test.mjs <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/pricing.ts', import.meta.url), 'utf8')
assert.match(source, /materialBase: listSum \/ 1\.15/)
JS

git add .
git commit -m "Initial pricing fixture"

gh repo create "$OWNER/$REPO_NAME" --private --source . --remote origin --push

git switch -c feature/material-base-channel
cat > src/pricing.ts <<'TS'
export type QuoteLine = {
  sku: string
  listSum: number
  purchaseSum: number
  materialBaseSum?: number
}

export type QuoteSummary = {
  listSum: number
  purchaseSum: number
  materialBase: number
}

export function summarizeQuote(lines: QuoteLine[]): QuoteSummary {
  const listSum = lines.reduce((sum, line) => sum + line.listSum, 0)
  const purchaseSum = lines.reduce((sum, line) => sum + line.purchaseSum, 0)
  const materialBase = lines.reduce(
    (sum, line) => sum + (line.materialBaseSum ?? line.listSum / 1.15),
    0,
  )

  return {
    listSum,
    purchaseSum,
    materialBase,
  }
}
TS

cat > test/pricing.test.mjs <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/pricing.ts', import.meta.url), 'utf8')
assert.match(source, /materialBaseSum\?/)
assert.match(source, /line\.materialBaseSum \?\? line\.listSum \/ 1\.15/)
JS

git add .
git commit -m "Add explicit material base channel"
git push -u origin feature/material-base-channel

gh pr create \
  --title "Add explicit material base channel" \
  --body "Fixture PR for aha update flow." \
  --base main \
  --head feature/material-base-channel
```

Record the PR number:

```sh
PR=$(gh pr view --json number --jq .number)
```

## Step 2: Generate The Base Aha

```sh
AHA=<path-to-aha>/bin/aha.mjs

cd "$ROOT"
"$AHA" generate --pr "$PR"
PACK=$(find <path-to-aha>/packs -name "aha-*.json" -print | head -1)
"$AHA" normalize --pack "$PACK"
```

Expected checks:

```sh
node - <<'NODE' "$PACK"
const fs = require('fs')
const pack = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
if (!pack.files.length) throw new Error('no files')
if (pack.files.some((file) => Object.prototype.hasOwnProperty.call(file, "id"))) {
  throw new Error("generated files still include legacy id")
}
console.log({ files: pack.files.length, symbols: Object.keys(pack.symbols || {}).length })
NODE
```

## Step 3: Ask An External AI To Enrich The Pack

Use a subagent or another AI session. Give it only the target repo path, the
pack path, and the enrichment task. It should act like a normal user-facing AI
enrichment pass.

Prompt:

```text
You are acting as the external AI enrichment agent for a real aha workflow test.

Target repository:
<ROOT>

Aha path:
<ROOT>/<PACK>

Task:
Enrich that aha JSON in place, like a user would ask an AI after `aha generate`.

Rules:
- Only edit the aha JSON file.
- Do not change files[].diff, line numbers, file paths, additions, deletions, or patch content.
- Do not write GitHub comments, push, merge, approve, or mutate GitHub.
- User-facing generated text must be German.
- Add realistic high-signal context, not filler.

Please add:
1. file.note for changed files.
2. 1-3 inline file.notes anchored to exact existing diff lines.
3. overview with mentalModelDelta, one assumption, and one hotspot if supported by current ids.
4. reviewSignals with at least one tight range-level noise classification for mechanically low-value content if present.
5. readingOrders with one low-friction order over the changed files.
6. One decision card only if you see a concrete review decision supported by the diff.

After editing, run:
<path-to-aha>/bin/aha.mjs normalize --pack <aha.json>

Final response:
- changed file path
- inline note count
- reviewSignals range count
- overview present yes/no
- readingOrders count
- decision cards count
- normalize result
```

Expected checks after the AI finishes:

```sh
node - <<'NODE' "$PACK"
const fs = require('fs')
const pack = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const inlineNotes = pack.files.reduce((sum, file) => sum + (file.notes?.length || 0), 0)
const ranges = Object.values(pack.reviewSignals?.files || {})
  .reduce((sum, signal) => sum + (signal.ranges?.length || 0), 0)
console.log({
  inlineNotes,
  ranges,
  overview: !!pack.overview,
  readingOrders: pack.readingOrders?.length || 0,
  decisionCards: pack.decisions?.cards?.length || 0,
})
NODE
```

## Step 4: Create Local Review State

This simulates the reviewer having already viewed a file and acted on a
Decision. The update flow must not mutate this state file.

```sh
node - <<'NODE' "$PACK"
const fs = require('fs')
const packPath = process.argv[2]
const pack = JSON.parse(fs.readFileSync(packPath, 'utf8'))
const statePath = packPath.replace(/\.json$/, '.state.json')
const viewedFile = pack.files.find((file) => file.path === 'src/pricing.ts') || pack.files[0]
const decision = pack.decisions?.cards?.[0]

const state = {
  schemaVersion: '0.2',
  viewed: [viewedFile.path],
  viewedFiles: {
    [viewedFile.path]: {
      diffFingerprint: viewedFile.diffFingerprint,
      viewedAt: new Date().toISOString(),
    },
  },
  decisions: decision ? { [decision.id]: 'flag' } : {},
  updatedAt: new Date().toISOString(),
}

fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n')
console.log({ statePath, viewed: viewedFile.path, decision: decision?.id || null })
NODE

cp "$PACK" /tmp/aha-before-update.json
cp "${PACK%.json}.state.json" /tmp/aha-before-update.state.json
```

## Step 5: Change The PR After Enrichment

Add a second behavior-bearing commit to the PR.

```sh
cat > src/pricing.ts <<'TS'
export type QuoteLine = {
  sku: string
  listSum: number
  purchaseSum: number
  materialBaseSum?: number
  discountable?: boolean
}

export type QuoteSummary = {
  listSum: number
  purchaseSum: number
  materialBase: number
}

export function summarizeQuote(lines: QuoteLine[]): QuoteSummary {
  const listSum = lines.reduce((sum, line) => sum + line.listSum, 0)
  const purchaseSum = lines.reduce((sum, line) => sum + line.purchaseSum, 0)
  const materialBase = lines.reduce((sum, line) => {
    if (line.discountable === false) return sum
    return sum + (line.materialBaseSum ?? line.listSum / 1.15)
  }, 0)

  return {
    listSum,
    purchaseSum,
    materialBase,
  }
}
TS

cat > test/pricing.test.mjs <<'JS'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../src/pricing.ts', import.meta.url), 'utf8')
assert.match(source, /materialBaseSum\?/)
assert.match(source, /discountable\?/)
assert.match(source, /line\.discountable === false/)
assert.match(source, /line\.materialBaseSum \?\? line\.listSum \/ 1\.15/)
JS

git add src/pricing.ts test/pricing.test.mjs
git commit -m "Add discountable material base guard"
git push
```

## Step 6: Ask An External AI To Run The Update Flow

Use a different subagent or AI session. This is the important real-life test:
the agent should run the command itself and then repair the pack using the
update report and backup.

Prompt:

```text
You are acting as the external update-repair AI for a real aha workflow test.

Target repository:
<ROOT>

Aha path:
<ROOT>/<PACK>

PR number:
<PR>

First run this command from inside the target repository:
<path-to-aha>/bin/aha.mjs update --pr <PR> --pack <aha.json>

Then:
1. Open the updated aha JSON.
2. Open the sibling update report.
3. If dropped enrichment needs more context than the report contains, open updateReport.backupPath and inspect the previous pack.
4. Inspect the current repository code and updated aha diff.
5. Focus on changed/added files and dropped enrichment from the update report.
6. Repair or add only user-facing AI context that is still correct for the current PR head:
   - file.note
   - file.notes
   - overview
   - reviewSignals
   - decisions, only if there is a concrete supported review decision
   - readingOrders, only if it materially improves review flow
7. Remove or rewrite stale AI context that no longer matches the current diff or repository behavior.
8. Save the aha JSON.
9. Run:
<path-to-aha>/bin/aha.mjs normalize --pack <aha.json>
10. Parse the JSON again to confirm it is valid.

Critical constraints:
- Do not change files[].diff.
- Do not change line numbers.
- Do not change file paths, additions, deletions, or patch content.
- Do not invent files, symbols, decisions, or refs.
- Do not write GitHub comments.
- Do not push.
- Do not run GitHub mutation commands.
- Only update the aha JSON file. Do not edit the .state.json file.
- User-facing generated text must be German.

Output only:
- updated file path
- update report path used
- backup path used yes/no
- number of repaired inline notes
- number of new inline notes
- number of reviewSignals ranges changed
- overview changed: yes/no
- normalize command result
- anything deliberately left unrepaired because it no longer applies
```

## Step 7: Verify The Result

Verify that the enriched pack still contains deterministic truth from the
current PR.

```sh
TMP_BASE=/tmp/aha-current-base.json
"$AHA" generate --pr "$PR" --out "$TMP_BASE"

node - <<'NODE' "$PACK" "$TMP_BASE"
const fs = require('fs')
const enriched = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
const base = JSON.parse(fs.readFileSync(process.argv[3], 'utf8'))

for (const baseFile of base.files) {
  const enrichedFile = enriched.files.find((file) => file.path === baseFile.path)
  if (!enrichedFile) throw new Error(`missing file ${baseFile.path}`)
  if (JSON.stringify(enrichedFile.diff) !== JSON.stringify(baseFile.diff)) {
    throw new Error(`diff changed by enrichment: ${baseFile.path}`)
  }
  for (const key of ['path', 'add', 'del', 'tag']) {
    if (JSON.stringify(enrichedFile[key]) !== JSON.stringify(baseFile[key])) {
      throw new Error(`${key} changed for ${baseFile.path}`)
    }
  }
}

if (enriched.files.some((file) => Object.prototype.hasOwnProperty.call(file, 'id'))) {
  throw new Error('generated files still include legacy id')
}

console.log('deterministic diff preserved')
NODE
```

Verify that state was not changed.

```sh
cmp "${PACK%.json}.state.json" /tmp/aha-before-update.state.json
```

Inspect the update report.

```sh
node - <<'NODE' "${PACK%.json}.update-report.json"
const fs = require('fs')
const report = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
console.log(JSON.stringify({
  backupPath: report.backupPath,
  files: report.files,
  droppedInlineNotes: report.enrichment.inlineNotes.dropped.length,
  movedInlineNotes: report.enrichment.inlineNotes.moved.length,
  droppedSignals: report.enrichment.reviewSignals.dropped.length,
  movedSignals: report.enrichment.reviewSignals.moved.length,
}, null, 2))
NODE
```

Serve the result and verify both pack and state endpoints.

```sh
PORT=4201
"$AHA" serve --pack "$PACK" --port "$PORT"
```

In another shell:

```sh
curl -fsS "http://127.0.0.1:$PORT/aha.json" >/tmp/aha-served-pack.json
curl -fsS "http://127.0.0.1:$PORT/aha-state.json" >/tmp/aha-served-state.json
```

Expected:

- `/aha.json` parses and includes changed PR diff.
- `/aha-state.json` still includes the viewed file and decision action.
- The viewed file may be shown as changed-viewed by the UI because its
  `diffFingerprint` changed.

## What A Passing Run Looks Like

A healthy run should show roughly:

- `generate` creates a pack with path-only file references.
- AI enrichment adds inline notes, overview, reading order, optional decisions,
  and optional review signals.
- `update` writes:
  - `<pack>.pre-update-<timestamp>.json`
  - `<pack>.update-report.json`
- The update report includes changed files and any dropped or moved enrichment.
- The update-repair AI uses `backupPath` when needed.
- `normalize` exits with `0`.
- A fresh deterministic `generate` has the same `files[].diff` as the enriched
  updated pack.
- The sibling `.state.json` is unchanged.
- The local viewer serves both pack and state.

## Cleanup

The disposable repo is private but real. Delete it when finished:

```sh
gh repo delete "$OWNER/$REPO_NAME" --yes
```
