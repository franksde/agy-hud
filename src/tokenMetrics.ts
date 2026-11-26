import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { TokenMetricsSource } from "./config";
import { Payload } from "./statusline";

export interface TokenMetrics {
  source: "transcript" | "db";
  // Cumulative uncached (newly billed) input tokens across the conversation.
  inputTokens: number;
  // Cumulative cache-read input tokens across the conversation, when known.
  cacheReadTokens?: number;
  // Cumulative cache-creation input tokens, when supplied by payload current_usage.
  cacheCreationTokens?: number;
  // Cumulative output tokens across the conversation (includes thinking when present).
  outputTokens: number;
  // Cumulative thinking tokens across the conversation (Plan B / db only).
  thinkingTokens?: number;
  // Latest completed (or in-flight sampled) model response output rate in tokens/second.
  tokensPerSecond?: number;
  // True when tokensPerSecond comes from status-line redraw sampling rather than DB decode duration.
  speedEstimated?: boolean;
  // Time-to-first-token of the latest model response in seconds (Plan B / db only).
  ttftSeconds?: number;
  // Number of model responses counted.
  turns?: number;
}

export interface DecodedGenMetadata {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  thinkingTokens?: number;
  responseTokens?: number;
  ttftSeconds?: number;
  genDurationSeconds?: number;
}

export interface SqliteStatement {
  all(...args: unknown[]): unknown[];
  run?(...args: unknown[]): unknown;
}

export interface SqliteDatabase {
  prepare(sql: string): SqliteStatement;
  exec?(sql: string): void;
  close(): void;
}

export interface SqliteModule {
  DatabaseSync: new (location: string, options?: { readOnly?: boolean }) => SqliteDatabase;
}

export interface CollectTokenMetricsOptions {
  source: TokenMetricsSource;
  statePath?: string;
  homedir?: string;
  conversationsDir?: string;
  now?: Date;
  loadSqlite?: () => SqliteModule | null;
}

interface TranscriptCursor {
  path: string;
  byteOffset: number;
  mtimeMs: number;
  size: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  turns: number;
  lastStepIndex: number;
}

interface SpeedSamplerState {
  conversationId: string;
  burstStartMs?: number;
  burstBaseOutputTokens?: number;
  lastAgentState?: string;
  lastTokensPerSecond?: number;
}

interface DbCursor {
  conversationId: string;
  path: string;
  fingerprint: string;
  dbSize: number;
  lastIdx: number;
  inputTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  turns: number;
  lastTokensPerSecond?: number;
  lastTtftSeconds?: number;
}

interface PersistedTokenState {
  transcript?: TranscriptCursor;
  sampler?: SpeedSamplerState;
  db?: DbCursor;
}

interface CurrentUsagePayload {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const maxTranscriptReadBytes = 32 * 1024 * 1024;
const minSampleOutputDelta = 5;
const minSampleDurationSec = 0.2;
const maxSampleDurationSec = 600;
const minDbDecodeDurationSec = 0.25;
const maxPlausibleTps = 5000;
const safeConversationIdPattern = /^[0-9A-Za-z_-]{1,128}$/;

let cachedSqliteModule: SqliteModule | null | undefined;

export function defaultLoadSqlite(): SqliteModule | null {
  if (cachedSqliteModule !== undefined) {
    return cachedSqliteModule;
  }
  const origEmitWarning = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...rest: unknown[]) => {
    const msg = typeof warning === "string" ? warning : warning?.message ?? "";
    if (msg.includes("SQLite")) {
      return;
    }
    return (origEmitWarning as (...args: unknown[]) => void).call(process, warning, ...rest);
  }) as typeof process.emitWarning;
  try {
    // Dynamic name prevents esbuild from bundling or failing on Node 18 targets where node:sqlite does not exist.
    const moduleName = "node:" + "sqlite";
    const loaded = require(moduleName) as Partial<SqliteModule>;
    cachedSqliteModule = typeof loaded?.DatabaseSync === "function" ? (loaded as SqliteModule) : null;
  } catch {
    cachedSqliteModule = null;
  } finally {
    process.emitWarning = origEmitWarning;
  }
  return cachedSqliteModule;
}

