import { Config } from "./config";
import { truncateColumns, visibleLen } from "./ansi";
import { Cache, matchModel, usagePercent as quotaUsagePercent } from "./quota";
import path from "node:path";

const colorReset = "\x1b[0m";
const colorBlue = "\x1b[34m";
const colorGreen = "\x1b[32m";
const colorYellow = "\x1b[33m";
const colorCyan = "\x1b[36m";
const colorMagenta = "\x1b[35m";
const colorRed = "\x1b[31m";
const colorOrange = "\x1b[38;5;208m";
const colorMuted = "\x1b[90m";

export interface Payload {
  cwd?: string;
  session_id?: string;
  conversation_id?: string;
  transcript_path?: string;
  email?: string;
  model?: {
    id?: string;
    display_name?: string;
  };
  context_window?: {
    total_input_tokens?: number;
    total_output_tokens?: number;
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    current_usage?: unknown;
  };
  quota?: Record<string, OfficialQuotaBucket>;
  agent_state?: string;
  plan_tier?: string;
  terminal_width?: number;
  vcs?: {
    type?: string;
    branch?: string;
    root?: string;
  };
  workspace?: {
    current_dir?: string;
    project_dir?: string;
  };
  cost?: {
    total_usd?: number;
    subagent_usd?: number;
    estimated?: boolean;
  };
}

interface OfficialQuotaBucket {
  remaining_fraction?: number;
  reset_time?: string;
  reset_in_seconds?: number;
}

interface QuotaWindowDisplay {
  label: string;
  usagePct: number;
  reset: string;
}

interface QuotaDisplay {
  usagePct: number;
  reset: string;
  hasQuota: boolean;
  windows: QuotaWindowDisplay[];
}

export interface RenderOptions {
  config: Config;
  quota?: Cache | null;
  gitBranch?: string;
  now?: Date;
}

export function shortModelName(display: string): string {
  let short = display.split("Gemini").join("");
  short = short.split("Claude").join("");
  short = short.split("Thinking").join("");
  short = short.split("(").join("");
  short = short.split(")").join("");
  short = short.split("Medium").join("Med");
  short = short.trim().split(/\s+/).filter(Boolean).join(" ");
  if (visibleLen(short) > 18) {
    short = `${truncateColumns(short, 15)}...`;
  }
  return short;
}

export function formatCost(usd: number): string {
  if (!Number.isFinite(usd) || usd <= 0) {
    return "$0.00";
  }
  if (usd >= 0.01) {
    return `$${usd.toFixed(2)}`;
  }
  if (usd >= 0.001) {
    return `$${usd.toFixed(3)}`;
  }
  return "<$0.001";
}

function renderCost(cost: Payload["cost"], config: Config): string {
  const usd = cost?.total_usd;
  if (!config.showCost || typeof usd !== "number" || !Number.isFinite(usd) || usd < 0) return "";
  return colorize(`${cost?.estimated === true ? "~" : ""}${formatCost(usd)}`, colorCyan, config.color);
}

export function render(payload: Payload, opts: RenderOptions): string {
  const config = opts.config;
  const width = (payload.terminal_width ?? 0) <= 0 ? 80 : payload.terminal_width!;
  const modelDisplay = payload.model?.display_name || payload.model?.id || "Gemini";
  const modelSegment = renderModelSegment(shortModelName(modelDisplay), payload.plan_tier ?? "", config);
  const ctxPct = contextPercent(payload.context_window);
  const stateLabel = state(payload.agent_state ?? "");
  const quota = quotaInfo(opts.quota, modelDisplay, payload.quota, opts.now ?? new Date());
  if (config.multiline) {
    return renderMultiline(payload, config, width, modelSegment, ctxPct, quota, opts.gitBranch ?? "", stateLabel);
  }
  return renderSingleLine(payload, config, width, modelSegment, ctxPct, quota, stateLabel);
}

