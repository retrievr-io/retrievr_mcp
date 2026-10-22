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
//     because one Edge Function request has a 150 s window and an upload on the same
//     GPU must not be able to sit in front of a query — submit, get a job id, poll.
//     A model wants one answer, so the job id never crosses this boundary.
//   * **A failure is a tool result, not a JSON-RPC error.** A JSON-RPC error is
//     what a harness renders as a broken server; a result is what the model reads
//     and acts on. "You have no key yet, here is the line to run" is only useful
//     in the second shape. The one exception is a tool name that does not exist,
//     which is a programming error in the caller.
//
// stdout is the protocol channel. Anything that is not JSON-RPC goes to stderr.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";

/** What this server speaks. The client's own choice is echoed when we know it. */
const SUPPORTED_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18"];
const LATEST_PROTOCOL_VERSION = "2025-06-18";

const SERVER_NAME = "retrievr";

/**
 * What this copy is.
 *
 * The published file is served from a version-pinned path, and the install sheet
 * names this version and its SHA-256 so the human can check what they fetched.
 * The handshake reports the same string. It is the only version string here, so
 * there is nothing for it to drift away from.
 */
const VERSION = "0.2.5";

/**
 * The deployment, unless told otherwise.
 *
 * Defaulted rather than required, because the alternative is a `mcp.json` entry
 * carrying an environment variable that a customer has to get right before the
 * tool works at all. This must name the live project: a stale default sends a
 * fresh key to the wrong backend and comes back 401 invalid_api_key. A test pins
 * it to the deployed functions origin in the frontend's environment.
 */
const DEFAULT_BASE_URL = "https://xihzxccadrvfvymspepx.supabase.co/functions/v1";

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

/**
 * The library's own limits, repeated here for one reason each.
 *
 * The server decides what may be uploaded — the gate, the type, the archive rule,
 * the cap — and these are not a second opinion on any of that. They exist because a
 * file has to be read from this machine *before* the server can refuse it wrongly
 * sized, and reading twenty-one files or a gigabyte to be told no is a cost paid
 * before the sentence arrives. The type and the archive are deliberately absent:
 * the init is one small request, so the server's message about a `.docx` reaches
 * the model without this file growing a copy of the extractor's allowlist.
 */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;
const MAX_FILES_PER_DROP = 20;

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
  "No retrievr key on this machine yet, so nothing was sent.",
  "Run the connect step from https://retrievr.io/install: it writes the key to",
  "~/.config/retrievr/credentials and never prints it. This tool will work on the",
  "next call — it reads the key each time and does not need restarting.",
].join(" ");

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

// --- putting a file in --------------------------------------------------------

/** Bytes as a person says them, matching the server's own sentence. */
function megabytes(bytes) {
  return (bytes / 1024 / 1024).toFixed(1);
}

/**
 * The local half of a drop: the paths exist, are files, are small enough to read,
 * and there are not too many.
 *
 * Everything else — the gate, the type, the archive rule, the cap — is the
 * server's, because those are the library's rules and a second copy here would be
 * a second answer. This runs before a byte is read, so a refusal is cheap.
 */
function localPlan(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    return { error: "retrievr: paths must be a non-empty list of local file paths." };
  }
  if (paths.length > MAX_FILES_PER_DROP) {
    return {
      error: `retrievr: a drop carries at most ${MAX_FILES_PER_DROP} files. Nothing was uploaded.`,
    };
  }

  const files = [];
  for (const entry of paths) {
    const named = typeof entry === "string" ? entry.trim() : "";
    if (named === "") {
      return { error: "retrievr: every path must be a non-empty string." };
    }
    // A model writes `~/lease.pdf` because that is how a person says it, and there
    // is no shell here to expand it.
    const path = named.startsWith("~/") ? join(homedir(), named.slice(2)) : named;

    let stats;
    try {
      stats = statSync(path);
    } catch (cause) {
      return {
        error:
          `retrievr: could not read ${path} (${cause.code ?? cause.message}). ` +
          "Pass a path that exists on this machine and that you can read, as the user named it.",
      };
    }
    if (!stats.isFile()) {
      return { error: `retrievr: ${path} is not a file.` };
    }
    if (stats.size > MAX_DOCUMENT_BYTES) {
      return {
        error: `retrievr: ${basename(path)} is ${megabytes(stats.size)} MB. The limit is 50 MB.`,
      };
    }
    files.push({ path, filename: basename(path), bytes: stats.size });
  }

  return { files };
}

/**
 * The server's sentence for a refusal, or the status read as best we can.
 *
 * Every refusal in the library flow carries a `message` written for the person who
 * caused it, and the agent's job is to read it back rather than reword it. The
 * fallback exists for the day a response has a code and no sentence.
 */
