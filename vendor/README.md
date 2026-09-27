# Bundled language server sources

`collects/` contains upstream source packages with the local patches noted below. `sources.json` pins
each archive URL and SHA-256. Run `python3 scripts/vendor-language-server.py`
to reproduce these directories. The VSIX includes these sources, this file,
the manifest, and the license texts. No Racket package is installed globally.

`patches/semantic-token-viewport.patch` applies to racket-langserver after
archive verification. Semantic-token ranges reuse the document's existing
viewport-bound clamping, as inlay hints already do. VS Code may request a range
ending beyond the document; this previously raised an internal error. The
patch includes a regression for oversized bounds and wholly outside ranges.
The vendoring script applies the patch explicitly and fails if it no longer
matches. No debugger instrumentation is changed by this patch.

`patches/watched-create-ownership.patch` preserves a client-open document when
a delayed watched-file creation event arrives. Previously that event replaced
the document with an empty buffer, causing subsequent incremental edits and
language requests to fail. Its regressions cover document identity, content,
version, and the next incremental edit. The vendoring script explicitly applies
these two Racket patches; the JavaScript client patch below is applied only by
the npm installation and extension build.

- **racket-langserver**: Conor Finegan and Jay McCarthy; upstream
  <https://github.com/jeapostrophe/racket-langserver>, commit
  `17e1b24d91163402470370bbe956ecb944521f88`. Its `LICENSE` uses the same terms
  as Racket (MIT or Apache 2.0); full texts are in `licenses/`.
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

## JavaScript language client startup

`patches/vscode-languageclient-start-promise.patch` corrects one line in the
pinned Microsoft `vscode-languageclient` 9.0.1 dependency (MIT license). Its
`start()` method must return the promise created for that attempt. A connection
closing during initialization clears the instance field before `start()`
returns; returning that field instead loses the rejected promise and causes an
unhandled rejection when cancelling a stalled startup.

`npm ci` applies the patch through `scripts/patch-language-client.js`. The script
verifies the dependency version and SHA-256 of both the original and patched
source, supports an already patched installation, and needs no network or
external patch utility. Unexpected versions or contents fail explicitly.
The dependency's original MIT license remains in `node_modules` and is included
in the bundled `out/THIRD_PARTY_NOTICES.txt` by the extension build.
