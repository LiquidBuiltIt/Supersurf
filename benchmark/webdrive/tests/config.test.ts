import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = path.join(os.tmpdir(), `webdrive-test-${Date.now()}`);

beforeEach(() => {
  fs.mkdirSync(tmpHome, { recursive: true });
  vi.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("config command", () => {
  it("set writes key/value to ~/.webdrive/config.json", async () => {
    const { runConfig } = await import("../src/commands/config");
    await runConfig("set", "cf_turnstile_sitekey", "cf-abc123");

    const configFile = path.join(tmpHome, ".webdrive", "config.json");
    const data = JSON.parse(fs.readFileSync(configFile, "utf8"));
    expect(data.cf_turnstile_sitekey).toBe("cf-abc123");
  });

  it("get returns the value for an existing key", async () => {
    const { runConfig } = await import("../src/commands/config");
    await runConfig("set", "foo", "bar");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runConfig("get", "foo");
    expect(spy).toHaveBeenCalledWith("bar");
  });

  it("list prints all key/value pairs", async () => {
    const { runConfig } = await import("../src/commands/config");
    await runConfig("set", "a", "1");
    await runConfig("set", "b", "2");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runConfig("list");
    const output = spy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("a = 1");
    expect(output).toContain("b = 2");
  });

  it("get on missing key prints nothing and does not throw", async () => {
    const { runConfig } = await import("../src/commands/config");
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    await runConfig("get", "missing");
    expect(spy).not.toHaveBeenCalled();
  });

  it("set without value throws", async () => {
    const { runConfig } = await import("../src/commands/config");
    await expect(runConfig("set", "key")).rejects.toThrow();
  });

  it("unknown action throws", async () => {
    const { runConfig } = await import("../src/commands/config");
    await expect(runConfig("bogus")).rejects.toThrow();
  });
});
