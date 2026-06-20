import test from "node:test";
import assert from "node:assert/strict";
import { buildQuotaCache, parseLanguageServerInfo, parseListeningPorts, refreshQuota } from "../src/quotaProbe";

test("parseLanguageServerInfo extracts pid and csrf token", () => {
  const ps = [
    "user 111 0.0 other",
    "user 56588 0.0 /path/language_server --foo bar --csrf_token abc-123XYZ --other"
  ].join("\n");

  assert.deepEqual(parseLanguageServerInfo(ps), { pid: "56588", csrfToken: "abc-123XYZ" });
});

test("parseLanguageServerInfo rejects non-numeric pid", () => {
  const ps = "user nope 0.0 /path/language_server --csrf_token abc-123XYZ";
  assert.equal(parseLanguageServerInfo(ps), null);
});

test("parseListeningPorts extracts unique LISTEN ports", () => {
  const lsof = [
    "COMMAND PID USER FD TYPE DEVICE SIZE/OFF NODE NAME",
    "lang 56588 user 10u IPv4 0 TCP 127.0.0.1:62951 (LISTEN)",
    "lang 56588 user 11u IPv4 0 TCP localhost:62955 (LISTEN)",
    "lang 56588 user 12u IPv4 0 TCP 127.0.0.1:62951 (LISTEN)"
  ].join("\n");

  assert.deepEqual(parseListeningPorts(lsof), [62951, 62955]);
});

test("buildQuotaCache converts GetUserStatus response to agy-hud cache shape", () => {
  const built = buildQuotaCache({
    userStatus: {
      email: "frank@example.com",
      planStatus: { planInfo: { planName: "Google AI Pro" } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Gemini 3.5 Flash (High)",
            quotaInfo: { remainingFraction: 0.42, resetTime: "2026-05-20T08:00:00Z" }
          },
          { label: "No Quota" }
        ]
      }
    }
  }, new Date("2026-05-20T04:00:00Z"));

  assert.deepEqual(built?.cache, {
    timestamp: "2026-05-20T04:00:00Z",
    email: "fra***@example.com",
    plan_name: "Google AI Pro",
    models: {
      "Gemini 3.5 Flash (High)": {
        remainingFraction: 0.42,
        resetTime: "2026-05-20T08:00:00Z",
        buckets: []
      }
    }
  });
  assert.match(built?.summary ?? "", /Gemini 3\.5 Flash \(High\).*Usage\s+58%/);
});

test("buildQuotaCache summary hides reset for untouched quota", () => {
  const built = buildQuotaCache(sampleRawStatus("Gemini 3.5 Flash (High)", 1), new Date("2026-05-20T04:00:00Z"));

  assert.match(built?.summary ?? "", /Gemini 3\.5 Flash \(High\).*Usage\s+0%/);
  assert.doesNotMatch(built?.summary ?? "", /Reset/);
});

test("buildQuotaCache treats reset-only quota info as exhausted", () => {
  const built = buildQuotaCache({
    userStatus: {
      planStatus: { planInfo: { planName: "Pro" } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          {
            label: "Gemini 3.5 Flash (Medium)",
            quotaInfo: { resetTime: "2026-06-01T07:52:16Z" }
          }
        ]
      }
    }
  }, new Date("2026-06-01T04:00:00Z"));

  assert.deepEqual((built?.cache as { models: Record<string, { remainingFraction: number }> })?.models["Gemini 3.5 Flash (Medium)"], {
    remainingFraction: 0,
    resetTime: "2026-06-01T07:52:16Z",
    buckets: []
  });
  assert.match(built?.summary ?? "", /Gemini 3\.5 Flash \(Medium\).*Usage\s+100%/);
});

test("refreshQuota queries first working port and writes cache", async () => {
  const writes: Record<string, string> = {};
  const result = await refreshQuota("/tmp/quota_cache.json", {
    ps: () => "user 56588 0.0 /path/language_server --csrf_token token-1",
    lsof: () => "lang 56588 user 10u IPv4 0 TCP 127.0.0.1:1111 (LISTEN)\nlang 56588 user 11u IPv4 0 TCP 127.0.0.1:2222 (LISTEN)",
    request: async port => port === 1111 ? null : {
      userStatus: {
        planStatus: { planInfo: { planName: "Pro" } },
        cascadeModelConfigData: {
          clientModelConfigs: [
            { label: "Gemini 3.5 Flash (Medium)", quotaInfo: { remainingFraction: 0.2, resetTime: "2026-05-20T09:00:00Z" } }
          ]
        }
      }
    },
    now: () => new Date("2026-05-20T04:00:00Z"),
    mkdir: () => {},
    writeFile: (filePath, data) => { writes[filePath] = data; }
  });

  assert.equal(result.ok, true);
  assert.match(writes["/tmp/quota_cache.json"], /Gemini 3\.5 Flash \(Medium\)/);
});

