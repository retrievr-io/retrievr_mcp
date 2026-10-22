// The MCP server, spoken to the way a harness speaks to it.
//
// These are protocol tests, not plumbing tests: they spawn the real server as a
// child process and put real JSON-RPC on its stdin, because the failure this
// file exists to catch is a handshake that looks fine in isolation and leaves a
// harness unable to see the tool. The upstream is a stub, so nothing here needs
// a key, a balance or a network.
//
// Four claims, and the last two are the ones that matter on camera:
//   * a harness can initialize the server and see its tool;
//   * a query comes back as cited passages;
//   * a machine with no key gets a sentence it can act on, not a stack trace;
//   * a spent balance says so rather than returning an empty result.
//
// And four about distribution: the default backend is the deployed one, the
// published copy is byte-for-byte the source with the checksum the install sheet
// names, the server reaches for no branch, and it checks for updates only when a
// human runs `--check-update`. A copy of this file runs with a customer's key and
// filesystem access, so it must not fetch code or phone home on its own.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const SERVER = resolve(import.meta.dirname, "mcp.mjs");
const execFileAsync = promisify(execFile);

/**
 * Whether this checkout is the frontend, or the mirror published from it.
 *
 * `mcp.mjs` and this file are also published to `retrievr-io/retrievr_mcp`, and the
 * two suites that check distribution below read `../README.md`, `../mcp-release.json`
 * and `../public/mcp/` — none of which exist in the mirror. They skip there instead
 * of failing: a test file that cannot pass in the mirror cannot be published to it,
 * and `sync-to-retrievr-mcp.sh` runs this file as its gate before pushing.
 */
const HAS_FRONTEND = existsSync(new URL("../mcp-release.json", import.meta.url));
const FRONTEND_ONLY = "only in the frontend checkout, where the copy is published from";

/**
 * The version the server reports, read out of the server rather than written here.
 *
 * The published copy and `mcp-release.json` are pinned to it, so a bump has to move
 * all three together. Reading it from the source makes the test assert that instead
 * of comparing a hardcoded copy against itself.
 */
const VERSION = /^const VERSION = "(.+)";$/m.exec(readFileSync(SERVER, "utf8"))?.[1];
assert.equal(typeof VERSION, "string", "mcp.mjs has no VERSION to test against");

const RESULT = {
  chunk_id: "158678",
  text: "  When in the Course of human events, it becomes necessary for one people to dissolve\n  the political bands which have connected them with another.  ",
  title: "The Declaration of Independence of the United States of America",
  author: "Jefferson, Thomas, 1743-1826",
  section_path: "THE DECLARATION > IN CONGRESS",
  doc_id: "pg:1",
  chunk_index: 3,
  char_start: 2938,
  char_end: 4471,
  parent_start: 2938,
  parent_end: 4471,
  licence: "public_domain",
  score: 0.0163934426229508,
};

/** A document in the caller's own library, as `GET /documents` answers it. */
const LIBRARY_DOCUMENT = {
  id: "lib:22a615eb-e7ae-4ef4-9d9a-baecbf720dae",
  title: "project-proposal.pdf",
  filename: "project-proposal.pdf",
  source: "library",
  passages: 12,
};

/** A document from the open corpus. */
const PUBLIC_DOCUMENT = {
  id: "pg:78",
  title: "Tarzan of the Apes",
  filename: "78",
  source: "public",
  passages: 381,
};

