import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { strip } from "../src/ansi";
import { runCli } from "../src/main";
import {
  collectTokenMetrics,
  decodeGenMetadata,
  resolveConversationDbPath,
  SqliteModule
} from "../src/tokenMetrics";
import { Payload } from "../src/statusline";

// Minimal Protobuf wire encoder for constructing realistic gen_metadata fixtures in tests.
function encodeVarint(value: bigint | number): Buffer {
  let n = typeof value === "bigint" ? value : BigInt(value);
  const bytes: number[] = [];
  do {
    let b = Number(n & 0x7fn);
    n >>= 7n;
    if (n > 0n) b |= 0x80;
    bytes.push(b);
  } while (n > 0n);
  return Buffer.from(bytes);
}

function fieldVarint(fieldNumber: number, value: bigint | number): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 0), encodeVarint(value)]);
}

function fieldBytes(fieldNumber: number, payload: Buffer): Buffer {
  return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(payload.length), payload]);
}

function encodeDuration(seconds: number, nanos: number): Buffer {
  return Buffer.concat([fieldVarint(1, seconds), fieldVarint(2, nanos)]);
}

function encodeGenMetadataRow(opts: {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  thinkingTokens?: number;
  responseTokens?: number;
  ttft?: [number, number];
  genDuration?: [number, number];
  extraMaxUint64?: boolean;
}): Buffer {
  const usageParts: Buffer[] = [
    fieldVarint(1, 1535),
    fieldVarint(2, opts.inputTokens),
    fieldVarint(3, opts.outputTokens)
  ];
  if (opts.cacheReadTokens !== undefined) usageParts.push(fieldVarint(5, opts.cacheReadTokens));
  if (opts.thinkingTokens !== undefined) usageParts.push(fieldVarint(9, opts.thinkingTokens));
  if (opts.responseTokens !== undefined) usageParts.push(fieldVarint(10, opts.responseTokens));
  const f1Parts: Buffer[] = [fieldBytes(4, Buffer.concat(usageParts))];
  if (opts.extraMaxUint64) {
    // Real agy gen_metadata rows contain f1.f9.f2 = uint64 max (18446744073709551615).
    f1Parts.push(fieldBytes(9, fieldVarint(2, 18446744073709551615n)));
  }
  if (opts.ttft) f1Parts.push(fieldBytes(11, encodeDuration(opts.ttft[0], opts.ttft[1])));
  if (opts.genDuration) f1Parts.push(fieldBytes(12, encodeDuration(opts.genDuration[0], opts.genDuration[1])));
  return fieldBytes(1, Buffer.concat(f1Parts));
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-tok-"));
}

test("decodeGenMetadata decodes tokens, thinking breakdown, TTFT, and decode duration", () => {
  const blob = encodeGenMetadataRow({
    inputTokens: 15303,
    outputTokens: 1106,
    cacheReadTokens: 18886,
    thinkingTokens: 624,
    responseTokens: 482,
    ttft: [5, 880_081_800],
    genDuration: [7, 263_687_200],
    extraMaxUint64: true
  });
  const got = decodeGenMetadata(blob);
  assert.ok(got);
  assert.equal(got.inputTokens, 15303);
  assert.equal(got.outputTokens, 1106);
  assert.equal(got.cacheReadTokens, 18886);
  assert.equal(got.thinkingTokens, 624);
  assert.ok(Math.abs((got.ttftSeconds ?? 0) - 5.8800818) < 1e-4);
  assert.ok(Math.abs((got.genDurationSeconds ?? 0) - 7.2636872) < 1e-4);
});

test("decodeGenMetadata safely returns null on empty or corrupt blobs", () => {
  assert.equal(decodeGenMetadata(new Uint8Array(0)), null);
  assert.equal(decodeGenMetadata(new Uint8Array([0xff, 0xff, 0xff])), null);
  assert.equal(decodeGenMetadata(Buffer.from([0x0a, 0x7f, 0x01])), null);
});