async function refusalMessage(response) {
  const body = await response.json().catch(() => ({}));
  return typeof body?.message === "string" && body.message !== ""
    ? body.message
    : explain(response.status, typeof body?.error === "string" ? body.error : "");
}

/**
 * `retrievr_upload`: read files from this machine and put them in the library.
 *
 * The bytes never cross the tool boundary. The model names paths, this process
 * reads the files and sends them to Storage on the signed URLs the init minted, and
 * what comes back is an upload id and a sentence — which is the whole reason this
 * is a tool and not the two raw HTTP calls, in the same way the search pair is.
 *
 * One call is one drop, so the server's all-or-nothing rule applies to every file
 * in it: if one is refused at the init, none of them is sent.
 */
async function uploadResult(rawPaths) {
  const key = apiKey();
  if (key === undefined) return textResult(NO_KEY, true);

  const planned = localPlan(rawPaths);
  if (planned.error !== undefined) return textResult(planned.error, true);

  const headers = { "content-type": "application/json", authorization: `Bearer ${key}` };

  let initResponse;
  try {
    initResponse = await fetch(`${baseUrl()}/library-upload`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        files: planned.files.map((file) => ({ filename: file.filename, byte_size: file.bytes })),
      }),
    });
  } catch (cause) {
    return textResult(`retrievr: could not reach the service (${cause.message}).`, true);
  }

  if (initResponse.status !== 202) {
    return textResult(await refusalMessage(initResponse), true);
  }

  const init = await initResponse.json().catch(() => null);
  if (
    init === null ||
    typeof init.upload_id !== "string" ||
    !Array.isArray(init.uploads) ||
    init.uploads.length !== planned.files.length
  ) {
    return textResult(
      "retrievr: the service did not answer with somewhere to put the files. Nothing was uploaded.",
      true,
    );
  }

  // The init lists the files in the order they were sent (`planDrop` keeps it), so
  // an index pairs a signed URL with the path it was minted for.
  for (const [index, target] of init.uploads.entries()) {
    const file = planned.files[index];

    let bytes;
    try {
      bytes = readFileSync(file.path);
    } catch (cause) {
      return textResult(
        `retrievr: could not read ${file.filename} (${cause.message}). Nothing was uploaded.`,
        true,
      );
    }

    let sent;
    try {
      sent = await fetch(target.url, {
        method: "PUT",
        headers: { "content-type": target.content_type, "x-upsert": "false" },
        body: bytes,
      });
    } catch (cause) {
      return textResult(
        `retrievr: ${file.filename} could not be sent (${cause.message}). Nothing was added.`,
        true,
      );
    }
    if (!sent.ok) {
      return textResult(
        `retrievr: ${file.filename} could not be sent (storage answered ${sent.status}). Nothing was added.`,
        true,
      );
    }
  }

  let commitResponse;
  try {
    commitResponse = await fetch(`${baseUrl()}/library-upload/${init.upload_id}`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        files: init.uploads.map((upload) => ({ filename: upload.filename, path: upload.path })),
      }),
    });
  } catch (cause) {
    return textResult(`retrievr: lost the service before the upload finished (${cause.message}).`, true);
  }

  if (commitResponse.status !== 202) {
    return textResult(await refusalMessage(commitResponse), true);
  }
  // The body names the jobs the commit made; the model needs the upload id, not one
  // id per file, so it is read and dropped rather than forwarded.
  await commitResponse.body?.cancel();

  const files = planned.files.map((file) => `  ${file.filename}`);
  return textResult(
    [
      `Sent ${planned.files.length} file${planned.files.length === 1 ? "" : "s"} to retrievr. ` +
        "Embedding has started — they are not searchable until it finishes.",
      ...files,
      "",
      `Upload id: ${init.upload_id}`,
      "Call retrievr_upload_status with that upload_id to see when they are ready " +
        "(a large PDF can take a few minutes). Until then retrievr_documents shows " +
        "them as not retrievable yet.",
    ].join("\n"),
  );
}

/**
 * The sentence for a failed job, from the row the worker wrote.
 *
 * The worker's own `error` is the better text and is preferred. `error_code` is the
 * fallback for a row that failed before it could say why, and a code still tells the
 * model more than "failed" does.
 */
function failureOf(job) {
  const reason = typeof job.error === "string" && job.error !== ""
    ? job.error
    : typeof job.error_code === "string" && job.error_code !== ""
      ? job.error_code
      : "no reason was recorded";
  return `${job.filename}: ${reason}`;
}

