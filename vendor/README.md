# Bundled language server sources

`collects/` contains upstream source packages with the patches noted below. `sources.json` pins
each archive URL and SHA-256. Run `python3 scripts/vendor-language-server.py`
to reproduce these directories. The VSIX includes these sources, this file,
the manifest and the license texts. No Racket package is installed globally.

The server is pinned to upstream commit
`23e19894f1a11ce38bc56028ee048adb984bca06`, which includes the background analysis
architecture of [PR #245](https://github.com/jeapostrophe/racket-langserver/pull/245).
That architecture completes or ends every waiting request when analysis fails,
times out or is superseded, and never publishes results from a closed or
replaced document. The reproduction script verifies the archive and then
applies Racketeer's own patches in order:

- `tail-position-hover.patch`: expose relative tail-position relationships from
  the documented analysis callback through standard LSP hover. Suppress those
  facts after edits until a fresh expansion succeeds.

- `predicted-bindings.patch`: identify unconfirmed syntax-template bindings in
  hover using the public analysis callback. Keep binding identities and phases
  distinct, and discard predictions after source edits.

- `clamp-protocol-columns.patch`: a column past the end of a line names the end of
  that line, wherever a document converts a protocol position, as the LSP
  specification requires. Upstream's conversion carries the excess into the following
  lines: a client's range ending at column 6 of `a😀b` would delete the start of the
  next line. The editor keeps its extending conversion for its
  internal callers, which an upstream multi-line edit test needs.

- `analysis-wait.patch`: wait 250 ms after the last edit of a document before
  analysing it, and before analysing again the open documents that load it. Upstream
  starts a whole-file Check Syntax for every edit: 30 s of typing at 5 keys per second
  into a 232-line module used 29.3 s of CPU on Linux ARM64, and 3.5 s with this wait. A request a person makes, such
  as hover or references, starts it at once; semantic tokens and inlay hints, which
  a client sends by itself, join the wait and answer from the current text after it.
  An edit still cancels a running analysis at once. The wait is a time in the attempt, not a timer, and is described in
  `lsp/analysis-lifecycle.md`. The `racket-langserver.analysisWaitMilliseconds` setting
  changes it, through the `racket-langserver` section the other settings use: an integer
  from 0 to 10000 read at each edit, where 0 starts each analysis at once, as upstream
  does, and any other value is the default of 250. Meant for upstream, as a pull request
  not yet made.

Workspace indexing belongs to Racketeer, in `vscode/workspace-analysis.rkt`,
its request adapter `vscode/workspace-index.rkt` and the VS Code client. The
separate process reuses the pinned analyser, the source-snapshot loader and the
workspace store as libraries, and indexes saved files only. It gives each
analysis a fresh namespace and the file's directory, which the source-snapshot
loader leaves to its caller. No indexing hooks
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
