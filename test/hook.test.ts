import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.join(__dirname, "..", "..");
const hook = path.join(root, "hooks", "status-line.sh");
const bundle = path.join(root, "dist", "agy-hud.js");

// Directories the hook checks last, outside any home directory. A test cannot fake them, so every
// case below puts its node in front of them, and AGY_HUD_NO_SYSTEM_NODE takes them out of the
// search for the case that needs nothing to be found.
const systemNodeDirs = ["/opt/homebrew/bin", "/usr/local/bin", "/home/linuxbrew/.linuxbrew/bin", "/usr/bin", "/snap/bin"];

function isRunnableFile(file: string): boolean {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// The hook declares `sh`, which is dash on Debian and Ubuntu and bash in POSIX mode on macOS.
// Running under dash as well catches a bashism on a machine whose `sh` would let it through.
// Absolute paths, because the hook runs with a PATH that holds neither.
const shells = ["sh", "dash"]
  .map((shell) => ["/bin", "/usr/bin"].map((dir) => path.join(dir, shell)).find((candidate) => fs.existsSync(candidate)))
  .filter((shell): shell is string => shell !== undefined);

interface Sandbox {
  home: string;
  bin: string;
}

function sandbox(): Sandbox {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "agy-hud-hook-"));
  const home = path.join(dir, "home");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(home);
  // The hook's PATH is this empty directory: no real node can be found through it, and the hook
  // has to get by on shell builtins.
  fs.mkdirSync(bin);
  return { home, bin };
}

// A stand-in for node that reports which copy ran, the arguments it got and the PATH it saw.
function fakeNode(binDir: string, label: string): void {
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "node"), `#!/bin/sh\necho "${label}|$*|$PATH"\n`, { mode: 0o755 });
}

