# Changelog

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
