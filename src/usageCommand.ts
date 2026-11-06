import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ChildProcess, spawn, spawnSync } from "node:child_process";
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
      if (typeof id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(id)) continue;
      if (typeof fraction !== "number" || !Number.isFinite(fraction) || fraction < 0 || fraction > 1) continue;
      if (typeof reset !== "string" || !Number.isFinite(Date.parse(reset))) continue;
      quota[id] = { remaining_fraction: fraction, reset_time: reset };
    }
  }
  return Object.keys(quota).length > 0 ? quota : null;
}

const scratchPrefix = "agy-hud-usage-";
// Far longer than a run, which the timeout caps at 45 s by default.
const staleScratchMs = 60 * 60 * 1000;

export interface RunAgyOptions {
  command?: string;
  timeoutMs?: number;
  maxBytes?: number;
  platform?: string;
}

// Runs agy from a fresh private directory, so no workspace rules or customizations load, and removes
// the directory afterwards. The output is capped and the run is killed at the timeout. A helper agy
// leaves running can keep that directory busy on Windows, so each run first sweeps away stale ones.
export function runAgy(args: string[], env: NodeJS.ProcessEnv, options: RunAgyOptions = {}): Promise<UsageRunResult> {
  const { command = "agy", timeoutMs = 45 * 1000, maxBytes = 1024 * 1024, platform = process.platform } = options;
  return new Promise(resolve => {
    let scratch: string;
    try {
      sweepStaleScratch(os.tmpdir());
      scratch = fs.mkdtempSync(path.join(os.tmpdir(), scratchPrefix));
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
      // Let go of the pipe, so a helper still holding it cannot keep this process alive.
      child.stdout.destroy();
      try {
        fs.rmSync(scratch, { recursive: true, force: true });
      } catch {
        // A leftover empty temp directory is harmless.
      }
      resolve(result);
    };
    // Off Windows, its own process group, so a kill also reaches anything agy started, which would
    // otherwise hold the output pipe open past the timeout. On Windows, detached means DETACHED_PROCESS:
    // agy gets no console, the CREATE_NO_WINDOW that windowsHide adds is ignored alongside it, and an
    // ordinary console program agy starts (cmd.exe, an MCP server) opens a visible window of its own
    // (issue #19). Not detached, agy gets a console with no window, which such programs inherit. One
    // that asks for a new console of its own still gets a window; nothing set here can prevent that.
    const detached = platform !== "win32";
    const child = spawn(command, args, { cwd: scratch, env, stdio: ["ignore", "pipe", "ignore"], detached, windowsHide: true });
    let treeKillStarted = false;
    const killGroup = () => {
      if (platform === "win32") {
        // Once is enough, and every chunk past the output cap would otherwise start another taskkill.
        if (treeKillStarted) return;
        treeKillStarted = true;
        killWindowsTree(child);
        return;
      }
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
    // A helper that agy leaves behind can hold the output pipe open after agy itself has exited, which
    // would hold "close" back until the timeout. Give the pipe a moment to drain, then end the run.
    child.on("exit", code => {
      setTimeout(() => {
        if (settled) return;
        killGroup();
        finish({ code, stdout: Buffer.concat(chunks).toString("utf8"), timedOut });
      }, 500).unref();
    });
  });
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

// Windows has no process group to signal. taskkill /T ends agy and everything it started, such as an
// MCP server that would otherwise outlive the refresh. It targets a pid, which is only safe while that
// pid is still agy's:
// - It runs synchronously. Until it returns, Node cannot handle agy's exit, so agy's process handle
//   stays open, and Windows reuses no pid while a handle to its process is open. This blocks the
//   refresh, which runs in the background; a taskkill still running at its timeout is terminated.
// - Once Node has seen agy exit, it runs no more: the handle is closed and the pid may belong to
//   another process. agy's leftovers cannot be found by it then anyway; finish() letting go of the
//   pipe is what keeps them from holding the refresh open.
// taskkill is named by full path because Windows looks up a bare name in the current directory first.
// If it cannot run or fails, agy alone is killed.
function killWindowsTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  // An empty value counts as missing, or the path would turn relative and resolve in the workspace.
  const systemRoot = process.env.SystemRoot || process.env.windir || "C:\\Windows";
  const taskkill = path.win32.join(systemRoot, "System32", "taskkill.exe");
  let ended = false;
  try {
    const result = spawnSync(taskkill, ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore", windowsHide: true, timeout: 5000 });
    ended = result.error === undefined && result.status === 0;
  } catch {
    // Thrown rather than reported, for example when Node's permission model forbids child processes.
  }
  if (!ended) child.kill("SIGKILL");
}

// Removes agy-hud-usage-* directories under `root` last modified over an hour ago. Best effort: one
// still busy, or not ours to remove, is left for a later run.
export function sweepStaleScratch(root: string, now: number = Date.now()): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.startsWith(scratchPrefix)) continue;
    const dir = path.join(root, name);
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || now - stat.mtimeMs < staleScratchMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Try again on a later run.
    }
  }
}
