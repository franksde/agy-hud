import test from "node:test";
import assert from "node:assert/strict";
import { DoctorDeps, collectDoctorReport, formatDoctorReport } from "../src/doctor";

function deps(overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return {
    version: "0.1.10",
    nodeVersion: "v22.14.0",
    platform: "darwin",
    env: {},
    homedir: "/home/u",
    configPaths: [],
    userConfigPath: "/home/u/.config/agy-hud/config.json",
    readFile: () => null,
    listDir: () => [],
    ...overrides
  };
}

test("reports node version and flags releases older than 18", () => {
  assert.equal(collectDoctorReport(deps({ nodeVersion: "v22.14.0" })).nodeOk, true);
  assert.equal(collectDoctorReport(deps({ nodeVersion: "v18.0.0" })).nodeOk, true);
  assert.equal(collectDoctorReport(deps({ nodeVersion: "v16.20.2" })).nodeOk, false);
  assert.equal(collectDoctorReport(deps({ nodeVersion: "not-a-version" })).nodeOk, false);
});

test("reads statusLine.command from the Antigravity settings file", () => {
  const settings = "/home/u/.gemini/antigravity-cli/settings.json";
  const report = collectDoctorReport(deps({
    readFile: p => (p === settings
      ? JSON.stringify({ statusLine: { command: "/home/u/.gemini/config/plugins/agy-hud/hooks/status-line.sh" } })
      : null)
  }));
  assert.equal(report.statuslineCommand, "/home/u/.gemini/config/plugins/agy-hud/hooks/status-line.sh");
  assert.equal(report.statuslineWired, true);
});

test("treats a statusline wired to another command as not wired", () => {
  const report = collectDoctorReport(deps({
    readFile: () => JSON.stringify({ statusLine: { command: "/usr/local/bin/starship" } })
  }));
  assert.equal(report.statuslineWired, false);
});

test("reports a missing or unparsable settings file without throwing", () => {
  assert.equal(collectDoctorReport(deps()).statuslineCommand, null);
  assert.equal(collectDoctorReport(deps({ readFile: () => "{ broken" })).statuslineCommand, null);
});

test("resolves the effective config path and show_icons", () => {
  const report = collectDoctorReport(deps({
    configPaths: ["/missing/config.json", "/home/u/.config/agy-hud/config.json"],
    readFile: p => (p === "/home/u/.config/agy-hud/config.json" ? '{"show_icons": false}' : null)
  }));
  assert.equal(report.configPath, "/home/u/.config/agy-hud/config.json");
  assert.equal(report.showIcons, false);
});

test("falls back to the built-in defaults when no config file exists", () => {
  const report = collectDoctorReport(deps({ configPaths: ["/missing/config.json"] }));
  assert.equal(report.configPath, null);
  assert.equal(report.showIcons, true);
});

test("points the fix at the config file already in effect, not at a lower-priority path", () => {
  // A config.json next to the bundle outranks ~/.config/agy-hud/config.json in configPaths(), so
  // telling the user to edit the home path there would write a file the HUD never reads.
  const active = "/home/u/.gemini/config/plugins/agy-hud/config.json";
  const report = collectDoctorReport(deps({
    configPaths: [active, "/home/u/.config/agy-hud/config.json"],
    readFile: p => (p === active ? '{"show_icons": true}' : null)
  }));
  assert.equal(report.configPath, active);
  assert.equal(report.suggestedConfigPath, active);
  const text = formatDoctorReport(report);
  // Home paths are abbreviated in the human report, so assert on the displayed form.
  assert.ok(text.includes("~/.gemini/config/plugins/agy-hud/config.json"), "fix must name the active config file");
  assert.ok(!text.includes("~/.config/agy-hud/config.json"), "fix must not name a shadowed path");
});

test("suggests the home config path when nothing is in effect yet", () => {
  const report = collectDoctorReport(deps({
    configPaths: ["/home/u/.gemini/config/plugins/agy-hud/config.json", "/home/u/.config/agy-hud/config.json"]
  }));
  assert.equal(report.configPath, null);
  assert.equal(report.suggestedConfigPath, "/home/u/.config/agy-hud/config.json");
});

test("warns when an existing config file must be edited rather than created", () => {
  const active = "/home/u/.config/agy-hud/config.json";
  const editing = formatDoctorReport(collectDoctorReport(deps({
    configPaths: [active],
    readFile: () => "{}"
  })));
  assert.match(editing, /already has a config file/i);
});

test("identifies the terminal emulator from TERM_PROGRAM", () => {
  assert.equal(collectDoctorReport(deps({ env: { TERM_PROGRAM: "iTerm.app" } })).terminal, "iTerm.app");
  assert.equal(collectDoctorReport(deps({ env: {} })).terminal, "unknown");
});

