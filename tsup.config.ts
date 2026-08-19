import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  target: "node22",
  bundle: true,
  clean: true,
  sourcemap: true,
  banner: { js: "#!/usr/bin/env node" },
});
