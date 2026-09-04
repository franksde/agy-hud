import { Config, defaultConfig, parseConfig } from "./config";

// The four Private Use Area glyphs src/statusline.ts renders. A terminal font without Nerd Font
// coverage draws each of them as a box or [?]; U+21BB, the quota reset arrow, is standard Unicode
// and keeps rendering, which is why a broken HUD still shows one working symbol.
export const iconProbe: { glyph: string; label: string }[] = [
  { glyph: "", label: "model" },
  { glyph: "", label: "plan" },
  { glyph: "", label: "branch" },
  { glyph: "", label: "folder" }
];

export interface DoctorDeps {
  version: string;
  nodeVersion: string;
  platform: string;
  env: Record<string, string | undefined>;
  homedir: string;
  configPaths: string[];
  // The user-level config path the runtime would resolve, honouring XDG_CONFIG_HOME. Supplied by
  // the caller rather than pattern-matched out of configPaths, which cannot recognise a custom XDG
  // directory and would silently suggest a different file from the one the loader prefers.
  userConfigPath: string;
  readFile(path: string): string | null;
  listDir(path: string): string[];
  // Linux font discovery goes through fc-list. `null` means the command is unavailable, which is
  // reported as unknown rather than as a missing font.
  fcList?: () => string | null;
}

export interface DoctorReport {
  version: string;
  homedir: string;
  nodeVersion: string;
  nodeOk: boolean;
  statuslineCommand: string | null;
  statuslineWired: boolean;
  configPath: string | null;
  suggestedConfigPath: string;
  showIcons: boolean;
  terminal: string;
  remoteSession: boolean;
  nerdFont: "found" | "not-found" | "unknown";
  nerdFontMatches: string[];
}

// Nerd Font names show up as "JetBrainsMono Nerd Font", "HackNerdFont-Regular" and
// "Hack-Nerd-Font-Regular", so the separator between the two words has to be optional punctuation
// rather than whitespace alone.
const nerdFontPattern = /nerd[\s_-]*font|nf-[a-z]/i;

export function collectDoctorReport(deps: DoctorDeps): DoctorReport {
  const config = resolveConfig(deps);
  const [nerdFont, nerdFontMatches] = scanNerdFont(deps);
  const [statuslineCommand, statuslineWired] = readStatuslineCommand(deps);
  // Config lookup stops at the first readable candidate, and a config.json next to the bundle or in
  // the plugin root outranks the home path. Suggesting the home path while such a file exists would
  // hand the user an edit the HUD never reads, so the fix always names the file already in effect.
  const suggested = config.path ?? homeConfigPath(deps);
  return {
    version: deps.version,
    homedir: deps.homedir,
    nodeVersion: deps.nodeVersion,
    nodeOk: nodeMajor(deps.nodeVersion) >= 18,
    statuslineCommand,
    statuslineWired,
    configPath: config.path,
    suggestedConfigPath: suggested,
    showIcons: config.value.showIcons,
    terminal: detectTerminal(deps.env),
    remoteSession: Boolean(deps.env.SSH_CONNECTION || deps.env.SSH_TTY),
    nerdFont,
    nerdFontMatches
  };
}

// TERM_PROGRAM is authoritative when present. kitty and Alacritty deliberately do not set it, so
// they are recognised by the variables they do export; TERM is checked last because a multiplexer
// or an ssh hop can carry a stale value across from another terminal.
function detectTerminal(env: Record<string, string | undefined>): string {
  if (env.TERM_PROGRAM) {
    return env.TERM_PROGRAM;
  }
  if (env.KITTY_WINDOW_ID) {
    return "kitty";
  }
  if (env.ALACRITTY_SOCKET || env.ALACRITTY_WINDOW_ID) {
    return "Alacritty";
  }
  const term = env.TERM ?? "";
  if (term.includes("kitty")) {
    return "kitty";
  }
  if (term.includes("alacritty")) {
    return "Alacritty";
  }
  return "unknown";
}

function nodeMajor(version: string): number {
  const match = /^v?(\d+)\./.exec(version);
  return match ? Number(match[1]) : -1;
}

function resolveConfig(deps: DoctorDeps): { path: string | null; value: Config } {
  for (const candidate of deps.configPaths) {
    const raw = deps.readFile(candidate);
    if (raw !== null) {
      return { path: candidate, value: parseConfig(raw) };
    }
  }
  return { path: null, value: defaultConfig() };
}

