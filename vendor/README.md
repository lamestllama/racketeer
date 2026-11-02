# Bundled language server sources

`collects/` contains upstream source packages with the patches noted below. `sources.json` pins
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
applies these patches in order. The first three are upstream pull requests, generated with
`git format-patch` from the commits exactly as submitted; drop each one when
upstream merges it:

- `pr-246-utf16-positions.patch`:
  [PR #246](https://github.com/jeapostrophe/racket-langserver/pull/246),
  "Count LSP columns in UTF-16 code units" (913dabb, b23ac28, 0f55cad,
  5a8f67c and b1916ed). Convert between UTF-16 protocol columns and Racket
  character offsets at the editor boundary, including semantic-token lengths
  and diagnostic ranges. Diagnostic columns no longer shift after tabs, each
  CRLF counts as two characters, and reading a position no longer changes the
  editor while only its read lock is held.

- `pr-247-open-buffer-imports.patch`:
  [PR #247](https://github.com/jeapostrophe/racket-langserver/pull/247),
  "Read imports from open editor buffers" (50d6f8d, ea54295, a8d0d5b and
  f0606dc). Analyse imports using one immutable snapshot of the open buffers,
  record the module files each analysis loads, and refresh affected consumers
  when a dependency opens, changes or closes. Project modules load from source.
  An analysis worker ended on timeout, cancellation or supersession leaves the
  state it shares with the server complete, so the server no longer hangs.

- `pr-248-relative-import-without-directory.patch`:
  [PR #248](https://github.com/jeapostrophe/racket-langserver/pull/248),
  "Refuse relative imports in documents without a directory" (2e29f52 and
  53e8dcd). A relative import in a document without an analysis directory,
  such as an untitled document without a save location, reports that a save
  location is required instead of resolving against the server's working
  directory.

Racketeer's own patches follow:

- `tail-position-hover.patch`: expose relative tail-position relationships from
  the documented analysis callback through standard LSP hover. Suppress those
  facts after edits until a fresh expansion succeeds.

- `predicted-bindings.patch`: identify unconfirmed syntax-template bindings in
  hover using the public analysis callback. Keep binding identities and phases
  distinct, and discard predictions after source edits.

- `clamp-protocol-columns.patch`: a column past the end of a line names the end of
  that line, wherever a document converts a protocol position, as the LSP
  specification requires. The conversion PR #246 gives upstream carries the excess
  into the following lines: a client's range ending at column 6 of `a😀b` would delete
  the start of the next line. Upstream has never clamped here, so this is not
  expected to go away with PR #246. The editor keeps its extending conversion for its
  internal callers, which an upstream multi-line edit test needs.

Workspace indexing belongs to Racketeer, in `vscode/workspace-analysis.rkt`,
its request adapter `vscode/workspace-index.rkt` and the VS Code client. The
separate process reuses the pinned analyser, the source-snapshot loader and the
workspace store as libraries, and indexes saved files only. It gives each
analysis a fresh namespace and the file's directory, which the submitted
source-snapshot loader leaves to its caller. No indexing hooks
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