test("resolveConversationDbPath derives appDataDir from transcript_path and rejects unsafe IDs", () => {
  const winAppDir = path.join("C:", "Users", "u", ".gemini", "antigravity-cli");
  const winTranscript = path.join(winAppDir, "brain", "conv-123", ".system_generated", "logs", "transcript.jsonl");
  assert.equal(
    resolveConversationDbPath("conv-123", winTranscript, path.join("C:", "Users", "u")),
    path.join(winAppDir, "conversations", "conv-123.db")
  );
  const posixAppDir = path.join("/home", "u", ".gemini", "antigravity-cli");
  const posixTranscript = path.join(posixAppDir, "brain", "conv-123", ".system_generated", "logs", "transcript.jsonl");
  assert.equal(
    resolveConversationDbPath("conv-123", posixTranscript, "/home/u"),
    path.join(posixAppDir, "conversations", "conv-123.db")
  );
  assert.equal(
    resolveConversationDbPath("conv-123", undefined, "/home/u"),
    path.join("/home/u", ".gemini", "antigravity-cli", "conversations", "conv-123.db")
  );
  for (const badId of ["", "../etc", "a/b", "a\\b", "conv with space"]) {
    assert.equal(resolveConversationDbPath(badId, winTranscript, "/home/u"), "");
  }
});

test("Plan A (transcript) incrementally accumulates PLANNER_RESPONSE tokens and ignores partial trailing lines", () => {
  const dir = tempDir();
  const transcriptPath = path.join(dir, "transcript.jsonl");
  const statePath = path.join(dir, "quota_cache.json.tokens.json");
  const line1 = JSON.stringify({ step_index: 0, type: "USER_INPUT", status: "DONE", content: "hi" });
  const line2 = JSON.stringify({
    step_index: 1, type: "PLANNER_RESPONSE", status: "DONE",
    input_tokens: 10000, cache_read_tokens: 0, output_tokens: 200
  });
  const line3 = JSON.stringify({ step_index: 2, type: "GENERIC", status: "DONE", content: "tool output" });
  const line4Partial = '{"step_index":3,"type":"PLANNER_RESPONSE","status":"DONE","input_tokens":5000';
  fs.writeFileSync(transcriptPath, `${line1}\n${line2}\n${line3}\n${line4Partial}`, "utf8");

  const payload: Payload = {
    conversation_id: "conv-a",
    transcript_path: transcriptPath,
    agent_state: "idle"
  };

  const first = collectTokenMetrics(payload, {
    source: "transcript",
    statePath,
    now: new Date("2026-11-26T02:00:00Z")
  });
  assert.ok(first);
  assert.equal(first.source, "transcript");
  assert.equal(first.inputTokens, 10000);
  assert.equal(first.cacheReadTokens, 0);
  assert.equal(first.outputTokens, 200);
  assert.equal(first.turns, 1);

  // Finish writing line4 and append a 5th line; incremental read should pick up only new bytes.
  const line4Rest = ',"cache_read_tokens":10000,"output_tokens":400}\n';
  const line5 = JSON.stringify({
    step_index: 4, type: "PLANNER_RESPONSE", status: "DONE",
    input_tokens: 2000, cache_read_tokens: 15000, output_tokens: 600
  }) + "\n";
  fs.appendFileSync(transcriptPath, line4Rest + line5, "utf8");

  const second = collectTokenMetrics(payload, {
    source: "transcript",
    statePath,
    now: new Date("2026-11-26T02:00:05Z")
  });
  assert.ok(second);
  assert.equal(second.inputTokens, 17000);
  assert.equal(second.cacheReadTokens, 25000);
  assert.equal(second.outputTokens, 1200);
  assert.equal(second.turns, 3);
});

test("Plan A falls back to current_usage and context_window totals when transcript is unavailable", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "state.json");

  const fromCurrentUsage = collectTokenMetrics({
    conversation_id: "conv-cu",
    context_window: {
      total_input_tokens: 80000,
      total_output_tokens: 1500,
      current_usage: {
        input_tokens: 20000,
        output_tokens: 500,
        cache_read_input_tokens: 60000,
        cache_creation_input_tokens: 1000
      }
    },
    agent_state: "idle"
  }, { source: "transcript", statePath, now: new Date("2026-11-26T02:00:00Z") });
  assert.ok(fromCurrentUsage);
  assert.equal(fromCurrentUsage.inputTokens, 20000);
  assert.equal(fromCurrentUsage.cacheReadTokens, 60000);
  assert.equal(fromCurrentUsage.cacheCreationTokens, 1000);
  assert.equal(fromCurrentUsage.outputTokens, 1500);

  const fromTotalsOnly = collectTokenMetrics({
    conversation_id: "conv-tot",
    context_window: {
      total_input_tokens: 125000,
      total_output_tokens: 5000
    },
    agent_state: "idle"
  }, { source: "transcript", statePath, now: new Date("2026-11-26T02:00:10Z") });
  assert.ok(fromTotalsOnly);
  assert.equal(fromTotalsOnly.inputTokens, 125000);
  assert.equal(fromTotalsOnly.cacheReadTokens, undefined);
  assert.equal(fromTotalsOnly.outputTokens, 5000);

  const empty = collectTokenMetrics({
    conversation_id: "conv-empty",
    context_window: { used_percentage: 0 },
    agent_state: "idle"
  }, { source: "transcript", statePath, now: new Date("2026-11-26T02:00:20Z") });
  assert.equal(empty, null);
});