export function resolveConversationDbPath(
  conversationId: string | undefined,
  transcriptPath: string | undefined,
  homedir: string = os.homedir(),
  conversationsDir?: string
): string {
  const id = (conversationId ?? "").trim();
  if (!safeConversationIdPattern.test(id)) {
    return "";
  }
  if (conversationsDir) {
    return path.join(conversationsDir, `${id}.db`);
  }
  if (typeof transcriptPath === "string" && transcriptPath.trim() !== "") {
    const derived = appDataDirFromTranscript(transcriptPath.trim(), id);
    if (derived !== "") {
      return path.join(derived, "conversations", `${id}.db`);
    }
  }
  if (!homedir) {
    return "";
  }
  return path.join(homedir, ".gemini", "antigravity-cli", "conversations", `${id}.db`);
}

function appDataDirFromTranscript(transcriptPath: string, conversationId: string): string {
  let current = path.dirname(transcriptPath);
  for (let depth = 0; depth < 8; depth += 1) {
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    if (path.basename(current) === conversationId && path.basename(parent) === "brain") {
      const appDir = path.dirname(parent);
      return appDir !== parent ? appDir : "";
    }
    current = parent;
  }
  return "";
}

export function collectTokenMetrics(payload: Payload | null, opts: CollectTokenMetricsOptions): TokenMetrics | null {
  if (!payload) {
    return null;
  }
  const now = opts.now ?? new Date();
  const statePath = opts.statePath ?? "";
  const state = loadPersistedState(statePath);
  let dirty = false;

  const persist = () => {
    if (dirty && statePath !== "") {
      savePersistedState(statePath, state);
    }
  };

  if (opts.source === "db") {
    const res = collectFromDb(payload, state, opts);
    dirty = res.dirty;
    persist();
    return res.metrics;
  }

  if (opts.source === "auto") {
    const dbRes = collectFromDb(payload, state, opts);
    dirty = dirty || dbRes.dirty;
    if (dbRes.metrics !== null) {
      persist();
      return dbRes.metrics;
    }
  }

  const transcriptRes = collectFromTranscript(payload, state, now);
  dirty = dirty || transcriptRes.dirty;
  persist();
  return transcriptRes.metrics;
}

function collectFromTranscript(
  payload: Payload,
  state: PersistedTokenState,
  now: Date
): { metrics: TokenMetrics | null; dirty: boolean } {
  let dirty = false;
  const transcriptPath = typeof payload.transcript_path === "string" ? payload.transcript_path.trim() : "";

  let inputTokens = 0;
  let cacheReadTokens: number | undefined;
  let cacheCreationTokens: number | undefined;
  let outputTokens = 0;
  let turns: number | undefined;
  let hasData = false;

  if (transcriptPath !== "") {
    const updated = readTranscriptIncremental(transcriptPath, state.transcript);
    if (updated.dirty && updated.cursor) {
      state.transcript = updated.cursor;
      dirty = true;
    }
    if (updated.cursor && updated.cursor.turns > 0) {
      inputTokens = updated.cursor.inputTokens;
      cacheReadTokens = updated.cursor.cacheReadTokens;
      outputTokens = updated.cursor.outputTokens;
      turns = updated.cursor.turns;
      hasData = true;
    }
  }

  if (!hasData) {
    const fallback = readFromPayloadContext(payload.context_window);
    if (fallback) {
      inputTokens = fallback.inputTokens;
      cacheReadTokens = fallback.cacheReadTokens;
      cacheCreationTokens = fallback.cacheCreationTokens;
      outputTokens = fallback.outputTokens;
      hasData = true;
    }
  }

  const isModelActive = isActiveModelState(payload.agent_state);
  if (!hasData && !state.sampler && !isModelActive) {
    return { metrics: null, dirty };
  }

  const sampledOutputTokens = Math.max(outputTokens, finiteNonNeg(payload.context_window?.total_output_tokens) ?? 0);
  const sampled = updateSpeedSampler(state.sampler, payload, sampledOutputTokens, now);
  if (sampled.dirty) {
    state.sampler = sampled.sampler;
    dirty = true;
  }

  if (!hasData) {
    return { metrics: null, dirty };
  }

  return {
    dirty,
    metrics: {
      source: "transcript",
      inputTokens,
      cacheReadTokens,
      cacheCreationTokens,
      outputTokens,
      tokensPerSecond: sampled.tokensPerSecond,
      speedEstimated: sampled.tokensPerSecond !== undefined ? true : undefined,
      turns
    }
  };
}

