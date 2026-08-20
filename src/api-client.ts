import { randomUUID } from "node:crypto";
import { DEFAULT_LOCALE, localize } from "./i18n.js";
import type { ClientSession } from "./session-store.js";

export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly details?: unknown) {
    super(message);
  }
}

export class ApiClient {
  constructor(private readonly session: Pick<ClientSession, "url" | "token" | "clientId"> & { locale?: ClientSession["locale"] }) {}

  get<T>(pathname: string): Promise<T> {
    return this.request<T>(pathname, { method: "GET" });
  }

  post<T>(pathname: string, body?: unknown, mutating = false): Promise<T> {
    const init: RequestInit = {
      method: "POST",
      ...(mutating ? { headers: { "Idempotency-Key": randomUUID() } } : {}),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    };
    return this.request<T>(pathname, init);
  }

  private async request<T>(pathname: string, init: RequestInit): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${this.session.token}`);
    headers.set("X-Agent-RemoteOps-Client-Id", this.session.clientId);
    if (init.body) headers.set("Content-Type", "application/json");
    const response = await fetch(`${this.session.url.replace(/\/$/, "")}${pathname}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const text = await response.text();
    let result: { error?: { code?: string; message?: string; details?: unknown } };
    try {
      result = JSON.parse(text) as typeof result;
    } catch {
      const locale = this.session.locale ?? DEFAULT_LOCALE;
      if (!response.ok) throw new ApiError(response.status, "HTTP_ERROR", localize(locale, `远程服务不可用：HTTP ${response.status}`, `Remote service unavailable: HTTP ${response.status}`));
      throw new ApiError(response.status, "INVALID_RESPONSE", localize(locale, "远程服务返回了非 JSON 响应", "Remote service returned a non-JSON response"));
    }
    if (!response.ok) throw new ApiError(response.status, result.error?.code ?? "HTTP_ERROR", result.error?.message ?? `HTTP ${response.status}`, result.error?.details);
    return result as T;
  }
}
