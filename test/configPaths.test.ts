import test from "node:test";
import assert from "node:assert";
import os from "node:os";
import path from "node:path";
import { configPaths } from "../src/main";

test("configPaths includes standard antigravity customization roots", () => {
  const paths = configPaths();
  
  const hasWorkspaceRoot = paths.some(p => p.includes(path.join(".agents", "plugins", "agy-hud", "config.json")));
  assert.ok(hasWorkspaceRoot, "Must include workspace .agents root");

  const home = os.homedir();
  if (home) {
    const hasGlobalRoot = paths.some(p => p.includes(path.join(".gemini", "config", "plugins", "agy-hud", "config.json")));
    assert.ok(hasGlobalRoot, "Must include global .gemini root");
  }
});
