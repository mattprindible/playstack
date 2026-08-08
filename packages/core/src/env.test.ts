/**
 * Tests for environment validation.
 *
 * These exist because of a real incident during setup: a missing secret threw
 * inside the Cloudflare fetch handler, and Cloudflare turned that into an
 * opaque "error code: 1101" page. The lesson was not that throwing is wrong —
 * it is that the error message has to name the missing variable, and the
 * caller has to catch it and say so.
 */

import test from "node:test";
import assert from "node:assert/strict";

import { readEnv } from "./env.ts";

const VALID = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_ANON_KEY: "anon-key",
};

test("readEnv accepts a complete environment", () => {
  assert.deepEqual(readEnv(VALID), VALID);
});

test("readEnv strips a trailing slash so URL building stays predictable", () => {
  const env = readEnv({ ...VALID, SUPABASE_URL: "https://example.supabase.co///" });
  assert.equal(env.SUPABASE_URL, "https://example.supabase.co");
});

test("readEnv names the variable that is missing", () => {
  assert.throws(
    () => readEnv({ SUPABASE_ANON_KEY: "anon-key" }),
    (error: Error) => {
      // Naming the variable is the whole point — a generic "config error"
      // would leave an operator guessing which of the two it was.
      assert.match(error.message, /SUPABASE_URL/);
      assert.doesNotMatch(error.message, /SUPABASE_ANON_KEY/);
      return true;
    },
  );
});

test("readEnv reports every missing variable at once", () => {
  assert.throws(
    () => readEnv({}),
    (error: Error) => {
      assert.match(error.message, /SUPABASE_URL/);
      assert.match(error.message, /SUPABASE_ANON_KEY/);
      return true;
    },
  );
});

test("readEnv treats blank and whitespace-only values as missing", () => {
  // A variable set to "" is a common CI mistake and must not look configured.
  assert.throws(() => readEnv({ ...VALID, SUPABASE_ANON_KEY: "" }), /SUPABASE_ANON_KEY/);
  assert.throws(() => readEnv({ ...VALID, SUPABASE_URL: "   " }), /SUPABASE_URL/);
});

test("readEnv never leaks the key's value in its error", () => {
  try {
    readEnv({ SUPABASE_URL: "", SUPABASE_ANON_KEY: "super-secret-value" });
    assert.fail("expected a throw");
  } catch (error) {
    assert.doesNotMatch((error as Error).message, /super-secret-value/);
  }
});
