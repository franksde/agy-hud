import { build } from "esbuild";

build({
  entryPoints: ["src/main.ts"],
  bundle: true,
  platform: "node",
  target: "node18",
  format: "cjs",
  outfile: "dist/agy-hud.js",
  banner: { js: "#!/usr/bin/env node" }
}).catch(() => process.exit(1));
