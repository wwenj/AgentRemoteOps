import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, SERVER_VERSION } from "../src/version.js";

describe("release version", () => {
  it("keeps package and server versions aligned", async () => {
    const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version: string };
    expect(SERVER_VERSION).toBe(packageJson.version);
    expect(PROTOCOL_VERSION).toBe(2);
  });
});
