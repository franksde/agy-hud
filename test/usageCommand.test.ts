import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import childProcess from "node:child_process";
import { parseUsageOutput, queryUsage, runAgy, sweepStaleScratch, usageArgs } from "../src/usageCommand";
import { writeFakeExecutable } from "./fakeExecutable";
import { captureSpawn } from "./spawnCapture";

// Shape of `agy -p /usage --output-format json` on Antigravity CLI 1.2.11, identity fields omitted.
function usageJson(buckets: unknown[] = [
  { id: "gemini-weekly", window: "weekly", remaining_fraction: 0.8614671230316162, reset_time: "2026-09-30T06:16:21Z" },
  { id: "gemini-5h", window: "5h", remaining_fraction: 0.9178674817085266, reset_time: "2026-09-25T14:51:03Z" }
]): string {
  return JSON.stringify({
    conversation_id: "", status: "SUCCESS", response: "", duration_seconds: 0, num_turns: 0,
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    command: { name: "usage", data: { groups: [
      { name: "Gemini Models", buckets },
      { name: "Claude and GPT models", buckets: [{ id: "3p-5h", window: "5h", remaining_fraction: 1, reset_time: "2026-09-25T18:52:41Z" }] }
    ] } }
  });
}

test("parses /usage buckets into the payload's bucket shape", () => {
  assert.deepEqual(parseUsageOutput(usageJson()), {
    "gemini-weekly": { remaining_fraction: 0.8614671230316162, reset_time: "2026-09-30T06:16:21Z" },
    "gemini-5h": { remaining_fraction: 0.9178674817085266, reset_time: "2026-09-25T14:51:03Z" },
    "3p-5h": { remaining_fraction: 1, reset_time: "2026-09-25T18:52:41Z" }
  });
});

test("skips malformed buckets and rejects output with none left", () => {
  const parsed = parseUsageOutput(usageJson([
    { id: "gemini-5h", remaining_fraction: 1.5, reset_time: "2026-09-25T14:51:03Z" },
    { id: "Bad Id!", remaining_fraction: 0.5, reset_time: "2026-09-25T14:51:03Z" },
    { id: "gemini-weekly", remaining_fraction: 0.5, reset_time: "not a time" },
    { id: "gemini-ok", remaining_fraction: 0.5, reset_time: "2026-09-25T14:51:03Z" }
  ]));
  assert.deepEqual(Object.keys(parsed ?? {}).sort(), ["3p-5h", "gemini-ok"]);
  for (const bad of ["", "not json", "{}", JSON.stringify({ status: "ERROR", error: "failed to get profile picture" }),
    JSON.stringify({ command: { data: { groups: [{ buckets: [] }] } } })]) {
    assert.equal(parseUsageOutput(bad), null, bad);
  }
});

test("queryUsage reports each failure without echoing CLI output", async () => {
  const cases = [
    { result: { code: 0, stdout: usageJson(), timedOut: false }, ok: true },
    { result: { code: 1, stdout: JSON.stringify({ status: "ERROR", error: "Get \"https://lh3.example/a/secret\": EOF" }), timedOut: false }, message: /exit 1/ },
    { result: { code: null, stdout: "", timedOut: true }, message: /timed out/ },
    { result: { code: null, stdout: "", timedOut: false, error: "spawn agy ENOENT" }, message: /could not start agy/ },
    { result: { code: 0, stdout: "garbage", timedOut: false }, message: /unreadable/ }
  ];
  for (const item of cases) {
    const outcome = await queryUsage(async () => item.result);
    assert.equal(outcome.ok, item.ok ?? false);
    if (!outcome.ok) {
      assert.match(outcome.message, item.message!);
      assert.doesNotMatch(outcome.message, /secret|lh3/);
    }
  }
});

