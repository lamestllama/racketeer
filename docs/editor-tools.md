<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
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

Project dependencies use the current source snapshot. The workspace index can reuse
compiled dependencies within one worker's pass. It retains the original load
observations and fingerprints. Dependencies that register external reads compile again
so those reads are observed. The language server loads project dependencies from source.
Analysis leaves source files and existing bytecode unchanged.

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

**Racket: Step Through Macros on This Line** (**Alt+Shift+M**) opens two linked panes
beside the source. **Before** appears above **After**. The tabs can be moved to other
editor groups. Both follow the same step. Closing either closes the pair. **Racket: Step
Through Macros in This File** starts at the file's first step.

Macro stepping is built on Ryan Culpepper's `macro-debugger` library. No graphical
display is needed.

![Source beside Before and After, with the swap! rewrite and binding
arrows](images/macro-steps.png)

### Reading a step

Each pane shows a whole program by default. Before highlights the form about to change;
After highlights its replacement. The Before title counts positions, including the
finished position. The After title names the transformation and macro, or says Finished
or Error. At completion, After shows the expanded program or the expansion error. Before
retains the last displayed input when available. Remarks and transformer contexts appear
with the relevant syntax.

Each program starts its line numbers at 1. The read-only panes use the editor's font,
syntax colours, bracket colours, selection and copying controls. Scope colours
distinguish macro-introduced syntax. Group 0 keeps ordinary token colours. Groups 1–17
have distinct colours; larger groups use numbered suffixes. Numbers are assigned as
syntax is displayed and remain stable while stepping. Reader brackets and eligible quote
shorthand are preserved.

The panes retain their text position while stepping and reveal a changed form when
needed. Source highlights follow the current expansion without taking keyboard focus.
Source locations use lines and columns. A source edit marks the recording out of date.
**Racket: Refresh Macro Steps** captures the current buffer. Changing hiding or display
options uses the captured expansion.

Place the cursor on a term to select its syntax. Related identifiers highlight by
binding identity. Hovering a name shows arrows to its visible binding or uses and a
sentence beneath the program. Binders have a solid underline. Definite arrows are green;
possible arrows are yellow and carry `?`. Binding connections stay within a printed
section. Equal spelling alone does not establish a connection.

**Racket: Show Details** opens a resizable inspector beside the program, or below it in
a narrow pane. It shows the apparent identifier binding, implicit `#%top`, `#%app` and
`#%datum` bindings, source location, scopes, built-in properties and additional syntax
properties. Bindings include their phase and defining and importing modules where
available. Scopes start at phase 0. **more phases** adds positive and negative phases;
**fewer phases** reduces the display. Built-in properties include tamper status, source
module and original status. Property values are bounded and report truncation.

### Navigation and term commands

The tab toolbar, tab menu and right-click menu provide the commands below. Keyboard
navigation applies while a macro pane has focus. During debugging, **F10** remains Step
Over; **Alt+Right** still advances the macro stepper.

| Command | Action |
| --- | --- |
| **First Macro Step** | Go to position 1. |
| **Previous Macro Step** | Go back one position: **Alt+Left**. |
| **Next Macro Step** | Advance one position: **F10** or **Alt+Right**. |
| **Finish Macro Steps** | Go to the finished or stopped expansion. |
| **Racket: Jump to Macro Step** | Enter a position number or `end`. The final position is included in the count. |
| **Racket: Copy** | Copy selected text, including partial or multiple selections. With no text selection, copy the term at the cursor. |
| **Racket: Go to Source** | Open the selected term's source. A changed or unverified location carries a warning. |
| **Racket: Go to Binder** | Choose a visible binder for the identifier: **F12**. |
| **Racket: Show Uses** | Choose a visible binder or use: **Shift+F12**. |
| **Racket: Keep Arrows** | Keep the selected identifier's binding arrows visible after the pointer moves. |
| **Racket: Release Kept Arrows** | Release kept connections touching the selected identifier. Other connections remain. |
| **Racket: Clear Kept Arrows** | Clear all kept arrows in the active pane. Stepping also clears them. |
| **Racket: Clear Macro Term Selection** | Clear the selected syntax: **Escape**, with no input or menu active. |
| **Racket: Show Details** | Show or hide the selected term's inspector. |
| **Racket: Inspect More Phases** | Inspect remaining available phases. The inspector's links can request further integer phases. |
| **Racket: Refresh Macro Steps** | Replace this pair's recording with an expansion of the current source. |
| **Racket: Open Saved Macro Source** | Open and expand the saved file after an untitled source has been saved. |

