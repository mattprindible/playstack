/**
 * THE shared HTTP handler. This is the centrepiece of the repo.
 *
 * Written against the Web platform's `Request` -> `Response` contract, so the
 * same file backs every deployment:
 *
 *   apps/worker-access/src/index.ts  behind Cloudflare Access  ~40 lines
 *   apps/web/api/[...path].ts        Vercel, ATProto-gated     ~100 lines
 *
 * Those line counts tell the real story, and an earlier version of this
 * comment got it wrong by claiming all hosts need "no adapter". Cloudflare
 * genuinely needs none — Workers ARE Web-standard. Vercel's Node runtime is
 * not, and that file has to convert (req, res) to Request/Response by hand.
 * See its header for why guessing cost hours.
 *
 * There used to be a third deployment: an ungated Worker, the original
 * "just get something end to end" prototype. It was deleted, and the reason
 * is worth keeping. It shared one Supabase table with the two gated apps, and
 * the row-level policy said `insert to anon with check (true)` — so anyone on
 * the internet could POST to the open Worker claiming any name they liked, and
 * that entry appeared in the gated guestbooks indistinguishable from a
 * verified one. Two carefully-built gates, undone by a third door into the
 * same room.
 *
 * The lesson generalises, and it is the reason `gate` below is not optional:
 * authenticating at the edge controls who reaches your code. It controls
 * nothing about your database unless the database is told.
 *
 * Everything platform-specific — where env vars come from, how identity is
 * established, how the process is started — is injected as `deps`. That is
 * what keeps this file pure, testable without a network, and unchanged whether
 * the app is public, behind an email PIN, or behind ATProto OAuth.
 */

import type { Env } from "./env.ts";
import {
  createMessage,
  deleteMessage,
  listMessages,
  SupabaseError,
  updateMessage,
  type FetchLike,
  type NewMessage,
} from "./supabase.ts";
import { mintAccessToken, type SigningKey } from "./token.ts";

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
 * That indirection is the entire reason one guestbook can run behind
 * Cloudflare Access or behind ATProto OAuth without its logic changing.
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
   * REQUIRED, and that is the point.
   *
   * This was `gate?: Gate` while an ungated prototype still existed. Making it
   * mandatory means an ungated deployment is no longer something you can
   * forget to configure — it is something the compiler refuses to let you
   * write. A convention holds until someone is in a hurry; a type holds.
   *
   * The API demands a verified identity, and messages are attributed to it, so
   * a visitor cannot sign as someone else.
   */
  gate: Gate;
  /**
   * Signs the short-lived token each request carries to PostgREST.
   *
   * This is what moves attribution from "the handler promises to set the right
   * name" to "the database refuses anything else". See token.ts and
   * supabase/migrations/…_attributed_messages.sql.
   */
  signingKey: SigningKey;
};

export const LIMITS = {
  nameMax: 50,
  bodyMax: 500,
} as const;

/**
 * NO CORS HEADERS, deliberately.
 *
 * This used to send `access-control-allow-origin: *`. That was safe as written
 * — a wildcard origin cannot be combined with credentials, so browsers refuse
 * to attach cookies cross-origin — but it bought nothing, because every
 * deployment serves its own frontend from its own origin.
 *
 * What it did do was sit one line away from a CSRF hole. The day somebody adds
 * `access-control-allow-credentials: true` to "fix" a cross-origin call, any
 * website on the internet can drive this API as your logged-in friend. A
 * permission you never granted cannot be widened by accident.
 *
 * If you genuinely need a cross-origin caller later, add an explicit allow-list
 * of origins — never the wildcard alongside credentials.
 */
function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

/**
 * What the caller is told when something breaks.
 *
 * The detail goes to the logs; the browser gets the status and a fixed string.
 * PostgREST's errors name tables, columns and constraints, and `SupabaseError`
 * used to carry 300 characters of that straight through to whoever asked. That
 * is free reconnaissance, and it helps a stranger far more than a user.
 *
 * The status is still honest — an RLS refusal stays a 403, a bad request stays
 * a 400 — because the status is what a legitimate client needs to react.
 */