/** A stub of the three function endpoints, with a mode the tests can set. */
async function startUpstream() {
  const state = {
    mode: "ok",
    submitted: 0,
    polled: 0,
    // What the last search actually put on the wire. A scope is the one argument
    // whose absence and default are dangerous to confuse, so the tests read the body
    // rather than trusting the tool's own report of what it did.
    lastBody: null,
    documentQueries: [],
    // Deletions the stub was asked for, and whether the id it was given is one it
    // knows. A `404` here stands in for both "no such document" and "not yours".
    deleted: [],
    // Uploads: what the stub was asked to start, the bytes it received, what it was
    // asked to commit, and the jobs a status call reports. `uploadMode` is how a
    // test makes the init refuse.
    uploadStarted: [],
    uploadedBytes: [],
    uploadCommitted: [],
    uploadMode: "ok",
    jobs: [],
    library: [LIBRARY_DOCUMENT],
    matches: {
      "Tarzan of the Apes": [PUBLIC_DOCUMENT],
      tarzan: [PUBLIC_DOCUMENT],
      "project-proposal.pdf": [LIBRARY_DOCUMENT],
    },
  };

  const readBody = (request) =>
    new Promise((done) => {
      let text = "";
      request.on("data", (chunk) => {
        text += chunk;
      });
      request.on("end", () => done(text));
    });

  // Bytes, not text: the point of the upload path is that the file arrives whole,
  // and decoding it as a string would hide a truncated or re-encoded body.
  const readBytes = (request) =>
    new Promise((done) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => done(Buffer.concat(chunks)));
    });

  const server = createServer(async (request, response) => {
    const send = (status, body) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (request.method === "POST" && request.url === "/retrieve") {
      state.submitted += 1;
      const text = await readBody(request);
      state.lastBody = text === "" ? null : JSON.parse(text);
      if (state.mode === "spent") return send(402, { error: "insufficient_credit" });
      if (state.mode === "revoked") return send(401, { error: "invalid_api_key" });
      return send(202, { job_id: "job-1", status: "pending", interval: 0 });
    }
    if (request.method === "GET" && request.url === "/retrieve-job/job-1") {
      state.polled += 1;
      return send(200, {
        status: "complete",
        results: [state.result ?? RESULT],
        retrieval_ms: 123,
      });
    }
    // The upload door: init (POST the collection), commit (POST the upload id), and
    // the agent's status call (GET, one upload or the recent ones). The signed URLs
    // point back at this stub, so a PUT is observable here.
    if (request.url.startsWith("/library-upload")) {
      const url = new URL(request.url, "http://upstream");
      const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";

      if (request.method === "GET") {
        const uploadId = url.searchParams.get("upload_id") ?? "";
        const jobs = state.jobs.filter(
          (job) => uploadId === "" || job.upload_id === uploadId,
        );
        return send(200, { upload_id: uploadId === "" ? null : uploadId, jobs });
      }

      if (request.method !== "POST") return send(405, { error: "method_not_allowed" });
      const body = JSON.parse(await readBody(request));

      if (tail !== "library-upload") {
        state.uploadCommitted.push(body);
        return send(202, {
          upload_id: tail,
          jobs: body.files.map((file, index) => ({ id: `job-${index}`, filename: file.filename })),
        });
      }

      state.uploadStarted.push(body);
      if (state.uploadMode === "not_funded") {
        return send(403, {
          error: "uploads_not_enabled",
          message:
            "A library starts with 5 free documents. Add $5 of credit at " +
            "https://retrievr.io/profile to upload more.",
        });
      }
      if (state.uploadMode === "unsupported") {
        return send(415, {
          error: "unsupported_type",
          message: `${body.files[0].filename} cannot be read. Accepted: PDF, EPUB, plain text and Markdown.`,
        });
      }

      const uploadId = "upload-1";
      const origin = `http://127.0.0.1:${server.address().port}`;
      return send(202, {
        upload_id: uploadId,
        bucket: "library",
        uploads: body.files.map((file, index) => ({
          filename: file.filename,
          path: `tenant/${uploadId}/${index}-${file.filename}`,
          content_type: "text/markdown",
          url: `${origin}/storage/${uploadId}/${index}`,
        })),
      });
    }

    if (request.method === "PUT" && request.url.startsWith("/storage/")) {
      const bytes = await readBytes(request);
      state.uploadedBytes.push({
        url: request.url,
        bytes: bytes.length,
        text: bytes.toString("utf8"),
        contentType: request.headers["content-type"],
      });
      return send(200, {});
    }

    // The naming route: no `q` is the whole library, `q` is a lookup across the
    // caller's library and the public corpus. A path id is a deletion.
    if (request.url.startsWith("/documents")) {
      const url = new URL(request.url, "http://upstream");
      const tail = url.pathname.split("/").filter(Boolean).pop() ?? "";

      if (tail !== "documents") {
        if (request.method !== "DELETE") return send(405, { error: "method_not_allowed" });
        const id = decodeURIComponent(tail);
        state.deleted.push(id);
        // Only the library's own document can be deleted; anything else is as
        // absent as another tenant's document is.
        if (id !== LIBRARY_DOCUMENT.id) return send(404, { error: "not_found" });
        return send(200, { id, storage_removed: true });
      }

      if (request.method !== "GET") return send(405, { error: "method_not_allowed" });
      const q = url.searchParams.get("q") ?? "";
      state.documentQueries.push(q);
      return send(200, {
        query: q === "" ? null : q,
        documents: q === "" ? state.library : (state.matches[q] ?? []),
      });
    }
    send(404, { error: "not_found" });
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((done) => server.close(done)),
  };
}

