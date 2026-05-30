import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ahaBin = path.join(repoRoot, "bin", "aha.mjs");

// The real client re-review logic. review-focus.ts uses extensionless relative
// imports (resolved by Vite in the app) that node's native TS loader won't
// resolve, so bundle it with esbuild (already a dependency) and import that.
const bundlePath = path.join(os.tmpdir(), `aha-review-focus-${process.pid}.mjs`);
execFileSync(
  path.join(repoRoot, "node_modules", ".bin", "esbuild"),
  ["src/lib/review-focus.ts", "--bundle", "--format=esm", "--platform=node", `--outfile=${bundlePath}`, "--log-level=warning"],
  { cwd: repoRoot },
);
const { allFocusItems, focusItemSnapshot, buildReviewFocus } = await import(pathToFileURL(bundlePath).href);

// Full hermetic walk of the change/update -> re-review path, mirroring
// docs/end-to-end-testing.md but with a fake gh and the real buildReviewFocus.
// Guards the thing npm test otherwise can't reach: a reviewer's triage + content
// baselines surviving an update, and the baseline-driven A->C classification.
test("e2e: update cycle preserves ids and drives the A->C re-review delta", async () => {
  const fixture = await createFixture(PATCH_V1);

  // 1. generate the deterministic pack
  const { stdout } = await runAha(fixture, ["generate", "--pr", "7"]);
  const packPath = stdout.trim().split(/\n/).at(-1);
  const fragDir = path.join(path.dirname(packPath), "fragments");

  // 2. simulate the INIT enrichment agent (stable, concern-anchored ids)
  await writeJson(path.join(fragDir, "review-judgment.json"), JUDGMENT_V1);
  await runAha(fixture, ["merge", "--pack", packPath, "--fragments", path.join(fragDir, "review-judgment.json")]);
  await runAha(fixture, ["normalize", "--pack", packPath]);
  const v1 = await readJson(packPath);

  // 3. simulate a reviewer triaging + the client capturing content baselines ("A")
  const triage = {
    "dc-mock-db-read": "flag",
    "dc-seed-sender": "accept",
    "assumption-impersonation": "flag",
    "hotspot-notification-parity": "accept",
  };
  const v1items = new Map(allFocusItems(v1.decisions, v1.overview).map((it) => [it.id, it]));
  const baselines = {};
  for (const id of Object.keys(triage)) {
    assert.ok(v1items.get(id), `init pack should contain ${id}`);
    baselines[id] = focusItemSnapshot(v1items.get(id), "2026-05-30T08:00:00.000Z");
  }
  const statePath = packPath.replace(/\.json$/, ".state.json");
  const stateBefore = { schemaVersion: "0.2", viewed: [], viewedFiles: {}, decisions: triage, baselines, updatedAt: "2026-05-30T08:00:00.000Z" };
  await writeJson(statePath, stateBefore);

  // 4. the PR changes; the deterministic update must leave review state alone
  await writeFile(fixture.patchPath, PATCH_V2);
  await runAha(fixture, ["update", "--pr", "7", "--pack", packPath]);
  assert.deepEqual(await readJson(statePath), stateBefore, "update must not touch review state or baselines");

  // 5. simulate the UPDATE agent re-enriching for v2: same ids for the same
  //    concerns (two with changed content -> A->C), one genuinely new concern
  await writeJson(path.join(fragDir, "review-judgment.json"), JUDGMENT_V2);
  await runAha(fixture, ["merge", "--pack", packPath, "--fragments", path.join(fragDir, "review-judgment.json")]);
  await runAha(fixture, ["normalize", "--pack", packPath]);
  const v2 = await readJson(packPath);

  // triaged concerns must survive the regeneration so their triage still maps
  const v2ids = new Set([...v2.decisions.cards, ...(v2.overview.assumptions || []), ...(v2.overview.hotspots || [])].map((x) => x.id));
  for (const id of Object.keys(triage)) assert.ok(v2ids.has(id), `triaged id ${id} must survive the update`);

  // 6. drive the real client re-review classification against the updated pack
  const focus = buildReviewFocus(v2.decisions, v2.overview, triage, v2.files, baselines);
  const ids = (arr) => arr.map((it) => it.id).sort();

  assert.deepEqual(ids(focus.reReview), ["assumption-impersonation", "dc-mock-db-read"], "changed-content triaged items surface as A->C re-review");
  assert.deepEqual(ids(focus.resolved), ["dc-seed-sender", "hotspot-notification-parity"], "unchanged triaged items stay resolved");
  assert.deepEqual(ids(focus.open), ["dc-runtime-guideline"], "a new, never-judged concern is open");

  // the baseline really holds the prior "A" content, distinct from current "C"
  const changed = v2.decisions.cards.find((c) => c.id === "dc-mock-db-read");
  assert.notEqual(baselines["dc-mock-db-read"].body, changed.claim);
});

