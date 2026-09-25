import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { defaultConfig, loadFromPaths, Config } from "./config";
import { Cache, CachedQuotaBucket, load as loadQuota, matchModel } from "./quota";
import { RefreshResult, refreshQuota } from "./quotaProbe";
import { queryUsage, UsageOutcome } from "./usageCommand";
import { branch as gitBranch } from "./gitinfo";
import { Payload, render } from "./statusline";
import { DoctorDeps, collectDoctorReport, formatDoctorReport } from "./doctor";

export const version = "0.1.10";

const consumedQuotaRefreshMs = 15 * 1000;
const untouchedQuotaRefreshMs = 30 * 1000;

interface StatuslineRefreshState {
  conversationId: string;
  agentState: string;
  lastActivityAt?: string;
}

export function renderStatusline(input: string, cfg: Config = defaultConfig(), cache: Cache | null = null): string {
  if (input.trim() === "") {
    return "agy-hud";
  }
  let payload: Payload;
  try {
    payload = JSON.parse(input) as Payload;
  } catch {
    return "agy-hud";
  }
  let branch = "";
  if (cfg.showGitBranch) {
    branch = gitBranchFromPayload(payload);
    if (branch === "") {
      branch = sanitizedBranch(payload.vcs?.branch ?? "");
    }
    if (branch === "" && shouldUseProcessCWD(payload.cwd ?? "")) {
      branch = gitBranch(".");
    }
    if (branch === "") {
      branch = sanitizedBranch(process.env.AGY_HUD_GIT_BRANCH ?? "");
    }
  }
  try {
    return render(payload, {
      config: cfg,
      quota: cache,
      gitBranch: branch
    });
  } catch {
    return "agy-hud";
  }
}

export function configPaths(): string[] {
  const paths: string[] = [];
  const explicit = process.env.AGY_HUD_CONFIG;
  if (explicit) {
    paths.push(explicit);
  }
  paths.push(...pluginConfigPaths());
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    paths.push(path.join(xdg, "agy-hud", "config.json"));
  }
  const home = os.homedir();
  if (home) {
    paths.push(path.join(home, ".config", "agy-hud", "config.json"));
  }
  return paths;
}

// The candidates next to the bundle and in the plugin root. Both sit inside the plugin's managed
// directory, which Antigravity CLI 1.1.28+ replaces exactly on `agy plugin install`.
export function pluginConfigPaths(): string[] {
  const dir = path.dirname(__filename);
  return [path.join(dir, "config.json"), path.join(dir, "..", "config.json")];
}

// The user-level config file to create when none exists yet. It is the first user-level entry
// configPaths() produces, so a custom XDG_CONFIG_HOME is honoured instead of being shadowed by a
// suggestion to write $HOME/.config, which the loader would only reach second.
export function userConfigPath(): string {
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    return path.join(xdg, "agy-hud", "config.json");
  }
  const home = os.homedir();
  if (home) {
    return path.join(home, ".config", "agy-hud", "config.json");
  }
  return "";
}

export function quotaCacheWritePath(): string {
  const explicit = process.env.AGY_HUD_QUOTA_CACHE;
  if (explicit) {
    return explicit;
  }
  // The XDG spec requires an absolute path and says to ignore the variable otherwise. A relative
  // value would make the cache follow the working directory, giving every project its own cache,
  // lock, and probe.
  const xdg = process.env.XDG_CACHE_HOME;
  if (xdg && path.isAbsolute(xdg)) {
    return path.join(xdg, "agy-hud", "quota_cache.json");
  }
  const home = os.homedir();
  if (!home) {
    return "";
  }
  return path.join(home, ".cache", "agy-hud", "quota_cache.json");
}

function legacyQuotaCachePath(): string {
  const home = os.homedir();
  if (!home) {
    return "";
  }
  return path.join(home, ".gemini", "antigravity-cli", "scratch", "agy-hud", "quota_cache.json");
}

export function quotaCacheReadCandidates(): string[] {
  if (process.env.AGY_HUD_QUOTA_CACHE) {
    return [quotaCacheWritePath()];
  }
  const candidates = [quotaCacheWritePath(), legacyQuotaCachePath()];
  return candidates.filter((candidate, index) => candidate !== "" && candidates.indexOf(candidate) === index);
}

