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
    pluginConfigPaths: [],
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

// Antigravity CLI 1.1.28 made `agy plugin install` replace the plugin's managed directory exactly,
// so a config.json the user placed inside it is deleted by the next reinstall of the plugin.
const pluginConfig = "/home/u/.gemini/config/plugins/agy-hud/config.json";

test("flags a config in effect that lives inside the plugin directory", () => {
  const report = collectDoctorReport(deps({
    configPaths: [pluginConfig, "/home/u/.config/agy-hud/config.json"],
    pluginConfigPaths: [pluginConfig],
    readFile: p => (p === pluginConfig ? "{}" : null)
  }));
  assert.equal(report.configInPluginDir, true);
  assert.equal(report.userConfigPath, "/home/u/.config/agy-hud/config.json");
});

test("does not flag a user-level or missing config as living in the plugin directory", () => {
  const home = "/home/u/.config/agy-hud/config.json";
  const userLevel = collectDoctorReport(deps({
    configPaths: [pluginConfig, home],
    pluginConfigPaths: [pluginConfig],
    readFile: p => (p === home ? "{}" : null)
  }));
  assert.equal(userLevel.configInPluginDir, false);
  const none = collectDoctorReport(deps({ configPaths: [pluginConfig, home], pluginConfigPaths: [pluginConfig] }));
  assert.equal(none.configInPluginDir, false);
});

test("warns that a plugin-directory config is deleted by a reinstall and names where to move it", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({
    configPaths: [pluginConfig, "/home/u/.config/agy-hud/config.json"],
    pluginConfigPaths: [pluginConfig],
    readFile: p => (p === pluginConfig ? "{}" : null)
  })));
  assert.match(text, /agy plugin install/);
  assert.match(text, /1\.1\.28/);
  assert.ok(text.includes("move it to ~/.config/agy-hud/config.json"), "must name the user-level target");
});

test("prints no reinstall warning for a user-level config", () => {
  const home = "/home/u/.config/agy-hud/config.json";
  const text = formatDoctorReport(collectDoctorReport(deps({
    configPaths: [home],
    pluginConfigPaths: [pluginConfig],
    readFile: p => (p === home ? "{}" : null)
  })));
  assert.doesNotMatch(text, /agy plugin install/);
});

// Antigravity CLI 1.3.4+ lists installed plugins with `agy plugin list --json`. The status line is
// wired through settings, not through the plugin, so an install only reaches the HUD when
// statusLine.command runs the installed copy.
const installedRoot = "/home/u/.gemini/config/plugins/agy-hud";
const pluginListJson = JSON.stringify([
  { name: "other", enabled: true, version: "1.0.0", path: "/home/u/.gemini/config/plugins/other" },
  { name: "agy-hud", enabled: true, version: "0.1.12", source: "antigravity", path: installedRoot }
]);

function wiredTo(command: string): (p: string) => string | null {
  return p => (p === "/home/u/.gemini/antigravity-cli/settings.json" ? JSON.stringify({ statusLine: { command } }) : null);
}

test("reports the installed plugin from agy plugin list --json", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo(`${installedRoot}/hooks/status-line.sh`)
  }));
  assert.equal(report.installedPluginStatus, "found");
  assert.deepEqual(report.installedPlugin, { version: "0.1.12", path: installedRoot, enabled: true });
  assert.equal(report.statuslineRunsInstalled, true);
});

test("treats a command wired as node <bundle> statusline inside the installed root as the installed copy", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo(`node ${installedRoot}/dist/agy-hud.js statusline`)
  }));
  assert.equal(report.statuslineRunsInstalled, true);
});

test("expands a leading ~/ in the status-line command before comparing", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo("~/.gemini/config/plugins/agy-hud/hooks/status-line.sh")
  }));
  assert.equal(report.statuslineRunsInstalled, true);
});

test("flags a status line that runs a copy outside the installed plugin", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo("/home/u/.gemini/antigravity-cli/plugins/agy-hud/hooks/status-line.sh")
  }));
  assert.equal(report.statuslineRunsInstalled, false);
  const text = formatDoctorReport(report);
  assert.match(text, /will not reach/);
  assert.ok(text.includes("/statusline ~/.gemini/config/plugins/agy-hud/hooks/status-line.sh"), "must give the rewire command");
});