async function createFixture(patch) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aha-e2e-"));
  const repo = path.join(temp, "target");
  const bin = path.join(temp, "bin");
  const patchPath = path.join(temp, "patch.diff");
  const packsDir = path.join(temp, "aha-packs");
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Aha E2E"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "aha-e2e@example.com"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# e2e\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "init"], { cwd: repo });
  await writeFile(patchPath, patch);
  await writeFakeGh(path.join(bin, "gh"));
  return {
    repo,
    patchPath,
    env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}`, AHA_FAKE_PATCH: patchPath, AHA_PACKS_DIR: packsDir },
  };
}

async function writeFakeGh(file) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "--version") { console.log("gh 0.0.0-test"); process.exit(0); }
if (a[0] === "auth") { console.log("Logged in"); process.exit(0); }
if (a[0] === "pr" && a[1] === "view") {
  console.log(JSON.stringify({ number: 7, title: "Persist sender id", headRefName: "feature/sender", baseRefName: "main", author: { name: "Aha E2E" }, url: "https://example.invalid/pr/7", additions: 0, deletions: 0, changedFiles: 2, createdAt: "2026-05-30T00:00:00Z" }));
  process.exit(0);
}
if (a[0] === "pr" && a[1] === "diff") { process.stdout.write(fs.readFileSync(process.env.AHA_FAKE_PATCH, "utf8")); process.exit(0); }
process.exit(1);
`;
  await writeFile(file, script, { mode: 0o755 });
}

