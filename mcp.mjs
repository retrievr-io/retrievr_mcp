#!/usr/bin/env node
// retrievr, as a tool an agent holds.
//
// A stdio MCP server: JSON-RPC over stdin and stdout, one message per line. It
// exists because the interesting half of retrievr is a *tool call* — the model
// reaches for retrieval and gets passages with citations — and the HTTP sheet is
// the same thing spelled out longhand.
//
// Three decisions worth knowing before editing this:
//
//   * **The key is read at call time, never at startup.** A server that reads it
//     once would have to be restarted after the install, which is exactly the
//     thing this shape avoids: the tool is already in the agent's belt, and the
//     install is what authenticates it. The same reason `retrieve.mjs` reads the
//     file per run.
//   * **The submit-then-poll pair is hidden here.** `/retrieve` is asynchronous
//     because the embedding ran on a scale-to-zero GPU — submit, get a job id,
//     poll. A model wants one answer, so the job id never crosses this boundary.
//   * **A failure is a tool result, not a JSON-RPC error.** A JSON-RPC error is
//     what a harness renders as a broken server; a result is what the model reads
//     and acts on. "You have no key yet, here is the line to run" is only useful
//     in the second shape. The one exception is a tool name that does not exist,
//     which is a programming error in the caller.
//
// stdout is the protocol channel. Anything that is not JSON-RPC goes to stderr.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

/** What this server speaks. The client's own choice is echoed when we know it. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

const SERVER_NAME = "retrievr";

/**
 * What this copy is.
 *
 * The customer holds a *copy* of this file — that is the shape we chose over a
 * hosted endpoint — so the copy has to be able to learn that it is behind. This
 * constant is the source of truth for both sides of that: the handshake reports
 * it, and the release tag is cut from it. It is also why there is no second
 * version string in here to drift away from the first.
 */
const VERSION = "0.1.0";

/**
 * The deployment, unless told otherwise.
 *
 * Defaulted rather than required, because the alternative is a `mcp.json` entry
 * carrying an environment variable that a customer has to get right before the
 * tool works at all. The connect script ships the same default for the same
 * reason.
 */
const DEFAULT_BASE_URL = "https://drqkocyrytmbvlmasoyv.supabase.co/functions/v1";

const TOOL_NAME = "retrievr_search";

/**
 * How much of a passage to show.
 *
 * A guard, not a summary. The parent window the chunker records runs to about
 * 1,500 characters — chars 2938-4471 for the Declaration — and that passage *is*
 * the citation, so this must not clip a real one.
 *
 * It was 600. A rehearsal showed what that costs: the model read a cut-off
 * quote and went back to the raw HTTP calls, job id and polling included, to
 * fetch the rest — precisely the plumbing this tool exists to hide. Two thousand
 * leaves every real window whole and still stops a pathological row from
 * flooding the context. Pi trims results over 20 KB itself, so a generous number
 * here is not a risk to the model's window.
 */
/**
 * The guard on a passage, not a summary of one.
 *
 * Measured against the corpus rather than guessed: the parent window the chunker
 * records averages **4,343 characters** and reaches **8,267**. An earlier version
 * of this file capped a passage at 600 on the assumption that windows were about
 * 1,500 — three samples that happened to be small. A rehearsal showed the cost:
 * the model read a cut-off quote and went back to the raw HTTP calls, job id and
 * polling included, to fetch the rest, which is precisely the plumbing this tool
 * exists to hide.
 *
 * So the guard sits above the largest window the corpus holds. It is there for
 * the day a chunker change makes one larger, and when it bites the cut is named
 * in the output rather than silent.
 */
const PASSAGE_CHARS = 9000;

/**
 * How many passages a call returns when the caller does not say.
 *
 * Three, not five. At an average window of 4.3 KB, five whole passages is over
 * 20 KB, which is where pi starts removing the middle of a large result — and a
 * passage with its middle removed is a passage that cannot be quoted. Three keeps
 * a typical answer in the low teens of thousands of characters.
 */
