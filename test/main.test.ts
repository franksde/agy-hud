import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { strip } from "../src/ansi";
import { defaultConfig } from "../src/config";
import { quotaCacheNeedsRefresh, renderStatusline, runCli } from "../src/main";
import { execFileSync } from "node:child_process";

function worktreeFixture(): { repo: string; worktree: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const repo = path.join(root, "repo");
  const worktree = path.join(root, "wt");
  fs.mkdirSync(repo);
  execFileSync("git", ["init", "-q"], { cwd: repo });
  execFileSync("git", ["config", "user.email", "agy-hud@example.invalid"], { cwd: repo });
  execFileSync("git", ["config", "user.name", "agy-hud"], { cwd: repo });
  fs.writeFileSync(path.join(repo, "file.txt"), "x\n");
  execFileSync("git", ["add", "file.txt"], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
  execFileSync("git", ["branch", "-m", "main"], { cwd: repo });
  execFileSync("git", ["branch", "wt-branch"], { cwd: repo });
  execFileSync("git", ["worktree", "add", "-q", worktree, "wt-branch"], { cwd: repo });
  return { repo, worktree };
}

function detachedRepoFixture(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "abcdef1234567890\n");
  return repo;
}

test("renderStatusline uses payload VCS branch", () => {
  const payload = `{
    "cwd": "agy-hud",
    "model": {"display_name": "Gemini 3.5 Flash (High)"},
    "context_window": {"used_percentage": 12},
    "agent_state": "idle",
    "plan_tier": "Google AI Pro",
    "terminal_width": 120,
    "vcs": {"type": "git", "branch": "main"}
  }`;

  const out = renderStatusline(payload, defaultConfig(), null);
  assert.match(strip(out), / main/);
  assert.match(out, /\x1b\[35m main/);
});

test("renderStatusline finds git branch from workspace project dir", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const payload = `{
    "cwd": "agy-hud",
    "workspace": {"project_dir": "${repo}"},
    "model": {"display_name": "Gemini 3.5 Flash (High)"},
    "context_window": {"used_percentage": 12},
    "agent_state": "idle",
    "plan_tier": "Google AI Pro",
    "terminal_width": 120,
    "vcs": {"type": "git"}
  }`;

  assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / main/);
});

test("renderStatusline prefers current worktree over stale payload VCS branch", () => {
  const { repo, worktree } = worktreeFixture();
  const payload = JSON.stringify({
    cwd: worktree,
    workspace: { project_dir: repo, current_dir: worktree },
    model: { display_name: "Gemini 3.5 Flash (High)" },
    context_window: { used_percentage: 12 },
    agent_state: "idle",
    plan_tier: "Google AI Pro",
    terminal_width: 120,
    vcs: { type: "git", branch: "main", root: repo }
  });

  assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / wt-branch/);
});

test("renderStatusline prefers workspace current dir over project dir for worktrees", () => {
  const { repo, worktree } = worktreeFixture();
  const payload = JSON.stringify({
    cwd: worktree,
    workspace: { project_dir: repo, current_dir: worktree },
    model: { display_name: "Gemini 3.5 Flash (High)" },
    context_window: { used_percentage: 12 },
    agent_state: "idle",
    plan_tier: "Google AI Pro",
    terminal_width: 120,
    vcs: { type: "git" }
  });

  assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / wt-branch/);
});

test("renderStatusline uses payload VCS branch before detached process cwd fallback", () => {
  const repo = detachedRepoFixture();
  const old = process.cwd();
  process.chdir(repo);
  try {
    const payload = JSON.stringify({
      cwd: path.basename(repo),
      model: { display_name: "Gemini 3.5 Flash (High)" },
      context_window: { used_percentage: 12 },
      agent_state: "idle",
      plan_tier: "Google AI Pro",
      terminal_width: 120,
      vcs: { type: "git", branch: "main" }
    });

    assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / main/);
  } finally {
    process.chdir(old);
  }
});

