import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { strip, visibleLen } from "../src/ansi";
import { defaultConfig, Config } from "../src/config";
import { Cache } from "../src/quota";
import { Payload, render, shortModelName, formatCost } from "../src/statusline";

function fixturePayload(): Payload {
  return JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "testdata", "statusline_payload.json"), "utf8"));
}

function renderFixture(config: Config, cache: Cache | null = null): string {
  return render(fixturePayload(), {
    config,
    quota: cache,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  });
}

test("short model name strips Gemini and compacts tier", () => {
  const cases: Record<string, string> = {
    "Gemini 3.8 Flash (High)": "3.8 Flash High",
    "Gemini 3.7 Flash (Medium)": "3.7 Flash Med",
    "Gemini 3.6 Flash (Low)": "3.6 Flash Low",
    "GPT-OSS 120B (Medium)": "GPT-OSS 120B Med",
    "Gemini 3.5 Flash (High)": "3.5 Flash High",
    "Gemini 3.1 Pro (High)": "3.1 Pro High",
    "Gemini 3.5 Flash (Medium)": "3.5 Flash Med",
    "Claude Sonnet 4.6 (Thinking)": "Sonnet 4.6",
    "Claude Opus 4.6 (Thinking)": "Opus 4.6"
  };
  for (const [input, want] of Object.entries(cases)) {
    assert.equal(shortModelName(input), want);
  }
});

test("combined model plan badge and no duplicate model", () => {
  const out = strip(renderFixture(defaultConfig()));
  assert.match(out, / 3\.5 Flash Med \|  Pro/);
  assert.equal((out.match(/3\.5 Flash Med/g) ?? []).length, 1);
});

test("multiline default shape uses context and quota", () => {
  const cache: Cache = {
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 0.20,
        resetTime: "2026-05-19T12:44:00Z"
      }
    }
  };
  const out = strip(renderFixture(defaultConfig(), cache));
  const lines = out.split("\n");
  assert.equal(lines.length, 2);
  assert.match(lines[0], / 3\.5 Flash Med \|  Pro/);
  assert.match(lines[0], / agy-hud/);
  assert.match(lines[0], / main/);
  assert.match(lines[0], /Idle/);
  assert.doesNotMatch(lines[0], /  \|  |  │  /);
  assert.match(lines[1], /Context/);
  assert.match(lines[1], /12%/);
  assert.doesNotMatch(lines[1], /  \|  |  │  /);
  assert.match(lines[1], /Usage/);
  assert.match(lines[1], /20% left/);
  assert.match(lines[1], /Usage ██░░░░░░ 20% left ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(lines[1], /↻ 00:44/);
  assert.doesNotMatch(lines[1], /resets/);
  assert.doesNotMatch(lines[1], /Idle/);
});

test("remaining quota renders as a context-style bar from precise fraction", () => {
  const cache: Cache = {
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 0.8475794,
        resetTime: "2026-05-19T14:04:00Z"
      }
    }
  };
  const config = defaultConfig();
  config.color = false;

  const out = strip(renderFixture(config, cache));

  assert.match(out, /Usage ███████░ 85% left ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(out, /\u2009/);
  assert.doesNotMatch(out, /↻ 02:04/);
});

test("official quota payload renders five-hour and weekly windows over stale quota cache", () => {
  const payload = fixturePayload();
  payload.terminal_width = 160;
  payload.quota = {
    "gemini-5h": {
      remaining_fraction: 0.8423024,
      reset_time: "2026-06-15T08:21:23Z",
      reset_in_seconds: 16151
    },
    "gemini-weekly": {
      remaining_fraction: 0.90918493,
      reset_time: "2026-06-19T01:21:19Z",
      reset_in_seconds: 336547
    }
  };
  const staleCache: Cache = {
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 0.2,
        resetTime: "2026-05-19T12:44:00Z"
      }
    }
  };
  const config = defaultConfig();
  config.color = false;

  const out = strip(render(payload, {
    config,
    quota: staleCache,
    gitBranch: "main",
    now: new Date("2026-06-15T03:52:00Z")
  }));

  assert.match(out, /Usage ████████░░ 84% \(↻ 4h 29m\) \|  █████████░ 91% \(↻ 3d 21h\)/);
  assert.doesNotMatch(out, /20% left/);
});

