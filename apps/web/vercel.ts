/**
 * Vercel project configuration, in TypeScript rather than JSON.
 *
 * `vercel.ts` is Vercel's current recommendation over `vercel.json`: you get
 * autocomplete and type errors instead of silently-ignored misspelled keys.
 */

import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  // No framework and no build step. The browser gets exactly the files in
  // public/, and api/ becomes a Function.
  framework: null,
  buildCommand: null,
  outputDirectory: "public",

  headers: [
    {
      source: "/(.*)",
      headers: [
        { key: "x-content-type-options", value: "nosniff" },
        { key: "referrer-policy", value: "strict-origin-when-cross-origin" },
      ],
    },
    {
      // The API is per-request state; never let a CDN cache it.
      source: "/api/(.*)",
      headers: [{ key: "cache-control", value: "no-store" }],
    },
  ],
};

export default config;