### Display options

The tab menu offers these controls. Saved settings are under `racketdap.macroSteps`. The
table gives their setting names and defaults.

| Option | Setting and default | Effect |
| --- | --- | --- |
| **Include Renaming Steps** | `includeRenamingSteps`: `false` | Include named scope and identifier-resolution transitions. Keep the expansion point when changing the filter. |
| **Always Suffix Marked Identifiers** | Per pair; off initially | Add `:N` to every identifier with a nonzero scope group. Otherwise only groups above 17 get suffixes. |
| **Highlight Redex/Contractum** | `highlightRedexContractum`: `true` | Highlight the changed syntax in Before and After. Other selection and binding decorations remain. |
| **Draw Binding Arrows** | `drawBindingArrows`: `true` | Show binding arrows. Turning this off clears kept arrows. |
| **One Term at a Time** | `oneTermAtATime`: `false` | Show each transformation as a Before position followed by an After position. The other pane is empty at each position. |
| **Factor Out Common Context** | `factorCommonContext`: `false` | Show only changed fragments in the panes. After adds shared outer syntax under `In context:`, with `[ HOLE ]` at the insertion site. Retained but inactive while One Term at a Time is on. |
| **Taint Icons** | `taintIcons`: `codicons` | Choose Codicons, Unicode or Do not show (`codicons`, `unicode`, `none`). Armed syntax has a yellow lock, disarmed syntax a green unlock and tainted syntax a red zap. Unicode uses 🔒, 🔓 and 💥. Marks stay outside copied text. |
| **Racket: Reset Mark Numbering** | Per pair | Start scope numbering afresh. Keep position, grouping, suffix choice, selection, arrows and scroll position. |
| **Racket: Foreground Colors** | Per pair; By macro scopes initially | Choose **By macro scopes** or **By all scopes**. Changing grouping resets mark numbering. |

One Term at a Time and Factor Out Common Context change the active pair and save
defaults for future pairs. Already open pairs keep their values. Syntax selection
follows the same syntax across their layout and position changes. The other saved
options also update ordinary open pairs. Duplicated pairs keep independent live
controls. Suffix choice has no saved setting.

### Macro hiding

The eye button opens **Macro Hiding...**. The shortcut is **Ctrl+K H** (**Cmd+K H** on
macOS). **Standard** hides Racket syntax, collection libraries, generated names
beginning with `provide/contract-id-` and uses above phase 0. **Disable** permits every
identifier. **Custom...** opens a checklist:

- **Enable macro hiding** applies the retained switches and rules.
- **Hide racket syntax** hides Racket's syntax.
- **Hide library syntax** hides collection-library syntax.
- **Hide contracts (heuristic)** hides generated contract names.
- **Hide phase>0** hides uses expanded above phase 0.

All five start checked. Accepting applies the checked set. Ordinary Custom pairs share
switches and rules in memory until VS Code closes. Enabled Custom pairs show
**(Custom)** in both titles. Returning to Custom restores its switches. Duplicated pairs
have their own Custom policy.

With the cursor on an identifier, **Hide This Macro** or **Show This Macro** adds a
binding rule and selects Custom. Renamed imports of the same binding match; unrelated
names of the same spelling do not. Rules match at each use's phase. A new rule replaces
an equivalent rule and moves to the front. The first match decides; switches apply when
no rule matches. **Macro Hiding Rules...** lists rules newest first. Select rules and
accept to delete them. Unchecking **Enable macro hiding** bypasses switches and rules
without deleting them.

The compatibility commands **Show Racket's Macros Too** and **Show Only My Macros**
select Disable and Standard. They are not listed in the Command Palette.