test("queryUsage runs agy with the /usage arguments and marks the child as nested", async () => {
  let seen: { args: string[]; env: NodeJS.ProcessEnv } | null = null;
  await queryUsage(async (args, env) => {
    seen = { args, env };
    return { code: 0, stdout: usageJson(), timedOut: false };
  });
  assert.deepEqual(seen!.args, usageArgs);
  assert.deepEqual(usageArgs, ["-p", "/usage", "--output-format", "json", "--print-timeout", "30s"]);
  assert.equal(seen!.env.AGY_HUD_NESTED, "1");
});

function fakeAgy(body: string): { command: string; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-fake-"));
  return { command: writeFakeExecutable(dir, "agy", body), dir };
}

test("runAgy runs in a private scratch directory that it removes afterwards", async () => {
  const { command, dir } = fakeAgy(`pwd > "${"$"}REPORT"; { stat -c %a . 2>/dev/null || stat -f %Lp .; } >> "${"$"}REPORT"; echo "${"$"}AGY_HUD_NESTED $*" >> "${"$"}REPORT"; echo '{"ok":1}'`);
  const report = path.join(dir, "report.txt");
  const result = await runAgy(["-p", "/usage"], { ...process.env, AGY_HUD_NESTED: "1", REPORT: report }, { command });
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), '{"ok":1}');
  const [cwd, mode, line] = fs.readFileSync(report, "utf8").trim().split("\n");
  assert.equal(mode, "700");
  assert.equal(line, "1 -p /usage");
  assert.equal(fs.existsSync(cwd), false, "the scratch directory must be removed");
});

test("runAgy kills a run that exceeds the timeout", async () => {
  const { command } = fakeAgy("sleep 5");
  const started = Date.now();
  const result = await runAgy([], process.env, { command, timeoutMs: 200 });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3000);
});

test("runAgy stops reading output past the size cap", async () => {
  const { command } = fakeAgy("head -c 200000 /dev/zero | tr '\\0' x; sleep 5");
  const result = await runAgy([], process.env, { command, maxBytes: 1024, timeoutMs: 4000 });
  assert.ok(result.stdout.length <= 1024);
  assert.equal(result.timedOut, false);
  assert.notEqual(result.code, 0);
});

test("runAgy reports a missing binary instead of throwing", async () => {
  const result = await runAgy([], process.env, { command: "/definitely/not/agy" });
  assert.equal(result.code, null);
  assert.match(result.error ?? "", /ENOENT/);
});

test("runAgy finishes when agy exits even if a leftover child still holds the output pipe", async () => {
  const { command } = fakeAgy("(sleep 5 &); echo '{\"ok\":1}'");
  const started = Date.now();
  const result = await runAgy([], process.env, { command, timeoutMs: 4000 });
  assert.equal(result.code, 0);
  assert.equal(result.timedOut, false);
  assert.equal(result.stdout.trim(), '{"ok":1}');
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
});

test("bucket ids may contain underscores", () => {
  const parsed = parseUsageOutput(usageJson([{ id: "3p_weekly", remaining_fraction: 0.5, reset_time: "2026-09-25T14:51:03Z" }]));
  assert.equal(parsed?.["3p_weekly"]?.remaining_fraction, 0.5);
});

test("runAgy sends no signal after a run has settled", async () => {
  const { command } = fakeAgy("echo '{\"ok\":1}'");
  const killed: Array<number | string> = [];
  const originalKill = process.kill;
  process.kill = ((pid: number, signal?: string | number) => {
    killed.push(pid);
    return originalKill.call(process, pid, signal as NodeJS.Signals);
  }) as typeof process.kill;
  try {
    const result = await runAgy([], process.env, { command });
    assert.equal(result.code, 0);
    await new Promise(resolve => setTimeout(resolve, 800));
  } finally {
    process.kill = originalKill;
  }
  assert.deepEqual(killed, [], "a clean run must not be followed by a group kill");
});

