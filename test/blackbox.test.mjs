import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ahaBin = path.join(repoRoot, "bin", "aha.mjs");

test("generate creates a deterministic path-only aha from a PR diff", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });

  const { stdout } = await runAha(fixture, ["generate", "--pr", "42"]);
  const packPath = stdout.trim().split(/\n/).at(-1);

  const pack = await readJson(packPath);
  assert.equal(path.dirname(packPath), path.join(fixture.packsDir, "target", "42"));
  assert.equal(fs.existsSync(path.join(fixture.repo, ".aha")), false);
  assert.equal(pack.number, 42);
  assert.equal(pack.title, "Add explicit material base channel");
  assert.equal(pack.branch, "feature/material-base-channel");
  assert.equal(pack.base, "main");
  assert.equal(pack.files.length, 2);
  assert.ok(pack.files.every((file) => !("id" in file)));
  assert.deepEqual(pack.files.map((file) => file.path), ["src/pricing.ts", "test/pricing.test.mjs"]);
  assert.ok(pack.groups.some((group) => group.key === "Tests"));
  assert.ok(pack.groups.some((group) => group.key === "Other"));
  assert.ok(pack.files.find((file) => file.path === "src/pricing.ts").diff.some((line) => line.k === "add" && line.R === 5));
  assert.ok(Object.keys(pack.symbols || {}).length > 0);
});

test("normalize canonicalizes legacy file ids and sidecar references to paths", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
  const packPath = path.join(fixture.repo, "pack.json");
  const normalizedPath = path.join(fixture.repo, "normalized.json");
  await runAha(fixture, ["generate", "--pr", "42", "--out", packPath]);

  const pack = await readJson(packPath);
  const pricing = pack.files.find((file) => file.path === "src/pricing.ts");
  pricing.id = "f-pricing";
  pack.readingOrders = [{
    key: "ai",
    label: "AI order",
    why: "start with production code",
    groups: [{ key: "g1", label: "Core", why: "", files: ["f-pricing"] }],
  }];
  pack.reviewSignals = {
    version: 1,
    files: {
      "f-pricing": {
        relevance: "normal",
        source: "ai",
        hideByDefault: false,
        categories: [],
        reason: "",
        ranges: [{
          id: "noise-import",
          relevance: "noise",
          source: "ai",
          kind: "imports-only",
          hideByDefault: true,
          reason: "Nur Import-Zeile.",
          anchor: { right: { start: 1, end: 1 } },
        }],
      },
    },
  };
  pack.overview = {
    mentalModelDelta: ["Siehe ", { type: "file", id: "f-pricing", label: "pricing" }],
    flows: [],
    assumptions: [{ text: "Bestehender Default bleibt.", refs: [{ type: "file", id: "f-pricing" }] }],
    hotspots: [],
  };
  await writeJson(packPath, pack);

  await runAha(fixture, ["normalize", "--pack", packPath, "--out", normalizedPath]);

  const normalized = await readJson(normalizedPath);
  const normalizedPricing = normalized.files.find((file) => file.path === "src/pricing.ts");
  assert.ok(!("id" in normalizedPricing));
  assert.ok(normalizedPricing.diffFingerprint);
  assert.ok(normalized.reviewSignals.files["src/pricing.ts"]);
  assert.equal(normalized.reviewSignals.files["f-pricing"], undefined);
  assert.equal(normalized.readingOrders[0].groups[0].files[0], "src/pricing.ts");
  assert.equal(normalized.overview.mentalModelDelta[1].id, "src/pricing.ts");
  assert.equal(normalized.overview.assumptions[0].refs[0].id, "src/pricing.ts");
});

