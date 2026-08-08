/**
 * Step 2 of ATProto login: the PDS sends the user back here with a code.
 *
 * `callback()` verifies the state we stored, exchanges the code for tokens
 * using the DPoP key it generated earlier, and persists the ATProto session.
 * Those tokens stay server-side forever — the browser receives only our own
 * signed cookie saying "you are did:plc:…".
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Agent } from "@atproto/api";

import { getOAuthClient } from "../../lib/atproto/client.ts";
import { createSessionCookie } from "../../lib/atproto/session.ts";

function fail(res: ServerResponse, status: number, message: string): void {
  res.statusCode = status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify({ error: message }));
}

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");

  // The PDS reports user-facing failures (denied consent, expired request)
  // here rather than by throwing, so check before doing any work.
  const oauthError = url.searchParams.get("error");
  if (oauthError) {
    return fail(
      res,
      400,
      `Login was not completed: ${url.searchParams.get("error_description") ?? oauthError}`,
    );
  }

  try {
    const { session } = await getOAuthClient().callback(url.searchParams);

    // The DID is the durable identity. The handle is a display name that can
    // be reassigned, so we fetch it for presentation but never trust it as an
    // identifier — note the cookie's subject is the DID.
    // Explicitly `string`: session.did is a `did:plc:…` template literal type,
    // and we are about to replace it with a free-form handle.
    let handle: string = session.did;
    try {
      const agent = new Agent(session);
      const profile = await agent.getProfile({ actor: session.did });
      handle = profile.data.handle;
    } catch {
      // A profile lookup failure must not break an otherwise valid login.
    }

    res.statusCode = 302;
    res.setHeader("set-cookie", await createSessionCookie({ did: session.did, handle }));
    res.setHeader("location", "/");
    res.setHeader("cache-control", "no-store");
    res.end();
  } catch (error) {
    return fail(
      res,
      400,
      `Could not complete login: ${error instanceof Error ? error.message : "unknown error"}`,
    );
  }
}