function readTranscriptIncremental(
  transcriptPath: string,
  prev: TranscriptCursor | undefined
): { cursor: TranscriptCursor | null; dirty: boolean } {
  const stat = statOrNull(transcriptPath);
  if (!stat || !stat.isFile()) {
    return { cursor: null, dirty: false };
  }
  if (prev && prev.path === transcriptPath && prev.size === stat.size && prev.mtimeMs === stat.mtimeMs) {
    return { cursor: prev, dirty: false };
  }

  const reset = !prev || prev.path !== transcriptPath || stat.size < prev.byteOffset;
  const cursor: TranscriptCursor = reset
    ? {
        path: transcriptPath,
        byteOffset: 0,
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        turns: 0,
        lastStepIndex: -1
      }
    : { ...prev, mtimeMs: stat.mtimeMs, size: stat.size };

  const available = stat.size - cursor.byteOffset;
  if (available <= 0) {
    return { cursor, dirty: !prev || prev.mtimeMs !== stat.mtimeMs || prev.size !== stat.size };
  }

  const toRead = Math.min(available, maxTranscriptReadBytes);
  const buffer = Buffer.allocUnsafe(toRead);
  let bytesRead = 0;
  let fd: number | undefined;
  try {
    fd = fs.openSync(transcriptPath, "r");
    bytesRead = fs.readSync(fd, buffer, 0, toRead, cursor.byteOffset);
  } catch {
    return { cursor: prev && prev.path === transcriptPath ? prev : null, dirty: false };
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }

  if (bytesRead <= 0) {
    return { cursor, dirty: false };
  }

  // Only consume complete newline-terminated lines so a line currently being written by the CLI is
  // retried cleanly on the next redraw without splitting UTF-8 multibyte characters.
  const slice = buffer.subarray(0, bytesRead);
  const lastNewline = slice.lastIndexOf(0x0a);
  if (lastNewline < 0) {
    return { cursor, dirty: false };
  }

  const completeText = slice.subarray(0, lastNewline + 1).toString("utf8");
  cursor.byteOffset += lastNewline + 1;

  for (const rawLine of completeText.split("\n")) {
    if (!rawLine.includes('"PLANNER_RESPONSE"')) {
      continue;
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (parsed.type !== "PLANNER_RESPONSE") {
      continue;
    }
    if (parsed.status !== undefined && parsed.status !== "DONE") {
      continue;
    }
    const stepIndex = typeof parsed.step_index === "number" && Number.isInteger(parsed.step_index) ? parsed.step_index : -1;
    if (stepIndex >= 0 && stepIndex <= cursor.lastStepIndex) {
      continue;
    }
    const inp = finiteNonNeg(parsed.input_tokens);
    const cacheRead = finiteNonNeg(parsed.cache_read_tokens);
    const out = finiteNonNeg(parsed.output_tokens);
    if (inp === null && cacheRead === null && out === null) {
      continue;
    }
    cursor.inputTokens += inp ?? 0;
    cursor.cacheReadTokens += cacheRead ?? 0;
    cursor.outputTokens += out ?? 0;
    cursor.turns += 1;
    if (stepIndex >= 0) {
      cursor.lastStepIndex = stepIndex;
    }
  }

  return { cursor, dirty: true };
}

function readFromPayloadContext(ctx: Payload["context_window"]): {
  inputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  outputTokens: number;
} | null {
  if (!ctx) {
    return null;
  }
  const totalIn = finiteNonNeg(ctx.total_input_tokens);
  const totalOut = finiteNonNeg(ctx.total_output_tokens);
  const cu = isRecord(ctx.current_usage) ? (ctx.current_usage as CurrentUsagePayload) : null;

  if (cu) {
    const cuIn = finiteNonNeg(cu.input_tokens);
    const cuOut = finiteNonNeg(cu.output_tokens);
    const cuCacheRead = finiteNonNeg(cu.cache_read_input_tokens);
    const cuCacheCreate = finiteNonNeg(cu.cache_creation_input_tokens);
    const inputTokens = cuIn ?? totalIn ?? 0;
    const outputTokens = Math.max(cuOut ?? 0, totalOut ?? 0);
    if (inputTokens > 0 || outputTokens > 0 || (cuCacheRead ?? 0) > 0) {
      return {
        inputTokens,
        cacheReadTokens: cuCacheRead ?? undefined,
        cacheCreationTokens: cuCacheCreate ?? undefined,
        outputTokens
      };
    }
  }

  if ((totalIn ?? 0) > 0 || (totalOut ?? 0) > 0) {
    return {
      inputTokens: totalIn ?? 0,
      outputTokens: totalOut ?? 0
    };
  }
  return null;
}

function isActiveModelState(raw: string | undefined): boolean {
  const agentState = (raw ?? "").trim().toLowerCase();
  return agentState === "thinking" || agentState === "working";
}

function updateSpeedSampler(
  prev: SpeedSamplerState | undefined,
  payload: Payload,
  currentOutputTokens: number,
  now: Date
): { sampler: SpeedSamplerState; tokensPerSecond?: number; dirty: boolean } {
  const convId = (payload.conversation_id ?? "").trim();
  const agentState = (payload.agent_state ?? "").trim().toLowerCase();
  const isModelActive = isActiveModelState(agentState);
  const nowMs = now.getTime();

  const switched = prev !== undefined && convId !== "" && prev.conversationId !== "" && prev.conversationId !== convId;
  const next: SpeedSamplerState =
    !prev || switched
      ? {
          conversationId: convId,
          burstStartMs: isModelActive ? nowMs : undefined,
          burstBaseOutputTokens: currentOutputTokens,
          lastAgentState: agentState,
          lastTokensPerSecond: undefined
        }
      : { ...prev };

  if (convId !== "") {
    next.conversationId = convId;
  }

  if (next.burstBaseOutputTokens !== undefined && currentOutputTokens < next.burstBaseOutputTokens) {
    next.burstBaseOutputTokens = currentOutputTokens;
    next.burstStartMs = isModelActive ? nowMs : undefined;
  }

  if (next.burstStartMs !== undefined) {
    const deltaOut = currentOutputTokens - (next.burstBaseOutputTokens ?? 0);
    const elapsedSec = (nowMs - next.burstStartMs) / 1000;
    if (deltaOut >= minSampleOutputDelta && elapsedSec >= minSampleDurationSec && elapsedSec <= maxSampleDurationSec) {
      const tps = deltaOut / elapsedSec;
      if (Number.isFinite(tps) && tps > 0 && tps <= maxPlausibleTps) {
        next.lastTokensPerSecond = tps;
      }
    }
    if (!isModelActive) {
      next.burstStartMs = undefined;
      next.burstBaseOutputTokens = currentOutputTokens;
    }
  } else if (isModelActive) {
    next.burstStartMs = nowMs;
    next.burstBaseOutputTokens = currentOutputTokens;
  } else {
    next.burstBaseOutputTokens = currentOutputTokens;
  }

  next.lastAgentState = agentState;
  const dirty = !prev || JSON.stringify(prev) !== JSON.stringify(next);
  return { sampler: next, tokensPerSecond: next.lastTokensPerSecond, dirty };
}

function collectFromDb(
  payload: Payload,
  state: PersistedTokenState,
  opts: CollectTokenMetricsOptions
): { metrics: TokenMetrics | null; dirty: boolean } {
  const convId = (payload.conversation_id ?? "").trim();
  const dbPath = resolveConversationDbPath(convId, payload.transcript_path, opts.homedir, opts.conversationsDir);
  if (dbPath === "") {
    return { metrics: null, dirty: false };
  }
  const dbStat = statOrNull(dbPath);
  if (!dbStat || !dbStat.isFile()) {
    return { metrics: null, dirty: false };
  }
  const walStat = statOrNull(`${dbPath}-wal`);
  const fingerprint = `${dbPath}|${dbStat.mtimeMs}|${dbStat.size}|${walStat?.mtimeMs ?? 0}|${walStat?.size ?? 0}`;

  if (state.db && state.db.fingerprint === fingerprint && state.db.conversationId === convId) {
    return { metrics: dbCursorToMetrics(state.db), dirty: false };
  }

  const sqlite = (opts.loadSqlite ?? defaultLoadSqlite)();
  if (!sqlite) {
    return { metrics: null, dirty: false };
  }

  const canReuse =
    state.db !== undefined &&
    state.db.path === dbPath &&
    state.db.conversationId === convId &&
    state.db.lastIdx >= 0 &&
    dbStat.size >= state.db.dbSize;

  const cursor: DbCursor = canReuse
    ? { ...state.db!, fingerprint, dbSize: dbStat.size }
    : {
        conversationId: convId,
        path: dbPath,
        fingerprint,
        dbSize: dbStat.size,
        lastIdx: -1,
        inputTokens: 0,
        cacheReadTokens: 0,
        outputTokens: 0,
        thinkingTokens: 0,
        turns: 0
      };

  let db: SqliteDatabase | undefined;
  try {
    db = new sqlite.DatabaseSync(dbPath, { readOnly: true });
    const rows = db.prepare("SELECT idx, data FROM gen_metadata WHERE idx > ? ORDER BY idx").all(cursor.lastIdx);
    for (const rawRow of rows) {
      if (!isRecord(rawRow)) continue;
      const idx = typeof rawRow.idx === "number" && Number.isInteger(rawRow.idx) ? rawRow.idx : -1;
      const data = asUint8Array(rawRow.data);
      if (idx < 0 || !data) continue;
      if (idx > cursor.lastIdx) {
        cursor.lastIdx = idx;
      }
      const decoded = decodeGenMetadata(data);
      if (!decoded) continue;
      cursor.inputTokens += decoded.inputTokens;
      cursor.cacheReadTokens += decoded.cacheReadTokens;
      cursor.outputTokens += decoded.outputTokens;
      cursor.thinkingTokens += decoded.thinkingTokens ?? 0;
      cursor.turns += 1;

      const speed = computeDbSpeed(decoded);
      if (speed !== undefined) {
        cursor.lastTokensPerSecond = speed;
      }
      if (decoded.ttftSeconds !== undefined && decoded.ttftSeconds >= 0 && decoded.ttftSeconds <= 600) {
        cursor.lastTtftSeconds = decoded.ttftSeconds;
      }
    }
  } catch {
    return { metrics: null, dirty: false };
  } finally {
    if (db) {
      try {
        db.close();
      } catch {
        // ignore
      }
    }
  }

  state.db = cursor;
  return { metrics: dbCursorToMetrics(cursor), dirty: true };
}

function dbCursorToMetrics(cursor: DbCursor): TokenMetrics | null {
  if (cursor.turns <= 0) {
    return null;
  }
  return {
    source: "db",
    inputTokens: cursor.inputTokens,
    cacheReadTokens: cursor.cacheReadTokens,
    outputTokens: cursor.outputTokens,
    thinkingTokens: cursor.thinkingTokens > 0 ? cursor.thinkingTokens : undefined,
    tokensPerSecond: cursor.lastTokensPerSecond,
    speedEstimated: cursor.lastTokensPerSecond !== undefined ? false : undefined,
    ttftSeconds: cursor.lastTtftSeconds,
    turns: cursor.turns
  };
}

function computeDbSpeed(row: DecodedGenMetadata): number | undefined {
  if (row.outputTokens <= 0) {
    return undefined;
  }
  const gen = row.genDurationSeconds ?? 0;
  const ttft = row.ttftSeconds ?? 0;
  let duration = 0;
  if (gen >= minDbDecodeDurationSec) {
    duration = gen;
  } else if (ttft + gen >= minDbDecodeDurationSec) {
    duration = ttft + gen;
  } else {
    return undefined;
  }
  const tps = row.outputTokens / duration;
  if (!Number.isFinite(tps) || tps <= 0 || tps > maxPlausibleTps) {
    return undefined;
  }
  return tps;
}

// Pure Protobuf wire decoder for agy's internal `gen_metadata` table blobs:
//   f1 (msg):
//     f4 (msg, model_usage): f2=input_tokens, f3=output_tokens, f5=cache_read_tokens,
//                            f9=thinking_tokens, f10=response_tokens
//     f11 (Duration): TTFT (f1=seconds, f2=nanos)
//     f12 (Duration): generation/streaming duration (f1=seconds, f2=nanos)
export function decodeGenMetadata(bytes: Uint8Array): DecodedGenMetadata | null {
  if (bytes.length === 0) {
    return null;
  }
  let inner: Uint8Array | null = null;
  const rootOk = scanProto(bytes, (fieldNumber, wireType, varintVal, slice) => {
    if (fieldNumber === 1 && wireType === 2 && slice) {
      inner = slice;
    }
  });
  if (!rootOk || !inner) {
    return null;
  }

  let usageSlice: Uint8Array | null = null;
  let ttftSlice: Uint8Array | null = null;
  let genSlice: Uint8Array | null = null;
  const innerOk = scanProto(inner, (fieldNumber, wireType, _varintVal, slice) => {
    if (wireType !== 2 || !slice) return;
    if (fieldNumber === 4) usageSlice = slice;
    else if (fieldNumber === 11) ttftSlice = slice;
    else if (fieldNumber === 12) genSlice = slice;
  });
  if (!innerOk || !usageSlice) {
    return null;
  }

  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let thinkingTokens: number | undefined;
  let responseTokens: number | undefined;
  const usageOk = scanProto(usageSlice, (fieldNumber, wireType, varintVal) => {
    if (wireType !== 0 || varintVal === undefined) return;
    const n = safeNonNegBigInt(varintVal);
    if (n === null) return;
    if (fieldNumber === 2) inputTokens = n;
    else if (fieldNumber === 3) outputTokens = n;
    else if (fieldNumber === 5) cacheReadTokens = n;
    else if (fieldNumber === 9) thinkingTokens = n;
    else if (fieldNumber === 10) responseTokens = n;
  });
  if (!usageOk) {
    return null;
  }

  const ttftSeconds = ttftSlice ? decodeProtoDuration(ttftSlice) : undefined;
  const genDurationSeconds = genSlice ? decodeProtoDuration(genSlice) : undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    thinkingTokens,
    responseTokens,
    ttftSeconds,
    genDurationSeconds
  };
}

