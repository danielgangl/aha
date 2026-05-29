# aha

Prototype. Vibecoded to see if the reviewpack concept actually makes sense.

This is a read-only local PR review viewer. It generates an `aha.json` from a GitHub PR diff, serves it locally, and lets optional AI passes add review context as fragment files that get merged back into the pack.

It is intentionally not a polished product yet:

- no GitHub write actions
- no comments, approvals, pushes, or review submission
- no hosted backend
- local state only
- schemas and UX are still being tested

## Agent Quickstart

If a user gives you this repo link and asks you to make an aha for a PR:

1. Clone and install this repo.

```sh
git clone https://github.com/danielgangl/aha.git
cd aha
npm install
```

2. Ask for:
   - the absolute path to the target repository,
   - the PR number,
   - whether you should run the full workflow yourself or start the empty viewer so another agent can copy the prompt.

3. If another agent should do the enrichment, start the empty viewer:

```sh
node bin/aha.mjs start
```

Then copy the setup prompt from the onboarding page. That copied prompt contains the current fragment-file workflow and merge contract; do not recreate those instructions by hand.

4. If you should do the workflow yourself, print the full prompt and follow it:

```sh
node bin/aha.mjs prompt --mode init --repo /path/to/target-repo --pr 123
```

For an already enriched pack that needs to follow the latest PR state:

```sh
node bin/aha.mjs prompt --mode update --repo /path/to/target-repo --pr 123 --pack /path/to/aha/packs/repo/123/aha-foo-123.json
```

The prompt tells you when to run `generate`, `update`, `merge`, and `normalize`, when to use subagents, and which fragment files each pass writes. Do not let parallel agents write the same JSON file.

## Local Development

```sh
npm install
npm test
npm run serve
```

After installing or linking the package bin, the direct command is:

```sh
aha serve
aha serve --pack ./aha.json
aha start
aha review --pack ./aha.json
aha generate --pr 123
aha review --pr 123
aha prompt --mode init --pr 123 --repo /path/to/repo
```

`aha serve` launches one local viewer for the central `packs/<repo>/<pr>/` library. Use the picker in the top-left header to switch between packs instead of running several ports. `aha serve --pack ./aha.json` still opens one explicit pack. `aha start` launches the empty onboarding screen with copyable commands and prompts.

`generate --pr` must be run inside the target git repository. It uses read-only GitHub CLI commands:

```sh
gh pr view 123 --json number,title,headRefName,baseRefName,author,url,additions,deletions,changedFiles,createdAt
gh pr diff 123
```

Without `--out`, generated packs are written centrally under `packs/<repo>/<pr>/` in this aha checkout. Passing `--out` explicitly chooses another output path.

Generated packs include best-effort local TS/JS symbol matching when `rg` is available. Function/class/const names found in the diff become clickable, and the right rail shows local callsites from the checked-out repo with `touched`, `untouched`, or `test` status. This is deterministic local search, not AI or full program analysis.

The viewer stores local review progress separately from the pack. `Viewed` files and review actions are saved to a sibling state file such as `aha-foo.state.json`, with `localStorage` as a browser fallback. Use `Reset viewed/actions` in the Tweaks panel, or delete the `.state.json` file to clear local progress.

For a real-life workflow test with a temporary GitHub repo, AI enrichment subagents, update repair, and state preservation checks, see [End-to-End Testing](docs/end-to-end-testing.md).

For now, note HTML is treated as trusted local aha output.