// On Windows, detached means DETACHED_PROCESS, and CREATE_NO_WINDOW, which windowsHide adds when no
// stdio is inherited, is ignored alongside it. agy then has no console, and an ordinary console program
// it starts (cmd.exe, an MCP server) opens a visible one of its own (issue #19). Off Windows, detached
// puts agy in its own process group, which the timeout kill relies on. A Windows console cannot be
// observed from here, so the test pins the spawn options, stdio included: an inherited stream would
// drop CREATE_NO_WINDOW.
async function spawnOptionsOn(t: TestContext, platform: NodeJS.Platform): Promise<childProcess.SpawnOptions> {
  const calls = captureSpawn(t);
  const { command } = fakeAgy("echo ok");
  await runAgy([], process.env, { command, platform });
  assert.equal(calls.length, 1);
  return calls[0].options;
}

test("runAgy does not detach agy on Windows, so the consoles agy opens stay hidden", async t => {
  const options = await spawnOptionsOn(t, "win32");
  assert.equal(options.detached, false);
  assert.equal(options.windowsHide, true);
  assert.deepEqual(options.stdio, ["ignore", "pipe", "ignore"]);
});

for (const platform of ["darwin", "linux"] as const) {
  test(`runAgy detaches agy into its own process group on ${platform}`, async t => {
    const options = await spawnOptionsOn(t, platform);
    assert.equal(options.detached, true);
    assert.equal(options.windowsHide, true);
  });
}

// Windows has no process group to signal, so a timed-out agy would leave its MCP servers behind. taskkill
// /T ends agy and everything it started, by pid. It runs synchronously: while it does, Node cannot
// handle agy's exit and keeps agy's process handle open, and Windows reuses no pid with a handle open,
// so the pid taskkill targets cannot have passed to another process. If taskkill fails, agy itself is
// still killed.
interface TaskkillCall {
  file: string;
  args: readonly string[];
  options: childProcess.SpawnSyncOptions;
}

function captureTaskkill(t: TestContext, status: number | null): TaskkillCall[] {
  const calls: TaskkillCall[] = [];
  const original = childProcess.spawnSync;
  t.mock.method(childProcess, "spawnSync", (...args: Parameters<typeof childProcess.spawnSync>) => {
    const [file, argv, options] = args as unknown as [string, readonly string[], childProcess.SpawnSyncOptions];
    if (!/taskkill\.exe$/i.test(file)) return (original as (...a: unknown[]) => unknown)(...args);
    calls.push({ file, args: argv, options });
    return { pid: 0, output: [], stdout: null, stderr: null, status, signal: null };
  });
  return calls;
}

function withWindowsDir(t: TestContext, systemRoot: string | undefined, windir: string | undefined): void {
  const saved = { SystemRoot: process.env.SystemRoot, windir: process.env.windir };
  const set = (name: "SystemRoot" | "windir", value: string | undefined) => {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  };
  set("SystemRoot", systemRoot);
  set("windir", windir);
  t.after(() => {
    set("SystemRoot", saved.SystemRoot);
    set("windir", saved.windir);
  });
}

test("runAgy ends agy's whole process tree with taskkill on Windows", async t => {
  withWindowsDir(t, "E:\\Sys", "D:\\Win");
  const killers = captureTaskkill(t, 0);
  const spawned = captureSpawn(t);
  const directKill = t.mock.method(childProcess.ChildProcess.prototype, "kill");
  const groupKill = t.mock.method(process, "kill");
  const { command } = fakeAgy("sleep 1");
  const result = await runAgy([], process.env, { command, timeoutMs: 200, platform: "win32" });
  assert.equal(result.timedOut, true);
  assert.deepEqual(spawned.map(call => call.file), [command]);
  assert.equal(killers.length, 1);
  const [killer] = killers;
  assert.equal(killer.file, "E:\\Sys\\System32\\taskkill.exe");
  assert.deepEqual(killer.args, ["/T", "/F", "/PID", String(killer.args[3])]);
  assert.ok(Number(killer.args[3]) > 0);
  assert.equal(killer.options.windowsHide, true);
  assert.equal(killer.options.stdio, "ignore");
  assert.ok(Number(killer.options.timeout) > 0);
  assert.equal(directKill.mock.callCount(), 0, "a taskkill that succeeds needs no direct kill");
  assert.ok(!groupKill.mock.calls.some(call => typeof call.arguments[0] === "number" && call.arguments[0] < 0),
    "no POSIX group kill on Windows");
});