test("renderStatusline uses workspace project dir before detached process cwd fallback", () => {
  const detachedRepo = detachedRepoFixture();
  const project = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  fs.mkdirSync(path.join(project, ".git"));
  fs.writeFileSync(path.join(project, ".git", "HEAD"), "ref: refs/heads/main\n");
  const old = process.cwd();
  process.chdir(detachedRepo);
  try {
    const payload = JSON.stringify({
      cwd: path.basename(detachedRepo),
      workspace: { project_dir: project },
      model: { display_name: "Gemini 3.5 Flash (High)" },
      context_window: { used_percentage: 12 },
      agent_state: "idle",
      plan_tier: "Google AI Pro",
      terminal_width: 120,
      vcs: { type: "git" }
    });

    assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / main/);
  } finally {
    process.chdir(old);
  }
});

test("renderStatusline uses process cwd when payload cwd basename matches", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  fs.mkdirSync(path.join(repo, ".git"));
  fs.writeFileSync(path.join(repo, ".git", "HEAD"), "ref: refs/heads/main\n");
  const old = process.cwd();
  process.chdir(repo);
  try {
    const payload = `{
      "cwd": "${path.basename(repo)}",
      "model": {"display_name": "Gemini 3.5 Flash (High)"},
      "context_window": {"used_percentage": 12},
      "agent_state": "idle",
      "plan_tier": "Google AI Pro",
      "terminal_width": 120
    }`;
    assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / main/);
  } finally {
    process.chdir(old);
  }
});

test("renderStatusline uses explicit git branch env", () => {
  const old = process.env.AGY_HUD_GIT_BRANCH;
  process.env.AGY_HUD_GIT_BRANCH = "main";
  try {
    const payload = `{
      "cwd": "not-a-repo",
      "model": {"display_name": "Gemini 3.5 Flash (High)"},
      "context_window": {"used_percentage": 12},
      "agent_state": "idle",
      "plan_tier": "Google AI Pro",
      "terminal_width": 120
    }`;
    assert.match(strip(renderStatusline(payload, defaultConfig(), null)), / main/);
  } finally {
    if (old === undefined) delete process.env.AGY_HUD_GIT_BRANCH;
    else process.env.AGY_HUD_GIT_BRANCH = old;
  }
});

test("renderStatusline does not show git segment when branch cannot be resolved", () => {
  const payload = `{
    "cwd": "not-a-repo",
    "model": {"display_name": "Gemini 3.5 Flash (High)"},
    "context_window": {"used_percentage": 12},
    "agent_state": "idle",
    "plan_tier": "Google AI Pro",
    "terminal_width": 120
  }`;

  assert.doesNotMatch(strip(renderStatusline(payload, defaultConfig(), null)), //);
});

test("renderStatusline fallbacks for empty and malformed input", () => {
  for (const input of ["", "not json", "{'bad':"]) {
    assert.equal(renderStatusline(input, defaultConfig(), null), "agy-hud");
  }
});

const packageVersion = JSON.parse(
  fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8")
).version as string;

test("CLI version prints package version and empty stdin prints agy-hud", () => {
  const entry = path.join(__dirname, "..", "src", "main.js");
  assert.equal(execFileSync(process.execPath, [entry, "version"], { encoding: "utf8" }), `${packageVersion}\n`);
  assert.equal(execFileSync(process.execPath, [entry, "statusline"], { input: "", encoding: "utf8" }), "agy-hud\n");
});

test("dist bundle CLI smoke test", () => {
  const entry = path.join(__dirname, "..", "..", "dist", "agy-hud.js");
  assert.equal(execFileSync(process.execPath, [entry, "version"], { encoding: "utf8" }), `${packageVersion}\n`);
  assert.equal(execFileSync(process.execPath, [entry, "statusline"], { input: "", encoding: "utf8" }), "agy-hud\n");
});

test("CLI quota refresh does not fall through to usage", async () => {
  let stdout = "";
  let stderr = "";

  const code = await runCli(["quota", "refresh"], {
    stdout: chunk => {
      stdout += chunk;
    },
    stderr: chunk => {
      stderr += chunk;
    },
    refreshQuota: async () => ({
      ok: true,
      message: "Successfully cached processed quota data to /tmp/quota_cache.json",
      summary: "- Gemini 3.5 Flash (High)     : Usage  58% | Reset 2026-05-20T08:00:00Z"
    })
  });

  assert.equal(code, 0);
  assert.match(stdout, /Gemini 3\.5 Flash \(High\)/);
  assert.match(stderr, /\[quota_probe\] Successfully cached processed quota data/);
  assert.doesNotMatch(stderr, /usage:/);
});

test("quota cache refresh detects stale and legacy cache shapes", () => {
  const now = new Date("2026-05-20T04:10:00Z");

  assert.equal(quotaCacheNeedsRefresh(null, now), true);
  assert.equal(quotaCacheNeedsRefresh({ timestamp: "not-a-date", models: {} }, now), true);
  assert.equal(quotaCacheNeedsRefresh({ timestamp: "2026-05-20T04:00:00Z", models: {} }, now), true);
  assert.equal(quotaCacheNeedsRefresh({
    timestamp: "2026-05-20T04:09:40Z",
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 0.8,
        resetTime: "2026-05-20T05:00:00Z"
      }
    }
  }, now), true);

  assert.equal(quotaCacheNeedsRefresh({
    timestamp: "2026-05-20T04:09:50Z",
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 0.8,
        resetTime: "2026-05-20T05:00:00Z"
      }
    }
  }, now), false);

  // Untouched quota (all 1.0) should refresh after 30 seconds
  const untouchedCache = {
    timestamp: "2026-05-20T04:09:00Z", // 1 minute ago
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 1.0,
        resetTime: "2026-05-20T05:00:00Z"
      }
    }
  };
  assert.equal(quotaCacheNeedsRefresh(untouchedCache, now), true); // 1 min > 30s -> true

  const untouchedFreshCache = {
    timestamp: "2026-05-20T04:09:45Z", // 15 seconds ago
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 1.0,
        resetTime: "2026-05-20T05:00:00Z"
      }
    }
  };
  assert.equal(quotaCacheNeedsRefresh(untouchedFreshCache, now), false); // 15s < 30s -> false
});