function homeConfigPath(deps: DoctorDeps): string {
  if (deps.userConfigPath !== "") {
    return deps.userConfigPath;
  }
  return deps.homedir === "" ? "/.config/agy-hud/config.json" : `${deps.homedir}/.config/agy-hud/config.json`;
}

function readStatuslineCommand(deps: DoctorDeps): [string | null, boolean] {
  const raw = deps.readFile(`${deps.homedir}/.gemini/antigravity-cli/settings.json`);
  if (raw === null) {
    return [null, false];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [null, false];
  }
  const statusLine = (parsed as { statusLine?: { command?: unknown } } | null)?.statusLine;
  const command = typeof statusLine?.command === "string" ? statusLine.command : null;
  if (command === null || command === "") {
    return [null, false];
  }
  return [command, command.includes("agy-hud")];
}

function scanNerdFont(deps: DoctorDeps): ["found" | "not-found" | "unknown", string[]] {
  if (deps.platform === "linux") {
    const output = deps.fcList ? deps.fcList() : null;
    if (output === null) {
      return ["unknown", []];
    }
    const matches = output
      .split("\n")
      .filter(line => nerdFontPattern.test(line))
      .slice(0, 5)
      .map(clip);
    return [matches.length > 0 ? "found" : "not-found", matches];
  }
  const matches: string[] = [];
  for (const dir of fontDirs(deps)) {
    for (const entry of deps.listDir(dir)) {
      if (nerdFontPattern.test(entry) && !matches.includes(entry)) {
        matches.push(clip(entry));
      }
    }
  }
  return [matches.length > 0 ? "found" : "not-found", matches.slice(0, 5)];
}

// One font name should never be able to run the report line off the screen.
function clip(name: string): string {
  const trimmed = name.trim();
  return trimmed.length > 30 ? trimmed.slice(0, 29) + "…" : trimmed;
}

function fontDirs(deps: DoctorDeps): string[] {
  return [`${deps.homedir}/Library/Fonts`, "/Library/Fonts", "/System/Library/Fonts"];
}

// Where each terminal keeps the font setting that actually decides whether the HUD icons render.
// Installing a Nerd Font never changes rendering on its own; this setting is the step that does.
function fontSettingHint(terminal: string): string {
  switch (terminal) {
    case "iTerm.app":
      return "iTerm2 -> Settings -> Profiles -> Text -> Font";
    case "Apple_Terminal":
      return "Terminal -> Settings -> Profiles -> Text -> Font";
    case "vscode":
      return "VS Code setting terminal.integrated.fontFamily";
    case "ghostty":
      return "font-family in ~/.config/ghostty/config";
    case "WezTerm":
      return "wezterm.font in ~/.wezterm.lua";
    case "Alacritty":
      return "font.normal.family in ~/.config/alacritty/alacritty.toml";
    case "kitty":
      return "font_family in ~/.config/kitty/kitty.conf";
    case "Hyper":
      return "config.fontFamily in ~/.hyper.js";
    case "tabby":
      return "Tabby -> Settings -> Appearance -> Font";
    default:
      return "your terminal's font setting (profile or config file)";
  }
}

// README's privacy section asks users not to put local machine paths in issues, and this report is
// what they will paste when the HUD looks wrong. Abbreviating the home prefix drops the account name
// while keeping every path recognizable. The JSON form keeps absolute paths: it is read by an agent
// on the same machine, and shortening them there would only make it harder to act on.
function abbreviate(text: string, homedir: string): string {
  // "/" as a home directory would match every absolute path on the system, rewriting the whole
  // filesystem as if it sat under home. An empty home has nothing to abbreviate either.
  if (homedir === "" || homedir === "/") {
    return text;
  }
  // The value can be a whole command — /statusline accepts `node <path> statusline` — so the home
  // prefix has to be replaced wherever it appears, not only at the start.
  const prefix = (homedir.endsWith("/") ? homedir.slice(0, -1) : homedir) + "/";
  return text.split(prefix).join("~/");
}

