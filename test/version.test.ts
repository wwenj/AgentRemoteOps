import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SERVER_VERSION } from "../src/version.js";

describe("release version", () => {
  it("keeps package and server versions aligned", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
      optionalDependencies: Record<string, string>;
    };
    const x64 = JSON.parse(await readFile(new URL("../packages/cloudflared-linux-x64/package.json", import.meta.url), "utf8")) as { name: string; version: string; os: string[]; cpu: string[] };
    const arm64 = JSON.parse(await readFile(new URL("../packages/cloudflared-linux-arm64/package.json", import.meta.url), "utf8")) as { name: string; version: string; os: string[]; cpu: string[] };
    expect(SERVER_VERSION).toBe(packageJson.version);
    expect(packageJson.version).toBe("0.4.0");
    expect(x64).toMatchObject({ version: packageJson.version, os: ["linux"], cpu: ["x64"] });
    expect(arm64).toMatchObject({ version: packageJson.version, os: ["linux"], cpu: ["arm64"] });
    expect(packageJson.optionalDependencies[x64.name]).toBe(packageJson.version);
    expect(packageJson.optionalDependencies[arm64.name]).toBe(packageJson.version);
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
