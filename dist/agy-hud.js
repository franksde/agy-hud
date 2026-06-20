#!/usr/bin/env node
"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// src/main.ts
var main_exports = {};
__export(main_exports, {
  configPaths: () => configPaths,
  quotaCacheNeedsRefresh: () => quotaCacheNeedsRefresh,
  quotaCachePath: () => quotaCachePath,
  renderStatusline: () => renderStatusline,
  runCli: () => runCli,
  version: () => version
});
module.exports = __toCommonJS(main_exports);
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_os = __toESM(require("node:os"));
var import_node_path4 = __toESM(require("node:path"));
var import_node_child_process2 = require("node:child_process");

// src/config.ts
var import_node_fs = __toESM(require("node:fs"));
function defaultConfig() {
  return {
    showModel: true,
    showProgressBar: true,
    multiline: true,
    color: true,
    showGitBranch: true,
    showCWD: true,
    showAgentState: true,
    showIcons: true,
    contextValue: "percent",
    usageValue: "remaining",
    debug: false,
    showAllQuotas: false
  };
}
function loadFromPaths(paths) {
  for (const configPath of paths) {
    let raw;
    try {
      raw = import_node_fs.default.readFileSync(configPath, "utf8");
    } catch {
      continue;
    }
    try {
      return merge(defaultConfig(), JSON.parse(raw));
    } catch {
      return defaultConfig();
    }
  }
  return defaultConfig();
}
function merge(base, patch) {
  if (typeof patch.show_model === "boolean") base.showModel = patch.show_model;
  if (typeof patch.show_progress_bar === "boolean") base.showProgressBar = patch.show_progress_bar;
  if (typeof patch.multiline === "boolean") base.multiline = patch.multiline;
  if (typeof patch.color === "boolean") base.color = patch.color;
  if (typeof patch.show_git_branch === "boolean") base.showGitBranch = patch.show_git_branch;
  if (typeof patch.show_cwd === "boolean") base.showCWD = patch.show_cwd;
  if (typeof patch.show_agent_state === "boolean") base.showAgentState = patch.show_agent_state;
  if (typeof patch.show_icons === "boolean") base.showIcons = patch.show_icons;
  if (typeof patch.context_value === "string" && patch.context_value !== "") base.contextValue = patch.context_value;
  if (typeof patch.usage_value === "string" && patch.usage_value !== "") base.usageValue = patch.usage_value;
  if (typeof patch.debug === "boolean") base.debug = patch.debug;
  if (typeof patch.show_all_quotas === "boolean") base.showAllQuotas = patch.show_all_quotas;
  return base;
}

