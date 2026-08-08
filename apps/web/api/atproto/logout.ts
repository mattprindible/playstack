/**
 * Sign out — and actually mean it.
 *
 * There was no logout for a while, which was the most quietly serious gap in
 * this project. `clearSessionCookie()` existed in lib/atproto/session.ts and
 * was imported by nothing. That meant:
 *
 *   - a 7-day session cookie no visitor could revoke, and
 *   - an `atproto_sessions` row holding a REFRESH TOKEN and a DPoP PRIVATE KEY
 *     that was never deleted, quietly refreshing itself long after somebody
 *     had stopped using the site.
 *
 * For an app whose distinguishing feature is custodying someone else's
 * credentials, "you cannot leave" is not a missing nicety. Signing out has to
 * revoke, not merely forget.
 *
 * So this endpoint does BOTH halves:
 *
 *   1. Tell the PDS to revoke the token, so it stops working at the source.
 *   2. Delete our stored copy, so we stop holding a credential we no longer
 *      have any reason to hold.
 *
 * Clearing the cookie alone would leave both of those in place.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { getOAuthClient } from "../../lib/atproto/client.ts";
import { clearSessionCookie, verifySessionCookie } from "../../lib/atproto/session.ts";
import { sessionStore } from "../../lib/atproto/store.ts";

export default async function handler(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // POST only. A logout reachable by GET can be triggered by any <img> tag on
  // any page — harmless here, but it is the same shape as the bugs that are
  // not, and SameSite=Lax does send cookies on top-level navigations.
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("allow", "POST");
    res.end(JSON.stringify({ error: "Use POST to sign out" }));
    return;
  }

  const session = await verifySessionCookie(req.headers.cookie ?? null);

  // Clear the cookie no matter what happens below. A visitor asking to leave
  // must always end up logged out of THIS app, even if revocation fails —
  // never strand somebody in a session they have asked to end.
  res.setHeader("set-cookie", clearSessionCookie());
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");

  if (session) {
    try {
      // Ask the PDS to revoke. This is the half that matters: without it the
      // refresh token stays valid at the source and only our copy disappears.
      const oauth = await getOAuthClient().restore(session.did);
      await oauth.signOut();
    } catch {
      // An already-expired or already-revoked session lands here. Fall through
      // and still delete our copy.
    }

    try {
      await sessionStore.del(session.did);
    } catch {
      // Best effort. The cookie is already cleared, so the visitor is out
      // either way; a stale row is a cleanup problem, not an access one.
    }
  }

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true }));
}