test("detects a remote session so font advice can be scoped to the local machine", () => {
  assert.equal(collectDoctorReport(deps({ env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" } })).remoteSession, true);
  assert.equal(collectDoctorReport(deps({ env: { SSH_TTY: "/dev/pts/3" } })).remoteSession, true);
  assert.equal(collectDoctorReport(deps({ env: {} })).remoteSession, false);
});

test("scans macOS font directories for Nerd Font families", () => {
  const report = collectDoctorReport(deps({
    platform: "darwin",
    listDir: p => (p === "/home/u/Library/Fonts" ? ["HackNerdFont-Regular.ttf", "Inter.ttc"] : [])
  }));
  assert.equal(report.nerdFont, "found");
  assert.deepEqual(report.nerdFontMatches, ["HackNerdFont-Regular.ttf"]);
});

test("reports not-found when macOS font directories hold no Nerd Font", () => {
  const report = collectDoctorReport(deps({ platform: "darwin", listDir: () => ["Inter.ttc"] }));
  assert.equal(report.nerdFont, "not-found");
  assert.deepEqual(report.nerdFontMatches, []);
});

test("uses fc-list on Linux and stays unknown when it is unavailable", () => {
  const found = collectDoctorReport(deps({
    platform: "linux",
    fcList: () => "/usr/share/fonts/JetBrainsMonoNerdFont-Regular.ttf: JetBrainsMono Nerd Font:style=Regular"
  }));
  assert.equal(found.nerdFont, "found");
  assert.equal(collectDoctorReport(deps({ platform: "linux", fcList: () => "" })).nerdFont, "not-found");
  assert.equal(collectDoctorReport(deps({ platform: "linux", fcList: () => null })).nerdFont, "unknown");
  assert.equal(collectDoctorReport(deps({ platform: "linux" })).nerdFont, "unknown");
});

test("never reports a scan result as proof, only as a heuristic", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({
    platform: "darwin",
    listDir: () => ["HackNerdFont-Regular.ttf"]
  })));
  assert.match(text, /heuristic/i);
});

test("defers to the probe when no font is found, since terminals can ship their own glyphs", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({ platform: "darwin", listDir: () => [] })));
  assert.match(text, /probe below/i);
  assert.match(text, /Ghostty/);
});

test("prints an icon probe carrying the exact glyphs the HUD renders", () => {
  const text = formatDoctorReport(collectDoctorReport(deps()));
  for (const glyph of ["", "", "", ""]) {
    assert.ok(text.includes(glyph), `probe is missing ${JSON.stringify(glyph)}`);
  }
});

test("gives terminal-specific font instructions for the detected terminal", () => {
  const iterm = formatDoctorReport(collectDoctorReport(deps({ env: { TERM_PROGRAM: "iTerm.app" } })));
  assert.match(iterm, /Profiles/);
  const code = formatDoctorReport(collectDoctorReport(deps({ env: { TERM_PROGRAM: "vscode" } })));
  assert.match(code, /terminal\.integrated\.fontFamily/);
});

test("warns that installing a font on a remote host cannot change local rendering", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({ env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" } })));
  assert.match(text, /local machine/i);
});

test("always offers the show_icons escape hatch with a copyable config path", () => {
  const text = formatDoctorReport(collectDoctorReport(deps()));
  assert.match(text, /"show_icons": false/);
  assert.match(text, /~\/\.config\/agy-hud\/config\.json/);
});

test("abbreviates home paths in the human report, which users paste into issues", () => {
  // README's privacy section tells users not to put local machine paths in issues, and doctor
  // output is exactly what they will paste when reporting a rendering problem. The home prefix
  // carries their account name and nothing diagnostic.
  const text = formatDoctorReport(collectDoctorReport(deps({
    homedir: "/home/u",
    configPaths: ["/home/u/.config/agy-hud/config.json"],
    readFile: p => (p === "/home/u/.config/agy-hud/config.json"
      ? "{}"
      : (p === "/home/u/.gemini/antigravity-cli/settings.json"
        ? JSON.stringify({ statusLine: { command: "/home/u/.gemini/config/plugins/agy-hud/hooks/status-line.sh" } })
        : null))
  })));
  assert.ok(!text.includes("/home/u/"), "human output must not carry the home prefix");
  assert.match(text, /~\/\.config\/agy-hud\/config\.json/);
  assert.match(text, /~\/\.gemini\/config\/plugins\/agy-hud\/hooks\/status-line\.sh/);
});

test("abbreviates only a real home prefix, not a lookalike path", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({
    homedir: "/home/u",
    configPaths: ["/home/username/.config/agy-hud/config.json"],
    readFile: p => (p === "/home/username/.config/agy-hud/config.json" ? "{}" : null)
  })));
  assert.ok(text.includes("/home/username/.config/agy-hud/config.json"), "must not truncate /home/username");
});

test("leaves absolute paths intact in JSON, which agents use locally", () => {
  const report = collectDoctorReport(deps({
    homedir: "/home/u",
    configPaths: ["/home/u/.config/agy-hud/config.json"],
    readFile: p => (p === "/home/u/.config/agy-hud/config.json" ? "{}" : null)
  }));
  assert.equal(report.configPath, "/home/u/.config/agy-hud/config.json");
  assert.equal(report.suggestedConfigPath, "/home/u/.config/agy-hud/config.json");
});

