# retrievr_mcp

The MCP server for [retrievr](https://retrievr.io): search openly licensed
documents and your own library, and get passages back with their citation —
source, author, section, character range and licence.

It holds three tools:

| tool | what it does |
|---|---|
| `retrievr_search` | a question in, cited passages out |
| `retrievr_documents` | lists your library, or finds a document by name |
| `retrievr_delete_document` | permanently removes one of your uploads |

This runs on **your** machine, beside your agent, and holds no corpus of its own.
It reads your retrievr key and talks to retrievr's API. That is the whole of it.

## Install

Fetch and follow <https://retrievr.io/install>. It is written for an agent to read:
it downloads this file to `~/.config/retrievr/mcp.mjs`, walks your human through
sign-in, and writes the key to `~/.config/retrievr/credentials` (mode 600) without
ever printing it.

Then your harness needs one entry.

```json
{
  "mcpServers": {
    "retrievr": {
      "command": "node",
      "args": ["~/.config/retrievr/mcp.mjs"]
    }
  }
}
```

For pi, the command that writes that entry is:

```bash
pi mcp add retrievr -- node ~/.config/retrievr/mcp.mjs
```

Reload your harness afterwards — the tool list is read when a session starts.
Nothing is installed globally, and there is no daemon: your harness starts this
process and it exits when your session does.

## Updating

This copy asks GitHub for the latest release **once a day**, and says so on your
next search if it is behind. It never updates itself and never blocks a search: if
GitHub is unreachable, rate-limited or private, the check says nothing at all.

To update, re-run the install line — the connect step also refreshes this file.

The version of this copy is **0.1.1**.

## Search settings

`retrievr_search` takes four arguments:

| argument | values | default |
|---|---|---|
| `query` | the question, or the passage to find | required |
| `k` | 1–50 passages | 3 |
| `scope` | `"all"`, `"private"` or `"public"` | `"all"` |
| `documents` | titles, filenames or ids from `retrievr_documents` | none |

`scope` decides what may be searched:

- `"all"` — your documents and the public corpus, ranked together. This is the
  default, because your own documents are part of what you have.
- `"private"` — only documents you uploaded.
- `"public"` — only the openly licensed corpus.

`documents` decides exactly which documents. Each entry is a title, a filename or
an id; a title matches every document whose name contains it, and one call may
name up to 20. When `documents` is given it decides the scope and `scope` is
ignored.

A scope that cannot be honoured fails the call rather than widening it: a typo in
a document name is an error, not a search of everything. A name that matches
nothing says what the library does hold, so the next call can be specific.

## How to trigger it

There is no keyword, no mode and nothing to switch on. The tools are in your
agent's belt and the key is read on every call. A sentence about a document is
the whole interface:

- "What does the Declaration of Independence say about self-government?"
  → `retrievr_search`, default scope `"all"`.
- "Search my own documents for the notice period."
  → `scope: "private"`. "My file", "my notes" and "what I uploaded" mean the
  same thing.
- "Search the public corpus for ..."
  → `scope: "public"`.
- "In adaptive-harness-proposal.pdf, what does it say about budgets?"
  → `documents: ["adaptive-harness-proposal.pdf"]`. Call `retrievr_documents`
  first when the exact name is not known.
- "Which of my documents mentions X?"
  → `scope: "private"`, then say which document each passage came from.
- "Delete the thesis draft."
  → `retrievr_delete_document`, only after `retrievr_documents` and reading the
  exact title back to the user. There is no undo and no trash.

## What comes back

Every passage carries its own citation — title, author, section, character range
and licence — so an agent can quote rather than paraphrase. `text` is the parent
passage; `char_start`/`char_end` address the embedded chunk and
`parent_start`/`parent_end` the passage, so either can be quoted. Nothing is
returned without a citation.

## The key

The key is read at call time, never at startup. That is what lets the install
happen in the same session you first use the tool in: the tool is already in your
agent's belt, and the install is what authenticates it.

## Tests

```bash
node --test mcp.test.mjs
```

The upstreams are stubs, so this needs no key, no balance and no network.

---

This repository is a mirror. The server is developed in retrievr's frontend
repository, where its tool text is written beside the endpoint it calls, and
published here by `frontend/scripts/sync-to-retrievr-mcp.sh`.
