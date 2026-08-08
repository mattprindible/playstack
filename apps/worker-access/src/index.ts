/**
 * Prototype A: the guestbook behind Cloudflare Access (email allow-list + PIN).
 *
 * The interesting claim this file tests: for a small, known group of people,
 * the best authentication code is *no authentication code*. There is no signup
 * form here, no password, no session table, no password-reset email, no JWT
 * refresh loop. You list your friends' email addresses in an Access policy and
 * Cloudflare does the rest at the edge, before this Worker is even invoked.
 *
 * What remains is the ~40 lines below, and they are pure verification.
 *
 * ---------------------------------------------------------------------------
 * WHY VERIFY AT ALL, IF ACCESS ALREADY BLOCKED THE REQUEST?
 *
 * Two reasons, and both are real:
 *
 * 1. Access enforces on a HOSTNAME. If this Worker is ever reachable by
 *    another route — a *.workers.dev URL (see workers_dev: false in
 *    wrangler.jsonc), a preview alias, a second custom domain — then Access
 *    never ran. Verifying here means the Worker is safe on its own merits
 *    rather than safe because of configuration somewhere else.
 *
 * 2. We need to know WHO the caller is, not merely that somebody let them
 *    through. The email claim is what signs the guestbook entry.
 *
 * The rule of thumb: a gate you did not verify is a gate somebody can walk
 * around. Defence in depth is cheap here, so take it.
 * ---------------------------------------------------------------------------
 */

import { createRemoteJWKSet, jwtVerify } from "jose";

import { createHandler, readEnv, readSigningKey, type Gate, type Identity } from "@playstack/core";

type WorkerEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** Signs the per-caller token PostgREST evaluates. See packages/core/src/token.ts. */
  SUPABASE_JWT_KID?: string;
  SUPABASE_JWT_PRIVATE_KEY?: string;
  /** Your Zero Trust team name, e.g. "mattprindible" => mattprindible.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. Pins the token to THIS app. */
  ACCESS_AUD?: string;
  /** Configured in wrangler.jsonc. Absent under `wrangler dev` on old versions. */
  API_RATE_LIMITER?: { limit: (options: { key: string }) => Promise<{ success: boolean }> };
  /** The static frontend. `run_worker_first` routes everything here first. */
  ASSETS: { fetch: (request: Request) => Promise<Response> };
};

/**
 * Security headers, applied to EVERY response this Worker returns.
 *
 * The Vercel deployment gets the equivalent from apps/web/vercel.json. Keeping
 * the two in step by hand is the honest cost of serving one frontend from two
 * platforms — and for a while nobody was paying it: vercel.json set headers and
 * the Cloudflare side set none at all. Same app, same code, two different
 * security postures, and no way to notice by looking at either site.
 *
 * The CSP is strict because this app earns it: no inline scripts, no inline
 * styles, no external anything. `data:` for images is the one exception, which
 * the emoji favicon in index.html needs.
 */
const SECURITY_HEADERS: Record<string, string> = {
  "content-security-policy":
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; " +
    "connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "geolocation=(), microphone=(), camera=(), payment=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
};

function secured(response: Response): Response {
  // Response headers are immutable once constructed, so clone to modify.
  const out = new Response(response.body, response);
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) {
    out.headers.set(key, value);
  }
  return out;
}

/**
 * JWKS fetching is cached across requests within an isolate. Rebuilding it per
 * request would hammer Cloudflare's certs endpoint and add latency to every
 * call, so we memoise per team domain.
 */
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(teamDomain: string) {
  let jwks = jwksCache.get(teamDomain);
  if (!jwks) {
    jwks = createRemoteJWKSet(
      new URL(`https://${teamDomain}.cloudflareaccess.com/cdn-cgi/access/certs`),
    );
    jwksCache.set(teamDomain, jwks);
  }
  return jwks;
}

/**
 * Build the Access gate.
 *
 * Returns null for ANY failure — missing token, bad signature, wrong audience,
 * expired. The caller turns that into a 401. We deliberately do not explain
 * which check failed: that detail helps an attacker far more than a user.
 */
