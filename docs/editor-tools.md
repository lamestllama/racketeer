# Editing and macro expansion

## References from debugger sources

Find All References works from captured debugger sources, including references
in unopened workspace files. The request stays with the captured source if
VS Code closes or reopens the underlying file document during indexing. Open
buffers remain authoritative; changed source text, cancellation and session
termination prevent stale results from appearing.

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
exports and imported uses together. Renaming an explicit import alias changes
its declaration and uses in that file; the exporting module keeps its name.
Renaming the original definition preserves explicit local aliases and
`prefix-in` prefixes, including nested prefixes and prefixes around `only-in`,
`except-in` and `rename-in`. Import selectors update with the exported name.
Local bindings stay local.

Before returning edits, Racketeer expands the original and proposed source
snapshots in memory and checks that source identifiers retain their bindings.
It rejects capture, conflicting imports, incomplete analysis and files changed
during the request. Validation is cancellable and bounded to 90 seconds; it
never applies the proposed edits itself.

Selectors over composed imports, phase-shifted imported uses, generated spellings without
unambiguous source ranges, and selectors spanning multiple export phases or
binding spaces can still be refused. Rename checks actual exported identities,
so a selector is not confused with a hidden definition of the same name.
Definitions outside the analysed workspace cannot be renamed, but their explicit
local import aliases can. Workspace exclusions still apply;
consumers outside that scope must be updated separately. Workspace analysis
must be enabled for Rename.

Source snapshots use Racket's documented
[module loading hooks](https://docs.racket-lang.org/syntax/module-helpers.html)
and the bundled analyser's binding queries. Import edits use documented
callbacks of Racket's check-syntax library,
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

The behavioral specifications and acceptance criteria use public language and
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
