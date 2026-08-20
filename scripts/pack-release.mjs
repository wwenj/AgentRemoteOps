import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const artifacts = path.join(root, "artifacts");
await rm(artifacts, { recursive: true, force: true });
await mkdir(artifacts, { recursive: true });

run("pnpm", ["build"], root);
run("node", ["scripts/prepare-cloudflared.mjs"], root);
for (const directory of [
  "packages/cloudflared-linux-x64",
  "packages/cloudflared-linux-arm64",
  ".",
]) {
  run("pnpm", ["pack", "--pack-destination", artifacts], path.join(root, directory));
}

process.stdout.write(`Release tarballs written to ${artifacts}\n`);

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