function createAccessGate(teamDomain: string, aud: string): Gate {
  return {
    name: "cloudflare-access",

    async resolve(request: Request): Promise<Identity | null> {
      // Access presents the token as a header on every proxied request, and
      // also as a cookie so a browser navigation carries it.
      const token =
        request.headers.get("Cf-Access-Jwt-Assertion") ??
        readCookie(request, "CF_Authorization");

      if (!token) return null;

      try {
        const { payload } = await jwtVerify(token, getJwks(teamDomain), {
          // Pins the token to this team...
          issuer: `https://${teamDomain}.cloudflareaccess.com`,
          // ...and to THIS application. Without the audience check, a valid
          // token minted for any other app in your account would be accepted
          // here. This single line is what stops that.
          audience: aud,
        });

        const email = typeof payload.email === "string" ? payload.email : null;
        const subject = typeof payload.sub === "string" ? payload.sub : null;
        if (!email || !subject) return null;

        return { label: email, subject };
      } catch {
        return null;
      }
    },
  };
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;

  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

function configError(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 503,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    const teamDomain = env.ACCESS_TEAM_DOMAIN?.trim();
    const aud = env.ACCESS_AUD?.trim();

    // FAIL CLOSED. If the gate is not configured we refuse everything rather
    // than quietly serving an ungated guestbook. An app that silently loses
    // its authentication is far worse than one that is visibly broken.
    if (!teamDomain || !aud || teamDomain === "REPLACE_ME" || aud === "REPLACE_ME") {
      return secured(
        configError(
          "Access gate not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD. " +
            "Refusing to serve ungated.",
        ),
      );
    }

    // Rate limit before doing any work, keyed on the caller's IP.
    //
    // Access sits in front of this, so a stranger never gets here — this is the
    // backstop for a signed-in friend's runaway script, and for the case where
    // some future route is reachable without Access. Only /api/* is limited:
    // rate-limiting the stylesheet would just break the page under load.
    const url = new URL(request.url);
    if (env.API_RATE_LIMITER && url.pathname.startsWith("/api/")) {
      const ip = request.headers.get("CF-Connecting-IP") ?? "unknown";
      const { success } = await env.API_RATE_LIMITER.limit({ key: ip });
      if (!success) {
        return secured(
          new Response(JSON.stringify({ error: "Too many requests" }), {
            status: 429,
            headers: {
              "content-type": "application/json; charset=utf-8",
              // Tell a well-behaved client when to come back rather than making
              // it guess. `period` in wrangler.jsonc is 60s.
              "retry-after": "60",
            },
          }),
        );
      }
    }

    // Everything that is not the API is the static frontend. `run_worker_first`
    // means those requests arrive here rather than being served behind our
    // back, which is the only way they can pick up the security headers.
    if (!url.pathname.startsWith("/api/")) {
      return secured(await env.ASSETS.fetch(request));
    }

    // Only the string-valued configuration, passed explicitly. `env` also
    // carries the rate limiter BINDING, which is an object — handing the whole
    // bag to a function expecting `Record<string, string>` stops type-checking
    // the moment a non-string binding is added, which is exactly what happened.
    const config = {
      SUPABASE_URL: env.SUPABASE_URL,
      SUPABASE_ANON_KEY: env.SUPABASE_ANON_KEY,
      SUPABASE_JWT_KID: env.SUPABASE_JWT_KID,
      SUPABASE_JWT_PRIVATE_KEY: env.SUPABASE_JWT_PRIVATE_KEY,
    };

    let handler: (request: Request) => Promise<Response>;
    try {
      handler = createHandler({
        env: readEnv(config),
        fetch: globalThis.fetch,
        platform: "cloudflare-access",
        gate: createAccessGate(teamDomain, aud),
        signingKey: await readSigningKey(config),
      });
    } catch (error) {
      return secured(
        configError(error instanceof Error ? error.message : "Worker is misconfigured"),
      );
    }

    return secured(await handler(request));
  },
};
