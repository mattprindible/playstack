/**
 * Supabase-backed storage for the ATProto OAuth client.
 *
 * `@atproto/oauth-client-node` needs two stores: one for short-lived OAuth
 * "state" during a login round-trip, and one for the long-lived session
 * (access token, refresh token, and the DPoP private key).
 *
 * Everything here uses the SERVICE_ROLE key, which bypasses Row Level Security
 * entirely. That is a deliberate, contained escalation:
 *
 *   - It exists only in this Vercel Function's environment.
 *   - It never reaches a browser, a Worker, or the repo.
 *   - The tables it touches are REVOKEd from anon and have RLS on with no
 *     policies, so even a leak of the anon key reveals nothing here.
 *
 * If you take one habit from this file: service_role is not "the key that
 * works", it is "the key that ignores your safety rails". Use it only in a
 * trusted server context, for data that genuinely must not be public.
 */

import type {
  NodeSavedSession,
  NodeSavedSessionStore,
  NodeSavedState,
  NodeSavedStateStore,
} from "@atproto/oauth-client-node";

function serviceConfig() {
  const url = process.env.SUPABASE_URL?.trim().replace(/\/+$/, "");
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim();

  if (!url || !key) {
    throw new Error(
      "ATProto OAuth needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY. " +
        "The service_role key is secret — set it with `vercel env add`, never in git.",
    );
  }

  return {
    url,
    headers: {
      apikey: key,
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
  };
}

async function upsert(table: string, row: Record<string, unknown>): Promise<void> {
  const { url, headers } = serviceConfig();

  const response = await fetch(`${url}/rest/v1/${table}`, {
    method: "POST",
    // merge-duplicates makes this an UPSERT keyed on the primary key, which is
    // what the OAuth client expects `set()` to mean.
    headers: { ...headers, Prefer: "resolution=merge-duplicates" },
    body: JSON.stringify(row),
  });

  if (!response.ok) {
    throw new Error(`Failed to write ${table}: ${response.status} ${await response.text()}`);
  }
}

async function selectOne<T>(table: string, column: string, value: string): Promise<T | null> {
  const { url, headers } = serviceConfig();

  const response = await fetch(
    `${url}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}&limit=1`,
    { headers },
  );

  if (!response.ok) {
    throw new Error(`Failed to read ${table}: ${response.status}`);
  }

  const rows = (await response.json()) as T[];
  return rows[0] ?? null;
}

async function remove(table: string, column: string, value: string): Promise<void> {
  const { url, headers } = serviceConfig();
  await fetch(`${url}/rest/v1/${table}?${column}=eq.${encodeURIComponent(value)}`, {
    method: "DELETE",
    headers,
  });
}

/**
 * OAuth state: created when a login starts, consumed at the callback.
 * Single-use by design — `del` is called as soon as it has served its purpose,
 * which is what stops a captured state from being replayed.
 */
export const stateStore: NodeSavedStateStore = {
  async set(key: string, state: NodeSavedState) {
    await upsert("atproto_states", { key, state });
  },

  async get(key: string) {
    const row = await selectOne<{ state: NodeSavedState }>("atproto_states", "key", key);
    return row?.state ?? undefined;
  },

  async del(key: string) {
    await remove("atproto_states", "key", key);
  },
};

/**
 * The long-lived session, keyed by DID.
 *
 * The library refreshes tokens on its own and calls set() again with the new
 * values, so this must genuinely persist — an in-memory store would silently
 * log everyone out on each cold start.
 */
export const sessionStore: NodeSavedSessionStore = {
  async set(did: string, session: NodeSavedSession) {
    await upsert("atproto_sessions", {
      did,
      // Denormalised purely so ops queries can read a handle without decoding
      // the session blob. Never trusted as identity — the DID is the identity.
      handle: (session as { tokenSet?: { sub?: string } }).tokenSet?.sub ?? did,
      session,
      updated_at: new Date().toISOString(),
    });
  },

  async get(did: string) {
    const row = await selectOne<{ session: NodeSavedSession }>(
      "atproto_sessions",
      "did",
      did,
    );
    return row?.session ?? undefined;
  },

  async del(did: string) {
    await remove("atproto_sessions", "did", did);
  },
};
