/**
 * Step 1 of ATProto login: hand the browser off to the user's own PDS.
 *
 * Note what is absent. No password reaches this server, ever. We take a
 * handle, resolve it to a DID, discover which PDS hosts it, and redirect there.
 * Authentication happens on the user's server, not ours — which is the entire
 * point of the protocol, and the reason this app has no user table.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { getOAuthClient } from "../../lib/atproto/client.ts";

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
  const handle = url.searchParams.get("handle")?.trim();

  if (!handle) {
    return fail(res, 400, "Provide ?handle= (for example: san.haha.computer)");
  }

  try {
    // authorize() does the heavy lifting: resolve handle -> DID -> PDS,
    // discover that server's OAuth endpoints, generate a DPoP keypair, and
    // stash the state via stateStore so the callback can pick it up.
    const authUrl = await getOAuthClient().authorize(handle, {
      scope: "atproto transition:generic",
    });

    res.statusCode = 302;
    res.setHeader("location", authUrl.toString());
    // A login redirect is per-request; never let it be cached.
    res.setHeader("cache-control", "no-store");
    res.end();
  } catch (error) {
    // Most commonly: the handle does not resolve. Say so plainly rather than
    // leaking a stack trace to the browser.
    return fail(
      res,
      400,
      `Could not start login for "${handle}": ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }
}
