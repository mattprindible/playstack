// Vanilla ES module. No bundler, no framework, no dependencies.
// The browser loads this file exactly as written — what you read is what runs.

const $ = (id) => document.getElementById(id);

const form = $("form");
const entries = $("entries");
const errorEl = $("error");
const emptyEl = $("empty");
const submitBtn = $("submit");
const bodyInput = $("body");
const countEl = $("count");

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

/** Turn a timestamp into "3 minutes ago" without pulling in a date library. */
function timeAgo(iso) {
  const seconds = (Date.now() - new Date(iso).getTime()) / 1000;
  const steps = [
    ["second", 60],
    ["minute", 60],
    ["hour", 24],
    ["day", 7],
    ["week", 4.35],
    ["month", 12],
    ["year", Infinity],
  ];

  let value = seconds;
  for (const [unit, size] of steps) {
    if (Math.abs(value) < size) return relative.format(-Math.round(value), unit);
    value /= size;
  }
  return iso;
}

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = !message;
}

/**
 * Render one entry.
 *
 * Note every value goes in via textContent, never innerHTML. That is what makes
 * a hostile message like `<img onerror=...>` render as literal text instead of
 * executing. It is the single most important habit in this file.
 */
function renderEntry(message) {
  const li = document.createElement("li");
  li.className = "entry";

  const head = document.createElement("div");
  head.className = "entry-head";

  const name = document.createElement("span");
  name.className = "entry-name";
  name.textContent = message.name;

  const time = document.createElement("time");
  time.className = "entry-time";
  time.dateTime = message.created_at;
  time.textContent = timeAgo(message.created_at);

  head.append(name, time);

  const body = document.createElement("p");
  body.className = "entry-body";
  body.textContent = message.body;

  li.append(head, body);
  return li;
}

function render(messages) {
  entries.replaceChildren(...messages.map(renderEntry));
  emptyEl.hidden = messages.length > 0;
}

async function loadMessages() {
  const response = await fetch("/api/messages");
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? "Could not load messages");
  render(data.messages);
}

/**
 * Ask the API who is answering and which gate is in front of it.
 *
 * One frontend serves both variants of this app. Rather than building twice,
 * the page asks /api/health at startup and adapts:
 *
 *   identity     -> the server signs your entries for you
 *   no identity  -> you are not signed in yet
 *
 * There is deliberately NO name input anywhere in this app. Every deployment
 * is gated, and the server overwrites `name` with the verified identity, so an
 * editable field would be a small lie about how the thing works.
 */
async function loadSession() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();

    $("platform").textContent = data.platform ?? "unknown";

    const whoami = $("whoami");
    whoami.hidden = false;

    if (data.identity) {
      whoami.textContent = `Signed in as ${data.identity}`;
      if (data.gate === "atproto") {
        loadGraph();
        // Only ATProto has a session this app owns and can revoke. A
        // Cloudflare Access session belongs to Cloudflare — offering a button
        // that cannot end it would be a lie.
        $("signout").hidden = false;
      }
    } else {
      whoami.textContent = `Not signed in — this guestbook is gated by ${data.gate}.`;
      whoami.classList.add("whoami-anon");
      submitBtn.disabled = true;

      // Cloudflare Access redirects you to a login page automatically, so
      // there is nothing to show. ATProto needs your handle first, because
      // that is what tells us which server to send you to.
      if (data.gate === "atproto") $("atproto-login").hidden = false;
    }
  } catch {
    $("platform").textContent = "offline";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  submitBtn.disabled = true;

  // Never send a name. The server overwrites it with the verified identity, so
  // sending one would only invite the misconception that the client gets a say.
  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body: bodyInput.value }),
    });

    const data = await response.json();
    if (!response.ok) throw new Error(data.error ?? "Could not post message");

    bodyInput.value = "";
    countEl.textContent = "0";
    await loadMessages();
  } catch (error) {
    showError(error.message);
  } finally {
    submitBtn.disabled = false;
  }
});

bodyInput.addEventListener("input", () => {
  countEl.textContent = String(bodyInput.value.length);
});

// --- ATProto -------------------------------------------------------------

const signinBtn = $("signin");
if (signinBtn) {
  signinBtn.addEventListener("click", () => {
    const handle = $("handle").value.trim().replace(/^@/, "");
    if (!handle) return showError("Enter your handle, e.g. san.haha.computer");

    // A full navigation, not fetch: the PDS needs to render its own consent
    // screen in the address bar the user can actually inspect. An OAuth flow
    // hidden inside XHR would be a phishing pattern.
    window.location.href = `/api/atproto/login?handle=${encodeURIComponent(handle)}`;
  });
}

const signoutBtn = $("signout");
if (signoutBtn) {
  signoutBtn.addEventListener("click", async () => {
    signoutBtn.disabled = true;
    try {
      // POST, not a link: a logout reachable by GET can be triggered by any
      // image tag on any page.
      await fetch("/api/atproto/logout", { method: "POST" });
      window.location.reload();
    } catch {
      showError("Could not sign out. Try again.");
      signoutBtn.disabled = false;
    }
  });
}

/**
 * Read the signed-in user's own graph.
 *
 * This is the cheap half of ATProto: one authenticated request, no storage of
 * our own. Cross-user questions ("what did my follows post about X") have no
 * equivalent endpoint and would require indexing the firehose.
 */
async function loadGraph() {
  try {
    const response = await fetch("/api/atproto/me");
    if (!response.ok) return;
    const data = await response.json();

    const { identity, follows } = data;
    $("graph-summary").textContent =
      `${identity.displayName ?? identity.handle} — ` +
      `${identity.followsCount ?? "?"} following, ` +
      `${identity.followersCount ?? "?"} followers. ` +
      `Showing ${follows.length}, read live from your PDS.`;

    $("follows").replaceChildren(
      ...follows.map((f) => {
        const li = document.createElement("li");
        li.className = "follow";
        li.textContent = f.displayName ? `${f.displayName} (@${f.handle})` : `@${f.handle}`;
        return li;
      }),
    );

    $("graph").hidden = false;
  } catch {
    // The graph is a bonus panel; never let it break the guestbook.
  }
}

// Session first: it decides whether the name field is even shown, and we would
// rather not flash an input that is about to disappear.
await loadSession();
loadMessages().catch((error) => showError(error.message));
