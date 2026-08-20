import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { access, constants } from "node:fs/promises";

export async function digestFile(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}

export async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export async function matchesDigest(file: string, expected: string): Promise<boolean> {
  try {
    return await digestFile(file) === expected;
  } catch {
    return false;
  }
}
