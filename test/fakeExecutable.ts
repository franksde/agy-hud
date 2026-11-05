import fs from "node:fs";
import path from "node:path";

// Writes an executable `/bin/sh` script named `name` into `dir`, creating the directory, and returns
// its path. Tests use these to stand in for programs found on PATH, such as agy, node, ps or lsof.
export function writeFakeExecutable(dir: string, name: string, body: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}
