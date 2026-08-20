import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { access, chmod, copyFile, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(await readFile(path.join(root, "cloudflared-manifest.json"), "utf8"));
const requested = process.argv[2] ? [process.argv[2]] : ["x64", "arm64"];

for (const arch of requested) {
  const key = `linux-${arch}`;
  const spec = manifest.platforms[key];
  if (!spec) throw new Error(`Unsupported cloudflared package architecture: ${arch}`);

  const packageDirectory = path.join(root, "packages", `cloudflared-linux-${arch}`);
  const binaryDirectory = path.join(packageDirectory, "bin");
  const target = path.join(binaryDirectory, "cloudflared");
  const temporary = `${target}.download`;
  await mkdir(binaryDirectory, { recursive: true, mode: 0o755 });

  if (await matchesDigest(target, spec.sha256)) {
    await chmod(target, 0o755);
    await copyFile(path.join(root, "third_party", "cloudflared", "LICENSE"), path.join(packageDirectory, "LICENSE"));
    process.stderr.write(`cloudflared ${manifest.version} ${arch}: cached and verified\n`);
    continue;
  }

  await rm(target, { force: true });
  await rm(temporary, { force: true });
  const url = `${manifest.releaseBaseUrl}/${spec.asset}`;
  process.stderr.write(`cloudflared ${manifest.version} ${arch}: downloading ${url}\n`);
  const signal = AbortSignal.timeout(180_000);
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`);
  const total = Number(response.headers.get("content-length")) || undefined;
  let received = 0;
  let lastPercent = -1;
  const progress = new Transform({
    transform(chunk, _encoding, callback) {
      received += chunk.length;
      const percent = total ? Math.floor(received / total * 100) : undefined;
      if (percent === undefined || percent >= lastPercent + 10 || percent === 100) {
        lastPercent = percent ?? lastPercent;
        process.stderr.write(`cloudflared ${arch}: ${formatBytes(received)}${total ? ` / ${formatBytes(total)} (${percent}%)` : ""}\n`);
      }
      callback(null, chunk);
    },
  });
  try {
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(temporary, { mode: 0o600 }), { signal });
    if (!await matchesDigest(temporary, spec.sha256)) throw new Error(`SHA-256 mismatch for ${spec.asset}`);
    await chmod(temporary, 0o755);
    await rename(temporary, target);
    await copyFile(path.join(root, "third_party", "cloudflared", "LICENSE"), path.join(packageDirectory, "LICENSE"));
    process.stderr.write(`cloudflared ${manifest.version} ${arch}: ready\n`);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function matchesDigest(file, expected) {
  try {
    await access(file);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    return hash.digest("hex") === expected;
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}