/**
 * One drop, as an agent reads it: how much is done, and what failed and why.
 *
 * A success is one line and a failure is named, which is the bell's rule (§8.3) in
 * text: the thing that needs action must not be buried under the twenty that
 * worked.
 */
function uploadGroupText(uploadId, jobs) {
  const ready = jobs.filter((job) => job.status === "ready").length;
  const failed = jobs.filter((job) => job.status === "failed").length;
  const pending = jobs.length - ready - failed;

  const headline =
    pending > 0
      ? `${ready + failed} of ${jobs.length} settled; ${pending} still embedding.`
      : failed > 0
        ? ready === 0
          ? `All ${failed} file${failed === 1 ? "" : "s"} failed — nothing was added.`
          : `${failed} of ${jobs.length} files failed; ${ready} ready.`
        : `All ${ready} document${ready === 1 ? "" : "s"} ready and searchable.`;

  const lines = [`Upload ${uploadId}: ${headline}`];
  for (const job of jobs) {
    if (job.status === "failed") lines.push(`  - ${failureOf(job)}`);
  }
  if (failed > 0) {
    lines.push(
      "Failed files were not added and hold no place in the library, so they can be sent again.",
    );
  }
  if (pending > 0) {
    lines.push("Call this tool again in a minute to see the rest.");
  }
  return lines.join("\n");
}

/**
 * `retrievr_upload_status`: what became of an upload.
 *
 * The upload id is the drop's; with no id this answers for the tenant's most recent
 * jobs, because an agent that has lost the id can still find out what happened. The
 * grouping is by upload, newest first — one drop is one answer, not one per file.
 */
