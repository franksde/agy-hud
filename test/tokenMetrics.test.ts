import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { strip, visibleLen } from "../src/ansi";
import { defaultConfig } from "../src/config";
import { runCli } from "../src/main";
import { Payload, render } from "../src/statusline";
import { collectTokenMetrics, decodeGenMetadata, defaultLoadSqlite, resolveConversationDbPath, sqliteSupported, SqliteModule, TokenMetrics } from "../src/tokenMetrics";
import { spawnSync } from "node:child_process";

// Every temp dir a test makes is removed when the file finishes.
const tmpDirs: string[] = [];
after(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });
const tempDir = (prefix: string): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(d);
  return d;
};

const encVarint = (v: bigint | number): Buffer => {
  let n = typeof v === "bigint" ? v : BigInt(v);
  const out: number[] = [];
  do { let b = Number(n & 0x7fn); n >>= 7n; if (n > 0n) b |= 0x80; out.push(b); } while (n > 0n);
  return Buffer.from(out);
};
const fVarint = (f: number, v: bigint | number) => Buffer.concat([encVarint((f << 3) | 0), encVarint(v)]);
const fBytes = (f: number, b: Buffer) => Buffer.concat([encVarint((f << 3) | 2), encVarint(b.length), b]);
const encDur = ([s, ns]: [number, number]) => Buffer.concat([fVarint(1, s), fVarint(2, ns)]);

function encRow(o: { inp: number; out: number; cache?: number; ttft?: [number, number]; gen?: [number, number]; maxU64?: boolean }): Buffer {
  const usage = [fVarint(1, 1535), fVarint(2, o.inp), fVarint(3, o.out)];
  if (o.cache !== undefined) usage.push(fVarint(5, o.cache));
  const f1 = [fBytes(4, Buffer.concat(usage))];
  if (o.maxU64) f1.push(fBytes(9, fVarint(2, 18446744073709551615n)));
  if (o.ttft) f1.push(fBytes(11, encDur(o.ttft)));
  if (o.gen) f1.push(fBytes(12, encDur(o.gen)));
  return fBytes(1, Buffer.concat(f1));
}

function makeStubDb(id = "conv-1"): string {
  const convDir = tempDir("agy-hud-tok-");
  // agy keeps a live conversation DB in WAL mode, so its -wal and -shm sidecars exist.
  for (const suffix of [".db", ".db-wal", ".db-shm"]) fs.writeFileSync(path.join(convDir, `${id}${suffix}`), "stub", "utf8");
  return convDir;
}

const fakeSqlite = (rows: unknown[], sqls: string[] = []): SqliteModule => ({
  DatabaseSync: class { prepare(sql: string) { sqls.push(sql); return { all: () => rows }; } close() {} }
});

test("decodeGenMetadata decodes valid rows (including uint64 max sibling) and rejects corrupt blobs", () => {
  const got = decodeGenMetadata(encRow({
    inp: 15303, out: 1106, cache: 18886, ttft: [5, 880_081_800], gen: [7, 263_687_200], maxU64: true
  }));
  assert.ok(got);
  assert.equal(got.inputTokens, 15303);
  assert.equal(got.outputTokens, 1106);
  assert.equal(got.cacheReadTokens, 18886);
  assert.ok(Math.abs((got.ttftSeconds ?? 0) - 5.8800818) < 1e-4);
  assert.ok(Math.abs((got.genDurationSeconds ?? 0) - 7.2636872) < 1e-4);
  for (const bad of [new Uint8Array(0), new Uint8Array([0xff, 0xff, 0xff]), Buffer.from([0x0a, 0x7f, 0x01])]) {
    assert.equal(decodeGenMetadata(bad), null);
  }
});