function renderMultiline(payload: Payload, config: Config, width: number, modelSegment: string, ctxPct: number, quota: QuotaDisplay, branch: string, stateLabel: string): string {
  const line1Parts = [colorize(modelSegment, colorBlue, config.color)];
  if (config.showCWD && payload.cwd) {
    line1Parts.push(colorize(withIcon(config, " ", "") + path.basename(payload.cwd), colorYellow, config.color));
  }
  if (config.showGitBranch && branch !== "") {
    line1Parts.push(colorize(renderGitSegment(branch, config), colorMagenta, config.color));
  }
  const stateText = config.showAgentState ? colorize(stateLabel, stateColor(stateLabel), config.color) : "";
  line1Parts.push(stateText);
  const costText = renderCost(payload.cost, config);
  let line1 = joinHeader(...line1Parts, costText);
  if (visibleLen(line1) > width) {
    line1 = joinHeader(...line1Parts);
  }
  if (visibleLen(line1) > width) {
    const git = config.showGitBranch && branch !== "" ? colorize(renderGitSegment(branch, config), colorMagenta, config.color) : "";
    line1 = joinHeader(colorize(modelSegment, colorBlue, config.color), git, stateText);
  }
  if (visibleLen(line1) > width) {
    line1 = joinHeader(colorize(modelSegment, colorBlue, config.color), stateText);
  }
  if (visibleLen(line1) > width) {
    line1 = colorize(modelSegment, colorBlue, config.color);
  }
  line1 = fit(line1, width);

  let ctx = "Context ";
  if (config.showProgressBar) {
    ctx += `${progressBar(ctxPct, 10, config.color)} `;
  }
  ctx += contextValue(config, payload.context_window, ctxPct);

  let usage = "";
  if (quota.hasQuota) {
    usage = usageLabel(config, quota, true);
    if (quota.windows.length <= 1 && quota.reset !== "") {
      usage += resetSuffix(config, quota.reset);
    }
  }
  let line2 = joinHeader(ctx, usage);
  if (visibleLen(line2) > width) {
    let usageNoBar = "";
    if (quota.hasQuota) {
      usageNoBar = usageLabel(config, quota, false);
      if (quota.windows.length <= 1 && quota.reset !== "") {
        usageNoBar += resetSuffix(config, quota.reset);
      }
    }
    line2 = joinHeader(`Context ${contextValue(config, payload.context_window, ctxPct)}`, usageNoBar);
  }
  if (visibleLen(line2) > width) {
    let usageCompact = "";
    if (quota.hasQuota) {
      usageCompact = usageLabel(config, quota, false);
      if (quota.windows.length <= 1 && quota.reset !== "") {
        usageCompact += resetSuffix(config, quota.reset);
      }
    }
    line2 = joinHeader(`Context ${formatInt(ctxPct)}%`, usageCompact);
  }
  if (visibleLen(line2) > width) {
    let coreUsage = "";
    if (quota.hasQuota) {
      coreUsage = `Use ${usageValue(config, quota.usagePct)}`;
    }
    line2 = join(`Ctx ${formatInt(ctxPct)}%`, coreUsage);
  }
  if (visibleLen(line2) > width) {
    line2 = `${formatInt(ctxPct)}%`;
  }
  line2 = fit(line2, width);
  return `${line1}\n${line2}`;
}

function renderSingleLine(payload: Payload, config: Config, width: number, modelSegment: string, ctxPct: number, quota: QuotaDisplay, stateLabel: string): string {
  const coloredBadge = colorize(modelSegment, colorBlue, config.color);
  const ctx = `Ctx ${contextValue(config, payload.context_window, ctxPct)}`;
  let tokens = tokenDetail(payload.context_window);
  if (tokens !== "" && config.contextValue === "percent") {
    tokens = colorize(tokens, colorMuted, config.color);
  } else {
    tokens = "";
  }
  let usage = "";
  if (quota.hasQuota) {
    let text = usageLabel(config, quota, false);
    if (quota.windows.length <= 1 && quota.reset !== "") {
      text += resetSuffix(config, quota.reset);
    }
    usage = colorize(text, colorMuted, config.color);
  }
  const stateText = config.showAgentState ? colorize(stateLabel, stateColor(stateLabel), config.color) : "";
  const costText = renderCost(payload.cost, config);
  let bar = "";
  if (config.showProgressBar) {
    bar = progressBar(ctxPct, 10, config.color);
  }
  const levels = [
    [coloredBadge, ctx, tokens, bar, usage, stateText, costText],
    [coloredBadge, ctx, tokens, bar, usage, stateText],
    [coloredBadge, ctx, bar, usage, stateText],
    [coloredBadge, ctx, usage, stateText],
    [coloredBadge, ctx, stateText],
    [ctx, stateText],
    [`${formatInt(ctxPct)}%`, stateLabel]
  ];
  for (const parts of levels) {
    const line = join(...parts);
    if (visibleLen(line) <= width) {
      return line;
    }
  }
  return fit(`${formatInt(ctxPct)}% ${stateLabel}`, width);
}

