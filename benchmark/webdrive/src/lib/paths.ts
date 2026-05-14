import os from "node:os";
import path from "node:path";

export function configPath(): string {
  return path.join(os.homedir(), ".webdrive", "config.json");
}

export function packageRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

export function challengesRoot(): string {
  return path.join(packageRoot(), "challenges");
}

export function manifestPath(): string {
  return path.join(packageRoot(), "manifest.json");
}
