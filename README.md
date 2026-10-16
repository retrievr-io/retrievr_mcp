# retrievr_mcp

The MCP server for [retrievr](https://retrievr.io): one tool, `retrievr_search`,
that returns passages from openly licensed documents with their citation — source,
author, section, character range and licence.

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