test("statusline triggers immediate refresh after live conversation starts with untouched fresh cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const cachePath = path.join(dir, "quota_cache.json");
  const probePath = path.join(dir, "spawn-probe.sh");
  const markerPath = path.join(dir, "spawned.txt");
  const oldCacheEnv = process.env.AGY_HUD_QUOTA_CACHE;
  const oldArgv0 = process.argv[0];

  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: new Date(Date.now() - 10_000).toISOString(),
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 1,
        resetTime: "2026-05-20T08:00:00Z"
      }
    }
  }), "utf8");
  fs.writeFileSync(probePath, `#!/bin/sh
echo "$@" >> "${markerPath}"
`, { encoding: "utf8", mode: 0o755 });

  process.env.AGY_HUD_QUOTA_CACHE = cachePath;
  process.argv[0] = probePath;

  try {
    const payload = JSON.stringify({
      cwd: "agy-hud",
      conversation_id: "conv-1",
      model: { display_name: "Gemini 3.5 Flash (High)" },
      context_window: { used_percentage: 12 },
      agent_state: "thinking",
      plan_tier: "Google AI Pro",
      terminal_width: 120
    });

    const code = await runCli(["statusline"], {
      stdin: Readable.from([payload]),
      stdout: () => {},
      stderr: () => {}
    });

    assert.equal(code, 0);

    for (let i = 0; i < 20 && !fs.existsSync(markerPath); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    process.argv[0] = oldArgv0;
    if (oldCacheEnv === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = oldCacheEnv;
  }
});

test("statusline refreshes when active model has untouched quota in mixed cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const cachePath = path.join(dir, "quota_cache.json");
  const probePath = path.join(dir, "spawn-probe.sh");
  const markerPath = path.join(dir, "spawned.txt");
  const oldCacheEnv = process.env.AGY_HUD_QUOTA_CACHE;
  const oldArgv0 = process.argv[0];

  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: new Date(Date.now() - 10_000).toISOString(),
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 0.4,
        resetTime: "2026-05-20T05:00:00Z"
      },
      "Claude Opus 4.6 (Thinking)": {
        remainingFraction: 1,
        resetTime: "2026-05-20T08:00:00Z"
      }
    }
  }), "utf8");
  fs.writeFileSync(probePath, `#!/bin/sh
echo "$@" >> "${markerPath}"
`, { encoding: "utf8", mode: 0o755 });

  process.env.AGY_HUD_QUOTA_CACHE = cachePath;
  process.argv[0] = probePath;

  try {
    const payload = JSON.stringify({
      cwd: "agy-hud",
      conversation_id: "conv-opus",
      model: { display_name: "Claude Opus 4.6 (Thinking)" },
      context_window: { used_percentage: 12 },
      agent_state: "thinking",
      plan_tier: "Google AI Pro",
      terminal_width: 120
    });

    const code = await runCli(["statusline"], {
      stdin: Readable.from([payload]),
      stdout: () => {},
      stderr: () => {}
    });

    assert.equal(code, 0);

    for (let i = 0; i < 20 && !fs.existsSync(markerPath); i += 1) {
      await new Promise(resolve => setTimeout(resolve, 25));
    }

    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    process.argv[0] = oldArgv0;
    if (oldCacheEnv === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = oldCacheEnv;
  }
});