test("refreshQuota falls back to agy local server ports without csrf token", async () => {
  const writes: Record<string, string> = {};
  const result = await refreshQuota("/tmp/quota_cache.json", {
    ps: () => "user 20331 0.0 0.0 agy --dangerously-skip-permissions\n",
    lsof: () => "agy 20331 user 9u IPv4 0 TCP 127.0.0.1:57150 (LISTEN)\n",
    request: async (port, csrfToken) => {
      assert.equal(port, 57150);
      assert.equal(csrfToken, "");
      return sampleRawStatus("Gemini 3.5 Flash (High)", 0.4);
    },
    now: () => new Date("2026-05-20T04:00:00Z"),
    writeFile: (filePath, data) => {
      writes[filePath] = data;
    },
    mkdir: () => {}
  });

  assert.equal(result.ok, true);
  assert.match(writes["/tmp/quota_cache.json"], /Gemini 3\.5 Flash \(High\)/);
});

test("refreshQuota skips stale agy process candidates", async () => {
  const writes: Record<string, string> = {};
  const result = await refreshQuota("/tmp/quota_cache.json", {
    ps: () => [
      "user 11111 0.0 0.0 /bin/zsh -c ps axww | rg agy",
      "user 22222 0.0 0.0 agy --dangerously-skip-permissions"
    ].join("\n"),
    lsof: pid => {
      if (pid === "11111") {
        throw new Error("process disappeared");
      }
      return "agy 22222 user 9u IPv4 0 TCP 127.0.0.1:57150 (LISTEN)\n";
    },
    request: async () => sampleRawStatus("Gemini 3.5 Flash (High)", 0.4),
    now: () => new Date("2026-05-20T04:00:00Z"),
    writeFile: (filePath, data) => {
      writes[filePath] = data;
    },
    mkdir: () => {}
  });

  assert.equal(result.ok, true);
  assert.match(writes["/tmp/quota_cache.json"], /Gemini 3\.5 Flash \(High\)/);
});

test("refreshQuota reports error branches without leaking csrf token", async () => {
  const token = "secret-token-123";
  const cases = [
    {
      name: "no server",
      runtime: {
        ps: () => "user 111 0.0 other",
        lsof: () => "",
        request: async () => null
      },
      message: /No running language_server or agy quota server/
    },
    {
      name: "no listening ports",
      runtime: {
        ps: () => `user 56588 0.0 /path/language_server --csrf_token ${token}`,
        lsof: () => "",
        request: async () => null
      },
      message: /No listening ports/
    },
    {
      name: "all ports fail",
      runtime: {
        ps: () => `user 56588 0.0 /path/language_server --csrf_token ${token}`,
        lsof: () => "lang 56588 user 10u IPv4 0 TCP 127.0.0.1:1111 (LISTEN)",
        request: async () => null
      },
      message: /Failed to query GetUserStatus/
    },
    {
      name: "malformed response",
      runtime: {
        ps: () => `user 56588 0.0 /path/language_server --csrf_token ${token}`,
        lsof: () => "lang 56588 user 10u IPv4 0 TCP 127.0.0.1:1111 (LISTEN)",
        request: async () => ({ notUserStatus: true })
      },
      message: /malformed quota data/
    }
  ];

  for (const item of cases) {
    const result = await refreshQuota("/tmp/quota_cache.json", {
      ...item.runtime,
      now: () => new Date("2026-05-20T04:00:00Z"),
      writeFile: () => {},
      mkdir: () => {}
    });
    assert.equal(result.ok, false, item.name);
    assert.match(result.message, item.message, item.name);
    assert.doesNotMatch(`${result.message}\n${result.summary ?? ""}`, new RegExp(token), item.name);
  }
});

function sampleRawStatus(label: string, remainingFraction: number): unknown {
  return {
    userStatus: {
      planStatus: { planInfo: { planName: "Pro" } },
      cascadeModelConfigData: {
        clientModelConfigs: [
          { label, quotaInfo: { remainingFraction, resetTime: "2026-05-20T09:00:00Z" } }
        ]
      }
    }
  };
}
