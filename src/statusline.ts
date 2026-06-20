import { Config } from "./config";
import { strip, visibleLen } from "./ansi";
import { Cache, matchModel, usagePercent as quotaUsagePercent, formatResetDuration } from "./quota";
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
}

interface OfficialQuotaBucket {
  remaining_fraction?: number;
  reset_time?: string;
  reset_in_seconds?: number;
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
  const runes = Array.from(short);
  if (runes.length > 18) {
    short = `${runes.slice(0, 15).join("")}...`;
  }
  return short;
}

export function render(payload: Payload, opts: RenderOptions): string {
  const config = opts.config;
  const width = (payload.terminal_width ?? 0) <= 0 ? 80 : payload.terminal_width!;
  const modelDisplay = payload.model?.display_name || payload.model?.id || "Gemini";
  const modelSegment = renderModelSegment(shortModelName(modelDisplay), payload.plan_tier ?? "", config);
  const ctxPct = contextPercent(payload.context_window);
  const stateLabel = state(payload.agent_state ?? "");
  const quotas = getQuotas(opts.quota, modelDisplay, config, opts.now ?? new Date(), payload.quota);
  if (config.multiline) {
    return renderMultiline(payload, config, width, modelSegment, ctxPct, quotas, opts.gitBranch ?? "", stateLabel);
  }
  return renderSingleLine(payload, config, width, modelSegment, ctxPct, quotas, stateLabel);
}

function renderMultiline(payload: Payload, config: Config, width: number, modelSegment: string, ctxPct: number, quotas: QuotaResult[], branch: string, stateLabel: string): string {
  const line1Parts = [colorize(modelSegment, colorBlue, config.color)];
  if (config.showCWD && payload.cwd) {
    line1Parts.push(colorize(withIcon(config, " ", "") + path.basename(payload.cwd), colorYellow, config.color));
  }
  if (config.showGitBranch && branch !== "") {
    line1Parts.push(colorize(renderGitSegment(branch, config), colorMagenta, config.color));
  }
  let line1 = joinHeader(...line1Parts);
  if (visibleLen(line1) > width) {
    line1 = joinHeader(colorize(modelSegment, colorBlue, config.color), colorize(renderGitSegment(branch, config), colorMagenta, config.color));
  }
  if (visibleLen(line1) > width) {
    line1 = colorize(modelSegment, colorBlue, config.color);
  }
  line1 = fit(line1, width);

  let ctx = "Context ";
  if (config.showProgressBar) {
    ctx += `${progressBar(ctxPct, 8, config.color)} `;
  }
  ctx += contextValue(config, payload.context_window, ctxPct);

  let usage = "";
  if (quotas.length > 0) {
    usage = joinHeader(...quotas.map(q => {
      let u = usageLabel(config, q.usagePct, true, q.label);
      if (q.reset !== "") u += resetSuffix(config, q.reset);
      return u;
    }));
  }
  const stateText = config.showAgentState ? colorize(stateLabel, stateColor(stateLabel), config.color) : "";
  let line2 = joinHeader(ctx, usage, stateText);
  if (visibleLen(line2) > width) {
    let usageNoBar = "";
    if (quotas.length > 0) {
      usageNoBar = joinHeader(...quotas.map(q => {
        let u = usageLabel(config, q.usagePct, false, q.label);
        if (q.reset !== "") u += resetSuffix(config, q.reset);
        return u;
      }));
    }
    line2 = joinHeader(`Context ${contextValue(config, payload.context_window, ctxPct)}`, usageNoBar, stateText);
  }
  if (visibleLen(line2) > width) {
    let usageCompact = "";
    if (quotas.length > 0) {
      const q = quotas[0];
      usageCompact = usageLabel(config, q.usagePct, false, q.label);
      if (q.reset !== "") usageCompact += resetSuffix(config, q.reset);
    }
    line2 = joinHeader(`Context ${formatInt(ctxPct)}%`, usageCompact, stateText);
  }
  if (visibleLen(line2) > width) {
    let coreUsage = "";
    if (quotas.length > 0) {
      coreUsage = `Use ${usageValue(config, quotas[0].usagePct)}`;
    }
    line2 = join(`Ctx ${formatInt(ctxPct)}%`, coreUsage, stateText);
  }
  if (visibleLen(line2) > width) {
    line2 = join(`${formatInt(ctxPct)}%`, stateText);
  }
  line2 = fit(line2, width);
  return `${line1}\n${line2}`;
}