test("collectTokenMetrics sums decodable rows and takes last-row TTFT and output/(ttft+gen) speed", () => {
  const convDir = makeStubDb("conv-sum");
  const rows = [
    { data: encRow({ inp: 100_000, cache: 200_000, out: 4_000, ttft: [2, 0], gen: [8, 0] }) },
    { data: Buffer.from([0xff, 0xff]) },
    { data: "not-a-blob" },
    { data: encRow({ inp: 7_000, cache: 117_000, out: 1_000, ttft: [3, 900_000_000], gen: [5, 700_000_000] }) }
  ];
  const payload: Payload = { conversation_id: "conv-sum" };
  const got = collectTokenMetrics(payload, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => fakeSqlite(rows) });
  assert.ok(got);
  assert.equal(got.inputTokens, 107_000);
  assert.equal(got.cacheReadTokens, 317_000);
  assert.equal(got.outputTokens, 5_000);
  assert.ok(Math.abs((got.ttftSeconds ?? 0) - 3.9) < 0.01);
  assert.ok(Math.abs((got.tokensPerSecond ?? 0) - 104.17) < 0.05); // 1000 / (3.9 + 5.7)

  const countsOnly = collectTokenMetrics(payload, { includeCounts: true, includeSpeed: false, conversationsDir: convDir, loadSqlite: () => fakeSqlite(rows) });
  assert.equal(countsOnly?.inputTokens, 107_000);
  assert.equal(countsOnly?.tokensPerSecond, undefined);
  assert.equal(countsOnly?.ttftSeconds, undefined);

  const speedOnly = collectTokenMetrics(payload, { includeCounts: false, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => fakeSqlite(rows) });
  assert.equal(speedOnly?.inputTokens, 0);
  assert.equal(speedOnly?.cacheReadTokens, undefined);
  assert.ok(Math.abs((speedOnly?.tokensPerSecond ?? 0) - 104.17) < 0.05);
});

test("collectTokenMetrics omits speed for short/implausible durations and guards TTFT bounds", () => {
  const convDir = makeStubDb("conv-bounds");
  const run = (o: Parameters<typeof encRow>[0]) => collectTokenMetrics(
    { conversation_id: "conv-bounds" },
    { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => fakeSqlite([{ data: encRow(o) }]) }
  );
  const shortDur = run({ inp: 1000, out: 100, ttft: [0, 150_000_000], gen: [0, 50_000_000] });
  assert.equal(shortDur?.tokensPerSecond, undefined);
  assert.ok(Math.abs((shortDur?.ttftSeconds ?? 0) - 0.15) < 0.001);
  assert.equal(run({ inp: 1000, out: 10_000, ttft: [0, 500_000_000], gen: [0, 0] })?.tokensPerSecond, undefined);
  assert.equal(run({ inp: 1000, out: 100, ttft: [0, 0], gen: [1, 0] })?.ttftSeconds, undefined);
  assert.equal(run({ inp: 1000, out: 100, ttft: [601, 0], gen: [1, 0] })?.ttftSeconds, undefined);
});

test("collectTokenMetrics guards flags, unsafe IDs, missing DB, null loader, and sqlite throws", () => {
  const convDir = makeStubDb("conv-guard");
  let loads = 0;
  const loader = () => { loads += 1; return fakeSqlite([]); };

  assert.equal(collectTokenMetrics({ conversation_id: "conv-guard" }, { includeCounts: false, includeSpeed: false, conversationsDir: convDir, loadSqlite: loader }), null);
  for (const badId of ["", "../etc", "a/b", "a\\b", "has space", "a".repeat(129), 42, null]) {
    assert.equal(resolveConversationDbPath(badId, "/home/u"), null);
    assert.equal(collectTokenMetrics({ conversation_id: badId as string, transcript_path: "/any/path" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: loader }), null);
  }
  assert.equal(resolveConversationDbPath("conv-1", "/home/u"), path.join("/home/u", ".gemini", "antigravity-cli", "conversations", "conv-1.db"));
  assert.equal(collectTokenMetrics({ conversation_id: "missing-id" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: loader }), null);
  assert.equal(loads, 0);

  assert.equal(collectTokenMetrics({ conversation_id: "conv-guard" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => null }), null);
  assert.equal(collectTokenMetrics({ conversation_id: "conv-guard" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => { throw new Error("boom"); } }), null);
  const throwing: SqliteModule = { DatabaseSync: class { constructor() { throw new Error("locked"); } prepare() { return { all: () => [] }; } close() {} } };
  assert.equal(collectTokenMetrics({ conversation_id: "conv-guard" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => throwing }), null);
});

test("sqliteSupported only accepts Node versions whose node:sqlite is unflagged and honours readOnly", () => {
  for (const v of ["18.20.8", "20.19.0", "22.5.0", "22.12.0", "23.3.0"]) assert.equal(sqliteSupported(v), false, v);
  for (const v of ["22.13.0", "22.20.1", "23.4.0", "24.0.0", "25.1.0"]) assert.equal(sqliteSupported(v), true, v);
});