function failure(status: number, detail: unknown): Response {
  console.error("request failed", { status, detail });

  const message =
    status === 401 || status === 403
      ? "Not authorised"
      : status >= 500
        ? "Something went wrong on our end"
        : "Request could not be completed";

  return json({ error: message }, status);
}

export type ValidationResult =
  | { ok: true; value: NewMessage }
  | { ok: false; error: string };

export type BodyValidationResult =
  | { ok: true; value: string }
  | { ok: false; error: string };

/**
 * Validate the one field a visitor actually controls.
 *
 * Shared by the create and edit paths so the two cannot drift. An edit that
 * accepted a 900-character body because only the insert path checked would be
 * caught by the CHECK constraint on the table — as a 400 from PostgREST naming
 * a constraint, rather than a sentence explaining what to fix.
 */
export function validateBody(input: unknown): BodyValidationResult {
  if (typeof input !== "string") {
    return { ok: false, error: "'body' must be a string" };
  }

  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "'body' is required" };
  if (trimmed.length > LIMITS.bodyMax) {
    return { ok: false, error: `'body' must be at most ${LIMITS.bodyMax} characters` };
  }

  return { ok: true, value: trimmed };
}

/**
 * Pull the id out of `/api/messages/123`, or null if this is not that route.
 *
 * The regex only accepts digits, so nothing else can reach the `eq.` filter
 * downstream. That is belt-and-braces rather than the actual defence — the id
 * travels as a URLSearchParams value and PostgREST parameterises it — but a
 * route that structurally cannot carry anything but a number is one fewer
 * thing to reason about.
 */
