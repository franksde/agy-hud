# Security Policy

Please do not report secrets, raw Antigravity probe payloads, cookies, CSRF tokens, emails, session IDs, transcript paths, or local absolute paths in public issues.

For sensitive reports, use a private disclosure channel provided by the project maintainers.

`agy-hud statusline` renders only sanitized HUD fields from stdin plus local config/cache files. If the quota cache is stale or missing, it may start a detached background refresh that contacts only the local Antigravity loopback server. On Antigravity CLI 1.2.2+, which refuses that request, the refresh instead runs the official read-only `agy -p /usage` command: agy then talks to Google with your own sign-in, as it always does, and agy-hud itself makes no network request. Its output is parsed for quota buckets only, and its error text is never printed.

## Local Files

`agy-hud` writes local files under its cache directory (`$XDG_CACHE_HOME/agy-hud/`, or `$HOME/.cache/agy-hud/`):

- `quota_cache.json` holds a masked email, the plan name, and per-model quota; after a `/usage` refresh it holds only the quota buckets (remaining fraction and reset time per window) and a timestamp.
- `quota_cache.json.statusline.json` holds the current conversation id and agent state, used to debounce refreshes.
- `quota_cache.json.server.json` is an optional discovery hint containing only a PID, loopback port, process start time/executable path and discovery timestamp. No CSRF token or credential is cached; reuse requires the same live `agy` process identity and a hint younger than five minutes.
- `quota_cache.json.auth-rejected.json` records that the loopback server refused the probe for a CLI version, plus the `/usage` failure backoff. It holds a version string and timestamps only.
- A transient `quota_cache.json.lock` coordinates background refreshes. It holds a random owner token.

These files are not secrets in the credential sense — there are no tokens, cookies, or CSRF values — but they describe your account, activity and local machine. Since 0.1.8 the directory is created with mode `0700` and the data files with `0600`, so newly created files are not readable by other local accounts on a shared machine. Existing permissions are not changed automatically. Before 0.1.8 they inherited the default umask, typically leaving them world-readable at `0755`/`0644`.
