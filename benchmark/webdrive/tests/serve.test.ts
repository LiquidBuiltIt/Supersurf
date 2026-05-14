import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { createServer } from "../src/commands/serve";

const tmpRoot = path.join(os.tmpdir(), `webdrive-serve-${Date.now()}`);
let server: http.Server;
let port: number;

beforeAll(async () => {
  fs.mkdirSync(path.join(tmpRoot, "sub"), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, "index.html"), "<h1>hello</h1>");
  fs.writeFileSync(path.join(tmpRoot, "sub", "page.html"), "<p>sub</p>");
  fs.writeFileSync(path.join(tmpRoot, "app.js"), "console.log(1);");

  server = createServer(tmpRoot);
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const addr = server.address();
  if (typeof addr === "object" && addr) port = addr.port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

async function get(p: string): Promise<{ status: number; body: string; type: string }> {
  return new Promise((resolve, reject) => {
    http.get(`http://127.0.0.1:${port}${p}`, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () =>
        resolve({
          status: res.statusCode || 0,
          body,
          type: res.headers["content-type"]?.toString() || "",
        })
      );
    }).on("error", reject);
  });
}

describe("serve", () => {
  it("serves root index.html", async () => {
    const r = await get("/");
    expect(r.status).toBe(200);
    expect(r.body).toBe("<h1>hello</h1>");
    expect(r.type).toMatch(/text\/html/);
  });

  it("serves nested HTML files", async () => {
    const r = await get("/sub/page.html");
    expect(r.status).toBe(200);
    expect(r.body).toBe("<p>sub</p>");
  });

  it("serves .js with correct mime", async () => {
    const r = await get("/app.js");
    expect(r.status).toBe(200);
    expect(r.type).toMatch(/javascript/);
  });

  it("returns 404 for missing files", async () => {
    const r = await get("/nope.html");
    expect(r.status).toBe(404);
  });

  it("rejects path traversal attempts", async () => {
    const r = await get("/../../../etc/passwd");
    expect(r.status).toBe(404);
  });
});
