# Changelog

## 0.1.10

- Added `doctor`, a read-only self-check: Node version, the command the CLI has wired to its status line, the config file in effect and the resolved `show_icons`, the detected terminal, whether the session is remote, a heuristic Nerd Font scan, and an icon probe. `doctor --json` prints the same report machine-readably for agents verifying an install they just performed.
- The font scan is reported as a hint and never as a verdict, in both directions: an installed Nerd Font is not necessarily the family the terminal draws with, and Ghostty, WezTerm and kitty ship their own glyph fallback, so a scan that finds nothing can still render every icon. Nothing in the HUD can observe what a terminal actually drew, so the probe needs a person to read it.
- `doctor` names the config file already in effect when it suggests turning icons off. A `config.json` next to the bundle outranks the one under `~/.config`, so suggesting the home path while such a file exists would have handed users an edit the HUD never reads. Both READMEs carry the same warning.
- Home-path abbreviation covers a path embedded in a command, so a status line wired as `node <path> statusline` no longer prints the account name, and is skipped when the home directory is `/`, which would otherwise rewrite every absolute path on the system.
- `doctor`'s human output abbreviates home paths to `~/…`, since that report is what a user pastes into a bug report and the README already asks them not to include local machine paths. `--json` keeps absolute paths for an agent acting on the same machine.
- `doctor` recognizes kitty and Alacritty, which deliberately do not set `TERM_PROGRAM`, from the variables they do export. Their font-setting hints were previously unreachable.
- The Nerd Font name pattern matches hyphenated forms such as `Hack-Nerd-Font-Regular.ttf`, which a whitespace-only separator missed.
- `fc-list` is queried for family names with a raised output limit. The unbounded default could exceed the 1 MB buffer on a font-heavy machine, and that failure would have been reported as "could not scan".
- Documented that icons rendering as boxes is a terminal font condition, not a plugin fault (#13). The four HUD icons live in the Nerd Font Private Use Area, while the quota reset arrow is standard Unicode and keeps rendering, which is what makes a broken status line look half-working.
- Rewrote the AI agent install flow around that: send the icon probe with the preview and ask the user what they see, write `show_icons: false` before installing when they report boxes, and verify with `doctor --json` afterwards. Agents are told not to install fonts on the user's behalf, since a font install alone changes nothing without the terminal's own font setting, and cannot change anything at all over SSH.

## 0.1.9 — 2026-09-02

- Updated verified compatibility with Antigravity CLI through 1.1.24.
- Added session token-cost display from CLI 1.1.21+ (`cost.total_usd`), enabled by default with `show_cost`. Estimates carry `~`; invalid values are omitted. The HUD displays the supplied total without adding subagent cost separately or calculating subscription charges.
- Cost is the first segment hidden on narrow terminals, preserving directory, branch and quota information that already fits.
- Recognize both short and `Google AI`-prefixed Pro, Ultra and Free tiers. Unrecognized tiers display `Plan ?` instead of incorrectly claiming Free.
- Measure terminal columns for CJK, current emoji sequences and combining marks; truncate on grapheme boundaries and strip ANSI/OSC sequences when clipping.
- Reuse a short-lived, credential-free local `agy` server hint after checking its PID, start time and executable path. Failed, expired or malformed hints fall back to discovery in the same refresh. Quota refresh frequency and same-frame correction are unchanged.
- Continue discovery when a listener returns unrelated JSON instead of quota data.
- Added regression coverage for current Gemini, Claude and GPT labels, dual quota windows, config overrides, cost degradation, Unicode width and server-hint recovery.
- Updated esbuild to 0.28.2, retaining Node.js 18 support and removing the development-server advisory. Runtime dependencies are bundled; their licenses ship in `THIRD_PARTY_NOTICES.md`.

## 0.1.8

- Moved the quota cache to `$XDG_CACHE_HOME/agy-hud/` (or `$HOME/.cache/agy-hud/`), out of the `~/.gemini/antigravity-cli/` tree that the Antigravity CLI abandoned in 1.1.0.
- Upgrades are seamless and need no action: the HUD still reads the old cache until the first refresh writes the new one, and the old file is left in place so downgrades keep working.
- Force a refresh when the new cache exists but cannot be parsed, so a truncated file cannot be masked indefinitely by a fresh legacy cache.
- Fixed the subprocess tests writing state and lock files into the real home directory, where they could spawn a detached refresh or unlink a live lock.
- Documented upgrading, which is not the same as installing: `agy plugin install` does not update `statusLine.command`, so a new version can sit unused while the CLI keeps running the old bundle without any error.
- Fixed the local-path install instructions. Passing a git clone to `agy plugin install` copies the entire repository into the plugin directory, and fails outright when git's fsmonitor socket is present.
- The cache directory is now created with mode `0700` and its files with `0600`. They carry a masked email, plan name, and conversation id, and previously inherited the default umask, leaving them readable by other local accounts.
- Ignore a relative `XDG_CACHE_HOME`, as the XDG spec requires. It would otherwise put a separate cache, lock, and refresh probe inside every project directory the HUD rendered in.
- A same-frame refresh that repairs a corrupt cache no longer also spawns a background refresh for damage it just fixed.
- Release builds now verify that the git tag matches `package.json`, `plugin.json`, and the built bundle, and re-check that the committed `dist/` is current. A mistyped tag previously published a release whose archive reported a different version.
- Documented that installing the plugin does not put an `agy-hud` command on `PATH`. The CLI examples now run the bundle with `node`.
- Requirements now state Antigravity CLI 1.1.0+ explicitly, since dropping the `components` hook leaves no way to activate the HUD on a CLI without `/statusline`.

## 0.1.7

- Adapted to the Antigravity CLI native status-line architecture: removed the `components` hook block from `plugin.json`, which newer CLI versions no longer honor.
- Documented the `/statusline <plugin-dir>/hooks/status-line.sh` command needed to enable the HUD after install, for both release and local-path installs.
- Updated the local plugin verification path to `$HOME/.gemini/config/plugins/agy-hud`, where `agy plugin install` now places plugins.
- Thanks to @lbwds for reporting and fixing the plugin manifest and install docs.

## 0.1.6

- Show both 5-hour and weekly quota windows when Antigravity provides both buckets.
- Refresh quota once before rendering when active work settles back to idle, so the next HUD redraw is not one turn behind.
- Prefer the current `agy` loopback server over stale `language_server` quota data.
- Fixed `agy` process detection when the process has no extra arguments.
- Fixed context token detail to match the input-token basis used by the context percentage.
- Updated English and Chinese docs for dual-window quota display and refresh behavior.
- Documented that Windows is not currently supported.

## 0.1.5

- Fixed git branch display when Antigravity is operating inside a linked worktree.
- Prefer the current workspace directory over stale VCS payload branches and project-root fallbacks.
- Added regression coverage for stale payload branch data and worktree project/current directory mismatches.

## 0.1.4

- Prefer official Antigravity CLI 1.0.8+ status-line quota payloads over the local fallback cache.
- Render quota usage with the same continuous progress bar style as context usage.
- Added regression coverage for official Gemini and third-party quota buckets.
- Updated English and Chinese docs for official quota payload support and fallback cache behavior.

## 0.1.3

- Fixed active-model quota refresh when switching to a model whose cached quota still looked untouched inside an otherwise used mixed-model cache.
- Added regression coverage for switching to `Claude Opus 4.6 (Thinking)` with stale `100% left` cache data.
- Synchronized the Antigravity plugin manifest version with the bundled CLI version.

## 0.1.2

- Added activity-triggered quota refresh when a live status-line payload arrives while cached quota still looks untouched.
- Added a lightweight status-line refresh state file and debounce so full placeholder quota can recover without waiting for the normal stale-cache window.
- Added regression coverage for a new live conversation starting with a fresh `100% left` quota cache.
- Updated docs for activity-triggered background quota refresh behavior.

## 0.1.1

- Fixed status-line model display after switching to Claude models.
- Shortened Claude model labels to `Sonnet 4.6` and `Opus 4.6`.
- Added non-blocking background quota cache refresh for stale or missing cache files.
- Updated English and Chinese docs for the Node.js runtime requirement and background quota refresh behavior.

## 0.1.0

- Initial TypeScript/Node.js implementation of the Antigravity CLI status-line HUD.
- Added renderer, config loading, quota cache reading, local quota refresh, fast git branch detection, bundled plugin packaging, and CI/release workflows.
- Added configurable agent state, context value format, and quota remaining/used display.
- Added quota refresh fallback for the current `agy` loopback server when the older `language_server --csrf_token` process is not present.
- Omitted fake quota placeholders when usage data is missing and hid reset countdowns for untouched `100% left` quota.