test("Plan A samples output speed across thinking/working frames, excludes tool_use time, and resets on conversation switch", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "state.json");
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, "", "utf8");

  const run = (agentState: string, iso: string, convId = "conv-1") => collectTokenMetrics({
    conversation_id: convId,
    transcript_path: transcriptPath,
    agent_state: agentState
  }, { source: "transcript", statePath, now: new Date(iso) });

  // Turn starts: thinking at t=0
  assert.equal(run("thinking", "2026-11-26T02:00:00.000Z"), null);

  // Model finishes first response (500 out tokens) at t=5s, entering tool_use
  fs.appendFileSync(transcriptPath, JSON.stringify({
    step_index: 1, type: "PLANNER_RESPONSE", status: "DONE",
    input_tokens: 5000, cache_read_tokens: 0, output_tokens: 500
  }) + "\n");
  const afterStep1 = run("tool_use", "2026-11-26T02:00:05.000Z");
  assert.ok(afterStep1);
  assert.equal(afterStep1.speedEstimated, true);
  assert.ok(Math.abs((afterStep1.tokensPerSecond ?? 0) - 100) < 0.1);

  // Tool runs for 30s; speed stays sticky without diluting into tool wait time
  const duringTool = run("tool_use", "2026-11-26T02:00:35.000Z");
  assert.ok(duringTool);
  assert.ok(Math.abs((duringTool.tokensPerSecond ?? 0) - 100) < 0.1);

  // Model resumes thinking at t=40s, produces 600 more tokens in 4s -> 150 tok/s
  run("thinking", "2026-11-26T02:00:40.000Z");
  fs.appendFileSync(transcriptPath, JSON.stringify({
    step_index: 3, type: "PLANNER_RESPONSE", status: "DONE",
    input_tokens: 3000, cache_read_tokens: 5000, output_tokens: 600
  }) + "\n");
  const afterStep2 = run("idle", "2026-11-26T02:00:44.000Z");
  assert.ok(afterStep2);
  assert.equal(afterStep2.outputTokens, 1100);
  assert.ok(Math.abs((afterStep2.tokensPerSecond ?? 0) - 150) < 0.1);

  // Switching conversation clears sticky speed
  const switched = collectTokenMetrics({
    conversation_id: "conv-2",
    context_window: { total_input_tokens: 1000, total_output_tokens: 50 },
    agent_state: "idle"
  }, { source: "transcript", statePath, now: new Date("2026-11-26T02:01:00.000Z") });
  assert.ok(switched);
  assert.equal(switched.tokensPerSecond, undefined);
});

