import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { challengesRoot } from "../lib/paths";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
};

export function createServer(rootDir: string): http.Server {
  const root = path.resolve(rootDir);
  return http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);
    const requested = urlPath === "/" ? "/index.html" : urlPath;
    const resolved = path.resolve(root, "." + requested);

    if (!resolved.startsWith(root + path.sep) && resolved !== root) {
      res.statusCode = 404;
      res.end("Not Found");
      return;
    }

    fs.stat(resolved, (err, stat) => {
      if (err || !stat.isFile()) {
        res.statusCode = 404;
        res.end("Not Found");
        return;
      }
      const mime = MIME[path.extname(resolved).toLowerCase()] || "application/octet-stream";
      res.setHeader("Content-Type", mime);
      fs.createReadStream(resolved).pipe(res);
    });
  });
}

export async function runServe(port: number): Promise<void> {
  const server = createServer(challengesRoot());
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`WebDrive serving challenges at http://localhost:${port}`);
  console.log("Press Ctrl+C to stop.");
}