function renderModelSegment(shortModel: string, rawPlan: string, config: Config): string {
  const trimmed = rawPlan.trim();
  const knownTier = trimmed.match(/^(?:Google AI\s+)?(Pro|Ultra|Free)$/i);
  const plan = knownTier ? title(knownTier[1]) : "Plan ?";
  if (config.showModel && shortModel !== "") {
    return `${withIcon(config, " ", "")}${shortModel} | ${renderPlan(plan, config)}`;
  }
  if (plan === "Pro") {
    return `${withIcon(config, " ", "")}${renderPlan(plan, config)} Tier`;
  }
  return `${withIcon(config, " ", "")}${plan}`;
}

function renderPlan(plan: string, config: Config): string {
  if (plan === "Pro") {
    return `${withIcon(config, " ", "")}Pro`;
  }
  return plan;
}

function renderGitSegment(branch: string, config: Config): string {
  if (branch === "git") {
    return `${withIcon(config, " ", "")}git`;
  }
  return `${withIcon(config, " ", "")}${branch}`;
}

function resetSuffix(config: Config, reset: string): string {
  return ` ${withIcon(config, "↻ ", "")}Reset ${reset}`;
}

function inlineResetSuffix(config: Config, reset: string): string {
  if (reset === "") {
    return "";
  }
  return ` (${withIcon(config, "↻ ", "")}${reset})`;
}

function withIcon(config: Config, icon: string, fallback: string): string {
  return config.showIcons ? icon : fallback;
}

function quotaInfo(cache: Cache | null | undefined, modelDisplay: string, officialQuota: Record<string, OfficialQuotaBucket> | undefined, now: Date): QuotaDisplay {
  const cacheInfo = cacheQuotaInfo(cache, modelDisplay);
  const official = officialQuotaInfo(officialQuota, modelDisplay);
  if (official !== null) {
    if (official.hasQuota && cacheInfo !== null && cacheInfo.hasQuota && cacheIsFresh(cache, now)) {
      return mergeFreshCacheQuota(official, cacheInfo);
    }
    return official;
  }
  if (cacheInfo !== null) {
    return cacheInfo;
  }
  return noQuota();
}

function cacheQuotaInfo(cache: Cache | null | undefined, modelDisplay: string): QuotaDisplay | null {
  const [quota, ok] = matchModel(cache, modelDisplay);
  if (!ok || quota === null) {
    return null;
  }
  const usagePct = quotaUsagePercent(quota);
  const reset = usagePct > 0 ? formatResetClock(quota.resetTime) : "";
  return quotaDisplay([{ label: "", usagePct, reset }]);
}

function cacheIsFresh(cache: Cache | null | undefined, now: Date): boolean {
  if (!cache?.timestamp) {
    return false;
  }
  const cacheTime = new Date(cache.timestamp);
  if (Number.isNaN(cacheTime.getTime())) {
    return false;
  }
  return now.getTime() - cacheTime.getTime() <= 5 * 60 * 1000;
}

function officialQuotaInfo(officialQuota: Record<string, OfficialQuotaBucket> | undefined, modelDisplay: string): QuotaDisplay | null {
  if (!officialQuota) {
    return null;
  }
  const keys = officialQuotaKeys(modelDisplay);
  const buckets: QuotaWindowDisplay[] = [];
  let sawKnownBucket = false;
  for (const { key, label } of keys) {
    if (!Object.prototype.hasOwnProperty.call(officialQuota, key)) {
      continue;
    }
    sawKnownBucket = true;
    const bucket = officialQuota[key];
    if (Number.isFinite(bucket.remaining_fraction)) {
      const usagePct = quotaUsagePercent({
        remainingFraction: bucket.remaining_fraction ?? 1,
        resetTime: bucket.reset_time ?? ""
      });
      const reset = usagePct > 0 ? formatOfficialReset(bucket) : "";
      buckets.push({ label, usagePct, reset });
    }
  }
  if (buckets.length === 0) {
    return sawKnownBucket ? noQuota() : null;
  }
  return quotaDisplay(buckets);
}

