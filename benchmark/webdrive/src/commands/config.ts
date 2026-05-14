import fs from "node:fs";
import path from "node:path";
import { configPath } from "../lib/paths";

function readConfig(): Record<string, string> {
  const p = configPath();
  if (!fs.existsSync(p)) return {};
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function writeConfig(data: Record<string, string>): void {
  const p = configPath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(data, null, 2));
}

export async function runConfig(action: string, key?: string, value?: string): Promise<void> {
  const config = readConfig();

  switch (action) {
    case "get": {
      if (!key) throw new Error("config get requires a key");
      if (key in config) console.log(config[key]);
      return;
    }
    case "set": {
      if (!key) throw new Error("config set requires a key");
      if (value === undefined) throw new Error("config set requires a value");
      config[key] = value;
      writeConfig(config);
      return;
    }
    case "list": {
      for (const [k, v] of Object.entries(config)) {
        console.log(`${k} = ${v}`);
      }
      return;
    }
    default:
      throw new Error(`Unknown config action: ${action}`);
  }
}
