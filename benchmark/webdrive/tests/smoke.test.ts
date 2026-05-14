import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ManifestSchema } from "../src/lib/schemas";

describe("e2e smoke", () => {
  const root = path.resolve(__dirname, "..");

  it("manifest parses against ManifestSchema", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    expect(() => ManifestSchema.parse(manifest)).not.toThrow();
  });

  it("every challenge listed in manifest has an index.html", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const challenges: string[] = manifest.suites["v1-foundation"].challenges;
    for (const c of challenges) {
      const indexPath = path.join(root, "challenges", c, "index.html");
      expect(fs.existsSync(indexPath), `missing ${indexPath}`).toBe(true);
    }
  });

  it("every challenge index.html declares window.__webdrive", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
    const challenges: string[] = manifest.suites["v1-foundation"].challenges;
    for (const c of challenges) {
      const content = fs.readFileSync(path.join(root, "challenges", c, "index.html"), "utf8");
      expect(content, `${c} missing window.__webdrive`).toMatch(/window\.__webdrive\s*=/);
    }
  });
});
