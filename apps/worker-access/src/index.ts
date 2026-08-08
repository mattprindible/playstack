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

import { createHandler, readEnv, type Gate, type Identity } from "@playstack/core";

type WorkerEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
  /** Your Zero Trust team name, e.g. "mattprindible" => mattprindible.cloudflareaccess.com */
  ACCESS_TEAM_DOMAIN?: string;
  /** The Access application's AUD tag. Pins the token to THIS app. */
  ACCESS_AUD?: string;
};

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
      return configError(
        "Access gate not configured: set ACCESS_TEAM_DOMAIN and ACCESS_AUD. " +
          "Refusing to serve ungated.",
      );
    }

    let handler: (request: Request) => Promise<Response>;
    try {
      handler = createHandler({
        env: readEnv(env),
        fetch: globalThis.fetch,
        platform: "cloudflare-access",
        gate: createAccessGate(teamDomain, aud),
      });
    } catch (error) {
      return configError(
        error instanceof Error ? error.message : "Worker is misconfigured",
      );
    }

    return handler(request);
  },
};
