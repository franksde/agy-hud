# agy-hud: Antigravity CLI Status-Line HUD Plugin

**English** | [简体中文](README.zh-CN.md)

`agy-hud` is a compact Antigravity CLI status-line HUD plugin written in TypeScript for Node.js.

It reads Antigravity status-line JSON from stdin and renders a short terminal HUD:

<img src="docs/hud-preview.png" alt="agy-hud status-line HUD preview" width="700">

## Requirements

- Antigravity CLI 1.1.0 or newer, verified through 1.1.24. The status line is wired with the CLI's native `/statusline` command, which 0.1.8 relies on: the `components` hook that older `plugin.json` files declared is not honored by 1.1.x, so it has been dropped. On a 1.0.x CLI that predates `/statusline` there is no way to activate this version — stay on 0.1.7 or update the CLI.
- Node.js 18+ available on `PATH`
- macOS or Linux. Windows is not currently supported because the plugin hook/install flow has not been verified there.

`agy-hud` is distributed as an Antigravity plugin archive, not as an npm package. The archive includes the bundled runtime script at `dist/agy-hud.js`, so plugin users do not need to run `npm install`.

## Install From GitHub Release

Download the platform-independent archive from the [latest release](https://github.com/franksde/agy-hud/releases/latest):

```sh
curl -fsSL -o agy-hud.tar.gz \
  https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz
tar -xzf agy-hud.tar.gz
agy plugin install ./agy-hud
```

The extracted directory is a complete plugin (`plugin.json`, `hooks/`, `dist/`), so it can be passed straight to `agy plugin install`. It runs with Node.js 18+ and does not require `npm install` after extraction.

**Important: After installation, you must run the following slash command inside your Antigravity CLI to enable the HUD:**
```
/statusline ~/.gemini/config/plugins/agy-hud/hooks/status-line.sh
```

## Install From Local Path

Do not pass a git clone straight to `agy plugin install`. The command copies the *entire* directory, so it would drag `.git/`, `src/`, `test/`, and everything else into the plugin directory — and if the clone has git's fsmonitor enabled, the copy aborts outright on `.git/fsmonitor--daemon.ipc`, because it is a socket rather than a file.

Stage the same file set the release archive ships, then install that:

```sh
npm ci && npm run build && npm test

stage=$(mktemp -d)/agy-hud
mkdir -p "$stage/hooks" "$stage/dist" "$stage/docs"
cp plugin.json config.example.json README.md README.zh-CN.md LICENSE THIRD_PARTY_NOTICES.md SECURITY.md CONTRIBUTING.md CHANGELOG.md "$stage/"
cp hooks/status-line.sh "$stage/hooks/"
cp dist/agy-hud.js "$stage/dist/"
cp docs/hud-preview.png "$stage/docs/"

agy plugin validate "$stage"
agy plugin install "$stage"
```

A local install lands in the same plugin directory as a release install, so the `/statusline` step above is required here too.

## Upgrading

**Installing a new version is not the same as upgrading.** The CLI's `statusLine.command` points at a specific file, and `agy plugin install` does not update it. If your command still points at an older copy of `dist/agy-hud.js`, that older copy keeps running: the HUD looks fine, nothing errors, and you are simply not on the new version.

Start by finding out what you are actually running:

```sh
grep -A2 '"statusLine"' ~/.gemini/antigravity-cli/settings.json
```

The command is one of these two shapes. Either way, **the plugin root is the `agy-hud` directory in that path** — not the `hooks` directory the command names, and not `dist`:

```text
/Users/you/.gemini/config/plugins/agy-hud/hooks/status-line.sh
                                   ^^^^^^^ plugin root

node /Users/you/.gemini/config/plugins/agy-hud/dist/agy-hud.js statusline
                                       ^^^^^^^ plugin root
```

Confirm the version that root is on:

```sh
node <plugin-root>/dist/agy-hud.js version
```

**If the HUD is currently working**, the smallest upgrade is to overwrite the bundle inside that root. The wiring does not change and no slash command is needed:

```sh
curl -fsSL -o agy-hud.tar.gz \
  https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz
tar -xzf agy-hud.tar.gz
cp agy-hud/dist/agy-hud.js <plugin-root>/dist/agy-hud.js
node <plugin-root>/dist/agy-hud.js version   # confirm it now reports the new version
```

**If your HUD disappeared after updating the Antigravity CLI to 1.1.x**, you were relying on the old `components` hook, which the CLI no longer registers. Install the new version normally and wire it up once with `/statusline`, as in the install sections above. This step is unavoidable: a plugin has no install hook that can write the status-line setting for you — `components` *was* that mechanism, and it is gone.

The quota cache needs no action either way. See [Quota Cache](#quota-cache).

## Uninstalling

The `/statusline` command stores its configuration separately from the plugin files. Clear that
configuration before uninstalling so the CLI does not retain a command that points at the removed
plugin:

```text
/statusline delete
```

Then uninstall the plugin:

```sh
agy plugin uninstall agy-hud
```

## For AI Agents

If you are an AI agent installing `agy-hud` for someone, do not install silently. Confirm the look first.

**First check whether they already have it**, by reading `statusLine.command` in `~/.gemini/antigravity-cli/settings.json`. If it already points at an `agy-hud.js`, this is an upgrade, not an install: follow [Upgrading](#upgrading) and overwrite that exact file. Do not `agy plugin install` into the new plugin directory and stop there — the CLI would keep running the old copy, the HUD would look perfectly healthy, and the user would never learn they are still on the old version.

For a genuinely new install:

1. Send the user this preview of a fully-populated HUD so they see every element before anything is installed:

   ```
    3.5 Flash High |  Pro │  agy-hud │  main
   Context ░░░░░░░░░░ 0% │ Usage ████████░░ 82% (↻ 1h 52m) |  █░░░░░░░░░ 13% (↻ 4d 21h)
   ```

   Tell them what they are looking at: model and plan tier, working directory, git branch, a context bar with token detail (`context_value: both`), quota remaining as a continuous bar, local reset time, and agent state. The default config shows a more compact `percent` context. Icons need a Nerd Font — without one they render as boxes — and the HUD degrades cleanly on narrow terminals.

2. Ask the user to confirm the effect, or whether they want to adjust `multiline`, `show_icons`, `context_value`, or `usage_value` (see [Config](#config)).

3. After the user confirms, download `https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz`, then extract it.

4. Run `agy plugin install <extracted-dir>`. Pass the extracted archive directory, never a git clone (see [Install From Local Path](#install-from-local-path) for why). After successful installation, instruct the user to run `/statusline ~/.gemini/config/plugins/agy-hud/hooks/status-line.sh` in their CLI — the HUD does not appear until they do. If it fails, show the user the error instead of retrying silently.

## Expected Release Install Shape

GitHub releases are expected to publish one platform-independent archive:

- `agy-hud.tar.gz`

The archive should contain `plugin.json`, `hooks/status-line.sh`, `dist/agy-hud.js`, `config.example.json`, `README.md`, `README.zh-CN.md`, `LICENSE`, `THIRD_PARTY_NOTICES.md`, and supporting docs. Runtime dependencies are bundled, so no extra installation is required.

## CLI

Installing the plugin does **not** put an `agy-hud` command on your `PATH` — the archive ships a bundle, not an npm package. Run the bundle with `node`, using the plugin root that your `statusLine.command` points into (`~/.gemini/config/plugins/agy-hud` for a current install):

```sh
node <plugin-root>/dist/agy-hud.js statusline < statusline_payload.json
node <plugin-root>/dist/agy-hud.js version
node <plugin-root>/dist/agy-hud.js quota refresh
```

The examples below use `agy-hud` as shorthand for that. If you use these often, alias it.

`statusline` renders from stdin plus local config/cache files. When `agent_state` settles from active work back to `idle`, it performs one local loopback `quota refresh` before rendering so the same redraw can reflect post-response quota. Missing or stale cache data can still refresh in the background as a fallback. `quota refresh` asks the running Antigravity local server for `GetUserStatus`, writes the sanitized quota cache, and exits non-zero if no local server can be reached.

## Config

`agy-hud` looks for config in:

- `AGY_HUD_CONFIG`
- `AGY_HUD_GIT_BRANCH` for an explicit git branch display override
- `config.json` next to the bundled script or plugin root
- `$XDG_CONFIG_HOME/agy-hud/config.json`
- `$HOME/.config/agy-hud/config.json`

Default config:

```json
{
  "show_model": true,
  "show_progress_bar": true,
  "multiline": true,
  "color": true,
  "debug": false,
  "show_git_branch": true,
  "show_cwd": true,
  "show_agent_state": true,
  "show_cost": true,
  "show_icons": true,
  "context_value": "percent",
  "usage_value": "remaining"
}
```

`show_progress_bar` and `multiline` default to `true`, matching the preferred compact two-line HUD. `debug` defaults to `false`; keep it disabled for normal use so status-line output stays clean. `AGY_HUD_GIT_BRANCH` is intended for environments where Antigravity does not provide a branch and the hook process cannot resolve one from the workspace.
When workspace paths are available, git branch display is resolved from the current workspace/worktree before falling back to Antigravity's VCS branch payload.

Display options:

- `show_agent_state`: shows stdin `agent_state` such as `Idle`, `Thinking`, or `Auth`.
- `show_cost`: shows the session cost supplied as `cost.total_usd` by Antigravity CLI 1.1.21+, at the end of the top line (or the single line). `estimated: true` adds `~`, for example `~$0.02`. Zero displays as `$0.00`, positive amounts below $0.001 as `<$0.001`; missing, negative or non-finite values are omitted. The HUD does not separately add `subagent_usd` or calculate subscription charges; this is not an invoice or a promise of actual billing.
- `show_icons`: shows Nerd Font icons. Set to `false` to fall back to plain text if your terminal font renders boxes.
- `context_value`: `percent`, `tokens`, or `both`. Default is `percent`, so context shows current input-side window occupancy. When token totals are available, the percentage and bar are derived from `total_input_tokens / context_window_size` so a large latest response does not make the HUD jump.
- `usage_value`: `remaining` or `percent`. Default is `remaining`, so quota text and bar show what is left. When Antigravity provides both windows, the HUD shows them separately with per-window reset durations, for example `Usage ████████░░ 82% (↻ 1h 52m) |  █░░░░░░░░░ 13% (↻ 4d 21h)`.

Cost is hidden before any existing segment when space is tight; the remaining layout then follows the usual degradation order. CJK, emoji and combining marks are measured in terminal columns, and clipping does not split grapheme clusters. Exact emoji appearance still depends on your terminal and font.

Plan badges recognize `Pro`, `Ultra`, `Free` and their `Google AI`-prefixed forms. Unknown or missing tiers show `Plan ?`, not `Free`.

## Quota Cache

On Antigravity CLI 1.0.8 and newer, `agy-hud` reads the official `quota` object from the status-line payload first. If the payload includes both 5-hour and weekly windows, the HUD renders both in order instead of collapsing them into one ambiguous number. If an official bucket still looks untouched while a fresh active-model cache already shows consumption, `agy-hud` uses the fresh cache to avoid showing a stale `100% left`. Older CLI versions, or payloads without official quota data, fall back to the local quota cache. The default cache path is:

```text
$XDG_CACHE_HOME/agy-hud/quota_cache.json
$HOME/.cache/agy-hud/quota_cache.json   # when XDG_CACHE_HOME is unset
```

You can override it with `AGY_HUD_QUOTA_CACHE`, which then becomes the only path used for both reads
and writes.

Before 0.1.8 the cache lived at `$HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json`,
inside a directory the Antigravity CLI abandoned in 1.1.0. Upgrading needs no action: the HUD still
reads that old file when no new cache exists yet, and the first refresh writes the new one. The old
file is left in place, so downgrading keeps working too.

If the new cache exists but cannot be parsed — a write interrupted by a crash, say — the HUD renders
from the old cache and forces a refresh to rewrite the damaged file, rather than leaving it masked.

Refresh the fallback cache manually when Antigravity is running:

```sh
node <plugin-root>/dist/agy-hud.js quota refresh
```

The refresh command supports both known Antigravity local-server shapes: the current `agy` loopback server and the older `language_server --csrf_token ...` process, in that order. If a CSRF token is present, it is used only for the loopback `GetUserStatus` request. The command stores only the sanitized cache shape below. Normal `statusline` rendering reads this cache and refreshes it when active work settles. It also uses stale-cache refreshes as a fallback. If the cache still looks untouched (`100% left` for every model), status-line activity such as a new conversation or agent state change can trigger an immediate debounced background refresh.

Since 0.1.9, quota refreshes can reuse `quota_cache.json.server.json` next to the quota cache (or `<AGY_HUD_QUOTA_CACHE>.server.json`). It holds only a PID, local port, process identity (start time and executable path), and discovery timestamp. Each reuse checks the process identity with a targeted `ps` call, avoiding a full process scan and `lsof`; hints expire after five minutes. Failure or malformed quota causes discovery in the same refresh. Legacy servers requiring CSRF are never cached in this hint. Quota refresh intervals, background refreshes and working-to-idle same-frame correction are unchanged.

Expected sanitized cache shape:

```json
{
  "timestamp": "2026-05-19T12:00:00Z",
  "plan_name": "Pro",
  "models": {
    "Gemini 3.5 Flash (Medium)": {
      "remainingFraction": 0.2,
      "resetTime": "2026-05-19T12:44:00Z"
    }
  }
}
```

If quota data is missing, the HUD omits the usage segment instead of showing a fake limit. Official quota payloads can include live `reset_in_seconds`, so dual-window quota displays show per-window relative reset durations. The local fallback cache still derives reset from the local API's `resetTime` field and displays it as a local clock time.

## Privacy And Security

`agy-hud statusline` renders from stdin plus local optional config/cache files. It does not transmit status-line payload data externally. Quota refreshes contact only the local Antigravity loopback server.

`agy-hud quota refresh` contacts only the local Antigravity server on loopback and does not print CSRF tokens, cookies, or raw probe responses.

The renderer intentionally avoids printing sensitive status-line fields, including email, session IDs, conversation IDs, transcript paths, tokens, CSRF values, cookies, keys, and full workspace paths. Git branch detection reads `.git/HEAD` directly and does not run `git`.

Do not put raw Antigravity probe payloads, logs, cookies, tokens, emails, or local machine paths in issues or pull requests.

## Development

```sh
npm ci
npm run build
npm test
```

`npm run build` bundles `src/main.ts` into `dist/agy-hud.js`. Commit the updated `dist/agy-hud.js` with any source changes so cloned plugins can run without a build step.

## Limitations

Quota fields depend on local Antigravity availability and a compatible local cache. If Antigravity is not running, or its local `GetUserStatus` endpoint changes, the HUD omits quota details.