/** The server as a child process, with a request/response helper over its stdio. */
function startClient({
  url,
  key,
  // Isolated by default: a client that inherited the real home directory would
  // read and write the operator's own ~/.config/retrievr on every test run.
  configDir = mkdtempSync(join(tmpdir(), "retrievr-cfg-")),
  env = {},
}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      RETRIEVR_FUNCTIONS_URL: url,
      RETRIEVR_API_KEY: key ?? "",
      RETRIEVR_CONFIG_DIR: configDir,
      ...env,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });

  const pending = new Map();
  let buffer = "";
  let stderr = "";
  let nextId = 1;

  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline === -1) break;
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (line === "") continue;
      const message = JSON.parse(line);
      const settle = pending.get(message.id);
      if (settle) {
        pending.delete(message.id);
        settle(message);
      }
    }
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return {
    /** A request, answered. Rejects if the server never answers. */
    async request(method, params) {
      const id = nextId++;
      const answer = new Promise((done, fail) => {
        pending.set(id, done);
        setTimeout(() => fail(new Error(`no answer to ${method}; stderr: ${stderr}`)), 5000);
      });
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return answer;
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    get stderr() {
      return stderr;
    },
    close: () => child.kill(),
  };
}

/** The text of a tool call's result, whichever shape the server answered in. */
function textOf(message) {
  const content = message.result?.content ?? [];
  return content.map((part) => part.text ?? "").join("\n");
}

