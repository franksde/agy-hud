# `doctor` Reports The Installed Plugin

**Date**: 2026-10-15
**Status**: Approved (Frank, 2026-10-15)

## Problem

The most common silent failure after an upgrade is a status line that runs a copy the upgrade never
touched. `agy plugin install` writes `$HOME/.gemini/config/plugins/agy-hud`, but it does not change
`statusLine.command`. A user wired before the CLI 1.1.0 config migration, or wired to a hand-copied
bundle, keeps running the old copy with no error. The README spends a whole section on finding this
by hand. `doctor` prints the command but cannot say whether it is the installed copy, because until
now nothing told it where the plugin was installed.

Antigravity CLI 1.3.4 added `agy plugin list --json`, which lists every installed plugin with
`name`, `version`, `enabled` and `path`. Measured on 1.3.5: about 0.1 s, local only, exit 0. Older
CLIs print `Error: unknown list option "--json"` and also exit 0.

## Contract

- `doctor` runs `agy plugin list --json` once, with a 5 s timeout and stderr discarded. Nothing else
  in agy-hud runs it; `statusline` stays as it is.
- Output that is not a JSON array, a failed or timed-out command, or a missing `agy` all mean
  **unknown**, never "not installed".
- The first entry whose `name` is `agy-hud` is the installed plugin. A JSON array without one means
  **not installed**.
- When the plugin is installed and `statusLine.command` runs agy-hud (`statuslineWired`), the command
  counts as running the installed copy when it contains `<path>/`, after `~/`, `$HOME/` and
  `${HOME}/` are expanded to the home directory. No symlink resolution. A status line owned by
  another tool is not compared: it is not ours to rewire.
- An `agy-hud` entry without a usable `path` is **unknown**.
- `doctor --json` adds:
  - `installedPlugin`: `{ "version", "path", "enabled" }`, or `null`.
  - `installedPluginStatus`: `"found"`, `"not-installed"` or `"unknown"`.
  - `statuslineRunsInstalled`: `true` / `false`, or `null` when either side is unknown or absent.
- The human report adds an `installed` row: version, enabled or disabled, and the path (home
  abbreviated). When `statuslineRunsInstalled` is `false`, it adds that upgrades installed with
  `agy plugin install` will not reach the status line, and the `/statusline` command that rewires it
  to `<path>/hooks/status-line.sh`.
- A disabled plugin is reported as such, without a warning: the status line is wired through
  settings, not through the plugin, so disabling it does not stop the HUD.

## Out Of Scope

- Reading the version of the bundle `statusLine.command` actually runs. The path check covers the
  failure that matters without executing or parsing another file.
- Any change to `statusline`, install, or the quota paths.

## Acceptance

- Unit tests cover found / not-installed / unknown, enabled and disabled, a command inside and
  outside the installed path, a `~/` command, and the human warning text.
- On this machine (CLI 1.3.5), `doctor --json` reports the installed 0.1.x at
  `~/.gemini/config/plugins/agy-hud` with `statuslineRunsInstalled: true`.
