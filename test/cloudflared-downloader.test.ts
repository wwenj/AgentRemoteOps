import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadCloudflared } from "../src/cloudflared/downloader.js";
import type { CloudflaredSpec } from "../src/cloudflared/manifest.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("cloudflared downloader", () => {
  it("downloads, reports progress, verifies, and makes the binary executable", async () => {
    const root = await makeRoot();
    const content = Buffer.from("complete-cloudflared-binary");
    const progress: number[] = [];
    const target = await downloadCloudflared({
      spec: specFor(content),
      cacheRoot: root,
      signal: new AbortController().signal,
      locale: "zh-CN",
      fetchImpl: responseFetch(content),
      onProgress: (event) => { if (event.currentBytes !== undefined) progress.push(event.currentBytes); },
    });
    expect(await readFile(target)).toEqual(content);
    expect((await stat(target)).mode & 0o111).not.toBe(0);
    expect(progress.at(-1)).toBe(content.length);
  });

  it("resumes an interrupted partial download with a Range request", async () => {
    const root = await makeRoot();
    const content = Buffer.from("0123456789");
    const spec = specFor(content);
    const partial = path.join(root, "agent-remoteops", "cloudflared", spec.version, `${spec.asset}.download`);
    await mkdir(path.dirname(partial), { recursive: true });
    await writeFile(partial, content.subarray(0, 4));
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      expect(new Headers(init?.headers).get("range")).toBe("bytes=4-");
      return new Response(content.subarray(4), {
        status: 206,
        headers: { "content-length": "6", "content-range": "bytes 4-9/10" },
      });
    }) as unknown as typeof fetch;
    const target = await downloadCloudflared({ spec, cacheRoot: root, signal: new AbortController().signal, locale: "en", fetchImpl });
    expect(await readFile(target)).toEqual(content);
  });

  it("retries transient failures within the bounded attempt count", async () => {
    const root = await makeRoot();
    const content = Buffer.from("retry-success");
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(new Response(content, { status: 200, headers: { "content-length": String(content.length) } })) as typeof fetch;
    const target = await downloadCloudflared({
      spec: specFor(content),
      cacheRoot: root,
      signal: new AbortController().signal,
      locale: "en",
      fetchImpl,
      totalTimeoutMs: 2_000,
    });
    expect(await readFile(target)).toEqual(content);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("fails a stalled body instead of waiting indefinitely", async () => {
    const root = await makeRoot();
    const body = new ReadableStream<Uint8Array>({ start() { /* deliberately stalled */ } });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 })) as typeof fetch;
    await expect(downloadCloudflared({
      spec: specFor(Buffer.from("never-arrives")),
      cacheRoot: root,
      signal: new AbortController().signal,
      locale: "en",
      fetchImpl,
      stallTimeoutMs: 20,
      totalTimeoutMs: 200,
      maxAttempts: 1,
    })).rejects.toThrow(/stalled|aborted/i);
  });

  it("honors cancellation and releases its download lock", async () => {
    const root = await makeRoot();
    const controller = new AbortController();
    const body = new ReadableStream<Uint8Array>({ start() { /* wait for cancellation */ } });
    const fetchImpl = vi.fn().mockResolvedValue(new Response(body, { status: 200 })) as typeof fetch;
    setTimeout(() => controller.abort(new Error("cancelled by test")), 20);
    const spec = specFor(Buffer.from("cancelled"));
    await expect(downloadCloudflared({
      spec,
      cacheRoot: root,
      signal: controller.signal,
      locale: "en",
      fetchImpl,
      stallTimeoutMs: 1_000,
      totalTimeoutMs: 2_000,
    })).rejects.toThrow("cancelled by test");
    const lock = path.join(root, "agent-remoteops", "cloudflared", spec.version, `${spec.asset}.lock`);
    await expect(stat(lock)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bad digest and removes the untrusted partial file", async () => {
    const root = await makeRoot();
    const expected = Buffer.from("expected");
    const spec = specFor(expected);
    await expect(downloadCloudflared({
      spec,
      cacheRoot: root,
      signal: new AbortController().signal,
      locale: "en",
      fetchImpl: responseFetch(Buffer.from("tampered")),
      maxAttempts: 1,
    })).rejects.toThrow("SHA-256");
    const partial = path.join(root, "agent-remoteops", "cloudflared", spec.version, `${spec.asset}.download`);
    await expect(stat(partial)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("coordinates concurrent callers with one network download", async () => {
    const root = await makeRoot();
    const content = Buffer.from("shared-download");
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return new Response(content, { status: 200, headers: { "content-length": String(content.length) } });
    }) as unknown as typeof fetch;
    const options = {
      spec: specFor(content),
      cacheRoot: root,
      signal: new AbortController().signal,
      locale: "en" as const,
      fetchImpl,
      totalTimeoutMs: 2_000,
    };
    const [first, second] = await Promise.all([downloadCloudflared(options), downloadCloudflared(options)]);
    expect(first).toBe(second);
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("recovers immediately from a lock left by a dead process", async () => {
    const root = await makeRoot();
    const content = Buffer.from("recovered-download");
    const spec = specFor(content);
    const directory = path.join(root, "agent-remoteops", "cloudflared", spec.version);
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, `${spec.asset}.lock`), "99999999 0\n");
    const target = await downloadCloudflared({
      spec,
      cacheRoot: root,
      signal: new AbortController().signal,
      locale: "en",
      fetchImpl: responseFetch(content),
      totalTimeoutMs: 500,
    });
    expect(await readFile(target)).toEqual(content);
  });
});

function specFor(content: Buffer): CloudflaredSpec {
  return {
    version: "test-version",
    releaseBaseUrl: "https://example.test/releases",
    platform: "linux",
    arch: "x64",
    asset: "cloudflared-linux-amd64",
    packageName: "agent-remoteops-cloudflared-linux-x64",
    sha256: createHash("sha256").update(content).digest("hex"),
  };
}

function responseFetch(content: Buffer): typeof fetch {
  return vi.fn().mockResolvedValue(new Response(content, {
    status: 200,
    headers: { "content-length": String(content.length) },
  })) as typeof fetch;
}

async function makeRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "agent-remoteops-downloader-"));
  roots.push(root);
  return root;
}
