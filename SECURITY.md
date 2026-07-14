# Security Policy

Please do not report secrets, raw Antigravity probe payloads, cookies, CSRF tokens, emails, session IDs, transcript paths, or local absolute paths in public issues.

For sensitive reports, use a private disclosure channel provided by the project maintainers.

`agy-hud statusline` renders only sanitized HUD fields from stdin plus local config/cache files. If the quota cache is stale or missing, it may start a detached background refresh that contacts only the local Antigravity loopback server.

## Local Files

`agy-hud` writes two files under its cache directory (`$XDG_CACHE_HOME/agy-hud/`, or `$HOME/.cache/agy-hud/`):

- `quota_cache.json` holds a masked email, the plan name, and per-model quota.
- `quota_cache.json.statusline.json` holds the current conversation id and agent state, used to debounce refreshes.

Neither is a secret in the credential sense — there are no tokens, cookies, or CSRF values — but both describe your account and activity. Since 0.1.8 the directory is created with mode `0700` and the files with `0600`, so they are not readable by other local accounts on a shared machine. Before 0.1.8 they inherited the default umask, typically leaving them world-readable at `0755`/`0644`.