function decodeProtoDuration(bytes: Uint8Array): number | undefined {
  let seconds = 0;
  let nanos = 0;
  const ok = scanProto(bytes, (fieldNumber, wireType, varintVal) => {
    if (wireType !== 0 || varintVal === undefined) return;
    const n = safeNonNegBigInt(varintVal);
    if (n === null) return;
    if (fieldNumber === 1) seconds = n;
    else if (fieldNumber === 2) nanos = n;
  });
  if (!ok || nanos >= 1_000_000_000) {
    return undefined;
  }
  return seconds + nanos / 1e9;
}

function scanProto(
  bytes: Uint8Array,
  onField: (fieldNumber: number, wireType: number, varintVal?: bigint, slice?: Uint8Array) => void
): boolean {
  let offset = 0;
  const len = bytes.length;
  while (offset < len) {
    const keyRes = readVarint(bytes, offset);
    if (!keyRes) return false;
    offset = keyRes.nextOffset;
    const fieldNumber = Number(keyRes.value >> 3n);
    const wireType = Number(keyRes.value & 7n);
    if (fieldNumber <= 0 || !Number.isSafeInteger(fieldNumber)) return false;

    if (wireType === 0) {
      const valRes = readVarint(bytes, offset);
      if (!valRes) return false;
      offset = valRes.nextOffset;
      onField(fieldNumber, 0, valRes.value);
    } else if (wireType === 1) {
      if (offset + 8 > len) return false;
      offset += 8;
    } else if (wireType === 2) {
      const lenRes = readVarint(bytes, offset);
      if (!lenRes) return false;
      const chunkLen = safeNonNegBigInt(lenRes.value);
      if (chunkLen === null) return false;
      offset = lenRes.nextOffset;
      if (offset + chunkLen > len) return false;
      onField(fieldNumber, 2, undefined, bytes.subarray(offset, offset + chunkLen));
      offset += chunkLen;
    } else if (wireType === 5) {
      if (offset + 4 > len) return false;
      offset += 4;
    } else {
      return false;
    }
  }
  return true;
}

