/**
 * The ATProto OAuth client.
 *
 * This is THE reason prototype B keeps a Node runtime around. The official
 * `@atproto/oauth-client-node` does not run on Cloudflare Workers — see
 * https://github.com/bluesky-social/atproto/issues/3292, still open. The
 * blockers are individually small (Workers lack `cache: 'no-cache'` and
 * `redirect: 'error'`, and there is no DNS for handle resolution) but they sit
 * inside the library, and patching around someone else's auth internals is a
 * bad trade when a supported path exists.
 *
 * So: the OAuth handshake happens here, on Vercel, using official code. The
 * Worker remains the app. That is the honest answer to "can I collapse
 * everything onto Cloudflare?" — mostly yes, and this is the exception.
 */

import { NodeOAuthClient, type NodeOAuthClientOptions } from "@atproto/oauth-client-node";

import { sessionStore, stateStore } from "./store.ts";

/**
 * The public origin this app is served from.
 *
 * OAuth is strict about this: `client_id` must be a URL that actually serves
 * the client metadata, and every redirect URI must be listed inside it. A
 * mismatch fails at the authorization server with a message that rarely points
 * at the real problem, so we derive all of it from one value.
 */
export function publicOrigin(): string {
  const explicit = process.env.PUBLIC_ORIGIN?.trim().replace(/\/+$/, "");
  if (explicit) return explicit;

  // Vercel injects the deployment host, but that is the per-deployment URL
  // (playstack-<hash>.vercel.app) which changes every push and would break the
  // registered client_id. PUBLIC_ORIGIN should be set to the stable alias.
  const vercelHost = process.env.VERCEL_PROJECT_PRODUCTION_URL?.trim();
  if (vercelHost) return `https://${vercelHost}`;

  throw new Error("Set PUBLIC_ORIGIN to the stable public origin of this deployment.");
}

/**
 * client_id must be an HTTPS URL that actually serves this app's metadata.
 * It does not have to sit at the root — pointing it at the Function that
 * generates the document keeps origin, redirect URI and metadata derived from
 * a single source, with no static file to drift out of sync.
 */
export function clientMetadataUrl(): string {
  return `${publicOrigin()}/api/atproto/client-metadata`;
}

export function redirectUri(): string {
  return `${publicOrigin()}/api/atproto/callback`;
}

/**
 * Client metadata, served publicly so the user's PDS can fetch it.
 *
 * We are an "unauthenticated public client": no client secret, because a
 * browser-facing app has nowhere to keep one. Security comes from the
 * redirect URI being registered here and from DPoP proof-of-possession, not
 * from a shared secret.
 */
export function clientMetadata() {
  return {
    client_id: clientMetadataUrl(),
    client_name: "Playstack Guestbook",
    client_uri: publicOrigin(),
    redirect_uris: [redirectUri()],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    scope: "atproto transition:generic",
    token_endpoint_auth_method: "none",
    application_type: "web",
    dpop_bound_access_tokens: true,
  } satisfies NodeOAuthClientOptions["clientMetadata"];
}

let cached: NodeOAuthClient | null = null;

export function getOAuthClient(): NodeOAuthClient {
  // Reused across invocations on a warm Fluid Compute instance. Building it is
  // cheap, but the client also caches handle/DID resolution internally, which
  // is worth keeping.
  if (cached) return cached;

  cached = new NodeOAuthClient({
    clientMetadata: clientMetadata(),
    stateStore,
    sessionStore,
  });

  return cached;
}