test("update refreshes diff truth, writes a report and leaves local review state alone", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
  const { stdout } = await runAha(fixture, ["generate", "--pr", "42"]);
  const packPath = stdout.trim().split(/\n/).at(-1);

  const oldPack = await readJson(packPath);
  const pricing = oldPack.files.find((file) => file.path === "src/pricing.ts");
  oldPack.files.find((file) => file.path === "src/pricing.ts").note = "<p>Materialbasis wird pro Zeile explizit.</p>";
  oldPack.files.find((file) => file.path === "src/pricing.ts").notes = [{
    afterR: 18,
    src: "kontext · ai",
    html: "<p>Explizite Materialbasis gewinnt, sonst bleibt der alte Default.</p>",
  }];
  oldPack.decisions.cards = [{
    id: "dc-material-base",
    category: "decisions",
    risk: "med",
    title: "Materialbasis wird zeilenweise",
    claim: "Der alte globale Default wird durch einen pro-Line-Kanal ersetzt.",
    whyItMatters: "Rabattbasis und Einkaufssumme laufen getrennt.",
    sections: [{ kind: "evidence", label: "Beleg", items: [{ fileId: "src/pricing.ts", line: 18, ref: "src/pricing.ts:18", desc: "Fallback" }] }],
  }];
  await writeJson(packPath, oldPack);
  const statePath = packPath.replace(/\.json$/, ".state.json");
  const state = {
    schemaVersion: "0.2",
    viewed: ["src/pricing.ts"],
    viewedFiles: {
      "src/pricing.ts": {
        diffFingerprint: pricing.diffFingerprint,
        viewedAt: "2026-05-26T12:00:00.000Z",
      },
    },
    decisions: { "dc-material-base": "flag" },
    updatedAt: "2026-05-26T12:00:00.000Z",
  };
  await writeJson(statePath, state);

  await writeFile(fixture.patchPath, PATCH_V2);
  await runAha(fixture, ["update", "--pr", "42", "--pack", packPath]);
  await runAha(fixture, ["normalize", "--pack", packPath]);

  const updated = await readJson(packPath);
  const report = await readJson(packPath.replace(/\.json$/, ".update-report.json"));
  const nextState = await readJson(statePath);
  assert.deepEqual(nextState, state);
  assert.ok(report.backupPath);
  assert.ok(fs.existsSync(report.backupPath));
  assert.deepEqual(report.files.changed, ["src/pricing.ts", "test/pricing.test.mjs"]);
  assert.ok(updated.files.every((file) => !("id" in file)));
  assert.equal(updated.decisions.cards[0].sections[0].items[0].path, "src/pricing.ts");
  assert.ok(!("fileId" in updated.decisions.cards[0].sections[0].items[0]));
  assert.ok(updated.files.find((file) => file.path === "src/pricing.ts").diff.some((line) => line.k === "add" && plain(line.c).includes("discountable === false")));

  const freshPath = path.join(fixture.repo, "fresh-v2.json");
  await runAha(fixture, ["generate", "--pr", "42", "--out", freshPath]);
  const fresh = await readJson(freshPath);
  for (const freshFile of fresh.files) {
    const updatedFile = updated.files.find((file) => file.path === freshFile.path);
    assert.ok(updatedFile, `missing updated file ${freshFile.path}`);
    assert.deepEqual(updatedFile.diff, freshFile.diff);
    assert.equal(updatedFile.add, freshFile.add);
    assert.equal(updatedFile.del, freshFile.del);
    assert.equal(updatedFile.tag, freshFile.tag);
  }
});

