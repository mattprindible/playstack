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
  /** Stamped by a database trigger, never by this code. Null until edited. */
  edited_at: string | null;
};

/**
 * A message as the BROWSER is allowed to see it.
 *
 * The frontend needs to know which entries it may offer to edit, and the only
 * honest answer lives in `subject` — which is precisely the column that must
 * never reach the browser (see the note in listMessages). Sending the
 * identifier and letting the client compare would answer the question and
 * publish a stable per-author id to every visitor at the same time.
 *
 * So the comparison happens on the server and only its RESULT travels: a
 * boolean about you, rather than an identifier about everyone. Fetch more than
 * you return.
 *
 * `mine` is a display hint and nothing more. The database re-checks ownership
 * on every write, so a client that flips this to true gains exactly nothing.
 */
export type VisibleMessage = Message & { mine: boolean };

export type NewMessage = {
  name: string;
  body: string;
};

/**
 * A message plus the attribution the database will check against the caller's
 * token. `subject` is never sent to the browser — it is the stable identity.
 * listMessages does now READ it, in order to answer "is this yours" and then
 * drop it; see toMessage, which has no field to put it in.
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

/**
 * The only columns that may ever reach the browser.
 *
 * Named once and reused by every function below, because the alternative is
 * what this file used to do: spell the list out in listMessages and forget it
 * everywhere else. PostgREST returns the ENTIRE row when you ask for
 * `return=representation` and give it no `select` — so the carefully-filtered
 * read was undone by the insert handing `subject` and `gate` straight back in
 * the 201. Only ever your own, so this leaked little, but it made a stated
 * invariant depend on remembering it at four call sites instead of one.
 */
const PUBLIC_COLUMNS = "id,name,body,created_at,edited_at";

/**
 * Rebuild a row as an ALLOW-LIST rather than trimming one as a deny-list.
 *
 * The difference matters more than it looks. `const { subject, ...rest } = row`
 * reads as "drop the subject" and behaves as "keep everything I did not think
 * to name" — so the day PostgREST returns a column nobody anticipated, it goes
 * straight to the browser. Naming the fields means a new column is invisible
 * here until somebody adds it on purpose.
 *
 * A test caught exactly this: a fixture carrying `gate` sailed through a
 * spread that only destructured `subject` away.
 */
function toMessage(row: Record<string, unknown>): Message {
  return {
    id: row.id as number,
    name: row.name as string,
    body: row.body as string,
    created_at: row.created_at as string,
    edited_at: (row.edited_at as string | null) ?? null,
  };
}

/** Newest messages first. `select` and `order` are PostgREST query params. */
export async function listMessages(
  env: Env,
  fetchImpl: FetchLike,
  accessToken: string,
  viewerSubject: string,
  limit = 50,
): Promise<VisibleMessage[]> {
  const query = new URLSearchParams({
    // `subject` IS selected here and `gate` is not, which looks inconsistent
    // until you see the map below: the subject is read so it can be compared
    // and then dropped. It exists so the database can verify attribution, not
    // so the browser can display it — publishing a stable identifier for every
    // author is how you turn a guestbook into a people-directory.
    select: `${PUBLIC_COLUMNS},subject`,
    order: "created_at.desc",
    limit: String(limit),
  });

  const response = await fetchImpl(restUrl(env, `messages?${query}`), {
    method: "GET",
    headers: headers(env, accessToken),
  });

  await assertOk(response);
  const rows = (await response.json()) as Record<string, unknown>[];

  // The subject is read, compared, and never copied forward — toMessage does
  // not have a field for it. The comparison's RESULT travels; the identifier
  // does not.
  return rows.map((row) => ({
    ...toMessage(row),
    mine: row.subject === viewerSubject,
  }));
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
  // `select` is not optional here, despite the row being your own: without it
  // PostgREST returns every column, `subject` and `gate` included. See
  // PUBLIC_COLUMNS.
  const response = await fetchImpl(restUrl(env, `messages?select=${PUBLIC_COLUMNS}`), {
    method: "POST",
    headers: { ...headers(env, accessToken), Prefer: "return=representation" },
    body: JSON.stringify(input),
  });

  await assertOk(response);
  const rows = (await response.json()) as Record<string, unknown>[];

  const row = rows[0];
  if (!row) {
    throw new SupabaseError("Insert returned no row", 500);
  }
  return toMessage(row);
}

/**
 * Edit the body of one entry.
 *
 * ---------------------------------------------------------------------------
 * THE THING THAT WILL CATCH YOU: RLS FILTERS, IT DOES NOT REFUSE.
 *
 * A policy is not a permission check that fails loudly — it is a WHERE clause
 * bolted onto your statement. Try to edit somebody else's entry and Postgres
 * does not raise: the row simply is not visible to the statement, so the update
 * matches nothing, and PostgREST answers **200 with an empty array**. Exactly
 * the same response you get for an id that never existed.
 *
 * So "forbidden" and "not found" arrive identically and there is no error to
 * catch. A caller that only checks `response.ok` here reports success for an
 * edit that silently did nothing — which is worse than an error, because the
 * UI will happily tell someone their change was saved.
 *
 * Returning null for "no row" and letting the handler answer 404 is the whole
 * fix. That the two cases are indistinguishable is also, conveniently, the
 * right thing to tell the client: confirming that somebody else's entry exists
 * is not information a stranger has earned.
 * ---------------------------------------------------------------------------
 *
 * Only `body` is sent. `edited_at` is stamped by a trigger, and the immutable
 * columns are pinned by that same trigger, so this is not the layer that keeps
 * an edit honest — it is just the layer that does not bother trying.
 */
export async function updateMessage(
  env: Env,
  fetchImpl: FetchLike,
  accessToken: string,
  id: number,
  body: string,
): Promise<Message | null> {
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: PUBLIC_COLUMNS,
  });

  const response = await fetchImpl(restUrl(env, `messages?${query}`), {
    method: "PATCH",
    headers: { ...headers(env, accessToken), Prefer: "return=representation" },
    body: JSON.stringify({ body }),
  });

  await assertOk(response);
  const rows = (await response.json()) as Record<string, unknown>[];

  const row = rows[0];
  return row ? toMessage(row) : null;
}

/**
 * Delete one entry. Returns false when nothing matched.
 *
 * `return=representation` is what makes that distinction possible at all — a
 * bare DELETE answers 204 with no body whether it removed a row or silently
 * matched none, for the filtering reason described above. Asking for the
 * deleted row back is the only way to find out which happened.
 */
export async function deleteMessage(
  env: Env,
  fetchImpl: FetchLike,
  accessToken: string,
  id: number,
): Promise<boolean> {
  const query = new URLSearchParams({
    id: `eq.${id}`,
    select: "id",
  });

  const response = await fetchImpl(restUrl(env, `messages?${query}`), {
    method: "DELETE",
    headers: { ...headers(env, accessToken), Prefer: "return=representation" },
  });

  await assertOk(response);
  const rows = (await response.json()) as { id: number }[];
  return rows.length > 0;
}
