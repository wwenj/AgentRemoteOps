import type { Locale } from "./types.js";

export const DEFAULT_LOCALE: Locale = "zh-CN";

export function localize(locale: Locale, zhCN: string, english: string): string {
  return locale === "en" ? english : zhCN;
}