// src/quota.ts
var import_node_fs2 = __toESM(require("node:fs"));
function load(cachePath) {
  let raw;
  try {
    raw = import_node_fs2.default.readFileSync(cachePath, "utf8");
  } catch {
    return [null, false];
  }
  try {
    const cache = JSON.parse(raw);
    if (cache.models === null || typeof cache.models !== "object") {
      cache.models = {};
    }
    return [cache, true];
  } catch {
    return [null, false];
  }
}
function matchModel(cache, model) {
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
function usagePercent(quota) {
  let remaining = quota.remainingFraction;
  if (remaining < 0) remaining = 0;
  if (remaining > 1) remaining = 1;
  return Math.trunc((1 - remaining) * 100 + 0.5);
}
function normalize(input) {
  let out = input.toLowerCase();
  for (const old of ["gemini", "(", ")", "-", "_"]) {
    out = out.split(old).join(" ");
  }
  return out.trim().split(/\s+/).filter(Boolean).join(" ");
}

// src/quotaProbe.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_http = __toESM(require("node:http"));
var import_node_https = __toESM(require("node:https"));
var import_node_path = __toESM(require("node:path"));
var import_node_child_process = require("node:child_process");
function parseLanguageServerInfo(psOutput) {
  for (const line of psOutput.split(/\r?\n/)) {
    if (!line.includes("language_server") || !line.includes("--csrf_token")) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parts[1] : "";
    const tokenMatch = line.match(/--csrf_token\s+([a-zA-Z0-9-]+)/);
    if (pid !== "" && /^\d+$/.test(pid) && tokenMatch) {
      return { pid, csrfToken: tokenMatch[1] };
    }
  }
  return null;
}
function parseAgyServerInfos(psOutput) {
  const infos = [];
  for (const line of psOutput.split(/\r?\n/)) {
    if (!/(^|\s)(?:\/\S+\/)?agy\s+--/.test(line)) {
      continue;
    }
    const parts = line.trim().split(/\s+/);
    const pid = parts.length > 1 ? parts[1] : "";
    if (pid !== "" && /^\d+$/.test(pid)) {
      infos.push({ pid, csrfToken: "", kind: "agy" });
    }
  }
  return infos;
}
function parseListeningPorts(lsofOutput) {
  const ports = /* @__PURE__ */ new Set();
  for (const line of lsofOutput.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) {
      continue;
    }
    const match = line.match(/(?:127\.0\.0\.1|localhost|\*|\[::1\]):(\d+)\b/);
    if (match) {
      ports.add(Number(match[1]));
    }
  }
  return [...ports];
}
function buildQuotaCache(rawResponse, now) {
  if (!isRecord(rawResponse)) {
    return null;
  }
  const userStatus = asRecord(rawResponse.userStatus);
  const email = typeof userStatus.email === "string" ? maskEmail(userStatus.email) : "masked@email.com";
  const planStatus = asRecord(userStatus.planStatus);
  const planInfo = asRecord(planStatus.planInfo);
  const planName = typeof planInfo.planName === "string" ? planInfo.planName : "Free";
  const cascade = asRecord(userStatus.cascadeModelConfigData);
  const configs = Array.isArray(cascade.clientModelConfigs) ? cascade.clientModelConfigs : [];
  const models = {};
  for (const item of configs) {
    const model = asRecord(item);
    const label = typeof model.label === "string" ? model.label : "";
    const quotaInfo = asRecord(model.quotaInfo);
    if (label === "" || Object.keys(quotaInfo).length === 0) {
      continue;
    }
    const resetTime = typeof quotaInfo.resetTime === "string" ? quotaInfo.resetTime : "";
    const remainingFraction = typeof quotaInfo.remainingFraction === "number" ? quotaInfo.remainingFraction : resetTime === "" ? 1 : 0;
    const rawBuckets = Array.isArray(quotaInfo.buckets) ? quotaInfo.buckets : [];
    const buckets = [];
    for (const b of rawBuckets) {
      const br = asRecord(b);
      const brReset = typeof br.resetTime === "string" ? br.resetTime : "";
      const brRem = typeof br.remainingFraction === "number" ? br.remainingFraction : brReset === "" ? 1 : 0;
      buckets.push({ remainingFraction: brRem, resetTime: brReset });
    }
    models[label] = { remainingFraction, resetTime, buckets };
  }
  if (Object.keys(models).length === 0) {
    return null;
  }
  const cache = {
    timestamp: now.toISOString().replace(".000Z", "Z"),
    email,
    plan_name: planName,
    models
  };
  const lines = ["=== QUOTA SUMMARY ===", `Plan: ${planName}`, `Cache Timestamp: ${cache.timestamp}`];
  for (const [model, quota] of Object.entries(models)) {
    const usedPct = Math.trunc((1 - quota.remainingFraction) * 100 + 0.5);
    let line = `- ${model.padEnd(30, " ")} : Usage ${String(usedPct).padStart(3, " ")}%`;
    if (usedPct > 0 && quota.resetTime !== "") {
      line += ` | Reset ${quota.resetTime}`;
    }
    lines.push(line);
  }
  lines.push("=====================");
  return { cache, summary: lines.join("\n") };
}
async function refreshQuota(cachePath, runtime = defaultRuntime()) {
  const psOutput = runtime.ps();
  const languageServer = parseLanguageServerInfo(psOutput);
  const candidates = languageServer ? [languageServer] : parseAgyServerInfos(psOutput);
  if (candidates.length === 0) {
    return { ok: false, message: "No running language_server or agy quota server found." };
  }
  let rawResponse = null;
  let sawPort = false;
  for (const info of candidates) {
    let ports;
    try {
      ports = parseListeningPorts(runtime.lsof(info.pid));
    } catch {
      continue;
    }
    if (ports.length > 0) {
      sawPort = true;
    }
    for (const port of ports) {
      rawResponse = await runtime.request(port, info.csrfToken);
      if (rawResponse) {
        break;
      }
    }
    if (rawResponse) {
      break;
    }
  }
  if (!sawPort) {
    return { ok: false, message: "No listening ports found on quota server." };
  }
  if (!rawResponse) {
    return { ok: false, message: "Failed to query GetUserStatus from all identified ports." };
  }
  const built = buildQuotaCache(rawResponse, runtime.now());
  if (!built) {
    return { ok: false, message: "GetUserStatus returned malformed quota data." };
  }
  runtime.mkdir(import_node_path.default.dirname(cachePath));
  runtime.writeFile(cachePath, `${JSON.stringify(built.cache, null, 2)}
`);
  return {
    ok: true,
    message: `Successfully cached processed quota data to ${cachePath}`,
    cachePath,
    summary: built.summary
  };
}
function defaultRuntime() {
  return {
    ps: () => (0, import_node_child_process.execFileSync)("ps", ["aux"], { encoding: "utf8" }),
    lsof: (pid) => (0, import_node_child_process.execFileSync)("lsof", ["-nP", "-iTCP", "-a", "-p", pid], { encoding: "utf8" }),
    request: queryLanguageServer,
    now: () => /* @__PURE__ */ new Date(),
    writeFile: (filePath, data) => import_node_fs3.default.writeFileSync(filePath, data, "utf8"),
    mkdir: (dirPath) => import_node_fs3.default.mkdirSync(dirPath, { recursive: true })
  };
}
async function queryLanguageServer(port, csrfToken) {
  const endpoint = `/exa.language_server_pb.LanguageServerService/GetUserStatus`;
  const headers = {
    "Content-Type": "application/json",
    "Connect-Protocol-Version": "1"
  };
  if (csrfToken !== "") {
    headers["X-Codeium-Csrf-Token"] = csrfToken;
  }
  const httpsResult = await requestJson(import_node_https.default, {
    protocol: "https:",
    hostname: "127.0.0.1",
    port,
    path: endpoint,
    method: "POST",
    headers,
    rejectUnauthorized: false
  });
  if (httpsResult !== null) {
    return httpsResult;
  }
  return requestJson(import_node_http.default, {
    protocol: "http:",
    hostname: "127.0.0.1",
    port,
    path: endpoint,
    method: "POST",
    headers
  });
}
function requestJson(mod, options) {
  return new Promise((resolve) => {
    const req = mod.request(options, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
      res.on("end", () => {
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          resolve(null);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        } catch {
          resolve(null);
        }
      });
    });
    req.setTimeout(5e3, () => {
      req.destroy();
      resolve(null);
    });
    req.on("error", () => resolve(null));
    req.write("{}");
    req.end();
  });
}
function maskEmail(email) {
  const at = email.indexOf("@");
  if (at < 0) {
    return "masked@email.com";
  }
  return `${email.slice(0, 3)}***${email.slice(at)}`;
}
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function asRecord(value) {
  return isRecord(value) ? value : {};
}

