import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseUsageOutput, queryUsage, runAgy, usageArgs } from "../src/usageCommand";

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
  const command = path.join(dir, "agy");
  fs.writeFileSync(command, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return { command, dir };
}

test("runAgy runs in a private scratch directory that it removes afterwards", async () => {
  const { command, dir } = fakeAgy(`pwd > "${"$"}REPORT"; stat -f %Lp . >> "${"$"}REPORT" 2>/dev/null || stat -c %a . >> "${"$"}REPORT"; echo "${"$"}AGY_HUD_NESTED $*" >> "${"$"}REPORT"; echo '{"ok":1}'`);
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
