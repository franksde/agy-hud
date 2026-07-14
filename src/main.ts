import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { defaultConfig, loadFromPaths, Config } from "./config";
import { Cache, load as loadQuota, matchModel } from "./quota";
import { RefreshResult, refreshQuota } from "./quotaProbe";
import { branch as gitBranch } from "./gitinfo";
import { Payload, render } from "./statusline";

export const version = "0.1.8";

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
  const dir = path.dirname(__filename);
  paths.push(path.join(dir, "config.json"));
  paths.push(path.join(dir, "..", "config.json"));
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
}

function usage(write: WriteFn): void {
  write("usage: agy-hud [statusline|quota refresh|version]\n");
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
    const [displayCache, refreshed] = await refreshQuotaBeforeRenderIfNeeded(
      cachePath,
      ok ? cache : null,
      payload,
      deps.refreshQuota ?? refreshQuota
    );
    // A same-frame refresh already rewrote the write path, so a corrupt primary is repaired by now.
    // Passing the stale flag on would spawn a second probe for damage that no longer exists.
    triggerBackgroundRefreshIfNeeded(cachePath, displayCache, payload, primaryUnloadable && !refreshed);
    stdout(`${renderStatusline(raw, cfg, displayCache)}\n`);
    return 0;
  }

  if (command === "quota") {
    if (args[1] === "refresh") {
      const lockPath = quotaCacheWritePath() + ".lock";
      try {
        const result = await (deps.refreshQuota ?? refreshQuota)(quotaCacheWritePath());
        stderr(`[quota_probe] ${result.message}\n`);
        if (result.ok && result.summary) {
          stdout(`${result.summary}\n`);
        }
        return result.ok ? 0 : 2;
      } catch (error) {
        stderr(`[quota_probe] ${error instanceof Error ? error.message : String(error)}\n`);
        return 2;
      } finally {
        try {
          if (fs.existsSync(lockPath)) {
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
  refresh: (cachePath: string) => Promise<RefreshResult>
): Promise<[Cache | null, boolean]> {
  if (!shouldRefreshBeforeRender(cachePath, payload, new Date())) {
    return [cache, false];
  }
  try {
    const result = await refresh(cachePath);
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
  repairRefresh = false
): void {
  const now = new Date();
  const statePath = refreshStatePath(cachePath);
  const prevState = loadRefreshStateWithFallback(quotaCacheReadCandidates());
  const activityRefresh = shouldTriggerActivityRefresh(cache, payload, prevState, now);
  const nextState = mergeStatuslineRefreshState(prevState, payload, activityRefresh, now);
  saveStatuslineRefreshState(statePath, nextState);

  if (!quotaCacheNeedsRefresh(cache, now) && !activityRefresh && !repairRefresh) {
    return;
  }

  const lockPath = cachePath + ".lock";
  try {
    if (fs.existsSync(lockPath)) {
      const stat = fs.statSync(lockPath);
      const minLockMs = activityRefresh ? 5 * 1000 : 30 * 1000;
      if (now.getTime() - stat.mtimeMs < minLockMs) {
        return;
      }
    }
    fs.writeFileSync(lockPath, new Date().toISOString(), "utf8");

    const nodePath = process.argv[0];
    const child = spawn(nodePath, [__filename, "quota", "refresh"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
    // ignore
  }
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
