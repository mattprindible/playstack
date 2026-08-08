/**
 * Environment handling.
 *
 * Why this file exists: Vercel and Cloudflare hand you configuration in two
 * different shapes.
 *
 *   Vercel     -> `process.env.SUPABASE_URL`  (a Node global, ambient)
 *   Cloudflare -> `env.SUPABASE_URL`          (passed INTO your fetch handler)
 *
 * That difference is real and unavoidable, so we isolate it here. Every other
 * file in this package receives a plain, already-validated `Env` object and
 * therefore has no idea which platform it is running on.
 */

export type Env = {
  SUPABASE_URL: string;
  SUPABASE_ANON_KEY: string;
};

/**
 * Validate an untrusted bag of environment values into a typed `Env`.
 *
 * We fail loudly at startup rather than letting `undefined` slide into a fetch
 * call and produce a confusing 401 from PostgREST much later.
 */
export function readEnv(source: Record<string, string | undefined>): Env {
  const missing: string[] = [];

  const url = source.SUPABASE_URL?.trim();
  const anonKey = source.SUPABASE_ANON_KEY?.trim();

  if (!url) missing.push("SUPABASE_URL");
  if (!anonKey) missing.push("SUPABASE_ANON_KEY");

  if (!url || !anonKey) {
    throw new Error(
      `Missing required environment variable(s): ${missing.join(", ")}. ` +
        `Copy .env.example to .env for local dev, or set them on the platform.`,
    );
  }

  return {
    SUPABASE_URL: url.replace(/\/+$/, ""), // tolerate a trailing slash
    SUPABASE_ANON_KEY: anonKey,
  };
}
