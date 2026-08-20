import manifestData from "../../cloudflared-manifest.json" with { type: "json" };

export interface CloudflaredSpec {
  version: string;
  releaseBaseUrl: string;
  platform: "linux";
  arch: "x64" | "arm64";
  asset: string;
  packageName: string;
  sha256: string;
}

interface ManifestPlatform {
  asset: string;
  packageName: string;
  sha256: string;
}

const platforms = manifestData.platforms as Record<string, ManifestPlatform>;

export const CLOUDFLARED_VERSION = manifestData.version;

export function getCloudflaredSpec(platform = process.platform, arch = process.arch): CloudflaredSpec | undefined {
  if (platform !== "linux" || (arch !== "x64" && arch !== "arm64")) return undefined;
  const entry = platforms[`${platform}-${arch}`];
  if (!entry) return undefined;
  return {
    version: manifestData.version,
    releaseBaseUrl: manifestData.releaseBaseUrl,
    platform,
    arch,
    asset: entry.asset,
    packageName: entry.packageName,
    sha256: entry.sha256,
  };
}
