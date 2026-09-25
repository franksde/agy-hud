# Contributing

Thanks for helping improve `agy-hud`.

Before opening a pull request:

- Run `npm ci` if dependencies are not installed.
- Run `npm run build`.
- Run `npm test`.
- Commit `dist/agy-hud.js` when TypeScript source changes.
- Do not commit local config, cache files, logs, probe outputs, secrets, or agent scratch directories.
- Keep status-line rendering fast; `statusline` must only read stdin plus local config/cache files.
- Keep quota probing local-only (the loopback server, or the official `agy -p /usage` command where loopback is refused; agy-hud itself never opens a network connection) and make sure it writes sanitized cache data only.
