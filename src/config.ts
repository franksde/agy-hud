import fs from "node:fs";

export interface Config {
  showModel: boolean;
  showProgressBar: boolean;
  multiline: boolean;
  color: boolean;
  showGitBranch: boolean;
  showCWD: boolean;
  showAgentState: boolean;
  showIcons: boolean;
  contextValue: string;
  usageValue: string;
  debug: boolean;
}

export function defaultConfig(): Config {
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
    debug: false
  };
}

export function loadFromPaths(paths: string[]): Config {
  for (const configPath of paths) {
    let raw: string;
    try {
      raw = fs.readFileSync(configPath, "utf8");
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

function merge(base: Config, patch: Record<string, unknown>): Config {
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
  return base;
}
