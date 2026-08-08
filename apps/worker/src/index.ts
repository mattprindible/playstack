/**
 * The Cloudflare half of the deploy story.
 *
 * Put this side by side with apps/web/api/[...path].ts. Both import the exact
 * same `createHandler` and neither contains a line of business logic. The only
 * real difference is where configuration comes from:
 *
 *   Vercel     -> process.env            (ambient Node global)
 *   Cloudflare -> the `env` argument     (explicitly passed in, per request)
 *
 * Cloudflare's approach is the stricter one: there are no ambient globals, so
 * a Worker cannot accidentally read configuration it was not handed.
 *
 * Static files are served by the `assets` binding in wrangler.jsonc, which
 * points at apps/web/public — the same directory Vercel serves. One frontend,
 * two hosts.
 */

import { createHandler, readEnv } from "@playstack/core";

type WorkerEnv = {
  SUPABASE_URL?: string;
  SUPABASE_ANON_KEY?: string;
};

export default {
  async fetch(request: Request, env: WorkerEnv): Promise<Response> {
    // Built per request because `env` only exists inside fetch(). This is
    // cheap — createHandler just closes over its dependencies.
    let handler: (request: Request) => Promise<Response>;

    try {
      handler = createHandler({
        env: readEnv(env),
        fetch: globalThis.fetch,
        platform: "cloudflare",
      });
    } catch (error) {
      // Without this, a missing secret escapes as an uncaught exception and
      // Cloudflare serves a bare "error code: 1101" page with no detail —
      // nothing in the response tells you WHICH variable is missing.
      //
      // Observed for real: for a few seconds after `wrangler secret put`, some
      // edge locations still ran without the new secrets and returned 1101.
      // 503 is the honest status — the code is fine, its configuration is not.
      const message =
        error instanceof Error ? error.message : "Worker is misconfigured";

      return new Response(JSON.stringify({ error: message }), {
        status: 503,
        headers: { "content-type": "application/json; charset=utf-8" },
      });
    }

    return handler(request);
  },
};
