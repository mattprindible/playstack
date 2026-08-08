/**
 * The app's own session cookie.
 *
 * Deliberately NOT the ATProto session. Two different things:
 *
 *   ATProto session  = access/refresh tokens + DPoP key. Sensitive. Lives in
 *                      Supabase behind service_role. Never leaves the server.
 *
 *   App session      = "this browser is did:plc:xyz". A signed JWT in an
 *                      httpOnly cookie. Carries no secrets, only a claim.
 *
 * Keeping them separate is what lets a Cloudflare Worker authenticate a user
 * without ever touching a refresh token: it verifies this JWT with a shared
 * secret and learns the DID. Exactly the same shape as the Cloudflare Access
 * gate in apps/worker-access — verify a token, trust nothing else.
 */

import { SignJWT, jwtVerify } from "jose";

const COOKIE_NAME = "playstack_session";
const ISSUER = "playstack";
const MAX_AGE_SECONDS = 60 * 60 * 24 * 7; // 7 days

/**
 * Binds the cookie to THIS deployment.
 *
 * Without an audience, the issuer is the constant "playstack", so the moment
 * you copy this file into another project and reuse a SESSION_SECRET, cookies
 * mint in one app and verify in the other. Deriving the audience from
 * PUBLIC_ORIGIN makes that impossible without anyone having to remember.
 *
 * Same reasoning as the ACCESS_AUD check in apps/worker-access: a signature
 * proves who made the token, never who it was made FOR.
 */
function audience(): string {
  return process.env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "") || "playstack-local";
}

export type AppSession = {
  did: string;
  handle: string;
};

function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET?.trim();
  if (!value || value.length < 32) {
    throw new Error(
      "SESSION_SECRET must be set and at least 32 characters. " +
        "Generate one with: openssl rand -hex 32",
    );
  }
  return new TextEncoder().encode(value);
}

export async function createSessionCookie(session: AppSession): Promise<string> {
  const token = await new SignJWT({ handle: session.handle })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(audience())
    .setSubject(session.did) // DID is the identity; the handle can change
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_SECONDS}s`)
    .sign(secret());

  // httpOnly  -> JavaScript cannot read it, so an XSS bug cannot steal it
  // SameSite=Lax -> not sent on cross-site POSTs, blunting CSRF
  // Secure    -> HTTPS only
  return [
    `${COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Lax",
    `Max-Age=${MAX_AGE_SECONDS}`,
  ].join("; ");
}

export function clearSessionCookie(): string {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export function readCookie(cookieHeader: string | null, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=") || null;
  }
  return null;
}

/** Returns null for any failure. Callers turn that into a 401. */
export async function verifySessionCookie(
  cookieHeader: string | null,
): Promise<AppSession | null> {
  const token = readCookie(cookieHeader, COOKIE_NAME);
  if (!token) return null;

  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: ISSUER,
      audience: audience(),
    });
    const did = payload.sub;
    const handle = payload.handle;

    if (typeof did !== "string" || typeof handle !== "string") return null;
    return { did, handle };
  } catch {
    return null;
  }
}

export { COOKIE_NAME };
