import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { defaultConfig, loadFromPaths } from "../src/config";

test("default config matches open-source defaults", () => {
  const got = defaultConfig();
  assert.equal(got.showModel, true);
  assert.equal(got.showProgressBar, true);
  assert.equal(got.multiline, true);
  assert.equal(got.color, true);
  assert.equal(got.showGitBranch, true);
  assert.equal(got.showCWD, true);
  assert.equal(got.showAgentState, true);
  assert.equal(got.showCost, true);
  assert.equal(got.showIcons, true);
  assert.equal(got.debug, false);
  assert.equal(got.contextValue, "percent");
  assert.equal(got.usageValue, "remaining");
});

test("load merges partial overrides", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, `{"color":false,"multiline":false,"debug":true,"show_agent_state":false,"show_icons":false,"context_value":"both","usage_value":"percent"}`);

  const got = loadFromPaths([configPath]);

  assert.equal(got.color, false);
  assert.equal(got.multiline, false);
  assert.equal(got.debug, true);
  assert.equal(got.showAgentState, false);
  assert.equal(got.showIcons, false);
  assert.equal(got.contextValue, "both");
  assert.equal(got.usageValue, "percent");
  assert.equal(got.showModel, true);
  assert.equal(got.showProgressBar, true);
  assert.equal(got.showGitBranch, true);
  assert.equal(got.showCWD, true);
});

test("load falls back on invalid JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, "not json");

  assert.deepEqual(loadFromPaths([configPath]), defaultConfig());
});

test("show_cost false is honored from config JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const configPath = path.join(dir, "config.json");
  fs.writeFileSync(configPath, JSON.stringify({ show_cost: false }));
  assert.equal(loadFromPaths([configPath]).showCost, false);
});

test("load uses first existing path", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-"));
  const first = path.join(dir, "missing.json");
  const second = path.join(dir, "config.json");
  fs.writeFileSync(second, `{"show_cwd":false}`);

  assert.equal(loadFromPaths([first, second]).showCWD, false);
});