function mergeFreshCacheQuota(official: QuotaDisplay, cache: QuotaDisplay): QuotaDisplay {
  if (!cache.hasQuota || cache.windows.length === 0) {
    return official;
  }
  const cacheWindow = cache.windows[0];
  const windows = official.windows.map(window => {
    if (window.label !== "5h") {
      return window;
    }
    if (cacheWindow.usagePct <= window.usagePct) {
      return window;
    }
    return { ...window, usagePct: cacheWindow.usagePct, reset: cacheWindow.reset };
  });
  const hasFiveHourWindow = windows.some(window => window.label === "5h");
  if (!hasFiveHourWindow && cacheWindow.usagePct > official.usagePct) {
    return cache;
  }
  return quotaDisplay(windows);
}

function quotaDisplay(windows: QuotaWindowDisplay[]): QuotaDisplay {
  let selected = windows[0] ?? { label: "", usagePct: 0, reset: "" };
  for (const window of windows.slice(1)) {
    if (window.usagePct > selected.usagePct) {
      selected = window;
    }
  }
  return {
    usagePct: selected.usagePct,
    reset: selected.reset,
    hasQuota: windows.length > 0,
    windows
  };
}

function noQuota(): QuotaDisplay {
  return { usagePct: 0, reset: "", hasQuota: false, windows: [] };
}

function officialQuotaKeys(modelDisplay: string): Array<{ key: string; label: string }> {
  const normalized = modelDisplay.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("gpt") || normalized.includes("oss")) {
    return [{ key: "3p-5h", label: "5h" }, { key: "3p-weekly", label: "W" }];
  }
  return [{ key: "gemini-5h", label: "5h" }, { key: "gemini-weekly", label: "W" }];
}

