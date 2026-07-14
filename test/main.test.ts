import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { strip } from "../src/ansi";
import { defaultConfig } from "../src/config";
import {
  quotaCacheNeedsRefresh,
  quotaCacheReadCandidates,
  quotaCacheWritePath,
  renderStatusline,
  runCli
} from "../src/main";
import { execFileSync } from "node:child_process";

function withEnv(overrides: Record<string, string | undefined>, run: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    const value = overrides[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    run();
  } finally {
    for (const key of Object.keys(saved)) {
      const value = saved[key];
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const legacyCacheRelative = path.join(".gemini", "antigravity-cli", "scratch", "agy-hud", "quota_cache.json");

interface HomeFixture {
  home: string;
  writePath: string;
  legacyPath: string;
  probePath: string;
  markerPath: string;
}

function homeFixture(): HomeFixture {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-home-"));
  const writePath = path.join(home, ".cache", "agy-hud", "quota_cache.json");
  const legacyPath = path.join(home, legacyCacheRelative);
  const probePath = path.join(home, "spawn-probe.sh");
  const markerPath = path.join(home, "spawned.txt");
  fs.writeFileSync(probePath, `#!/bin/sh\necho "$@" >> "${markerPath}"\n`, { encoding: "utf8", mode: 0o755 });
  return { home, writePath, legacyPath, probePath, markerPath };
}

function writeCache(cachePath: string, remainingFraction: number, ageMs: number): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify({
    timestamp: new Date(Date.now() - ageMs).toISOString(),
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction,
        resetTime: "2026-05-20T08:00:00Z"
      }
    }
  }), "utf8");
}

function statuslinePayload(agentState = "idle"): string {
  return JSON.stringify({
    cwd: "agy-hud",
    conversation_id: "conv-1",
    model: { display_name: "Gemini 3.5 Flash (High)" },
    context_window: { used_percentage: 12 },
    agent_state: agentState,
    plan_tier: "Google AI Pro",
    terminal_width: 120
  });
}

async function runStatuslineInHome(fixture: HomeFixture, payload: string): Promise<string> {
  const saved = {
    home: process.env.HOME,
    xdg: process.env.XDG_CACHE_HOME,
    explicit: process.env.AGY_HUD_QUOTA_CACHE,
    argv0: process.argv[0]
  };
  process.env.HOME = fixture.home;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.AGY_HUD_QUOTA_CACHE;
  process.argv[0] = fixture.probePath;

  let out = "";
  try {
    const code = await runCli(["statusline"], {
      stdin: Readable.from([payload]),
      stdout: chunk => {
        out += chunk;
      },
      stderr: () => {}
    });
    assert.equal(code, 0);
  } finally {
    process.argv[0] = saved.argv0;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved.xdg;
    if (saved.explicit === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = saved.explicit;
  }
  return strip(out);
}

async function waitForSpawn(markerPath: string): Promise<boolean> {
  for (let i = 0; i < 20 && !fs.existsSync(markerPath); i += 1) {
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  return fs.existsSync(markerPath);
}

test("statusline renders usage from the legacy cache when only the legacy cache exists", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 10_000);

  const out = await runStatuslineInHome(fixture, statuslinePayload());

  assert.match(out, /40% left/);
});

test("statusline prefers the new cache when both caches parse", async () => {
  const fixture = homeFixture();
  writeCache(fixture.writePath, 0.4, 10_000);
  writeCache(fixture.legacyPath, 0.9, 10_000);

  const out = await runStatuslineInHome(fixture, statuslinePayload());

  assert.match(out, /40% left/);
});

test("statusline falls back to a valid legacy cache when the new cache is corrupt, and forces a repair refresh", async () => {
  const fixture = homeFixture();
  fs.mkdirSync(path.dirname(fixture.writePath), { recursive: true });
  fs.writeFileSync(fixture.writePath, "{ truncated", "utf8");
  writeCache(fixture.legacyPath, 0.4, 10_000);

  const out = await runStatuslineInHome(fixture, statuslinePayload());

  assert.match(out, /40% left/);
  assert.equal(await waitForSpawn(fixture.markerPath), true, "a corrupt primary cache must force a repair refresh");
});

test("statusline omits usage when neither cache exists", async () => {
  const fixture = homeFixture();

  const out = await runStatuslineInHome(fixture, statuslinePayload());

  assert.doesNotMatch(out, /Usage/);
});

