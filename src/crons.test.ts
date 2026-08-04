import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { ACTION_CRONS } from "./index";

/**
 * The cron strings live in two files — `wrangler.jsonc` decides what fires, and
 * `ACTIONS` decides what each firing does — and they are matched by exact string.
 *
 * Nothing at runtime notices when they disagree. `jobForCron` just returns
 * undefined and `scheduled()` logs and returns, so the job stops running while the
 * Worker still reports healthy. That is not hypothetical: the poll interval was
 * changed in `wrangler.jsonc` alone, and the bot quietly stopped replying to every
 * mention until this test was written.
 *
 * So the coupling is asserted here rather than trusted. `cf.sh deploy` runs the
 * suite, which makes a drifted schedule a failed deploy instead of a silent outage.
 */
function wranglerCrons(): string[] {
  const raw = readFileSync("wrangler.jsonc", "utf8");
  const block = raw.match(/"crons"\s*:\s*\[([\s\S]*?)\]/);
  if (!block) throw new Error("no triggers.crons array found in wrangler.jsonc");
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

describe("cron wiring", () => {
  it("fires exactly the schedules ACTIONS claims", () => {
    expect([...wranglerCrons()].sort()).toEqual([...ACTION_CRONS].sort());
  });

  it("lets one action own several schedules", () => {
    // The original post runs twice a day; a one-string-per-action registry would
    // have forced a duplicate entry per firing.
    expect(ACTION_CRONS.filter((c) => c.startsWith("0 15") || c.startsWith("0 21"))).toHaveLength(2);
  });

  it("gives every schedule a distinct owner", () => {
    // Two actions on one string would make the winner depend on key order.
    expect(new Set(ACTION_CRONS).size).toBe(ACTION_CRONS.length);
  });

  it("reads the real file, so the guard can't pass against a stale copy", () => {
    expect(wranglerCrons().length).toBeGreaterThan(0);
  });
});
