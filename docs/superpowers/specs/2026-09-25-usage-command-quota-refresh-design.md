# Quota Refresh Through `agy -p /usage`

**Date**: 2026-09-25
**Status**: Approved 2026-09-25
**Target version**: 0.1.11

## Problem

From Antigravity CLI 1.2.2 on, the `agy` loopback server rejects `GetUserStatus` with
`401 missing CSRF token`, and the status-line command is never given that token (CodexBar measured the
boundary in steipete/CodexBar#3685: 1.2.1 answers 200, 1.2.2 answers 401). The HUD is left with the
quota in the status-line payload, and that quota lags. Measured on 1.2.11 on 2026-09-25:

- During a turn the payload quota does not move at all, while `/usage` showed `gemini-5h` falling
  0.9178 → 0.9170 → 0.9159. A long task shows the quota from before it started.
- At the end of a turn the payload caught up within 0.3 s in this run.
- Before that turn, an idle session had shown 0.9194873 for about 25 minutes while the real value was
  0.9178675. Most likely the previous turn's usage was booked after the CLI's end-of-turn fetch, and
  an idle CLI does not fetch again.

`agy -p "/usage" --output-format json` (CLI 1.1.12+) returns the same four buckets the payload uses
(`gemini-5h`, `gemini-weekly`, `3p-5h`, `3p-weekly`). The CLI changelog states it starts no agent turn
and spends no quota; measured: `num_turns: 0`, `total_tokens: 0`, 5–14 s per run, 24 of 24 runs
succeeded. One run earlier the same day failed on a profile-picture download (steipete/CodexBar#3861).
A run costs about 1 s of CPU and a transient 160 MB; the rest of its roughly 7 s is five sequential
requests to `cloudcode-pa.googleapis.com`, the same ones every CLI start makes.

The running session itself offers no route to its quota. Its loopback server wants the CSRF token.
Hooks fire inside the session (`PreToolUse`, `PostInvocation`, `Stop`), but they receive only
`ANTIGRAVITY_CONVERSATION_ID` in their environment and no quota on stdin (measured 2026-09-25). A
`/usage` typed in the session prints to the terminal only. A second, short-lived `agy` process is
therefore the only sanctioned source, which is also where CodexBar landed.

## Goals

- Keep the quota moving during long tasks, and correct the stale idle value, on CLI 1.2.2+.
- Never slow down a redraw: `/usage` runs only in the background.
- Bounded cost: at most one run in flight across all sessions, and a floor between runs.
- No behaviour change on CLIs where the loopback probe still works.

## Non-Goals

- Replacing the loopback probe. It stays first choice, as it is cheaper.
- Updating the HUD while the CLI is idle. A status-line hook only runs on redraw; a fresher cache
  appears at the next redraw.
- Reading the CSRF token from the CLI binary, its memory or another process's environment.

## Design

### Source selection

`quota refresh` tries the loopback probe first. When the loopback probe is rejected as
unauthenticated, it runs `/usage` in the same refresh. When the CLI version already has a recorded
rejection (`<cache>.auth-rejected.json`, added in 9f0e383), it skips the loopback probe and goes
straight to `/usage`. The marker keeps its meaning ("loopback is refused for this version"), but it
now selects the source instead of disabling refreshes.

### Running `/usage`

- Command: `agy -p /usage --output-format json --print-timeout 30s`, resolved from `PATH`. Killed
  after 45 s.
- Working directory: a fresh `0700` temp directory, removed afterwards, so no workspace rules or
  customizations load.
- Environment: inherited, plus `AGY_HUD_NESTED=1` (see Recursion).
- Output is capped at 1 MiB and parsed as `command.data.groups[].buckets[]` with `id`, `window`,
  `remaining_fraction` and `reset_time`. Anything else is a failure. No identity fields are read or
  stored.

### Recursion

`agy -p` runs the status-line command too: the 24 measured runs produced 64 status-line frames. A
spawned `agy` therefore runs `agy-hud statusline`, which could spawn another refresh. With
`AGY_HUD_NESTED=1` set, `statusline` renders and never starts a refresh of any kind. The global lock
below is the second line of defence if the CLI ever stops passing the environment through.

### Cache

`/usage` results go into the same cache file as a new `quota` field with the payload's bucket shape
(`{ "gemini-5h": { "remaining_fraction", "reset_time" }, ... }`), plus `timestamp` and
`source: "usage"`. The per-model `models` field written by the loopback probe is unchanged, and
readers ignore whichever field is absent.

### Merge: the fresher value wins, per window

The payload carries no fetch time, so freshness is inferred from the quota itself. For each window
(5h and weekly) where both the payload and the cache have a bucket:

1. A reading whose `reset_time` has passed describes a window that has ended: a cached one is
   dropped, and a payload one yields to a live cached reading.
2. A bucket has at most one live window, so two live readings are the same window, whatever their
   `reset_time` says. An untouched bucket's `reset_time` floats with the query time, which is why it
   cannot be used to order readings (review r1). Remaining quota only goes down within a window: the
   lower `remaining_fraction` is the more recent reading.

This replaces the current rule (a cache under 5 minutes old, 5h window only, and only when it shows
more usage) for bucket-shaped caches, and it covers the weekly window as well. The per-model loopback
cache keeps the current rule unchanged.

### Triggers

Evaluated on every redraw. At most one trigger fires, and every one goes through the lock:

| When | Condition |
| --- | --- |
| Turn settles (working → idle) | cache older than 60 s |
| While working | cache older than 60 s |
| Idle redraw (e.g. typing) | cache older than 5 min |

On failure, the next attempt waits 60 s, doubling to a 10-minute cap; a success resets the wait.
These floors apply only to `/usage`. The loopback probe keeps its current intervals.

The background `quota refresh` checks the backoff and a `/usage` cache younger than 60 s again
before it runs `/usage`, so no route into it (the loopback path's lock, a takeover) can run agy more
often. A background refresh without a CLI version never falls back to `/usage`: there is nothing to
key the backoff on. A manual `quota refresh` is not paced.

### Lock

One refresh in flight across every session: a lock file next to the cache, taken with an exclusive
create, holding a random owner token that the status line passes to the refresh it spawns. Only the
refresh holding that token removes the lock, and a background refresh runs `/usage` only while the
lock still holds its token (review r2: on the first refusal of a version, the loopback path's
non-exclusive lock let two children reach `/usage`). A manual refresh never touches the lock. A lock older than 120 s
(a loopback probe followed by the 45 s `/usage` run) is stale: it is renamed aside under a unique
name and the exclusive create is retried, so two status lines cannot both take it over.

## Acceptance

- On 1.2.11, during a turn that runs longer than 2 minutes, the HUD's 5h quota changes before the
  turn ends.
- The redraw at the end of a turn takes no longer than it does with the probe paused (about 60 ms).
- With two agy sessions open, `ps` never shows more than one `agy -p /usage` spawned by agy-hud.
- `AGY_HUD_NESTED=1 agy-hud statusline` never spawns a process (unit test).
- Merge: tests cover a later window beating a lower value, the same window with the lower value
  winning, and the weekly window.
- A failing `/usage` (non-zero exit, timeout, unparseable output) leaves the payload quota on screen
  and backs off as specified.
- CLI ≤ 1.2.1 and older setups: no `/usage` run ever happens while the loopback probe succeeds.
- Both READMEs document the source, the cost (a background `agy` process, no tokens) and the
  triggers; `AGENTS.md` records why `/usage` is allowed although it is not loopback.

## Open Points

- The 25-minute stale idle value was seen once, and its cause is inferred. The trigger at the end of
  a turn is cheap enough to keep either way.