function writeRefreshState(cachePath: string, agentState: string, ageMs = 60_000): void {
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(`${cachePath}.statusline.json`, JSON.stringify({
    conversationId: "conv-1",
    agentState,
    lastActivityAt: new Date(Date.now() - ageMs).toISOString()
  }), "utf8");
}

async function runInHome<T>(fixture: HomeFixture, run: () => Promise<T>): Promise<T> {
  const saved = {
    home: process.env.HOME,
    xdg: process.env.XDG_CACHE_HOME,
    explicit: process.env.AGY_HUD_QUOTA_CACHE,
    argv0: process.argv[0]
  };
  process.env.HOME = fixture.home;
  delete process.env.XDG_CACHE_HOME;
  delete process.env.AGY_HUD_QUOTA_CACHE;
  process.argv[0] = fixture.probePath;
  try {
    return await run();
  } finally {
    process.argv[0] = saved.argv0;
    if (saved.home === undefined) delete process.env.HOME;
    else process.env.HOME = saved.home;
    if (saved.xdg === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = saved.xdg;
    if (saved.explicit === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = saved.explicit;
  }
}

test("same-frame idle refresh targets the write path and reloads from it", async () => {
  const fixture = homeFixture();
  writeCache(fixture.writePath, 0.4, 10_000);
  writeRefreshState(fixture.writePath, "working");
  const seen: string[] = [];

  const out = await runInHome(fixture, async () => {
    let captured = "";
    await runCli(["statusline"], {
      stdin: Readable.from([statuslinePayload("idle")]),
      stdout: chunk => {
        captured += chunk;
      },
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        seen.push(cachePath);
        writeCache(cachePath, 0.1, 0);
        return { ok: true, message: "refreshed" };
      }
    });
    return strip(captured);
  });

  assert.deepEqual(seen, [fixture.writePath]);
  assert.match(out, /10% left/, "the HUD must render the cache reloaded from the write path");
});

test("background refresh writes lock and state under the new path only", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 60_000);

  await runStatuslineInHome(fixture, statuslinePayload());

  assert.equal(fs.existsSync(`${fixture.writePath}.lock`), true);
  assert.equal(fs.existsSync(`${fixture.writePath}.statusline.json`), true);
  assert.equal(fs.existsSync(`${fixture.legacyPath}.lock`), false);
  assert.equal(fs.existsSync(`${fixture.legacyPath}.statusline.json`), false);
});

test("background refresh starts when the new cache directory does not exist yet", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 60_000);
  assert.equal(fs.existsSync(path.dirname(fixture.writePath)), false);

  await runStatuslineInHome(fixture, statuslinePayload());

  assert.equal(await waitForSpawn(fixture.markerPath), true);
});

test("upgrade on a working-to-idle transition still refreshes using the legacy debounce state", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 10_000);
  writeRefreshState(fixture.legacyPath, "working", 60_000);
  const seen: string[] = [];

  await runInHome(fixture, async () => {
    await runCli(["statusline"], {
      stdin: Readable.from([statuslinePayload("idle")]),
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        seen.push(cachePath);
        writeCache(cachePath, 0.1, 0);
        return { ok: true, message: "refreshed" };
      }
    });
  });

  assert.deepEqual(seen, [fixture.writePath], "the legacy working state must drive the same-frame refresh");
});

test("a corrupt primary debounce state does not resurrect the legacy state", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 10_000);
  writeRefreshState(fixture.legacyPath, "working", 60_000);
  fs.mkdirSync(path.dirname(fixture.writePath), { recursive: true });
  fs.writeFileSync(`${fixture.writePath}.statusline.json`, "{ truncated", "utf8");
  const seen: string[] = [];

  await runInHome(fixture, async () => {
    await runCli(["statusline"], {
      stdin: Readable.from([statuslinePayload("idle")]),
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        seen.push(cachePath);
        return { ok: true, message: "refreshed" };
      }
    });
  });

  assert.deepEqual(seen, [], "a corrupt primary state must read as null, not fall back to a stale working state");
});

