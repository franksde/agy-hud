# Quota Cache Path Migration Design

**Date**: 2026-07-14
**Status**: Approved (revised after Codex spec review)
**Target version**: 0.1.8

## Problem

`quotaCachePath()` (`src/main.ts:76`) hardcodes the quota cache at:

```text
$HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json
```

Antigravity CLI 1.1.0 migrated its global configuration from `~/.gemini/antigravity-cli/` to
`~/.gemini/config/`, and `agy plugin install` now places plugins under `~/.gemini/config/plugins/`.
The cache path we ship therefore points into a directory the CLI itself has abandoned.

Nothing is broken: `agy-hud` creates and reads that directory itself and does not depend on the CLI
scanning it. This is a correctness-of-location problem, not a runtime bug. But the path is
misleading to anyone reading the code, and it couples us to a CLI directory layout that has already
moved once.

## Goals

- Move the quota cache out of the CLI's directory tree entirely, so a future official reorganization
  cannot strand it again.
- Upgrade must be seamless for existing users: no visible HUD regression on the first render after
  upgrading, not even a single frame missing the usage segment, and no missed quota refresh.
- Add no migration write (no rename, copy, or delete) to the `statusline` render path.

## Non-Goals

- Migrating or deleting the old cache file on disk. It is left in place deliberately (see
  "Downgrade safety").
- Making the quota cache write atomic. `quotaProbe` currently writes with a plain `writeFileSync`
  (`src/quotaProbe.ts:160`), so a concurrent reader can observe a truncated file and a crash can
  leave a corrupt one. This is a pre-existing defect that exists identically today with a single
  cache path. The read fallback below limits its blast radius, but fixing the write itself is out of
  scope for this change.
- Changing the cache file format, the quota probe, or any rendering behavior.

## Correcting a Prior Claim

An earlier draft of this spec listed "keep the statusline hot path read-only" as a goal, citing
`AGENTS.md`. That was wrong. The `statusline` path already writes: it persists the refresh-debounce
state (`src/main.ts:293`) and the background-refresh lock (`src/main.ts:308`). The real constraint in
`AGENTS.md` is that `statusline` must stay *fast*. The goal above is restated accordingly: we add no
*migration* write, and we leave the existing state and lock writes exactly as they are.

## Decisions

**New location: XDG cache directory.** The cache is derived, regenerable data, so it belongs in a
cache directory rather than in anyone's config tree. This also decouples us from Antigravity's
layout permanently. The config loader already honors `XDG_CONFIG_HOME`, so honoring `XDG_CACHE_HOME`
is consistent with existing conventions.

**Compatibility via read fallback, not migration.** Reads try the new path first and fall back to
the legacy path; writes always go to the new path. This makes the upgrade seamless without moving
files. An atomic rename on first run would produce a cleaner disk, but it adds rename-failure,
concurrency, and companion-file handling to the render path for no user-visible benefit, and it
forfeits the downgrade safety described below.

**Fallback keys on a successful load, not on file existence.** A path is only "chosen" if
`loadQuota` actually parses a cache from it. Keying on `existsSync` would let an empty, truncated, or
corrupt new cache permanently mask a perfectly good legacy one, which contradicts the
no-missing-frame goal given the non-atomic write noted above.

## Architecture

Replace the single `quotaCachePath()` with a write path and an ordered list of read candidates,
separating the read and write concerns that are currently conflated in one variable.

### `quotaCacheWritePath(): string`

Resolution order:

1. `AGY_HUD_QUOTA_CACHE` if set
2. `$XDG_CACHE_HOME/agy-hud/quota_cache.json` if `XDG_CACHE_HOME` is set
3. `$HOME/.cache/agy-hud/quota_cache.json`
4. `""` if there is no home directory (matches current behavior)

This is the only write target. Every write-side artifact derives from it: the cache itself, the
`.lock` file, and the `.statusline.json` debounce state.

### `quotaCacheReadCandidates(): string[]`

- If `AGY_HUD_QUOTA_CACHE` is set, the list is exactly `[thatPath]`. An explicit override wins
  outright, with no fallback.
- Otherwise the list is `[quotaCacheWritePath(), LEGACY_QUOTA_CACHE_PATH]`, with empty strings and
  duplicates removed.

Where:

```text
LEGACY_QUOTA_CACHE_PATH = $HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json
```

Consumers walk the list in order and take the first candidate that loads successfully. Two readers
use it:

- the quota cache itself, via `loadQuota`;
- the refresh-debounce state, via `loadStatuslineRefreshState` on each candidate's
  `.statusline.json` companion.

The debounce state must fall back too. `shouldRefreshBeforeRender` (`src/main.ts:268`) keys the
same-frame refresh on the *previous* `agentState`. If the state file did not fall back, then an
upgrade landing exactly on a working-to-idle transition would see no previous state, skip the
same-frame refresh, and also fail the staleness and activity checks (the legacy cache is fresh and
already-consumed). The quota would silently not refresh that turn. Falling back on read costs one
extra `readFileSync` attempt and removes the case entirely.

Writes never fall back: the new cache, its lock, and its debounce state always go to the write path.

## Data Flow

In the `statusline` command (`src/main.ts:174-189`):

