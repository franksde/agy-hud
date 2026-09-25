import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { CachedQuotaBucket } from "./quota";

// Antigravity CLI 1.2.2+ refuses the loopback probe for want of a CSRF token it never gives the
// status line. `/usage` in print mode is the official read-only route: it starts no agent turn and
// spends no quota (CLI 1.1.12 changelog; measured num_turns 0, total_tokens 0). It does start a whole
// agy process, about 7 s mostly spent waiting on Google's API, so it only ever runs in the background.
export const usageArgs = ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"];

export interface UsageRunResult {
  code: number | null;
  stdout: string;
  timedOut: boolean;
  error?: string;
}

export type UsageRunner = (args: string[], env: NodeJS.ProcessEnv) => Promise<UsageRunResult>;

export type UsageOutcome =
  | { ok: true; quota: Record<string, CachedQuotaBucket> }
  | { ok: false; message: string };

export async function queryUsage(runner: UsageRunner = runAgy): Promise<UsageOutcome> {
  // agy runs the status-line command in print mode as well, so the child would otherwise render
  // agy-hud, which could start another refresh. The marker makes that nested render inert.
  const result = await runner(usageArgs, { ...process.env, AGY_HUD_NESTED: "1" });
  // CLI error text can carry account URLs, so failures are described, never echoed.
  if (result.error !== undefined) {
    return { ok: false, message: "agy /usage failed: could not start agy." };
  }
  if (result.timedOut) {
    return { ok: false, message: "agy /usage failed: timed out." };
  }
  if (result.code !== 0) {
    return { ok: false, message: `agy /usage failed: exit ${result.code ?? "signal"}.` };
  }
  const quota = parseUsageOutput(result.stdout);
  if (quota === null) {
    return { ok: false, message: "agy /usage failed: unreadable output." };
  }
  return { ok: true, quota };
}

export function parseUsageOutput(stdout: string): Record<string, CachedQuotaBucket> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return null;
  }
  const groups = record(record(record(parsed).command).data).groups;
  if (!Array.isArray(groups)) {
    return null;
  }
  const quota: Record<string, CachedQuotaBucket> = {};
  for (const group of groups) {
    const buckets = record(group).buckets;
    if (!Array.isArray(buckets)) continue;
    for (const raw of buckets) {
      const bucket = record(raw);
      const id = bucket.id;
      const fraction = bucket.remaining_fraction;
      const reset = bucket.reset_time;
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(id)) continue;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      if (typeof reset !== "string" || !Number.isFinite(Date.parse(reset))) continue;
      quota[id] = { remaining_fraction: fraction, reset_time: reset };
    }
  }
  return Object.keys(quota).length > 0 ? quota : null;
}

export interface RunAgyOptions {
  command?: string;
  timeoutMs?: number;
  maxBytes?: number;
}

// Runs agy from a fresh private directory, so no workspace rules or customizations load, and removes
// the directory afterwards. The output is capped and the run is killed at the timeout.
export function runAgy(args: string[], env: NodeJS.ProcessEnv, options: RunAgyOptions = {}): Promise<UsageRunResult> {
  const { command = "agy", timeoutMs = 45 * 1000, maxBytes = 1024 * 1024 } = options;
  return new Promise(resolve => {
    let scratch: string;
    try {
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-usage-"));
    } catch (error) {
      resolve({ code: null, stdout: "", timedOut: false, error: String(error) });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    let settled = false;
    const finish = (result: UsageRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // A leftover empty temp directory is harmless.
      }
      resolve(result);
    };
    // Its own process group, so a kill also reaches anything agy started, which would otherwise hold
    // the output pipe open past the timeout.
    const child = spawn(command, args, { cwd: scratch, env, stdio: ["ignore", "pipe", "ignore"], detached: true });
    const killGroup = () => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      if (size + chunk.length > maxBytes) {
        chunks.push(chunk.subarray(0, maxBytes - size));
        size = maxBytes;
        killGroup();
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.on("error", error => finish({ code: null, stdout: "", timedOut: false, error: String(error) }));
    child.on("close", code => finish({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut }));
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
