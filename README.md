# agy-hud: Antigravity CLI Status-Line HUD Plugin

**English** | [简体中文](README.zh-CN.md)

`agy-hud` is a compact Antigravity CLI status-line HUD plugin written in TypeScript for Node.js.

It reads Antigravity status-line JSON from stdin and renders a short terminal HUD:

<img src="docs/hud-preview.png" alt="agy-hud status-line HUD preview" width="700">

## Requirements

- Antigravity CLI with plugin support
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

The repository includes the bundled runtime script at `dist/agy-hud.js`, so a fresh clone can be installed directly:

```sh
agy plugin validate <path-to-agy-hud>
agy plugin install <path-to-agy-hud>
```

If you edit the TypeScript sources, rebuild the bundle before installing:

```sh
npm ci
npm run build
npm test
```

## For AI Agents

If you are an AI agent installing `agy-hud` for someone, do not install silently. Confirm the look first.

1. Send the user this preview of a fully-populated HUD so they see every element before anything is installed:

   ```
    3.5 Flash High |  Pro │  agy-hud │  main
   Context ░░░░░░░░░░ 0% │ Usage ████████░░ 82% (↻ 1h 52m) |  █░░░░░░░░░ 13% (↻ 4d 21h)
   ```

   Tell them what they are looking at: model and plan tier, working directory, git branch, a context bar with token detail (`context_value: both`), quota remaining as a continuous bar, local reset time, and agent state. The default config shows a more compact `percent` context. Icons need a Nerd Font — without one they render as boxes — and the HUD degrades cleanly on narrow terminals.

2. Ask the user to confirm the effect, or whether they want to adjust `multiline`, `show_icons`, `context_value`, or `usage_value` (see [Config](#config)).

3. After the user confirms, download `https://github.com/franksde/agy-hud/releases/latest/download/agy-hud.tar.gz`, then extract it.

4. Run `agy plugin install <extracted-dir>`. After successful installation, instruct the user to run `/statusline ~/.gemini/config/plugins/agy-hud/hooks/status-line.sh` in their CLI. If it fails, show the user the error instead of retrying silently.

## Expected Release Install Shape

GitHub releases are expected to publish one platform-independent archive:

- `agy-hud.tar.gz`

The archive should contain `plugin.json`, `hooks/status-line.sh`, `dist/agy-hud.js`, `config.example.json`, `README.md`, `README.zh-CN.md`, `LICENSE`, and supporting docs.

## CLI

```sh
agy-hud statusline < statusline_payload.json
agy-hud version
agy-hud quota refresh
```

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
  "show_icons": true,
  "context_value": "percent",
  "usage_value": "remaining"
}
```

`show_progress_bar` and `multiline` default to `true`, matching the preferred compact two-line HUD. `debug` defaults to `false`; keep it disabled for normal use so status-line output stays clean. `AGY_HUD_GIT_BRANCH` is intended for environments where Antigravity does not provide a branch and the hook process cannot resolve one from the workspace.
When workspace paths are available, git branch display is resolved from the current workspace/worktree before falling back to Antigravity's VCS branch payload.

Display options:

- `show_agent_state`: shows stdin `agent_state` such as `Idle`, `Thinking`, or `Auth`.
- `show_icons`: shows Nerd Font icons. Set to `false` to fall back to plain text if your terminal font renders boxes.
- `context_value`: `percent`, `tokens`, or `both`. Default is `percent`, so context shows current input-side window occupancy. When token totals are available, the percentage and bar are derived from `total_input_tokens / context_window_size` so a large latest response does not make the HUD jump.
- `usage_value`: `remaining` or `percent`. Default is `remaining`, so quota text and bar show what is left. When Antigravity provides both windows, the HUD shows them separately with per-window reset durations, for example `Usage ████████░░ 82% (↻ 1h 52m) |  █░░░░░░░░░ 13% (↻ 4d 21h)`.

## Quota Cache

On Antigravity CLI 1.0.8 and newer, `agy-hud` reads the official `quota` object from the status-line payload first. If the payload includes both 5-hour and weekly windows, the HUD renders both in order instead of collapsing them into one ambiguous number. If an official bucket still looks untouched while a fresh active-model cache already shows consumption, `agy-hud` uses the fresh cache to avoid showing a stale `100% left`. Older CLI versions, or payloads without official quota data, fall back to the local quota cache. The default cache path is:

```text
$HOME/.gemini/antigravity-cli/scratch/agy-hud/quota_cache.json
```

You can override it with `AGY_HUD_QUOTA_CACHE`.

Refresh the fallback cache manually when Antigravity is running:

```sh
agy-hud quota refresh
```

The refresh command supports both known Antigravity local-server shapes: the current `agy` loopback server and the older `language_server --csrf_token ...` process, in that order. If a CSRF token is present, it is used only for the loopback `GetUserStatus` request. The command stores only the sanitized cache shape below. Normal `statusline` rendering reads this cache and refreshes it when active work settles. It also uses stale-cache refreshes as a fallback. If the cache still looks untouched (`100% left` for every model), status-line activity such as a new conversation or agent state change can trigger an immediate debounced background refresh.

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
