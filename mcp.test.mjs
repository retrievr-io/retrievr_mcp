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

/** A stub of the two function endpoints, with a mode the tests can set. */
async function startUpstream() {
  const state = { mode: "ok", submitted: 0, polled: 0 };

  const server = createServer((request, response) => {
    const send = (status, body) =>
      response.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body));

    if (request.method === "POST" && request.url === "/retrieve") {
      state.submitted += 1;
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

  it("offers one search tool, and asks for a query", async () => {
    const answer = await withKey.request("tools/list", {});
    const tools = answer.result.tools;
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, "retrievr_search");
    assert.equal(tools[0].inputSchema.required.includes("query"), true);
    assert.equal(tools[0].inputSchema.properties.query.type, "string");
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
    const tag_name = mode === "newer" ? "v0.2.0" : mode === "current" ? "v0.1.0" : "nightly";
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
      assert.match(first, /0\.1\.0/);
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
