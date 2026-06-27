import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatResetCountdown, formatResetDuration, load, matchModel, usagePercent } from "../src/quota";

test("load cache hit and model match", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const cachePath = path.join(dir, "quota_cache.json");
  const raw = `{"timestamp":"2026-05-19T12:00:00Z","email":"masked@example.invalid","plan_name":"Pro","models":{"Gemini 3.5 Flash (Medium)":{"remainingFraction":0.2,"resetTime":"2026-05-19T12:44:00Z"}}}`;
  fs.writeFileSync(cachePath, raw);

  const [cache, ok] = load(cachePath);
  assert.equal(ok, true);
  const [model, matched] = matchModel(cache, "Gemini 3.5 Flash (Medium)");
  assert.equal(matched, true);
  assert.equal(usagePercent(model!), 80);
});

test("model match tolerates normalized labels", () => {
  const [model, matched] = matchModel({
    models: {
      "Gemini 3.5 Flash (Medium)": {
        remainingFraction: 0.4,
        resetTime: "2026-05-19T12:44:00Z"
      }
    }
  }, "3.5 Flash Medium");

  assert.equal(matched, true);
  assert.equal(usagePercent(model!), 60);
});

test("load cache miss and invalid fallback", () => {
  assert.equal(load(path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-")), "missing.json"))[1], false);
  const badPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-")), "bad.json");
  fs.writeFileSync(badPath, "not json");
  assert.equal(load(badPath)[1], false);
});

test("format reset countdown", () => {
  const now = new Date("2026-05-19T12:00:00Z");
  const cases: Record<string, string> = {
    "2026-05-19T12:44:00Z": "00:44",
    "2026-05-19T17:33:00Z": "05:33",
    "2026-05-20T15:00:00Z": "27:00",
    "2026-05-19T13:56:13Z": "01:56",
    "2026-05-19T11:59:00Z": "00:00",
    "2026-05-19T12:05:59Z": "00:05",
    "2026-05-19T12:00:01Z": "00:00",
    "": "",
    bad: ""
  };

  for (const [input, want] of Object.entries(cases)) {
    assert.equal(formatResetCountdown(input, now), want);
  }
});

test("formatResetDuration formats properly", () => {
  const now = new Date("2026-06-19T12:00:00Z");
  assert.strictEqual(formatResetDuration("2026-06-19T14:15:00Z", now), "2h 15m");
  assert.strictEqual(formatResetDuration("2026-06-24T14:00:00Z", now), "5d 2h");
  assert.strictEqual(formatResetDuration("2026-06-19T11:00:00Z", now), "0m");
});