function renderSingleLine(payload: Payload, config: Config, width: number, modelSegment: string, ctxPct: number, quotas: QuotaResult[], stateLabel: string): string {
  const coloredBadge = colorize(modelSegment, colorBlue, config.color);
  const ctx = `Ctx ${contextValue(config, payload.context_window, ctxPct)}`;
  let tokens = tokenDetail(payload.context_window);
  if (tokens !== "" && config.contextValue === "percent") {
    tokens = colorize(tokens, colorMuted, config.color);
  } else {
    tokens = "";
  }
  let usage = "";
  if (quotas.length > 0) {
    usage = joinHeader(...quotas.map(q => {
      let u = usageLabel(config, q.usagePct, true, q.label);
      if (q.reset !== "") u += resetSuffix(config, q.reset);
      return u;
    }));
  }
  const stateText = config.showAgentState ? colorize(stateLabel, stateColor(stateLabel), config.color) : "";
  let bar = "";
  if (config.showProgressBar) {
    bar = progressBar(ctxPct, 8, config.color);
  }
  const levels = [
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
  let plan = "Plan ?";
  if (rawPlan === "Google AI Pro") {
    plan = "Pro";
  } else if (rawPlan !== "") {
    plan = "Free";
  }
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
  return ` (${withIcon(config, "↻ ", "")}${reset})`;
}

function withIcon(config: Config, icon: string, fallback: string): string {
  return config.showIcons ? icon : fallback;
}

export interface QuotaResult {
  label: string;
  usagePct: number;
  reset: string;
}

function getQuotas(cache: Cache | null | undefined, modelDisplay: string, config: Config, now: Date, officialQuota?: Record<string, OfficialQuotaBucket>): QuotaResult[] {
  const official = officialQuotaInfo(officialQuota, modelDisplay, config, now);
  if (official !== null) {
    return official;
  }
  const [quota, ok] = matchModel(cache, modelDisplay);
  if (!ok || quota === null) {
    return [];
  }
  if (config.showAllQuotas && Array.isArray(quota.buckets) && quota.buckets.length > 0) {
    const results: QuotaResult[] = [];
    for (let i = 0; i < quota.buckets.length; i++) {
      const b = quota.buckets[i];
      const uPct = quotaUsagePercent(b);
      const rst = uPct > 0 ? formatReset(b.resetTime, config, now) : "";
      // Assume 1st is 5-Hour and 2nd is Weekly for known limits, else fallback
      let label = "Usage ";
      if (quota.buckets.length === 2) {
        label = i === 0 ? "Usage " : "Weekly ";
      }
      results.push({ label, usagePct: uPct, reset: rst });
    }
    // We already labeled them, just return
    return results;
  }
  const usagePct = quotaUsagePercent(quota);
  const reset = usagePct > 0 ? formatReset(quota.resetTime, config, now) : "";
  return [{ label: "Usage ", usagePct, reset }];
}

function officialQuotaInfo(officialQuota: Record<string, OfficialQuotaBucket> | undefined, modelDisplay: string, config: Config, now: Date): QuotaResult[] | null {
  if (!officialQuota) return null;
  const keys = officialQuotaKeys(modelDisplay);
  const results: QuotaResult[] = [];
  let sawKnownBucket = false;

  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(officialQuota, key)) continue;
    sawKnownBucket = true;
    const bucket = officialQuota[key];
    if (Number.isFinite(bucket.remaining_fraction)) {
      const usagePct = quotaUsagePercent({
        remainingFraction: bucket.remaining_fraction ?? 1,
        resetTime: bucket.reset_time ?? ""
      });
      const reset = usagePct > 0 ? formatReset(bucket.reset_time ?? "", config, now) : "";
      
      let label = "Usage ";
      if (config.showAllQuotas) {
        if (key.includes("weekly")) label = "Weekly ";
      }
      
      results.push({ label, usagePct, reset });
    }
  }
  
  if (results.length === 0) return sawKnownBucket ? [] : null;
  if (!config.showAllQuotas) {
    results[0].label = "Usage ";
    return [results[0]];
  }
  return results;
}

function officialQuotaKeys(modelDisplay: string): string[] {
  const normalized = modelDisplay.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("gpt") || normalized.includes("oss")) {
    return ["3p-5h", "3p-weekly"];
  }
  return ["gemini-5h", "gemini-weekly"];
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

function formatReset(reset: string, config: Config, now: Date): string {
  if (config.resetFormat === "duration") return formatResetDuration(reset, now);
  return formatResetClock(reset);
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

function usageLabel(config: Config, usagePct: number, withBar: boolean, prefix: string): string {
  let label = prefix;
  if (withBar && config.showProgressBar) {
    label += `${usageBar(config, usagePct)} `;
  }
  return label + usageValue(config, usagePct);
}

function usageValue(config: Config, usagePct: number): string {
  if (config.usageValue === "remaining") {
    return `${formatInt(100 - usagePct)}%`;
  }
  return `${formatInt(usagePct)}%`;
}

function usageBar(config: Config, usagePct: number): string {
  const fillPct = config.usageValue === "remaining" ? 100 - usagePct : usagePct;
  return progressBarWithColor(fillPct, usagePct, 8, config.color);
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
  return Array.from(strip(input)).slice(0, width).join("");
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