function readVarint(bytes: Uint8Array, start: number): { value: bigint; nextOffset: number } | null {
  let value = 0n;
  let shift = 0n;
  let offset = start;
  while (offset < bytes.length) {
    const b = bytes[offset];
    offset += 1;
    value |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return { value, nextOffset: offset };
    }
    shift += 7n;
    if (shift > 63n) {
      return null;
    }
  }
  return null;
}

function safeNonNegBigInt(value: bigint): number | null {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    return null;
  }
  return Number(value);
}

function loadPersistedState(statePath: string): PersistedTokenState {
  if (statePath === "") {
    return {};
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, "utf8")) as unknown;
    if (!isRecord(parsed)) {
      return {};
    }
    const out: PersistedTokenState = {};
    if (isValidTranscriptCursor(parsed.transcript)) {
      out.transcript = parsed.transcript;
    }
    if (isValidSamplerState(parsed.sampler)) {
      out.sampler = parsed.sampler;
    }
    if (isValidDbCursor(parsed.db)) {
      out.db = parsed.db;
    }
    return out;
  } catch {
    return {};
  }
}

function isValidTranscriptCursor(value: unknown): value is TranscriptCursor {
  if (!isRecord(value)) return false;
  return (
    typeof value.path === "string" &&
    finiteNonNeg(value.byteOffset) !== null &&
    typeof value.mtimeMs === "number" && Number.isFinite(value.mtimeMs) &&
    finiteNonNeg(value.size) !== null &&
    finiteNonNeg(value.inputTokens) !== null &&
    finiteNonNeg(value.cacheReadTokens) !== null &&
    finiteNonNeg(value.outputTokens) !== null &&
    finiteNonNeg(value.turns) !== null &&
    typeof value.lastStepIndex === "number" && Number.isInteger(value.lastStepIndex)
  );
}