describe("the retrievr MCP server", async () => {
  let upstream;
  let withKey;
  const emptyConfig = mkdtempSync(join(tmpdir(), "retrievr-nokey-"));

  before(async () => {
    upstream = await startUpstream();
    withKey = startClient({ url: upstream.url, key: "rtv_live_test" });
  });

  after(async () => {
    withKey.close();
    await upstream.close();
  });

  it("initializes, and says who it is", async () => {
    const answer = await withKey.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    assert.equal(answer.result.serverInfo.name, "retrievr");
    // A version the client offered, so a harness is never handed one it did not ask for.
    assert.equal(answer.result.protocolVersion, "2025-06-18");
    assert.equal(typeof answer.result.capabilities.tools, "object");
  });

  it("offers every tool, with the arguments a model needs to see", async () => {
    const answer = await withKey.request("tools/list", {});
    const tools = answer.result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      [
        "retrievr_search",
        "retrievr_documents",
        "retrievr_delete_document",
        "retrievr_upload",
        "retrievr_upload_status",
      ],
    );
    const search = tools[0];
    assert.equal(search.inputSchema.required.includes("query"), true);
    assert.equal(search.inputSchema.properties.query.type, "string");
    // The scope is what the whole private-library feature turns on, so the schema
    // has to offer it — a model cannot ask for a scope it cannot see.
    assert.deepEqual(search.inputSchema.properties.scope.enum, ["all", "public", "private"]);
    assert.equal(search.inputSchema.properties.documents.type, "array");
    // Uploading is paths, not file contents: the bytes are this process's job, and
    // a schema that asked for them would be asking the model to carry the file.
    const upload = tools.find((tool) => tool.name === "retrievr_upload");
    assert.deepEqual(upload.inputSchema.required, ["paths"]);
    assert.equal(upload.inputSchema.properties.paths.type, "array");
    assert.equal(upload.inputSchema.properties.paths.items.type, "string");
  });

  it("answers a query with cited passages", async () => {
    const answer = await withKey.request("tools/call", {
      name: "retrievr_search",
      arguments: { query: "What does the Declaration of Independence say?", k: 5 },
    });
    const text = textOf(answer);
    // The citation is the product: source, author, section, character range, licence.
    assert.match(text, /Declaration of Independence/);
    assert.match(text, /Jefferson, Thomas/);
    assert.match(text, /2938-4471/);
    assert.match(text, /public_domain/);
    // The submit-then-poll pair is the client's problem, not the model's: the tool
    // makes one call and the job id never appears.
    assert.equal(upstream.state.submitted, 1);
    assert.equal(upstream.state.polled, 1);
    assert.doesNotMatch(text, /job-1/);
  });

  it("calls an unknown tool an error, the way the protocol does", async () => {
    const answer = await withKey.request("tools/call", { name: "nope", arguments: {} });
    assert.equal(answer.error.code, -32602);
  });

  it("tells a machine with no key what to do, instead of crashing", async () => {
    const bare = startClient({ url: upstream.url, key: "", configDir: emptyConfig });
    try {
      const answer = await bare.request("tools/call", {
        name: "retrievr_search",
        arguments: { query: "anything" },
      });
      // A result, not a JSON-RPC error: the model has to read the sentence to act
      // on it, and an error object is what a harness shows as a broken server.
      assert.equal(answer.error, undefined);
      assert.match(textOf(answer), /connect|credentials|key/i);
      assert.equal(answer.result.isError, true);
    } finally {
      bare.close();
    }
  });

  it("reads the key at call time, so a key that arrives later still works", async () => {
    // This is what lets the install happen in the same session the tool is used in.
    const dir = mkdtempSync(join(tmpdir(), "retrievr-late-"));
    const late = startClient({ url: upstream.url, key: "", configDir: dir });
    try {
      const before = await late.request("tools/call", {
        name: "retrievr_search",
        arguments: { query: "before" },
      });
      assert.equal(before.result.isError, true);

      writeFileSync(join(dir, "credentials"), "rtv_live_later\n", { mode: 0o600 });

      const after = await late.request("tools/call", {
        name: "retrievr_search",
        arguments: { query: "after" },
      });
      assert.notEqual(after.result.isError, true);
      assert.match(textOf(after), /Declaration of Independence/);
    } finally {
      late.close();
    }
  });

  it("returns a parent passage whole, rather than clipping the quote", async () => {
    // The parent window the chunker records runs to about 1,500 characters, and
    // that passage IS the citation. Clipping it sends the model back to the raw
    // HTTP calls to read the rest — which is the plumbing this tool exists to
    // hide. Observed: a rehearsal where the agent did exactly that.
    const tail = "that mankind are more disposed to suffer, while evils are sufferable";
    upstream.state.result = { ...RESULT, text: `${"THE DECLARATION ".repeat(90)}${tail}` };
    try {
      const answer = await withKey.request("tools/call", {
        name: "retrievr_search",
        arguments: { query: "the whole passage" },
      });
      assert.match(textOf(answer), new RegExp(tail));
    } finally {
      upstream.state.result = undefined;
    }
  });

  it("never clips a passage silently", async () => {
    // If a window ever exceeds the guard, the model has to be able to tell. A
    // silent cut is what sent the rehearsal around the tool; a named one lets the
    // model ask a narrower question or read the range it was given.
    upstream.state.result = { ...RESULT, text: "word ".repeat(4000) };
    try {
      const answer = await withKey.request("tools/call", {
        name: "retrievr_search",
        arguments: { query: "something enormous" },
      });
      assert.match(textOf(answer), /truncated at/i);
      assert.match(textOf(answer), /4471/);
    } finally {
      upstream.state.result = undefined;
    }
  });

  it("says the balance is spent rather than returning nothing", async () => {
    upstream.state.mode = "spent";
    try {
      const answer = await withKey.request("tools/call", {
        name: "retrievr_search",
        arguments: { query: "anything" },
      });
      assert.equal(answer.result.isError, true);
      assert.match(textOf(answer), /balance|credit/i);
    } finally {
      upstream.state.mode = "ok";
    }
  });

  // --- the scope, and naming a document ------------------------------------

  it("sends the scope it was asked for, and sends nothing when it was not", async () => {
    await withKey.request("tools/call", {
      name: "retrievr_search",
      arguments: { query: "only mine", scope: "private" },
    });
    assert.deepEqual(upstream.state.lastBody.scope, { type: "private", ids: [] });
    assert.match(upstream.state.lastBody.query, /only mine/);

    await withKey.request("tools/call", {
      name: "retrievr_search",
      arguments: { query: "everything" },
    });
    // Absent rather than defaulted here: "I forgot the scope" and "search
    // everything" must not look the same on the wire, or a dropped argument
    // silently widens a private search to the whole corpus.
    assert.equal(upstream.state.lastBody.scope, undefined);
  });

  it("refuses a scope it does not have, rather than widening the search", async () => {
    const before = upstream.state.submitted;
    const answer = await withKey.request("tools/call", {
      name: "retrievr_search",
      arguments: { query: "anything", scope: "privat" },
    });
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /scope/i);
    // Nothing was submitted, so nothing was charged for a query nobody could scope.
    assert.equal(upstream.state.submitted, before);
  });

  it("turns a named document into the ids the scope takes", async () => {
    const answer = await withKey.request("tools/call", {
      name: "retrievr_search",
      arguments: { query: "what does it propose?", documents: ["Tarzan of the Apes"] },
    });
    assert.deepEqual(upstream.state.lastBody.scope, { type: "documents", ids: ["pg:78"] });
    // The answer says which documents were searched, so a person can tell a narrow
    // search from a wide one without reading the JSON.
    assert.match(textOf(answer), /scope: documents/);
    assert.match(textOf(answer), /Tarzan of the Apes/);
  });

  it("fails rather than searching wider when a named document does not exist", async () => {
    const before = upstream.state.submitted;
    const answer = await withKey.request("tools/call", {
      name: "retrievr_search",
      arguments: { query: "anything", documents: ["the lease"] },
    });
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /the lease/);
    // And what they do have, so the model recovers without a second guess.
    assert.match(textOf(answer), /project-proposal/);
    // The whole point: a name that resolved to nothing did not become a search of
    // everything.
    assert.equal(upstream.state.submitted, before);
  });

  it("lists the library, and finds a document by name", async () => {
    const listed = await withKey.request("tools/call", {
      name: "retrievr_documents",
      arguments: {},
    });
    assert.match(textOf(listed), /project-proposal\.pdf/);
    assert.match(textOf(listed), /lib:22a615eb/);
    assert.equal(upstream.state.documentQueries.at(-1), "");

    const found = await withKey.request("tools/call", {
      name: "retrievr_documents",
      arguments: { query: "tarzan" },
    });
    assert.match(textOf(found), /Tarzan of the Apes/);
    // Whose it is, because "a book I can search" and "my own file" are different
    // answers to "where did this come from".
    assert.match(textOf(found), /public corpus/);
  });

  // --- deleting a document --------------------------------------------------

  it("deletes the id it was given, and says what happened", async () => {
    const answer = await withKey.request("tools/call", {
      name: "retrievr_delete_document",
      arguments: { doc_id: LIBRARY_DOCUMENT.id },
    });
    assert.notEqual(answer.result.isError, true);
    assert.match(textOf(answer), /Deleted/);
    assert.match(textOf(answer), /lib:22a615eb/);
    // The id reaches the API as a path segment, encoded — `lib:<uuid>` carries a
    // colon, and a colon in the wrong place is a different route.
    assert.deepEqual(upstream.state.deleted, [LIBRARY_DOCUMENT.id]);
  });

  it("cannot delete an id that is not the caller's, and says nothing was", async () => {
    const before = upstream.state.deleted.length;
    const answer = await withKey.request("tools/call", {
      name: "retrievr_delete_document",
      arguments: { doc_id: "lib:00000000-0000-0000-0000-000000000000" },
    });
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /nothing was deleted/i);
    // It was *asked* — the API is what refuses, not the client's opinion of ids.
    assert.equal(upstream.state.deleted.length, before + 1);
  });

  it("refuses an empty id rather than deleting something", async () => {
    const before = upstream.state.deleted.length;
    const answer = await withKey.request("tools/call", {
      name: "retrievr_delete_document",
      arguments: {},
    });
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /doc_id is required/i);
    assert.equal(upstream.state.deleted.length, before);
  });

  // --- uploading a document -------------------------------------------------

  /** A real file on disk, because the tool reads paths rather than bytes from the caller. */
  function tempFile(name, text) {
    const dir = mkdtempSync(join(tmpdir(), "retrievr-upload-"));
    const path = join(dir, name);
    writeFileSync(path, text);
    return path;
  }

  it("uploads a file the user named, and the bytes never enter the conversation", async () => {
    const body = "# The notice period\n\nIt is thirty days.\n";
    const path = tempFile("notes.md", body);

    const answer = await withKey.request("tools/call", {
      name: "retrievr_upload",
      arguments: { paths: [path] },
    });
    const text = textOf(answer);

    assert.notEqual(answer.result.isError, true);
    assert.match(text, /Embedding has started/);
    assert.match(text, /upload-1/);
    // The model gets a filename and an id — not the file. A tool that echoed the
    // document back would have put it in the context it is meant to keep it out of.
    assert.match(text, /notes\.md/);
    assert.doesNotMatch(text, /thirty days/);

    // The three steps, in the server's order: names and sizes, the bytes, the commit.
    assert.deepEqual(upstream.state.uploadStarted.at(-1), {
      files: [{ filename: "notes.md", byte_size: Buffer.byteLength(body) }],
    });
    assert.equal(upstream.state.uploadedBytes.at(-1).text, body);
    assert.equal(upstream.state.uploadedBytes.at(-1).contentType, "text/markdown");
    assert.deepEqual(upstream.state.uploadCommitted.at(-1), {
      files: [{ filename: "notes.md", path: "tenant/upload-1/0-notes.md" }],
    });
  });

  it("refuses a path that is not a file before it calls the service", async () => {
    const before = upstream.state.uploadStarted.length;
    const answer = await withKey.request("tools/call", {
      name: "retrievr_upload",
      arguments: { paths: [join(tmpdir(), "no-such-retrievr-file.pdf")] },
    });
    assert.equal(answer.result.isError, true);
    assert.match(textOf(answer), /could not read/i);
    // Nothing was asked to start, so a typo cannot leave an empty upload behind.
    assert.equal(upstream.state.uploadStarted.length, before);

    // A model writes `~/...`; there is no shell here, so the tool expands it. The
    // message names the path it actually looked for, which is how the model learns
    // whether the file is missing or the path was never resolved.
    const tilde = await withKey.request("tools/call", {
      name: "retrievr_upload",
      arguments: { paths: ["~/no-such-retrievr-file.pdf"] },
    });
    assert.equal(tilde.result.isError, true);
    assert.ok(textOf(tilde).includes(homedir()), "~/ was not expanded to the home directory");
    assert.equal(upstream.state.uploadStarted.length, before);
  });

  it("reads back the server's refusal rather than rewording it", async () => {
    const path = tempFile("contract.pdf", "%PDF-1.4\n");
    const before = upstream.state.uploadedBytes.length;
    upstream.state.uploadMode = "not_funded";
    try {
      const answer = await withKey.request("tools/call", {
        name: "retrievr_upload",
        arguments: { paths: [path] },
      });
      assert.equal(answer.result.isError, true);
      // The sentence names what to do and where, which is what an agent has to relay.
      assert.match(textOf(answer), /\$5/);
      assert.match(textOf(answer), /retrievr\.io\/profile/);
      // Refused at the init means no bytes were read or sent.
      assert.equal(upstream.state.uploadedBytes.length, before);
    } finally {
      upstream.state.uploadMode = "ok";
    }
  });

  it("says where to get a key before it tries to upload", async () => {
    const bare = startClient({ url: upstream.url, key: "", configDir: emptyConfig });
    const path = tempFile("notes.md", "hello");
    try {
      const answer = await bare.request("tools/call", {
        name: "retrievr_upload",
        arguments: { paths: [path] },
      });
      assert.equal(answer.error, undefined);
      assert.equal(answer.result.isError, true);
      assert.match(textOf(answer), /connect|credentials|key/i);
      assert.match(textOf(answer), /nothing was sent/i);
    } finally {
      bare.close();
    }
  });

  it("says what became of an upload, naming the ones that failed", async () => {
    upstream.state.jobs = [
      {
        id: "job-a",
        upload_id: "upload-1",
        filename: "notes.md",
        status: "ready",
        error_code: null,
        error: null,
      },
      {
        id: "job-b",
        upload_id: "upload-1",
        filename: "scan.pdf",
        status: "failed",
        error_code: "no_text",
        error: "scan.pdf contains no extractable text. If it is a scan or images, there is nothing to embed.",
      },
      {
        id: "job-c",
        upload_id: "upload-1",
        filename: "lease.pdf",
        status: "embedding",
        error_code: null,
        error: null,
      },
    ];
    try {
      const answer = await withKey.request("tools/call", {
        name: "retrievr_upload_status",
        arguments: { upload_id: "upload-1" },
      });
      const text = textOf(answer);
      assert.notEqual(answer.result.isError, true);
      // How many settled, how many are still going, and which one needs a human.
      assert.match(text, /2 of 3 settled/);
      assert.match(text, /1 still embedding/);
      assert.match(text, /scan\.pdf: .*no extractable text/i);
      // A failed file holds no place, which is the fact that decides the retry.
      assert.match(text, /can be sent again/i);
    } finally {
      upstream.state.jobs = [];
    }
  });

  it("tells the agent nothing has been uploaded rather than inventing a status", async () => {
    const answer = await withKey.request("tools/call", {
      name: "retrievr_upload_status",
      arguments: {},
    });
    assert.notEqual(answer.result.isError, true);
    assert.match(textOf(answer), /not uploaded anything/i);
  });
});