test("statusline refreshes when conversation settles after active work even with fresh consumed cache", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const cachePath = path.join(dir, "quota_cache.json");
  const markerPath = path.join(dir, "spawned.txt");
  const oldCacheEnv = process.env.AGY_HUD_QUOTA_CACHE;

  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: new Date().toISOString(),
    models: {
      "Claude Opus 4.6 (Thinking)": {
        remainingFraction: 0.52,
        resetTime: "2026-05-20T08:00:00Z"
      }
    }
  }), "utf8");
  fs.writeFileSync(`${cachePath}.statusline.json`, JSON.stringify({
    conversationId: "conv-opus",
    agentState: "working",
    lastActivityAt: new Date(Date.now() - 10_000).toISOString()
  }), "utf8");

  process.env.AGY_HUD_QUOTA_CACHE = cachePath;

  try {
    const payload = JSON.stringify({
      cwd: "agy-hud",
      conversation_id: "conv-opus",
      model: { display_name: "Claude Opus 4.6 (Thinking)" },
      context_window: { used_percentage: 12 },
      agent_state: "idle",
      plan_tier: "Google AI Pro",
      terminal_width: 120
    });

    const code = await runCli(["statusline"], {
      stdin: Readable.from([payload]),
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async () => {
        fs.writeFileSync(markerPath, "refreshed\n", "utf8");
        return { ok: true, message: "refreshed" };
      }
    });

    assert.equal(code, 0);
    assert.equal(fs.existsSync(markerPath), true);
  } finally {
    if (oldCacheEnv === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = oldCacheEnv;
  }
});

test("statusline renders refreshed quota on the same idle transition", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const cachePath = path.join(dir, "quota_cache.json");
  const oldCacheEnv = process.env.AGY_HUD_QUOTA_CACHE;
  let stdout = "";

  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: new Date().toISOString(),
    models: {
      "Claude Opus 4.6 (Thinking)": {
        remainingFraction: 0.29,
        resetTime: "2026-06-27T09:48:56Z"
      }
    }
  }), "utf8");
  fs.writeFileSync(`${cachePath}.statusline.json`, JSON.stringify({
    conversationId: "conv-opus",
    agentState: "working",
    lastActivityAt: new Date(Date.now() - 10_000).toISOString()
  }), "utf8");

  process.env.AGY_HUD_QUOTA_CACHE = cachePath;

  try {
    const payload = JSON.stringify({
      cwd: "agy-hud",
      conversation_id: "conv-opus",
      model: { display_name: "Claude Opus 4.6 (Thinking)" },
      context_window: { used_percentage: 12 },
      agent_state: "idle",
      plan_tier: "Google AI Pro",
      terminal_width: 120,
      quota: {
        "3p-5h": {
          remaining_fraction: 0.29,
          reset_time: "2026-06-27T09:48:56Z"
        }
      }
    });

    const code = await runCli(["statusline"], {
      stdin: Readable.from([payload]),
      stdout: chunk => {
        stdout += chunk;
      },
      stderr: () => {},
      refreshQuota: async refreshPath => {
        fs.writeFileSync(refreshPath, JSON.stringify({
          timestamp: new Date().toISOString(),
          models: {
            "Claude Opus 4.6 (Thinking)": {
              remainingFraction: 0.03,
              resetTime: "2026-06-27T09:48:56Z"
            }
          }
        }), "utf8");
        return { ok: true, message: "refreshed" };
      }
    });

    assert.equal(code, 0);
    assert.match(strip(stdout), /3% left/);
    assert.doesNotMatch(strip(stdout), /29% left/);
  } finally {
    if (oldCacheEnv === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = oldCacheEnv;
  }
});
