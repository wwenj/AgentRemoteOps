import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export function createId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function createToken(): string {
  return `arops_${randomBytes(32).toString("base64url")}`;
}

export function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

export function safeTokenEqual(candidate: string, digest: Buffer): boolean {
  const candidateDigest = tokenDigest(candidate);
  return candidateDigest.length === digest.length && timingSafeEqual(candidateDigest, digest);
}

export function sha256(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

export function parseDuration(value: string): number {
  const match = /^(\d+)(s|m|h)$/.exec(value.trim());
  if (!match) throw new Error("有效期格式应为 30m、1h 等形式");
  const amount = Number(match[1]);
  const unit = match[2];
  const multiplier = unit === "s" ? 1_000 : unit === "m" ? 60_000 : 3_600_000;
  const result = amount * multiplier;
  if (result < 5 * 60_000 || result > 8 * 3_600_000) {
    throw new Error("有效期必须在 5 分钟至 8 小时之间");
  }
  return result;
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  return `${ms / 60_000}m`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/((?:token|password|passwd|secret|api[_-]?key)\s*[:=]\s*)[^\s]+/gi, "$1[REDACTED]")
    .replace(/arops_[A-Za-z0-9_-]+/g, "arops_[REDACTED]")
    .slice(0, 500);
}