// src/gitinfo.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
function branch(cwd) {
  if (cwd === "") {
    return "";
  }
  let dir;
  try {
    dir = import_node_path2.default.resolve(cwd);
  } catch {
    dir = cwd;
  }
  for (let i = 0; i < 8; i++) {
    const raw = readHEAD(dir);
    if (raw !== null) {
      return parseHEAD(raw.trim());
    }
    const parent = import_node_path2.default.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return "";
}
function readHEAD(dir) {
  const gitPath = import_node_path2.default.join(dir, ".git");
  let stat;
  try {
    stat = import_node_fs4.default.statSync(gitPath);
  } catch {
    return null;
  }
  if (stat.isDirectory()) {
    try {
      return import_node_fs4.default.readFileSync(import_node_path2.default.join(gitPath, "HEAD"), "utf8");
    } catch {
      return null;
    }
  }
  let raw;
  try {
    raw = import_node_fs4.default.readFileSync(gitPath, "utf8");
  } catch {
    return null;
  }
  let gitDir = parseGitDirFile(raw.trim());
  if (gitDir === "") {
    return null;
  }
  if (!import_node_path2.default.isAbsolute(gitDir)) {
    gitDir = import_node_path2.default.join(dir, gitDir);
  }
  try {
    return import_node_fs4.default.readFileSync(import_node_path2.default.join(gitDir, "HEAD"), "utf8");
  } catch {
    return null;
  }
}
function parseGitDirFile(raw) {
  if (!raw.startsWith("gitdir:")) {
    return "";
  }
  return raw.slice("gitdir:".length).trim();
}
function parseHEAD(head) {
  if (head.startsWith("ref:")) {
    const ref = head.slice("ref:".length).trim();
    if (ref.startsWith("refs/heads/")) {
      return ref.slice("refs/heads/".length);
    }
    return import_node_path2.default.basename(ref);
  }
  if (head.length > 7) {
    return head.slice(0, 7);
  }
  return head;
}

// src/ansi.ts
function strip(input) {
  return input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
}
function visibleLen(input) {
  return Array.from(strip(input)).length;
}

// src/statusline.ts
var import_node_path3 = __toESM(require("node:path"));
var colorReset = "\x1B[0m";
var colorBlue = "\x1B[34m";
var colorGreen = "\x1B[32m";
var colorYellow = "\x1B[33m";
var colorCyan = "\x1B[36m";
var colorMagenta = "\x1B[35m";
var colorRed = "\x1B[31m";
var colorOrange = "\x1B[38;5;208m";
var colorMuted = "\x1B[90m";
function shortModelName(display) {
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
function render(payload, opts) {
  const config = opts.config;
  const width = (payload.terminal_width ?? 0) <= 0 ? 80 : payload.terminal_width;
  const modelDisplay = payload.model?.display_name || payload.model?.id || "Gemini";
  const modelSegment = renderModelSegment(shortModelName(modelDisplay), payload.plan_tier ?? "", config);
  const ctxPct = contextPercent(payload.context_window);
  const stateLabel = state(payload.agent_state ?? "");
  const quotas = getQuotas(opts.quota, modelDisplay, config, opts.now ?? /* @__PURE__ */ new Date(), payload.quota);
  if (config.multiline) {
    return renderMultiline(payload, config, width, modelSegment, ctxPct, quotas, opts.gitBranch ?? "", stateLabel);
  }
  return renderSingleLine(payload, config, width, modelSegment, ctxPct, quotas, stateLabel);
}
function renderMultiline(payload, config, width, modelSegment, ctxPct, quotas, branch2, stateLabel) {
  const line1Parts = [colorize(modelSegment, colorBlue, config.color)];
  if (config.showCWD && payload.cwd) {
    line1Parts.push(colorize(withIcon(config, "\uF07C ", "") + import_node_path3.default.basename(payload.cwd), colorYellow, config.color));
  }
  if (config.showGitBranch && branch2 !== "") {
    line1Parts.push(colorize(renderGitSegment(branch2, config), colorMagenta, config.color));
  }
  let line1 = joinHeader(...line1Parts);
  if (visibleLen(line1) > width) {
    line1 = joinHeader(colorize(modelSegment, colorBlue, config.color), colorize(renderGitSegment(branch2, config), colorMagenta, config.color));
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
  let usage2 = "";
  if (quotas.length > 0) {
    usage2 = joinHeader(...quotas.map((q) => {
      let u = usageLabel(config, q.usagePct, true, q.label);
      if (q.reset !== "") u += resetSuffix(config, q.reset);
      return u;
    }));
  }
  const stateText = config.showAgentState ? colorize(stateLabel, stateColor(stateLabel), config.color) : "";
  let line2 = joinHeader(ctx, usage2, stateText);
  if (visibleLen(line2) > width) {
    let usageNoBar = "";
    if (quotas.length > 0) {
      usageNoBar = joinHeader(...quotas.map((q) => {
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
  return `${line1}
${line2}`;
}
function renderSingleLine(payload, config, width, modelSegment, ctxPct, quotas, stateLabel) {
  const coloredBadge = colorize(modelSegment, colorBlue, config.color);
  const ctx = `Ctx ${contextValue(config, payload.context_window, ctxPct)}`;
  let tokens = tokenDetail(payload.context_window);
  if (tokens !== "" && config.contextValue === "percent") {
    tokens = colorize(tokens, colorMuted, config.color);
  } else {
    tokens = "";
  }
  let usage2 = "";
  if (quotas.length > 0) {
    usage2 = joinHeader(...quotas.map((q) => {
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
    [coloredBadge, ctx, tokens, bar, usage2, stateText],
    [coloredBadge, ctx, bar, usage2, stateText],
    [coloredBadge, ctx, usage2, stateText],
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
function renderModelSegment(shortModel, rawPlan, config) {
  let plan = "Plan ?";
  if (rawPlan === "Google AI Pro") {
    plan = "Pro";
  } else if (rawPlan !== "") {
    plan = "Free";
  }
  if (config.showModel && shortModel !== "") {
    return `${withIcon(config, "\uEE9C ", "")}${shortModel} | ${renderPlan(plan, config)}`;
  }
  if (plan === "Pro") {
    return `${withIcon(config, "\uEE9C ", "")}${renderPlan(plan, config)} Tier`;
  }
  return `${withIcon(config, "\uEE9C ", "")}${plan}`;
}
function renderPlan(plan, config) {
  if (plan === "Pro") {
    return `${withIcon(config, "\uF0A3 ", "")}Pro`;
  }
  return plan;
}
function renderGitSegment(branch2, config) {
  if (branch2 === "git") {
    return `${withIcon(config, "\uE725 ", "")}git`;
  }
  return `${withIcon(config, "\uE725 ", "")}${branch2}`;
}
function resetSuffix(config, reset) {
  return ` ${withIcon(config, "\u21BB ", "")}Reset ${reset}`;
}
function withIcon(config, icon, fallback) {
  return config.showIcons ? icon : fallback;
}
function getQuotas(cache, modelDisplay, config, now, officialQuota) {
  const official = officialQuotaInfo(officialQuota, modelDisplay, config, now);
  if (official !== null) {
    return official;
  }
  const [quota, ok] = matchModel(cache, modelDisplay);
  if (!ok || quota === null) {
    return [];
  }
  if (config.showAllQuotas && Array.isArray(quota.buckets) && quota.buckets.length > 0) {
    const results = [];
    for (let i = 0; i < quota.buckets.length; i++) {
      const b = quota.buckets[i];
      const uPct = usagePercent(b);
      const rst = uPct > 0 ? formatResetClock(b.resetTime) : "";
      let label = "Usage ";
      if (quota.buckets.length === 2) {
        label = i === 0 ? "Usage " : "Weekly ";
      }
      results.push({ label, usagePct: uPct, reset: rst });
    }
    return results;
  }
  const usagePct = usagePercent(quota);
  const reset = usagePct > 0 ? formatResetClock(quota.resetTime) : "";
  return [{ label: "Usage ", usagePct, reset }];
}
function officialQuotaInfo(officialQuota, modelDisplay, config, now) {
  if (!officialQuota) return null;
  const keys = officialQuotaKeys(modelDisplay);
  const results = [];
  let sawKnownBucket = false;
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(officialQuota, key)) continue;
    sawKnownBucket = true;
    const bucket = officialQuota[key];
    if (Number.isFinite(bucket.remaining_fraction)) {
      const usagePct = usagePercent({
        remainingFraction: bucket.remaining_fraction ?? 1,
        resetTime: bucket.reset_time ?? ""
      });
      const reset = usagePct > 0 ? formatResetClock(bucket.reset_time ?? "") : "";
      let label = "Usage ";
      if (config.showAllQuotas) {
        if (key.includes("weekly")) label = "Weekly ";
      }
      results.push({ label, usagePct, reset });
    }
  }
  if (results.length === 0) return sawKnownBucket ? [] : null;
  results.sort((a, b) => b.usagePct - a.usagePct);
  if (!config.showAllQuotas) {
    results[0].label = "Usage ";
    return [results[0]];
  }
  return results;
}
function officialQuotaKeys(modelDisplay) {
  const normalized = modelDisplay.toLowerCase();
  if (normalized.includes("claude") || normalized.includes("gpt") || normalized.includes("oss")) {
    return ["3p-5h", "3p-weekly"];
  }
  return ["gemini-5h", "gemini-weekly"];
}
function formatResetClock(reset) {
  if (reset === "") {
    return "";
  }
  const target = new Date(reset.replace("Z", "+00:00"));
  if (Number.isNaN(target.getTime())) {
    return "";
  }
  return `${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
}
function contextValue(config, ctx, pct) {
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
function contextPercent(ctx) {
  const inputTokens = ctx?.total_input_tokens ?? 0;
  const windowSize = ctx?.context_window_size ?? 0;
  if (Number.isFinite(inputTokens) && Number.isFinite(windowSize) && inputTokens > 0 && windowSize > 0) {
    return clampInt(Math.trunc(inputTokens / windowSize * 100 + 0.5));
  }
  const upstream = ctx?.used_percentage ?? 0;
  if (!Number.isFinite(upstream)) {
    return 0;
  }
  return clampInt(Math.trunc(upstream + 0.5));
}
function usageLabel(config, usagePct, withBar, prefix) {
  let label = prefix;
  if (withBar && config.showProgressBar) {
    label += `${usageBar(config, usagePct)} `;
  }
  return label + usageValue(config, usagePct);
}
function usageValue(config, usagePct) {
  if (config.usageValue === "remaining") {
    return `${formatInt(100 - usagePct)}%`;
  }
  return `${formatInt(usagePct)}%`;
}
function usageBar(config, usagePct) {
  const fillPct = config.usageValue === "remaining" ? 100 - usagePct : usagePct;
  return progressBarWithColor(fillPct, usagePct, 8, config.color);
}
function tokenDetail(ctx) {
  const total = (ctx?.total_input_tokens ?? 0) + (ctx?.total_output_tokens ?? 0);
  const windowSize = ctx?.context_window_size ?? 0;
  if (total <= 0 || windowSize <= 0) {
    return "";
  }
  return `(${formatTokens(total)}/${formatTokens(windowSize)})`;
}
function formatTokens(n) {
  if (n >= 1e6) {
    if (n % 1e6 === 0) {
      return `${formatInt(n / 1e6)}M`;
    }
    return `${Number((n / 1e6).toFixed(1))}M`;
  }
  if (n >= 1e3) {
    return `${formatInt((n + 500) / 1e3)}k`;
  }
  return formatInt(n);
}
function progressBar(pct, width, color) {
  return progressBarWithColor(pct, pct, width, color);
}
function progressBarWithColor(fillPct, colorPct, width, color) {
  fillPct = clampInt(fillPct);
  colorPct = clampInt(colorPct);
  let filled = Math.trunc(fillPct / 100 * width + 0.5);
  if (filled < 0) filled = 0;
  if (filled > width) filled = width;
  const bar = `${"\u2588".repeat(filled)}${"\u2591".repeat(width - filled)}`;
  if (!color) {
    return bar;
  }
  return colorize(bar, percentageColor(colorPct), true);
}
function percentageColor(pct) {
  if (pct >= 90) return colorRed;
  if (pct >= 75) return colorOrange;
  if (pct >= 50) return colorYellow;
  return colorGreen;
}
function state(raw) {
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
function stateColor(label) {
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
function colorize(input, colorCode, enabled) {
  if (!enabled || input === "") {
    return input;
  }
  return `${colorCode}${input}${colorReset}`;
}
function join(...parts) {
  return parts.filter((part) => part !== "").join("  ");
}
function joinHeader(...parts) {
  return parts.filter((part) => part !== "").join(" \u2502 ");
}
function fit(input, width) {
  if (width <= 0 || visibleLen(input) <= width) {
    return input;
  }
  return Array.from(strip(input)).slice(0, width).join("");
}
function clampInt(n) {
  if (n < 0) return 0;
  if (n > 100) return 100;
  return n;
}
function formatInt(n) {
  return Math.trunc(n).toString(10);
}
function pad2(n) {
  if (n < 10) {
    return `0${formatInt(n)}`;
  }
  return formatInt(n);
}
function title(raw) {
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

// src/main.ts
var version = "0.1.4";
function renderStatusline(input, cfg = defaultConfig(), cache = null) {
  if (input.trim() === "") {
    return "agy-hud";
  }
  let payload;
  try {
    payload = JSON.parse(input);
  } catch {
    return "agy-hud";
  }
  let branch2 = "";
  if (cfg.showGitBranch) {
    branch2 = sanitizedBranch(payload.vcs?.branch ?? "");
    if (branch2 === "") {
      branch2 = gitBranchFromPayload(payload);
    }
    if (branch2 === "") {
      branch2 = sanitizedBranch(process.env.AGY_HUD_GIT_BRANCH ?? "");
    }
  }
  try {
    return render(payload, {
      config: cfg,
      quota: cache,
      gitBranch: branch2
    });
  } catch {
    return "agy-hud";
  }
}
function configPaths() {
  const paths = [];
  const explicit = process.env.AGY_HUD_CONFIG;
  if (explicit) {
    paths.push(explicit);
  }
  const dir = import_node_path4.default.dirname(__filename);
  paths.push(import_node_path4.default.join(dir, "config.json"));
  paths.push(import_node_path4.default.join(dir, "..", "config.json"));
  const xdg = process.env.XDG_CONFIG_HOME;
  if (xdg) {
    paths.push(import_node_path4.default.join(xdg, "agy-hud", "config.json"));
  }
  const home = import_node_os.default.homedir();
  if (home) {
    paths.push(import_node_path4.default.join(home, ".config", "agy-hud", "config.json"));
  }
  return paths;
}
function quotaCachePath() {
  const explicit = process.env.AGY_HUD_QUOTA_CACHE;
  if (explicit) {
    return explicit;
  }
  const home = import_node_os.default.homedir();
  if (!home) {
    return "";
  }
  return import_node_path4.default.join(home, ".gemini", "antigravity-cli", "scratch", "agy-hud", "quota_cache.json");
}
function gitBranchFromPayload(payload) {
  const paths = [
    payload.vcs?.root ?? "",
    payload.workspace?.project_dir ?? "",
    payload.workspace?.current_dir ?? "",
    payload.cwd ?? ""
  ];
  if (shouldUseProcessCWD(payload.cwd ?? "")) {
    paths.push(".");
  }
  for (const candidate of paths) {
    if (!validGitCandidatePath(candidate)) {
      continue;
    }
    const found = branch(candidate);
    if (found !== "") {
      return found;
    }
  }
  return "";
}
function shouldUseProcessCWD(payloadCWD) {
  if (payloadCWD.trim() === "") {
    return true;
  }
  return import_node_path4.default.basename(process.cwd()) === import_node_path4.default.basename(payloadCWD);
}
function validGitCandidatePath(candidate) {
  const trimmed = candidate.trim();
  if (trimmed === "") {
    return false;
  }
  try {
    return import_node_fs5.default.statSync(trimmed).isDirectory();
  } catch {
    return false;
  }
}
function sanitizedBranch(raw) {
  raw = raw.trim();
  if (raw === "" || raw.length > 80) {
    return "";
  }
  for (const char of raw) {
    const ok = char >= "a" && char <= "z" || char >= "A" && char <= "Z" || char >= "0" && char <= "9" || char === "/" || char === "-" || char === "_" || char === ".";
    if (!ok) {
      return "";
    }
  }
  return raw;
}
function usage(write) {
  write("usage: agy-hud [statusline|quota refresh|version]\n");
}
async function runCli(args, deps = {}) {
  const stdout = deps.stdout ?? ((chunk) => {
    process.stdout.write(chunk);
  });
  const stderr = deps.stderr ?? ((chunk) => {
    process.stderr.write(chunk);
  });
  const command = args[0] ?? "statusline";
  if (command === "version" || command === "--version" || command === "-v") {
    stdout(`${version}
`);
    return 0;
  }
  if (command === "statusline") {
    const cfg = loadFromPaths(configPaths());
    const raw = await readStdin(deps.stdin ?? process.stdin);
    const payload = parsePayload(raw);
    const cachePath = quotaCachePath();
    const [cache, ok] = load(cachePath);
    triggerBackgroundRefreshIfNeeded(cachePath, ok ? cache : null, payload);
    stdout(`${renderStatusline(raw, cfg, ok ? cache : null)}
`);
    return 0;
  }
  if (command === "quota") {
    if (args[1] === "refresh") {
      const lockPath = quotaCachePath() + ".lock";
      try {
        const result = await (deps.refreshQuota ?? refreshQuota)(quotaCachePath());
        stderr(`[quota_probe] ${result.message}
`);
        if (result.ok && result.summary) {
          stdout(`${result.summary}
`);
        }
        return result.ok ? 0 : 2;
      } catch (error) {
        stderr(`[quota_probe] ${error instanceof Error ? error.message : String(error)}
`);
        return 2;
      } finally {
        try {
          if (import_node_fs5.default.existsSync(lockPath)) {
            import_node_fs5.default.unlinkSync(lockPath);
          }
        } catch {
        }
      }
    }
    usage(stderr);
    return 2;
  }
  if (command === "help" || command === "--help" || command === "-h") {
    usage(stderr);
    return 0;
  }
  usage(stderr);
  return 2;
}
function readStdin(stdin) {
  return new Promise((resolve) => {
    let raw = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => {
      raw += chunk;
    });
    stdin.on("end", () => {
      resolve(raw);
    });
  });
}
function triggerBackgroundRefreshIfNeeded(cachePath, cache, payload = null) {
  const now = /* @__PURE__ */ new Date();
  const statePath = refreshStatePath(cachePath);
  const prevState = loadStatuslineRefreshState(statePath);
  const activityRefresh = shouldTriggerActivityRefresh(cache, payload, prevState, now);
  const nextState = mergeStatuslineRefreshState(prevState, payload, activityRefresh, now);
  saveStatuslineRefreshState(statePath, nextState);
  if (!quotaCacheNeedsRefresh(cache, now) && !activityRefresh) {
    return;
  }
  const lockPath = cachePath + ".lock";
  try {
    if (import_node_fs5.default.existsSync(lockPath)) {
      const stat = import_node_fs5.default.statSync(lockPath);
      const minLockMs = activityRefresh ? 5 * 1e3 : 30 * 1e3;
      if (now.getTime() - stat.mtimeMs < minLockMs) {
        return;
      }
    }
    import_node_fs5.default.writeFileSync(lockPath, (/* @__PURE__ */ new Date()).toISOString(), "utf8");
    const nodePath = process.argv[0];
    const child = (0, import_node_child_process2.spawn)(nodePath, [__filename, "quota", "refresh"], {
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } catch {
  }
}
function quotaCacheNeedsRefresh(cache, now = /* @__PURE__ */ new Date()) {
  if (!cache || !cache.timestamp) {
    return true;
  }
  try {
    const cacheTime = new Date(cache.timestamp);
    if (Number.isNaN(cacheTime.getTime())) {
      return true;
    }
    const interval = cacheLooksUntouched(cache) ? 30 * 1e3 : 5 * 60 * 1e3;
    if (now.getTime() - cacheTime.getTime() > interval) {
      return true;
    }
  } catch {
    return true;
  }
  return false;
}
function parsePayload(input) {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}
function refreshStatePath(cachePath) {
  if (cachePath === "") {
    return "";
  }
  return `${cachePath}.statusline.json`;
}
function loadStatuslineRefreshState(statePath) {
  if (statePath === "") {
    return null;
  }
  try {
    const raw = import_node_fs5.default.readFileSync(statePath, "utf8");
    const parsed = JSON.parse(raw);
    return {
      conversationId: typeof parsed.conversationId === "string" ? parsed.conversationId : "",
      agentState: typeof parsed.agentState === "string" ? parsed.agentState : "",
      lastActivityAt: typeof parsed.lastActivityAt === "string" ? parsed.lastActivityAt : void 0
    };
  } catch {
    return null;
  }
}
function saveStatuslineRefreshState(statePath, state2) {
  if (statePath === "") {
    return;
  }
  try {
    import_node_fs5.default.mkdirSync(import_node_path4.default.dirname(statePath), { recursive: true });
    import_node_fs5.default.writeFileSync(statePath, `${JSON.stringify(state2, null, 2)}
`, "utf8");
  } catch {
  }
}
function mergeStatuslineRefreshState(prevState, payload, activityRefresh, now) {
  const next = {
    conversationId: prevState?.conversationId ?? "",
    agentState: prevState?.agentState ?? "",
    lastActivityAt: prevState?.lastActivityAt
  };
  if (payload) {
    next.conversationId = (payload.conversation_id ?? "").trim();
    next.agentState = normalizeAgentState(payload.agent_state);
  }
  if (activityRefresh) {
    next.lastActivityAt = now.toISOString();
  }
  return next;
}
function shouldTriggerActivityRefresh(cache, payload, prevState, now) {
  if (!payload) {
    return false;
  }
  if (!cacheLooksUntouched(cache) && !activeModelQuotaLooksUntouched(cache, payload)) {
    return false;
  }
  const conversationId = (payload.conversation_id ?? "").trim();
  const agentState = normalizeAgentState(payload.agent_state);
  const prevConversationId = prevState?.conversationId ?? "";
  const prevAgentState = prevState?.agentState ?? "";
  const conversationChanged = conversationId !== "" && conversationId !== prevConversationId;
  const becameActive = agentState !== "" && agentState !== "idle" && agentState !== prevAgentState;
  const settledAfterActive = agentState === "idle" && prevAgentState !== "" && prevAgentState !== "idle";
  if (!conversationChanged && !becameActive && !settledAfterActive) {
    return false;
  }
  if (prevState?.lastActivityAt) {
    const last = new Date(prevState.lastActivityAt);
    if (!Number.isNaN(last.getTime()) && now.getTime() - last.getTime() < 5 * 1e3) {
      return false;
    }
  }
  return true;
}
function activeModelQuotaLooksUntouched(cache, payload) {
  if (!cache) {
    return false;
  }
  const model = payload.model?.display_name || payload.model?.id || "";
  if (model === "") {
    return false;
  }
  const [quota, ok] = matchModel(cache, model);
  if (!ok || quota === null) {
    return true;
  }
  return quota.remainingFraction >= 1;
}
function normalizeAgentState(raw) {
  return (raw ?? "").trim().toLowerCase();
}
function cacheLooksUntouched(cache) {
  if (!cache || !cache.models) {
    return false;
  }
  const quotas = Object.values(cache.models);
  if (quotas.length === 0) {
    return true;
  }
  for (const quota of quotas) {
    if (quota.remainingFraction < 1) {
      return false;
    }
  }
  return true;
}
if (require.main === module) {
  runCli(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  configPaths,
  quotaCacheNeedsRefresh,
  quotaCachePath,
  renderStatusline,
  runCli,
  version
});
