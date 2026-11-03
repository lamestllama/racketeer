# Editing and macro expansion

## Tail positions and imports

Identifiers inside syntax templates can have predicted bindings. Their hover
shows **Predicted binding** when analysis cannot confirm the reported binding;
ordinary confirmed uses keep their usual hover. A source location can represent
several bindings or expansion phases, so confirming one does not confirm the
others. Try [the binding example](../examples/predicted-bindings.rkt). Prediction
labels are hidden after an edit until successful analysis supplies fresh facts.

Hover an expression's opening delimiter or operator to see its tail-position
relationships. The language server reports the containing expression and any
immediate expressions in tail position relative to it, with line and column
numbers. A branch may be in tail position within an `if` that is itself an
argument to another call; this does not make that branch a tail call of the
enclosing function. Try [the tail-position example](../examples/tail-positions.rkt).

These facts come from expansion, through the `syncheck:add-tail-arrow` callback of
Racket's check-syntax library, including macros that preserve source positions. They are hidden after an edit
until analysis succeeds again. Generated expressions without usable source
positions may have no hover information. Each direction shows up to eight
related locations. Existing type, binding and documentation information remains
in the same hover.

Unused imports appear as informational **unused require** diagnostics. Using
an imported binding clears that diagnostic after analysis. Go to Definition on
an imported alias follows its defining module; hover provides binding information
and documentation when available. Outline uses the native document-symbol
view. These services use the editor's current source without running the file's
ordinary body; compile-time code can execute during analysis.

## References from debugger sources

Find All References works from captured debugger sources, including references
in unopened workspace files. The request stays with the captured source if
VS Code closes or reopens the underlying file document during indexing. Open
buffers remain authoritative; changed source text, cancellation and session
termination prevent stale results from appearing.

## New documents before saving

The bundled language server supports untitled Racket documents as upstream
racket-langserver does: completion, diagnostics, definitions, references and
rename use the current editor text and stay within the document. Locations and
edit previews keep the document's untitled URI. Saving creates a new
file-document lifetime; closing or replacing the draft retires its analysis.
No placeholder source files are written. The workspace index covers saved
files only.

Relative imports use an associated save location when the document has one.
A workspace folder is not an import base: without a save location, local
analysis and collection imports still work, and a relative import reports
that a save location is required instead of resolving against the language
server's working directory.

Resyntax refactorings require a saved file. An externally installed language
server retains its existing file-only document selection.

## Unsaved workspace imports

Open workspace buffers supply the source used for imported modules, including
compile-time imports. Diagnostics and definition navigation refresh affected
open consumers when a dependency changes or closes. Workspace references and
rename previews use the same source-loading rules. Closing a buffer returns
its imports to the saved file's contents.

Project dependencies load from source during analysis, so a compiled
intermediate module cannot retain an earlier macro expansion. Analysis leaves
source files and existing bytecode unchanged.

## Rename across files

Use VS Code's **Rename Symbol** command (F2 by default) and its normal edit
preview. Racketeer's workspace index includes unopened Racket source files and
uses open buffers as the authoritative text. Rename updates a definition, its
exports and imported uses together. Renaming an explicit import alias from one
of its uses changes its declaration and uses in that file; the exporting module
keeps its name, including when the alias is inside nested prefixes.
Renaming the original definition preserves explicit local aliases and
`prefix-in` prefixes, including nested prefixes and prefixes around `only-in`,
`except-in` and `rename-in`. Selectors outside composed standard imports update
with the exported name. Compile-time uses follow the defining binding's phase;
relative submodule imports retain their enclosing module. Local bindings stay
local.

Before returning edits, Racketeer expands the original and proposed source
snapshots in memory and checks that source identifiers retain their bindings.
It rejects capture, conflicting imports, incomplete analysis and files changed
during the request. Validation is cancellable and bounded to 90 seconds; it
never applies the proposed edits itself.

Custom import transformers, generated spellings without unambiguous source
ranges, and selectors spanning multiple bindings, export phases or binding
spaces can still be refused. Rename checks actual exported identities,
so a selector is not confused with a hidden definition of the same name.
Definitions outside the analysed workspace cannot be renamed, but their explicit
local import aliases can. Workspace exclusions still apply;
consumers outside that scope must be updated separately. Workspace analysis
must be enabled for Rename.

