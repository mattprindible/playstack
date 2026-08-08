/**
 * Supabase data access — using nothing but `fetch`.
 *
 * Supabase's data API is PostgREST: it turns your Postgres tables into a plain
 * REST API. `supabase-js` is a convenience wrapper over exactly these HTTP
 * calls. We skip the wrapper here so the wire format is visible, because the
 * whole point of this repo is that nothing is hidden.
 *
 * The two headers below are the entire authentication story, and they do
 * genuinely different jobs:
 *   apikey        -> identifies the PROJECT (Supabase's gateway needs it to route)
 *   Authorization -> the JWT whose claims Row Level Security evaluates
 *
 * Most Supabase code sends the same anon key for both, which is why almost
 * nobody notices they are separate. Here they are not: `apikey` stays the anon
 * key, while `Authorization` carries a short-lived token minted for the
 * verified caller (see token.ts). PostgREST reads that token, switches to the
 * `authenticated` role, and exposes its claims to the policies.
 *
 * The anon key has been REVOKEd from public.messages entirely, so it can no
 * longer read or write this table on its own. The database, not this file, is
 * what enforces access control.
 */

import type { Env } from "./env.ts";

export type Message = {
  id: number;
  name: string;
  body: string;
  created_at: string;
};

export type NewMessage = {
  name: string;
  body: string;
};

/**
 * A message plus the attribution the database will check against the caller's
 * token. `subject` is never sent to the browser — it is the stable identity,
 * and listMessages deliberately does not select it.
 */
export type AttributedMessage = NewMessage & {
  subject: string;
  gate: string;
};

/**
 * We pass `fetch` in rather than reaching for the global.
 * That is what lets the tests run with zero network and zero mocking library.
 */
export type FetchLike = typeof fetch;

function restUrl(env: Env, path: string): string {
  return `${env.SUPABASE_URL}/rest/v1/${path}`;
}

/**
 * `accessToken` is the minted per-caller JWT. It is what RLS evaluates; the
 * anon key alone can no longer touch this table.
 */
function headers(env: Env, accessToken: string): Record<string, string> {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken}`,
    "Content-Type": "application/json",
  };
}

/** Raised when PostgREST returns a non-2xx. Carries the status through. */
export class SupabaseError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "SupabaseError";
    this.status = status;
  }
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const detail = await response.text().catch(() => "");
  throw new SupabaseError(
    `Supabase request failed (${response.status}): ${detail.slice(0, 300)}`,
    response.status,
  );
}

/** Newest messages first. `select` and `order` are PostgREST query params. */
export async function listMessages(
  env: Env,
  fetchImpl: FetchLike,
  accessToken: string,
  limit = 50,
): Promise<Message[]> {
  const query = new URLSearchParams({
    // `subject` and `gate` are deliberately NOT selected. They exist so the
    // database can verify attribution, not so the browser can display it —
    // publishing a stable identifier for every author is how you turn a
    // guestbook into a people-directory.
    select: "id,name,body,created_at",
    order: "created_at.desc",
    limit: String(limit),
  });

  const response = await fetchImpl(restUrl(env, `messages?${query}`), {
    method: "GET",
    headers: headers(env, accessToken),
  });

  await assertOk(response);
  return (await response.json()) as Message[];
}

/**
 * Insert one row.
 *
 * `Prefer: return=representation` is the PostgREST way of saying
 * "give me the inserted row back" — otherwise you get an empty 201.
 */
export async function createMessage(
  env: Env,
  fetchImpl: FetchLike,
  accessToken: string,
  input: AttributedMessage,
): Promise<Message> {
  const response = await fetchImpl(restUrl(env, "messages"), {
    method: "POST",
    headers: { ...headers(env, accessToken), Prefer: "return=representation" },
    body: JSON.stringify(input),
  });

  await assertOk(response);
  const rows = (await response.json()) as Message[];

  const row = rows[0];
  if (!row) {
    throw new SupabaseError("Insert returned no row", 500);
  }
  return row;
}
