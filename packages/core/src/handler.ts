/**
 * THE shared HTTP handler. This is the centrepiece of the repo.
 *
 * Written against the Web platform's `Request` -> `Response` contract, so the
 * same file backs every deployment:
 *
 *   apps/worker/src/index.ts         public guestbook          ~30 lines
 *   apps/worker-access/src/index.ts  behind Cloudflare Access  ~40 lines
 *   apps/web/api/[...path].ts        Vercel, ATProto-gated     ~100 lines
 *
 * Those line counts tell the real story, and an earlier version of this
 * comment got it wrong by claiming all hosts need "no adapter". Cloudflare
 * genuinely needs none — Workers ARE Web-standard. Vercel's Node runtime is
 * not, and that file has to convert (req, res) to Request/Response by hand.
 * See its header for why guessing cost hours.
 *
 * Everything platform-specific — where env vars come from, how identity is
 * established, how the process is started — is injected as `deps`. That is
 * what keeps this file pure, testable without a network, and unchanged whether
 * the app is public, behind an email PIN, or behind ATProto OAuth.
 */

import type { Env } from "./env.ts";
import {
  createMessage,
  listMessages,
  SupabaseError,
  type FetchLike,
  type NewMessage,
} from "./supabase.ts";

/**
 * A caller whose identity some gate has already verified.
 *
 * `label` is shown publicly as the message author (an email, an ATProto
 * handle). `subject` is the stable unique id (a DID, an Access user UUID) and
 * is never displayed — labels can change, subjects should not.
 */
export type Identity = {
  label: string;
  subject: string;
};

/**
 * An authentication strategy. The core knows nothing about how identity is
 * established — only that some gate can either produce one or refuse.
 *
 * That indirection is the entire reason one guestbook can run ungated, behind
 * Cloudflare Access, or behind ATProto OAuth without its logic changing.
 */
export type Gate = {
  /** Advertised at /api/health so the frontend can adapt to it. */
  name: string;
  resolve: (request: Request) => Promise<Identity | null>;
};

export type HandlerDeps = {
  env: Env;
  fetch: FetchLike;
  /** Which host is answering. Surfaced at /api/health so you can prove it. */
  platform: string;
  /**
   * Optional. With no gate the guestbook is public and anyone may type any
   * name. With a gate, the API demands a verified identity and messages are
   * attributed to it — a visitor cannot sign as someone else.
   */
  gate?: Gate;
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
      // Health is deliberately ungated: the frontend calls it BEFORE it knows
      // whether it is signed in, to discover which gate is active and who it
      // is talking as. It exposes no data beyond that.
      if (pathname === "/api/health" && request.method === "GET") {
        const whoami = deps.gate ? await deps.gate.resolve(request) : null;
        return json({
          status: "ok",
          platform: deps.platform,
          gate: deps.gate?.name ?? null,
          identity: whoami?.label ?? null,
        });
      }

      if (pathname === "/api/messages") {
        // Resolve identity once, before any method-specific work. If a gate is
        // configured and cannot vouch for this caller, nothing else happens.
        let identity: Identity | null = null;
        if (deps.gate) {
          identity = await deps.gate.resolve(request);
          if (!identity) {
            return json({ error: `Not authenticated (${deps.gate.name})` }, 401);
          }
        }

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

          if (identity) {
            // OVERWRITE rather than default. The client may well have sent a
            // `name`; when a gate is active that field is not theirs to choose,
            // and honouring it would let anyone sign as anyone.
            if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
              // Sliced because the column caps at nameMax and a verified email
              // or handle can be longer. Truncating a trusted label beats
              // rejecting a legitimate post.
              (payload as Record<string, unknown>).name = identity.label.slice(
                0,
                LIMITS.nameMax,
              );
            }
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