test("collectTokenMetrics never opens a DB whose WAL sidecars are missing, so SQLite cannot create them", () => {
  const convDir = makeStubDb("conv-nowal");
  fs.rmSync(path.join(convDir, "conv-nowal.db-wal"));
  let loads = 0;
  const opts = { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => { loads += 1; return fakeSqlite([]); } };
  assert.equal(collectTokenMetrics({ conversation_id: "conv-nowal" }, opts), null);
  fs.writeFileSync(path.join(convDir, "conv-nowal.db-wal"), "stub");
  fs.rmSync(path.join(convDir, "conv-nowal.db-shm"));
  assert.equal(collectTokenMetrics({ conversation_id: "conv-nowal" }, opts), null);
  assert.equal(loads, 0);
});

test("speed needs both a valid TTFT and a generation duration and skips trailing zero-output rows", () => {
  const convDir = makeStubDb("conv-speed");
  const one = (o: Parameters<typeof encRow>[0], sqls: string[] = [], includeCounts = true) => collectTokenMetrics(
    { conversation_id: "conv-speed" },
    { includeCounts, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => fakeSqlite([{ data: encRow(o) }], sqls) }
  );
  assert.equal(one({ inp: 1000, out: 500, ttft: [2, 0] })?.tokensPerSecond, undefined);
  assert.equal(one({ inp: 1000, out: 500, gen: [2, 0] })?.tokensPerSecond, undefined);
  assert.equal(one({ inp: 1000, out: 500, ttft: [601, 0], gen: [2, 0] })?.tokensPerSecond, undefined);
  // 13 of 565 real conversation DBs end with an all-zero row; the latest real response still counts.
  const rows = [
    { data: encRow({ inp: 1000, out: 500, ttft: [2, 0], gen: [3, 0] }) },
    { data: encRow({ inp: 0, out: 0, cache: 0, ttft: [0, 0], gen: [0, 0] }) }
  ];
  for (const includeCounts of [true, false]) {
    const got = collectTokenMetrics({ conversation_id: "conv-speed" }, { includeCounts, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => fakeSqlite(rows) });
    assert.ok(Math.abs((got?.tokensPerSecond ?? 0) - 100) < 0.01, `includeCounts=${includeCounts}`);
    assert.equal(got?.ttftSeconds, 2);
  }
  const countsOnly = collectTokenMetrics({ conversation_id: "conv-speed" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir, loadSqlite: () => fakeSqlite([{ data: encRow({ inp: 900, out: 0, cache: 100 }) }]) });
  assert.equal(countsOnly?.inputTokens, 900);
  assert.equal(countsOnly?.tokensPerSecond, undefined);
});

test("counts that are out of range or of the wrong wire type reject the row, and unsafe sums are dropped", () => {
  assert.equal(decodeGenMetadata(encRow({ inp: 2 ** 60, out: 1, cache: 5 })), null);
  const wrongType = fBytes(1, fBytes(4, Buffer.concat([fBytes(2, Buffer.from([1])), fVarint(3, 1), fVarint(5, 9)])));
  assert.equal(decodeGenMetadata(wrongType), null);
  const overlong = Buffer.from([0x08, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02]);
  assert.equal(decodeGenMetadata(fBytes(1, fBytes(4, overlong))), null);
  const convDir = makeStubDb("conv-huge");
  const rows = [{ data: encRow({ inp: Number.MAX_SAFE_INTEGER, out: 1, cache: 1 }) }, { data: encRow({ inp: 10, out: 1, cache: 1 }) }];
  assert.equal(collectTokenMetrics({ conversation_id: "conv-huge" }, { includeCounts: true, includeSpeed: false, conversationsDir: convDir, loadSqlite: () => fakeSqlite(rows) }), null);
});

test("loading node:sqlite prints nothing to stderr", { skip: !sqliteSupported() }, () => {
  const mod = path.join(__dirname, "..", "src", "tokenMetrics.js");
  const r = spawnSync(process.execPath, ["-e", `const m = require(${JSON.stringify(mod)}); if (!m.defaultLoadSqlite()) process.exit(3);`], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stderr, "");
});

const realSqlite = defaultLoadSqlite();