test("Plan B (db) reads gen_metadata via injected SQLite, computes exact decode speed and TTFT, and handles short bursts", () => {
  const dir = tempDir();
  const convDir = path.join(dir, "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, "conv-db.db");
  fs.writeFileSync(dbPath, "stub-db", "utf8");
  const statePath = path.join(dir, "state.json");

  const rows: Array<{ idx: number; data: Uint8Array }> = [
    {
      idx: 0,
      data: encodeGenMetadataRow({
        inputTokens: 19284, outputTokens: 81, cacheReadTokens: 0,
        thinkingTokens: 61, responseTokens: 20,
        // Very short streaming duration (< 0.25s) should use total (ttft + gen) instead of fake 1000 tok/s
        ttft: [2, 674_000_000], genDuration: [0, 81_000_000]
      })
    }
  ];

  let openCount = 0;
  const fakeSqlite: SqliteModule = {
    DatabaseSync: class {
      constructor() { openCount += 1; }
      prepare() {
        return {
          all: (...args: unknown[]) => {
            const afterIdx = typeof args[0] === "number" ? args[0] : -1;
            return rows.filter(r => r.idx > afterIdx);
          }
        };
      }
      close() {}
    }
  };

  const payload: Payload = { conversation_id: "conv-db", agent_state: "idle" };
  const first = collectTokenMetrics(payload, {
    source: "db",
    statePath,
    conversationsDir: convDir,
    loadSqlite: () => fakeSqlite
  });
  assert.ok(first);
  assert.equal(first.source, "db");
  assert.equal(first.inputTokens, 19284);
  assert.equal(first.cacheReadTokens, 0);
  assert.equal(first.outputTokens, 81);
  assert.equal(first.thinkingTokens, 61);
  assert.equal(first.speedEstimated, false);
  assert.ok(Math.abs((first.ttftSeconds ?? 0) - 2.674) < 0.01);
  // 81 / (2.674 + 0.081) ≈ 29.4 tok/s, NOT 1000 tok/s
  assert.ok((first.tokensPerSecond ?? 0) > 25 && (first.tokensPerSecond ?? 0) < 35);
  assert.equal(openCount, 1);

  // Unchanged DB + no WAL change hits the stat cache without opening SQLite again.
  const cached = collectTokenMetrics(payload, {
    source: "db",
    statePath,
    conversationsDir: convDir,
    loadSqlite: () => fakeSqlite
  });
  assert.deepEqual(cached, first);
  assert.equal(openCount, 1);

  // Append a WAL file + new row: WAL change busts the stat cache and incrementally reads only idx > 0.
  rows.push({
    idx: 1,
    data: encodeGenMetadataRow({
      inputTokens: 15303, outputTokens: 1106, cacheReadTokens: 18886,
      thinkingTokens: 624, responseTokens: 482,
      ttft: [5, 880_000_000], genDuration: [7, 264_000_000]
    })
  });
  fs.writeFileSync(`${dbPath}-wal`, "wal-update", "utf8");

  const updated = collectTokenMetrics(payload, {
    source: "db",
    statePath,
    conversationsDir: convDir,
    loadSqlite: () => fakeSqlite
  });
  assert.ok(updated);
  assert.equal(openCount, 2);
  assert.equal(updated.inputTokens, 19284 + 15303);
  assert.equal(updated.cacheReadTokens, 18886);
  assert.equal(updated.outputTokens, 81 + 1106);
  assert.equal(updated.thinkingTokens, 61 + 624);
  assert.equal(updated.turns, 2);
  // 1106 / 7.264 ≈ 152.26 tok/s
  assert.ok(Math.abs((updated.tokensPerSecond ?? 0) - 152.26) < 0.2);
  assert.ok(Math.abs((updated.ttftSeconds ?? 0) - 5.88) < 0.01);
});

test("db mode returns null when sqlite is unavailable, while auto mode falls back cleanly to Plan A", () => {
  const dir = tempDir();
  const statePath = path.join(dir, "state.json");
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, JSON.stringify({
    step_index: 1, type: "PLANNER_RESPONSE", status: "DONE",
    input_tokens: 4000, cache_read_tokens: 6000, output_tokens: 300
  }) + "\n");

  const payload: Payload = {
    conversation_id: "conv-fallback",
    transcript_path: transcriptPath,
    agent_state: "idle"
  };

  const dbOnly = collectTokenMetrics(payload, {
    source: "db",
    statePath,
    conversationsDir: dir,
    loadSqlite: () => null
  });
  assert.equal(dbOnly, null);

  const autoMode = collectTokenMetrics(payload, {
    source: "auto",
    statePath,
    conversationsDir: dir,
    loadSqlite: () => null
  });
  assert.ok(autoMode);
  assert.equal(autoMode.source, "transcript");
  assert.equal(autoMode.inputTokens, 4000);
  assert.equal(autoMode.cacheReadTokens, 6000);
  assert.equal(autoMode.outputTokens, 300);
});

// Live SQLite integration test: runs whenever Node provides built-in node:sqlite (Node 22.5+).
let realSqlite: SqliteModule | null = null;
try {
  const origWarn = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message ?? "";
    if (msg.includes("SQLite")) return;
    return (origWarn as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    realSqlite = require("node:" + "sqlite") as SqliteModule;
  } finally {
    process.emitWarning = origWarn;
  }
} catch {
  realSqlite = null;
}

