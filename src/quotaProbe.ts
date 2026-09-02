import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import { execFileSync } from "node:child_process";

export interface LanguageServerInfo {
  pid: string;
  csrfToken: string;
  kind?: string;
}

export interface ProbeRuntime {
  ps(): string;
  lsof(pid: string): string;
  request(port: number, csrfToken: string): Promise<unknown | null>;
  now(): Date;
  writeFile(filePath: string, data: string): void;
  mkdir(dirPath: string): void;
  readFile?(filePath: string): string;
  processIdentity?(pid: string): string | null;
}

interface ServerHint {
  pid: string;
  port: number;
  identity: string;
  discoveredAt: string;
}

export interface RefreshResult {
  ok: boolean;
  message: string;
  cachePath?: string;
  summary?: string;
}

export function parseLanguageServerInfo(psOutput: string): LanguageServerInfo | null {
  for (const line of psOutput.split(/\r?\n/)) {
    if (!line.includes("language_server") || !line.includes("--csrf_token")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parts[1] : "";
    const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9-]+)/);
    if (pid !== "" && /^\d+$/.test(pid) && tokenMatch) {
      return { pid, csrfToken: tokenMatch[1] };
    }
  }
  return null;
}

export function parseAgyServerInfos(psOutput: string): LanguageServerInfo[] {
  const infos: LanguageServerInfo[] = [];
  for (const line of psOutput.split(/\r?\n/)) {
    if (!/(^|\s)(?:\/\S+\/)?agy(\s|$)/.test(line)) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parts[1] : "";
    if (pid !== "" && /^\d+$/.test(pid)) {
      infos.push({ pid, csrfToken: "", kind: "agy" });
    }
  }
  return infos;
}

export function parseListeningPorts(lsofOutput: string): number[] {
  const ports = new Set<number>();
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) {
      continue;
    }
    const match = line.match(/(?:127\.0\.0\.1|localhost|\*|\[::1\]):(\d+)\b/);
    if (match) {
      ports.add(Number(match[1]));
    }
  }
  return [...ports];
}

export function buildQuotaCache(rawResponse: unknown, now: Date): { cache: unknown; summary: string } | null {
  if (!isRecord(rawResponse)) {
    return null;
  }
  const userStatus = asRecord(rawResponse.userStatus);
  const email = typeof userStatus.email === "string" ? maskEmail(userStatus.email) : "masked@email.com";
  const planStatus = asRecord(userStatus.planStatus);
  const planInfo = asRecord(planStatus.planInfo);
  const planName = typeof planInfo.planName === "string" ? planInfo.planName : "Free";
  const cascade = asRecord(userStatus.cascadeModelConfigData);
  const configs = Array.isArray(cascade.clientModelConfigs) ? cascade.clientModelConfigs : [];
  const models: Record<string, { remainingFraction: number; resetTime: string }> = {};

  for (const item of configs) {
    const model = asRecord(item);
    const label = typeof model.label === "string" ? model.label : "";
    const quotaInfo = asRecord(model.quotaInfo);
    if (label === "" || Object.keys(quotaInfo).length === 0) {
      continue;
    }
    const resetTime = typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : "";
    const remainingFraction = typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : resetTime === "" ? 1.0 : 0.0;
    models[label] = { remainingFraction, resetTime };
  }
  if (Object.keys(models).length === 0) {
    return null;
  }

  const cache = {
    timestamp: now.toISOString().replace(".000Z", "Z"),
    email,
    plan_name: planName,
    models
  };
  const lines = ["=== QUOTA SUMMARY ===", `Plan: ${planName}`, `Cache Timestamp: ${cache.timestamp}`];
  for (const [model, quota] of Object.entries(models)) {
    const usedPct = Math.trunc((1 - quota.remainingFraction) * 100 + 0.5);
    let line = `- ${model.padEnd(30, " ")} : Usage ${String(usedPct).padStart(3, " ")}%`;
    if (usedPct > 0 && quota.resetTime !== "") {
      line += ` | Reset ${quota.resetTime}`;
    }
    lines.push(line);
  }
  lines.push("=====================");
  return { cache, summary: lines.join("\n") };
}

export async function refreshQuota(cachePath: string, runtime: ProbeRuntime = defaultRuntime()): Promise<RefreshResult> {
  const hint = loadServerHint(cachePath, runtime);
  if (hint) {
    const raw = await tryRequest(runtime, hint.port, "");
    const built = buildQuotaCache(raw, runtime.now());
    if (built) return saveQuotaCache(cachePath, built, runtime);
    // This is a disposable discovery hint, never quota or credentials. A concurrent replacement
    // lost here only costs another discovery; it cannot suppress or corrupt the quota refresh.
    saveServerHint(cachePath, null, runtime);
  }
  const psOutput = runtime.ps();
  const languageServer = parseLanguageServerInfo(psOutput);
  const candidates = [...parseAgyServerInfos(psOutput), ...(languageServer ? [languageServer] : [])];
  if (candidates.length === 0) {
    return { ok: false, message: "No running language_server or agy quota server found." };
  }

  let sawPort = false;
  let sawResponse = false;
  for (const info of candidates) {
    // Identity is required only for hint reuse. If targeted inspection fails, full discovery
    // must remain available; the optional optimization must never disable quota refreshes.
    const identity = info.kind === "agy" ? processIdentity(runtime, info.pid) : null;
    let ports: number[];
    try {
      ports = parseListeningPorts(runtime.lsof(info.pid));
    } catch {
      continue;
    }
    if (ports.length > 0) {
      sawPort = true;
    }
    for (const port of ports) {
      const rawResponse = await tryRequest(runtime, port, info.csrfToken);
      if (rawResponse) sawResponse = true;
      const built = buildQuotaCache(rawResponse, runtime.now());
      if (built) {
        const result = saveQuotaCache(cachePath, built, runtime);
        if (identity) {
          saveServerHint(cachePath, { pid: info.pid, port, identity, discoveredAt: runtime.now().toISOString() }, runtime);
        }
        return result;
      }
    }
  }
  if (!sawPort) {
    return { ok: false, message: "No listening ports found on quota server." };
  }
  if (!sawResponse) {
    return { ok: false, message: "Failed to query GetUserStatus from all identified ports." };
  }
  return { ok: false, message: "GetUserStatus returned malformed quota data." };
}