test("reads a real WAL-mode SQLite DB end-to-end", { skip: realSqlite === null }, () => {
  const convDir = tempDir("agy-hud-wal-");
  const writer = new realSqlite!.DatabaseSync(path.join(convDir, "conv-live.db"));
  writer.exec?.("PRAGMA journal_mode=WAL; CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB);");
  const ins = writer.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");
  ins.run?.(0, encRow({ inp: 5_000, cache: 10_000, out: 200, ttft: [1, 0], gen: [1, 0] }));
  ins.run?.(1, encRow({ inp: 12_000, cache: 24_000, out: 800, ttft: [4, 0], gen: [4, 0] }));
  try {
    const got = collectTokenMetrics({ conversation_id: "conv-live" }, { includeCounts: true, includeSpeed: true, conversationsDir: convDir });
    assert.ok(got);
    assert.equal(got.inputTokens, 17_000);
    assert.equal(got.cacheReadTokens, 34_000);
    assert.equal(got.outputTokens, 1_000);
    assert.ok(Math.abs((got.tokensPerSecond ?? 0) - 100) < 0.01); // 800 / (4 + 4)
    assert.ok(Math.abs((got.ttftSeconds ?? 0) - 4) < 0.01);
  } finally {
    writer.close();
  }
});

test("renderer formats line 3, hit colors, toggles, width degradation, and single-line mode", () => {
  const basePayload: Payload = {
    cwd: "/work/agy-hud", model: { display_name: "Gemini 4 Neon (High)" },
    context_window: { used_percentage: 12 }, agent_state: "idle", plan_tier: "Ultra", terminal_width: 120
  };
  const metrics: TokenMetrics = { inputTokens: 107_000, cacheReadTokens: 317_000, outputTokens: 5_000, ttftSeconds: 3.9, tokensPerSecond: 104.2 };
  const cfg = { ...defaultConfig(), color: false, showTokens: true, showTokenSpeed: true };

  const full = render(basePayload, { config: cfg, tokenMetrics: metrics }).split("\n");
  assert.equal(full.length, 3);
  assert.equal(full[2], "Tokens 429k [in 107k · cache 317k (75%) · out 5k] │ TTFT 3.9s │ 104 tok/s");

  const colored = render(basePayload, { config: { ...cfg, color: true }, tokenMetrics: { ...metrics, tokensPerSecond: 9.44 } }).split("\n")[2];
  assert.ok(colored.includes("\x1b[32m(75%)\x1b[0m"));
  assert.ok(colored.includes("\x1b[90mTTFT 3.9s\x1b[0m"));
  assert.ok(colored.includes("\x1b[36m9.4 tok/s\x1b[0m"));
  assert.ok(render(basePayload, { config: { ...cfg, color: true }, tokenMetrics: { inputTokens: 50_000, cacheReadTokens: 50_000, outputTokens: 1000 } }).split("\n")[2].includes("\x1b[33m(50%)\x1b[0m"));
  assert.ok(render(basePayload, { config: { ...cfg, color: true }, tokenMetrics: { inputTokens: 90_000, cacheReadTokens: 10_000, outputTokens: 1000 } }).split("\n")[2].includes("\x1b[90m(10%)\x1b[0m"));

  assert.equal(render(basePayload, { config: { ...cfg, showTokens: false }, tokenMetrics: metrics }).split("\n")[2], "TTFT 3.9s │ 104 tok/s");
  assert.equal(render(basePayload, { config: { ...cfg, showTokenSpeed: false }, tokenMetrics: metrics }).split("\n")[2], "Tokens 429k [in 107k · cache 317k (75%) · out 5k]");
  assert.equal(render(basePayload, { config: { ...cfg, showTokens: false, showTokenSpeed: false }, tokenMetrics: metrics }).split("\n").length, 2);

  const atWidth = (w: number) => render({ ...basePayload, terminal_width: w }, { config: cfg, tokenMetrics: metrics }).split("\n")[2];
  assert.equal(atWidth(60), "Tokens 429k (75% hit) │ TTFT 3.9s │ 104 tok/s");
  assert.equal(atWidth(40), "Tokens 429k (75% hit) │ 104 tok/s");
  assert.equal(atWidth(25), "Tokens 429k (75% hit)");
  assert.equal(atWidth(15), "Tokens 429k");
  assert.equal(visibleLen(atWidth(8)), 8);

  const singleWide = render({ ...basePayload, terminal_width: 140 }, { config: { ...cfg, multiline: false, showIcons: false }, tokenMetrics: metrics });
  assert.doesNotMatch(singleWide, /\n/);
  assert.match(singleWide, /Tokens 429k \(75% hit\)  104 tok\/s/);
  const singleNarrow = render({ ...basePayload, terminal_width: 55 }, { config: { ...cfg, multiline: false, showIcons: false }, tokenMetrics: metrics });
  assert.ok(visibleLen(singleNarrow) <= 55);
  assert.doesNotMatch(singleNarrow, /Tokens 429k/);
  assert.match(singleNarrow, /Ctx 12%.*Idle/);
  // Speed is dropped before the token segment, as on the multiline token line.
  const singleMid = render({ ...basePayload, terminal_width: 79 }, { config: { ...cfg, multiline: false, showIcons: false }, tokenMetrics: metrics });
  assert.ok(visibleLen(singleMid) <= 79);
  assert.match(singleMid, /Tokens 429k \(75% hit\)/);
  assert.doesNotMatch(singleMid, /tok\/s/);

  // 999,999 rounds to 1M, never "1000k".
  const nearMillion = render(basePayload, { config: cfg, tokenMetrics: { inputTokens: 999_999, cacheReadTokens: 0, outputTokens: 0 } }).split("\n")[2];
  assert.match(nearMillion, /^Tokens 1M /);
});