const DEFAULT_K = 3;

/**
 * The plain scopes the API accepts, and the one a query gets when it says nothing.
 *
 * `all` is the default because it is what a person means by "ask retrievr": their
 * own documents are part of what they have. The fourth scope, `documents`, is not
 * in this list because a caller never spells it — they name documents, and
 * `scopeFor` turns that into the ids it takes.
 */
const SCOPES = ["all", "public", "private"];

/** How many documents one call may name. The API's own ceiling on `scope.ids` is 100. */
const MAX_DOCUMENT_NAMES = 20;

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function baseUrl() {
  return (process.env.RETRIEVR_FUNCTIONS_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
}

/**
 * The key, read now rather than at startup.
 *
 * `$RETRIEVR_API_KEY` first so a harness can override per session; then the file
 * the connect script writes. A missing file is not an error at this layer — the
 * caller is told what to do about it.
 */
function configDir() {
  return process.env.RETRIEVR_CONFIG_DIR ?? join(homedir(), ".config", "retrievr");
}

function apiKey() {
  const fromEnv = process.env.RETRIEVR_API_KEY?.trim();
  if (fromEnv) return fromEnv;

  try {
    return readFileSync(join(configDir(), "credentials"), "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

/** The sentence a machine with no key needs, which is how to get one. */
const NO_KEY = [
  "No retrievr key on this machine yet, so nothing was retrieved.",
  "Run the connect step from https://retrievr.io/install: it writes the key to",
  "~/.config/retrievr/credentials and never prints it. This tool will work on the",
  "next call — it reads the key each time and does not need restarting.",
].join(" ");

// --- telling a copy that it is behind ---------------------------------------

/**
 * Where the released copy lives, and what it is called.
 *
 * The repository is private while this is being built, so an anonymous call here
 * answers 404 and the check says nothing. That is the intended reading of a 404
 * in this file, not an error: see `checkForUpdate`.
 */
const REPO = "retrievr-io/retrievr_mcp";
const LATEST_RELEASE_URL =
  process.env.RETRIEVR_MCP_LATEST_URL ?? `https://api.github.com/repos/${REPO}/releases/latest`;

/**
 * A day between checks, and three seconds to answer.
 *
 * The day is what makes the check affordable: a customer who asks ten questions
 * in an afternoon asks GitHub once. The three seconds is the whole of the risk
 * this file takes on a network it does not own — everything after it fails quiet.
 */
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const UPDATE_CHECK_TIMEOUT_MS = 3000;
const UPDATE_CACHE_FILE = "update-check.json";

/** `v0.2.0` → `0.2.0`. A tag that is not x.y.z is a tag we say nothing about. */
function versionOf(tag) {
  return /^v?(\d+\.\d+\.\d+)$/.exec(String(tag ?? "").trim())?.[1];
}

/** Part by part, numerically: 0.10.0 is newer than 0.9.0, which a string compare gets wrong. */
function isNewer(latest, current) {
  const [a, b] = [latest, current].map((version) => version.split(".").map(Number));
  for (let part = 0; part < 3; part += 1) {
    if (a[part] !== b[part]) return a[part] > b[part];
  }
  return false;
}

/** The sentence a human needs: both versions, and what to do about it. */
function noticeFor(latest) {
  return (
    `retrievr-mcp ${latest} is available — this copy is ${VERSION}. ` +
    "Update it by re-running the install line from https://retrievr.io/install."
  );
}

function readUpdateCache() {
  try {
    const cached = JSON.parse(readFileSync(join(configDir(), UPDATE_CACHE_FILE), "utf8"));
    if (typeof cached?.checkedAt !== "number" || typeof cached?.latest !== "string") {
      return undefined;
    }
    return cached;
  } catch {
    return undefined; // absent, or not ours — either way it is a check to make
  }
}

function writeUpdateCache(latest) {
  try {
    mkdirSync(configDir(), { recursive: true });
    writeFileSync(
      join(configDir(), UPDATE_CACHE_FILE),
      `${JSON.stringify({ checkedAt: Date.now(), latest })}\n`,
    );
  } catch {
    // A cache that cannot be written is a check made twice, not a failed search.
  }
}

/**
 * What the latest release is, asked at most once a day, and never in a way that
 * can be noticed.
 *
 * Every failure here is silence, on purpose. GitHub can be unreachable, rate
 * limited (sixty anonymous calls an hour), or holding a tag nobody can parse, and
 * while the repository is private it answers 404 to everyone but us. None of that
 * is the customer's problem and none of it may reach their answer — a retrieval
 * that reports on a version check is worse than one that never checks.
 *
 * A stale answer beats no answer, so a cache that has aged out is still the
 * fallback when the network will not speak.
 */
async function checkForUpdate() {
  const cached = readUpdateCache();
  if (cached !== undefined && Date.now() - cached.checkedAt < UPDATE_CHECK_TTL_MS) {
    return cached.latest;
  }

  try {
    const response = await fetch(LATEST_RELEASE_URL, {
      headers: { accept: "application/vnd.github+json" },
      signal: AbortSignal.timeout(UPDATE_CHECK_TIMEOUT_MS),
    });
    if (!response.ok) return cached?.latest;

    const latest = versionOf((await response.json())?.tag_name);
    if (latest === undefined) return cached?.latest;

    writeUpdateCache(latest);
    return latest;
  } catch {
    return cached?.latest; // offline, refused, or slower than we were willing to wait
  }
}

/**
 * The check, started when the process starts and awaited by the first tool call.
 *
 * Started here rather than on the first call so that it overlaps the session
 * starting up — and awaited there rather than here so that the handshake is never
 * held open by a network we do not own. `catch` because a rejection here would
 * travel into that tool call through `Promise.all`, and nothing about an update
 * check is worth failing a search over.
 */
const updateCheck = checkForUpdate().catch(() => undefined);

let noticeShown = false;

/** The line to add to an answer, or nothing. Once per session, and never a downgrade. */
function updateNotice(latest) {
  if (noticeShown || latest === undefined || !isNewer(latest, VERSION)) return undefined;
  noticeShown = true;
  return noticeFor(latest);
}

function explain(status, detail) {
  const because =
    status === 401
      ? "the key is unknown or revoked — run the connect step again"
      : status === 402
        ? "the balance is spent — top up at https://retrievr.io/profile"
        : status === 503
          ? "retrievr could not embed the query just now; try again shortly"
          : status === 400
            ? "the request was refused as invalid"
            : "the retrieval endpoint answered an error";
  return `retrievr: ${because} (HTTP ${status}${detail ? ` ${detail}` : ""}).`;
}

async function readError(response) {
  try {
    return (await response.json()).error ?? "";
  } catch {
    // A non-JSON error body is still an error; the status is the message.
    return "";
  }
}

/**
 * One question in, cited passages out.
 *
 * Returns a value rather than throwing for anything the caller can act on, so
 * every failure below reaches the model as a sentence.
 */
async function search(query, k, scope) {
  const key = apiKey();
  if (key === undefined) return { ok: false, message: NO_KEY };

  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };
  // `k` is omitted rather than defaulted here, so the API's own default stays the
  // one place it is written down. The scope is the opposite: it is sent whenever
  // the caller asked for one, because "I forgot the scope" and "search everything"
  // must not look the same on the wire.
  const body = { query };
  if (k !== undefined) body.k = k;
  if (scope !== undefined) body.scope = scope;

  let submitted;
  try {
    submitted = await fetch(`${baseUrl()}/retrieve`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (cause) {
    return { ok: false, message: `retrievr: could not reach the service (${cause.message}).` };
  }

  if (submitted.status !== 202) {
    return { ok: false, message: explain(submitted.status, await readError(submitted)) };
  }

  const { job_id: jobId, interval } = await submitted.json();
  const everyMs = Math.max(1, Number(interval) || 2) * 1000;

  // Bounded by the job's own lifetime: once it expires the poll answers 410 and
  // the loop ends below, so there is no separate deadline to keep in step.
  for (;;) {
    await sleep(everyMs);

    let polled;
    try {
      polled = await fetch(`${baseUrl()}/retrieve-job/${jobId}`, { headers });
    } catch (cause) {
      return { ok: false, message: `retrievr: lost the service mid-query (${cause.message}).` };
    }

    if (polled.status !== 200) {
      return { ok: false, message: explain(polled.status, await readError(polled)) };
    }

    const state = await polled.json();
    if (state.status === "pending") continue;
    if (state.status !== "complete") {
      return { ok: false, message: `retrievr: retrieval failed — ${state.error ?? state.status}.` };
    }
    return {
      ok: true,
      results: Array.isArray(state.results) ? state.results : [],
      retrieval_ms: state.retrieval_ms,
    };
  }
}

/** The citation is the product, so it is rendered in full and never summarised. */
function format(results, retrievalMs) {
  if (results.length === 0) return "retrievr found no passages for that query.";

  const blocks = results.map((result, index) => {
    const collapsed = String(result.text ?? "").split(/\s+/).filter(Boolean).join(" ");
    // A cut is named, never silent: a model that cannot tell has to go around
    // the tool to find out what it is missing, which is the failure this file
    // already has a comment about.
    const passage =
      collapsed.length <= PASSAGE_CHARS
        ? collapsed
        : `${collapsed.slice(0, PASSAGE_CHARS)} \u2026[passage truncated at ${PASSAGE_CHARS} characters; the full window is chars ${result.char_start}-${result.char_end}]`;
    return [
      `${index + 1}. ${result.title || result.doc_id}  [${result.doc_id}]`,
      `   ${result.author}`,
      `   ${result.section_path}   chars ${result.char_start}-${result.char_end}`,
      `   licence: ${result.licence}   score: ${Number(result.score).toFixed(6)}`,
      `   ${passage}`,
    ].join("\n");
  });

  return `${blocks.join("\n\n")}\n\nretrieval ${retrievalMs}ms`;
}

// --- naming a document ------------------------------------------------------

/**
 * What a name resolves to: the caller's library, and the public corpus.
 *
 * `undefined` is "the service could not be reached" and `[]` is "nothing is called
 * that". The distinction is the caller's to keep: one is worth retrying, the other
 * is worth telling the human about, and a tool that collapses them sends the model
 * looking for a network problem that does not exist.
 */
async function documentsNamed(name) {
  const key = apiKey();
  if (key === undefined) return undefined;

  const query = name === "" ? "" : `?q=${encodeURIComponent(name)}`;
  try {
    const response = await fetch(`${baseUrl()}/documents${query}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    if (!response.ok) return undefined;
    const body = await response.json();
    return Array.isArray(body?.documents) ? body.documents : [];
  } catch {
    return undefined;
  }
}

/**
 * The scope a call asks for, from its `scope` and `documents` arguments.
 *
 * `documents` wins when both arrive. A caller who names documents has said
 * something more specific than `scope: "all"`, and the API drops `ids` that come
 * with any other type — so honouring both would mean the names were silently
 * ignored and the search ran wider than the request.
 *
 * A name that resolves to nothing **fails the call** rather than widening it. The
 * alternative is a search that charges for a query, answers from the whole corpus,
 * and looks to the person exactly like the document they named was searched.
 */
async function scopeFor(args) {
  const named = args?.documents;
  const plain = args?.scope;

  if (named === undefined) {
    if (plain === undefined) return {};
    if (typeof plain !== "string" || !SCOPES.includes(plain)) {
      return { error: `retrievr: scope must be one of ${SCOPES.join(", ")}.` };
    }
    return { scope: { type: plain, ids: [] }, note: plain === "all" ? undefined : `scope: ${plain}` };
  }

  if (!Array.isArray(named) || named.length === 0) {
    return { error: "retrievr: documents must be a non-empty list of document names or ids." };
  }
  if (named.length > MAX_DOCUMENT_NAMES) {
    return { error: `retrievr: name at most ${MAX_DOCUMENT_NAMES} documents in one call.` };
  }

  const found = [];
  const missing = [];
  for (const entry of named) {
    const name = typeof entry === "string" ? entry.trim() : "";
    if (name === "") continue;

    const matches = await documentsNamed(name);
    if (matches === undefined) {
      return { error: "retrievr: could not reach the service to resolve a document name." };
    }
    if (matches.length === 0) {
      missing.push(name);
      continue;
    }
    found.push(...matches);
  }

  if (missing.length > 0) {
    const held = (await documentsNamed("")) ?? [];
    const names = missing.map((name) => `"${name}"`).join(" or ");
    const library =
      held.length === 0
        ? "The user's library is empty. Name a document from the public corpus, or search with scope \"public\"."
        : `Their library holds: ${held.map((doc) => doc.title).join(", ")}.`;
    return { error: `retrievr: nothing in the user's library or the public corpus is called ${names}. ${library}` };
  }

  const ids = [...new Set(found.map((doc) => doc.id))];
  return {
    scope: { type: "documents", ids },
    note: `scope: documents — ${found.map((doc) => `${doc.title} [${doc.id}]`).join("; ")}`,
  };
}

/** One document, as a result line: what it is, what to call it, whose it is, whether it answers. */
function documentLine(doc, index) {
  const where = doc.source === "public" ? "public corpus" : "the user's library";
  const ready = doc.passages > 0 ? `${doc.passages} passages` : "not retrievable yet";
  return `${index + 1}. ${doc.title}  [${doc.id}]  ${where}, ${ready}`;
}

/**
 * `retrievr_documents`, as a tool result.
 *
 * A listing and a lookup are the same call with and without a name, because they
 * are the same question — "what can I name?" — and a model that has two tools for it
 * has to know which one it wants before it knows what exists.
 */
async function documentsResult(rawQuery) {
  const query = typeof rawQuery === "string" ? rawQuery.trim() : "";
  const documents = await documentsNamed(query);

  if (documents === undefined) {
    return textResult("retrievr: could not reach the service to list documents.", true);
  }

  if (query === "") {
    if (documents.length === 0) {
      return textResult(
        "The user's retrievr library is empty — nothing has been uploaded to it yet. " +
          "The public corpus is still searchable with retrievr_search.",
      );
    }
    return textResult(
      [
        `The user's library holds ${documents.length} document${documents.length === 1 ? "" : "s"}:`,
        ...documents.map(documentLine),
        "",
        "Pass any of these names to retrievr_search's `documents` argument to search only it.",
      ].join("\n"),
    );
  }

  if (documents.length === 0) {
    return textResult(
      `Nothing in the user's library or the public corpus is called "${query}". ` +
        "Call this tool with no query to see what they do have, or ask them for the exact title.",
    );
  }

  return textResult(
    [
      `${documents.length} document${documents.length === 1 ? "" : "s"} matching "${query}":`,
      ...documents.map(documentLine),
      "",
      "Pass a name to retrievr_search's `documents` argument to search only that document (or that list).",
    ].join("\n"),
  );
}

/**
 * `retrievr_delete_document`, as a tool result.
 *
 * The only destructive tool here, and the reason its description makes the model
 * confirm a title before it acts: "delete the lease" and "delete the lease renewal"
 * are the same request until somebody reads one back. The id is required and never
 * inferred — a name would resolve to whatever ranked first, and the first result of
 * a fuzzy match is not a thing to delete sight unseen.
 */
async function deleteResult(rawId) {
  const docId = typeof rawId === "string" ? rawId.trim() : "";
  if (docId === "") {
    return textResult(
      "retrievr: doc_id is required, and nothing was deleted. Call retrievr_documents " +
        "to see the user's document ids.",
      true,
    );
  }

  const key = apiKey();
  if (key === undefined) return textResult(NO_KEY, true);

  let response;
  try {
    response = await fetch(`${baseUrl()}/documents/${encodeURIComponent(docId)}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${key}` },
    });
  } catch (cause) {
    return textResult(`retrievr: could not reach the service (${cause.message}).`, true);
  }

  if (response.status === 404) {
    return textResult(
      `retrievr: nothing of the user's was called ${docId}, so nothing was deleted. ` +
        "Call retrievr_documents to see what they do have.",
      true,
    );
  }
  if (!response.ok) {
    return textResult(explain(response.status, await readError(response)), true);
  }

  const body = await response.json().catch(() => ({}));
  // Said only when it is true, because it is the one part of a deletion that is not
  // finished: the row is gone and the place is free either way.
  const tidy =
    body?.storage_removed === false
      ? " The stored file is still being tidied up; that does not change what the user can see or search."
      : "";

  return textResult(
    `Deleted ${body?.id ?? docId}. It is gone from their library and from retrieval, and its place is free.${tidy}`,
  );
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

const TOOL = {
  name: TOOL_NAME,
  title: "Search retrievr",
  description:
    "Search retrievr and get passages back with their citation: source, author, section, " +
    "character range and licence. Use this instead of answering from memory when a question is " +
    "about a document retrievr may hold, and cite the fields it returns. " +
    "By default this searches the user's own documents *and* the public corpus together; pass " +
    'scope: "private" to search only their documents, scope: "public" for only the open ' +
    "corpus, or documents: [\"a title or id\"] to search one document or a list of them " +
    "(use retrievr_documents to find the names).",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The question, or the passage to find.",
      },
      k: {
        type: "integer",
        minimum: 1,
        maximum: 50,
        description: `How many passages to return. Defaults to ${DEFAULT_K}.`,
      },
      scope: {
        type: "string",
        enum: SCOPES,
        description:
          'What to search: "all" (the user\'s documents and the public corpus, the default), ' +
          '"private" (only the user\'s own documents), or "public" (only the openly licensed corpus).',
      },
      documents: {
        type: "array",
        items: { type: "string" },
        description:
          "Search only these documents. Each entry is a title, a filename or an id from " +
          "retrievr_documents, and a title matches the documents that contain it. When this is " +
          "given it decides the scope; `scope` is ignored.",
      },
    },
    required: ["query"],
    additionalProperties: false,
  },
};

const DOCUMENTS_TOOL = {
  name: "retrievr_documents",
  title: "See retrievr's documents",
  description:
    "List the documents in the user's private retrievr library, or find a document by name " +
    "across their library and the public corpus. Call it with no arguments when the user asks " +
    "what is in their library, or before a search when they name a document — then pass that " +
    "name to retrievr_search's `documents` argument to search only it.",
  inputSchema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description:
          "A title, filename or id to look for, in the user's library and the public corpus. " +
          "Omit it to list the user's own library.",
      },
    },
    required: [],
    additionalProperties: false,
  },
};

