# Quota Cache Path Migration Design

**Date**: 2026-07-14
**Status**: Approved (revised after two Codex spec-review rounds)
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
- Upgrade must be seamless for existing users: no frame missing the usage segment, and no missed
  quota refresh.
- Introduce no failure mode that does not already exist with a single cache path.
- Add no migration write (no rename, copy, or delete) to the `statusline` render path.

## Non-Goals

- Migrating or deleting the old cache file on disk. It is left in place deliberately (see
  "Downgrade safety").
- Making the cache and state writes atomic. Both use a plain `writeFileSync`
  (`src/quotaProbe.ts:160`, `src/main.ts:378`), so a concurrent reader can observe a truncated file
  and a crash can leave a corrupt one. This is a pre-existing defect. It is out of scope, but the
  read-fallback design below must not *amplify* it — see "Corruption handling", which is what makes
  declining the atomic write safe.
- Changing the cache file format, the quota probe, or any rendering behavior.

## Correcting Two Prior Claims

An earlier draft listed "keep the statusline hot path read-only" as a goal, citing `AGENTS.md`. That
was wrong: `statusline` already writes the refresh-debounce state (`src/main.ts:293`) and the
background-refresh lock (`src/main.ts:308`). The real constraint is that `statusline` must stay
*fast*. The goal is restated as adding no *migration* write.

An earlier draft also claimed the legacy cache "cannot be newer" than the new cache. That is false;
see "Downgrade safety" for the reachable sequence and the accepted cost.

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

The first candidate is the *primary*. Consumers walk the list in order. Writes never fall back.

## Corruption Handling

The cache and the debounce state fall back under *different* rules. The asymmetry is deliberate,
because the two failure modes have opposite consequences.

### Quota cache: fall back on any load failure, but repair the primary

The cache falls back whenever a candidate fails to load, corrupt or absent, because falling back
means "render slightly older but valid quota", which is safe.

That alone would introduce a new failure mode, however. Consider: the primary cache is truncated by
an interrupted write, while a fresh legacy cache still sits within its TTL. The render falls back to
the legacy cache, `quotaCacheNeedsRefresh` inspects *that* cache, finds it fresh, and schedules no
refresh. The corrupt primary is never rewritten, and it stays masked until the legacy cache ages out
— indefinitely, if an old build keeps refreshing the legacy path. With a single cache path this
cannot happen: the load fails, the cache is `null`, and a refresh fires immediately.

So the loader must distinguish *absent* from *present-but-unloadable*. If the primary exists and
fails to load, that is a **repair condition**: a background refresh is forced regardless of the
freshness of whatever cache was actually rendered, which rewrites the primary. This reuses the
existing escape hatch in `triggerBackgroundRefreshIfNeeded`, where `activityRefresh` already forces
a refresh past the `quotaCacheNeedsRefresh` check (`src/main.ts:295`). The repair takes the normal
30-second lock window, not the 5-second activity window, so a persistently failing refresh retries
at the same cadence as any stale cache today.

### Debounce state: fall back only when the primary is absent

The state file must *not* fall back on a corrupt primary. Falling back here does not mean "render
older data", it means *resurrecting a stale `agentState`*, which has a side effect:
`shouldRefreshBeforeRender` (`src/main.ts:268`) would read a stale `working`, compare it against a
current `idle` payload, and fire a same-frame refresh — and unlike the background path, the
same-frame refresh takes no lock. Concurrent renders that all fail to read a primary state file
mid-write would each resurrect the legacy `working` state and each launch a probe, which would then
race to overwrite the primary cache and feed straight back into the corruption above.

Single-path behavior is to read `null` on any failure and skip the same-frame refresh. We preserve
exactly that: the state falls back to the legacy companion **only when the primary companion does
not exist**. A primary that exists but fails to parse yields `null`, same as today.

Why the state must fall back at all when absent: `shouldRefreshBeforeRender` keys the same-frame
refresh on the *previous* `agentState`. Without the fallback, an upgrade landing exactly on a
working-to-idle transition sees no previous state, skips the same-frame refresh, and also fails the
staleness and activity checks, because the legacy cache is fresh and already-consumed. The quota
silently would not refresh that turn.

## Data Flow

In the `statusline` command (`src/main.ts:174-189`):

- The initial cache load walks the read candidates and takes the first that parses, recording whether
  the primary was present-but-unloadable (the repair condition above).
