import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { ApiClient } from "../src/api-client.js";

const servers: Array<ReturnType<typeof createServer>> = [];
afterEach(async () => Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))));

describe("ApiClient", () => {
  it("reports an HTTP error instead of leaking a JSON parse failure", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(502, { "content-type": "text/html" });
      response.end("<!DOCTYPE html><title>Bad gateway</title>");
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("missing address");
    const client = new ApiClient({ url: `http://127.0.0.1:${address.port}`, token: "test" });
    await expect(client.get("/v1/session")).rejects.toMatchObject({
      status: 502,
      code: "HTTP_ERROR",
      message: "远程服务不可用：HTTP 502",
    });
  });
});
