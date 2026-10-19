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
// And five more for the update check, which is the one thing here that talks to a
// service this product does not own: a customer's copy is a *copy*, and a copy
// that never learns it is behind is what the check exists to fix. The rest of
// those tests are about the check staying invisible when it cannot answer.
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";

const SERVER = resolve(import.meta.dirname, "mcp.mjs");

/**
 * The version the server reports, read out of the server rather than written here.
 *
 * A hardcoded copy is how these tests go quietly vacuous: bump the release and the
 * "stays quiet when this copy is the latest" case starts passing because the copy is
 * now *newer* than the feed, which asserts nothing. Read this way, a bump moves the
 * tests with it — the same extraction the sync script does before it publishes.
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
  releaseUrl,
}) {
  const child = spawn(process.execPath, [SERVER], {
    env: {
      ...process.env,
      RETRIEVR_FUNCTIONS_URL: url,
      RETRIEVR_API_KEY: key ?? "",
      RETRIEVR_CONFIG_DIR: configDir,
      // Offline unless a test says otherwise. The real endpoint is api.github.com,
      // and a suite that asked it once per spawn would be rate-limited and flaky by
      // turns. Port 9 is discard: it refuses immediately.
      RETRIEVR_MCP_LATEST_URL: releaseUrl ?? "http://127.0.0.1:9/releases/latest",
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

  it("offers the search tool and the naming tool", async () => {
    const answer = await withKey.request("tools/list", {});
    const tools = answer.result.tools;
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["retrievr_search", "retrievr_documents", "retrievr_delete_document"],
    );
    const search = tools[0];
    assert.equal(search.inputSchema.required.includes("query"), true);
    assert.equal(search.inputSchema.properties.query.type, "string");
    // The scope is what the whole private-library feature turns on, so the schema
    // has to offer it — a model cannot ask for a scope it cannot see.
    assert.deepEqual(search.inputSchema.properties.scope.enum, ["all", "public", "private"]);
    assert.equal(search.inputSchema.properties.documents.type, "array");
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
});

/** A stub of GitHub's latest-release endpoint, counting how often it is asked. */
async function startReleaseFeed({ mode = "newer" } = {}) {
  const state = { asks: 0 };

  const server = createServer((request, response) => {
    state.asks += 1;
    if (!request.url.startsWith("/releases/latest")) {
      return response.writeHead(404, { "content-type": "application/json" }).end("{}");
    }
    if (mode === "broken") {
      return response.writeHead(500, { "content-type": "application/json" }).end("{}");
    }
    // "unreadable" is a tag that is not a version — a nightly, say. A tag nobody
    // can compare is a tag to say nothing about.
    const tag_name = mode === "newer" ? "v0.2.0" : mode === "current" ? `v${VERSION}` : "nightly";
    return response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ tag_name }));
  });

  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  return {
    state,
    url: `http://127.0.0.1:${server.address().port}/releases/latest`,
    close: () => new Promise((done) => server.close(done)),
  };
}

describe("the update check", async () => {
  let upstream;

  before(async () => {
    upstream = await startUpstream();
  });

  after(async () => {
    await upstream.close();
  });

  /** One client, initialized, with a release feed it can be pointed at. */
  async function clientOn(feed, configDir) {
    const client = startClient({
      url: upstream.url,
      key: "rtv_live_test",
      configDir,
      releaseUrl: feed?.url,
    });
    await client.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "test", version: "1" },
    });
    return client;
  }

  const search = (client, query) =>
    client
      .request("tools/call", { name: "retrievr_search", arguments: { query } })
      .then(textOf);

  it("tells the human once when a newer release exists", async () => {
    const feed = await startReleaseFeed({ mode: "newer" });
    const client = await clientOn(feed, mkdtempSync(join(tmpdir(), "retrievr-upd-")));
    try {
      const first = await search(client, "a question");
      // The line names both versions, because "update available" without them is
      // something a reader cannot act on or check.
      assert.match(first, /0\.2\.0 is available/);
      // And names the copy it is talking about, which is the only way the human
      // knows which of their machines is behind.
      assert.ok(first.includes(VERSION), "the notice does not name this copy's version");
      // And the answer is still the answer.
      assert.match(first, /Declaration of Independence/);

      // Once per session: this is a line the model relays to the human, not a
      // footnote bolted to every passage for the rest of the day.
      const second = await search(client, "another question");
      assert.doesNotMatch(second, /is available/);

      assert.equal(feed.state.asks, 1);
    } finally {
      client.close();
      await feed.close();
    }
  });

  it("checks at most once a day", async () => {
    // The cache is the whole point of the check being affordable: a customer who
    // asks ten questions in an afternoon asks GitHub once.
    const dir = mkdtempSync(join(tmpdir(), "retrievr-cache-"));
    writeFileSync(
      join(dir, "update-check.json"),
      JSON.stringify({ checkedAt: Date.now(), latest: "0.2.0" }),
    );

    const feed = await startReleaseFeed({ mode: "newer" });
    const client = await clientOn(feed, dir);
    try {
      const text = await search(client, "a question");
      assert.match(text, /0\.2\.0 is available/);
      assert.equal(feed.state.asks, 0, "a fresh cache means GitHub is not asked");
    } finally {
      client.close();
      await feed.close();
    }
  });

  it("remembers what it learned, so the next session starts quiet", async () => {
    const dir = mkdtempSync(join(tmpdir(), "retrievr-remember-"));
    const feed = await startReleaseFeed({ mode: "newer" });
    const client = await clientOn(feed, dir);
    try {
      await search(client, "a question");
      const written = JSON.parse(readFileSync(join(dir, "update-check.json"), "utf8"));
      assert.equal(written.latest, "0.2.0");
      assert.equal(typeof written.checkedAt, "number");
    } finally {
      client.close();
      await feed.close();
    }
  });

  it("never lets a failed check reach the user", async () => {
    // GitHub being down, rate-limited, or answering nonsense must cost a search
    // nothing at all. A retrieval that reports a version check is worse than no
    // version check.
    for (const mode of ["broken", "unreadable"]) {
      const feed = await startReleaseFeed({ mode });
      const client = await clientOn(feed, mkdtempSync(join(tmpdir(), "retrievr-quiet-")));
      try {
        const text = await search(client, "a question");
        assert.doesNotMatch(text, /is available/, `mode ${mode} leaked a notice`);
        assert.match(text, /Declaration of Independence/);
      } finally {
        client.close();
        await feed.close();
      }
    }
  });

  it("stays quiet when this copy is the latest", async () => {
    const feed = await startReleaseFeed({ mode: "current" });
    const client = await clientOn(feed, mkdtempSync(join(tmpdir(), "retrievr-current-")));
    try {
      assert.doesNotMatch(await search(client, "a question"), /is available/);
    } finally {
      client.close();
      await feed.close();
    }
  });

  it("survives an unreachable GitHub", async () => {
    // No feed at all: startClient points at a refused port. The search still
    // answers, which is the property that matters on a customer's machine behind
    // a firewall.
    const client = await clientOn(undefined, mkdtempSync(join(tmpdir(), "retrievr-offline-")));
    try {
      assert.match(await search(client, "a question"), /Declaration of Independence/);
    } finally {
      client.close();
    }
  });
});
