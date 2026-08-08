/**
 * Supabase data access — using nothing but `fetch`.
 *
 * Supabase's data API is PostgREST: it turns your Postgres tables into a plain
 * REST API. `supabase-js` is a convenience wrapper over exactly these HTTP
 * calls. We skip the wrapper here so the wire format is visible, because the
 * whole point of this repo is that nothing is hidden.
 *
 * The two headers below are the entire authentication story for anonymous
 * access:
 *   apikey        -> identifies the project
 *   Authorization -> the JWT whose claims Row Level Security evaluates
 *
 * Because we send the ANON key, every query here is still subject to the RLS
 * policies defined in supabase/migrations/. The database, not this file, is
 * what actually enforces access control.
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
 * We pass `fetch` in rather than reaching for the global.
 * That is what lets the tests run with zero network and zero mocking library.
 */
export type FetchLike = typeof fetch;

function restUrl(env: Env, path: string): string {
  return `${env.SUPABASE_URL}/rest/v1/${path}`;
}

function headers(env: Env): Record<string, string> {
  return {
    apikey: env.SUPABASE_ANON_KEY,
    Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
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
  limit = 50,
): Promise<Message[]> {
  const query = new URLSearchParams({
    select: "id,name,body,created_at",
    order: "created_at.desc",
    limit: String(limit),
  });

  const response = await fetchImpl(restUrl(env, `messages?${query}`), {
    method: "GET",
    headers: headers(env),
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
  input: NewMessage,
): Promise<Message> {
  const response = await fetchImpl(restUrl(env, "messages"), {
    method: "POST",
    headers: { ...headers(env), Prefer: "return=representation" },
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
