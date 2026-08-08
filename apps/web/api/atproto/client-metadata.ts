/**
 * Serves the OAuth client metadata document.
 *
 * The user's PDS fetches this URL during login to learn who is asking and
 * where it is allowed to redirect back to. It must be publicly reachable and
 * its `client_id` must equal this exact URL — that self-reference is what
 * makes the document trustworthy without a client secret.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { clientMetadata } from "../../lib/atproto/client.ts";

export default function handler(_req: IncomingMessage, res: ServerResponse): void {
  try {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json; charset=utf-8");
    // Cached briefly: PDSes refetch this, and it only changes on redeploy.
    res.setHeader("cache-control", "public, max-age=300");
    res.end(JSON.stringify(clientMetadata(), null, 2));
  } catch (error) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Misconfigured",
      }),
    );
  }
}