test("runCli keeps defaults off and tolerates malformed payload types", async () => {
  const convDir = makeStubDb("conv-cli");
  const rows = [{ data: encRow({ inp: 107_000, cache: 317_000, out: 5_000, ttft: [3, 900_000_000], gen: [44, 100_000_000] }) }];
  let sqliteLoads = 0;

  const run = async (cfgObj: Record<string, unknown>, payloadObj: Record<string, unknown>) => {
    const dir = tempDir("agy-hud-cli-");
    const cfgPath = path.join(dir, "cfg.json"), cachePath = path.join(dir, "cache.json");
    fs.writeFileSync(cfgPath, JSON.stringify(cfgObj));
    fs.writeFileSync(cachePath, JSON.stringify({ timestamp: new Date().toISOString(), models: {} }));
    // A background quota refresh would start a real `node quota refresh` against the live agy and
    // write into this temp dir after it is removed; point the spawn at a no-op script instead.
    const noop = path.join(dir, "noop.sh");
    fs.writeFileSync(noop, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    const prevCfg = process.env.AGY_HUD_CONFIG, prevCache = process.env.AGY_HUD_QUOTA_CACHE, prevArgv0 = process.argv[0];
    process.env.AGY_HUD_CONFIG = cfgPath;
    process.env.AGY_HUD_QUOTA_CACHE = cachePath;
    process.argv[0] = noop;
    let out = "";
    try {
      const code = await runCli(["statusline"], {
        stdin: Readable.from([JSON.stringify(payloadObj)]),
        stdout: s => { out += s; }, stderr: () => {},
        tokenMetricsConversationsDir: convDir,
        loadSqlite: () => { sqliteLoads += 1; return fakeSqlite(rows); }
      });
      assert.equal(code, 0);
    } finally {
      process.argv[0] = prevArgv0;
      if (prevCfg === undefined) delete process.env.AGY_HUD_CONFIG; else process.env.AGY_HUD_CONFIG = prevCfg;
      if (prevCache === undefined) delete process.env.AGY_HUD_QUOTA_CACHE; else process.env.AGY_HUD_QUOTA_CACHE = prevCache;
    }
    return strip(out).trimEnd();
  };

  const payload = { cwd: "agy-hud", conversation_id: "conv-cli", model: { display_name: "Gemini 4 Neon" }, context_window: { used_percentage: 10 }, agent_state: "idle", terminal_width: 120 };
  assert.equal((await run({ color: false }, payload)).split("\n").length, 2);
  assert.equal(sqliteLoads, 0);

  const on = (await run({ color: false, show_tokens: true, show_token_speed: true }, payload)).split("\n");
  assert.equal(on.length, 3);
  assert.equal(on[2], "Tokens 429k [in 107k · cache 317k (75%) · out 5k] │ TTFT 3.9s │ 104 tok/s");
  assert.equal(sqliteLoads, 1);

  const malformed = await run({ color: false, show_tokens: true, show_token_speed: true }, { ...payload, agent_state: 123, conversation_id: { bad: true } });
  assert.equal(malformed.split("\n").length, 2);
});
