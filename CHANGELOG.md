# Changelog

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