test("background refresh reads the debounce state through the fallback independently of the same-frame path", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 10_000);
  // lastActivityAt inside the 5s window suppresses the same-frame refresh, so only the background
  // trigger can act on this state. It can only see "working" through the fallback.
  writeRefreshState(fixture.legacyPath, "working", 1_000);
  const seen: string[] = [];

  await runInHome(fixture, async () => {
    await runCli(["statusline"], {
      stdin: Readable.from([statuslinePayload("idle")]),
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        seen.push(cachePath);
        return { ok: true, message: "refreshed" };
      }
    });
  });

  assert.deepEqual(seen, [], "the same-frame refresh must stay suppressed by the 5s debounce");
  assert.equal(await waitForSpawn(fixture.markerPath), true, "the background trigger must see the fallback state");
});

test("the post-refresh state is rebuilt from the payload and never inherits legacy fields", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 10_000);
  fs.mkdirSync(path.dirname(fixture.legacyPath), { recursive: true });
  fs.writeFileSync(`${fixture.legacyPath}.statusline.json`, JSON.stringify({
    conversationId: "old-conv",
    agentState: "working",
    lastActivityAt: new Date(Date.now() - 60_000).toISOString()
  }), "utf8");

  await runInHome(fixture, async () => {
    await runCli(["statusline"], {
      stdin: Readable.from([statuslinePayload("idle")]),
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        writeCache(cachePath, 0.1, 0);
        return { ok: true, message: "refreshed" };
      }
    });
  });

  const written = JSON.parse(fs.readFileSync(`${fixture.writePath}.statusline.json`, "utf8"));
  assert.equal(written.conversationId, "conv-1");
  assert.equal(written.agentState, "idle");
  assert.ok(
    Date.now() - new Date(written.lastActivityAt).getTime() < 5_000,
    "lastActivityAt must be stamped fresh, not inherited from the legacy companion"
  );
});

test("the cache directory and state file are not world-readable", async () => {
  const fixture = homeFixture();
  writeCache(fixture.legacyPath, 0.4, 60_000);

  await runStatuslineInHome(fixture, statuslinePayload());

  const dirMode = fs.statSync(path.dirname(fixture.writePath)).mode & 0o777;
  const stateMode = fs.statSync(`${fixture.writePath}.statusline.json`).mode & 0o777;
  assert.equal(dirMode, 0o700, "the cache dir holds quota and conversation state, so it must be private");
  assert.equal(stateMode, 0o600, "the state file records the conversation id and agent state");
});

test("a same-frame repair does not also spawn a background refresh", async () => {
  const fixture = homeFixture();
  fs.mkdirSync(path.dirname(fixture.writePath), { recursive: true });
  fs.writeFileSync(fixture.writePath, "{ truncated", "utf8");
  writeCache(fixture.legacyPath, 0.4, 10_000);
  writeRefreshState(fixture.legacyPath, "working", 60_000);
  const seen: string[] = [];

  await runInHome(fixture, async () => {
    await runCli(["statusline"], {
      stdin: Readable.from([statuslinePayload("idle")]),
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        seen.push(cachePath);
        writeCache(cachePath, 0.1, 0);
        return { ok: true, message: "refreshed" };
      }
    });
  });

  assert.deepEqual(seen, [fixture.writePath], "the same-frame refresh already rewrote the corrupt cache");
  await new Promise(resolve => setTimeout(resolve, 200));
  assert.equal(
    fs.existsSync(fixture.markerPath),
    false,
    "the repair was already done in-frame, so no second probe should be spawned"
  );
});

test("quota refresh targets the write path and leaves a legacy lock alone", async () => {
  const fixture = homeFixture();
  fs.mkdirSync(path.dirname(fixture.legacyPath), { recursive: true });
  fs.writeFileSync(`${fixture.legacyPath}.lock`, new Date().toISOString(), "utf8");
  const seen: string[] = [];

  await runInHome(fixture, async () => {
    const code = await runCli(["quota", "refresh"], {
      stdout: () => {},
      stderr: () => {},
      refreshQuota: async (cachePath: string) => {
        seen.push(cachePath);
        return { ok: true, message: "refreshed" };
      }
    });
    assert.equal(code, 0);
  });

  assert.deepEqual(seen, [fixture.writePath], "quota refresh must write the cache to the write path");
  assert.equal(fs.existsSync(`${fixture.legacyPath}.lock`), true, "a legacy lock must never be unlinked");
});

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

