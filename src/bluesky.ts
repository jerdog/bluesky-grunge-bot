import {
  AtpAgent,
  RichText,
  type AppBskyFeedPost,
  type ComAtprotoRepoStrongRef,
} from "@atproto/api";
import type { Env } from "./env";
import { isDryRun } from "./env";
import { loadSession, saveSession, clearSession } from "./state";

const SERVICE = "https://bsky.social";

/**
 * Bluesky's hard post limit. Owned here because this module owns the platform;
 * exported so composers can reserve room rather than discover the limit by
 * failing. `buildPostRecord` asserts it as a last-resort backstop.
 */
export const POST_MAX_GRAPHEMES = 300;

// The SDK's generated lexicon types already carry the open index signature these
// records need; re-declaring them by hand would just duplicate that.
export type StrongRef = ComAtprotoRepoStrongRef.Main;
export type ReplyRef = AppBskyFeedPost.ReplyRef;

/** Secrets that must exist before we can authenticate at all. */
export const REQUIRED_SECRETS = ["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"] as const;

/** Names of the required secrets that are absent from `env`. */
export const missingSecrets = (env: Partial<Env>): string[] =>
  REQUIRED_SECRETS.filter((k) => !env[k]);

/**
 * One authenticated agent per Worker invocation.
 *
 * `resumeSession` is a network call to bsky.social and also fires
 * `persistSession`, which writes KV — so calling it per post would cost a KV read,
 * a round trip and a KV write for every reply in a batch. `env` is
 * invocation-scoped, so a WeakMap keyed on it expires naturally with no risk of
 * leaking tokens across requests. The *promise* is cached so concurrent callers
 * share one in-flight resume.
 */
const agents = new WeakMap<Env, Promise<AtpAgent>>();

function getAgent(env: Env): Promise<AtpAgent> {
  const existing = agents.get(env);
  if (existing) return existing;
  const created = createAgent(env);
  agents.set(env, created);
  return created;
}

async function createAgent(env: Env): Promise<AtpAgent> {
  const cached = await loadSession(env);
  // What KV already holds, so an unchanged session isn't rewritten. The SDK fires
  // persistSession on resume as well as on rotation, so writing unconditionally
  // cost one KV write on *every* poll — pure overhead that scales with how often
  // the cron runs, and the tighter the schedule the more it matters.
  let stored = cached;

  const agent = new AtpAgent({
    service: SERVICE,
    // Sole writer of the cached session: the SDK fires this on login, on resume,
    // and on every token rotation, so no call site needs to save explicitly.
    persistSession: (_evt, sess) => {
      if (!sess) return;
      if (stored?.accessJwt === sess.accessJwt && stored?.refreshJwt === sess.refreshJwt) {
        return; // resumed with the same tokens — nothing to persist
      }
      stored = {
        accessJwt: sess.accessJwt,
        refreshJwt: sess.refreshJwt,
        did: sess.did,
        handle: sess.handle,
      };
      void saveSession(env, stored);
    },
  });

  if (cached) {
    try {
      await agent.resumeSession({ ...cached, active: true });
      return agent;
    } catch {
      // Cached tokens no longer valid — drop and log in fresh below.
      await clearSession(env);
    }
  }

  // Check before calling login: the SDK reports a missing handle as
  // `Input must have the property "identifier"`, which names an AT Protocol
  // field rather than the Worker secret that is actually absent.
  const missing = missingSecrets(env);
  if (missing.length > 0) {
    throw new Error(
      `missing Worker secret${missing.length > 1 ? "s" : ""}: ${missing.join(", ")} — ` +
        `set with: ./scripts/cf.sh secrets`,
    );
  }

  await agent.login({
    identifier: env.BLUESKY_HANDLE,
    password: env.BLUESKY_APP_PASSWORD,
  });
  return agent;
}

/**
 * Build the post record with detected richtext facets, and enforce the platform
 * length limit here — the single place every outbound record is constructed, in
 * graphemes (what Bluesky actually counts) rather than UTF-16 units.
 */
async function buildPostRecord(agent: AtpAgent, text: string, reply?: ReplyRef) {
  const rt = new RichText({ text });
  await rt.detectFacets(agent);
  if (rt.graphemeLength > POST_MAX_GRAPHEMES) {
    throw new Error(`post is ${rt.graphemeLength} graphemes, limit is ${POST_MAX_GRAPHEMES}`);
  }
  return {
    $type: "app.bsky.feed.post",
    text: rt.text,
    facets: rt.facets,
    createdAt: new Date().toISOString(),
    ...(reply ? { reply } : {}),
  };
}

/**
 * Publish a post, or a reply when `reply` is given. The DRY_RUN gate lives here,
 * at the single send choke point, and short-circuits before the auth handshake so
 * a dry run costs nothing.
 */
