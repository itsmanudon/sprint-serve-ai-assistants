import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';

/**
 * Standalone stand-in for Sprint Serve's validated env. Same ASSISTANT_* names
 * and defaults, so the assistant module runs unchanged. Reads ./.env if present.
 */
const envFile = resolve(process.cwd(), '.env');
if (process.env.NODE_ENV !== 'test' && existsSync(envFile)) {
  // Variables already set in the shell win over the file.
  const preset = { ...process.env };
  process.loadEnvFile(envFile);
  Object.assign(process.env, preset);
}

const bool = z
  .enum(['true', 'false', '1', '0'])
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  ASSISTANT_ENABLED: bool,
  ASSISTANT_MODEL_BASE_URL: z.string().url().default('https://api.meta.ai/v1'),
  ASSISTANT_MODEL: z.string().min(1).max(100).default('muse-spark-1.3'),
  ASSISTANT_MODEL_API_KEY: z.string().min(10).optional(),
  ASSISTANT_MODEL_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(20000),
  ASSISTANT_DEBUG_USAGE: bool,
  ASSISTANT_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
  // Owner assistant tiers. Fast: picks and runs the reports. Deep: writes analysis
  // from them. Each falls back to the ASSISTANT_MODEL_* defaults; the deep tier may
  // point at another OpenAI-compatible host (e.g. a larger Meta open-weights model).
  ASSISTANT_FAST_MODEL: z.string().min(1).max(100).optional(),
  ASSISTANT_FAST_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
  ASSISTANT_DEEP_MODEL: z.string().min(1).max(100).optional(),
  ASSISTANT_DEEP_REASONING_EFFORT: z.enum(['minimal', 'low', 'medium', 'high', 'xhigh']).default('high'),
  ASSISTANT_DEEP_BASE_URL: z.string().url().optional(),
  ASSISTANT_DEEP_API_KEY: z.string().min(10).optional(),
  ASSISTANT_DEEP_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(45000),
});

const blankToUndefined = Object.fromEntries(
  Object.entries(process.env).map(([k, v]) => [k, v === '' ? undefined : v])
);

export const env = schema.parse(blankToUndefined);