function write(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function runHook(shell: string, box: Sandbox, env: Record<string, string> = {}) {
  return spawnSync(shell, [hook], { encoding: "utf8", input: "", env: { HOME: box.home, PATH: box.bin, ...env } });
}

function assertRan(shell: string, box: Sandbox, label: string, env: Record<string, string> = {}): string {
  const result = runHook(shell, box, env);
  assert.equal(result.stderr, "");
  assert.equal(result.status, 0);
  const [ran, args, seenPath] = result.stdout.trimEnd().split("|");
  assert.equal(ran, label);
  assert.equal(args, `${bundle} statusline`);
  return seenPath;
}

interface Case {
  name: string;
  expect: string;
  env?: (box: Sandbox) => Record<string, string>;
  setup: (box: Sandbox) => void;
}

const cases: Case[] = [
  {
    name: "uses the node already on PATH without consulting a version manager",
    expect: "path",
    setup: ({ home, bin }) => {
      fakeNode(bin, "path");
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "nvm");
    }
  },
  {
    name: "nvm: default alias holding a full version",
    expect: "v20.18.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v20.18.0/bin"), "v20.18.0");
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "v22.11.0");
      write(path.join(home, ".nvm/alias/default"), "v20.18.0\n");
    }
  },
  {
    name: "nvm: default alias holding a major picks the highest matching install numerically",
    expect: "v22.11.0",
    setup: ({ home }) => {
      for (const version of ["v22.3.0", "v22.11.0", "v24.1.0", "v2.0.0"]) {
        fakeNode(path.join(home, ".nvm/versions/node", version, "bin"), version);
      }
      write(path.join(home, ".nvm/alias/default"), "22\n");
    }
  },
  {
    name: "nvm: default alias without a trailing newline",
    expect: "v20.18.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v20.18.0/bin"), "v20.18.0");
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "v22.11.0");
      write(path.join(home, ".nvm/alias/default"), "20");
    }
  },
  {
    name: "nvm: default alias follows lts aliases to a version",
    expect: "v22.11.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "v22.11.0");
      fakeNode(path.join(home, ".nvm/versions/node/v25.0.0/bin"), "v25.0.0");
      write(path.join(home, ".nvm/alias/default"), "lts/*\n");
      write(path.join(home, ".nvm/alias/lts/*"), "lts/jod\n");
      write(path.join(home, ".nvm/alias/lts/jod"), "v22.11.0\n");
    }
  },
  {
    name: "nvm: an alias that names no installed version falls back to the highest install",
    expect: "v20.10.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v20.9.0/bin"), "v20.9.0");
      fakeNode(path.join(home, ".nvm/versions/node/v20.10.0/bin"), "v20.10.0");
      write(path.join(home, ".nvm/alias/default"), "node\n");
    }
  },
  {
    name: "nvm: an alias loop ends instead of hanging",
    expect: "v22.11.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "v22.11.0");
      write(path.join(home, ".nvm/alias/default"), "a\n");
      write(path.join(home, ".nvm/alias/a"), "default\n");
    }
  },
  {
    name: "nvm: skips install names that are not three-part versions or overflow shell arithmetic",
    expect: "v22.11.0",
    setup: ({ home }) => {
      for (const version of ["v22.11.0", "v22.11.0.9", "v23.0.0.1", "v99999999999999999999.0.0"]) {
        fakeNode(path.join(home, ".nvm/versions/node", version, "bin"), version);
      }
    }
  },
  {
    name: "nvm: a default alias older than Node 18 gives way to an install that can run the bundle",
    expect: "v22.11.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v16.20.2/bin"), "v16.20.2");
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "v22.11.0");
      write(path.join(home, ".nvm/alias/default"), "16\n");
    }
  },
  {
    name: "a manager holding only installs older than Node 18 gives way to the next one",
    expect: "asdf",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v14.21.3/bin"), "nvm");
      fakeNode(path.join(home, ".asdf/installs/nodejs/20.18.0/bin"), "asdf");
    }
  },
  {
    name: "nvm: no alias file picks the highest install",
    expect: "v20.10.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v20.9.0/bin"), "v20.9.0");
      fakeNode(path.join(home, ".nvm/versions/node/v20.10.0/bin"), "v20.10.0");
    }
  },
  {
    name: "nvm: NVM_DIR overrides ~/.nvm",
    expect: "custom",
    env: ({ home }) => ({ NVM_DIR: path.join(home, "tools/nvm dir") }),
    setup: ({ home }) => {
      fakeNode(path.join(home, "tools/nvm dir/versions/node/v22.11.0/bin"), "custom");
      fakeNode(path.join(home, ".nvm/versions/node/v24.0.0/bin"), "home");
    }
  },
  {
    name: "fnm: default alias under the macOS data directory",
    expect: "fnm-default",
    setup: ({ home }) => {
      const fnm = path.join(home, "Library/Application Support/fnm");
      fakeNode(path.join(fnm, "node-versions/v20.18.0/installation/bin"), "fnm-default");
      fakeNode(path.join(fnm, "node-versions/v22.11.0/installation/bin"), "fnm-newest");
      fs.mkdirSync(path.join(fnm, "aliases"), { recursive: true });
      fs.symlinkSync(path.join(fnm, "node-versions/v20.18.0/installation"), path.join(fnm, "aliases/default"));
    }
  },
  {
    name: "fnm: no default alias picks the highest install under XDG_DATA_HOME",
    expect: "v22.11.0",
    env: ({ home }) => ({ XDG_DATA_HOME: path.join(home, "data") }),
    setup: ({ home }) => {
      fakeNode(path.join(home, "data/fnm/node-versions/v22.11.0/installation/bin"), "v22.11.0");
      fakeNode(path.join(home, "data/fnm/node-versions/v18.20.4/installation/bin"), "v18.20.4");
    }
  },
  {
    name: "fnm: FNM_DIR overrides the default locations",
    expect: "custom",
    env: ({ home }) => ({ FNM_DIR: path.join(home, "fnm-here") }),
    setup: ({ home }) => {
      fakeNode(path.join(home, "fnm-here/node-versions/v22.11.0/installation/bin"), "custom");
      fakeNode(path.join(home, ".local/share/fnm/node-versions/v24.0.0/installation/bin"), "home");
    }
  },
  {
    name: "nvm: default alias with surrounding blanks and a CRLF line ending",
    expect: "v20.18.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v20.18.0/bin"), "v20.18.0");
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "v22.11.0");
      write(path.join(home, ".nvm/alias/default"), " 20 \t\r\n");
    }
  },
  {
    name: "volta: highest installed image rather than the shim, which may have no default to run",
    expect: "22.11.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".volta/bin"), "volta-shim");
      fakeNode(path.join(home, ".volta/tools/image/node/22.11.0/bin"), "22.11.0");
      fakeNode(path.join(home, ".volta/tools/image/node/18.20.4/bin"), "18.20.4");
    }
  },
  {
    name: "volta: a shim with no node installed behind it does not hide a usable nvm install",
    expect: "nvm",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".volta/bin"), "volta");
      fakeNode(path.join(home, ".nvm/versions/node/v22.11.0/bin"), "nvm");
    }
  },
  {
    name: "mise: an install rather than the shim, which may have no version configured",
    expect: "mise-install",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".local/share/mise/shims"), "mise-shim");
      fakeNode(path.join(home, ".local/share/mise/installs/node/22.11.0/bin"), "mise-install");
    }
  },
  {
    name: "mise: highest install, ignoring the non-version entries mise keeps beside them",
    expect: "22.11.0",
    setup: ({ home }) => {
      const installs = path.join(home, ".local/share/mise/installs/node");
      fakeNode(path.join(installs, "22.11.0/bin"), "22.11.0");
      fakeNode(path.join(installs, "20.18.0/bin"), "20.18.0");
      fs.symlinkSync(path.join(installs, "20.18.0"), path.join(installs, "lts"));
    }
  },
  {
    name: "asdf: highest nodejs install",
    expect: "22.11.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".asdf/installs/nodejs/22.11.0/bin"), "22.11.0");
      fakeNode(path.join(home, ".asdf/installs/nodejs/18.20.4/bin"), "18.20.4");
    }
  },
  {
    name: "nodenv: global version file",
    expect: "20.18.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nodenv/versions/20.18.0/bin"), "20.18.0");
      fakeNode(path.join(home, ".nodenv/versions/22.11.0/bin"), "22.11.0");
      write(path.join(home, ".nodenv/version"), "20.18.0\n");
    }
  },
  {
    name: "nodenv: global version file written with a leading v",
    expect: "20.18.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nodenv/versions/20.18.0/bin"), "20.18.0");
      fakeNode(path.join(home, ".nodenv/versions/22.11.0/bin"), "22.11.0");
      write(path.join(home, ".nodenv/version"), "v20.18.0\n");
    }
  },
  {
    name: "n: N_PREFIX",
    expect: "n-prefix",
    env: ({ home }) => ({ N_PREFIX: path.join(home, "tools/n") }),
    setup: ({ home }) => fakeNode(path.join(home, "tools/n/bin"), "n-prefix")
  },
  {
    name: "n: ~/n, where n-install puts it",
    expect: "n-home",
    setup: ({ home }) => fakeNode(path.join(home, "n/bin"), "n-home")
  },
  {
    name: "n: ~/.n",
    expect: "n-dot",
    setup: ({ home }) => fakeNode(path.join(home, ".n/bin"), "n-dot")
  },
  {
    name: "homebrew: HOMEBREW_PREFIX/bin",
    expect: "brew",
    env: ({ home }) => ({ HOMEBREW_PREFIX: path.join(home, "brew") }),
    setup: ({ home }) => fakeNode(path.join(home, "brew/bin"), "brew")
  },
  {
    name: "homebrew: highest keg-only node@N formula",
    expect: "node@22",
    env: ({ home }) => ({ HOMEBREW_PREFIX: path.join(home, "brew") }),
    setup: ({ home }) => {
      fakeNode(path.join(home, "brew/opt/node@22/bin"), "node@22");
      fakeNode(path.join(home, "brew/opt/node@18/bin"), "node@18");
      fakeNode(path.join(home, "brew/opt/nodenv/bin"), "nodenv");
    }
  },
  {
    name: "skips an install directory whose node is not executable",
    expect: "v20.18.0",
    setup: ({ home }) => {
      fakeNode(path.join(home, ".nvm/versions/node/v20.18.0/bin"), "v20.18.0");
      write(path.join(home, ".nvm/versions/node/v22.11.0/bin/node"), "half-finished download\n");
    }
  }
];

