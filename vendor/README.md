# Bundled language server sources

`collects/` contains upstream source packages with the local patches noted below. `sources.json` pins
each archive URL and SHA-256. Run `python3 scripts/vendor-language-server.py`
to reproduce these directories. The VSIX includes these sources, this file,
the manifest and the license texts. No Racket package is installed globally.

The server is pinned to upstream commit
`b7c4642055ccda877e3e6380e76e2776031a3c52`, which includes the watched-file,
diagnostic logging and rename notification fixes and the background analysis
architecture of [PR #245](https://github.com/jeapostrophe/racket-langserver/pull/245).
That architecture completes or ends every waiting request when analysis fails,
times out or is superseded, and never publishes results from a closed or
replaced document. The reproduction script verifies the archive and then
applies these patches:

- `tail-position-hover.patch`: expose relative tail-position relationships from
  the documented analysis callback through standard LSP hover. Suppress those
  facts after edits until a fresh expansion succeeds. Convert between UTF-16
  protocol columns and Racket character offsets at the shared editor boundary,
  including semantic-token lengths and diagnostic ranges.

- `predicted-bindings.patch`: identify unconfirmed syntax-template bindings in
  hover using the public analysis callback. Keep binding identities and phases
  distinct, and discard predictions after source edits.

- `open-buffer-imports.patch`: analyse imports using one immutable snapshot of
  the open buffers, record the module files each analysis loads, and refresh
  affected consumers when a dependency opens, changes or closes. Project
  modules load from source to avoid retaining earlier macro expansions in
  compiled intermediates.

- `untitled-relative-imports.patch`: refuse a relative import in an untitled
  document without a save location with a located message, instead of
  resolving it against the server's working directory. Untitled documents
  otherwise follow upstream, and other virtual documents, such as revisions
  shown in a diff, stay isolated as upstream intends.

Workspace indexing belongs to Racketeer, in `vscode/workspace-analysis.rkt`,
its request adapter `vscode/workspace-index.rkt` and the VS Code client. The
separate process reuses the pinned analyser, the source-snapshot loader and the
workspace store as libraries, and indexes saved files only. No indexing hooks
or index state are added to the language server.

Regression tests exercise these patches. Reproduction fails if any no longer
applies. It does not change debugger instrumentation.

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
- **html-parsing 11.0**, **mcfly 2.2** and **overeasy 4.3**:
  Copyright Neil Van Dyke, with exact notices in each package's `info.rkt`.
  LGPL version 3 or later. Full LGPLv3 and GPLv3 texts are in `licenses/`.
  These components are provided as source, can be modified or replaced in
  `language-server/collects/` inside the installed extension, and run in a
  separate Racket process. Overeasy is required by an inline test submodule
  that Racket resolves when compiling html-parsing.

The installed full Racket distribution supplies standard libraries and
documentation. Optional third-party formatters/refactoring tools (`fmt` and
`resyntax`) are not bundled. The default formatter uses bundled `fixw`.