async function runAha(fixture, args) {
  return execFileAsync("node", [ahaBin, ...args], { cwd: fixture.repo, env: fixture.env, maxBuffer: 64 * 1024 * 1024 });
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

const PATCH_V1 = `diff --git a/src/chat.ts b/src/chat.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/chat.ts
@@ -0,0 +1,8 @@
+export function addMessage(text, auth) {
+  return { text, senderId: auth.userId }
+}
+
+export function seedChat(auth) {
+  return addMessage("welcome", auth)
+}
diff --git a/test/chat.test.mjs b/test/chat.test.mjs
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/test/chat.test.mjs
@@ -0,0 +1,4 @@
+import assert from 'node:assert/strict'
+import { readFileSync } from 'node:fs'
+const src = readFileSync(new URL('../src/chat.ts', import.meta.url), 'utf8')
+assert.match(src, /senderId/)
`;

const PATCH_V2 = `diff --git a/src/chat.ts b/src/chat.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/chat.ts
@@ -0,0 +1,9 @@
+export function addMessage(text, auth) {
+  return { text, senderId: auth.userId }
+}
+
+export function seedChat(auth) {
+  return addMessage("welcome", auth)
+}
+
+export const SCHEMA = "messages.sender_id"
diff --git a/test/chat.test.mjs b/test/chat.test.mjs
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/test/chat.test.mjs
@@ -0,0 +1,6 @@
+import assert from 'node:assert/strict'
+import { PGlite } from '@electric-sql/pglite'
+const db = new PGlite()
+await db.exec('select sender_id from messages')
+assert.ok(db)
`;

const JUDGMENT_V1 = {
  overview: {
    mentalModelDelta: "Seed-Nachrichten persistieren den Absender.",
    flows: [],
    modelDeltas: [],
    assumptions: [{ id: "assumption-impersonation", text: "Demo-Impersonation: auth.userId ist die effektive Participant-ID.", refs: [], evidence: [{ path: "src/chat.ts", line: 2, ref: "src/chat.ts:2", desc: "senderId" }], check: "Ist auth.userId die einzige Absenderquelle?" }],
    hotspots: [{ id: "hotspot-notification-parity", title: "Parität Notification vs. Persistenz", why: "Beide Pfade müssen denselben Absender nutzen.", refs: [], evidence: [{ path: "src/chat.ts", line: 5, ref: "src/chat.ts:5" }], check: "Nutzen beide Pfade denselben Absender?" }],
  },
  decisions: {
    categories: [{ key: "coverage", label: "Coverage", why: "what tests prove" }, { key: "trust", label: "Trust", why: "auth" }],
    cards: [
      { id: "dc-mock-db-read", category: "coverage", risk: "med", title: "Test deckt Persistenz nicht ab", claim: "Mock reicht nicht — braucht DB-Read?", whyItMatters: "Ohne DB-Read driftet die Spalte.", sections: [{ kind: "evidence", label: "Beleg", items: [{ path: "test/chat.test.mjs", line: 4, ref: "test/chat.test.mjs:4", desc: "Source-Text-Test" }] }, { kind: "check", label: "Check", text: "Reicht der Mock?" }] },
      { id: "dc-seed-sender", category: "trust", risk: "low", title: "Seed setzt senderId serverseitig", claim: "Seed-Actions setzen senderId aus auth.userId.", whyItMatters: "Verhindert Client-Spoofing.", sections: [{ kind: "evidence", label: "Beleg", items: [{ path: "src/chat.ts", line: 6, ref: "src/chat.ts:6", desc: "seedChat" }] }, { kind: "check", label: "Check", text: "Serverseitig gesetzt?" }] },
    ],
    questions: [],
  },
};

const JUDGMENT_V2 = {
  overview: {
    mentalModelDelta: "Seed-Nachrichten persistieren den Absender; PGlite testet die DB-Spalte.",
    flows: [],
    modelDeltas: [],
    // same id, changed text -> A->C
    assumptions: [{ id: "assumption-impersonation", text: "PGlite-Migrationen modellieren messages.sender_id korrekt.", refs: [], evidence: [{ path: "src/chat.ts", line: 9, ref: "src/chat.ts:9", desc: "SCHEMA" }], check: "Stimmt die DB-Spalte mit auth.userId überein?" }],
    // same id, same content -> unchanged
    hotspots: [{ id: "hotspot-notification-parity", title: "Parität Notification vs. Persistenz", why: "Beide Pfade müssen denselben Absender nutzen.", refs: [], evidence: [{ path: "src/chat.ts", line: 5, ref: "src/chat.ts:5" }], check: "Nutzen beide Pfade denselben Absender?" }],
  },
  decisions: {
    categories: [{ key: "coverage", label: "Coverage", why: "what tests prove" }, { key: "trust", label: "Trust", why: "auth" }],
    cards: [
      // same id, changed claim+check -> A->C
      { id: "dc-mock-db-read", category: "coverage", risk: "med", title: "PGlite-Test beweist DB-Spalte", claim: "PGlite-Test beweist die DB-Spalte messages.sender_id.", whyItMatters: "Beweist Persistenz statt nur Source-Text.", sections: [{ kind: "evidence", label: "Beleg", items: [{ path: "test/chat.test.mjs", line: 4, ref: "test/chat.test.mjs:4", desc: "PGlite-DB-Read" }] }, { kind: "check", label: "Check", text: "Reicht der DB-Read als Nachweis?" }] },
      // same id, same content -> unchanged
      { id: "dc-seed-sender", category: "trust", risk: "low", title: "Seed setzt senderId serverseitig", claim: "Seed-Actions setzen senderId aus auth.userId.", whyItMatters: "Verhindert Client-Spoofing.", sections: [{ kind: "evidence", label: "Beleg", items: [{ path: "src/chat.ts", line: 6, ref: "src/chat.ts:6", desc: "seedChat" }] }, { kind: "check", label: "Check", text: "Serverseitig gesetzt?" }] },
      // new concern -> new id -> open
      { id: "dc-runtime-guideline", category: "coverage", risk: "med", title: "Resume/Guideline ohne PGlite", claim: "Resume- und Guideline-Flows haben nur Mock-Regression.", whyItMatters: "Offene Lücke ohne DB-Nachweis.", sections: [{ kind: "evidence", label: "Beleg", items: [{ path: "test/chat.test.mjs", line: 5, ref: "test/chat.test.mjs:5", desc: "nur Mock" }] }, { kind: "check", label: "Check", text: "Braucht es DB-Tests für Resume?" }] },
    ],
    questions: [],
  },
};