Hiding makes a use opaque while identifiable original subterms can still expand visibly.
It changes the display, not which macros execute. The finished display can therefore
retain macro forms. A shown macro's explicit local expansion permits all identifiers
there, including within the module-body wrapper. Resolution involving several
identifiers requires permission for each one.

A new source command starts with Standard hiding. A line containing only Racket macros
reveals the ones written on that line. A line with no macro starts at the first step.
The most recently chosen hiding mode is remembered for duplication.

### Independent copies

**Racket: Duplicate Stepper** opens another Before/After pair on the same recorded
expansion. It starts at position 1, with fresh mark numbering, no selection or kept
arrows, and the saved display defaults and hiding mode. Custom switches start checked
and rules start empty. Navigation and controls are independent. Duplicating does not run
transformers again.

Each pair holds one recorded term. **Racket: Duplicate Stepper (Current Term Only)**
therefore copies the same term. **Racket: Remove Selected Term** empties the active pair
and releases its recording reference. The panes stay open. A full duplicate of an empty
pair is empty; Current Term Only does nothing. Refresh replaces only its addressed pair;
other copies keep their recording.

### Expansion and limits

Both source commands use the current buffer, including unsaved changes, without saving
it. In a module, they expand the whole module with its language, imports and macro
definitions. In a non-module buffer, the line or selection expands in a fresh namespace
with standard Racket bindings. Select complete forms across lines. Selected definitions
are not installed for later selected forms. Use a self-contained `let-syntax` when forms
depend on a local macro.

Expansion runs readers and compile-time code. It does not run the module's ordinary
body, `main` or `test` submodules. Workspace trust applies. Compile-time output does not
appear in the panes. Try [the macro example](../examples/macro-stepper.rkt): the
whole-file command shows `twice` and `swap!`; the line command on `(swap! tmp other)`
opens at that rewrite. The runtime error in `module+ main` does not run.

At 40,000 macro applications, a modal warning offers **Continue** and **Stop**. Continue
doubles the next threshold. Dismissing the warning means Continue. Stop retains the
completed history and shows an expansion error. It cannot resume that expansion. The
progress notification can cancel expansion instead. Each recording has a 1000 MiB memory
ceiling; each worker answer has a 64 MiB text ceiling. A limit failure is reported.

At most two unshared worker sessions remain resident. A pair hidden for 60 seconds
releases its worker. Printed positions remain available; an uncached position or
inspection can rebuild the captured expansion and run transformers again. Recorded
Continue and Stop decisions replay during rebuilding. Refresh captures current source
instead. Shared recordings created by duplication remain resident until their last
retained term closes, is removed or is refreshed. A failed shared worker needs Refresh.
An evicted recording must be restored by navigation or Refresh before it can be
duplicated.

An internal stepper error has a **[details]** link when exception details are available.
Its notification offers **Copy Details**, **Show Error**, **Dump Debugging File** and
**Cancel**. Show Error writes to the **Macro stepper** output channel. Dump Debugging
File asks for a destination and saves a readable expansion diagnostic when recorded
events are available.

The full Racket distribution supplies `macro-debugger`. Racketeer uses its model
modules, which are not its documented interface, and supplies the panes and process
integration. The [session schema](macro-stepper-schema.md) describes requests, rendering
and lifetime rules.

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

Racketeer provides two servers over LSP: the language server for editing and a workspace
indexing server for project references and rename. Its debug adapter uses DAP. Language
analysis is independent of debugger operation.