async function publish(env: Env, text: string, reply?: ReplyRef): Promise<StrongRef | null> {
  if (isDryRun(env)) {
    console.log(
      `[DRY_RUN] would ${reply ? "reply" : "post"}:`,
      JSON.stringify({ text, parent: reply?.parent.uri }),
    );
    return null;
  }
  const agent = await getAgent(env);
  const res = await agent.post(await buildPostRecord(agent, text, reply));
  return { uri: res.uri, cid: res.cid };
}

/** Create a top-level post. Returns null in DRY_RUN. */
export const post = (env: Env, text: string) => publish(env, text);

/** Reply to a post. Returns null in DRY_RUN. */
export const reply = (env: Env, text: string, replyRef: ReplyRef) =>
  publish(env, text, replyRef);

/**
 * Parse a Bluesky post reference into its actor + record key.
 *
 * Accepts what you can actually copy out of a browser or a client:
 *   https://bsky.app/profile/<handle-or-did>/post/<rkey>
 *   at://<did>/app.bsky.feed.post/<rkey>
 * Returns null for anything else, including likes and other collections.
 */
export function parseBskyUrl(input: string): { actor: string; rkey: string } | null {
  const s = input.trim();
  if (!s) return null;

  const at = s.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/([^/?#]+)/);
  if (at) return { actor: at[1], rkey: at[2] };

  const web = s.match(/^https?:\/\/(?:[a-z0-9.-]*\.)?bsky\.app\/profile\/([^/]+)\/post\/([^/?#]+)/i);
  if (web) return { actor: web[1], rkey: web[2] };

  return null;
}

/**
 * The inverse of `parseBskyUrl`: an at:// post URI as a bsky.app permalink.
 * Returns null when there is no URI (dry-run rows) or the URI isn't a post —
 * a like or a follow has no permalink of this shape.
 *   at://did:plc:abc/app.bsky.feed.post/3k2a -> https://bsky.app/profile/did:plc:abc/post/3k2a
 *
 * Lives here rather than in analytics.ts because the record-path format is a
 * platform concern; keeping it beside the parser means a change to the AT Proto
 * path shape lands on both directions at once.
 */
export function bskyUrl(uri: string | null | undefined): string | null {
  if (!uri) return null;
  const m = uri.match(/^at:\/\/([^/]+)\/app\.bsky\.feed\.post\/(.+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

/**
 * Resolve a post reference into the same shape the notification poller produces,
 * so a manually-supplied post flows through exactly the same reply path.
 *
 * `root` matters: replying to something that is itself a reply must thread under
 * the original root, not under the post we were handed.
 */
export async function resolvePostTarget(env: Env, input: string): Promise<MentionNotification> {
  const parsed = parseBskyUrl(input);
  if (!parsed) {
    throw new Error(
      "could not parse that as a Bluesky post — expected https://bsky.app/profile/<handle>/post/<id>",
    );
  }

  const agent = await getAgent(env);
  let did = parsed.actor;
  if (!did.startsWith("did:")) {
    const res = await agent.resolveHandle({ handle: did });
    did = res.data.did;
  }

  const uri = `at://${did}/app.bsky.feed.post/${parsed.rkey}`;
  const { data } = await agent.getPosts({ uris: [uri] });
  const post = data.posts[0];
  if (!post) throw new Error(`no such post: ${uri}`);

  const record = post.record as { text?: string; reply?: { root?: StrongRef } };
  const self: StrongRef = { uri: post.uri, cid: post.cid };

  return {
    uri: post.uri,
    cid: post.cid,
    reason: "manual",
    authorHandle: post.author.handle,
    authorDid: post.author.did,
    text: record.text ?? "",
    root: record.reply?.root ?? self,
    parent: self,
  };
}

export interface MentionNotification {
  uri: string;
  cid: string;
  reason: string; // 'mention' | 'reply' | ...
  authorHandle: string;
  authorDid: string;
  text: string;
  // The thread root; for a reply-notification we thread under the mentioning post.
  root: StrongRef;
  parent: StrongRef;
}

/**
 * List notifications since the given cursor and return only actionable
 * mention/reply items (with their text and reply refs resolved).
 */
export async function listMentions(
  env: Env,
  cursor?: string,
): Promise<{ mentions: MentionNotification[]; cursor?: string }> {
  const agent = await getAgent(env);
  const res = await agent.listNotifications({ limit: 50, cursor });
  const mentions: MentionNotification[] = [];

  for (const n of res.data.notifications) {
    if (n.reason !== "mention" && n.reason !== "reply") continue;
    const record = n.record as { text?: string; reply?: { root?: StrongRef } };
    const self: StrongRef = { uri: n.uri, cid: n.cid };
    mentions.push({
      uri: n.uri,
      cid: n.cid,
      reason: n.reason,
      authorHandle: n.author.handle,
      authorDid: n.author.did,
      text: record.text ?? "",
      root: record.reply?.root ?? self,
      parent: self,
    });
  }

  return { mentions, cursor: res.data.cursor };
}