- Everything write-side uses the write path: `refreshQuotaBeforeRenderIfNeeded`, the background
  refresh trigger, the `.lock` file, and the `.statusline.json` debounce state.
- After a refresh completes, the cache is re-read from the write path, because fresh data is
  necessarily there.

`loadStatuslineRefreshState` has three call sites, and they do not all get the fallback:

| Call site | Read strategy |
|---|---|
| `shouldRefreshBeforeRender` (`src/main.ts:272`) | Fallback (absent-primary only) |
| `triggerBackgroundRefreshIfNeeded` (`src/main.ts:290`) | Fallback (absent-primary only) |
| Post-refresh merge in `refreshQuotaBeforeRenderIfNeeded` (`src/main.ts:260`) | **Read removed** |

The third call site turned out to be dead work, which only became visible while implementing. It
reaches `mergeStatuslineRefreshState` with a non-null payload and `activityRefresh` hard-coded to
`true`, and that overwrites every field of the merged state — so whatever it loaded was discarded.
Rather than give a dead read a fallback policy, the read is removed and `null` is passed. A test pins
the resulting state: rebuilt from the payload with a fresh `lastActivityAt`, inheriting nothing.

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

The sharp edge: a downgrade that then runs a refresh writes *fresh* data to the legacy path while an
older cache sits at the new path. On re-upgrade the primary loads successfully and therefore wins, so
the HUD renders the older data. Pointing `AGY_HUD_QUOTA_CACHE` at the legacy path for one refresh and
then unsetting it produces the same state.

We accept this, and the cost is larger than an earlier draft claimed. It is **not** one frame. If the
primary cache is still inside its TTL — 15 seconds when consumed, 30 seconds when untouched
(`src/main.ts:13-14`) — then `quotaCacheNeedsRefresh` returns `false` and *every* render in that
window shows the older data, plus the round trip of the background refresh that eventually fires.
Seconds, not frames.

Timestamps are deliberately not compared: doing so would mean reading and parsing both candidates on
every render to defend against a sequence that requires a manual downgrade or a manual env override,
and that self-heals within seconds. If a one-frame bound were ever required, comparing candidate
timestamps would be the way to get it.

The standing cost of this approach is one orphaned file of a few KB per user, which is never cleaned
up. Accepted.

## Testing

TDD. Each test is written and observed failing before the corresponding implementation.

Path resolution:

1. `quotaCacheWritePath` honors `XDG_CACHE_HOME`.
2. `quotaCacheWritePath` falls back to `~/.cache/agy-hud/quota_cache.json` when `XDG_CACHE_HOME` is unset.
3. `AGY_HUD_QUOTA_CACHE` overrides the write path, and makes the read candidates exactly that one path.
4. `quotaCacheReadCandidates` lists the new path before the legacy path, and de-duplicates.

Cache read fallback:

5. Only a legacy cache exists: it is loaded and the usage segment renders (the seamless-upgrade case).
6. Both caches exist and both parse: the primary wins.
7. Primary corrupt, legacy valid: the legacy cache renders, **and** a repair refresh is forced even
   though the rendered legacy cache is fresh.
8. Neither exists: no crash, no usage segment.

Write-side routing (these are what stop a partial implementation from passing):

9. A same-frame idle refresh receives the write path and reloads from the write path.
10. With only a legacy cache present, the background refresh writes `.lock` and `.statusline.json`
    under the new path only, leaving the legacy companions untouched.
11. `quota refresh` cleans up only the new lock and never unlinks a legacy lock.
12. `quota refresh` passes `quotaCacheWritePath()` to the injected refresh callback. (Without this,
    an implementation could migrate the lock cleanup correctly and still write the cache to the old
    path.)
13. The first background refresh succeeds when the new cache directory does not exist yet.

Debounce-state semantics:

14. Upgrade on a working-to-idle transition with only a legacy state present still performs the
    same-frame refresh (the missed-refresh case that motivates the state fallback).
15. A *corrupt* primary state file with a legacy `working` state present does **not** resurrect the
    legacy state: no same-frame refresh fires.
16. `triggerBackgroundRefreshIfNeeded` reads the state through the fallback independently of
    `shouldRefreshBeforeRender`. Pin it with a recent legacy `working` state that suppresses the
    same-frame refresh, and assert the background trigger still sees the fallback state.
17. The post-refresh state merge reads the write path only, and does not merge fields from a legacy
    companion.

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