test("merge combines AI fragment files without rewriting deterministic diff truth", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
  const { stdout } = await runAha(fixture, ["generate", "--pr", "42"]);
  const packPath = stdout.trim().split(/\n/).at(-1);
  const before = await readJson(packPath);
  const fragmentsDir = path.join(path.dirname(packPath), "fragments");
  const codeContextPath = path.join(fragmentsDir, "code-context.json");
  const signalsPath = path.join(fragmentsDir, "review-signals.json");
  const judgmentPath = path.join(fragmentsDir, "review-judgment.json");

  await writeJson(codeContextPath, {
    files: [{
      path: "src/pricing.ts",
      note: "<p>Materialbasis wird pro Zeile erklärbar.</p>",
      notes: [{
        afterR: 5,
        src: "kontext · ai",
        type: "risk",
        html: "<p><code>materialBaseSum</code> macht den alten Default überschreibbar.</p>",
      }],
    }],
    readingOrders: [{
      key: "low-friction",
      label: "Low friction",
      why: "erst Contract, dann Evidence",
      groups: [{ key: "core", label: "Core", why: "", files: ["src/pricing.ts", "test/pricing.test.mjs"] }],
    }],
  });
  await writeJson(signalsPath, {
    reviewSignals: {
      version: 1,
      files: {
        "test/pricing.test.mjs": {
          relevance: "normal",
          source: "ai",
          hideByDefault: false,
          categories: [],
          reason: "",
          ranges: [{
            id: "noise-test-import",
            relevance: "noise",
            source: "ai",
            kind: "imports-only",
            hideByDefault: true,
            reason: "Nur Import-Zeile.",
            anchor: { right: { start: 1, end: 2 } },
          }],
        },
      },
    },
  });
  await writeJson(judgmentPath, {
    overview: {
      mentalModelDelta: ["Materialbasis wechselt zu ", { type: "file", id: "src/pricing.ts", label: "Pricing" }],
      flows: [],
      assumptions: [],
      hotspots: [],
    },
    decisions: {
      categories: [{ key: "coverage", label: "Coverage", why: "what tests prove vs what they don't" }],
      cards: [{
        id: "dc-runtime-coverage",
        category: "coverage",
        risk: "med",
        title: "Runtime-Test fehlt",
        claim: "Der Test prüft Source-Text statt Verhalten.",
        whyItMatters: "Die neue Aggregation kann ohne Laufzeitfall driften.",
        sections: [{ kind: "evidence", label: "Beleg", items: [{ path: "test/pricing.test.mjs", line: 5, ref: "test/pricing.test.mjs:5", desc: "Source-Text-Test" }] }],
      }],
      questions: [],
    },
  });

  await runAha(fixture, ["merge", "--pack", packPath, "--fragments", [codeContextPath, signalsPath, judgmentPath].join(",")]);

  const merged = await readJson(packPath);
  const pricing = merged.files.find((file) => file.path === "src/pricing.ts");
  assert.equal(pricing.note, "<p>Materialbasis wird pro Zeile erklärbar.</p>");
  assert.equal(pricing.notes.length, 1);
  assert.equal(pricing.notes[0].type, "risk");
  assert.ok(pricing.notes[0].anchor?.textFingerprint);
  assert.equal(merged.readingOrders[0].groups[0].files[0], "src/pricing.ts");
  assert.ok(merged.reviewSignals.files["test/pricing.test.mjs"].ranges[0].anchor.right.textFingerprint);
  assert.equal(merged.overview.mentalModelDelta[1].id, "src/pricing.ts");
  assert.equal(merged.decisions.cards[0].id, "dc-runtime-coverage");
  assert.equal(merged.decisions.cards[0].sections[0].items[0].path, "test/pricing.test.mjs");
  assert.ok(!("fileId" in merged.decisions.cards[0].sections[0].items[0]));

  for (const beforeFile of before.files) {
    const mergedFile = merged.files.find((file) => file.path === beforeFile.path);
    assert.ok(mergedFile, `missing merged file ${beforeFile.path}`);
    assert.deepEqual(mergedFile.diff, beforeFile.diff);
    assert.equal(mergedFile.add, beforeFile.add);
    assert.equal(mergedFile.del, beforeFile.del);
    assert.equal(mergedFile.tag, beforeFile.tag);
  }
});

test("start serves an empty in-memory aha without a pack file", async () => {
  const port = await freePort();
  const child = spawn("node", [ahaBin, "start", "--port", String(port)], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const pack = await waitForJson(`http://127.0.0.1:${port}/aha.json`);
    const runtime = await waitForJson(`http://127.0.0.1:${port}/aha-runtime.json`);
    assert.equal(pack.title, "Empty aha");
    assert.deepEqual(pack.files, []);
    assert.deepEqual(pack.decisions.cards, []);
    assert.match(runtime.ahaCli, /aha\.mjs$/);
  } finally {
    child.kill();
  }
});

