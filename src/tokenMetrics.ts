import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Payload } from "./statusline";

export interface TokenMetrics {
  inputTokens: number;
  cacheReadTokens?: number;
  outputTokens: number;
  tokensPerSecond?: number;
  ttftSeconds?: number;
}

export interface DecodedGenMetadata { inputTokens: number; outputTokens: number; cacheReadTokens: number; ttftSeconds?: number; genDurationSeconds?: number; }
export interface SqliteDatabase { prepare(sql: string): { all(...args: unknown[]): unknown[]; run?(...args: unknown[]): unknown }; exec?(sql: string): void; close(): void; }
export interface SqliteModule { DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase; }

export interface CollectTokenMetricsOptions {
  includeCounts: boolean;
  includeSpeed: boolean;
  homedir?: string;
  conversationsDir?: string;
  loadSqlite?: () => SqliteModule | null;
}

const safeConversationId = /^[0-9A-Za-z_-]{1,128}$/;
let cachedSqlite: SqliteModule | null | undefined;

// node:sqlite is unflagged from 22.13 / 23.4. Earlier releases need --experimental-sqlite, and
// before 22.12 that build ignores readOnly and opens the CLI's live DB read-write, so the version
// gate, not the module's presence, decides whether it is safe to use.
export function sqliteSupported(version = process.versions.node): boolean {
  const [major, minor] = version.split(".").map(Number);
  return major > 23 || (major === 23 && minor >= 4) || (major === 22 && minor >= 13);
}

export function defaultLoadSqlite(): SqliteModule | null {
  if (cachedSqlite !== undefined) return cachedSqlite;
  if (!sqliteSupported()) return (cachedSqlite = null);
  const orig = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if ((typeof w === "string" ? w : w?.message ?? "").includes("SQLite")) return;
    return (orig as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    // Required lazily: the version gate above keeps older Node, where it does not exist, away.
    const mod = require("node:sqlite") as Partial<SqliteModule>;
    cachedSqlite = typeof mod?.DatabaseSync === "function" ? (mod as SqliteModule) : null;
  } catch { cachedSqlite = null; } finally { process.emitWarning = orig; }
  return cachedSqlite;
}

export function resolveConversationDbPath(id: unknown, homedir = os.homedir(), conversationsDir?: string): string | null {
  if (typeof id !== "string" || !safeConversationId.test(id)) return null;
  const dir = conversationsDir || (homedir ? path.join(homedir, ".gemini", "antigravity-cli", "conversations") : "");
  return dir ? path.join(dir, `${id}.db`) : null;
}

export function collectTokenMetrics(payload: Payload | null, opts: CollectTokenMetricsOptions): TokenMetrics | null {
  if (!payload || (!opts.includeCounts && !opts.includeSpeed)) return null;
  const dbPath = resolveConversationDbPath(payload.conversation_id, opts.homedir, opts.conversationsDir);
  // A read-only open of a WAL database creates missing -wal/-shm files, so only open one whose
  // sidecars already exist, as they do while agy has the conversation open.
  if (!dbPath || ![dbPath, `${dbPath}-wal`, `${dbPath}-shm`].every(isFile)) return null;

  let inputTokens = 0, cacheReadTokens = 0, outputTokens = 0;
  let last: DecodedGenMetadata | null = null, decoded = false;
  let db: SqliteDatabase | undefined;
  try {
    const sqlite = (opts.loadSqlite ?? defaultLoadSqlite)();
    if (!sqlite) return null;
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    for (const row of db.prepare("SELECT data FROM gen_metadata ORDER BY idx").all()) {
      const data = typeof row === "object" && row !== null ? (row as Record<string, unknown>).data : null;
      const d = data instanceof Uint8Array ? decodeGenMetadata(data) : null;
      if (!d) continue;
      inputTokens += d.inputTokens;
      cacheReadTokens += d.cacheReadTokens;
      outputTokens += d.outputTokens;
      decoded = true;
      // Some conversations end with an all-zero row; TTFT and speed come from the latest real response.
      if (d.outputTokens > 0) last = d;
    }
  } catch { return null; } finally { try { db?.close(); } catch { /* ignore */ } }
  if (!decoded || ![inputTokens, cacheReadTokens, outputTokens].every(Number.isSafeInteger)) return null;

  let ttftSeconds: number | undefined, tokensPerSecond: number | undefined;
  if (opts.includeSpeed && last) {
    const ttft = last.ttftSeconds, gen = last.genDurationSeconds;
    if (ttft !== undefined && ttft > 0 && ttft <= 600) ttftSeconds = ttft;
    // Thinking happens before the first token, so the speed spans TTFT plus generation.
    if (ttftSeconds !== undefined && gen !== undefined && gen > 0 && ttftSeconds + gen >= 0.25 && last.outputTokens > 0) {
      const tps = last.outputTokens / (ttftSeconds + gen);
      if (Number.isFinite(tps) && tps <= 5000) tokensPerSecond = tps;
    }
  }
  const hasCounts = opts.includeCounts && (inputTokens > 0 || cacheReadTokens > 0 || outputTokens > 0);
  if (!hasCounts && ttftSeconds === undefined && tokensPerSecond === undefined) return null;
  return {
    inputTokens: opts.includeCounts ? inputTokens : 0,
    cacheReadTokens: opts.includeCounts ? cacheReadTokens : undefined,
    outputTokens: opts.includeCounts ? outputTokens : 0,
    ttftSeconds,
    tokensPerSecond
  };
}

