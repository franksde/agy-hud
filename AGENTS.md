# Agent Instructions

This repository is the TypeScript source for the `agy-hud` Antigravity CLI status-line plugin.

## Project Rules

- Reply to the user in Chinese unless they explicitly ask otherwise.
- Keep edits narrowly scoped to the requested change.
- Do not commit local runtime data, probe output, caches, secrets, or agent scratch files.
- Use `git pull --rebase` when synchronizing with a remote. Do not create merge commits.
- Prefer conventional commit messages, for example `fix(hud): prefer the current worktree branch`.

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

Sync the bundle to the file the CLI actually runs, which is whatever `statusLine.command` points at in `$HOME/.gemini/antigravity-cli/settings.json`. Do not assume it is the current plugin directory:

```sh
npm test
grep -A2 '"statusLine"' "$HOME/.gemini/antigravity-cli/settings.json"
```

The command points either at `<plugin-root>/hooks/status-line.sh` or at `<plugin-root>/dist/agy-hud.js`. The plugin root is the `agy-hud` directory in that path, not `hooks/` and not `dist/`. Sync the bundle into that root:

```sh
cp dist/agy-hud.js <plugin-root>/dist/agy-hud.js
node <plugin-root>/dist/agy-hud.js version    # must report the version you just built
node <plugin-root>/dist/agy-hud.js statusline < testdata/statusline_payload.json
```

`agy plugin install` places plugins under `$HOME/.gemini/config/plugins`, but it does NOT update `statusLine.command`. A user who installed before the Antigravity CLI 1.1.0 config migration can still be wired to `$HOME/.gemini/antigravity-cli/plugins/agy-hud`, so installing a new version there changes nothing and the CLI keeps running the old bundle without any error.

Never pass a git clone to `agy plugin install`: it copies the whole directory, including `.git/`, and aborts outright when fsmonitor's `.git/fsmonitor--daemon.ipc` socket is present. Stage the release file set first, as `README.md` describes.

If the live CLI still shows old output, first check that this installed bundle was updated. Do not assume the user is testing the working-tree `dist/agy-hud.js`.

## HUD Behavior Notes

- `statusline` must stay fast. It should only read stdin, local config, local cache, and cheap local git metadata.
- Quota probing must contact only Antigravity loopback services and must write sanitized cache data.
- The quota cache path defaults to `$XDG_CACHE_HOME/agy-hud/quota_cache.json`, falling back to `$HOME/.cache/agy-hud/quota_cache.json`. Writes always go there. Reads fall back to the pre-0.1.8 path under `$HOME/.gemini/antigravity-cli/scratch/agy-hud/` when no new cache exists yet, so upgrades are seamless.
- Quota reset comes from the local API `quotaInfo.resetTime`. Display it as an absolute local clock time, not as a live countdown, because a status-line hook cannot update already-rendered text without a redraw.
- The quota bar is a continuous progress bar derived from the exact quota fraction, 8 cells for a single window and 10 per window when both are shown (`usageBar` in `src/statusline.ts`). It is not five discrete 20% cells; an earlier revision of this file said otherwise, and that never matched the code, the tests, or the READMEs.
- The context bar is likewise continuous, based on a precise context percentage.

## Do Not "Optimize Away" The Quota Probe

On CLI 1.0.8+ the payload carries official quota and the HUD renders from it, so the background probe
looks like pure waste: it spawns a process to write a cache that, seemingly, nothing reads. It is not
waste. **The two quota sources lag in opposite windows, and they cover for each other:**

- Right after a turn settles from working to idle, the **official payload is behind**. The probe is
  ahead. `test/main.test.ts` pins this: official reports `29% left` while the probe returns
  `3% left`, and the HUD must render 3%. This is what 0.1.6's same-frame refresh exists for.
- After an idle stretch, the **loopback API is behind**. The payload is ahead. Measured on CLI 1.1.2:
  loopback still said `remainingFraction: 1` for every model while the payload already reported
  `gemini-5h: 0.9826359`; the loopback caught up about ten minutes later.

`mergeFreshCacheQuota` (`src/statusline.ts`) is what reconciles the first case, and it needs a cache
younger than five minutes to do it — which is exactly what the background refresh maintains. Suppress
the probe and that correction silently dies.

Two further traps, if you are tempted anyway. `mergeFreshCacheQuota` only corrects the **5h** window,
never weekly, so "some bucket shows consumption" is not a safe signal that official quota is healthy.
And the cache is **shared across all models** with one timestamp (`buildQuotaCache` in
`src/quotaProbe.ts`), so gating refreshes on the *current* model's quota lets the whole cache age out
and breaks the next model switch.

Also note that `statusline` only runs when the CLI redraws. There is no such thing as a refresh
during genuine idleness; the background refresh fires while the CLI is *busy*, which is what keeps
quota moving in the HUD during a long task. Lengthening its TTL trades away exactly that.

If probe cost is the real concern, make each probe cheaper rather than rarer: it currently runs
`ps aux` and `lsof` to rediscover the loopback port on every call, and that port is stable for the
CLI's lifetime.

## Release And CI

- CI expects `npm test` to pass.
- Keep `README.md` and `README.zh-CN.md` in sync when user-facing behavior changes.
- Keep `dist/agy-hud.js` in sync with TypeScript changes.
- Do not edit files under `$HOME/.gemini/config/plugins/agy-hud` except as a local verification sync step. Those installed-plugin files are not the source of truth.
