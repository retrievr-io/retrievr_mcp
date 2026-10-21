---
name: retrievr
description: Search openly licensed documents and the user's own uploaded library and get passages back with a full citation (source, author, section, character range, licence). Use when a question is about a document — "what does X say about Y", "search my files/notes", "find the exact quote", "which of my documents mentions X" — and when the user wants to list, upload, or delete documents in their retrievr library. Prefer it over answering document questions from memory.
---

# retrievr

Five tools. Every passage comes back with its own citation, so quote rather than
paraphrase.

| tool | what it does |
|---|---|
| `retrievr_search` | a question in, cited passages out |
| `retrievr_documents` | lists the library, or finds a document by name |
| `retrievr_delete_document` | permanently removes one upload |
| `retrievr_upload` | adds files from the user's machine to the library |
| `retrievr_upload_status` | says which uploads are ready, which failed and why |

There is no keyword and nothing to switch on: a sentence about a document is the
whole interface.

## Choosing the call

`retrievr_search` takes `query`, `k` (1–50, default 3), `scope`, `documents`.

- "What does the Declaration of Independence say about self-government?" ->
  `retrievr_search` with the default `scope: "all"`.
- "Search my own documents for the notice period", "my file", "my notes", "what I
  uploaded" -> `scope: "private"`.
- "Search the public corpus for ..." -> `scope: "public"`.
- "In the project proposal, what does it say about budgets?" ->
  `documents: ["project-proposal.pdf"]`, after `retrievr_documents` when the exact
  name is not known.
- "Which of my documents mentions X?" -> `scope: "private"`, then name the document
  each passage came from.

When `documents` is given it decides the scope and `scope` is ignored. A scope that
cannot be honoured fails rather than widening: a mistyped document name is an error,
not a search of everything. If a name matches nothing the result says what the
library does hold, so the next call can be specific. To search two documents, name
both in one `documents` list rather than calling twice.

## Quoting

`text` is the parent passage; `char_start`/`char_end` address the embedded chunk and
`parent_start`/`parent_end` the passage, so either can be quoted verbatim. Say which
source, section and licence a quote came from. If nothing came back, say so — do not
fill the gap from memory.

## Uploading

`retrievr_upload` takes `paths` — local paths the user named, with `~/` expanded. The
server reads the files itself, so contents never pass through the conversation; what
comes back is an upload id and a sentence. PDF, EPUB, plain text and Markdown, up to
50 MB each and 20 files per call. Uploading needs a funded account.

Embedding is asynchronous: call `retrievr_upload_status` with the upload id. A file
that could not be read was not added, so it can be sent again.

Upload nothing the user did not name.

## Deleting

`retrievr_delete_document` is permanent and has no trash. Call `retrievr_documents`
first, read the exact title back to the user, and delete only the id they confirm.

## When there is no key yet

Every tool returns a sentence rather than breaking, and with no key on the machine
that sentence says to run the connect step from <https://retrievr.io/install>. Relay
it verbatim, then retry the call afterwards: the key is read on each call, so no
restart is needed once the user has signed in.