test("does not abbreviate when the home directory is the filesystem root", () => {
  // A container or root account can have HOME=/. Every absolute path starts with "/", so a naive
  // prefix match would rewrite the whole filesystem as if it lived under home.
  const text = formatDoctorReport(collectDoctorReport(deps({
    homedir: "/",
    userConfigPath: "/.config/agy-hud/config.json",
    configPaths: ["/.config/agy-hud/config.json"],
    readFile: p => (p === "/.config/agy-hud/config.json" ? "{}" : null)
  })));
  // The prose mentions ~/.config as a literal, so assert on the resolved path instead.
  assert.ok(!text.includes("~/.config/agy-hud/config.json"), "root home must not be abbreviated");
  assert.ok(text.includes("/.config/agy-hud/config.json"));
});

test("abbreviates a home path embedded in a command, not only a bare path", () => {
  // /statusline can be wired to `node <path> statusline`, so the home prefix appears mid-string.
  // Matching only the start of the value would print the account name in a report meant for issues.
  const settings = "/home/u/.gemini/antigravity-cli/settings.json";
  const command = "node /home/u/.gemini/config/plugins/agy-hud/dist/agy-hud.js statusline";
  const text = formatDoctorReport(collectDoctorReport(deps({
    readFile: p => (p === settings ? JSON.stringify({ statusLine: { command } }) : null)
  })));
  assert.ok(!text.includes("/home/u/"), "no home prefix may survive anywhere in the report");
  assert.match(text, /node ~\/\.gemini\/config\/plugins\/agy-hud\/dist\/agy-hud\.js statusline/);
});

test("suggests the user config path the runtime actually resolves, including a custom XDG one", () => {
  const report = collectDoctorReport(deps({
    userConfigPath: "/home/u/.xdg_config/agy-hud/config.json",
    configPaths: ["/home/u/.xdg_config/agy-hud/config.json", "/home/u/.config/agy-hud/config.json"]
  }));
  assert.equal(report.suggestedConfigPath, "/home/u/.xdg_config/agy-hud/config.json");
});

test("builds a usable mkdir for a config directly under the root", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({
    homedir: "",
    userConfigPath: "/config.json",
    configPaths: []
  })));
  assert.match(text, /mkdir -p \/$/m);
  assert.ok(!text.includes("mkdir -p /config.json"), "must not create the config file as a directory");
});

test("identifies terminals that refuse to set TERM_PROGRAM", () => {
  assert.equal(collectDoctorReport(deps({ env: { KITTY_WINDOW_ID: "1" } })).terminal, "kitty");
  assert.equal(collectDoctorReport(deps({ env: { TERM: "xterm-kitty" } })).terminal, "kitty");
  assert.equal(collectDoctorReport(deps({ env: { ALACRITTY_SOCKET: "/tmp/a.sock" } })).terminal, "Alacritty");
  assert.equal(collectDoctorReport(deps({ env: { ALACRITTY_WINDOW_ID: "9" } })).terminal, "Alacritty");
  assert.equal(collectDoctorReport(deps({ env: { TERM: "alacritty" } })).terminal, "Alacritty");
  // TERM_PROGRAM stays authoritative: a multiplexer or ssh can leave a stale TERM behind.
  assert.equal(collectDoctorReport(deps({ env: { TERM_PROGRAM: "ghostty", TERM: "xterm-kitty" } })).terminal, "ghostty");
});

test("gives kitty and Alacritty their own font setting locations", () => {
  const kitty = formatDoctorReport(collectDoctorReport(deps({ env: { TERM: "xterm-kitty" } })));
  assert.match(kitty, /kitty\.conf/);
  const alacritty = formatDoctorReport(collectDoctorReport(deps({ env: { ALACRITTY_SOCKET: "/tmp/a.sock" } })));
  assert.match(alacritty, /alacritty\.toml/);
});

test("marks the font scan as remote-host data during an SSH session", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({
    env: { SSH_CONNECTION: "10.0.0.2 51000 10.0.0.9 22" },
    platform: "darwin",
    listDir: () => []
  })));
  // Scanning this host says nothing about the machine drawing the glyphs; the report must not
  // present it as though it did.
  assert.match(text, /this host/i);
});

test("keeps a single font match from running away with the line", () => {
  const long = "VeryLongVendorName-With-Extended-Metadata-" + "x".repeat(200) + "-Nerd-Font-Regular.ttf";
  const report = collectDoctorReport(deps({ platform: "darwin", listDir: () => [long] }));
  assert.equal(report.nerdFont, "found");
  for (const line of formatDoctorReport(report).split("\n")) {
    assert.ok(line.length <= 100, `line too long (${line.length}): ${line.slice(0, 60)}...`);
  }
});

test("serializes the report as JSON for agents", () => {
  const report = collectDoctorReport(deps({ env: { TERM_PROGRAM: "ghostty" } }));
  const parsed = JSON.parse(JSON.stringify(report));
  assert.equal(parsed.terminal, "ghostty");
  assert.equal(parsed.showIcons, true);
  assert.equal(parsed.nodeOk, true);
});
