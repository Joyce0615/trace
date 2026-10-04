# Plugins

Drop a plugin directory here and the application will look at it on launch. It
will almost certainly refuse it, and it will say why.

A plugin directory holds a `plugin.json` and the entry file it names:

```json
{
  "id": "reference-indexer",
  "name": "Reference Zig indexer",
  "version": "1.0.0",
  "kind": "indexer",
  "apiVersion": 1,
  "entry": "index.mjs",
  "entryDigest": "<sha256 of index.mjs>",
  "capabilities": ["read-file", "log"],
  "languages": ["zig"]
}
```

Sign it, which pins the code as well as the manifest:

```bash
node scripts/plugin-tool.mjs sign --dir=plugins/reference-indexer --keys=~/.trace-keys
node scripts/plugin-tool.mjs check --dir=plugins/reference-indexer --trust=<keyId>
```

`reference-indexer` here is deliberately **unsigned**, and the application
refuses to load it. That is not an oversight — it is the demonstration. A
plugin is code that runs with the learner's privileges, so an intact signature
from a key this installation does not trust is a refusal rather than a warning,
exactly as it is for an application update.

## Capabilities

Four, and each one is narrow on purpose. A plugin receives an object holding
exactly the ones it declared *and* the host granted; anything else is simply not
there.

| Capability | Call | What it gives you |
| --- | --- | --- |
| `read-file` | `await host.readFile(path)` | One file from inside the repository being indexed, resolved through the same validation the application uses for its own reads. Any path that is not part of the index is refused. |
| `list-files` | `await host.listFiles()` | The repository-relative paths you were asked about. No sizes, no contents, no absolute paths. |
| `symbols` | `await host.symbols(path)` | The definitions the built-in indexers already found for one file, so you can add to them rather than repeat them. |
| `log` | `await host.log(message)` | One line to the application's plugin log. It is redacted before it is stored, because a log is a file on disk. |

There is no capability for the network, the filesystem at large, spawning a
process, or writing anywhere. Those are not withheld pending a future version;
there is nothing to grant.

## Entry point

```js
export default async function (input, host) {
  // ...
  return { definitions: [] };
}
```

A named export matching the kind, or `run`, works too. The returned value is
validated against the schema for the plugin's kind — unknown fields are
rejected, not ignored — so a result cannot introduce structure into the
application's data model.

## What a plugin can and cannot do

It runs in its own process, with a bare environment, talking newline-delimited
JSON to the application. It never executes inside the main process. `console`
output is discarded rather than written, because it would land in the middle of
the protocol; `host.log` is the supported way to say something.

It can call only the capabilities its manifest declared *and* the host granted;
the check is repeated on the host side for every call, because a check made
inside a sandbox is a check made by the thing being restrained. It has a
wall-clock timeout, a ceiling on how much it may write, and a cap on how many
host calls it may make. Its result is validated against the schema for its kind
before anything is done with it, so it cannot invent structure inside the
application's data model.

Indexer plugins are asked **last**, and only about files the built-in indexers
could not read at all. A plugin cannot overwrite a definition tree-sitter or the
regex indexer already found.

**Stated limitation.** A child process is a fault boundary and a capability
boundary. It is not an operating-system sandbox: the plugin runs as the same
user and can read what that user can read. What it cannot do is act *through*
this application. Real confinement needs a sandbox this project cannot portably
assume, and claiming it would be worse than saying so.
