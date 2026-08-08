/**
 * THE shared HTTP handler. This is the centrepiece of the repo.
 *
 * It is written against the Web platform's `Request` -> `Response` contract,
 * which both Vercel Functions and Cloudflare Workers speak natively. That is
 * why the very same file runs on both hosts with no adapter, no shim and no
 * framework — see apps/api-vercel and apps/worker, which are ~10 lines each.
 *
 * Everything platform-specific (where env vars come from, how the process is
 * started) is injected as `deps`. That keeps this file pure and, as a happy
 * side effect, trivially testable without a network or a mocking library.
 */

import type { Env } from "./env.ts";
import {
  createMessage,
  listMessages,
  SupabaseError,
  type FetchLike,
  type NewMessage,
} from "./supabase.ts";

export type HandlerDeps = {
  env: Env;
  fetch: FetchLike;
  /** Which host is answering. Surfaced at /api/health so you can prove it. */
  platform: string;
};

export const LIMITS = {
  nameMax: 50,
  bodyMax: 500,
} as const;

const CORS_HEADERS: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "content-type",
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...CORS_HEADERS,
    },
  });
}

export type ValidationResult =
  | { ok: true; value: NewMessage }
  | { ok: false; error: string };

/**
 * Validate untrusted JSON from the browser.
 *
 * Note this is defence in depth, not the only defence: the database has CHECK
 * constraints saying the same thing. Never trust the client, and don't rely on
 * a single layer to enforce a rule.
 */
export function validateNewMessage(input: unknown): ValidationResult {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Expected a JSON object" };
  }

  const { name, body } = input as Record<string, unknown>;

  if (typeof name !== "string" || typeof body !== "string") {
    return { ok: false, error: "Both 'name' and 'body' must be strings" };
  }

  const trimmedName = name.trim();
  const trimmedBody = body.trim();

  if (trimmedName.length === 0) return { ok: false, error: "'name' is required" };
  if (trimmedBody.length === 0) return { ok: false, error: "'body' is required" };

  if (trimmedName.length > LIMITS.nameMax) {
    return { ok: false, error: `'name' must be at most ${LIMITS.nameMax} characters` };
  }
  if (trimmedBody.length > LIMITS.bodyMax) {
    return { ok: false, error: `'body' must be at most ${LIMITS.bodyMax} characters` };
  }

  return { ok: true, value: { name: trimmedName, body: trimmedBody } };
}

/**
 * Build the request handler. Returns a plain function, so hosting it is just
 * `export default { fetch: handler }` (Cloudflare) or
 * `export default handler` (Vercel).
 */
export function createHandler(deps: HandlerDeps) {
  return async function handler(request: Request): Promise<Response> {
    // The one genuine incompatibility found between the two hosts:
    //
    //   Cloudflare -> request.url is ABSOLUTE  ("https://host/api/health")
    //   Vercel     -> request.url is a PATH    ("/api/health?...path=health")
    //
    // `new URL("/api/health")` throws ERR_INVALID_URL, which took down every
    // Vercel request until this base was added. When the input is already
    // absolute the base is ignored, so this is correct on both platforms.
    // The host below is a placeholder and is never used for routing.
    const { pathname } = new URL(request.url, "http://playstack.invalid");

    // Browser preflight for cross-origin POSTs.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      if (pathname === "/api/health" && request.method === "GET") {
        return json({ status: "ok", platform: deps.platform });
      }

      if (pathname === "/api/messages") {
        if (request.method === "GET") {
          const messages = await listMessages(deps.env, deps.fetch);
          return json({ messages });
        }

        if (request.method === "POST") {
          let payload: unknown;
          try {
            payload = await request.json();
          } catch {
            return json({ error: "Request body must be valid JSON" }, 400);
          }

          const result = validateNewMessage(payload);
          if (!result.ok) {
            return json({ error: result.error }, 400);
          }

          const message = await createMessage(deps.env, deps.fetch, result.value);
          return json({ message }, 201);
        }

        return json({ error: `Method ${request.method} not allowed` }, 405);
      }

      return json({ error: `No route for ${request.method} ${pathname}` }, 404);
    } catch (error) {
      // Surface Supabase's own status (e.g. RLS rejection -> 401) rather than
      // flattening every failure into an opaque 500.
      if (error instanceof SupabaseError) {
        return json({ error: error.message }, error.status);
      }
      const message = error instanceof Error ? error.message : "Unknown error";
      return json({ error: message }, 500);
    }
  };
}
