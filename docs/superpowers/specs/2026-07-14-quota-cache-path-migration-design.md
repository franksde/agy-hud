# Quota Cache Path Migration Design

**Date**: 2026-07-14
**Status**: Approved
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
  upgrading, not even a single frame missing the usage segment.
- Keep the `statusline` hot path read-only, per the constraint in `AGENTS.md`.

## Non-Goals

- Migrating or deleting the old cache file on disk. It is left in place deliberately (see
  "Downgrade safety").
- Changing the cache file format, the quota probe, or any rendering behavior.
- Making the refresh-debounce state file or the lock file backward compatible.

## Decisions

**New location: XDG cache directory.** The cache is derived, regenerable data, so it belongs in a
cache directory rather than in anyone's config tree. This also decouples us from Antigravity's
layout permanently. The config loader already honors `XDG_CONFIG_HOME`, so honoring `XDG_CACHE_HOME`
is consistent with existing conventions.

**Compatibility via read fallback, not migration.** Reads try the new path first and fall back to
the legacy path; writes always go to the new path. This makes the upgrade seamless without moving
files, and keeps the hot path read-only. The alternative, an atomic rename on first run, would
produce a cleaner disk but adds a write to the `statusline` render path plus rename-failure,
concurrency, and companion-file handling for no user-visible benefit.

## Architecture

Replace the single `quotaCachePath()` with two functions that separate the read and write concerns
that are currently conflated in one variable.

### `quotaCacheWritePath(): string`

Resolution order:

1. `AGY_HUD_QUOTA_CACHE` if set
2. `$XDG_CACHE_HOME/agy-hud/quota_cache.json` if `XDG_CACHE_HOME` is set
3. `$HOME/.cache/agy-hud/quota_cache.json`
4. `""` if there is no home directory (matches current behavior)

This is the only write target. Every write-side artifact derives from it.

### `quotaCacheReadPath(): string`

Resolution order:

1. `AGY_HUD_QUOTA_CACHE` if set (explicit override wins for both read and write; no fallback)
2. `quotaCacheWritePath()` if that file exists
3. `LEGACY_QUOTA_CACHE_PATH` if that file exists
4. `quotaCacheWritePath()` otherwise

Where:

```text
LEGACY_QUOTA_CACHE_PATH = $HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json
```

The new path wins whenever it exists; timestamps are never compared. Writes only ever target the new
path, so the legacy file cannot be newer in any flow reachable from a single version.

## Data Flow

In the `statusline` command (`src/main.ts:174-189`):

- The initial `loadQuota` uses the read path.
- Everything write-side uses the write path: `refreshQuotaBeforeRenderIfNeeded`, the background
  refresh trigger, the `.lock` file, and the `.statusline.json` debounce state.
- After a refresh completes, the cache is re-read from the write path, because fresh data is
  necessarily there.

In the `quota refresh` command (`src/main.ts:191-213`), the cache path and its `.lock` companion both
resolve to the write path. `quotaProbe` already calls `mkdir(path.dirname(cachePath))` before
writing (`src/quotaProbe.ts:160`), so `~/.cache/agy-hud/` is created automatically. No new directory
handling is needed.

### Companion files do not fall back

`${cachePath}.lock` and `${cachePath}.statusline.json` bind to the write path only. Losing the
debounce state on upgrade causes at most one extra background refresh, which is harmless. Making
them backward compatible would add branches for no user-visible gain.

## Error Handling

Read-path probing uses `existsSync`. Any exception falls through to the write path. A missing cache
is already a supported state: the existing missing/stale logic triggers a background refresh and the
HUD omits the usage segment rather than showing a fake limit. So the worst case of a path-resolution
failure degrades into an already-tested code path.

## Downgrade Safety

Because the legacy file is never moved or deleted, a user who reverts to 0.1.7 or earlier still has
a working cache: the old build reads the old path, finds the file, and proceeds. If it is stale, the
existing refresh logic rebuilds it in place. This is a direct consequence of choosing read-fallback
over migration.

The cost is one orphaned file of a few KB per user, which never gets cleaned up. Accepted.

## Testing

TDD. Each test is written and observed failing before the corresponding implementation.

Path resolution (`test/main.test.ts`):

1. `quotaCacheWritePath` honors `XDG_CACHE_HOME`.
2. `quotaCacheWritePath` falls back to `~/.cache/agy-hud/quota_cache.json` when `XDG_CACHE_HOME` is unset.
3. `AGY_HUD_QUOTA_CACHE` overrides both read and write paths.
4. `quotaCacheReadPath` returns the new path when both new and legacy files exist.
5. `quotaCacheReadPath` returns the legacy path when only the legacy file exists.
6. `quotaCacheReadPath` returns the new path when neither file exists.

Integration (`test/main.test.ts`):

7. `statusline` renders the usage segment when only a legacy cache exists (the seamless-upgrade case).
8. A refresh writes the new cache to the write path and leaves the legacy file unmodified.

Existing tests inject paths via `AGY_HUD_QUOTA_CACHE`, so they are unaffected by the change in
hardcoded defaults. Tests that manipulate `XDG_CACHE_HOME` or `HOME` must save and restore the
original environment values, matching the existing pattern in `test/main.test.ts`.

## Documentation

- `README.md` and `README.zh-CN.md`, "Quota Cache" section: document the new default path, the
  `XDG_CACHE_HOME` override, and the legacy read fallback.
- `AGENTS.md` line 47: update the stated default cache path.
- `CHANGELOG.md`: new 0.1.8 entry.
- Rebuild and commit `dist/agy-hud.js`, since `src/` changes.
