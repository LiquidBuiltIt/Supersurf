import fs from "node:fs";
import { PredictionSchema, Prediction } from "../lib/schemas";

export interface ScoreReport {
  total: number;
  passed_count: number;
  failed_count: number;
  ranked: Prediction[];
}

export function rankPredictions(predictions: Prediction[]): ScoreReport {
  const passers = predictions.filter((p) => p.passed);
  const ranked = [...passers].sort((a, b) => a.cost_usd - b.cost_usd);
  return {
    total: predictions.length,
    passed_count: passers.length,
    failed_count: predictions.length - passers.length,
    ranked,
  };
}

function parseJsonl(content: string): Prediction[] {
  return content
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line, idx) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error(`Line ${idx + 1}: invalid JSON`);
      }
      const result = PredictionSchema.safeParse(parsed);
      if (!result.success) {
        throw new Error(`Line ${idx + 1}: ${result.error.message}`);
      }
      return result.data;
    });
}

export async function runScore(file: string, output?: string): Promise<void> {
  const content = fs.readFileSync(file, "utf8");
  const predictions = parseJsonl(content);
  const report = rankPredictions(predictions);

  console.log(`Total: ${report.total}  Passed: ${report.passed_count}  Failed: ${report.failed_count}`);
  console.log("\nRanked passers (cheapest first):");
  report.ranked.forEach((p, i) => {
    console.log(
      `  ${i + 1}. ${p.agent_name}@${p.agent_version} (${p.model}) — $${p.cost_usd.toFixed(4)} | ${p.time_ms}ms | ${p.tool_calls} calls`
    );
  });

  if (output) {
    fs.writeFileSync(output, JSON.stringify(report, null, 2));
    console.log(`\nWrote report to ${output}`);
  }
}
