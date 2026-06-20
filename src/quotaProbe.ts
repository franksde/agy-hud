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
  const psOutput = runtime.ps();
  const languageServer = parseLanguageServerInfo(psOutput);
  const candidates = languageServer ? [languageServer] : parseAgyServerInfos(psOutput);
  if (candidates.length === 0) {
    return { ok: false, message: "No running language_server or agy quota server found." };
  }

  let rawResponse: unknown | null = null;
  let sawPort = false;
  for (const info of candidates) {
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
      rawResponse = await runtime.request(port, info.csrfToken);
      if (rawResponse) {
        break;
      }
    }
    if (rawResponse) {
      break;
    }
  }
  if (!sawPort) {
    return { ok: false, message: "No listening ports found on quota server." };
  }
  if (!rawResponse) {
    return { ok: false, message: "Failed to query GetUserStatus from all identified ports." };
  }
  const built = buildQuotaCache(rawResponse, runtime.now());
  if (!built) {
    return { ok: false, message: "GetUserStatus returned malformed quota data." };
  }
  runtime.mkdir(path.dirname(cachePath));
  runtime.writeFile(cachePath, `${JSON.stringify(built.cache, null, 2)}\n`);
  return {
    ok: true,
    message: `Successfully cached processed quota data to ${cachePath}`,
    cachePath,
    summary: built.summary
  };
}

function defaultRuntime(): ProbeRuntime {
  return {
    ps: () => execFileSync("ps", ["aux"], { encoding: "utf8" }),
    lsof: (pid: string) => execFileSync("lsof", ["-nP", "-iTCP", "-a", "-p", pid], { encoding: "utf8" }),
    request: queryLanguageServer,
    now: () => new Date(),
    writeFile: (filePath: string, data: string) => fs.writeFileSync(filePath, data, "utf8"),
    mkdir: (dirPath: string) => fs.mkdirSync(dirPath, { recursive: true })
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
