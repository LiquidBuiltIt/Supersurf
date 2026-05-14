import { z } from "zod";

export const PredictionSchema = z.object({
  task_id: z.string(),
  agent_name: z.string(),
  agent_version: z.string(),
  model: z.string(),
  passed: z.boolean(),
  evidence: z.record(z.unknown()).optional(),
  time_ms: z.number().nonnegative(),
  tool_calls: z.number().int().nonnegative(),
  tokens_in: z.number().int().nonnegative(),
  tokens_out: z.number().int().nonnegative(),
  cost_usd: z.number().nonnegative(),
  webdrive_version: z.string(),
  evaluated_at: z.string().datetime(),
});

export type Prediction = z.infer<typeof PredictionSchema>;

export const ManifestSchema = z.object({
  version: z.string(),
  suites: z.record(
    z.object({
      description: z.string(),
      challenges: z.array(z.string()),
    })
  ),
});

export type Manifest = z.infer<typeof ManifestSchema>;