// Returns the first candidate that parses, plus whether the primary candidate exists but failed to
// load. A primary that is present and unloadable is a repair condition: a fallback render would
// otherwise mask the damaged file behind a fresh legacy cache and nothing would ever rewrite it.
function loadQuotaFromCandidates(candidates: string[]): [Cache | null, boolean, boolean] {
  let primaryUnloadable = false;
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const [cache, ok] = loadQuota(candidate);
    if (ok) {
      return [cache, true, primaryUnloadable];
    }
    if (index === 0 && fs.existsSync(candidate)) {
      primaryUnloadable = true;
    }
  }
  return [null, false, primaryUnloadable];
}

function gitBranchFromPayload(payload: Payload): string {
  const paths = [
    payload.workspace?.current_dir ?? "",
    payload.cwd ?? "",
    payload.vcs?.root ?? "",
    payload.workspace?.project_dir ?? ""
  ];
  for (const candidate of paths) {
    if (!validGitCandidatePath(candidate)) {
      continue;
    }
    const found = gitBranch(candidate);
    if (found !== "") {
      return found;
    }
  }
  return "";
}

function shouldUseProcessCWD(payloadCWD: string): boolean {
  if (payloadCWD.trim() === "") {
    return true;
  }
  return path.basename(process.cwd()) === path.basename(payloadCWD);
}

