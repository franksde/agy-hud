# Agent Instructions

This repository is the TypeScript source for the `agy-hud` Antigravity CLI status-line plugin.

## Project Rules

- Reply to the user in Chinese unless they explicitly ask otherwise.
- Keep edits narrowly scoped to the requested change.
- Do not commit local runtime data, probe output, caches, secrets, or agent scratch files.
- Use `git pull --rebase` when synchronizing with a remote. Do not create merge commits.
- Prefer conventional commit messages, for example `fix(hud): render quota as discrete cells`.

## Development Workflow

Before changing code, inspect the relevant source and tests. Use TDD for behavior changes:

1. Add or update a focused test that captures the desired behavior.
2. Run the target test and confirm it fails for the expected reason.
3. Make the minimal source change.
4. Run the target test again.
5. Run the full test suite before reporting completion.

The full suite is:

```sh
npm test
```

`npm test` runs `npm run build`, `npm run build:test`, and then the compiled Node test suite. Because the plugin ships its bundled runtime, source changes that affect runtime behavior must include the rebuilt `dist/agy-hud.js`.

## Local Plugin Verification

Antigravity runs the installed plugin copy, not necessarily this working tree. After changing HUD rendering or quota behavior, rebuild and sync the bundle before asking the user to verify in the live CLI:

```sh
npm test
cp dist/agy-hud.js "$HOME/.gemini/config/plugins/agy-hud/dist/agy-hud.js"
node "$HOME/.gemini/config/plugins/agy-hud/dist/agy-hud.js" statusline < testdata/statusline_payload.json
```

`agy plugin install` places plugins under `$HOME/.gemini/config/plugins`. Installs predating the Antigravity CLI 1.1.0 config migration may still leave a stale copy under `$HOME/.gemini/antigravity-cli/plugins/agy-hud`, which the CLI no longer reads.

If the live CLI still shows old output, first check that this installed bundle was updated. Do not assume the user is testing the working-tree `dist/agy-hud.js`.

## HUD Behavior Notes

- `statusline` must stay fast. It should only read stdin, local config, local cache, and cheap local git metadata.
- Quota probing must contact only Antigravity loopback services and must write sanitized cache data.
- The quota cache path defaults to `$XDG_CACHE_HOME/agy-hud/quota_cache.json`, falling back to `$HOME/.cache/agy-hud/quota_cache.json`. Writes always go there. Reads fall back to the pre-0.1.8 path under `$HOME/.gemini/antigravity-cli/scratch/agy-hud/` when no new cache exists yet, so upgrades are seamless.
- Quota reset comes from the local API `quotaInfo.resetTime`. Display it as an absolute local clock time, not as a live countdown, because a status-line hook cannot update already-rendered text without a redraw.
- The quota bar represents 20% steps from the official quota data. Render it as five discrete cells, not as a continuous progress bar.
- The context bar is different: it is based on a precise context percentage and may remain continuous.

## Release And CI

- CI expects `npm test` to pass.
- Keep `README.md` and `README.zh-CN.md` in sync when user-facing behavior changes.
- Keep `dist/agy-hud.js` in sync with TypeScript changes.
- Do not edit files under `$HOME/.gemini/config/plugins/agy-hud` except as a local verification sync step. Those installed-plugin files are not the source of truth.