export function formatDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  const row = (label: string, value: string) => lines.push(`  ${label.padEnd(12)}${value}`);
  const short = (filePath: string) => abbreviate(filePath, report.homedir);

  lines.push("agy-hud doctor");
  lines.push("");
  row("plugin", report.version);
  row("node", `${report.nodeVersion}${report.nodeOk ? "" : "   too old, 18+ required"}`);
  row("statusline", report.statuslineCommand
    ? `${short(report.statuslineCommand)}${report.statuslineWired ? "" : "   not pointing at agy-hud"}`
    : "not configured — run /statusline <plugin-root>/hooks/status-line.sh in the CLI");
  row("config", report.configPath
    ? `${short(report.configPath)} (show_icons: ${report.showIcons})`
    : `none found, using defaults (show_icons: ${report.showIcons})`);
  row("terminal", report.terminal);
  row("session", report.remoteSession ? "remote (SSH)" : "local");
  const fontLines = nerdFontLines(report);
  row("nerd font", fontLines[0]);
  for (const extra of fontLines.slice(1)) {
    lines.push(" ".repeat(14) + extra);
  }
  lines.push("");
  lines.push("Icon probe. Each label below must be preceded by its own distinct glyph:");
  lines.push("");
  lines.push(`  ${iconProbe.map(icon => `${icon.glyph} ${icon.label}`).join("    ")}`);
  lines.push("");
  lines.push("A box, [?], or blank in front of any label means the terminal font has no Nerd Font");
  lines.push("glyph for it. The HUD is working; the font cannot draw it. Two ways forward:");
  lines.push("");
  lines.push("  A. Turn icons off. Instant, always works, no font needed:");
  if (report.configPath) {
    lines.push(`       This install already has a config file, and it is the one that wins:`);
    lines.push(`         ${short(report.configPath)}`);
    lines.push('       Set "show_icons": false in it. Edit that file, do not create another one:');
    lines.push("       a config next to the bundle outranks the one under ~/.config, so a new file");
    lines.push("       there would be shadowed and nothing would change.");
  } else {
    lines.push(`       mkdir -p ${short(dirname(report.suggestedConfigPath))}`);
    lines.push(`       echo '{"show_icons": false}' > ${short(report.suggestedConfigPath)}`);
  }
  lines.push("");
  lines.push("  B. Keep icons. This takes two steps, and the second is the one that matters:");
  lines.push("       1. Install a Nerd Font, e.g. brew install --cask font-hack-nerd-font");
  lines.push(`       2. Point the terminal at it: ${fontSettingHint(report.terminal)}`);
  lines.push("     Step 1 alone changes nothing on screen.");
  if (report.remoteSession) {
    lines.push("");
    lines.push("  This is an SSH session. Glyphs are drawn by the terminal on your local machine, so");
    lines.push("  a font installed on this host cannot change anything. Do both steps of option B on");
    lines.push("  the local machine, or take option A here.");
  }
  return lines.join("\n") + "\n";
}

function dirname(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  if (cut < 0) {
    return filePath;
  }
  // A file directly under the root has its separator at index 0; slicing there would yield "", and
  // returning the path itself would emit `mkdir -p <the config file>`.
  return cut === 0 ? "/" : filePath.slice(0, cut);
}

// Both directions of this scan are unreliable, so neither is ever stated as a verdict. An installed
// font is not necessarily the one the terminal draws with, and terminals such as Ghostty, WezTerm
// and kitty carry their own Nerd Font symbol fallback, so a clean scan can still render every glyph.
// The probe is the only thing that answers the question, and it needs a human to read it.
// Returned as lines because every caveat here outruns a single terminal row.
function nerdFontLines(report: DoctorReport): string[] {
  const out: string[] = [];
  switch (report.nerdFont) {
    case "found":
      out.push(`found ${report.nerdFontMatches.slice(0, 2).join(", ")}`);
      out.push("(heuristic: an installed font is not necessarily the one your terminal uses)");
      break;
    case "not-found":
      out.push("none found in the system font directories — not a verdict:");
      out.push("Ghostty, WezTerm and kitty ship their own glyph fallback, so read");
      out.push("the probe below before installing anything");
      break;
    default:
      out.push("could not scan (fc-list unavailable)");
      break;
  }
  if (report.remoteSession && report.nerdFont !== "unknown") {
    // Scanning this host says nothing about the machine that draws the glyphs.
    out.push("scanned on this host, which is not the one drawing the glyphs");
  }
  return out;
}
