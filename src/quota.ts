import fs from "node:fs";

export interface ModelQuota {
  remainingFraction: number;
  resetTime: string;
}

export interface Cache {
  timestamp?: string;
  email?: string;
  plan_name?: string;
  models: Record<string, ModelQuota>;
}

export function load(cachePath: string): [Cache | null, boolean] {
  let raw: string;
  try {
    raw = fs.readFileSync(cachePath, "utf8");
  } catch {
    return [null, false];
  }
  try {
    const cache = JSON.parse(raw) as Cache;
    if (cache.models === null || typeof cache.models !== "object") {
      cache.models = {};
    }
    return [cache, true];
  } catch {
    return [null, false];
  }
}

export function matchModel(cache: Cache | null | undefined, model: string): [ModelQuota | null, boolean] {
  if (!cache) {
    return [null, false];
  }
  if (Object.prototype.hasOwnProperty.call(cache.models, model)) {
    return [cache.models[model], true];
  }
  const needle = normalize(model);
  for (const [label, quota] of Object.entries(cache.models)) {
    const haystack = normalize(label);
    if (haystack.includes(needle) || needle.includes(haystack)) {
      return [quota, true];
    }
  }
  return [null, false];
}

export function usagePercent(quota: ModelQuota): number {
  let remaining = quota.remainingFraction;
  if (remaining < 0) remaining = 0;
  if (remaining > 1) remaining = 1;
  return Math.trunc((1 - remaining) * 100 + 0.5);
}

export function formatResetCountdown(reset: string, now: Date): string {
  if (reset === "") {
    return "";
  }
  const target = new Date(reset.replace("Z", "+00:00"));
  if (Number.isNaN(target.getTime())) {
    return "";
  }
  const diffMs = target.getTime() - now.getTime();
  if (diffMs <= 0) {
    return "00:00";
  }
  const totalMinutes = Math.trunc(diffMs / 60000);
  const hours = Math.trunc(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return `${pad2(hours)}:${pad2(minutes)}`;
}
function normalize(input: string): string {
  let out = input.toLowerCase();
  for (const old of ["gemini", "(", ")", "-", "_"]) {
    out = out.split(old).join(" ");
  }
  return out.trim().split(/\s+/).filter(Boolean).join(" ");
}

function pad2(n: number): string {
  if (n < 10) {
    return `0${formatInt(n)}`;
  }
  return formatInt(n);
}

function formatInt(n: number): string {
  return Math.trunc(n).toString(10);
}
