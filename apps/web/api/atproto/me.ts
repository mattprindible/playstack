/**
 * Who am I, and what does my social graph look like?
 *
 * This endpoint exists to answer the question the whole prototype was built
 * for: **is reading the graph enough, or do I need to index the network?**
 *
 * Everything below is a READ on behalf of ONE logged-in user. No firehose, no
 * background jobs, no index, no database of other people's data. If your app
 * only ever needs this shape, your backend can stay this small — a Worker and
 * a session cookie.
 *
 * The moment you need "everything my follows posted about X", none of this
 * helps: no endpoint answers cross-user queries, so you would have to consume
 * the firehose (or Jetstream), store what streams past, and keep it fresh.
 * That is a always-on service, and it is where the cost genuinely changes.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { Agent } from "@atproto/api";

import { getOAuthClient } from "../../lib/atproto/client.ts";
import { verifySessionCookie } from "../../lib/atproto/session.ts";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  const app = await verifySessionCookie(req.headers.cookie ?? null);
  if (!app) {
    res.statusCode = 401;
    res.end(JSON.stringify({ error: "Not signed in", identity: null }));
    return;
  }

  try {
    // Rehydrate the ATProto session from storage. The library refreshes the
    // access token here if it has expired, and writes the new one back through
    // sessionStore — which is why that store has to be genuinely persistent.
    const session = await getOAuthClient().restore(app.did);
    const agent = new Agent(session);

    const [profile, follows] = await Promise.all([
      agent.getProfile({ actor: app.did }),
      agent.app.bsky.graph.getFollows({ actor: app.did, limit: 25 }),
    ]);

    res.statusCode = 200;
    res.end(
      JSON.stringify({
        identity: {
          did: app.did,
          handle: profile.data.handle,
          displayName: profile.data.displayName ?? null,
          avatar: profile.data.avatar ?? null,
          followsCount: profile.data.followsCount ?? null,
          followersCount: profile.data.followersCount ?? null,
        },
        // Proof that reading the graph on behalf of one user needs no
        // infrastructure of our own beyond a session.
        follows: follows.data.follows.map((f) => ({
          did: f.did,
          handle: f.handle,
          displayName: f.displayName ?? null,
        })),
      }),
    );
  } catch (error) {
    // A revoked or expired session lands here. Treat it as signed-out rather
    // than as a server fault.
    res.statusCode = 401;
    res.end(
      JSON.stringify({
        error: `Session could not be restored: ${
          error instanceof Error ? error.message : "unknown error"
        }`,
        identity: null,
      }),
    );
  }
}