The bundled upstream [racket-langserver](https://github.com/jeapostrophe/racket-langserver)
provides completion, hover documentation, definition, references, rename, diagnostics,
symbols, semantic tokens, signature help, inlay hints and code actions. Support varies
with the program's `#lang` and available documentation. Formatting uses bundled `fixw`.
The value `language` of the `racket-langserver.formatting.documentFormatter` and
`indentationFormatter` settings indents by the rules of the file's own language, which
leaves all but each line's leading space alone. Syntax highlighting, bracket matching,
commenting and two-space indentation also work before the server is ready, and common
built-in procedures have basic syntax colouring before server analysis completes.

The server supplies semantic highlighting and documentation for ordinary files: for
example, `values` is highlighted as a procedure. A stop shows the file itself until a saved
edit leaves the running text behind. It then shows a captured source with that text and
basic colouring, with no language-server results.

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
language-server startup to it to avoid duplicate providers. Racketeer then offers, until answered or dismissed, to turn
off only Magic Racket's language server and reload the window. Disable Magic Racket and reload
the window to use Racketeer alone. No other extensions or global Racket packages are disabled
or changed automatically.

The server uses Racket's installed language-analysis libraries, including check-syntax. Its
sources, pinned archive hashes, patches and licence notices are documented in
[vendor/README.md](../vendor/README.md).

## Workspace references

Racketeer analyses unopened Racket module files in trusted workspaces using a separate
workspace indexing server over LSP. It works with either the bundled or installed
language server, reusing the bundled analysis libraries. Nothing is analysed until a
request asks: the first Find All References or Rename after a change waits for an
analysis pass, which can be cancelled and which keeps what it finished. A pass analyses
again only the files whose text or dependencies changed. Unsaved editor buffers remain
authoritative for their source files, including where another file imports them; closing
a buffer returns that file to disk analysis. A file read by `include` and its like is
read from disk, whatever a buffer holds.

The status bar counts the files of a pass and warns when references are partial. Files that fail
analysis make the index partial; rename refuses incomplete or stale snapshots, and says which file
and limit stopped a worker. Background diagnostics are not part of this feature.

Settings under `racket-langserver.workspaceAnalysis` control whether analysis is
enabled, excluded directory names, file count, maximum source size and the time limit
per file. Defaults are 1,000 files, 1 MiB per file and 20 seconds per file. A request
stops waiting and says so when sources keep changing, as under a generator or a build,
and no more files have been analysed for that time limit. A pass runs at most three
workers at once and no more than half the number of processors, each in a process of its
own, reused through discovery and the pass, and gives the same answers as one at a time.
On Linux, available memory, including container limits, can reduce the default count
further; at least one worker remains available. An explicit worker count takes
precedence. Compile-time code in different files can therefore run at the same moment.
Each worker adds its runtime and libraries to memory and has a 2 GiB limit on the memory
its analysis adds to its own libraries. Analysing a file of 1 MiB can need about 1 GiB;
the limit is there to stop compile-time code that never releases what it allocates, and
it applies to each worker rather than to a pass. Each file has fresh custodians and a
fresh namespace. Workers collect binding contributions without constructing hover,
documentation, diagnostics or other editor results. Each worker reuses compiled project
dependencies within its pass, with the original read fingerprints. Registered external
reads are observed by compiling again. A worker at or above 288 MiB is replaced between
analyses, preserving its completed result. Linux checks resident memory; other systems
check managed memory. This is a replacement threshold, so one analysis can still use its
full allowance. Workers end with the pass; cancellation, timeout, memory failure, a
crash or an unreadable reply ends one sooner. A pass accepts at most 16 MiB of source
input and 200,000 reference/definition locations. Excluded directories and symbolic
links are not scanned. Reaching a limit or failing to analyse a file produces a partial
index.

The extension discards a workspace index connection that stops answering. References
then come from the language server alone and rename reports the stall. **Racket: Restart
Language Server** creates fresh language tools.

Changes within watched workspace directories mark the analysis out of date, and changes
to files that are not source files are noted when the next request arrives. A pass then
checks every file each analysis loaded or registered with the compiler, wherever it is,
so a change outside those directories is seen at the next pass. A change while a pass
runs replaces it, and the new pass starts 2 seconds after that change. A macro reading a
file it does not register sees that file only at the next change to a file loaded with
it, after a refresh or a restart. Excluded files, environment changes and
nondeterministic macros also require a manual refresh. Initial indexing can take time,
especially when dependencies are not compiled. These limits bound work and retained
facts; they are not a total process memory limit. The language server and workspace
indexing server use Racket's compilation cache under the Racket addon directory's
`racketeer` subdirectory, keeping generated bytecode outside the project.

## Lambda insertion

The **Alt+\\** (**Option+\\** on macOS) shortcut uses the built-in `editor.action.insertSnippet`
command with the **Racket lambda** snippet, in an editable Racket buffer.
