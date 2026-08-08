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

/** Set by loadSession(): true when an auth gate is in front of this deployment. */
let gated = false;

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
 * Ask the API who is answering and whether a gate is in front of it.
 *
 * One frontend serves every variant of this app. Rather than building three
 * builds, the page asks /api/health at startup and adapts:
 *
 *   no gate            -> type any name you like
 *   gate + identity     -> name field disappears; the server signs for you
 *   gate + no identity  -> you are not signed in
 *
 * The name input is REMOVED rather than pre-filled when a gate is active,
 * because with a gate the server overwrites it regardless. Showing an editable
 * field whose value is discarded would be a small lie about how it works.
 */
async function loadSession() {
  try {
    const response = await fetch("/api/health");
    const data = await response.json();

    $("platform").textContent = data.platform ?? "unknown";
    gated = Boolean(data.gate);

    if (!gated) return;

    $("name-field").hidden = true;
    $("name").required = false;

    const whoami = $("whoami");
    whoami.hidden = false;

    if (data.identity) {
      whoami.textContent = `Signed in as ${data.identity}`;
    } else {
      whoami.textContent = `Not signed in — this guestbook is gated by ${data.gate}.`;
      whoami.classList.add("whoami-anon");
      submitBtn.disabled = true;
    }
  } catch {
    $("platform").textContent = "offline";
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  showError("");
  submitBtn.disabled = true;

  // When gated, don't send a name at all. The server overwrites it with the
  // verified identity, so sending one would only invite the misconception that
  // the client gets a say.
  const payload = gated
    ? { body: bodyInput.value }
    : { name: $("name").value, body: bodyInput.value };

  try {
    const response = await fetch("/api/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
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

// Session first: it decides whether the name field is even shown, and we would
// rather not flash an input that is about to disappear.
await loadSession();
loadMessages().catch((error) => showError(error.message));