- The initial `loadQuota` walks the read candidates and takes the first that parses.
- Everything write-side uses the write path: `refreshQuotaBeforeRenderIfNeeded`, the background
  refresh trigger, the `.lock` file, and the `.statusline.json` debounce state.
- Reading the debounce state walks the candidates' `.statusline.json` companions; writing it targets
  the write path only.
- After a refresh completes, the cache is re-read from the write path, because fresh data is
  necessarily there.

In the `quota refresh` command (`src/main.ts:191-213`), the cache path and its `.lock` companion both
resolve to the write path, so a stale legacy lock is never touched.

### Directory creation ordering

`~/.cache/agy-hud/` will not exist on first run. Two things already handle this, and the change must
preserve both:

- `quotaProbe` calls `mkdir(path.dirname(cachePath))` before writing the cache
  (`src/quotaProbe.ts:160`).
- In `triggerBackgroundRefreshIfNeeded`, `saveStatuslineRefreshState` runs (`src/main.ts:293`) before
  the `.lock` write (`src/main.ts:308`), and it is what creates the directory via its own
  `mkdirSync` (`src/main.ts:377`). The lock write depends on that ordering. Do not reorder them.

## Error Handling

Candidate walking tolerates failures: `loadQuota` already returns an `ok` flag and never throws, and
`loadStatuslineRefreshState` returns `null` on any error. If no candidate loads, the result is a
missing cache, which is an already-supported state: the existing logic triggers a background refresh
and the HUD omits the usage segment rather than showing a fake limit.

## Downgrade Safety, And Its One Sharp Edge

Because the legacy file is never moved or deleted, a user who reverts to 0.1.7 or earlier still has a
working cache: the old build reads the old path, finds the file, and proceeds.

The sharp edge: a downgrade that then runs a refresh writes *fresh* data to the legacy path while a
*stale* cache sits at the new path. On re-upgrade, the new path loads successfully and therefore
wins, so the HUD renders the older data. Pointing `AGY_HUD_QUOTA_CACHE` at the legacy path for one
refresh and then unsetting it produces the same state.

We accept this. Timestamps are deliberately not compared: doing so would mean reading and parsing
both files on every render to defend against a downgrade-refresh-upgrade sequence, and the failure
is self-healing — the stale new cache trips `quotaCacheNeedsRefresh`, a background refresh fires, and
the next render is correct. The cost is at most one render of older-but-valid quota data.

The standing cost of this approach is one orphaned file of a few KB per user, which is never cleaned
up. Accepted.

## Testing

TDD. Each test is written and observed failing before the corresponding implementation.

Path resolution:

1. `quotaCacheWritePath` honors `XDG_CACHE_HOME`.
2. `quotaCacheWritePath` falls back to `~/.cache/agy-hud/quota_cache.json` when `XDG_CACHE_HOME` is unset.
3. `AGY_HUD_QUOTA_CACHE` overrides the write path, and makes the read candidates exactly that one path.
4. `quotaCacheReadCandidates` lists the new path before the legacy path, and de-duplicates.

Read fallback:

5. Only a legacy cache exists: it is loaded and the usage segment renders (the seamless-upgrade case).
6. Both caches exist and both parse: the new one wins.
7. The new cache exists but is corrupt, and a valid legacy cache exists: the legacy one is used and
   the usage segment still renders.
8. Neither exists: no crash, no usage segment.

Write-side routing (these are what stop a partial implementation from passing):

9. A same-frame idle refresh receives the write path and reloads from the write path.
10. With only a legacy cache present, the background refresh writes `.lock` and `.statusline.json`
    under the new path only, leaving the legacy companions untouched.
11. `quota refresh` cleans up only the new lock and never unlinks a legacy lock.
12. The first background refresh succeeds when the new cache directory does not exist yet.

Debounce-state fallback:

13. Upgrade on a working-to-idle transition with only a legacy debounce state present still performs
    the same-frame refresh (the missed-refresh case that motivates the state fallback).

Test hygiene, corrected from the prior draft: it is *not* true that all existing tests inject
`AGY_HUD_QUOTA_CACHE`. The two subprocess smoke tests (`test/main.test.ts:207`, `:213`) and the
`quota refresh` test (`:219`) do not, so they run against the real default path — writing state and
lock files into the developer's home directory, potentially spawning a detached refresh, and
potentially unlinking a live lock. Since this change moves that default, these three tests must be
given a temporary `AGY_HUD_QUOTA_CACHE` override as part of the work.

## Documentation And Version Propagation

- `README.md` and `README.zh-CN.md`, "Quota Cache" section: document the new default path, the
  `XDG_CACHE_HOME` override, and the legacy read fallback.
- `AGENTS.md` line 47: update the stated default cache path.
- `CHANGELOG.md`: new 0.1.8 entry.
- Bump the version in every source of truth, not just `package.json`: `plugin.json`,
  `package-lock.json`, and the `version` constant in `src/main.ts`. The 0.1.7 release missed the last
  two and shipped a bundle that reported 0.1.6; the smoke tests now read the expected version from
  `package.json`, so a repeat of that drift fails loudly.
- Rebuild and commit `dist/agy-hud.js`, since `src/` changes.
