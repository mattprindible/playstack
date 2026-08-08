/**
 * The Vercel half of the deploy story.
 *
 * `[...path].ts` is Vercel's file-based catch-all: every request under /api/*
 * lands here, keeping routing in our shared handler rather than in filenames.
 *
 * Note how little is here. Vercel Functions speak Web-standard Request ->
 * Response, so hosting the shared handler means exporting it. Compare against
 * apps/worker/src/index.ts — same handler, different three lines of glue.
 */

import { createHandler, readEnv } from "@playstack/core";

// Read config once, at module load. If a variable is missing we throw during
// cold start and the logs say exactly which one — far better than a mystery
// 401 from PostgREST on every request.
//
// On Vercel, configuration arrives as ambient `process.env`. On Cloudflare it
// is passed into fetch(). That difference is the entire reason readEnv exists.
const handler = createHandler({
  env: readEnv(process.env),
  fetch: globalThis.fetch,
  platform: "vercel",
});

export default handler;