async function uploadStatusResult(rawUploadId) {
  const key = apiKey();
  if (key === undefined) return textResult(NO_KEY, true);

  const uploadId = typeof rawUploadId === "string" ? rawUploadId.trim() : "";
  const query = uploadId === "" ? "" : `?upload_id=${encodeURIComponent(uploadId)}`;

  let response;
  try {
    response = await fetch(`${baseUrl()}/library-upload${query}`, {
      headers: { authorization: `Bearer ${key}` },
    });
  } catch (cause) {
    return textResult(`retrievr: could not reach the service (${cause.message}).`, true);
  }

  if (response.status === 404) {
    return textResult(
      `retrievr: no upload of the user's has the id ${uploadId}. ` +
        "Call this tool with no argument to see their recent uploads.",
      true,
    );
  }
  if (!response.ok) {
    return textResult(await refusalMessage(response), true);
  }

  const body = await response.json().catch(() => ({}));
  const jobs = Array.isArray(body?.jobs) ? body.jobs : [];
  if (jobs.length === 0) {
    return textResult(
      uploadId === ""
        ? "The user has not uploaded anything to retrievr yet. Call retrievr_upload with the paths they named."
        : `No jobs were recorded for upload ${uploadId}.`,
    );
  }

  const groups = new Map();
  for (const job of jobs) {
    const group = groups.get(job.upload_id) ?? [];
    group.push(job);
    groups.set(job.upload_id, group);
  }

  return textResult(
    [...groups.entries()].map(([id, group]) => uploadGroupText(id, group)).join("\n\n"),
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
    "about a document retrievr may hold, and cite the fields it returns. Carry the licence with " +
    "any quotation, and if a result has no licence, cite its span instead of reproducing the " +
    "text. By default this searches the user's own documents *and* the public corpus together; " +
    'pass scope: "private" to search only their documents (when the question is about their ' +
    "documents alone — a comparison needs the default), scope: \"public\" for only the open " +
    'corpus, or documents: ["a title or id"] to search one document or a list of them (use ' +
    "retrievr_documents to find the names). An empty result is an answer: if a private search " +
    "finds nothing, say so rather than re-running it wider.",
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

const UPLOAD_TOOL = {
  name: "retrievr_upload",
  title: "Upload documents to retrievr",
  description:
    "Add the user's own files to their private retrievr library, where their searches can find " +
    "them with citations. Pass the local paths of files the user named. This server reads each " +
    "file and sends it straight to retrievr, so its contents never pass through the conversation. " +
    "Accepts PDF, EPUB, plain text and Markdown, up to 50 MB each. Uploading is free: " +
    "the account's first five documents need no payment, and after that a $5 top-up " +
    "unlocks the rest. Embedding is asynchronous: this returns an upload id, and retrievr_upload_status says " +
    "when the documents are ready to search. Never upload a file the user did not ask for.",
  inputSchema: {
    type: "object",
    properties: {
      paths: {
        type: "array",
        items: { type: "string" },
        description:
          "Local paths of the files to upload, as the user named them. A leading ~/ is " +
          "expanded. One call is one drop: if any file is refused, none of them is added.",
      },
    },
    required: ["paths"],
    additionalProperties: false,
  },
};

const UPLOAD_STATUS_TOOL = {
  name: "retrievr_upload_status",
  title: "Check a retrievr upload",
  description:
    "Check what happened to files uploaded with retrievr_upload: how many are ready to search, how " +
    "many are still embedding, and which failed and why. Call it with the upload_id retrievr_upload " +
    "returned, or with no argument to see the user's most recent uploads. A failed file was not " +
    "added and holds no place in the library, so it can be sent again.",
  inputSchema: {
    type: "object",
    properties: {
      upload_id: {
        type: "string",
        description:
          "The upload id retrievr_upload returned. Omit it to see the user's most recent uploads.",
      },
    },
    required: [],
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
    return {
      jsonrpc: "2.0",
      id,
      result: { tools: [TOOL, DOCUMENTS_TOOL, DELETE_TOOL, UPLOAD_TOOL, UPLOAD_STATUS_TOOL] },
    };
  }

  if (method === "tools/call") {
    const tool = params?.name;
    const known = [
      TOOL_NAME,
      DOCUMENTS_TOOL.name,
      DELETE_TOOL.name,
      UPLOAD_TOOL.name,
      UPLOAD_STATUS_TOOL.name,
    ];
    if (!known.includes(tool)) {
      return {
        jsonrpc: "2.0",
        id,
        error: { code: -32602, message: `unknown tool: ${String(tool)}` },
      };
    }

    if (tool === UPLOAD_TOOL.name) {
      return {
        jsonrpc: "2.0",
        id,
        result: await uploadResult(params?.arguments?.paths),
      };
    }

    if (tool === UPLOAD_STATUS_TOOL.name) {
      return {
        jsonrpc: "2.0",
        id,
        result: await uploadStatusResult(params?.arguments?.upload_id),
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

    const outcome = await search(query, k, scoped.scope);
    const text = outcome.ok ? format(outcome.results, outcome.retrieval_ms) : outcome.message;
    // The scope line is appended to a *successful* answer only: on a failure the
    // message already says what went wrong, and "scope: documents" beside "nothing
    // retrieved" reads as if the scope were the reason.
    const body = [text, outcome.ok ? scoped.note : undefined].filter(Boolean).join("\n\n");

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

// --- the explicit update path ------------------------------------------------
//
// There is no background check. A copy of this file runs on a customer's machine
// and must not phone home on its own, so updating is something a person asks for:
//
//   node mcp.mjs --version          what this copy is
//   node mcp.mjs --check-update     asks retrievr.io once, now, because you asked
//
// The feed is our own origin, not a branch and not a third party. It names the
// current version, the pinned path and the SHA-256 the install sheet prints.
const RELEASE_FEED_URL =
  process.env.RETRIEVR_MCP_UPDATE_FEED ?? "https://retrievr.io/mcp/release.json";

/** Part by part, numerically: 0.10.0 is newer than 0.9.0, which a string compare gets wrong. */
function isNewer(candidate, current) {
  const [a, b] = [candidate, current].map((version) => version.split(".").map(Number));
  for (let part = 0; part < 3; part += 1) {
    if (a[part] !== b[part]) return a[part] > b[part];
  }
  return false;
}

/** The published release, read only when a human runs `--check-update`. */
async function checkForUpdate() {
  const response = await fetch(RELEASE_FEED_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`the release feed answered HTTP ${response.status}`);

  const release = await response.json();
  if (!/^\d+\.\d+\.\d+$/.test(release?.version ?? "")) {
    throw new Error("the release feed did not name a version");
  }
  return release;
}

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--version")) {
    process.stdout.write(`${SERVER_NAME} ${VERSION}\n`);
    return;
  }

  if (args.includes("--check-update")) {
    try {
      const release = await checkForUpdate();
      const verdict = isNewer(release.version, VERSION)
        ? `${release.version} is available — this copy is ${VERSION}. ` +
          "Update it by re-running https://retrievr.io/install."
        : "up to date.";
      process.stdout.write(`${SERVER_NAME} ${VERSION} — ${verdict}\n`);
      if (release.path !== undefined) {
        process.stdout.write(`  ${release.path}  sha256 ${release.sha256 ?? "unknown"}\n`);
      }
    } catch (cause) {
      // Explicit means the failure is visible: this ran because someone asked.
      process.stderr.write(`${SERVER_NAME}: could not check for updates: ${cause.message}\n`);
      process.exit(1);
    }
    return;
  }

  serve();
}

// The stdio server, started only when no flag asked for something else.
function serve() {
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
}

main();