test("Plan B reads a real WAL-mode SQLite database end-to-end without warnings", { skip: realSqlite === null }, () => {
  const dir = tempDir();
  const convDir = path.join(dir, "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, "conv-live.db");
  const statePath = path.join(dir, "state.json");

  const writer = new realSqlite!.DatabaseSync(dbPath);
  writer.exec?.("PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER NOT NULL DEFAULT 0);");
  const stmt = writer.prepare("INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, 0)");
  stmt.run?.(0, encodeGenMetadataRow({
    inputTokens: 12000, outputTokens: 800, cacheReadTokens: 24000,
    thinkingTokens: 300, responseTokens: 500,
    ttft: [4, 200_000_000], genDuration: [6, 400_000_000]
  }));

  try {
    const got = collectTokenMetrics(
      { conversation_id: "conv-live", agent_state: "idle" },
      { source: "db", statePath, conversationsDir: convDir }
    );
    assert.ok(got);
    assert.equal(got.source, "db");
    assert.equal(got.inputTokens, 12000);
    assert.equal(got.cacheReadTokens, 24000);
    assert.equal(got.outputTokens, 800);
    assert.equal(got.thinkingTokens, 300);
    assert.ok(Math.abs((got.tokensPerSecond ?? 0) - 125) < 0.1);
    assert.ok(Math.abs((got.ttftSeconds ?? 0) - 4.2) < 0.01);
  } finally {
    writer.close();
  }
});

test("runCli statusline switches between Plan A (transcript) and Plan B (db) via config", async () => {
  const dir = tempDir();
  const convDir = path.join(dir, "conversations");
  fs.mkdirSync(convDir, { recursive: true });
  const dbPath = path.join(convDir, "conv-cli.db");
  fs.writeFileSync(dbPath, "stub-db", "utf8");
  const transcriptPath = path.join(dir, "transcript.jsonl");
  fs.writeFileSync(transcriptPath, JSON.stringify({
    step_index: 1, type: "PLANNER_RESPONSE", status: "DONE",
    input_tokens: 10_000, cache_read_tokens: 30_000, output_tokens: 1_000
  }) + "\n");

  const fakeSqlite: SqliteModule = {
    DatabaseSync: class {
      prepare() {
        return {
          all: () => [{
            idx: 0,
            data: encodeGenMetadataRow({
              inputTokens: 10_000, outputTokens: 1_000, cacheReadTokens: 30_000,
              thinkingTokens: 400, responseTokens: 600,
              ttft: [3, 500_000_000], genDuration: [8, 0]
            })
          }]
        };
      }
      close() {}
    }
  };

  const payload = JSON.stringify({
    cwd: "agy-hud",
    conversation_id: "conv-cli",
    transcript_path: transcriptPath,
    model: { display_name: "Gemini 4 Neon (XHigh)" },
    context_window: { used_percentage: 10 },
    agent_state: "idle",
    plan_tier: "Google AI Ultra",
    terminal_width: 140
  });

  const runWithConfig = async (cfgObj: Record<string, unknown>) => {
    const cfgPath = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    const cachePath = path.join(dir, `cache-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj), "utf8");
    // Seed a fresh cache so the test never triggers a background quota refresh subprocess.
    fs.writeFileSync(cachePath, JSON.stringify({
      timestamp: new Date().toISOString(),
      models: { "Gemini 4 Neon (XHigh)": { remainingFraction: 0.9, resetTime: "2026-12-01T00:00:00Z" } }
    }), "utf8");
    const savedCfg = process.env.AGY_HUD_CONFIG;
    const savedCache = process.env.AGY_HUD_QUOTA_CACHE;
    process.env.AGY_HUD_CONFIG = cfgPath;
    process.env.AGY_HUD_QUOTA_CACHE = cachePath;
    let out = "";
    try {
      const code = await runCli(["statusline"], {
        stdin: Readable.from([payload]),
        stdout: chunk => { out += chunk; },
        stderr: () => {},
        tokenMetricsConversationsDir: convDir,
        loadSqlite: () => fakeSqlite
      });
      assert.equal(code, 0);
    } finally {
      if (savedCfg === undefined) delete process.env.AGY_HUD_CONFIG; else process.env.AGY_HUD_CONFIG = savedCfg;
      if (savedCache === undefined) delete process.env.AGY_HUD_QUOTA_CACHE; else process.env.AGY_HUD_QUOTA_CACHE = savedCache;
    }
    return strip(out).trimEnd();
  };

  // Plan A (default "transcript"): shows transcript totals, no TTFT
  const planA = await runWithConfig({ color: false, token_metrics_source: "transcript" });
  assert.equal(planA.split("\n").length, 3);
  assert.equal(planA.split("\n")[2], "Tok 10k in · 30k hit (75%) · 1k out");

  // Plan B ("db"): shows exact decode speed (1000 / 8 = 125 tok/s) and TTFT 3.5s
  const planB = await runWithConfig({ color: false, token_metrics_source: "db" });
  assert.equal(planB.split("\n").length, 3);
  assert.equal(planB.split("\n")[2], "Tok 10k in · 30k hit (75%) · 1k out │ 125 tok/s · TTFT 3.5s");

  // Disabled via config: stays 2 lines
  const disabled = await runWithConfig({ color: false, show_tokens: false, show_token_speed: false });
  assert.equal(disabled.split("\n").length, 2);
});
