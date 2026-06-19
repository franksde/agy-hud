import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { strip, visibleLen } from "../src/ansi";
import { defaultConfig, Config } from "../src/config";
import { Cache } from "../src/quota";
import { Payload, render, shortModelName, renderModelSegment } from "../src/statusline";

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
  assert.doesNotMatch(lines[0], /  \|  |  │  /);
  assert.match(lines[1], /Context/);
  assert.match(lines[1], /12%/);
  assert.doesNotMatch(lines[1], /  \|  |  │  /);
  assert.match(lines[1], /Usage/);
  assert.match(lines[1], /20% left/);
  assert.match(lines[1], /Usage ██░░░░░░ 20% left ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(lines[1], /↻ 00:44/);
  assert.doesNotMatch(lines[1], /resets/);
  assert.match(lines[1], /Idle/);
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

test("official quota payload wins over stale quota cache", () => {
  const payload = fixturePayload();
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

  assert.match(out, /Usage ███████░ 84% left ↻ Reset \d\d:\d\d/);
  assert.doesNotMatch(out, /20% left/);
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

test("context value formats", () => {
  const cases: Record<string, string> = {
    percent: "Context █░░░░░░░ 12%",
    tokens: "Context █░░░░░░░ 130k/1M",
    both: "Context █░░░░░░░ 12% (130k/1M)"
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

  const out = strip(render(payload, {
    config,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  }));

  assert.match(out, /Context .* 6%/);
  assert.doesNotMatch(out, /Context .* 10%/);
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
  assert.match(out, /\(130k\/1M\)/);

  const payload = fixturePayload();
  payload.terminal_width = 35;
  const narrow = render(payload, {
    config,
    gitBranch: "main",
    now: new Date("2026-05-19T12:00:00Z")
  });
  assert.doesNotMatch(strip(narrow), /\(130k\/1M\)/);
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

test("renderModelSegment respects showPlanTier", () => {
  const config = defaultConfig();
  config.showPlanTier = false;
  const result = renderModelSegment("Gemini", "Pro", config);
  assert.strictEqual(result.includes("Pro"), false);
});