function validGitCandidatePath(candidate: string): boolean {
  const trimmed = candidate.trim();
  if (trimmed === "") {
    return false;
  }
  try {
    return fs.statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}

function sanitizedBranch(raw: string): string {
  raw = raw.trim();
  if (raw === "" || raw.length > 80) {
    return "";
  }
  for (const char of raw) {
    const ok =
      (char >= "a" && char <= "z") ||
      (char >= "A" && char <= "Z") ||
      (char >= "0" && char <= "9") ||
      char === "/" ||
      char === "-" ||
      char === "_" ||
      char === ".";
    if (!ok) {
      return "";
    }
  }
  return raw;
}

type WriteFn = (chunk: string) => void;

interface CliDeps {
  stdin?: NodeJS.ReadableStream;
  stdout?: WriteFn;
  stderr?: WriteFn;
  refreshQuota?: (cachePath: string) => Promise<RefreshResult>;
  usageQuota?: () => Promise<UsageOutcome>;
  doctorDeps?: Partial<DoctorDeps>;
}

function usage(write: WriteFn): void {
  write("usage: agy-hud [statusline|quota refresh|doctor [--json]|version]\n");
}

// Font discovery is the only part of doctor that shells out, and only on Linux. A missing or
// failing fc-list is reported as "unknown", never as a missing font: the scan is a hint, and a
// wrong negative would push users toward a font install they may not need.
function fcList(): string | null {
  try {
    return execFileSync("fc-list", [":", "family"], {
      encoding: "utf8",
      timeout: 3000,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"]
    });
  } catch {
    return null;
  }
}

export function doctorDepsFromEnv(): DoctorDeps {
  return {
    version,
    nodeVersion: process.version,
    platform: process.platform,
    env: process.env,
    homedir: os.homedir(),
    configPaths: configPaths(),
    userConfigPath: userConfigPath(),
    pluginConfigPaths: pluginConfigPaths(),
    readFile: filePath => {
      try {
        return fs.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    listDir: dirPath => {
      try {
        return fs.readdirSync(dirPath);
      } catch {
        return [];
      }
    },
    fcList
  };
}

export async function runCli(args: string[], deps: CliDeps = {}): Promise<number> {
  const stdout = deps.stdout ?? (chunk => {
    process.stdout.write(chunk);
  });
  const stderr = deps.stderr ?? (chunk => {
    process.stderr.write(chunk);
  });
  const command = args[0] ?? "statusline";

  if (command === "version" || command === "--version" || command === "-v") {
    stdout(`${version}\n`);
    return 0;
  }

  if (command === "statusline") {
    const cfg = loadFromPaths(configPaths());
    const raw = await readStdin(deps.stdin ?? process.stdin);
    const payload = parsePayload(raw);
    const cachePath = quotaCacheWritePath();
    const [cache, ok, primaryUnloadable] = loadQuotaFromCandidates(quotaCacheReadCandidates());
    if (process.env.AGY_HUD_NESTED === "1") {
      // The status line of the agy that a /usage refresh started. It must not refresh again, and its
      // print-mode agent states must not overwrite the interactive session's refresh state.
      stdout(`${renderStatusline(raw, cfg, ok ? cache : null)}\n`);
      return 0;
    }
    const cliVersion = safeCliVersion(payload?.version);
    // Loopback is refused for this CLI version, so quota comes from background /usage runs instead.
    const probeRejected = authRejectedFor(cachePath, cliVersion);
    const [displayCache, refreshed] = await refreshQuotaBeforeRenderIfNeeded(
      cachePath,
      ok ? cache : null,
      payload,
      deps.refreshQuota ?? refreshQuota,
      cliVersion,
      probeRejected
    );
    // A same-frame refresh already rewrote the write path, so a corrupt primary is repaired by now.
    // Passing the stale flag on would spawn a second probe for damage that no longer exists.
    triggerBackgroundRefreshIfNeeded(cachePath, displayCache, payload, primaryUnloadable && !refreshed, cliVersion, probeRejected);
    stdout(`${renderStatusline(raw, cfg, displayCache)}\n`);
    return 0;
  }

  if (command === "quota") {
    if (args[1] === "refresh") {
      const cachePath = quotaCacheWritePath();
      const lockPath = cachePath + ".lock";
      const flags = refreshFlags(args.slice(2));
      const cliVersion = flags.cliVersion;
      try {
        // Loopback first, as it is cheaper. Only a refusal falls back to /usage, so a CLI whose loopback
        // server is merely not running behaves exactly as before. A version already known to refuse
        // skips straight to /usage; a manual refresh names no version and always tries loopback.
        let result: RefreshResult | null = null;
        if (!authRejectedFor(cachePath, cliVersion)) {
          result = await (deps.refreshQuota ?? refreshQuota)(cachePath);
          recordAuthRejection(cachePath, result, cliVersion);
        }
        // A background refresh needs the CLI version to key the backoff on, and paces /usage itself as
        // well, so a refresh reaching it by any route (the loopback path, a lock takeover) cannot run
        // agy more often than the status line would. A manual refresh is never paced.
        const usageNeeded = result === null || (!result.ok && result.authRejected === true);
        if (usageNeeded && (!flags.background || cliVersion !== "")) {
          const skip = flags.background ? usageSkipReason(cachePath, lockPath, flags.lockToken, new Date()) : null;
          if (skip !== null) {
            result = skip;
          } else {
            const outcome = await (deps.usageQuota ?? (() => queryUsage()))();
            result = outcome.ok ? saveUsageCache(cachePath, outcome.quota) : { ok: false, message: outcome.message };
            recordUsageOutcome(cachePath, cliVersion, result.ok);
          }
        }
        // Loopback is only skipped for a known version, which always reaches /usage above.
        result ??= { ok: false, message: "No quota source was tried." };
        stderr(`[quota_probe] ${result.message}\n`);
        if (result.ok && result.summary) {
          stdout(`${result.summary}\n`);
        }
        return result.ok ? 0 : 2;
      } catch (error) {
        stderr(`[quota_probe] ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      } finally {
        // Only the refresh the lock was taken for may release it. After a stale-lock takeover the lock
        // belongs to a newer refresh, and a manual refresh never holds it at all.
        try {
          if (flags.lockToken !== "" && fs.readFileSync(lockPath, "utf8") === flags.lockToken) {
            fs.unlinkSync(lockPath);
          }
        } catch {
          // ignore
        }
      }
    }
    usage(stderr);
    return 2;
  }

  if (command === "doctor") {
    const rest = args.slice(1);
    const json = rest.length === 1 && rest[0] === "--json";
    if (rest.length > 0 && !json) {
      usage(stderr);
      return 2;
    }
    const report = collectDoctorReport({ ...doctorDepsFromEnv(), ...deps.doctorDeps });
    stdout(json ? `${JSON.stringify(report, null, 2)}\n` : formatDoctorReport(report));
    return 0;
  }

  if (command === "help" || command === "--help" || command === "-h") {
    usage(stderr);
    return 0;
  }

  usage(stderr);
  return 2;
}

function readStdin(stdin: NodeJS.ReadableStream): Promise<string> {
  return new Promise(resolve => {
    let raw = "";
    stdin.setEncoding("utf8");
    stdin.on("data", chunk => {
      raw += chunk;
    });
    stdin.on("end", () => {
      resolve(raw);
    });
  });
}

async function refreshQuotaBeforeRenderIfNeeded(
  cachePath: string,
  cache: Cache | null,
  payload: Payload | null,
  refresh: (cachePath: string) => Promise<RefreshResult>,
  cliVersion: string,
  probeRejected: boolean
): Promise<[Cache | null, boolean]> {
  if (probeRejected || !shouldRefreshBeforeRender(cachePath, payload, new Date())) {
    return [cache, false];
  }
  try {
    const result = await refresh(cachePath);
    recordAuthRejection(cachePath, result, cliVersion);
    if (!result.ok) {
      return [cache, false];
    }
    const [freshCache, ok] = loadQuota(cachePath);
    if (!ok) {
      return [cache, false];
    }
    // No previous state is read here: payload is non-null and activityRefresh is true, so the merge
    // overwrites every field. Reading a companion first would be dead work, and giving it a legacy
    // fallback would only create a way to merge stale fields into a file we are about to overwrite.
    saveStatuslineRefreshState(
      refreshStatePath(cachePath),
      mergeStatuslineRefreshState(null, payload, true, new Date())
    );
    return [freshCache, true];
  } catch {
    return [cache, false];
  }
}

function shouldRefreshBeforeRender(cachePath: string, payload: Payload | null, now: Date): boolean {
  if (cachePath === "" || !payload) {
    return false;
  }
  const prevState = loadRefreshStateWithFallback(quotaCacheReadCandidates());
  const prevAgentState = prevState?.agentState ?? "";
  const agentState = normalizeAgentState(payload.agent_state);
  if (agentState !== "idle" || prevAgentState === "" || prevAgentState === "idle") {
    return false;
  }
  if (prevState?.lastActivityAt) {
    const last = new Date(prevState.lastActivityAt);
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < 5 * 1000) {
      return false;
    }
  }
  return true;
}

function triggerBackgroundRefreshIfNeeded(
  cachePath: string,
  cache: Cache | null,
  payload: Payload | null = null,
  repairRefresh = false,
  cliVersion = "",
  probeRejected = false
): void {
  const now = new Date();
  const statePath = refreshStatePath(cachePath);
  const prevState = loadRefreshStateWithFallback(quotaCacheReadCandidates());
  const activityRefresh = shouldTriggerActivityRefresh(cache, payload, prevState, now);
  const nextState = mergeStatuslineRefreshState(prevState, payload, activityRefresh, now);
  saveStatuslineRefreshState(statePath, nextState);

  const lockPath = cachePath + ".lock";
  const lockToken = randomUUID();
  if (probeRejected) {
    if (usageRefreshDue(cache, payload, prevState, readRejectionMarker(cachePath), now) && takeUsageLock(lockPath, lockToken, now)) {
      spawnQuotaRefresh(cliVersion, lockToken);
    }
    return;
  }
  if (!quotaCacheNeedsRefresh(cache, now) && !activityRefresh && !repairRefresh) {
    return;
  }

  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      const minLockMs = activityRefresh ? 5 * 1000 : 30 * 1000;
      if (now.getTime() - stat.mtimeMs < minLockMs) {
        return;
      }
    }
    fs.writeFileSync(lockPath, lockToken, { encoding: "utf8", mode: 0o600 });
    spawnQuotaRefresh(cliVersion, lockToken);
  } catch {
    // ignore
  }
}

function spawnQuotaRefresh(cliVersion: string, lockToken: string): void {
  try {
    const args = [
      __filename, "quota", "refresh",
      ...(cliVersion ? ["--cli-version", cliVersion] : []),
      "--background", "--lock-token", lockToken
    ];
    const child = spawn(process.argv[0], args, {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // ignore
  }
}

// A /usage run starts a whole agy process for about 7 s, so it is paced more slowly than the loopback
// probe: a 60 s floor while a turn runs or has just settled, 5 minutes while the CLI sits idle, and
// no run at all while a failure backoff is pending.
const usageActiveFloorMs = 60 * 1000;
const usageIdleFloorMs = 5 * 60 * 1000;
// Longer than the slowest refresh: a loopback probe on the first refusal, then the 45 s /usage run.
const usageLockStaleMs = 120 * 1000;

interface RefreshFlags {
  cliVersion: string;
  background: boolean;
  lockToken: string;
}

function refreshFlags(args: string[]): RefreshFlags {
  const flags: RefreshFlags = { cliVersion: "", background: false, lockToken: "" };
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--cli-version") {
      flags.cliVersion = safeCliVersion(args[index + 1]);
      index += 1;
    } else if (args[index] === "--lock-token") {
      const token = args[index + 1] ?? "";
      flags.lockToken = /^[0-9A-Za-z-]{1,64}$/.test(token) ? token : "";
      index += 1;
    } else if (args[index] === "--background") {
      flags.background = true;
    }
  }
  return flags;
}

// The child's own check before it starts agy. It must still own the lock: on the first refusal of a
// version the loopback path's lock is not exclusive, so two children can get here, and only the one
// whose token is in the lock may run /usage. Then a pending backoff, or a /usage cache younger than
// the active floor, also skips it.
function usageSkipReason(cachePath: string, lockPath: string, lockToken: string, now: Date): RefreshResult | null {
  let owner = "";
  try {
    owner = fs.readFileSync(lockPath, "utf8");
  } catch {
    // No lock at all: this refresh does not own one.
  }
  if (lockToken === "" || owner !== lockToken) {
    return { ok: false, message: "Skipped agy /usage: another refresh holds the lock." };
  }
  const retryAt = Date.parse(readRejectionMarker(cachePath)?.usageRetryAt ?? "");
  if (Number.isFinite(retryAt) && retryAt > now.getTime()) {
    return { ok: false, message: "Skipped agy /usage: backing off after a failure." };
  }
  const [cache, ok] = loadQuota(cachePath);
  const cacheTime = Date.parse(cache?.timestamp ?? "");
  if (ok && cache?.source === "usage" && Number.isFinite(cacheTime) && now.getTime() - cacheTime < usageActiveFloorMs) {
    return { ok: true, message: "Skipped agy /usage: the cached quota is fresh." };
  }
  return null;
}

function usageRefreshDue(
  cache: Cache | null,
  payload: Payload | null,
  prevState: StatuslineRefreshState | null,
  marker: RejectionMarker | null,
  now: Date
): boolean {
  const retryAt = Date.parse(marker?.usageRetryAt ?? "");
  if (Number.isFinite(retryAt) && retryAt > now.getTime()) {
    return false;
  }
  const agentState = normalizeAgentState(payload?.agent_state);
  const prevAgentState = prevState?.agentState ?? "";
  const isActive = (value: string) => value !== "" && value !== "idle";
  const active = isActive(agentState) || isActive(prevAgentState);
  const cacheTime = Date.parse(cache?.timestamp ?? "");
  const age = Number.isFinite(cacheTime) ? now.getTime() - cacheTime : Infinity;
  return age > (active ? usageActiveFloorMs : usageIdleFloorMs);
}

// One /usage run at a time across every session. The lock holds the owner's token and is taken with
// an exclusive create. One older than the slowest refresh belongs to a refresh that died; it is moved
// aside under a unique name before retrying, so two status lines racing for it cannot both win.
function takeUsageLock(lockPath: string, token: string, now: Date): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  } catch {
    return false;
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      fs.writeFileSync(lockPath, token, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        return false;
      }
      try {
        if (now.getTime() - fs.statSync(lockPath).mtimeMs <= usageLockStaleMs) {
          return false;
        }
        const aside = `${lockPath}.stale-${token}`;
        fs.renameSync(lockPath, aside);
        fs.rmSync(aside, { force: true });
      } catch (takeoverError) {
        // Someone else moved the stale lock first: try the exclusive create once more.
        if ((takeoverError as NodeJS.ErrnoException).code !== "ENOENT") {
          return false;
        }
      }
    }
  }
  return false;
}

function saveUsageCache(cachePath: string, quota: Record<string, CachedQuotaBucket>): RefreshResult {
  try {
    fs.mkdirSync(path.dirname(cachePath), { recursive: true, mode: 0o700 });
    const cache: Cache = { timestamp: new Date().toISOString(), source: "usage", models: {}, quota };
    fs.writeFileSync(cachePath, `${JSON.stringify(cache, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(cachePath, 0o600);
  } catch (error) {
    return { ok: false, message: `Could not write the quota cache: ${error instanceof Error ? error.message : String(error)}` };
  }
  const summary = Object.entries(quota)
    .map(([key, bucket]) => `${key} ${Math.round((bucket.remaining_fraction ?? 0) * 100)}% left`)
    .join(", ");
  return { ok: true, message: `Cached quota from agy /usage to ${cachePath}`, cachePath, summary };
}

export function quotaCacheNeedsRefresh(cache: Cache | null, now: Date = new Date()): boolean {
  if (!cache || !cache.timestamp) {
    return true;
  }
  try {
    const cacheTime = new Date(cache.timestamp);
    if (Number.isNaN(cacheTime.getTime())) {
      return true;
    }
    const interval = cacheLooksUntouched(cache) ? untouchedQuotaRefreshMs : consumedQuotaRefreshMs;
    if (now.getTime() - cacheTime.getTime() > interval) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}

function parsePayload(input: string): Payload | null {
  try {
    return JSON.parse(input) as Payload;
  } catch {
    return null;
  }
}

// Antigravity CLI 1.2.x answers the loopback probe with 401 and never gives the status line the
// CSRF token it wants, so every probe fails. The rejection is recorded against the CLI version from
// the payload: the HUD stops probing for that version, and an upgrade retries on its own. A payload
// without a version, or one that fails this check, is never treated as rejected.
function safeCliVersion(raw: unknown): string {
  return typeof raw === "string" && /^[0-9A-Za-z][0-9A-Za-z.+-]{0,31}$/.test(raw) ? raw : "";
}

function authRejectedPath(cachePath: string): string {
  return cachePath === "" ? "" : `${cachePath}.auth-rejected.json`;
}

interface RejectionMarker {
  cliVersion: string;
  rejectedAt: string;
  // Consecutive /usage failures and when the next run may start.
  usageFailures?: number;
  usageRetryAt?: string;
}

function readRejectionMarker(cachePath: string): RejectionMarker | null {
  const markerPath = authRejectedPath(cachePath);
  if (markerPath === "") {
    return null;
  }
  try {
    const marker = JSON.parse(fs.readFileSync(markerPath, "utf8")) as Partial<RejectionMarker>;
    if (typeof marker.cliVersion !== "string") {
      return null;
    }
    return {
      cliVersion: marker.cliVersion,
      rejectedAt: typeof marker.rejectedAt === "string" ? marker.rejectedAt : "",
      usageFailures: Number.isInteger(marker.usageFailures) && (marker.usageFailures ?? 0) > 0 ? marker.usageFailures : undefined,
      usageRetryAt: typeof marker.usageRetryAt === "string" ? marker.usageRetryAt : undefined
    };
  } catch {
    return null;
  }
}

function writeRejectionMarker(cachePath: string, marker: RejectionMarker): void {
  const markerPath = authRejectedPath(cachePath);
  fs.mkdirSync(path.dirname(markerPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(markerPath, `${JSON.stringify(marker)}\n`, { encoding: "utf8", mode: 0o600 });
}

function authRejectedFor(cachePath: string, cliVersion: string): boolean {
  return cliVersion !== "" && readRejectionMarker(cachePath)?.cliVersion === cliVersion;
}

function recordAuthRejection(cachePath: string, result: RefreshResult, cliVersion: string): void {
  if (authRejectedPath(cachePath) === "") {
    return;
  }
  try {
    if (result.ok) {
      fs.rmSync(authRejectedPath(cachePath), { force: true });
    } else if (result.authRejected && cliVersion !== "" && !authRejectedFor(cachePath, cliVersion)) {
      writeRejectionMarker(cachePath, { cliVersion, rejectedAt: new Date().toISOString() });
    }
  } catch {
    // Losing the marker only costs another loopback probe; it can never suppress a refresh wrongly.
  }
}

// Backs /usage off after a failure: 60 s, doubling to a 10-minute cap. A success clears it.
function recordUsageOutcome(cachePath: string, cliVersion: string, ok: boolean): void {
  const marker = readRejectionMarker(cachePath);
  if (!marker || cliVersion === "" || marker.cliVersion !== cliVersion) {
    return;
  }
  try {
    if (ok) {
      writeRejectionMarker(cachePath, { cliVersion: marker.cliVersion, rejectedAt: marker.rejectedAt });
      return;
    }
    const failures = (marker.usageFailures ?? 0) + 1;
    const delayMs = Math.min(60 * 1000 * 2 ** (failures - 1), 10 * 60 * 1000);
    writeRejectionMarker(cachePath, { ...marker, usageFailures: failures, usageRetryAt: new Date(Date.now() + delayMs).toISOString() });
  } catch {
    // Losing the backoff only costs an earlier retry.
  }
}

function refreshStatePath(cachePath: string): string {
  if (cachePath === "") {
    return "";
  }
  return `${cachePath}.statusline.json`;
}

// Falls back to a legacy companion only when the primary companion is ABSENT. A primary that exists
// but fails to parse must read as null, exactly as it does today: falling back there would
// resurrect a stale agentState, and a stale "working" against an idle payload fires an unlocked
// same-frame refresh. Concurrent renders hitting a mid-write primary would each launch a probe.
function loadRefreshStateWithFallback(candidates: string[]): StatuslineRefreshState | null {
  for (const candidate of candidates) {
    const statePath = refreshStatePath(candidate);
    if (statePath === "") {
      continue;
    }
    if (fs.existsSync(statePath)) {
      return loadStatuslineRefreshState(statePath);
    }
  }
  return null;
}

function loadStatuslineRefreshState(statePath: string): StatuslineRefreshState | null {
  if (statePath === "") {
    return null;
  }
  try {
    const raw = fs.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<StatuslineRefreshState>;
    return {
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : "",
      agentState: typeof parsed.agentState === "string" ? parsed.agentState : "",
      lastActivityAt: typeof parsed.lastActivityAt === "string" ? parsed.lastActivityAt : undefined
    };
  } catch {
    return null;
  }
}

function saveStatuslineRefreshState(statePath: string, state: StatuslineRefreshState): void {
  if (statePath === "") {
    return;
  }
  try {
    // The cache dir holds quota data and this file records the conversation id and agent state, so
    // keep both private rather than leaving them world-readable under the default umask.
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  } catch {
    // ignore
  }
}

function mergeStatuslineRefreshState(
  prevState: StatuslineRefreshState | null,
  payload: Payload | null,
  activityRefresh: boolean,
  now: Date
): StatuslineRefreshState {
  const next: StatuslineRefreshState = {
    conversationId: prevState?.conversationId ?? "",
    agentState: prevState?.agentState ?? "",
    lastActivityAt: prevState?.lastActivityAt
  };
  if (payload) {
    next.conversationId = (payload.conversation_id ?? "").trim();
    next.agentState = normalizeAgentState(payload.agent_state);
  }
  if (activityRefresh) {
    next.lastActivityAt = now.toISOString();
  }
  return next;
}

function shouldTriggerActivityRefresh(
  cache: Cache | null,
  payload: Payload | null,
  prevState: StatuslineRefreshState | null,
  now: Date
): boolean {
  if (!payload) {
    return false;
  }

  const conversationId = (payload.conversation_id ?? "").trim();
  const agentState = normalizeAgentState(payload.agent_state);
  const prevConversationId = prevState?.conversationId ?? "";
  const prevAgentState = prevState?.agentState ?? "";
  const conversationChanged = conversationId !== "" && conversationId !== prevConversationId;
  const becameActive = agentState !== "" && agentState !== "idle" && agentState !== prevAgentState;
  const settledAfterActive = agentState === "idle" && prevAgentState !== "" && prevAgentState !== "idle";

  if (settledAfterActive) {
    return true;
  }

  if (!cacheLooksUntouched(cache) && !activeModelQuotaLooksUntouched(cache, payload)) {
    return false;
  }

  if (!conversationChanged && !becameActive && !settledAfterActive) {
    return false;
  }

  if (prevState?.lastActivityAt) {
    const last = new Date(prevState.lastActivityAt);
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < 5 * 1000) {
      return false;
    }
  }
  return true;
}

function activeModelQuotaLooksUntouched(cache: Cache | null, payload: Payload): boolean {
  if (!cache) {
    return false;
  }
  const model = payload.model?.display_name || payload.model?.id || "";
  if (model === "") {
    return false;
  }
  const [quota, ok] = matchModel(cache, model);
  if (!ok || quota === null) {
    return true;
  }
  return quota.remainingFraction >= 1.0;
}

function normalizeAgentState(raw: string | undefined): string {
  return (raw ?? "").trim().toLowerCase();
}

function cacheLooksUntouched(cache: Cache | null): boolean {
  if (!cache || !cache.models) {
    return false;
  }
  const quotas = Object.values(cache.models);
  if (quotas.length === 0) {
    return true;
  }
  for (const quota of quotas) {
    if (quota.remainingFraction < 1.0) {
      return false;
    }
  }
  return true;
}

if (require.main === module) {
  runCli(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  });
}
