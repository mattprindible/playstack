/**
 * Tests for the shared handler.
 *
 * Run with `pnpm test` (which is just `node --test`). Note what is NOT here:
 * no vitest, no jest, no supertest, no nock, no msw. Node 24 ships the test
 * runner, the assertion library and the TypeScript support. Zero dependencies
 * means zero supply-chain surface for the part of the repo you run most often.
 *
 * We fake `fetch` by hand — it is a one-line function, which is a good reminder
 * that most mocking libraries are solving a problem you can avoid by injecting
 * your dependencies.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { createHandler, validateNewMessage, LIMITS } from "./handler.ts";
import type { Env } from "./env.ts";
import type { FetchLike, Message } from "./supabase.ts";

const TEST_ENV: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
};

const SAMPLE: Message = {
  id: 1,
  name: "Ada",
  body: "Hello, world!",
  created_at: "2026-08-08T00:00:00Z",
};

type Call = { url: string; init: RequestInit | undefined };

/** A fetch stand-in that records calls and replays a canned response. */
function stubFetch(
  response: { status?: number; body: unknown },
  calls: Call[] = [],
): { fetch: FetchLike; calls: Call[] } {
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return new Response(JSON.stringify(response.body), {
      status: response.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as FetchLike;

  return { fetch: fetchImpl, calls };
}

function handlerWith(stub: { fetch: FetchLike }, platform = "test") {
  return createHandler({ env: TEST_ENV, fetch: stub.fetch, platform });
}

test("GET /api/health reports which platform answered", async () => {
  const handler = handlerWith(stubFetch({ body: [] }), "cloudflare");
  const response = await handler(new Request("https://x.dev/api/health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", platform: "cloudflare" });
});

test("GET /api/messages returns rows from PostgREST", async () => {
  const stub = stubFetch({ body: [SAMPLE] });
  const handler = handlerWith(stub);

  const response = await handler(new Request("https://x.dev/api/messages"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { messages: [SAMPLE] });
});

test("GET /api/messages sends the auth headers RLS depends on", async () => {
  const stub = stubFetch({ body: [] });
  const handler = handlerWith(stub);

  await handler(new Request("https://x.dev/api/messages"));

  const call = stub.calls[0];
  assert.ok(call, "expected exactly one upstream call");
  assert.ok(call.url.startsWith("https://example.supabase.co/rest/v1/messages"));
  assert.match(call.url, /order=created_at\.desc/);

  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.apikey, "test-anon-key");
  assert.equal(headers.Authorization, "Bearer test-anon-key");
});

test("POST /api/messages creates a message and returns 201", async () => {
  const stub = stubFetch({ status: 201, body: [SAMPLE] });
  const handler = handlerWith(stub);

  const response = await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Ada", body: "Hello, world!" }),
    }),
  );

  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), { message: SAMPLE });

  // PostgREST stays silent unless you ask for the row back.
  const headers = stub.calls[0]?.init?.headers as Record<string, string>;
  assert.equal(headers.Prefer, "return=representation");
});

test("POST /api/messages rejects malformed JSON without calling Supabase", async () => {
  const stub = stubFetch({ body: [] });
  const handler = handlerWith(stub);

  const response = await handler(
    new Request("https://x.dev/api/messages", { method: "POST", body: "not json{" }),
  );

  assert.equal(response.status, 400);
  assert.equal(stub.calls.length, 0, "must not hit the database on bad input");
});

test("upstream failures preserve their status code", async () => {
  const stub = stubFetch({ status: 401, body: { message: "RLS denied" } });
  const handler = handlerWith(stub);

  const response = await handler(new Request("https://x.dev/api/messages"));

  assert.equal(response.status, 401, "an RLS rejection must not become a 500");
});

test("unknown routes 404 and preflight succeeds", async () => {
  const handler = handlerWith(stubFetch({ body: [] }));

  const missing = await handler(new Request("https://x.dev/nope"));
  assert.equal(missing.status, 404);

  const preflight = await handler(
    new Request("https://x.dev/api/messages", { method: "OPTIONS" }),
  );
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "*");
});

test("routes work when request.url is a bare path (the Vercel shape)", async () => {
  // Regression test for a real production outage. Cloudflare hands the handler
  // an absolute request.url; Vercel's Node runtime hands it a path plus the
  // catch-all query param. Every Vercel request 500'd on ERR_INVALID_URL until
  // `new URL(..., base)` was used.
  //
  // Request normalises a relative URL, so we call the handler directly with a
  // minimal stand-in to reproduce exactly what Vercel passes in.
  const handler = handlerWith(stubFetch({ body: [SAMPLE] }), "vercel");

  const vercelStyle = {
    url: "/api/health?...path=health",
    method: "GET",
  } as unknown as Request;

  const response = await handler(vercelStyle);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok", platform: "vercel" });

  const messages = await handler({
    url: "/api/messages?...path=messages",
    method: "GET",
  } as unknown as Request);
  assert.equal(messages.status, 200);
});

test("validateNewMessage enforces the documented limits", () => {
  assert.equal(validateNewMessage({ name: "a", body: "b" }).ok, true);

  // Trimmed before measuring, so whitespace cannot smuggle a value through.
  assert.equal(validateNewMessage({ name: "   ", body: "b" }).ok, false);
  assert.equal(validateNewMessage({ name: "a", body: "" }).ok, false);
  assert.equal(validateNewMessage(null).ok, false);
  assert.equal(validateNewMessage([]).ok, false);
  assert.equal(validateNewMessage({ name: 1, body: "b" }).ok, false);

  assert.equal(
    validateNewMessage({ name: "x".repeat(LIMITS.nameMax + 1), body: "b" }).ok,
    false,
  );
  assert.equal(
    validateNewMessage({ name: "a", body: "x".repeat(LIMITS.bodyMax + 1) }).ok,
    false,
  );

  const trimmed = validateNewMessage({ name: "  Ada  ", body: "  hi  " });
  assert.deepEqual(trimmed.ok && trimmed.value, { name: "Ada", body: "hi" });
});