Source snapshots use Racket's documented
[module loading hooks](https://docs.racket-lang.org/syntax/module-helpers.html)
and the bundled analyser's binding queries. Import edits use the `syncheck:add-arrow/name-dup/pxpy` callback of Racket's
check-syntax library,
[require forms](https://docs.racket-lang.org/reference/require.html),
and [module export reflection](https://docs.racket-lang.org/reference/Module_Names_and_Loading.html).
Nested import forms use the outer transformer's documented
[expansion origin](https://docs.racket-lang.org/reference/stxprops.html) and
[scope transfer](https://docs.racket-lang.org/reference/stxtrans.html) to resolve
their bindings. Custom transformers do not inherit standard import semantics.
The existing libraries remain dependencies; their rename implementations are
not used by this workspace rename service. Rename and preview use the standard
[VS Code RenameProvider API](https://code.visualstudio.com/api/references/vscode-api#RenameProvider).

## Macro stepper

**Racket: Open Line or Selection in Macro Stepper** opens the selected Racket
forms, or the current line when there is no selection, in Racket's macro-stepper
window. The shortcut is **Alt+Shift+Enter**. Select complete forms when an
expression spans several lines.

Fragments expand in a fresh Racket namespace. They do not inherit bindings from
an active debugger, REPL, or the surrounding file. To inspect a macro defined or
imported by the file, use **Racket: Open File in Macro Stepper**. That command
expands the whole module with its own language, imports, and macro definitions.
Both commands use the current editor buffer, including unsaved changes.
Selected top-level definitions are expanded without being installed for later
selected forms. Use a self-contained `let-syntax` expression or the whole-file
command when one form depends on a macro definition in another.

The stepper shows expansion, not runtime evaluation. Expanding a module does not
run its ordinary body, `main`, or `test` submodules. Compile-time code can execute
as part of expansion, just as it does during normal compilation. Workspace trust
therefore applies.

The window comes from the public `macro-debugger/stepper` library in the full
Racket installation. Racketeer supplies the editor commands and process
integration; it does not reimplement or claim authorship of that library.
A graphical desktop is required. Expansion and startup errors are reported in
the command's terminal. Close the macro-stepper window to finish, or close its
**Racket Macro Stepper** terminal to cancel expansion. Each command owns a
separate process; closing one leaves other steppers running. The commands do not
save the buffer.

Try [the macro example](../examples/macro-stepper.rkt). Use the whole-file
command to see its local macro expand, or select a complete expression using
standard Racket forms for the fragment command.

## Rhombus

Files ending in `.rhm` use the Rhombus language mode. Basic highlighting,
comments, brackets, and indentation work without starting a language server.
Saved files also use Racketeer's bundled language server for semantic editing.
The same `racketdap.racketExecutable` setting selects the language environment.

The Rhombus language must be installed in that environment. Use **Racket:
Install Package** with `rhombus`, or run `raco pkg install rhombus` for the
selected Racket installation. Racketeer does not install it automatically.
The smaller `rhombus-lib` package supplies the language without its documentation.
Missing language packages are reported by the language server; basic syntax
highlighting remains available.

Automatic document, selection, and on-type formatting are not enabled for
Rhombus. The bundled default formatter handles Racket S-expressions; applying it
to indentation-sensitive shrubbery could change the program. Rhombus uses its
own basic indentation rules while semantic editing remains available.

The lexical grammar covers ordinary tokens, nested block comments, quoted
forms, embedded Racket atoms, and common at-notation text forms. It is not a
complete shrubbery parser: `#//` is highlighted as a group-comment marker without
calculating the indentation-dependent extent, custom at-text delimiters cover
`{…}`, `|{…}|`, and `|<<{…}>>|`, and emoji identifiers use common Unicode ranges.
Language-server analysis uses the installed language's reader.

Try [the Rhombus example](../examples/rhombus/demo.rhm). This feature provides
editing support. It does not establish Rhombus debugger, Debug REPL, or Test
Explorer compatibility.

## Independent implementation

The behavioural specifications and acceptance criteria use public language and
API documentation. The new integration, grammar, and regression tests were
written independently by implementers who had not inspected the compared
editor implementation. Third-party libraries remain identified dependencies
with their existing attribution. The [clean-room policy](quality.md) applies.

Specification references:

- [Racket macro debugger public API](https://docs.racket-lang.org/macro-debugger/index.html)
- [Rhombus notation](https://docs.racket-lang.org/rhombus-guide/Notation.html)
- [Shrubbery notation](https://docs.racket-lang.org/shrubbery/)
- [Rhombus reference](https://docs.racket-lang.org/rhombus-reference/)
- [VS Code language configuration](https://code.visualstudio.com/api/language-extensions/language-configuration-guide)
- [VS Code syntax highlighting](https://code.visualstudio.com/api/language-extensions/syntax-highlight-guide)

The installed-extension harness exercises the actual packaged commands and
language registration. Its explicit `--rhombus` mode provisions a pinned
language runtime into a private test environment for semantic checks. The
ordinary mode retains a fresh addon directory without additional language
packages. See [testing](../tests/README.md) and [CI](ci.md) for commands and
retained evidence.

## Language server

The bundled upstream [racket-langserver](https://github.com/jeapostrophe/racket-langserver)
provides completion, hover documentation, definition, references, rename, diagnostics,
symbols, semantic tokens, signature help, inlay hints and code actions. Support varies
with the program's `#lang` and available documentation. Formatting uses bundled `fixw`.
The value `language` of the `racket-langserver.formatting.documentFormatter` and
`indentationFormatter` settings indents by the rules of the file's own language, which
leaves all but each line's leading space alone. Syntax highlighting, bracket matching,
commenting and two-space indentation also work before the server is ready, and common
built-in procedures have basic syntax colouring before server analysis completes.

The server supplies semantic highlighting and documentation for ordinary files and
matching captured debugger sources: for example, `values` is highlighted as a procedure.
If the file is edited while debugging, the captured source keeps its original text and
basic colouring; language-server results are used only when the two versions match.
Captured debugger sources support hover, Go to Definition and Find References. Navigation
opens current project files. These features are disabled for that view if its file changes
or the debug session ends.

The language server analyses a document 250 ms after its last edit, so typing does not
start an analysis at every keystroke. Hover, definition, references and the other requests
a person makes start it at once, whatever the wait. Set
`racket-langserver.analysisWaitMilliseconds` to an integer from 0 to 10000 to change the
wait; a change applies from the next edit. 0 starts each analysis at once, as the unpatched
server does, and invalid values use the default. The setting applies to the bundled language
server. When nothing asks first, diagnostics appear 250 ms later than without the wait.

Cold startup loads the bundled source packages and can take longer on a busy machine.
Startup has a three-minute deadline by default; set
`racketdap.languageServer.startupTimeoutSeconds` to an integer from 1 to 3600 if the machine
needs more time. Invalid values use the default. Restarting or shutting down cancels a pending
startup immediately, regardless of this limit. `racketdap.languageServer.enabled` disables the
server without disabling the debugger or commands. `racketdap.languageServer.source` set to
`installed` uses a separately installed `racket-langserver` package; the default is `bundled`.
Optional Resyntax suggestions require a separately installed `resyntax` package and
`racket-langserver.resyntax.enable`; they are off by default.

Magic Racket is not required. If its language client is enabled, Racketeer defers
language-server startup to it to avoid duplicate providers. Disable Magic Racket and reload
the window to use Racketeer alone. No other extensions or global Racket packages are disabled
or changed automatically.

The server uses Racket's installed language-analysis libraries, including check-syntax. Its
sources, pinned archive hashes, patches and licence notices are documented in
[vendor/README.md](../vendor/README.md).

## Workspace references

Racketeer analyses unopened Racket module files in trusted workspaces using a separate
indexing service. It works with either the bundled or installed language server, reusing the
bundled analysis libraries. Nothing is analysed until a request asks: the first Find All
References or Rename after a change waits for an analysis pass, which can be cancelled and which
keeps what it finished. A pass analyses again only the files whose text or dependencies changed.
Unsaved editor buffers remain authoritative for their source files, including where another file
imports them; closing a buffer returns that file to disk analysis. A file read by `include` and
its like is read from disk, whatever a buffer holds.

The status bar counts the files of a pass and warns when references are partial. Files that fail
analysis make the index partial; rename refuses incomplete or stale snapshots, and says which file
and limit stopped a worker. Background diagnostics are not part of this feature.

Settings under `racket-langserver.workspaceAnalysis` control whether analysis is enabled, excluded
directory names, file count, maximum source size and the time limit per file. Defaults are 1,000
files, 1 MiB per file and 20 seconds per file. A request stops waiting and says so when sources keep
changing, as under a generator or a build, and no more files have been analysed for that time limit.
A pass runs at most three workers at once and no more than half the number of processors, each in a
process of its own, and gives the same answers as one at a time. Compile-time code in different files
can therefore run at the same moment. Each worker adds about 260 MB to the index's memory, more with
heavy libraries, and has a 2 GiB limit on the memory its analysis adds to its own libraries. Analysing
a file of 1 MiB can need about 1 GiB; the limit is there to stop compile-time code that never releases
what it allocates, and it applies to each worker rather than to a pass, because a worker's memory ends
with it. A pass accepts at most 16 MiB of source input and 200,000 reference/definition locations.
Excluded directories and symbolic links are not scanned. Reaching a limit or failing to analyse a file
produces a partial index.

Changes within watched workspace directories mark the analysis out of date, and changes to files that
are not source files are noted when the next request arrives. A pass then checks every file each
analysis loaded or registered with the compiler, wherever it is, so a change outside those directories
is seen at the next pass. A change while a pass runs replaces it, and the new pass starts 2 seconds
after that change. A macro reading a file it does not register sees that file only at the next change
to a file loaded with it, after a refresh or a restart. Excluded files, environment changes and
nondeterministic macros also require a manual refresh. Initial indexing can take time, especially when
dependencies are not compiled. These limits bound work and retained facts; they are not a total process
memory limit. Both language tools use Racket's compilation cache under the Racket addon directory's
`racketeer` subdirectory, keeping generated bytecode outside the project.

## Lambda insertion

The **Alt+\\** (**Option+\\** on macOS) shortcut uses the built-in `editor.action.insertSnippet`
command with the **Racket lambda** snippet, in an editable Racket buffer.
