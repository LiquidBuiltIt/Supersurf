import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const tmpDir = path.join(os.tmpdir(), `webdrive-score-${Date.now()}`);

beforeEach(() => fs.mkdirSync(tmpDir, { recursive: true }));
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function writeJsonl(filename: string, rows: unknown[]): string {
  const p = path.join(tmpDir, filename);
  fs.writeFileSync(p, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return p;
}

const basePred = {
  task_id: "challenge-course/01-nested-iframe",
  agent_name: "supersurf",
  agent_version: "1.11.0",
  model: "claude-opus-4-7",
  time_ms: 4000,
  tool_calls: 5,
  tokens_in: 10000,
  tokens_out: 300,
  cost_usd: 0.15,
  webdrive_version: "0.1.0",
  evaluated_at: "2026-05-11T12:00:00.000Z",
};

describe("score", () => {
  it("counts passed predictions only", async () => {
    const { rankPredictions } = await import("../src/commands/score");
    const result = rankPredictions([
      { ...basePred, passed: true, task_id: "a" },
      { ...basePred, passed: false, task_id: "b" },
      { ...basePred, passed: true, task_id: "c" },
    ] as any);
    expect(result.passed_count).toBe(2);
    expect(result.failed_count).toBe(1);
  });

  it("ranks by cost_usd ascending among passers", async () => {
    const { rankPredictions } = await import("../src/commands/score");
    const result = rankPredictions([
      { ...basePred, passed: true, agent_name: "agent-a", cost_usd: 0.30 },
      { ...basePred, passed: true, agent_name: "agent-b", cost_usd: 0.10 },
      { ...basePred, passed: false, agent_name: "agent-c", cost_usd: 0.01 },
    ] as any);
    expect(result.ranked[0].agent_name).toBe("agent-b");
    expect(result.ranked[1].agent_name).toBe("agent-a");
    expect(result.ranked).toHaveLength(2);
  });

  it("runScore throws on invalid prediction", async () => {
    const file = writeJsonl("bad.jsonl", [{ task_id: "x" }]);
    const { runScore } = await import("../src/commands/score");
    await expect(runScore(file)).rejects.toThrow();
  });

  it("runScore writes output when --output specified", async () => {
    const file = writeJsonl("good.jsonl", [{ ...basePred, passed: true }]);
    const outFile = path.join(tmpDir, "out.json");
    const { runScore } = await import("../src/commands/score");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await runScore(file, outFile);
    expect(fs.existsSync(outFile)).toBe(true);
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"));
    expect(out.passed_count).toBe(1);
  });

  it("runScore handles empty file", async () => {
    const file = path.join(tmpDir, "empty.jsonl");
    fs.writeFileSync(file, "");
    const { runScore } = await import("../src/commands/score");
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(runScore(file)).resolves.not.toThrow();
  });
});
