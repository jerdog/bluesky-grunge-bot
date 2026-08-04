import { describe, it, expect, vi } from "vitest";
import worker from "./index";
import type { Env } from "./env";

/**
 * Routing and auth only — the work itself is covered by each module's own tests.
 */
function makeEnv(over: Partial<Env> = {}) {
  return {
    MANUAL_TRIGGER_KEY: "secret",
    DRY_RUN: "true",
    DB: { prepare: vi.fn(() => ({ bind: () => ({ first: async () => null, run: async () => {} }) })) },
    ...over,
  } as unknown as Env;
}

const get = (path: string, env: Env, headers: Record<string, string> = {}) =>
  worker.fetch(new Request(`https://w.example${path}`, { headers }), env);

describe("auth gate", () => {
  it("rejects a guarded route with no key", async () => {
    expect((await get("/run/poll", makeEnv())).status).toBe(401);
    expect((await get("/api/summary", makeEnv())).status).toBe(401);
  });

  it("rejects a wrong key", async () => {
    expect((await get("/run/poll?key=nope", makeEnv())).status).toBe(401);
  });

  it("fails closed when MANUAL_TRIGGER_KEY is unset, rather than allowing everything", async () => {
    const env = makeEnv({ MANUAL_TRIGGER_KEY: "" });
    expect((await get("/run/poll?key=", env)).status).toBe(401);
    expect((await get("/dashboard", env)).status).toBe(401);
  });

  it("accepts the session cookie it issues", async () => {
    const res = await get("/dashboard?key=secret", makeEnv({ DB: emptyDb() }));
    expect(res.headers.get("set-cookie")).toContain("bgb_auth=secret");
    expect(res.headers.get("set-cookie")).toContain("HttpOnly");
    expect(res.headers.get("set-cookie")).toContain("SameSite=Strict");
  });
});

describe("/run/<action>", () => {
  it("404s an unknown action without opening a run row", async () => {
    // A caller-supplied name reaching withRun would write a `runs` record with an
    // arbitrary `kind`, so validation has to come first.
    const prepare = vi.fn();
    const env = makeEnv({ DB: { prepare } as unknown as Env["DB"] });
    const res = await get("/run/../../etc/passwd?key=secret", env);
    expect(res.status).toBe(404);
    expect(prepare).not.toHaveBeenCalled();
  });
});

describe("/health", () => {
  it("needs no auth and reports the dry-run flag", async () => {
    const res = await get("/health", makeEnv({ DB: brokenDb() }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true });
  });
});

/** D1 that answers everything with no rows. */
function emptyDb() {
  const stmt = {
    bind: () => stmt,
    first: async () => null,
    all: async () => ({ results: [] }),
    run: async () => ({}),
  };
  return { prepare: () => stmt } as unknown as Env["DB"];
}

/**
 * D1 that always throws. /health degrades to a -1 line count; the dashboard does
 * NOT degrade and will surface the error — it is a reporting page, so failing
 * loudly beats rendering zeroes that look like real data.
 */
function brokenDb() {
  return {
    prepare: () => {
      throw new Error("D1 down");
    },
  } as unknown as Env["DB"];
}