export function matchMessageId(pathname: string): number | null {
  const match = /^\/api\/messages\/(\d+)$/.exec(pathname);
  if (!match) return null;

  const id = Number(match[1]);
  return Number.isSafeInteger(id) ? id : null;
}

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

    // Same-origin only, so there is no preflight to answer — just advertise
    // what this endpoint accepts.
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { allow: "GET,POST,PATCH,DELETE,OPTIONS" },
      });
    }

    try {
      // Health is deliberately ungated: the frontend calls it BEFORE it knows
      // whether it is signed in, to discover which gate is active and who it
      // is talking as. It exposes no data beyond that.
      if (pathname === "/api/health" && request.method === "GET") {
        const whoami = await deps.gate.resolve(request);
        return json({
          status: "ok",
          platform: deps.platform,
          gate: deps.gate.name,
          identity: whoami?.label ?? null,
        });
      }

      // `/api/messages` is the collection; `/api/messages/123` is one entry.
      // Both need the same verified caller and the same minted token, so they
      // share a branch rather than duplicating the gate.
      const messageId = matchMessageId(pathname);

      if (pathname === "/api/messages" || messageId !== null) {
        // Resolve identity once, before any method-specific work. If the gate
        // cannot vouch for this caller, nothing else happens — no read, no
        // write, no database call at all.
        const identity = await deps.gate.resolve(request);
        if (!identity) {
          return json({ error: `Not authenticated (${deps.gate.name})` }, 401);
        }

        // Mint once, use for every method. The anon key can no longer touch
        // this table, so even a GET now requires a verified caller.
        const accessToken = await mintAccessToken(
          deps.signingKey,
          identity,
          deps.gate.name,
        );

        // -------------------------------------------------------------------
        // One entry: PATCH and DELETE.
        //
        // Note what is NOT here: any check that the entry belongs to the
        // caller. It would be redundant. The token carries the subject, the
        // policies compare it to the row, and a mismatch means the statement
        // matches nothing. Writing the check here as well would create a
        // second place for the rule to live and a second place for it to rot —
        // and it is the weaker of the two, because it only guards this code
        // path while the policy guards the table.
        // -------------------------------------------------------------------
        if (messageId !== null) {
          if (request.method === "PATCH") {
            let payload: unknown;
            try {
              payload = await request.json();
            } catch {
              return json({ error: "Request body must be valid JSON" }, 400);
            }

            if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
              return json({ error: "Expected a JSON object" }, 400);
            }

            // Only `body` is read. The POST path has to defensively overwrite
            // `name`; here there is nothing to overwrite, because an edit
            // structurally cannot change attribution — the trigger pins those
            // columns whatever this code sends.
            const result = validateBody((payload as Record<string, unknown>).body);
            if (!result.ok) {
              return json({ error: result.error }, 400);
            }

            const message = await updateMessage(
              deps.env,
              deps.fetch,
              accessToken,
              messageId,
              result.value,
            );

            // Null means the statement matched no row — someone else's entry,
            // or none at all. Those two cases are deliberately given the SAME
            // answer: telling a stranger that entry 41 exists but is not
            // theirs is a fact they have not earned, and it is exactly how you
            // enumerate a table you cannot read.
            if (!message) {
              return json({ error: "No such entry, or it is not yours" }, 404);
            }

            return json({ message: { ...message, mine: true } });
          }

          if (request.method === "DELETE") {
            const removed = await deleteMessage(
              deps.env,
              deps.fetch,
              accessToken,
              messageId,
            );

            if (!removed) {
              return json({ error: "No such entry, or it is not yours" }, 404);
            }

            return json({ ok: true });
          }

          return json({ error: `Method ${request.method} not allowed` }, 405);
        }

        if (request.method === "GET") {
          // The subject decides which entries come back flagged `mine`. It is
          // used for the comparison and then dropped — see listMessages.
          const messages = await listMessages(
            deps.env,
            deps.fetch,
            accessToken,
            identity.subject,
          );
          return json({ messages });
        }

        if (request.method === "POST") {
          let payload: unknown;
          try {
            payload = await request.json();
          } catch {
            return json({ error: "Request body must be valid JSON" }, 400);
          }

          // OVERWRITE rather than default. The client may well have sent a
          // `name`; it is not theirs to choose, and honouring it would let
          // anyone sign as anyone.
          //
          // This is now belt AND braces: the RLS policy independently requires
          // `name = left(auth.jwt() ->> 'label', 50)`, so a bug here produces a
          // rejected insert rather than a forged signature. That is the whole
          // point of the migration — this line stopped being load-bearing.
          if (typeof payload === "object" && payload !== null && !Array.isArray(payload)) {
            // Sliced because the column caps at nameMax and a verified email
            // or handle can be longer. Truncating a trusted label beats
            // rejecting a legitimate post. Must match the policy's
            // `left(..., 50)` exactly, or every insert is refused.
            (payload as Record<string, unknown>).name = identity.label.slice(
              0,
              LIMITS.nameMax,
            );
          }

          const result = validateNewMessage(payload);
          if (!result.ok) {
            return json({ error: result.error }, 400);
          }

          const message = await createMessage(deps.env, deps.fetch, accessToken, {
            ...result.value,
            subject: identity.subject,
            gate: deps.gate.name,
          });
          // An entry you just wrote is definitionally yours, so the flag is a
          // constant rather than a comparison — but it is still sent, because
          // the frontend renders a created entry with the same code that
          // renders a listed one.
          return json({ message: { ...message, mine: true } }, 201);
        }

        return json({ error: `Method ${request.method} not allowed` }, 405);
      }

      return json({ error: `No route for ${request.method} ${pathname}` }, 404);
    } catch (error) {
      // Surface Supabase's own STATUS (e.g. an RLS rejection stays a 403)
      // rather than flattening everything into an opaque 500 — but never its
      // message, which names tables and constraints. See failure().
      if (error instanceof SupabaseError) {
        return failure(error.status, error.message);
      }
      return failure(500, error);
    }
  };
}
