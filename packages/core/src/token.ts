/**
 * Minting a Supabase access token for an already-verified caller.
 *
 * This is the piece that lets the DATABASE enforce attribution instead of
 * trusting this codebase to do it.
 *
 * Before: every request reached PostgREST as the `anon` role, carrying the
 * public anon key. RLS could not tell one caller from another, so the insert
 * policy had to be `with check (true)` and the handler was the only thing
 * stopping you from signing as somebody else.
 *
 * After: once a Gate has verified who you are, we mint a short-lived JWT
 * carrying that identity, and send it as the bearer token. PostgREST switches
 * to the `authenticated` role and puts our claims in `request.jwt.claims`,
 * where the policy in supabase/migrations/…_attributed_messages.sql can
 * compare them against the row being written.
 *
 * The security property that buys: forging an entry now requires the SIGNING
 * KEY, not a bearer key. The anon key has been revoked from the table entirely
 * and can no longer read or write it.
 *
 * ---------------------------------------------------------------------------
 * TWO KEYS, TWO JOBS — the thing that confuses everyone about Supabase:
 *
 *   apikey:        <anon key>    identifies the PROJECT. Supabase's gateway
 *                                needs it just to route the request.
 *   Authorization: Bearer <jwt>  decides what you may DO. This is what RLS
 *                                actually evaluates.
 *
 * They are usually the same value, which is exactly why the distinction is
 * invisible until you need it. Here they are deliberately different.
 * ---------------------------------------------------------------------------
 */

import { SignJWT, importJWK, type JWK, type KeyObject } from "jose";

import type { Identity } from "./handler.ts";

/**
 * How long a minted token lives.
 *
 * Deliberately tiny. These are created per request and used immediately for a
 * single PostgREST call — they never reach the browser and never need to
 * survive a round trip. A leaked one is worthless in a minute.
 */
const TOKEN_TTL_SECONDS = 60;

export type SigningKey = {
  /** Must match the `kid` of the key registered with the Supabase project. */
  kid: string;
  /** ES256. Supabase's current recommendation; P-256 is fast and widely supported. */
  alg: string;
  privateKey: CryptoKey | KeyObject | Uint8Array;
};

/**
 * Parse the signing key out of the environment.
 *
 * The private key is a JWK, stored as one JSON string so it survives being an
 * environment variable on every platform without newline mangling — which PEM
 * does not, and that costs an afternoon every time.
 */
export async function readSigningKey(
  source: Record<string, string | undefined>,
): Promise<SigningKey> {
  const kid = source.SUPABASE_JWT_KID?.trim();
  const raw = source.SUPABASE_JWT_PRIVATE_KEY?.trim();

  if (!kid || !raw) {
    throw new Error(
      "Missing SUPABASE_JWT_KID and/or SUPABASE_JWT_PRIVATE_KEY. Writes are " +
        "signed with a project signing key — see README, 'Database-enforced " +
        "attribution'. Never commit these.",
    );
  }

  let jwk: JWK;
  try {
    jwk = JSON.parse(raw) as JWK;
  } catch {
    throw new Error("SUPABASE_JWT_PRIVATE_KEY must be a JSON Web Key (JWK) object.");
  }

  const alg = jwk.alg ?? "ES256";
  const privateKey = await importJWK(jwk, alg);

  return { kid, alg, privateKey };
}

/**
 * Mint a token that says "this request is `identity`, admitted by `gateName`".
 *
 * Every claim here is checked by an RLS policy, so read this next to
 * supabase/migrations/…_attributed_messages.sql — the two files are one
 * mechanism split across two languages.
 */
export async function mintAccessToken(
  key: SigningKey,
  identity: Identity,
  gateName: string,
): Promise<string> {
  return new SignJWT({
    // The Postgres role to run as. `authenticated` holds exactly SELECT and
    // INSERT on public.messages after the migration — nothing more.
    role: "authenticated",
    // Custom claims. The policy compares these to the row being inserted, so a
    // caller cannot attribute a message to another subject or another gate.
    gate: gateName,
    label: identity.label,
  })
    // `kid` is how Supabase finds the right public key in its JWKS. Get it
    // wrong and every request fails as an invalid signature.
    .setProtectedHeader({ alg: key.alg, kid: key.kid, typ: "JWT" })
    // NOTE: `sub` stays a plain string. It holds an ATProto DID or a
    // Cloudflare Access user id, neither of which is a UUID — which is why the
    // policy reads `auth.jwt() ->> 'sub'` and never `auth.uid()`. auth.uid()
    // casts to uuid and would raise `invalid input syntax for type uuid`.
    .setSubject(identity.subject)
    .setAudience("authenticated")
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .sign(key.privateKey);
}