test("does not treat a sibling directory sharing the installed path as a prefix as the installed copy", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo(`${installedRoot}-old/hooks/status-line.sh`)
  }));
  assert.equal(report.statuslineRunsInstalled, false);
});

test("reports not-installed when the list holds no agy-hud entry", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => JSON.stringify([{ name: "other", enabled: true, version: "1", path: "/x" }]),
    readFile: wiredTo(`${installedRoot}/hooks/status-line.sh`)
  }));
  assert.equal(report.installedPluginStatus, "not-installed");
  assert.equal(report.installedPlugin, null);
  assert.equal(report.statuslineRunsInstalled, null);
});

test("stays unknown when the list is unavailable or not JSON, as on a CLI before 1.3.4", () => {
  for (const pluginList of [undefined, () => null, () => 'Error: unknown list option "--json"', () => "{}"]) {
    const report = collectDoctorReport(deps({ pluginList, readFile: wiredTo(`${installedRoot}/hooks/status-line.sh`) }));
    assert.equal(report.installedPluginStatus, "unknown");
    assert.equal(report.installedPlugin, null);
    assert.equal(report.statuslineRunsInstalled, null);
  }
});

test("leaves statuslineRunsInstalled unknown when no status line is configured", () => {
  const report = collectDoctorReport(deps({ pluginList: () => pluginListJson }));
  assert.equal(report.installedPluginStatus, "found");
  assert.equal(report.statuslineRunsInstalled, null);
});

test("prints the installed row with version, state and abbreviated path", () => {
  const enabled = formatDoctorReport(collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo(`${installedRoot}/hooks/status-line.sh`)
  })));
  assert.match(enabled, /installed\s+0\.1\.12, enabled — ~\/\.gemini\/config\/plugins\/agy-hud/);
  assert.doesNotMatch(enabled, /will not reach/);
  const disabled = formatDoctorReport(collectDoctorReport(deps({
    pluginList: () => pluginListJson.replace('"enabled":true,"version":"0.1.12"', '"enabled":false,"version":"0.1.12"'),
    readFile: wiredTo(`${installedRoot}/hooks/status-line.sh`)
  })));
  assert.match(disabled, /installed\s+0\.1\.12, disabled/);
  const unknown = formatDoctorReport(collectDoctorReport(deps()));
  assert.match(unknown, /installed\s+unknown/);
  assert.match(unknown, /1\.3\.4/);
  const missing = formatDoctorReport(collectDoctorReport(deps({ pluginList: () => "[]" })));
  assert.match(missing, /installed\s+not installed as an Antigravity plugin/);
});

test("does not offer to rewire a status line that another tool owns", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => pluginListJson,
    readFile: wiredTo("/home/u/bin/my-prompt.sh")
  }));
  assert.equal(report.statuslineWired, false);
  assert.equal(report.statuslineRunsInstalled, null);
  assert.doesNotMatch(formatDoctorReport(report), /will not reach/);
});

test("expands $HOME and ${HOME} in the status-line command before comparing", () => {
  for (const home of ["$HOME", "${HOME}"]) {
    const report = collectDoctorReport(deps({
      pluginList: () => pluginListJson,
      readFile: wiredTo(`${home}/.gemini/config/plugins/agy-hud/hooks/status-line.sh`)
    }));
    assert.equal(report.statuslineRunsInstalled, true, home);
  }
});

test("reports an agy-hud entry without a path as unknown, not as missing", () => {
  const report = collectDoctorReport(deps({
    pluginList: () => JSON.stringify([{ name: "agy-hud", enabled: true, version: "0.1.12" }])
  }));
  assert.equal(report.installedPluginStatus, "unknown");
  assert.equal(report.installedPlugin, null);
});

