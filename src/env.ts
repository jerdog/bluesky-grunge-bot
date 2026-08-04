/// <reference types="@cloudflare/workers-types" />

// Bindings and vars available to the Worker. Mirrors wrangler.jsonc.
export interface Env {
  // Bindings
  AI: Ai;
  LYRICS_INDEX: VectorizeIndex;
  DB: D1Database;
  STATE: KVNamespace;

  // Vars
  DRY_RUN: string;
  AI_TEXT_MODEL: string;
  AI_EMBED_MODEL: string;
  AI_RERANK_MODEL: string;
  MATCH_TOP_K: string;
  RERANK_TOP_N: string;
  SNIPPET_MAX_CHARS: string;
  PASSAGE_MAX_LINES: string;
  LINE_MAX_CHARS: string;

  // Secrets
  BLUESKY_HANDLE: string;
  BLUESKY_APP_PASSWORD: string;
  MANUAL_TRIGGER_KEY: string;
}

export const isDryRun = (env: Env): boolean => env.DRY_RUN !== "false";

/**
 * The bot's handle without a leading "@". Both reply entry points feed this to the
 * same mention-stripping regex, so normalising it in two places would let them
 * build subtly different patterns.
 */
export const botHandle = (env: Env): string => env.BLUESKY_HANDLE.replace(/^@/, "");

/** Current time in unix seconds — the unit every stored timestamp uses. */
export const nowSeconds = (): number => Math.floor(Date.now() / 1000);

// NOTE: the tunable values (MATCH_TOP_K, RERANK_TOP_N, SNIPPET_MAX_CHARS,
// PASSAGE_MAX_LINES, LINE_MAX_CHARS) are deliberately NOT exported as accessors
// here. They are dashboard-editable, so reading the raw var would bypass the KV
// override. Go through `loadSettings(env)` in ./settings, which owns parsing them.
