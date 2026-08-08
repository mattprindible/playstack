/**
 * The Vercel half of the deploy story.
 *
 * `[...path].ts` is Vercel's file-based catch-all: every request under /api/*
 * lands here, keeping routing in our shared handler rather than in filenames.
 *
 * This file is longer than its Cloudflare counterpart, and the reason is the
 * single most useful thing this repo has to teach about the two platforms:
 *
 *   Cloudflare Workers are Web-standard NATIVELY. `fetch(request, env)` hands
 *   you a real `Request` and takes a real `Response` back.
 *   apps/worker-access/src/index.ts needs no adapter at all.
 *
 *   Vercel Functions on the Node runtime use Node's classic (req, res) pair.
 *   Vercel can serve Web-standard handlers too, but it decides which style you
 *   wrote by inspecting the export — and a closure it cannot inspect is
 *   assumed to be Node-style. Hand it one anyway and it passes an
 *   IncomingMessage (whose `.url` is a bare path, not a URL) and then waits
 *   forever for a `res.end()` that never comes. The symptom is not an error;
 *   it is a request that hangs until the 300-second timeout. That cost real
 *   debugging time, so we do the conversion explicitly below rather than
 *   relying on detection.
 *
 * The business logic still lives in exactly one place. This is glue, and glue
 * you can read beats magic you cannot.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

// NOTE: imported by relative path, while apps/worker-access/src/index.ts
// imports it as the workspace package "@playstack/core". That asymmetry works
// around a real Vercel limitation: pnpm links a workspace dependency as a
// symlink pointing outside the consuming package, and Vercel's builder records
// that symlink in the function's `filePathMap` without ever uploading it. The
// deploy then fails with "File does not exist:
// apps/web/node_modules/@playstack/core" even though the bundle already holds
// every compiled file. A relative path sidesteps node resolution entirely.
import {
  createHandler,
  readEnv,
  readSigningKey,
  type Gate,
} from "../../../packages/core/src/index.ts";
import { verifySessionCookie } from "../lib/atproto/session.ts";

/**
 * The ATProto gate — prototype B.
 *
 * Note how little happens here: verify our own signed cookie, read the DID and
 * handle out of it, done. No token refresh, no PDS call, no database. The
 * expensive parts of ATProto auth all happened once at /api/atproto/callback.
 */
function atprotoGate(): Gate {
  // FAIL CLOSED, matching apps/worker-access.
  //
  // This used to read `if (ATPROTO_GATE !== "on") return undefined`, and an
  // undefined gate meant the deployment quietly served an ungated guestbook.
  // That is the worst possible default: unsetting one environment variable
  // silently removed all authentication, and nothing in the response said so.
  // Now a missing flag is a configuration error that stops the deploy dead.
  if (process.env.ATPROTO_GATE?.trim() !== "on") {
    throw new Error(
      "ATPROTO_GATE must be 'on'. This deployment has no ungated mode — " +
        "refusing to serve rather than silently dropping authentication.",
    );
  }

  return {
    name: "atproto",
    async resolve(request: Request) {
      const session = await verifySessionCookie(request.headers.get("cookie"));
      if (!session) return null;

      // The handle is what gets shown; the DID is the stable identity, so a
      // rename never turns a visitor into a different person.
      return { label: session.handle, subject: session.did };
    },
  };
}

// Read config once, at module load. If a variable is missing we throw during
// cold start and the logs name it — far better than a mystery 401 from
// PostgREST on every request.
//
// On Vercel, configuration arrives as ambient `process.env`. On Cloudflare it
// is passed into fetch(). That difference is the entire reason readEnv exists.
// Top-level await: readSigningKey imports the JWK, which is async. Doing it
// once at module load keeps it off the request path, and a bad key fails the
// cold start loudly instead of 500ing every insert later.
const handler = createHandler({
  env: readEnv(process.env),
  fetch: globalThis.fetch,
  platform: "vercel (atproto)",
  gate: atprotoGate(),
  signingKey: await readSigningKey(process.env),
});

/** Headers Node manages itself; forwarding them corrupts the Request. */
const HOP_BY_HOP = new Set(["connection", "content-length", "transfer-encoding"]);

function toWebRequest(req: IncomingMessage, body: string | undefined): Request {
  // req.url is a PATH ("/api/health?...path=health"), so `new URL` needs a base.
  const proto = (req.headers["x-forwarded-proto"] as string | undefined) ?? "https";
  const host = req.headers.host ?? "playstack.invalid";
  const url = new URL(req.url ?? "/", `${proto}://${host}`);

  // Vercel appends its catch-all segment as a query param. It is an artefact of
  // routing, not part of the request the handler should reason about.
  url.searchParams.delete("...path");

  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (value === undefined || HOP_BY_HOP.has(key.toLowerCase())) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(key, item);
    } else {
      headers.set(key, value);
    }
  }

  return new Request(url, { method: req.method ?? "GET", headers, body });
}

async function readBody(req: IncomingMessage): Promise<string | undefined> {
  if (req.method === "GET" || req.method === "HEAD") return undefined;

  // Vercel's `shouldAddHelpers` may have already parsed and consumed the
  // stream, in which case the stream yields nothing and only req.body has it.
  const parsed = (req as IncomingMessage & { body?: unknown }).body;
  if (parsed !== undefined && parsed !== null && parsed !== "") {
    return typeof parsed === "string" ? parsed : JSON.stringify(parsed);
  }

  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer));
  }
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
}

export default async function vercelHandler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const response = await handler(toWebRequest(req, await readBody(req)));

  res.statusCode = response.status;
  response.headers.forEach((value, key) => res.setHeader(key, value));

  // Buffer rather than stream: these payloads are small, and res.end() is what
  // finally tells Vercel the invocation is over.
  res.end(Buffer.from(await response.arrayBuffer()));
}
