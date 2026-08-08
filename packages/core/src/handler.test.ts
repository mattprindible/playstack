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

import { generateKeyPair, exportJWK, jwtVerify } from "jose";

import { createHandler, validateNewMessage, LIMITS } from "./handler.ts";
import { readSigningKey, type SigningKey } from "./token.ts";
import type { Env } from "./env.ts";
import type { FetchLike, Message } from "./supabase.ts";

const TEST_ENV: Env = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "test-anon-key",
};

/**
 * A throwaway ES256 keypair, generated per test run. Real key material never
 * goes near the test suite, and we keep the public half so tests can VERIFY
 * the tokens the handler mints rather than taking their contents on trust.
 */
const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
const TEST_KEY: SigningKey = {
  kid: "test-kid",
  alg: "ES256",
  privateKey,
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

const ADA = { label: "ada@example.com", subject: "user-123" };

function gateReturning(identity: { label: string; subject: string } | null) {
  return { name: "test-gate", resolve: async () => identity };
}

/**
 * Every handler needs a gate — `HandlerDeps.gate` is not optional, so there is
 * no ungated handler to construct even in a test. The default here admits a
 * known user so the tests below can exercise the ordinary path.
 */
function handlerWith(stub: { fetch: FetchLike }, platform = "test") {
  return createHandler({
    env: TEST_ENV,
    fetch: stub.fetch,
    platform,
    gate: gateReturning(ADA),
    signingKey: TEST_KEY,
  });
}

test("GET /api/health reports which platform answered and which gate is active", async () => {
  const handler = handlerWith(stubFetch({ body: [] }), "cloudflare");
  const response = await handler(new Request("https://x.dev/api/health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: "ok",
    platform: "cloudflare",
    gate: "test-gate",
    identity: ADA.label,
  });
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

  // The two headers do different jobs: apikey identifies the project, while
  // Authorization carries the minted per-caller token RLS actually evaluates.
  // They used to be the same value; that they now differ is the whole change.
  const headers = call.init?.headers as Record<string, string>;
  assert.equal(headers.apikey, "test-anon-key");
  assert.notEqual(
    headers.Authorization,
    "Bearer test-anon-key",
    "the anon key must no longer be used as the bearer token",
  );
});

test("subject and gate are never exposed to the browser", async () => {
  const stub = stubFetch({ body: [] });
  const handler = handlerWith(stub);

  await handler(new Request("https://x.dev/api/messages"));

  const select = new URL(String(stub.calls[0]?.url)).searchParams.get("select");
  assert.equal(select, "id,name,body,created_at");
  assert.doesNotMatch(select ?? "", /subject/, "the stable identity must stay server-side");
});

// ---------------------------------------------------------------------------
// The minted token. These assertions are the client-side half of the RLS
// policy in supabase/migrations/…_attributed_messages.sql — if they drift
// apart, every insert is rejected by the database.
// ---------------------------------------------------------------------------

async function claimsFrom(stub: { calls: Call[] }) {
  const headers = stub.calls[0]?.init?.headers as Record<string, string>;
  const token = String(headers.Authorization).replace(/^Bearer /, "");
  const { payload, protectedHeader } = await jwtVerify(token, publicKey);
  return { payload, protectedHeader };
}

test("the minted token carries exactly the claims the RLS policy checks", async () => {
  const stub = stubFetch({ status: 201, body: [SAMPLE] });
  const handler = handlerWith(stub);

  await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      body: JSON.stringify({ body: "hi" }),
    }),
  );

  const { payload, protectedHeader } = await claimsFrom(stub);

  assert.equal(protectedHeader.alg, "ES256");
  assert.equal(protectedHeader.kid, "test-kid", "kid is how Supabase finds the public key");

  assert.equal(payload.role, "authenticated", "PostgREST switches role on this claim");
  assert.equal(payload.sub, ADA.subject, "sub is the stable identity, not the label");
  assert.equal(payload.gate, "test-gate");
  assert.equal(payload.label, ADA.label);

  // Short-lived by design: minted per request, used once, never sent to a browser.
  const ttl = (payload.exp ?? 0) - (payload.iat ?? 0);
  assert.ok(ttl > 0 && ttl <= 120, `expected a short TTL, got ${ttl}s`);
});