function isValidSamplerState(value: unknown): value is SpeedSamplerState {
  if (!isRecord(value)) return false;
  return (
    typeof value.conversationId === "string" &&
    (value.burstStartMs === undefined || (typeof value.burstStartMs === "number" && Number.isFinite(value.burstStartMs))) &&
    (value.burstBaseOutputTokens === undefined || finiteNonNeg(value.burstBaseOutputTokens) !== null) &&
    (value.lastAgentState === undefined || typeof value.lastAgentState === "string") &&
    (value.lastTokensPerSecond === undefined || (typeof value.lastTokensPerSecond === "number" && Number.isFinite(value.lastTokensPerSecond) && value.lastTokensPerSecond > 0))
  );
}

function isValidDbCursor(value: unknown): value is DbCursor {
  if (!isRecord(value)) return false;
  return (
    typeof value.conversationId === "string" &&
    typeof value.path === "string" &&
    typeof value.fingerprint === "string" &&
    finiteNonNeg(value.dbSize) !== null &&
    typeof value.lastIdx === "number" && Number.isInteger(value.lastIdx) &&
    finiteNonNeg(value.inputTokens) !== null &&
    finiteNonNeg(value.cacheReadTokens) !== null &&
    finiteNonNeg(value.outputTokens) !== null &&
    finiteNonNeg(value.thinkingTokens) !== null &&
    finiteNonNeg(value.turns) !== null &&
    (value.lastTokensPerSecond === undefined || (typeof value.lastTokensPerSecond === "number" && Number.isFinite(value.lastTokensPerSecond) && value.lastTokensPerSecond > 0)) &&
    (value.lastTtftSeconds === undefined || finiteNonNeg(value.lastTtftSeconds) !== null)
  );
}

function savePersistedState(statePath: string, state: PersistedTokenState): void {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(statePath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.chmodSync(statePath, 0o600);
  } catch {
    // ignore
  }
}

function statOrNull(filePath: string): fs.Stats | null {
  try {
    return fs.statSync(filePath);
  } catch {
    return null;
  }
}

function finiteNonNeg(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asUint8Array(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) return value;
  if (Buffer.isBuffer(value)) return value;
  return null;
}