test("serve without --pack exposes the central pack library and selected pack", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
  const { stdout } = await runAha(fixture, ["generate", "--pr", "42"]);
  const packPath = stdout.trim().split(/\n/).at(-1);
  const fragmentsDir = path.join(path.dirname(packPath), "fragments");
  await writeJson(path.join(fragmentsDir, "code-context.json"), {
    files: [{ path: "src/pricing.ts", note: "<p>Fragment, not a pack.</p>" }],
  });
  const port = await freePort();
  const child = spawn("node", [ahaBin, "serve", "--port", String(port)], {
    cwd: fixture.repo,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const index = await waitForJson(`http://127.0.0.1:${port}/aha-packs.json`);
    assert.equal(index.packs.length, 1);
    assert.equal(index.packs[0].id, "target/42/aha-feature-material-base-channel-42.json");
    assert.equal(index.packs[0].path, packPath);
    const pack = await waitForJson(`http://127.0.0.1:${port}/aha.json?pack=${encodeURIComponent(index.packs[0].id)}`);
    assert.equal(pack.number, 42);
    assert.equal(pack.title, "Add explicit material base channel");
  } finally {
    child.kill();
  }
});

test("prompt prints substituted full workflow instructions", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
  const { stdout: initPrompt } = await runAha(fixture, [
    "prompt",
    "--mode",
    "init",
    "--repo",
    fixture.repo,
    "--pr",
    "42",
    "--pack",
    path.join(fixture.packsDir, "target", "42", "aha-feature-material-base-channel-42.json"),
  ]);
  assert.match(initPrompt, /Mode: init/);
  assert.match(initPrompt, /AHA_CLI=.*aha\.mjs/);
  assert.match(initPrompt, /PACK_PATH="\$\("\$AHA_CLI" generate --pr "\$PR_NUMBER" \| tail -n 1\)"/);
  assert.match(initPrompt, /Use `\$PACK_PATH` for every later merge, normalize, and serve command/);
  assert.match(initPrompt, /--- CODE CONTEXT PASS ---/);
  assert.match(initPrompt, /--- REVIEW SIGNALS PASS ---/);
  assert.match(initPrompt, /--- REVIEW JUDGMENT PASS ---/);
  assert.match(initPrompt, /--- FRAGMENT MERGE CONTRACT ---/);
  assert.match(initPrompt, /PACK_DIR="\$\(dirname "\$PACK_PATH"\)"/);
  assert.match(initPrompt, /FRAGMENTS_DIR="\$PACK_DIR\/fragments"/);
  assert.match(initPrompt, /FRAGMENT_LIST="\$FRAGMENTS_DIR\/code-context\.json,\$FRAGMENTS_DIR\/review-signals\.json,\$FRAGMENTS_DIR\/review-judgment\.json"/);
  assert.match(initPrompt, /"\$AHA_CLI" merge --pack "\$PACK_PATH" --fragments "\$FRAGMENT_LIST"/);
  assert.match(initPrompt, /If the user explicitly asks, you can start the viewer/);
  assert.match(initPrompt, /"\$AHA_CLI" serve --pack "\$PACK_PATH" --port 4173 --host 127\.0\.0\.1/);
  assert.match(initPrompt, /do not use `nohup \.\.\. &`/);
  assert.doesNotMatch(initPrompt, /nohup "\$AHA_CLI"/);
  assert.match(initPrompt, /reviewSignals noise ranges count/);
  assert.match(initPrompt, /reviewSignals context ranges count/);
  assert.match(initPrompt, /Subagents write JSON fragment files only/);
  assert.match(initPrompt, /Give each subagent the matching pass prompt below 1:1/);
  assert.match(initPrompt, /Save only \$FRAGMENTS_DIR\/code-context\.json/);
  assert.match(initPrompt, /Save only \$FRAGMENTS_DIR\/review-signals\.json/);
  assert.match(initPrompt, /Save only \$FRAGMENTS_DIR\/review-judgment\.json/);
  assert.match(initPrompt, /Default to the current working repository and the current branch PR/);
  assert.match(initPrompt, /if \[ -z "\$TARGET_REPO" \]; then TARGET_REPO="\$\(pwd\)"; fi/);
  assert.match(initPrompt, /if \[ -z "\$PR_NUMBER" \]; then PR_NUMBER="\$\(gh pr view --json number -q \.number\)"; fi/);
  assert.doesNotMatch(initPrompt, /reviewOrders/);
  assert.doesNotMatch(initPrompt, /files\[\]\.id|file ids|fileId/);
  assert.doesNotMatch(initPrompt, /Save the updated JSON back to the same file|Return the complete updated aha JSON|Only update the aha JSON file/);
  assert.doesNotMatch(initPrompt, /<aha-cli>|<target-repo>|<pr-number>|<aha\.json>/);

  const { stdout: updatePrompt } = await runAha(fixture, [
    "prompt",
    "--mode",
    "update",
    "--repo",
    fixture.repo,
    "--pr",
    "42",
    "--pack",
    path.join(fixture.packsDir, "target", "42", "aha-feature-material-base-channel-42.json"),
  ]);
  assert.match(updatePrompt, /Mode: update/);
  assert.match(updatePrompt, /"\$AHA_CLI" update --pr "\$PR_NUMBER" --pack "\$PACK_PATH"/);
  assert.match(updatePrompt, /"\$AHA_CLI" merge --pack "\$PACK_PATH" --fragments "\$FRAGMENT_LIST"/);
  assert.match(updatePrompt, /Give each subagent the matching pass prompt below 1:1/);
  assert.match(updatePrompt, /updateReport\.backupPath/);
});