test("treats $ in the home directory literally when expanding ~/", () => {
  const home = "/home/u$1";
  const root = `${home}/.gemini/config/plugins/agy-hud`;
  const report = collectDoctorReport(deps({
    homedir: home,
    pluginList: () => JSON.stringify([{ name: "agy-hud", enabled: true, version: "0.1.12", path: root }]),
    readFile: p => (p === `${home}/.gemini/antigravity-cli/settings.json`
      ? JSON.stringify({ statusLine: { command: "~/.gemini/config/plugins/agy-hud/hooks/status-line.sh" } })
      : null)
  }));
  assert.equal(report.statuslineRunsInstalled, true);
});

test("does not blame the listing command for an entry that only lacks a path", () => {
  const text = formatDoctorReport(collectDoctorReport(deps({
    pluginList: () => JSON.stringify([{ name: "agy-hud", enabled: true, version: "0.1.12" }])
  })));
  assert.match(text, /installed\s+unknown/);
  assert.doesNotMatch(text, /could not read/);
});

// Windows. Antigravity's own paths there use backslashes and NTFS ignores case, so the comparison and
// the home abbreviation accept either separator in any case. The paths below are the shape a Windows
// install reports, not POSIX paths with the platform switched.
const winHome = "C:\\Users\\u";
const winRoot = `${winHome}\\.gemini\\config\\plugins\\agy-hud`;
const winSettings = `${winHome}\\.gemini\\antigravity-cli\\settings.json`;

function winDeps(command: string | null, overrides: Partial<DoctorDeps> = {}): DoctorDeps {
  return deps({
    platform: "win32",
    homedir: winHome,
    env: { WINDIR: "C:\\Windows", LOCALAPPDATA: `${winHome}\\AppData\\Local` },
    userConfigPath: `${winHome}\\.config\\agy-hud\\config.json`,
    pluginList: () => JSON.stringify([{ name: "agy-hud", enabled: true, version: "0.1.13", path: winRoot }]),
    readFile: p => (p === winSettings && command !== null ? JSON.stringify({ statusLine: { command } }) : null),
    ...overrides
  });
}

test("on Windows, a status line wired to the installed copy is recognised in any spelling", () => {
  for (const command of [
    `${winRoot}\\hooks\\status-line.cmd`,
    "c:/users/u/.gemini/config/plugins/agy-hud/hooks/status-line.cmd",
    "%USERPROFILE%\\.gemini\\config\\plugins\\agy-hud\\hooks\\status-line.cmd",
    "~\\.gemini\\config\\plugins\\agy-hud\\hooks\\status-line.cmd",
    `node "${winRoot}\\dist\\agy-hud.js" statusline`
  ]) {
    assert.equal(collectDoctorReport(winDeps(command)).statuslineRunsInstalled, true, command);
  }
});

test("on Windows, a sibling directory sharing the installed path as a prefix is another copy", () => {
  assert.equal(collectDoctorReport(winDeps(`${winRoot}-old\\hooks\\status-line.cmd`)).statuslineRunsInstalled, false);
});

test("on Windows, the rewire command and home paths use backslashes and ~", () => {
  const report = collectDoctorReport(winDeps(`${winHome}\\.gemini\\antigravity-cli\\plugins\\agy-hud\\hooks\\status-line.cmd`));
  assert.equal(report.statuslineRunsInstalled, false);
  const text = formatDoctorReport(report);
  assert.ok(text.includes("/statusline ~\\.gemini\\config\\plugins\\agy-hud\\hooks\\status-line.cmd"), text);
  assert.ok(text.includes("~\\.gemini\\antigravity-cli\\plugins\\agy-hud\\hooks\\status-line.cmd"), "the statusline row hides the account name");
  assert.ok(!text.includes("Users\\u"), text);
});