test("untouched official third-party quota does not override consumed active-model cache", () => {
  const payload = fixturePayload();
  payload.model = { display_name: "Claude Opus 4.6 (Thinking)" };
  payload.quota = {
    "3p-5h": {
      remaining_fraction: 1,
      reset_time: "2026-06-27T09:48:56Z"
    }
  };
  const cache: Cache = {
    timestamp: "2026-06-27T04:51:30Z",
    models: {
      "Claude Opus 4.6 (Thinking)": {
        remainingFraction: 0.92,
        resetTime: "2026-06-27T09:48:56Z"
      }
    }
  };
  const config = defaultConfig();
  config.color = false;
  config.contextValue = "both";

  const out = strip(render(payload, {
    config,
    quota: cache,
    gitBranch: "main",
    now: new Date("2026-06-27T04:52:00Z")
  }));

  assert.match(out, /Usage ███████░ 92% left ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(out, /100% left/);
});

test("fresh active-model cache can override stale official third-party quota with higher remaining value", () => {
  const payload = fixturePayload();
  payload.model = { display_name: "Claude Opus 4.6 (Thinking)" };
  payload.quota = {
    "3p-5h": {
      remaining_fraction: 0.29,
      reset_time: "2026-06-27T09:48:56Z"
    }
  };
  const cache: Cache = {
    timestamp: "2026-06-27T05:08:37Z",
    models: {
      "Claude Opus 4.6 (Thinking)": {
        remainingFraction: 0.1661196,
        resetTime: "2026-06-27T09:48:56Z"
      }
    }
  };
  const config = defaultConfig();
  config.color = false;

  const out = strip(render(payload, {
    config,
    quota: cache,
    gitBranch: "main",
    now: new Date("2026-06-27T05:09:00Z")
  }));

  assert.match(out, /Usage █░░░░░░░ 17% left ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(out, /29% left/);
});

test("official quota uses third-party buckets for Claude and GPT models", () => {
  const payload = fixturePayload();
  payload.model = { display_name: "Claude Sonnet 4.6 (Thinking)" };
  payload.quota = {
    "3p-5h": {
      remaining_fraction: 0.48,
      reset_time: "2026-06-15T08:52:11Z"
    },
    "gemini-5h": {
      remaining_fraction: 0.84,
      reset_time: "2026-06-15T08:21:23Z"
    }
  };
  const config = defaultConfig();
  config.color = false;

  const out = strip(render(payload, {
    config,
    gitBranch: "main",
    now: new Date("2026-06-15T03:52:00Z")
  }));

  assert.match(out, /Sonnet 4\.6/);
  assert.match(out, /Usage ████░░░░ 48% left ↻ Reset \d\d:\d\d/);
});

test("agent state can be hidden", () => {
  const config = defaultConfig();
  config.showAgentState = false;
  assert.doesNotMatch(strip(renderFixture(config)), /Idle/);
});

test("current Gemini, Claude and GPT labels select the matching dual quota windows", () => {
  for (const [label, wantFiveHour, wantWeekly] of [
    ["Gemini 3.8 Flash (High)", "42%", "81%"],
    ["Claude Sonnet 4.6 (Thinking)", "13%", "67%"],
    ["GPT-OSS 120B (Medium)", "13%", "67%"]
  ]) {
    const payload = { ...fixturePayload(), terminal_width: 180, model: { display_name: label }, quota: {
      "gemini-5h": { remaining_fraction: 0.42 }, "gemini-weekly": { remaining_fraction: 0.81 },
      "3p-5h": { remaining_fraction: 0.13 }, "3p-weekly": { remaining_fraction: 0.67 }
    } };
    const usage = render(payload, { config: { ...defaultConfig(), color: false } }).split("\n")[1];
    assert.match(usage, new RegExp(wantFiveHour));
    assert.match(usage, new RegExp(wantWeekly));
  }
});

test("context value formats", () => {
  const cases: Record<string, string> = {
    percent: "Context █░░░░░░░░░ 12%",
    tokens: "Context █░░░░░░░░░ 125k/1M",
    both: "Context █░░░░░░░░░ 12% (125k/1M)"
  };
  for (const [value, want] of Object.entries(cases)) {
    const config = defaultConfig();
    config.color = false;
    config.contextValue = value;
    assert.match(renderFixture(config), new RegExp(want.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
});

test("context percent ignores volatile output token count", () => {
  const payload = fixturePayload();
  payload.context_window = {
    total_input_tokens: 60_000,
    total_output_tokens: 40_000,
    context_window_size: 1_000_000,
    used_percentage: 10
  };
  const config = defaultConfig();
  config.color = false;
  config.contextValue = "both";

  const out = strip(render(payload, {
    config,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  }));

  assert.match(out, /Context .* 6%/);
  assert.match(out, /\(60k\/1M\)/);
  assert.doesNotMatch(out, /Context .* 10%/);
  assert.doesNotMatch(out, /\(100k\/1M\)/);
});

test("usage value can show percent used", () => {
  const cache: Cache = {
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 0.20,
        resetTime: "2026-05-19T12:44:00Z"
      }
    }
  };
  const config = defaultConfig();
  config.color = false;
  config.usageValue = "percent";
  assert.match(renderFixture(config, cache), /Usage ██████░░ 80% ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(renderFixture(config, cache), /↻ 00:44/);
});

test("header uses theme palette ANSI colors", () => {
  const out = renderFixture(defaultConfig());
  const lines = out.split("\n");
  assert.match(lines[0], /\x1b\[34m 3\.5 Flash Med \|  Pro\x1b\[0m/);
  assert.match(lines[0], /\x1b\[33m agy-hud\x1b\[0m/);
  assert.match(lines[0], /\x1b\[35m main\x1b\[0m/);
});

test("remaining usage bar color reflects used percentage", () => {
  const cache: Cache = {
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 0.40,
        resetTime: "2026-05-19T12:44:00Z"
      }
    }
  };
  const out = renderFixture(defaultConfig(), cache);
  assert.match(out, /Usage \x1b\[33m███░░░░░\x1b\[0m/);
  assert.match(strip(out), /40% left/);
});

test("quota miss omits usage without fake limit", () => {
  const out = strip(renderFixture(defaultConfig()));
  assert.doesNotMatch(out, /Limit --/);
  assert.doesNotMatch(out, /Usage/);
  assert.doesNotMatch(out, /weekly/);
});

test("full remaining quota hides inactive reset countdown", () => {
  const cache: Cache = {
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 1,
        resetTime: "2026-05-19T14:44:00Z"
      }
    }
  };
  const out = strip(renderFixture(defaultConfig(), cache));
  assert.match(out, /Usage/);
  assert.match(out, /100% left/);
  assert.doesNotMatch(out, /↻/);
  assert.doesNotMatch(out, /02:44/);
});

test("payload model wins over stale cache active model", () => {
  const payload = fixturePayload();
  payload.model = { display_name: "Claude Sonnet 4.6 (Thinking)" };
  const cache: Cache = {
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 0.8,
        resetTime: "2026-05-19T12:44:00Z"
      },
      "Claude Sonnet 4.6 (Thinking)": {
        remainingFraction: 1,
        resetTime: "2026-05-19T16:44:00Z"
      }
    }
  };

  const out = strip(render(payload, {
    config: defaultConfig(),
    quota: { ...cache, active_model: "Gemini 3.5 Flash (High)" } as Cache,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  }));

  assert.match(out, /Sonnet 4\.6/);
  assert.match(out, /100% left/);
  assert.doesNotMatch(out, /3\.5 Flash High/);
});

test("single-line can show token detail only when it fits", () => {
  const config = defaultConfig();
  config.multiline = false;
  config.showProgressBar = false;
  const out = strip(renderFixture(config));
  assert.doesNotMatch(out, /\n/);
  assert.match(out, /\(125k\/1M\)/);

  const payload = fixturePayload();
  payload.terminal_width = 35;
  const narrow = render(payload, {
    config,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  });
  assert.doesNotMatch(strip(narrow), /\(125k\/1M\)/);
  assert.ok(visibleLen(narrow) <= 35);
});

test("color can be disabled", () => {
  const config = defaultConfig();
  config.color = false;
  assert.doesNotMatch(renderFixture(config), /\x1b\[/);
});

test("icons can be disabled", () => {
  const config = defaultConfig();
  config.showIcons = false;
  const out = strip(renderFixture(config));
  for (const icon of ["", "", "", "", "↻"]) {
    assert.doesNotMatch(out, new RegExp(icon));
  }
  assert.match(out, /3\.5 Flash Med \| Pro/);
  assert.match(out, /agy-hud/);
  assert.match(out, /main/);
});

test("sensitive payload fields never leak", () => {
  const payload = fixturePayload();
  payload.email = "private-email-value";
  payload.session_id = "private-session-value";
  payload.conversation_id = "private-conversation-value";
  payload.transcript_path = "private-transcript-location";
  const out = render(payload, {
    config: defaultConfig(),
    quota: { email: "private-cache-email-value", models: {} },
    now: new Date("2026-05-19T12:00:00Z")
  });
  const lower = strip(out).toLowerCase();
  for (const forbidden of ["private-email-value", "private-session-value", "private-conversation-value", "private-transcript-location", "csrf", "cookie", "token", "key"]) {
    assert.doesNotMatch(lower, new RegExp(forbidden));
  }
});

test("width degradation keeps every line within terminal width", () => {
  for (const width of [10, 20, 30, 40, 60, 80]) {
    const payload = fixturePayload();
    payload.terminal_width = width;
    const out = render(payload, {
      config: defaultConfig(),
      gitBranch: "main",
      now: new Date("2026-05-19T12:00:00Z")
    });
    for (const line of out.split("\n")) {
      assert.ok(visibleLen(line) <= width, `width ${width} exceeded by line ${JSON.stringify(line)}`);
    }
  }
});

test("formatCost formats USD values cleanly", () => {
  assert.equal(formatCost(0), "$0.00");
  assert.equal(formatCost(-1), "$0.00");
  assert.equal(formatCost(Number.NaN), "$0.00");
  assert.equal(formatCost(0.0004), "<$0.001");
  assert.equal(formatCost(0.0042), "$0.004");
  assert.equal(formatCost(0.012), "$0.01");
  assert.equal(formatCost(0.158), "$0.16");
  assert.equal(formatCost(1.25), "$1.25");
  assert.equal(formatCost(12.5), "$12.50");
});

test("renders cost at the end of line 1 when available", () => {
  const payload = fixturePayload();
  payload.cost = {
    total_usd: 0.0345
  };
  const out = strip(render(payload, {
    config: defaultConfig(),
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  }));
  const line1 = out.split("\n")[0];
  assert.match(line1, /Idle │ \$0\.03$/);

  // Can be disabled via showCost
  const noCostConfig = defaultConfig();
  noCostConfig.showCost = false;
  const noCostOut = strip(render(payload, {
    config: noCostConfig,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  }));
  assert.doesNotMatch(noCostOut.split("\n")[0], /\$0\.03/);
});

test("single-line renders cost at the end when it fits", () => {
  const payload = fixturePayload();
  payload.cost = {
    total_usd: 0.12
  };
  const config = defaultConfig();
  config.multiline = false;
  const out = strip(render(payload, {
    config,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  }));
  assert.doesNotMatch(out, /\n/);
  assert.match(out, /Idle  \$0\.12$/);
});

test("multiline drops cost before directory or branch at boundary widths", () => {
  const payload: Payload = {
    model: { display_name: "Claude Sonnet 4.6" }, cwd: "/workspace/project",
    plan_tier: "Google AI Pro", agent_state: "idle", cost: { total_usd: 0 }
  };
  const config = { ...defaultConfig(), color: false, showIcons: false };
  const cases = [
    [40, "Sonnet 4.6 | Pro │ project │ main │ Idle"],
    [32, "Sonnet 4.6 | Pro │ main │ Idle"]
  ] as const;
  for (const [width, want] of cases) {
    assert.equal(render({ ...payload, terminal_width: width }, { config, gitBranch: "main" }).split("\n")[0], want);
  }
});

test("single-line drops cost before quota at boundary width", () => {
  const payload: Payload = {
    model: { display_name: "Claude Sonnet 4.6" }, plan_tier: "Google AI Pro",
    terminal_width: 50, agent_state: "idle", context_window: { used_percentage: 12 },
    quota: { "3p-5h": { remaining_fraction: 0.01 } }, cost: { total_usd: 0 }
  };
  const config = { ...defaultConfig(), multiline: false, color: false, showIcons: false };
  assert.equal(render(payload, { config }), "Sonnet 4.6 | Pro  Ctx 12%  Usage 1% left  Idle");
});

test("cost estimates are marked in both layouts using the provided total", () => {
  for (const multiline of [true, false]) {
    const config = { ...defaultConfig(), multiline, color: false };
    const payload = { ...fixturePayload(), terminal_width: 180, cost: { total_usd: 1.25, subagent_usd: 0.25, estimated: true } };
    assert.match(render(payload, { config }).split("\n")[0], /~\$1\.25$/);
    payload.cost.estimated = false;
    assert.match(render(payload, { config }).split("\n")[0], /[^~]\$1\.25$/);
  }
});

test("invalid cost is omitted rather than reported as zero spend", () => {
  for (const multiline of [true, false]) {
    for (const total_usd of [NaN, Infinity, -1]) {
      const out = render({ ...fixturePayload(), cost: { total_usd }, terminal_width: 180 }, {
        config: { ...defaultConfig(), multiline, color: false }
      });
      assert.doesNotMatch(out, /\$/);
    }
  }
});

test("plan badges normalize known tiers and do not call unknown paid plans Free", () => {
  const cases = [
    ["Pro", "Pro"], ["Google AI Pro", "Pro"], [" pro ", "Pro"],
    ["Ultra", "Ultra"], ["Google AI Ultra", "Ultra"], ["Free", "Free"],
    ["Google AI Free", "Free"], ["Enterprise", "Plan ?"], ["", "Plan ?"],
    ["\x1b]0;untrusted title\x07", "Plan ?"]
  ];
  for (const [plan_tier, want] of cases) {
    const out = render({ model: { display_name: "Claude Sonnet 4.6" }, plan_tier, terminal_width: 100 }, {
      config: { ...defaultConfig(), color: false, showIcons: false }
    });
    assert.equal(out.split("\n")[0], `Sonnet 4.6 | ${want} │ Idle`);
  }
});

test("narrow CJK model headers are clipped to columns without splitting graphemes", () => {
  for (const [display_name, width, want] of [["中文模型", 3, "中"], ["👩‍💻abc", 2, "👩‍💻"], ["e\u0301abc", 1, "e\u0301"]] as const) {
    const out = render({ model: { display_name }, terminal_width: width }, {
      config: { ...defaultConfig(), color: false, showIcons: false, showAgentState: false }
    });
    assert.equal(out.split("\n")[0], want);
  }
});

test("cost and wide workspace labels obey both layout width limits", () => {
  for (const multiline of [true, false]) {
    for (const width of [10, 20, 30, 40, 60, 80]) {
      for (const total_usd of [0, 0.0001, 0.01, 1.25]) {
        const payload = { ...fixturePayload(), cwd: "/workspace/中文目录👩‍💻", terminal_width: width, cost: { total_usd, estimated: true } };
        const out = render(payload, { config: { ...defaultConfig(), multiline }, gitBranch: "main" });
        for (const line of out.split("\n")) assert.ok(visibleLen(line) <= width);
      }
    }
  }
});