test("update carries overview forward with stable, position-independent ids", async () => {
  const assumptionA = {
    text: "Bestehender Default bleibt erhalten.",
    refs: [],
    evidence: [{ path: "src/pricing.ts", line: 18, ref: "src/pricing.ts:18", desc: "Fallback" }],
    check: "Bleibt der alte Default wirklich erhalten?",
  };
  const assumptionB = { id: "assumption-author-kept", text: "Autor-ID bleibt stabil.", refs: [] };
  const hotspot = {
    title: "Aggregation prüfen",
    why: "Drift möglich",
    refs: [],
    evidence: [{ path: "test/pricing.test.mjs", line: 5, ref: "test/pricing.test.mjs:5", desc: "Source-Text-Test" }],
    check: "Deckt der Test das Laufzeitverhalten ab?",
  };

  // The deterministic `update` carries the existing overview forward via
  // preserveOverview — the path where positional ids used to desync triage.
  const updateWithOverview = async (assumptions) => {
    const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
    const { stdout } = await runAha(fixture, ["generate", "--pr", "42"]);
    const packPath = stdout.trim().split(/\n/).at(-1);
    const pack = await readJson(packPath);
    pack.overview = { mentalModelDelta: "x", flows: [], modelDeltas: [], assumptions, hotspots: [hotspot] };
    await writeJson(packPath, pack);
    await runAha(fixture, ["update", "--pr", "42", "--pack", packPath]);
    return readJson(packPath);
  };

  const first = await updateWithOverview([assumptionA, assumptionB]);
  const second = await updateWithOverview([assumptionB, assumptionA]); // reordered

  const idA1 = first.overview.assumptions.find((a) => a.text === assumptionA.text).id;
  const idA2 = second.overview.assumptions.find((a) => a.text === assumptionA.text).id;

  // Author-provided id is preserved verbatim.
  assert.equal(first.overview.assumptions.find((a) => a.text === assumptionB.text).id, "assumption-author-kept");
  // Content-anchored, never positional.
  assert.ok(!/^overview-assumption-\d+$/.test(idA1), `expected content-anchored id, got ${idA1}`);
  assert.ok(idA1.startsWith("assumption-"));
  assert.ok(first.overview.hotspots[0].id.startsWith("hotspot-"));
  // Position-independent: same concern -> same id regardless of list order.
  assert.equal(idA1, idA2);
  // Uniform worklist payload (evidence + check) survives normalize.
  assert.equal(first.overview.assumptions.find((a) => a.text === assumptionA.text).evidence[0].path, "src/pricing.ts");
  assert.equal(first.overview.hotspots[0].check, hotspot.check);
});

