# Bundled language server sources

`collects/` contains upstream source packages with the patches noted below.
`sources.json` pins each archive URL and SHA-256. Run `python3
scripts/vendor-language-server.py` to reproduce these directories. The VSIX includes
these sources, this file, the manifest and the licence texts. No Racket package is
installed globally.

The server is pinned to upstream commit
`1defb5054961276199dfd284f83764ef068c1a2b`, which includes the background analysis
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

- `lazy-documentation.patch`: load the documentation helpers on their first use
  from the document, documentation parser and documentation callback service.
  The document also loads the HTML documentation parser only on its first use.
  Binding analysis in an indexer worker never uses them; language-server hover
  and signature help keep the same documentation lookup and rendering.

- `url-string.patch`: use `net/url-string` in the path utilities and documentation
  callback service. These use URL parsing, encoding and structures, all re-exported
  unchanged by `net/url`, without its HTTP and TLS implementations.

- `contribution-only.patch`: add an optional contribution-only expansion mode,
  disabled by default. The indexer uses only the declaration service's binding
  graph for contributions and reference and rename queries. This mode skips
  expansion log interception and the hover, documentation, completion, require
  menu, diagnostic, Typed Racket, semantic highlighting, inlay hint and tail
  services. Declaration callbacks and syntax processing still run. Language-server
  callers retain all services and expansion logs.

- `contribution-only-resources.patch`: propagate allocation failures from the
  optional contribution-only analysis to the worker controller. Skipping diagnostic
  construction must preserve the indexer's resource failure reporting. Full
  document analysis retains its existing diagnostics.

- `binding-identities.patch`: retain every module binding, including its phase and
  space, when definitions or uses share a source range. Keep local queries and
  workspace contributions distinct for generated struct and macro names, and refuse
  document renames that would change only part of a shared binding family. Meant for
  upstream; see [issue #255](https://github.com/jeapostrophe/racket-langserver/issues/255).

- `generic-bindings.patch`: collect scoped core binders, origins and disappeared
  bindings/uses in the expansion namespace, including unused generated local
  binders whose originalness prevents Check Syntax arrows. Retain structural
  anchors and exact module identities in full and contribution-only analysis.
  Recover defining phases for shifted imports from scoped identifiers.
  Reference queries expand explicitly supplied families and deduplicate their
  locations, while unrelated identities at a shared range remain separate.
  The phase-aware core walker is also used by workspace rename. Meant for upstream.

- `bindings-provider.patch`: add Racketeer's optional `#:bindings-provider`
  argument to `expand-source`. The supplied procedure receives the documented
  immutable `bindings` request; its provider data is captured by the caller.
  It runs once in the expansion namespace after generic collection, in either
  analysis mode. Confirmed names require scoped bindings and source ranges;
  family members require distinct structural anchors. Without a supplied
  procedure, analysis uses generic facts alone. Discovery and loading remain
  the embedding application's responsibility. Shared-binder disambiguation
  preserves verified component ranges supplied for the same scoped occurrence.

- `language-adapter-discovery.patch`: accept an optional descriptor resolver
  installed by the embedding launcher. Full and contribution-only expansion
  retain the selected descriptor on the reader syntax. Standalone callers keep
  ordinary analysis; the bundled sources have no dependency on Racketeer code.
  This selects data only; language policy and service behaviour are unchanged.

- `language-adapter-policy-cache.patch`: apply optional editor policy fields at
  analysis, source hover and formatting boundaries. Keep adapter dependency
  observations in the server source snapshot and validate fingerprints before retaining,
  restoring or publishing editor results. The embedding launcher supplies the
  resolver and freshness check; standalone callers retain existing defaults.

- `language-adapter-bindings.patch`: when the embedding launcher maps a selected
  adapter to a bindings procedure, pass it to the existing `#:bindings-provider`
  argument. An explicit argument still wins; standalone callers are unchanged.

- `binding-facts-services.patch`: supplement completion, the structural declaration
  outline and semantic kinds with confirmed source bindings. Retain scoped core
  identities, original form extents and local visibility; exclude generated helpers
  and template predictions while preserving structure families and lexical recovery.

- `language-adapter-declarations.patch`: dispatch optional declaration and native
  call providers through the embedding launcher. Keep immutable declaration and
  call records for the current snapshot, and release reader syntax when analysis
  ends. Share declaration trees, source signatures, declared annotations and
  semantic kinds with outline, hover and signature services; flatten native
  outlines only at transport. Preserve generic service behaviour and advertised
  capabilities when no provider is selected.

- `rename-binders.patch`: share identifier token and proposal validation between
  document and workspace rename. Match retained binder anchors through a checked
  bijection, preserving occurrence ownership for generated families, local
  bindings and virtual documents. Check scoped component mappings and storage
  binders in the same core declaration. Retain generated uses and disappeared
  bindings, and resolve provider identities in their expansion namespace. Refuse capture and incomplete families before
  returning edits. Preserve require and provide paths and wrappers; changed names
  need an edited location or a scoped owner in the renamed family.

- `language-adapter-completion.patch`: add one optional completion dispatch through
  the embedding launcher and an optional completion edit. Native providers supply
  contextual members and exact replacement ranges; ordinary completion retains
  its existing output and trigger characters when no provider handles the cursor.
  Rhombus recovery and static member knowledge remain in Racketeer's provider.

- `extra-services.patch`: let an embedding program add services to every trace
  through a parameter of factories, and read one back by key. With no factories
  a trace is unchanged.

Racketeer provides a language server and a workspace indexing server, both over LSP, and
a debug adapter over DAP. The sources here supply the language server and the libraries
used by the index. The index does not start until references or rename asks for it.

Workspace indexing belongs to Racketeer, in `vscode/workspace-analysis.rkt`, its request
adapter `vscode/workspace-index.rkt` and the VS Code client. The separate process reuses
the pinned analyser and workspace store as libraries, with Racketeer's
source-snapshot loader in `racketdap/tools/source-snapshot.rkt`,
and indexes saved files only. It gives each analysis a fresh namespace, custodians and
the file's directory. A worker lasts for discovery and one pass and reuses compiled
dependencies only within that snapshot. Cached code retains its original load
fingerprints. Registered external reads compile again. Workers are replaced between
files when they reach their memory threshold; completed contributions remain. No
indexing hooks or index state are added to the language server. The resolver
notifies both loaders of descriptor reads because server diagnostics still use
the server loader. Both loaders use Racket's input interception for buffer reads.

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
  both licence texts are included in its directory.
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