test("the inserted row carries the attribution the database will verify", async () => {
  const stub = stubFetch({ status: 201, body: [SAMPLE] });
  const handler = handlerWith(stub);

  await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      body: JSON.stringify({ name: "Someone Else Entirely", body: "hi" }),
    }),
  );

  const sent = JSON.parse(String(stub.calls[0]?.init?.body));
  const { payload } = await claimsFrom(stub);

  // Each of these is compared against the token by the insert policy. The row
  // and the token have to agree, or Postgres refuses the write.
  assert.equal(sent.subject, payload.sub);
  assert.equal(sent.gate, payload.gate);
  assert.equal(sent.name, payload.label);
  assert.equal(sent.name, ADA.label, "the client-supplied name must be discarded");
});

test("a long identity is truncated the same way the SQL policy truncates it", async () => {
  // The policy is `name = left(auth.jwt() ->> 'label', 50)`. If this slice and
  // that left() ever disagree, every insert from a long-handled user is
  // rejected by RLS — a failure that looks like a database bug and is not.
  const long = `${"a".repeat(80)}@example.com`;
  const stub = stubFetch({ status: 201, body: [SAMPLE] });
  const handler = createHandler({
    env: TEST_ENV,
    fetch: stub.fetch,
    platform: "test",
    gate: gateReturning({ label: long, subject: "user-999" }),
    signingKey: TEST_KEY,
  });

  await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      body: JSON.stringify({ body: "hi" }),
    }),
  );

  const sent = JSON.parse(String(stub.calls[0]?.init?.body));
  const { payload } = await claimsFrom(stub);

  assert.equal(sent.name.length, LIMITS.nameMax);
  assert.equal(
    sent.name,
    String(payload.label).slice(0, LIMITS.nameMax),
    "row name must equal left(label, 50) or RLS rejects the insert",
  );
});

test("readSigningKey rejects an incomplete or malformed key", async () => {
  const jwk = await exportJWK(privateKey);

  await assert.rejects(
    () => readSigningKey({ SUPABASE_JWT_KID: "k" }),
    /SUPABASE_JWT_PRIVATE_KEY/,
    "a missing key must name itself, not fail later as a bad signature",
  );
  await assert.rejects(
    () => readSigningKey({ SUPABASE_JWT_KID: "k", SUPABASE_JWT_PRIVATE_KEY: "not json" }),
    /JSON Web Key/,
  );

  const ok = await readSigningKey({
    SUPABASE_JWT_KID: "k",
    SUPABASE_JWT_PRIVATE_KEY: JSON.stringify({ ...jwk, alg: "ES256" }),
  });
  assert.equal(ok.kid, "k");
  assert.equal(ok.alg, "ES256");
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

test("unknown routes 404 and OPTIONS advertises the allowed methods", async () => {
  const handler = handlerWith(stubFetch({ body: [] }));

  const missing = await handler(new Request("https://x.dev/nope"));
  assert.equal(missing.status, 404);

  const options = await handler(
    new Request("https://x.dev/api/messages", { method: "OPTIONS" }),
  );
  assert.equal(options.status, 204);
  assert.equal(options.headers.get("allow"), "GET,POST,OPTIONS");
});

test("no response carries CORS headers", async () => {
  // This API is same-origin only. A wildcard ACAO bought nothing and sat one
  // line away from a CSRF hole, so it is gone — and stays gone.
  const handler = handlerWith(stubFetch({ body: [] }));

  for (const request of [
    new Request("https://x.dev/api/health"),
    new Request("https://x.dev/api/messages"),
    new Request("https://x.dev/api/messages", { method: "OPTIONS" }),
    new Request("https://x.dev/nope"),
  ]) {
    const response = await handler(request);
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      null,
      `${request.method} ${new URL(request.url).pathname} must not allow cross-origin reads`,
    );
    assert.equal(response.headers.get("access-control-allow-credentials"), null);
  }
});

test("upstream error detail never reaches the caller", async () => {
  // PostgREST names tables, columns and constraints in its errors. That is
  // free reconnaissance for a stranger and useless to a legitimate client.
  const leaky = 'relation "public.messages" violates constraint "messages_name_length"';
  const stub = stubFetch({ status: 403, body: { message: leaky, hint: "check your policy" } });
  const handler = handlerWith(stub);

  const response = await handler(new Request("https://x.dev/api/messages"));
  const body = JSON.stringify(await response.json());

  assert.equal(response.status, 403, "the status stays honest so clients can react");
  assert.doesNotMatch(body, /messages_name_length/, "constraint names must not leak");
  assert.doesNotMatch(body, /relation/, "schema detail must not leak");
  assert.doesNotMatch(body, /policy/, "policy detail must not leak");
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
  assert.deepEqual(await response.json(), {
    status: "ok",
    platform: "vercel",
    gate: "test-gate",
    identity: ADA.label,
  });

  const messages = await handler({
    url: "/api/messages?...path=messages",
    method: "GET",
  } as unknown as Request);
  assert.equal(messages.status, 200);
});

// ---------------------------------------------------------------------------
// Gates. The guestbook runs behind Cloudflare Access or behind ATProto OAuth —
// these tests pin down what changes between them and what must not.
//
// There is deliberately no "ungated" case. `HandlerDeps.gate` is required, so
// the ungated handler these tests used to cover cannot be constructed at all;
// the check now happens at compile time, which is the only place it cannot be
// skipped in a hurry.
// ---------------------------------------------------------------------------

test("no route reaches the database without the gate's approval", async () => {
  // The gate is consulted BEFORE any method-specific work, so a refusal costs
  // nothing downstream. This is the property that makes an unauthenticated
  // flood cheap to absorb: it never becomes database load.
  const stub = stubFetch({ body: [] });
  const handler = createHandler({
    env: TEST_ENV,
    fetch: stub.fetch,
    platform: "test",
    signingKey: TEST_KEY,
    gate: gateReturning(null),
  });

  for (const request of [
    new Request("https://x.dev/api/messages"),
    new Request("https://x.dev/api/messages", { method: "POST", body: "{}" }),
    new Request("https://x.dev/api/messages", { method: "DELETE" }),
  ]) {
    assert.equal((await handler(request)).status, 401);
  }

  assert.equal(stub.calls.length, 0, "an unauthenticated caller must not reach the database");
});

test("a gate that refuses blocks reads and writes with 401", async () => {
  const stub = stubFetch({ body: [] });
  const handler = createHandler({
    env: TEST_ENV,
    fetch: stub.fetch,
    platform: "test",
    signingKey: TEST_KEY,
    gate: gateReturning(null),
  });

  const read = await handler(new Request("https://x.dev/api/messages"));
  assert.equal(read.status, 401);

  const write = await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      body: JSON.stringify({ name: "Mallory", body: "hi" }),
    }),
  );
  assert.equal(write.status, 401);

  assert.equal(stub.calls.length, 0, "an unauthenticated caller must not reach the database");
});

