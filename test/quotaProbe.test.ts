import test from "node:test";
import assert from "node:assert/strict";
import { buildQuotaCache, parseAgyServerInfos, parseLanguageServerInfo, parseListeningPorts, refreshQuota } from "../src/quotaProbe";

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

test("parseAgyServerInfos matches agy process with and without arguments", () => {
  const ps = [
    "user 222 0.0 agy",
    "user 333 0.0 /opt/bin/agy --dangerously-skip-permissions",
    "user 444 0.0 agy-helper --not-real"
  ].join("\n");

  assert.deepEqual(parseAgyServerInfos(ps), [
    { pid: "222", csrfToken: "", kind: "agy" },
    { pid: "333", csrfToken: "", kind: "agy" }
  ]);
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
        resetTime: "2026-05-20T08:00:00Z"
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
    resetTime: "2026-06-01T07:52:16Z"
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

test("refreshQuota prefers agy local server over stale language_server when both are running", async () => {
  const writes: Record<string, string> = {};
  const result = await refreshQuota("/tmp/quota_cache.json", {
    ps: () => [
      "user 11111 0.0 0.0 /Applications/Antigravity.app/Contents/Resources/bin/language_server --csrf_token token-1",
      "user 22222 0.0 0.0 agy --dangerously-skip-permissions"
    ].join("\n"),
    lsof: pid => {
      if (pid === "11111") {
        return "lang 11111 user 9u IPv4 0 TCP 127.0.0.1:1111 (LISTEN)\n";
      }
      return "agy 22222 user 9u IPv4 0 TCP 127.0.0.1:2222 (LISTEN)\n";
    },
    request: async (port, csrfToken) => {
      if (port === 2222) {
        assert.equal(csrfToken, "");
        return sampleRawStatus("Claude Opus 4.6 (Thinking)", 0.17);
      }
      assert.equal(port, 1111);
      assert.equal(csrfToken, "token-1");
      return sampleRawStatus("Claude Opus 4.6 (Thinking)", 0.29);
    },
    now: () => new Date("2026-05-20T04:00:00Z"),
    writeFile: (filePath, data) => {
      writes[filePath] = data;
    },
    mkdir: () => {}
  });

  assert.equal(result.ok, true);
  assert.match(writes["/tmp/quota_cache.json"], /"remainingFraction": 0\.17/);
  assert.doesNotMatch(writes["/tmp/quota_cache.json"], /"remainingFraction": 0\.29/);
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

function hintRuntime() {
  const files: Record<string, string> = {};
  const calls = { ps: 0, lsof: 0, requests: [] as number[] };
  const runtime = {
    ps: () => { calls.ps++; return "user 222 0.0 /opt/bin/agy"; },
    lsof: (_pid: string) => { calls.lsof++; return "agy 222 user 9u IPv4 0 TCP 127.0.0.1:2222 (LISTEN)"; },
    processIdentity: (_pid: string): string | null => "Tue May 19 12:00:00 2026 /opt/bin/agy",
    request: async (port: number, csrfToken: string): Promise<unknown> => {
      calls.requests.push(port);
      assert.equal(csrfToken, "");
      return sampleRawStatus("Gemini 3.8 Flash (High)", 0.4);
    },
    now: () => new Date("2026-05-20T04:00:00Z"),
    readFile: (filePath: string) => files[filePath] ?? "",
    writeFile: (filePath: string, data: string) => { files[filePath] = data; },
    mkdir: (_dir: string) => {}
  };
  return { runtime, files, calls };
}

test("a validated server hint skips discovery but still refreshes quota every call", async () => {
  const { runtime, files, calls } = hintRuntime();
  const cachePath = "/tmp/quota-hint-test.json";
  assert.equal((await refreshQuota(cachePath, runtime)).ok, true);
  const hint = JSON.parse(files[`${cachePath}.server.json`] ?? "null");
  assert.deepEqual(hint, {
    pid: "222", port: 2222, identity: "Tue May 19 12:00:00 2026 /opt/bin/agy",
    discoveredAt: "2026-05-20T04:00:00.000Z"
  });
  assert.equal((await refreshQuota(cachePath, runtime)).ok, true);
  assert.equal(calls.ps, 1);
  assert.equal(calls.lsof, 1);
  assert.deepEqual(calls.requests, [2222, 2222]);
  assert.match(files[cachePath], /"remainingFraction": 0.4/);
});

test("a dead or reused PID never receives a cached-port request", async () => {
  for (const identity of [null, "Wed May 20 03:00:00 2026 /opt/bin/agy"]) {
    const { runtime, files, calls } = hintRuntime();
    const cachePath = "/tmp/quota-restart-test.json";
    await refreshQuota(cachePath, runtime);
    calls.requests.length = 0;
    runtime.processIdentity = () => identity;
    runtime.ps = () => { calls.ps++; return ""; };
    const result = await refreshQuota(cachePath, runtime);
    assert.equal(result.ok, false);
    assert.deepEqual(calls.requests, []);
    assert.equal(calls.ps, 2);
    assert.ok(files[cachePath]);
  }
});

test("failed or malformed cached replies rediscover a working server in the same refresh", async () => {
  for (const reply of [null, { notUserStatus: true }]) {
    const { runtime, files, calls } = hintRuntime();
    const cachePath = "/tmp/quota-fallback-test.json";
    await refreshQuota(cachePath, runtime);
    calls.requests.length = 0;
    runtime.lsof = () => { calls.lsof++; return "agy 222 user 9u IPv4 0 TCP 127.0.0.1:3333 (LISTEN)"; };
    runtime.request = async port => {
      calls.requests.push(port);
      return port === 2222 ? reply : sampleRawStatus("Gemini 3.8 Flash (High)", 0.2);
    };
    assert.equal((await refreshQuota(cachePath, runtime)).ok, true);
    assert.deepEqual(calls.requests, [2222, 3333]);
    assert.equal(JSON.parse(files[`${cachePath}.server.json`]).port, 3333);
    assert.match(files[cachePath], /"remainingFraction": 0.2/);
  }
});

test("invalid and expired hints are ignored without trying their port", async () => {
  const valid = { pid: "222", port: 4444, identity: "Tue May 19 12:00:00 2026 /opt/bin/agy", discoveredAt: "2026-05-20T04:00:00.000Z" };
  for (const raw of ["{broken", "null", JSON.stringify({ ...valid, port: -1 }), JSON.stringify({ ...valid, port: 65536 }),
    JSON.stringify({ ...valid, pid: "-1;pwd" }), JSON.stringify({ ...valid, discoveredAt: "2026-05-20T03:54:59Z" }),
    JSON.stringify({ ...valid, discoveredAt: "2026-05-20T05:00:00Z" })]) {
    const { runtime, files, calls } = hintRuntime();
    files["/tmp/quota-invalid-test.json.server.json"] = raw;
    assert.equal((await refreshQuota("/tmp/quota-invalid-test.json", runtime)).ok, true);
    assert.deepEqual(calls.requests, [2222]);
  }
});

test("hint storage failures do not prevent publishing fresh quota", async () => {
  const { runtime, files, calls } = hintRuntime();
  runtime.readFile = () => { throw new Error("unreadable hint"); };
  runtime.writeFile = (filePath, data) => {
    if (filePath.endsWith(".server.json")) throw new Error("hint write denied");
    files[filePath] = data;
  };
  assert.equal((await refreshQuota("/tmp/quota-write-test.json", runtime)).ok, true);
  assert.deepEqual(calls.requests, [2222]);
  assert.match(files["/tmp/quota-write-test.json"], /"remainingFraction": 0.4/);
});

test("discovery continues past a listener returning non-quota JSON", async () => {
  const { runtime, calls } = hintRuntime();
  runtime.lsof = () => "agy 222 user 9u IPv4 0 TCP 127.0.0.1:1111 (LISTEN)\nagy 222 user 9u IPv4 0 TCP 127.0.0.1:2222 (LISTEN)";
  runtime.request = async port => {
    calls.requests.push(port);
    return port === 1111 ? { unrelated: true } : sampleRawStatus("Gemini 3.8 Flash (High)", 0.4);
  };
  assert.equal((await refreshQuota("/tmp/quota-multi-port-test.json", runtime)).ok, true);
  assert.deepEqual(calls.requests, [1111, 2222]);
});

test("unavailable process identity disables hints but not full quota discovery", async () => {
  for (const inspect of [() => null, () => { throw new Error("ps timeout"); }]) {
    const { runtime, calls, files } = hintRuntime();
    runtime.processIdentity = inspect;
    const result = await refreshQuota("/tmp/quota-no-identity-test.json", runtime);
    assert.equal(result.ok, true);
    assert.deepEqual(calls.requests, [2222]);
    assert.match(files["/tmp/quota-no-identity-test.json"], /"remainingFraction": 0.4/);
    assert.equal(files["/tmp/quota-no-identity-test.json.server.json"], undefined);
  }
});