// Protobuf wire decoder for agy's `gen_metadata` blobs:
// f1 -> f4 (f2=input, f3=output, f5=cache_read), f11 (Duration TTFT), f12 (Duration gen).
export function decodeGenMetadata(bytes: Uint8Array): DecodedGenMetadata | null {
  if (bytes.length === 0) return null;
  let inner: Uint8Array | null = null;
  if (!scanProto(bytes, (f, w, _v, s) => { if (f === 1 && w === 2 && s) inner = s; }) || !inner) return null;
  let usage: Uint8Array | null = null, ttft: Uint8Array | null = null, gen: Uint8Array | null = null;
  if (!scanProto(inner, (f, w, _v, s) => {
    if (w !== 2 || !s) return;
    if (f === 4) usage = s; else if (f === 11) ttft = s; else if (f === 12) gen = s;
  }) || !usage) return null;
  let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, valid = true;
  if (!scanProto(usage, (f, w, v) => {
    if (f !== 2 && f !== 3 && f !== 5) return;
    // A count of the wrong wire type or beyond 2^53 rejects the whole row rather than skewing totals.
    const n = w === 0 && v !== undefined ? safeNonNeg(v) : null;
    if (n === null) { valid = false; return; }
    if (f === 2) inputTokens = n; else if (f === 3) outputTokens = n; else cacheReadTokens = n;
  }) || !valid) return null;
  return {
    inputTokens, outputTokens, cacheReadTokens,
    ttftSeconds: ttft ? decodeDuration(ttft) : undefined,
    genDurationSeconds: gen ? decodeDuration(gen) : undefined
  };
}

function decodeDuration(bytes: Uint8Array): number | undefined {
  let seconds = 0, nanos = 0, valid = true;
  const ok = scanProto(bytes, (f, w, v) => {
    if (w !== 0 || v === undefined || (f !== 1 && f !== 2)) return;
    const n = safeNonNeg(v);
    if (n === null) { valid = false; return; }
    if (f === 1) seconds = n; else nanos = n;
  });
  return ok && valid && nanos < 1_000_000_000 ? seconds + nanos / 1e9 : undefined;
}

function scanProto(bytes: Uint8Array, onField: (f: number, w: number, v?: bigint, s?: Uint8Array) => void): boolean {
  let off = 0;
  while (off < bytes.length) {
    const key = readVarint(bytes, off);
    if (!key) return false;
    off = key.next;
    const f = Number(key.val >> 3n), w = Number(key.val & 7n);
    if (f <= 0 || !Number.isSafeInteger(f)) return false;
    if (w === 0) {
      const v = readVarint(bytes, off);
      if (!v) return false;
      off = v.next;
      onField(f, 0, v.val);
    } else if (w === 1 || w === 5) {
      const step = w === 1 ? 8 : 4;
      if (off + step > bytes.length) return false;
      off += step;
    } else if (w === 2) {
      const len = readVarint(bytes, off), size = len ? safeNonNeg(len.val) : null;
      if (!len || size === null || len.next + size > bytes.length) return false;
      off = len.next;
      onField(f, 2, undefined, bytes.subarray(off, off + size));
      off += size;
    } else return false;
  }
  return true;
}

function readVarint(bytes: Uint8Array, off: number): { val: bigint; next: number } | null {
  let val = 0n, shift = 0n;
  while (off < bytes.length) {
    const b = bytes[off++];
    if (shift === 63n && b > 1) return null; // more than 64 bits
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { val, next: off };
    if ((shift += 7n) > 63n) return null;
  }
  return null;
}

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile(); } catch { return false; }
}

const safeNonNeg = (v: bigint): number | null =>
  v >= 0n && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : null;
