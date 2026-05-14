import { describe, it, expect } from "vitest";
import { PredictionSchema, ManifestSchema } from "../src/lib/schemas";

describe("PredictionSchema", () => {
  const valid = {
    task_id: "challenge-course/01-nested-iframe",
    agent_name: "supersurf",
    agent_version: "1.11.0",
    model: "claude-opus-4-7",
    passed: true,
    evidence: { submitted: true },
    time_ms: 4320,
    tool_calls: 9,
    tokens_in: 12400,
    tokens_out: 380,
    cost_usd: 0.21,
    webdrive_version: "0.1.0",
    evaluated_at: "2026-05-11T12:00:00.000Z",
  };

  it("accepts a valid prediction", () => {
    expect(() => PredictionSchema.parse(valid)).not.toThrow();
  });

  it("rejects negative time_ms", () => {
    expect(() => PredictionSchema.parse({ ...valid, time_ms: -1 })).toThrow();
  });

  it("rejects non-integer tool_calls", () => {
    expect(() => PredictionSchema.parse({ ...valid, tool_calls: 1.5 })).toThrow();
  });

  it("rejects malformed evaluated_at", () => {
    expect(() => PredictionSchema.parse({ ...valid, evaluated_at: "yesterday" })).toThrow();
  });

  it("allows omitted evidence", () => {
    const { evidence, ...withoutEvidence } = valid;
    expect(() => PredictionSchema.parse(withoutEvidence)).not.toThrow();
  });
});

describe("ManifestSchema", () => {
  it("accepts a valid manifest", () => {
    const manifest = {
      version: "0.1.0",
      suites: {
        v1: {
          description: "Domain 1 foundation suite",
          challenges: ["challenge-course/01-nested-iframe"],
        },
      },
    };
    expect(() => ManifestSchema.parse(manifest)).not.toThrow();
  });

  it("rejects missing suite description", () => {
    const manifest = {
      version: "0.1.0",
      suites: { v1: { challenges: [] } },
    };
    expect(() => ManifestSchema.parse(manifest)).toThrow();
  });
});