test("review state PUT keeps baselines only for triaged items", async () => {
  const fixture = await createBlackboxFixture({ patch: PATCH_V1 });
  await runAha(fixture, ["generate", "--pr", "42"]);
  const port = await freePort();
  const child = spawn("node", [ahaBin, "serve", "--port", String(port)], {
    cwd: fixture.repo,
    env: fixture.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const index = await waitForJson(`http://127.0.0.1:${port}/aha-packs.json`);
    const packId = index.packs[0].id;
    const url = `http://127.0.0.1:${port}/aha-state.json?pack=${encodeURIComponent(packId)}`;
    const baseline = { lens: "decide", title: "Old A", body: "old claim", check: "still right?", at: "2026-05-29T00:00:00.000Z" };
    const put = await putJson(url, {
      schemaVersion: "0.2",
      viewed: [],
      viewedFiles: {},
      decisions: { "dc-keep": "flag" },
      baselines: {
        "dc-keep": baseline,
        "dc-orphan": { lens: "verify", title: "no triage", body: "", check: "", at: "2026-05-29T00:00:00.000Z" },
      },
      updatedAt: "2026-05-29T00:00:00.000Z",
    });
    assert.ok(put.ok);

    const state = await getJson(url);
    assert.equal(state.decisions["dc-keep"], "flag");
    assert.deepEqual(state.baselines["dc-keep"], baseline);
    // A baseline whose item is not triaged is dropped on save.
    assert.equal(state.baselines["dc-orphan"], undefined);
  } finally {
    child.kill();
  }
});

async function createBlackboxFixture({ patch }) {
  const temp = await mkdtemp(path.join(os.tmpdir(), "aha-blackbox-"));
  const repo = path.join(temp, "target");
  const bin = path.join(temp, "bin");
  const patchPath = path.join(temp, "patch.diff");
  const packsDir = path.join(temp, "aha-packs");
  await mkdir(repo, { recursive: true });
  await mkdir(bin, { recursive: true });
  await execFileAsync("git", ["init", "-b", "main"], { cwd: repo });
  await execFileAsync("git", ["config", "user.name", "Aha Test"], { cwd: repo });
  await execFileAsync("git", ["config", "user.email", "aha-test@example.com"], { cwd: repo });
  await writeFile(path.join(repo, "README.md"), "# fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: repo });
  await execFileAsync("git", ["commit", "-m", "Initial fixture"], { cwd: repo });
  await writeFile(patchPath, patch);
  await writeFakeGh(path.join(bin, "gh"), patchPath);
  return {
    repo,
    bin,
    patchPath,
    env: {
      ...process.env,
      PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      AHA_FAKE_PATCH: patchPath,
      AHA_PACKS_DIR: packsDir,
    },
    packsDir,
  };
}

async function writeFakeGh(file, patchPath) {
  const script = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "--version") {
  console.log("gh version 0.0.0-test");
  process.exit(0);
}
if (args[0] === "auth" && args[1] === "status") {
  console.log("Logged in to github.com as aha-test");
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "view") {
  console.log(JSON.stringify({
    number: 42,
    title: "Add explicit material base channel",
    headRefName: "feature/material-base-channel",
    baseRefName: "main",
    author: { name: "Aha Test" },
    url: "https://example.invalid/aha/pull/42",
    additions: 0,
    deletions: 0,
    changedFiles: 2,
    createdAt: "2026-05-26T12:00:00Z"
  }));
  process.exit(0);
}
if (args[0] === "pr" && args[1] === "diff") {
  process.stdout.write(fs.readFileSync(${JSON.stringify(patchPath)}, "utf8"));
  process.exit(0);
}
console.error("unexpected fake gh args: " + args.join(" "));
process.exit(1);
`;
  await writeFile(file, script, { mode: 0o755 });
}

async function runAha(fixture, args) {
  const { stdout, stderr } = await execFileAsync("node", [ahaBin, ...args], {
    cwd: fixture.repo,
    env: fixture.env,
    maxBuffer: 64 * 1024 * 1024,
  });
  return { stdout, stderr };
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + "\n");
}

function plain(value) {
  if (Array.isArray(value)) return value.map(plain).join("");
  if (value && typeof value === "object") return value.label || "";
  return String(value || "");
}

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

async function waitForJson(url) {
  let lastError;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      return await getJson(url);
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw lastError;
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${body}`));
          return;
        }
        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    }).on("error", reject);
  });
}