test("a verified identity OVERWRITES the client-supplied name", async () => {
  // The security property of the whole gate: Mallory cannot sign as Ada.
  const stub = stubFetch({ status: 201, body: [SAMPLE] });
  const handler = createHandler({
    env: TEST_ENV,
    fetch: stub.fetch,
    platform: "test",
    signingKey: TEST_KEY,
    gate: gateReturning(ADA),
  });

  const response = await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      body: JSON.stringify({ name: "Someone Else Entirely", body: "hi" }),
    }),
  );

  assert.equal(response.status, 201);
  const sent = JSON.parse(String(stub.calls[0]?.init?.body));
  assert.equal(sent.name, ADA.label, "the gate's identity must win, not the request body");
  assert.equal(sent.body, "hi");
});

test("health advertises the active gate and who you are", async () => {
  const handler = createHandler({
    env: TEST_ENV,
    fetch: stubFetch({ body: [] }).fetch,
    platform: "test",
    gate: gateReturning(ADA),
    signingKey: TEST_KEY,
  });

  const health = await handler(new Request("https://x.dev/api/health"));
  assert.equal(health.status, 200, "health must stay reachable so the UI can adapt");
  assert.deepEqual(await health.json(), {
    status: "ok",
    platform: "test",
    gate: "test-gate",
    identity: ADA.label,
  });
});

test("an over-long verified label is truncated, not rejected", async () => {
  const long = `${"a".repeat(80)}@example.com`;
  const stub = stubFetch({ status: 201, body: [SAMPLE] });
  const handler = createHandler({
    env: TEST_ENV,
    fetch: stub.fetch,
    platform: "test",
    signingKey: TEST_KEY,
    gate: gateReturning({ label: long, subject: "user-999" }),
  });

  const response = await handler(
    new Request("https://x.dev/api/messages", {
      method: "POST",
      body: JSON.stringify({ body: "hi" }),
    }),
  );

  assert.equal(response.status, 201, "a legitimate user must not be locked out by their address");
  assert.equal(JSON.parse(String(stub.calls[0]?.init?.body)).name.length, LIMITS.nameMax);
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