const DELETE_TOOL = {
  name: "retrievr_delete_document",
  title: "Delete a retrievr document",
  description:
    "Permanently remove one of the user's own uploaded documents, freeing its place in their " +
    "library (the library holds twenty). This cannot be undone and there is no trash, so before " +
    "calling it: find the document with retrievr_documents, say its exact title back to the " +
    "user, and delete only the id they confirm. Never guess an id and never delete as a tidy-up. " +
    "Documents from the public corpus cannot be deleted.",
  inputSchema: {
    type: "object",
    properties: {
      doc_id: {
        type: "string",
        description:
          "The id of the document to delete, exactly as retrievr_documents returned it " +
          "(for example lib:22a615eb-e7ae-4ef4-9d9a-baecbf720dae).",
      },
    },
    required: ["doc_id"],
    additionalProperties: false,
  },
};

async function handle(message) {
  const { id, method, params } = message;

  if (method === "initialize") {
    const asked = params?.protocolVersion;
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: SUPPORTED_PROTOCOL_VERSIONS.includes(asked)
          ? asked
          : LATEST_PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: VERSION },
      },
    };
  }

  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    return { jsonrpc: "2.0", id, result: { tools: [TOOL, DOCUMENTS_TOOL, DELETE_TOOL] } };
  }

  if (method === "tools/call") {
    const tool = params?.name;
    if (tool !== TOOL_NAME && tool !== DOCUMENTS_TOOL.name && tool !== DELETE_TOOL.name) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${String(tool)}` },
      };
    }

    if (tool === DOCUMENTS_TOOL.name) {
      return {
        jsonrpc: "2.0",
        id,
        result: await documentsResult(params?.arguments?.query),
      };
    }

    if (tool === DELETE_TOOL.name) {
      return {
        jsonrpc: "2.0",
        id,
        result: await deleteResult(params?.arguments?.doc_id),
      };
    }

    const query = typeof params?.arguments?.query === "string" ? params.arguments.query.trim() : "";
    if (query === "") {
      return { jsonrpc: "2.0", id, result: textResult("retrievr: a query is required.", true) };
    }
    const rawK = params?.arguments?.k;
    const k = Number.isInteger(rawK) ? rawK : DEFAULT_K;

    const scoped = await scopeFor(params?.arguments);
    if (scoped.error !== undefined) {
      return { jsonrpc: "2.0", id, result: textResult(scoped.error, true) };
    }

    // The check was started at startup and has at most three seconds to answer,
    // so this costs the first call the *difference* between the two waits rather
    // than their sum. It is also the only place the notice can be delivered: stderr
    // goes to a log nobody reads, and a harness shows the model the tool result.
    const [outcome, latest] = await Promise.all([search(query, k, scoped.scope), updateCheck]);
    const text = outcome.ok ? format(outcome.results, outcome.retrieval_ms) : outcome.message;
    const notice = updateNotice(latest);
    // The scope line is appended to a *successful* answer only: on a failure the
    // message already says what went wrong, and "scope: documents" beside "nothing
    // retrieved" reads as if the scope were the reason.
    const body = [text, outcome.ok ? scoped.note : undefined, notice].filter(Boolean).join("\n\n");

    return {
      jsonrpc: "2.0",
      id,
      result: textResult(body, !outcome.ok),
    };
  }

  // Notifications carry no id and are answered by silence.
  if (id === undefined) return undefined;

  return {
    jsonrpc: "2.0",
    id,
    error: { code: -32601, message: `method not found: ${String(method)}` },
  };
}

function write(message) {
  if (message !== undefined) process.stdout.write(`${JSON.stringify(message)}\n`);
}

// Serialized: a tools/call can take seconds, and two answers must not interleave
// on one line of stdout.
let queue = Promise.resolve();
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

lines.on("line", (line) => {
  const trimmed = line.trim();
  if (trimmed === "") return;

  queue = queue.then(async () => {
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } });
      return;
    }
    try {
      write(await handle(message));
    } catch (cause) {
      // A bug here is ours, not the caller's, and it still has to be told.
      if (message.id !== undefined) {
        write({
          jsonrpc: "2.0",
          id: message.id,
          error: { code: -32603, message: `internal error: ${cause.message}` },
        });
      }
    }
  });
});

// The harness closing the pipe is the client leaving.
lines.on("close", () => queue.finally(() => process.exit(0)));