// A roaming profile can put home on a share. Matching it without the leading \\ left `\\~\...`,
// a path to a server named ~, in every command doctor printed.
test("on Windows, a home on a UNC share is abbreviated with its whole prefix", () => {
  const home = "\\\\server\\share\\u";
  const report = collectDoctorReport(winDeps(`${home}\\.gemini\\antigravity-cli\\plugins\\agy-hud\\hooks\\status-line.cmd`, {
    homedir: home,
    userConfigPath: `${home}\\.config\\agy-hud\\config.json`,
    readFile: p => (p === `${home}\\.gemini\\antigravity-cli\\settings.json`
      ? JSON.stringify({ statusLine: { command: `${home}\\.gemini\\antigravity-cli\\plugins\\agy-hud\\hooks\\status-line.cmd` } })
      : null),
    pluginList: () => JSON.stringify([{ name: "agy-hud", enabled: true, version: "0.1.13", path: `${home}\\.gemini\\config\\plugins\\agy-hud` }])
  }));
  const text = formatDoctorReport(report);
  assert.ok(text.includes("/statusline ~\\.gemini\\config\\plugins\\agy-hud\\hooks\\status-line.cmd"), text);
  assert.ok(text.includes('-Path "~\\.config\\agy-hud\\config.json"'), text);
  assert.ok(!text.includes("\\\\~"), text);
});

test("on Windows, a share root as home is left alone like a drive root", () => {
  const text = formatDoctorReport(collectDoctorReport(winDeps(null, {
    homedir: "\\\\server\\share",
    userConfigPath: "\\\\server\\share\\.config\\agy-hud\\config.json"
  })));
  assert.ok(text.includes('-Path "\\\\server\\share\\.config\\agy-hud\\config.json"'), text);
});

// The directory name is case-insensitive on Windows, so an AGY-HUD in the path still runs agy-hud.
test("on Windows, a status line wired through an upper-case AGY-HUD directory counts as agy-hud", () => {
  const report = collectDoctorReport(winDeps(`${winHome}\\.gemini\\config\\plugins\\AGY-HUD\\hooks\\status-line.cmd`));
  assert.equal(report.statuslineWired, true);
  assert.equal(report.statuslineRunsInstalled, true);
});

// Notepad and Windows PowerShell's Set-Content -Encoding utf8 save a UTF-8 BOM, which JSON.parse
// rejects. The CLI reads such a settings file, so doctor must too.
test("reads a settings file that starts with a UTF-8 byte order mark", () => {
  const report = collectDoctorReport(deps({
    readFile: p => (p === "/home/u/.gemini/antigravity-cli/settings.json"
      ? "\uFEFF" + JSON.stringify({ statusLine: { command: "/home/u/.gemini/config/plugins/agy-hud/hooks/status-line.sh" } })
      : null)
  }));
  assert.equal(report.statuslineWired, true);
});

test("on Windows, an unwired status line is told to run status-line.cmd", () => {
  const text = formatDoctorReport(collectDoctorReport(winDeps(null)));
  assert.ok(text.includes("/statusline <plugin-root>\\hooks\\status-line.cmd"), text);
});

test("on Windows, fonts are scanned in the system and per-user font folders", () => {
  const seen: string[] = [];
  const report = collectDoctorReport(winDeps(null, {
    listDir: p => {
      seen.push(p);
      return p === `${winHome}\\AppData\\Local\\Microsoft\\Windows\\Fonts` ? ["HackNerdFont-Regular.ttf"] : [];
    }
  }));
  assert.deepEqual(seen, ["C:\\Windows\\Fonts", `${winHome}\\AppData\\Local\\Microsoft\\Windows\\Fonts`]);
  assert.equal(report.nerdFont, "found");
});

test("recognises Windows Terminal and names its font setting", () => {
  const report = collectDoctorReport(winDeps(null, { env: { WT_SESSION: "8c2f" } }));
  assert.equal(report.terminal, "Windows Terminal");
  assert.ok(formatDoctorReport(report).includes("Windows Terminal -> Settings -> Profiles -> Defaults -> Appearance -> Font face"));
});

// cmd has no mkdir -p, and Windows PowerShell 5.1's > writes UTF-16, which the config loader cannot
// parse. Font installs are not brew there either.
test("on Windows, the icons-off fix is PowerShell that writes plain ASCII", () => {
  const text = formatDoctorReport(collectDoctorReport(winDeps(null)));
  assert.ok(text.includes('New-Item -ItemType Directory -Force -Path "~\\.config\\agy-hud"'), text);
  assert.ok(text.includes(`Set-Content -Encoding ascii -Path "~\\.config\\agy-hud\\config.json" -Value '{"show_icons": false}'`), text);
  assert.doesNotMatch(text, /mkdir -p|brew install/);
});