/**
 * The backend the published copy talks to.
 *
 * It is a hardcoded default because the file has to work with no environment set,
 * and it has already shipped stale once: a key minted against the live project
 * reached the other one and came back 401. README.md names the deployed origin, so
 * the two are pinned together here.
 */
describe("the default backend", { skip: HAS_FRONTEND ? false : FRONTEND_ONLY }, () => {
  it("is the deployment the rest of the product uses", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const deployed = /`RETRIEVR_FUNCTIONS_URL`\s*\|\s*`([^`]+)`/.exec(readme)?.[1];
    assert.ok(deployed, "README.md does not name RETRIEVR_FUNCTIONS_URL");

    const source = readFileSync(SERVER, "utf8");
    const fallback = /^const DEFAULT_BASE_URL = "(.+)";$/m.exec(source)?.[1];
    assert.equal(fallback, deployed);
  });
});

/**
 * Distribution, not behaviour: the file a customer runs is published under its
 * version with a checksum, and the install sheet names both. These tests are what
 * make "pinned" true rather than aspirational.
 */
describe("the published copy", { skip: HAS_FRONTEND ? false : FRONTEND_ONLY }, () => {
  // Read inside the tests rather than at describe time: `describe` registers its
  // callback even when the suite is skipped, and the file it names is not there.
  const release = () =>
    JSON.parse(readFileSync(new URL("../mcp-release.json", import.meta.url), "utf8"));
  const source = readFileSync(SERVER);
  const routeFile = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

  it("is the source, byte for byte", () => {
    const pinned = release();
    assert.equal(pinned.version, VERSION);
    const published = readFileSync(
      new URL(`../public/mcp/v${pinned.version}/mcp.mjs`, import.meta.url),
    );
    assert.ok(
      published.equals(source),
      `public/mcp/v${pinned.version}/mcp.mjs is stale — run node scripts/publish-mcp.mjs`,
    );
  });

  it("carries the checksum the install sheet names", () => {
    const digest = createHash("sha256").update(source).digest("hex");
    assert.equal(release().sha256, digest);
  });

  it("publishes the feed the explicit check reads", () => {
    const feed = JSON.parse(readFileSync(new URL("../public/mcp/release.json", import.meta.url), "utf8"));
    assert.deepEqual(feed, release());
  });

  it("publishes a manifest that is facts, and agrees with the release it names", () => {
    // The install sheet is prose addressed to an agent, and an agent has to treat
    // prose that says "run this" as untrusted. The manifest is the same facts with
    // no verbs, so it can be read and checked instead of obeyed — which only works
    // if it cannot disagree with `mcp-release.json`.
    const manifest = JSON.parse(
      readFileSync(new URL("../public/.well-known/retrievr.json", import.meta.url), "utf8"),
    );
    assert.equal(manifest.name, "retrievr");
    assert.deepEqual(manifest.release, release());
    // Site-relative: the manifest is served from the origin it describes.
    assert.match(manifest.mcp, /^\//);
    assert.match(manifest.docs, /^\//);
    // No instruction, and nothing to execute: every value is a fact or a path.
    for (const value of [manifest.name, manifest.description, manifest.mcp, manifest.docs]) {
      assert.doesNotMatch(String(value), /^(run|install|execute|paste|do|use)\b/i);
    }
  });

  it("reaches for no branch and no background check", () => {
    const text = source.toString("utf8");
    assert.doesNotMatch(text, /raw\.githubusercontent\.com|api\.github\.com/);
    assert.doesNotMatch(text, /RETRIEVR_MCP_LATEST_URL|update-check\.json/);
    assert.match(text, /https:\/\/retrievr\.io\/mcp\/release\.json/);
  });

  it("is installed from this site, at the pinned path", () => {
    const install = routeFile("../app/install/route.ts");
    assert.match(install, /from "@\/mcp-release\.json"/);
    assert.match(install, /release\.path/);
    assert.match(install, /--check-update/);
    assert.doesNotMatch(install, /raw\.githubusercontent\.com|RETRIEVR_MCP_URL/);
  });

  it("is not refreshed by the connect script", () => {
    const connect = routeFile("../app/connect/route.ts");
    assert.doesNotMatch(connect, /raw\.githubusercontent\.com|MCP_URL|refresh_mcp/);
  });
});

/**
 * Updating is deliberate, not automatic.
 *
 * The server must not phone home during a normal session, and the explicit check
 * must work for a human who asks. These tests are the two halves of that promise.
 */
describe("the explicit update path", () => {
  const NEXT_VERSION = (() => {
    const parts = VERSION.split(".").map(Number);
    parts[2] += 1;
    return parts.join(".");
  })();

  /** A release feed on localhost, counting how often it is asked. */
  async function startFeed(release) {
    const state = { asks: 0 };
    const server = createServer((request, response) => {
      state.asks += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(release));
    });
    await new Promise((done) => server.listen(0, "127.0.0.1", done));
    return {
      state,
      url: `http://127.0.0.1:${server.address().port}/release.json`,
      close: () => new Promise((done) => server.close(done)),
    };
  }

  /**
   * The CLI, run asynchronously.
   *
   * Not `spawnSync`: the release feed in these tests is a server in *this*
   * process, and a synchronous child would block the event loop that has to
   * answer it. The check would then time out against a server that is right here.
   */
  async function run(args, feed) {
    try {
      const { stdout, stderr } = await execFileAsync(process.execPath, [SERVER, ...args], {
        env: { ...process.env, RETRIEVR_MCP_UPDATE_FEED: feed ?? "http://127.0.0.1:9/release.json" },
        encoding: "utf8",
        timeout: 10000,
      });
      return { status: 0, stdout, stderr };
    } catch (cause) {
      return {
        status: typeof cause.code === "number" ? cause.code : 1,
        stdout: cause.stdout ?? "",
        stderr: cause.stderr ?? "",
      };
    }
  }

  it("says what this copy is, without touching the network", async () => {
    const answer = await run(["--version"]);
    assert.equal(answer.status, 0);
    assert.equal(answer.stdout.trim(), `retrievr ${VERSION}`);
  });

  it("names the newer release when a human asks", async () => {
    const feed = await startFeed({
      version: NEXT_VERSION,
      sha256: "a".repeat(64),
      path: `/mcp/v${NEXT_VERSION}/mcp.mjs`,
    });
    try {
      const answer = await run(["--check-update"], feed.url);
      assert.equal(answer.status, 0);
      assert.match(answer.stdout, new RegExp(`${NEXT_VERSION} is available`));
      assert.match(answer.stdout, new RegExp(`this copy is ${VERSION.replaceAll(".", "\\.")}`));
      assert.match(answer.stdout, /https:\/\/retrievr\.io\/install/);
      assert.match(answer.stdout, new RegExp(`/mcp/v${NEXT_VERSION.replaceAll(".", "\\.")}/mcp\\.mjs`));
      assert.equal(feed.state.asks, 1);
    } finally {
      await feed.close();
    }
  });

  it("says up to date when this copy is the latest", async () => {
    const feed = await startFeed({ version: VERSION, sha256: "a".repeat(64), path: "/mcp/x" });
    try {
      const answer = await run(["--check-update"], feed.url);
      assert.equal(answer.status, 0);
      assert.match(answer.stdout, /up to date/);
    } finally {
      await feed.close();
    }
  });

  it("shows the failure when the explicit check cannot answer", async () => {
    const answer = await run(["--check-update"], "http://127.0.0.1:9/release.json");
    assert.equal(answer.status, 1);
    assert.match(answer.stderr, /could not check for updates/);
  });

  it("does not check at all during a normal session", async () => {
    const feed = await startFeed({ version: NEXT_VERSION, sha256: "a".repeat(64), path: "/mcp/x" });
    const upstream = await startUpstream();
    const client = startClient({
      url: upstream.url,
      key: "rtv_live_test",
      env: { RETRIEVR_MCP_UPDATE_FEED: feed.url },
    });
    try {
      await client.request("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "test", version: "1" },
      });
      // Starting up and shaking hands is not a reason to ask anything.
      assert.equal(feed.state.asks, 0);
    } finally {
      client.close();
      await upstream.close();
      await feed.close();
    }
  });
});