for (const shell of shells) {
  for (const item of cases) {
    test(`status-line.sh (${path.basename(shell)}) ${item.name}`, { skip: process.platform === "win32" }, () => {
      const box = sandbox();
      item.setup(box);
      assertRan(shell, box, item.expect, item.env?.(box));
    });
  }

  test(`status-line.sh (${path.basename(shell)}) keeps the caller's PATH ahead of the node it found`, { skip: process.platform === "win32" }, () => {
    const box = sandbox();
    const nodeDir = path.join(box.home, ".nvm/versions/node/v22.11.0/bin");
    fakeNode(nodeDir, "nvm");
    assert.equal(assertRan(shell, box, "nvm"), `${box.bin}:${nodeDir}`);
  });

  test(`status-line.sh (${path.basename(shell)}) does not take a Volta or mise shim that has no install behind it`, { skip: process.platform === "win32" }, () => {
    const box = sandbox();
    fakeNode(path.join(box.home, ".volta/bin"), "volta-shim");
    fakeNode(path.join(box.home, ".local/share/mise/shims"), "mise-shim");
    const result = runHook(shell, box, { AGY_HUD_NO_SYSTEM_NODE: "1" });
    assert.equal(result.status, 127);
    assert.equal(result.stdout, "");
  });

  test(`status-line.sh (${path.basename(shell)}) says so and exits 127 when no node is found`, { skip: process.platform === "win32" }, () => {
    const box = sandbox();
    const result = runHook(shell, box, { AGY_HUD_NO_SYSTEM_NODE: "1" });
    assert.equal(result.status, 127);
    assert.match(result.stderr, /^agy-hud: node not found/);
    assert.equal(result.stdout, "");
  });

  // Whether this machine has a system node is not the test's to decide, so this one only runs
  // where it does. It is the one case that starts a real node.
  const systemNode = systemNodeDirs.some((dir) => isRunnableFile(path.join(dir, "node")));
  test(`status-line.sh (${path.basename(shell)}) without a version manager uses a system node`, { skip: process.platform === "win32" || !systemNode }, () => {
    const box = sandbox();
    const result = runHook(shell, box);
    assert.equal(result.status, 0);
    assert.equal(result.stdout, "agy-hud\n");
  });
}

test("status-line.sh is exercised by at least one shell", { skip: process.platform === "win32" }, () => {
  assert.ok(shells.length > 0);
});
