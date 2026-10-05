# Bundled language server sources

`collects/` contains upstream source packages with the local patches noted below. `sources.json` pins
each archive URL and SHA-256. Run `python3 scripts/vendor-language-server.py`
to reproduce these directories. The VSIX includes these sources, this file,
the manifest, and the license texts. No Racket package is installed globally.

The server is pinned to upstream commit
`5029bdb7d22b4ce7848fbd74d34224c450e2da16`, which includes the watched-file,
diagnostic logging and rename notification fixes. The reproduction script
verifies the archive and then applies these patches:

- `analysis-completion.patch`: complete requests after analysis failure and reject
  results from superseded or closed documents. Changes four production files;
  document analysis does not inspect disk state or track index generations.
- `open-buffer-imports.patch`: analyse imports using immutable snapshots of
  open documents, refresh affected consumers when buffers change or close, and
  resolve definitions against the accepted snapshot. Project modules load from
  source to avoid retaining earlier macro expansions in compiled intermediates.

- `untitled-documents.patch`: retain untitled document URIs while analysing
  in-memory source identities, select an explicit import base, and retire
  analysis when documents close or workspace folders change.

- `tail-position-hover.patch`: expose relative tail-position relationships from
  the documented analysis callback through standard LSP hover. Suppress those
  facts after edits until a fresh expansion succeeds. Convert between UTF-16
  protocol columns and Racket character offsets at the shared editor boundary,
  including semantic-token lengths and diagnostic ranges.

- `predicted-bindings.patch`: identify unconfirmed syntax-template bindings in
  hover using the public analysis callback. Keep binding identities and phases
  distinct, and discard predictions after source edits.

These patches do not introduce closed-file retention rules or
URI-alias restoration. Rename ownership is provided by upstream
[PR #244](https://github.com/jeapostrophe/racket-langserver/pull/244).

Workspace indexing belongs to Racketeer, in `vscode/workspace-analysis.rkt`,
its request adapter `vscode/workspace-index.rkt`, and the VS Code client. The separate process reuses the pinned analyser and workspace store
as libraries. No indexing hooks or index state are added to the language server.

Regression tests exercise these patches. Reproduction fails if any no longer
applies. It does not change debugger instrumentation. The JavaScript
client patch below is applied by npm installation and the extension build.

For offline regeneration, supply the pinned ZIP with `--package racket-langserver
--archive /path/to/archive.zip`; its checksum is still checked against
`sources.json`.

- **racket-langserver**: Conor Finegan and Jay McCarthy; upstream
  <https://github.com/jeapostrophe/racket-langserver>, at the commit above with
  the listed local patches. Its `LICENSE` uses the same terms as Racket
  (MIT or Apache 2.0); full texts are in `licenses/`.
- **fixw**: Copyright 2023 6cdh; upstream
  <https://github.com/6cdh/racket-fixw>, commit
  `036d0f2cd2d6e061f5acf0835662f194509f2a46`. MIT or Apache 2.0;
  both license texts are included in its directory.
- **html-parsing 11.0**, **mcfly 2.2**, and **overeasy 4.3**:
  Copyright Neil Van Dyke, with exact notices in each package's `info.rkt`.
  LGPL version 3 or later. Full LGPLv3 and GPLv3 texts are in `licenses/`.
  These components are provided as source, can be modified or replaced in
  `language-server/collects/` inside the installed extension, and run in a
  separate Racket process. Overeasy is required by an inline test submodule
  that Racket resolves when compiling html-parsing.

The installed full Racket distribution supplies standard libraries and
documentation. Optional third-party formatters/refactoring tools (`fmt` and
`resyntax`) are not bundled. The default formatter uses bundled `fixw`.

## JavaScript language client reliability

`patches/vscode-languageclient-start-promise.patch` corrects one line in the
pinned Microsoft `vscode-languageclient` 9.0.1 dependency (MIT license). Its
`start()` method must return the promise created for that attempt. A connection
closing during initialization clears the instance field before `start()`
returns; returning that field instead loses the rejected promise and causes an
unhandled rejection when cancelling a stalled startup.

Microsoft merged this fix in
[PR #1867](https://github.com/microsoft/vscode-languageserver-node/pull/1867)
on 29 September 2026. As of 1 October 2026, the latest published client,
10.1.2, still lacks the fix. Retain this backport until Racketeer adopts a
compatible release containing it, then remove the patch and its build hooks.

`patches/vscode-jsonrpc-write-rejection.patch` removes a redundant throw from
the pinned `vscode-jsonrpc` 8.2.0 request writer (MIT license). A failed write
already rejects the caller's request and releases its cancellation subscription.
Throwing again inside the asynchronous promise executor creates an unhandled
rejection. Keep this correction until the pinned dependency includes it.

`npm ci` applies both patches through `scripts/patch-language-client.js`. The script
verifies each dependency version and SHA-256 of both the original and patched
source, supports an already patched installation, and needs no network or
external patch utility. Unexpected versions or contents fail explicitly.
Each dependency's original MIT license remains in `node_modules` and is included
in the bundled `out/THIRD_PARTY_NOTICES.txt` by the extension build.