function formatResetClock(reset: string): string {
  if (reset === "") {
    return "";
  }
  const target = new Date(reset.replace("Z", "+00:00"));
  if (Number.isNaN(target.getTime())) {
    return "";
  }
  return `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
}

function formatOfficialReset(bucket: OfficialQuotaBucket): string {
  if (Number.isFinite(bucket.reset_in_seconds) && (bucket.reset_in_seconds ?? 0) > 0) {
    return formatResetDuration(bucket.reset_in_seconds ?? 0);
  }
  return formatResetClock(bucket.reset_time ?? "");
}

function formatResetDuration(seconds: number): string {
  let totalMinutes = Math.max(0, Math.trunc(seconds / 60));
  const days = Math.trunc(totalMinutes / (24 * 60));
  totalMinutes -= days * 24 * 60;
  const hours = Math.trunc(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) {
    return `${formatInt(days)}d ${formatInt(hours)}h`;
  }
  if (hours > 0) {
    return `${formatInt(hours)}h ${formatInt(minutes)}m`;
  }
  return `${formatInt(minutes)}m`;
}

function contextValue(config: Config, ctx: Payload["context_window"], pct: number): string {
  const tokens = tokenDetail(ctx);
  switch (config.contextValue) {
    case "tokens":
      if (tokens !== "") {
        return tokens.replace(/^\(/, "").replace(/\)$/, "");
      }
      break;
    case "both":
      if (tokens !== "") {
        return `${formatInt(pct)}% ${tokens}`;
      }
      break;
  }
  return `${formatInt(pct)}%`;
}

function contextPercent(ctx: Payload["context_window"]): number {
  const inputTokens = ctx?.total_input_tokens ?? 0;
  const windowSize = ctx?.context_window_size ?? 0;
  if (Number.isFinite(inputTokens) && Number.isFinite(windowSize) && inputTokens > 0 && windowSize > 0) {
    return clampInt(Math.trunc((inputTokens / windowSize) * 100 + 0.5));
  }

  const upstream = ctx?.used_percentage ?? 0;
  if (!Number.isFinite(upstream)) {
    return 0;
  }
  return clampInt(Math.trunc(upstream + 0.5));
}

function usageLabel(config: Config, quota: QuotaDisplay, withBar: boolean): string {
  if (quota.windows.length > 1) {
    return `Usage ${quota.windows.map(window => usageWindowLabel(config, window, withBar)).join(" |  ")}`;
  }
  let label = "Usage ";
  if (withBar && config.showProgressBar) {
    label += `${usageBar(config, quota.usagePct)} `;
  }
  return label + usageValue(config, quota.usagePct);
}

function usageWindowLabel(config: Config, window: QuotaWindowDisplay, withBar: boolean): string {
  let label = "";
  if (withBar && config.showProgressBar) {
    label += `${usageBar(config, window.usagePct, 10)} `;
  }
  return label + usageWindowValue(config, window.usagePct) + inlineResetSuffix(config, window.reset);
}

function usageWindowValue(config: Config, usagePct: number): string {
  if (config.usageValue === "remaining") {
    return `${formatInt(100 - usagePct)}%`;
  }
  return `${formatInt(usagePct)}%`;
}

function usageValue(config: Config, usagePct: number): string {
  if (config.usageValue === "remaining") {
    return `${formatInt(100 - usagePct)}% left`;
  }
  return `${formatInt(usagePct)}%`;
}

function usageBar(config: Config, usagePct: number, width = 8): string {
  const fillPct = config.usageValue === "remaining" ? 100 - usagePct : usagePct;
  return progressBarWithColor(fillPct, usagePct, width, config.color);
}

function tokenDetail(ctx: Payload["context_window"]): string {
  const total = ctx?.total_input_tokens;
  const windowSize = ctx?.context_window_size ?? 0;
  if (typeof total !== "number" || total <= 0 || windowSize <= 0) {
    return "";
  }
  return `(${formatTokens(total)}/${formatTokens(windowSize)})`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) {
    if (n % 1_000_000 === 0) {
      return `${formatInt(n / 1_000_000)}M`;
    }
    return `${Number((n / 1_000_000).toFixed(1))}M`;
  }
  if (n >= 1000) {
    return `${formatInt((n + 500) / 1000)}k`;
  }
  return formatInt(n);
}

function progressBar(pct: number, width: number, color: boolean): string {
  return progressBarWithColor(pct, pct, width, color);
}

function progressBarWithColor(fillPct: number, colorPct: number, width: number, color: boolean): string {
  fillPct = clampInt(fillPct);
  colorPct = clampInt(colorPct);
  let filled = Math.trunc((fillPct / 100) * width + 0.5);
  if (filled < 0) filled = 0;
  if (filled > width) filled = width;
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  if (!color) {
    return bar;
  }
  return colorize(bar, percentageColor(colorPct), true);
}

function percentageColor(pct: number): string {
  if (pct >= 90) return colorRed;
  if (pct >= 75) return colorOrange;
  if (pct >= 50) return colorYellow;
  return colorGreen;
}

function state(raw: string): string {
  switch (raw.toLowerCase()) {
    case "":
    case "idle":
      return "Idle";
    case "thinking":
      return "Thinking";
    case "authenticating":
      return "Auth";
    default:
      return title(raw);
  }
}

function stateColor(label: string): string {
  switch (label) {
    case "Idle":
      return colorGreen;
    case "Thinking":
      return colorYellow;
    case "Auth":
      return colorCyan;
    default:
      return colorCyan;
  }
}

function colorize(input: string, colorCode: string, enabled: boolean): string {
  if (!enabled || input === "") {
    return input;
  }
  return `${colorCode}${input}${colorReset}`;
}

function join(...parts: string[]): string {
  return parts.filter(part => part !== "").join("  ");
}

function joinHeader(...parts: string[]): string {
  return parts.filter(part => part !== "").join(" │ ");
}

function fit(input: string, width: number): string {
  if (width <= 0 || visibleLen(input) <= width) {
    return input;
  }
  return truncateColumns(input, width);
}

function clampInt(n: number): number {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

function formatInt(n: number): string {
  return Math.trunc(n).toString(10);
}

function pad2(n: number): string {
  if (n < 10) {
    return `0${formatInt(n)}`;
  }
  return formatInt(n);
}

function title(raw: string): string {
  const fields = raw.trim().split(/\s+/).filter(Boolean);
  for (let i = 0; i < fields.length; i++) {
    const runes = Array.from(fields[i].toLowerCase());
    if (runes.length > 0 && runes[0] >= "a" && runes[0] <= "z") {
      runes[0] = runes[0].toUpperCase();
    }
    fields[i] = runes.join("");
  }
  if (fields.length === 0) {
    return "Active";
  }
  return fields.join(" ");
}
