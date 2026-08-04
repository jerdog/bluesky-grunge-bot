import type { Env } from "./env";

// Runtime-tunable settings.
//
// `wrangler.jsonc` vars are baked in at deploy time, so they can't be changed from
// the dashboard. These helpers resolve KV overrides on top of those vars: the env
// var is the default, and anything saved via the dashboard wins until it's cleared.
//
// SPEC is the single source of truth — the `Settings` type, the clamp bounds, the
// env parsing, and the dashboard's form fields are all derived from it, so adding
// a tunable is one entry here plus a wrangler.jsonc var.

const K_SETTINGS = "settings:overrides";

interface Spec {
  envVar: keyof Env;
  fallback: number;
  min: number;
  max: number;
  label: string;
  hint: string;
}

export const SPEC = {
  matchTopK: {
    envVar: "MATCH_TOP_K",
    fallback: 25,
    min: 1,
    // Vectorize caps topK at 50 when a query returns full metadata, which ours does.
    max: 50,
    label: "Vectorize recall (topK)",
    hint: "candidates fetched",
  },
  rerankTopN: {
    envVar: "RERANK_TOP_N",
    fallback: 4,
    min: 1,
    max: 20,
    label: "Rerank shortlist (topN)",
    hint: "lines the LLM picks from",
  },
  snippetMaxChars: {
    envVar: "SNIPPET_MAX_CHARS",
    fallback: 260,
    min: 40,
    max: 280,
    label: "Snippet max chars",
    hint: "total quote length posted",
  },
  passageMaxLines: {
    envVar: "PASSAGE_MAX_LINES",
    fallback: 8,
    min: 1,
    max: 12,
    label: "Passage max lines",
    hint: "1 = single line only",
  },
  lineMaxChars: {
    envVar: "LINE_MAX_CHARS",
    fallback: 150,
    min: 40,
    max: 200,
    label: "Harvest line max chars",
    hint: "corpus build only; needs a rebuild",
  },
} as const satisfies Record<string, Spec>;

export type SettingKey = keyof typeof SPEC;
export type Settings = Record<SettingKey, number>;

export const SETTING_KEYS = Object.keys(SPEC) as SettingKey[];

/** Clamp a value into its allowed range; returns null if not a usable number. */
export function clamp(key: SettingKey, value: unknown): number | null {
  const n = typeof value === "number" ? value : Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return null;
  const { min, max } = SPEC[key];
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** Deploy-time defaults, parsed from the wrangler.jsonc vars. */
export function defaults(env: Env): Settings {
  const out = {} as Settings;
  for (const key of SETTING_KEYS) {
    const spec = SPEC[key];
    const parsed = Number.parseInt(String(env[spec.envVar] ?? ""), 10);
    out[key] = Number.isFinite(parsed) ? parsed : spec.fallback;
  }
  return out;
}

type Overrides = Partial<Record<SettingKey, number>>;

/** Single KV read of the override blob. Never throws — a bad read means "no overrides". */
async function readOverrides(env: Env): Promise<Overrides> {
  try {
    return (await env.STATE.get<Overrides>(K_SETTINGS, "json")) ?? {};
  } catch {
    return {};
  }
}

/** Pure merge of stored overrides onto the deploy-time defaults. */
function applyOverrides(base: Settings, stored: Overrides): Settings {
  const out = { ...base };
  for (const key of SETTING_KEYS) {
    const raw = stored[key];
    if (raw === undefined || raw === null) continue;
    const v = clamp(key, raw);
    if (v !== null) out[key] = v;
  }
  return out;
}

export interface Resolved {
  settings: Settings;
  /** Keys currently overridden, for showing "modified" in the UI. */
  overridden: SettingKey[];
}

/** What "resolved" means, in one place — both entry points below return this. */
function resolve(env: Env, stored: Overrides): Resolved {
  return {
    settings: applyOverrides(defaults(env), stored),
    overridden: SETTING_KEYS.filter((k) => stored[k] !== undefined),
  };
}

/** Effective settings plus which keys are overridden, from one KV read. */
export async function resolveSettings(env: Env): Promise<Resolved> {
  return resolve(env, await readOverrides(env));
}

/** Effective settings: env defaults with any stored overrides applied. */
export async function loadSettings(env: Env): Promise<Settings> {
  return (await resolveSettings(env)).settings;
}

/**
 * Merge and persist overrides. Only known, in-range keys are stored; an empty
 * value clears an override, falling back to the deployed default. Returns the
 * effective result computed from data in hand — no read-after-write.
 */
export async function saveSettings(env: Env, patch: Record<string, unknown>): Promise<Resolved> {
  const next: Overrides = { ...(await readOverrides(env)) };

  for (const key of SETTING_KEYS) {
    if (!(key in patch)) continue;
    const raw = patch[key];
    if (raw === "" || raw === null) {
      delete next[key];
      continue;
    }
    const v = clamp(key, raw);
    if (v !== null) next[key] = v;
  }

  await env.STATE.put(K_SETTINGS, JSON.stringify(next));
  return resolve(env, next);
}