function saveQuotaCache(cachePath: string, built: NonNullable<ReturnType<typeof buildQuotaCache>>, runtime: ProbeRuntime): RefreshResult {
  runtime.mkdir(path.dirname(cachePath));
  runtime.writeFile(cachePath, `${JSON.stringify(built.cache, null, 2)}\n`);
  return {
    ok: true,
    message: `Successfully cached processed quota data to ${cachePath}`,
    cachePath,
    summary: built.summary
  };
}

function loadServerHint(cachePath: string, runtime: ProbeRuntime): ServerHint | null {
  try {
    const raw = runtime.readFile?.(`${cachePath}.server.json`);
    if (!raw || raw.length > 4096) return null;
    const hint = JSON.parse(raw) as ServerHint | null;
    if (!hint || typeof hint.pid !== "string" || !/^[1-9]\d{0,9}$/.test(hint.pid) || Number(hint.pid) > 2147483647 ||
      !Number.isInteger(hint.port) || hint.port < 1 || hint.port > 65535 ||
      typeof hint.identity !== "string" || hint.identity === "" || typeof hint.discoveredAt !== "string") return null;
    const age = runtime.now().getTime() - Date.parse(hint.discoveredAt);
    if (!Number.isFinite(age) || age < 0 || age >= 5 * 60 * 1000) return null;
    return processIdentity(runtime, hint.pid) === hint.identity ? hint : null;
  } catch {
    return null;
  }
}

function processIdentity(runtime: ProbeRuntime, pid: string): string | null {
  try {
    return runtime.processIdentity?.(pid) || null;
  } catch {
    return null;
  }
}

function saveServerHint(cachePath: string, hint: ServerHint | null, runtime: ProbeRuntime): void {
  try {
    runtime.writeFile(`${cachePath}.server.json`, `${JSON.stringify(hint)}\n`);
  } catch {
    // A missing, truncated or unwritable hint only disables this optimization.
  }
}

async function tryRequest(runtime: ProbeRuntime, port: number, csrfToken: string): Promise<unknown | null> {
  try {
    return await runtime.request(port, csrfToken);
  } catch {
    return null;
  }
}

function defaultRuntime(): ProbeRuntime {
  return {
    ps: () => execFileSync("ps", ["aux"], { encoding: "utf8" }),
    lsof: (pid: string) => execFileSync("lsof", ["-nP", "-iTCP", "-a", "-p", pid], { encoding: "utf8" }),
    request: queryLanguageServer,
    now: () => new Date(),
    readFile: filePath => fs.readFileSync(filePath, "utf8"),
    processIdentity: pid => {
      const identity = execFileSync("ps", ["-p", pid, "-o", "lstart=", "-o", "comm="], {
        encoding: "utf8", timeout: 1000, env: { ...process.env, LC_ALL: "C" }
      }).trim();
      const match = identity.match(/^\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}\s+(.+)$/);
      return match && path.basename(match[1]) === "agy" ? identity : null;
    },
    // The cache carries a masked email, plan name, and per-model quota, so keep it private instead
    // of leaving it world-readable under the default umask.
    writeFile: (filePath: string, data: string) =>
      fs.writeFileSync(filePath, data, { encoding: "utf8", mode: 0o600 }),
    mkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 })
  };
}

async function queryLanguageServer(port: number, csrfToken: string): Promise<unknown | null> {
  const endpoint = `/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1"
  };
  if (csrfToken !== "") {
    headers["X-Codeium-Csrf-Token"] = csrfToken;
  }
  const httpsResult = await requestJson(https, {
    protocol: "https:",
    hostname: "127.0.0.1",
    port,
    path: endpoint,
    method: "POST",
    headers,
    rejectUnauthorized: false
  });
  if (httpsResult !== null) {
    return httpsResult;
  }
  return requestJson(http, {
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
    path: endpoint,
    method: "POST",
    headers
  });
}

function requestJson(
  mod: typeof http | typeof https,
  options: http.RequestOptions & { rejectUnauthorized?: boolean }
): Promise<unknown | null> {
  return new Promise(resolve => {
    const req = mod.request(options, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(5000, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write("{}");
    req.end();
  });
}

function maskEmail(email: string): string {
  const at = email.indexOf("@");
  if (at < 0) {
    return "masked@email.com";
  }
  return `${email.slice(0, 3)}***${email.slice(at)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}
