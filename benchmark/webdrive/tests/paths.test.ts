import { describe, it, expect } from "vitest";
import os from "node:os";
import path from "node:path";
import { configPath, challengesRoot, manifestPath } from "../src/lib/paths";

describe("paths", () => {
  it("configPath points to ~/.webdrive/config.json", () => {
    expect(configPath()).toBe(path.join(os.homedir(), ".webdrive", "config.json"));
  });

  it("challengesRoot resolves to package challenges directory", () => {
    expect(challengesRoot()).toMatch(/challenges$/);
  });

  it("manifestPath resolves to package manifest.json", () => {
    expect(manifestPath()).toMatch(/manifest\.json$/);
  });
});