test("quota cache write path honors XDG_CACHE_HOME", () => {
  withEnv({ AGY_HUD_QUOTA_CACHE: undefined, XDG_CACHE_HOME: "/tmp/xdg-cache", HOME: "/tmp/home" }, () => {
    assert.equal(quotaCacheWritePath(), path.join("/tmp/xdg-cache", "agy-hud", "quota_cache.json"));
  });
});

test("quota cache write path falls back to ~/.cache when XDG_CACHE_HOME is unset", () => {
  withEnv({ AGY_HUD_QUOTA_CACHE: undefined, XDG_CACHE_HOME: undefined, HOME: "/tmp/home" }, () => {
    assert.equal(quotaCacheWritePath(), path.join("/tmp/home", ".cache", "agy-hud", "quota_cache.json"));
  });
});

test("AGY_HUD_QUOTA_CACHE overrides the write path and is the only read candidate", () => {
  withEnv({ AGY_HUD_QUOTA_CACHE: "/tmp/explicit/quota_cache.json", XDG_CACHE_HOME: undefined, HOME: "/tmp/home" }, () => {
    assert.equal(quotaCacheWritePath(), "/tmp/explicit/quota_cache.json");
    assert.deepEqual(quotaCacheReadCandidates(), ["/tmp/explicit/quota_cache.json"]);
  });
});

test("a relative XDG_CACHE_HOME is ignored, per the XDG spec", () => {
  // A relative value would make the cache follow the working directory: one cache, lock, and probe
  // per project, written into whatever tree the CLI happens to be rendering in.
  withEnv({ AGY_HUD_QUOTA_CACHE: undefined, XDG_CACHE_HOME: ".cache", HOME: "/tmp/home" }, () => {
    assert.equal(quotaCacheWritePath(), path.join("/tmp/home", ".cache", "agy-hud", "quota_cache.json"));
  });
});

test("quota cache read candidates list the new path before the legacy path", () => {
  withEnv({ AGY_HUD_QUOTA_CACHE: undefined, XDG_CACHE_HOME: undefined, HOME: "/tmp/home" }, () => {
    assert.deepEqual(quotaCacheReadCandidates(), [
      path.join("/tmp/home", ".cache", "agy-hud", "quota_cache.json"),
      path.join("/tmp/home", legacyCacheRelative)
    ]);
  });
});

// These run the CLI in a subprocess, which walks the real statusline path: it loads the cache,
// writes the debounce state and the lock, and can spawn a detached refresh. Without an override it
// would do all of that against the developer's real home directory.
function sandboxedEnv(): NodeJS.ProcessEnv {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-sandbox-"));
  return { ...process.env, AGY_HUD_QUOTA_CACHE: path.join(dir, "quota_cache.json") };
}

test("CLI version prints package version and empty stdin prints agy-hud", () => {
  const entry = path.join(__dirname, "..", "src", "main.js");
  const env = sandboxedEnv();
  assert.equal(execFileSync(process.execPath, [entry, "version"], { encoding: "utf8", env }), `${packageVersion}\n`);
  assert.equal(execFileSync(process.execPath, [entry, "statusline"], { input: "", encoding: "utf8", env }), "agy-hud\n");
});

test("dist bundle CLI smoke test", () => {
  const entry = path.join(__dirname, "..", "..", "dist", "agy-hud.js");
  const env = sandboxedEnv();
  assert.equal(execFileSync(process.execPath, [entry, "version"], { encoding: "utf8", env }), `${packageVersion}\n`);
  assert.equal(execFileSync(process.execPath, [entry, "statusline"], { input: "", encoding: "utf8", env }), "agy-hud\n");
});

test("CLI quota refresh does not fall through to usage", async () => {
  let stdout = "";
  let stderr = "";

  // Without an override, the lock cleanup in the quota refresh command would unlink a lock at the
  // real default cache path, which may belong to a live refresh on the developer's machine.
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-sandbox-"));
  const oldCacheEnv = process.env.AGY_HUD_QUOTA_CACHE;
  process.env.AGY_HUD_QUOTA_CACHE = path.join(sandbox, "quota_cache.json");

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
  }).finally(() => {
    if (oldCacheEnv === undefined) delete process.env.AGY_HUD_QUOTA_CACHE;
    else process.env.AGY_HUD_QUOTA_CACHE = oldCacheEnv;
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
