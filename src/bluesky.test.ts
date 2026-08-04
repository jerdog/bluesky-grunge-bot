import { describe, it, expect } from "vitest";
import { bskyUrl, missingSecrets, REQUIRED_SECRETS } from "./bluesky";
import type { Env } from "./env";

describe("missingSecrets", () => {
  it("names the secrets that are absent", () => {
    expect(missingSecrets({} as Partial<Env>)).toEqual([
      "BLUESKY_HANDLE",
      "BLUESKY_APP_PASSWORD",
    ]);
    expect(missingSecrets({ BLUESKY_HANDLE: "a.bsky.social" } as Partial<Env>)).toEqual([
      "BLUESKY_APP_PASSWORD",
    ]);
  });

  it("treats an empty string as missing (a skipped `secret put` prompt)", () => {
    expect(
      missingSecrets({ BLUESKY_HANDLE: "", BLUESKY_APP_PASSWORD: "pw" } as Partial<Env>),
    ).toEqual(["BLUESKY_HANDLE"]);
  });

  it("is empty when both are set", () => {
    expect(
      missingSecrets({ BLUESKY_HANDLE: "a.bsky.social", BLUESKY_APP_PASSWORD: "pw" } as Partial<Env>),
    ).toEqual([]);
  });

  it("covers exactly the credentials login() needs", () => {
    expect([...REQUIRED_SECRETS]).toEqual(["BLUESKY_HANDLE", "BLUESKY_APP_PASSWORD"]);
  });
});

import { parseBskyUrl } from "./bluesky";

describe("parseBskyUrl", () => {
  it("parses a bsky.app URL with a handle", () => {
    expect(parseBskyUrl("https://bsky.app/profile/jerdog.dev/post/3k2aXyZ")).toEqual({
      actor: "jerdog.dev",
      rkey: "3k2aXyZ",
    });
  });

  it("parses a bsky.app URL with a DID", () => {
    expect(parseBskyUrl("https://bsky.app/profile/did:plc:abc123/post/3k2aXyZ")).toEqual({
      actor: "did:plc:abc123",
      rkey: "3k2aXyZ",
    });
  });

  it("parses an at:// URI", () => {
    expect(parseBskyUrl("at://did:plc:abc123/app.bsky.feed.post/3k2aXyZ")).toEqual({
      actor: "did:plc:abc123",
      rkey: "3k2aXyZ",
    });
  });

  it("tolerates surrounding whitespace, query strings and fragments", () => {
    expect(parseBskyUrl("  https://bsky.app/profile/a.bsky.social/post/3k2a?x=1#y  ")).toEqual({
      actor: "a.bsky.social",
      rkey: "3k2a",
    });
  });

  it("rejects non-post references and junk", () => {
    expect(parseBskyUrl("")).toBeNull();
    expect(parseBskyUrl("not a url")).toBeNull();
    expect(parseBskyUrl("https://bsky.app/profile/a.bsky.social")).toBeNull();
    expect(parseBskyUrl("https://example.com/profile/a/post/3k2a")).toBeNull();
    // A like record is not a post.
    expect(parseBskyUrl("at://did:plc:abc/app.bsky.feed.like/3k2a")).toBeNull();
  });
});

describe("bskyUrl", () => {
  it("converts an at:// post uri to a bsky.app permalink", () => {
    expect(bskyUrl("at://did:plc:abc123/app.bsky.feed.post/3k2aXyZ")).toBe(
      "https://bsky.app/profile/did:plc:abc123/post/3k2aXyZ",
    );
  });

  it("returns null for dry-run rows and unusable input", () => {
    expect(bskyUrl(null)).toBeNull();
    expect(bskyUrl(undefined)).toBeNull();
    expect(bskyUrl("")).toBeNull();
    expect(bskyUrl("https://example.com/not-an-at-uri")).toBeNull();
    expect(bskyUrl("at://did:plc:abc/app.bsky.feed.like/3k2a")).toBeNull();
  });
});