test("runAgy kills agy directly on Windows when taskkill fails", async t => {
  withWindowsDir(t, "", "D:\\Win");
  const killers = captureTaskkill(t, 128);
  const { command } = fakeAgy("sleep 5");
  const started = Date.now();
  const result = await runAgy([], process.env, { command, timeoutMs: 200, platform: "win32" });
  assert.equal(result.timedOut, true);
  assert.ok(Date.now() - started < 3000, `took ${Date.now() - started} ms`);
  assert.equal(killers.length, 1);
  assert.equal(killers[0].file, "D:\\Win\\System32\\taskkill.exe", "windir stands in for an empty SystemRoot");
});

// The stand-in taskkill reports success without ending agy, so agy keeps writing past the cap and then
// reaches the timeout, and each of those would start a taskkill of its own.
test("runAgy runs taskkill once on Windows however many chunks pass the output cap", async t => {
  const killers = captureTaskkill(t, 0);
  const { command } = fakeAgy("head -c 200000 /dev/zero | tr '\\0' x; sleep 1");
  const result = await runAgy([], process.env, { command, maxBytes: 1024, timeoutMs: 500, platform: "win32" });
  assert.ok(result.stdout.length <= 1024);
  assert.equal(result.timedOut, true);
  assert.equal(killers.length, 1);
});

// Once agy has exited, Windows may hand its pid to another process, so no taskkill may target it then.
test("runAgy runs no taskkill on Windows after agy has exited", async t => {
  const killers = captureTaskkill(t, 0);
  const { command } = fakeAgy("(sleep 5 &); echo '{\"ok\":1}'");
  const result = await runAgy([], process.env, { command, timeoutMs: 4000, platform: "win32" });
  assert.equal(result.code, 0);
  assert.equal(killers.length, 0);
});

test("runAgy does not run taskkill off Windows", async t => {
  const killers = captureTaskkill(t, 0);
  const { command } = fakeAgy("sleep 5");
  const result = await runAgy([], process.env, { command, timeoutMs: 200, platform: "linux" });
  assert.equal(result.timedOut, true);
  assert.equal(killers.length, 0);
});

// A helper agy leaves running can keep its scratch directory busy on Windows, so the removal after the
// run fails. Each run first removes scratch directories an earlier run left behind over an hour ago.
test("sweepStaleScratch removes only old agy-hud-usage directories", t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-sweep-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const now = Date.now();
  const old = new Date(now - 2 * 60 * 60 * 1000);
  const make = (name: string, mtime?: Date) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "f"), "x");
    if (mtime) fs.utimesSync(dir, mtime, mtime);
    return dir;
  };
  const stale = make("agy-hud-usage-stale", old);
  const fresh = make("agy-hud-usage-fresh");
  const foreign = make("someone-else-old", old);
  fs.writeFileSync(path.join(root, "agy-hud-usage-file"), "x");
  fs.utimesSync(path.join(root, "agy-hud-usage-file"), old, old);
  sweepStaleScratch(root, now);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(fresh), true);
  assert.equal(fs.existsSync(foreign), true);
  assert.equal(fs.existsSync(path.join(root, "agy-hud-usage-file")), true, "only directories are swept");
  sweepStaleScratch(path.join(root, "missing"), now);
});

test("runAgy sweeps stale scratch directories before it runs", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-tmproot-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const stale = path.join(root, "agy-hud-usage-left");
  fs.mkdirSync(stale);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  fs.utimesSync(stale, old, old);
  t.mock.method(os, "tmpdir", () => root);
  const { command } = fakeAgy("echo ok");
  const result = await runAgy([], process.env, { command });
  assert.equal(result.code, 0);
  assert.equal(fs.existsSync(stale), false);
});