function putJson(url, value) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(value);
    const target = new URL(url);
    const req = http.request(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname + target.search,
        method: "PUT",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) },
      },
      (res) => {
        let body = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => {
          if (res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(`HTTP ${res.statusCode}: ${body}`));
            return;
          }
          try {
            resolve(JSON.parse(body));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.on("error", reject);
    req.write(data);
    req.end();
  });
}

const PATCH_V1 = `diff --git a/src/pricing.ts b/src/pricing.ts
new file mode 100644
index 0000000..1111111
--- /dev/null
+++ b/src/pricing.ts
@@ -0,0 +1,23 @@
+export type QuoteLine = {
+  sku: string
+  listSum: number
+  purchaseSum: number
+  materialBaseSum?: number
+}
+
+export type QuoteSummary = {
+  listSum: number
+  purchaseSum: number
+  materialBase: number
+}
+
+export function summarizeQuote(lines: QuoteLine[]): QuoteSummary {
+  const listSum = lines.reduce((sum, line) => sum + line.listSum, 0)
+  const purchaseSum = lines.reduce((sum, line) => sum + line.purchaseSum, 0)
+  const materialBase = lines.reduce(
+    (sum, line) => sum + (line.materialBaseSum ?? line.listSum / 1.15),
+    0,
+  )
+
+  return { listSum, purchaseSum, materialBase }
+}
diff --git a/test/pricing.test.mjs b/test/pricing.test.mjs
new file mode 100644
index 0000000..2222222
--- /dev/null
+++ b/test/pricing.test.mjs
@@ -0,0 +1,6 @@
+import assert from 'node:assert/strict'
+import { readFileSync } from 'node:fs'
+
+const source = readFileSync(new URL('../src/pricing.ts', import.meta.url), 'utf8')
+assert.match(source, /materialBaseSum\\?/)
+assert.match(source, /line\\.materialBaseSum \\?\\? line\\.listSum \\/ 1\\.15/)
`;

const PATCH_V2 = `diff --git a/src/pricing.ts b/src/pricing.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/src/pricing.ts
@@ -0,0 +1,25 @@
+export type QuoteLine = {
+  sku: string
+  listSum: number
+  purchaseSum: number
+  materialBaseSum?: number
+  discountable?: boolean
+}
+
+export type QuoteSummary = {
+  listSum: number
+  purchaseSum: number
+  materialBase: number
+}
+
+export function summarizeQuote(lines: QuoteLine[]): QuoteSummary {
+  const listSum = lines.reduce((sum, line) => sum + line.listSum, 0)
+  const purchaseSum = lines.reduce((sum, line) => sum + line.purchaseSum, 0)
+  const materialBase = lines.reduce((sum, line) => {
+    if (line.discountable === false) return sum
+    return sum + (line.materialBaseSum ?? line.listSum / 1.15)
+  }, 0)
+
+  return { listSum, purchaseSum, materialBase }
+}
diff --git a/test/pricing.test.mjs b/test/pricing.test.mjs
new file mode 100644
index 0000000..4444444
--- /dev/null
+++ b/test/pricing.test.mjs
@@ -0,0 +1,8 @@
+import assert from 'node:assert/strict'
+import { readFileSync } from 'node:fs'
+
+const source = readFileSync(new URL('../src/pricing.ts', import.meta.url), 'utf8')
+assert.match(source, /materialBaseSum\\?/)
+assert.match(source, /discountable\\?/)
+assert.match(source, /line\\.discountable === false/)
+assert.match(source, /line\\.materialBaseSum \\?\\? line\\.listSum \\/ 1\\.15/)
`;
