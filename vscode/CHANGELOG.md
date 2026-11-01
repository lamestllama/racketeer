# Changelog

## 0.8.48

- Combine the continuous integration corrections, the re-vendored language server and debugger attachment.
- Bundle racket-langserver at upstream b7c4642, whose background analysis ends every waiting request when analysis fails, times out or is superseded. A request whose analysis failed or passed its 30-second deadline now fails with RequestFailed, as upstream answers, instead of returning an empty result. Keep tail-position and predicted-binding hover, UTF-16 positions and unsaved imports as local patches.
- Untitled documents follow upstream: definition no longer leads from an untitled document into the files it imports, references and rename stay within the document, the workspace index covers saved files only, and a workspace folder is no longer an import base. A relative import in an untitled document without a save location reports that one is required instead of resolving against the language server's working directory.
- Use vscode-languageclient 11.0.0 and vscode-jsonrpc 10.0.0, which contain the startup and request-write corrections formerly patched locally. VS Code 1.91 or newer is required. Language server output is a log channel with timestamps and levels, as the new client requires.
- Workspace references keep their analysis while unchanged documents open and close. A pass in progress, or a partial index, continues under the new document set, and a complete index is still verified against the disk, so Find All References no longer waits for a pause in editor activity.
- Image results keep one editor group, release their snapshot when the last tab closes and save from the active tab in VS Code 1.144 and later, whose built-in image editor tabs expose no input to extensions.
- Attach to cooperative Racket hosts through a token authenticated loopback listener.
- Reuse source selection, breakpoints and inspection without owning or killing the host.
- Resolve attach configurations without a program; input and interrupt stay with the host.
- Keep the source editor active after Run File or Start Debug REPL opens Interactions beside it, so a further command on the same file finds its editor.
- Record coverage visits without constructing debugger stops: coverage reports are unchanged and no longer slow down with the depth of the stack.
- Treat build outputs that differ from their input only in case as the same file on Windows and macOS, so a build cannot replace its source there.

## 0.8.47

- Combine the thread pausing and suspension work with the editor, debugger view and test tooling releases.
- Suspend paused threads without delivering application breaks, so programs that catch breaks keep their behavior. Inspect a suspended thread's live source frames with its captured parameterization, and keep evaluation cancellation scoped to the selected program thread.
- Pause requests a source stop in every registered application thread and focuses the first executing expression. Blocked calls remain suspended, and resuming cancels a pending pause.
- Step from a GUI or other callback to the next source boundary when no return target is observable.
- Label debugger results as Return values with a count, clarify lexical variables and `set!`, and align expression and printing commands while retaining native VS Code controls and call-site completion stops.
- Stop at standalone module and plain-file expressions such as literals and variable references, while keeping atomic operands out of the stepping sequence.
- Preserve custom error display and escape handlers after an exception stop so program recovery can continue in its original context.
- Show bounded list, vector, hash, structure and syntax previews, expandable syntax source details, and procedure arity without invoking custom printers or wrapped accessors.
- Escape symbol and keyword names consistently, and show port direction plus safely known names and state without performing port I/O or invoking user callbacks.
- Start debugging at the first expression in main, preserving explicit breakpoints during module initialization.
- Offer `stopOnEntryMode: "firstExpression"` to pause before initialization, with a launch configuration snippet for that mode.
- Step into function initializers without stopping on generated binding containers that make Step Over skip the remaining body.
- Resolve the Unix cleanup helper through PATH so adapter crashes also stop grandchildren.
- Own debugger and macro-stepper descendants with Windows Job Objects.
- Evaluate multiple selections in source order in the plain and Debug REPLs.
- Evaluate selected Racket expressions in the Debug REPL with Shift+Enter.
- Open the relevant setting directly from debugger and language-server startup errors.
- Report language-server startup failures once while keeping diagnostic detail in Output.
- Preview and save image results in the native image editor, with a picker for multiple returned images.
- View image variables directly from the debugger context menu and keep image previews in one editor group.
- Find references in unopened workspace files using a separate Racketeer indexing service with bounded analysis.
- Keep editor buffers authoritative during file replacement and rename events.
- Show incomplete indexing and provide a command to refresh workspace references.
- Update the bundled language server with lifecycle, cancellation and logging fixes.

## 0.8.34

- Browse module imports and submodules in a native dependency tree with phase labels, source navigation and unsaved-buffer support. Cancel obsolete analysis and release owned workers on timeout or editor shutdown.

## 0.8.33

- Edit, insert and remove XML/Racket boxes, change whitespace and splicing modes, and retain them through undo, recovery and saving. Use independent box readers and writers.

## 0.8.32

- View XML and Racket boxes with whitespace and splicing labels, and run or debug WXME from its read-only viewer. Restrict readers in nested streams and refuse edits that would change the original box types.

## 0.8.31

- Restore current WXME text when returning from the debugger or another editor tab. Preserve edits and undo history while VS Code recreates hidden webviews.

## 0.8.30

- Run and debug the active WXME document after saving it through VS Code. Debug source snapshots retain decoded text and one position per embedded object, correcting breakpoints and exception locations in surrounding source.

## 0.8.29

- Insert PNG images, comment boxes and nested editors in WXME documents. Move selected text into a box or remove an object with native undo, save and recovery. Unchanged text retains its source styles.

## 0.8.28

- Edit text around images and inside nested WXME editors and comment boxes with native undo, save, revert and recovery. Object boundaries remain fixed; editing requires Racket GUI libraries and a working display.

## 0.8.27

- Display nested editors and comment boxes in the WXME viewer, including their text and embedded images, while preserving file bytes and refusing unsupported object readers.

## 0.8.26

- View saved WXME source with inline bitmap images through Open With. The read-only viewer preserves file bytes, identifies unsupported objects and marks changed snapshots for reopening.

## 0.8.25

- Rename through composed import selectors, compile-time uses and relative submodules.
- Rename local aliases inside prefixes while preserving exported names and checking for capture or ambiguous selectors.

## 0.8.24

- Support untitled documents in the bundled language service and workspace index.
- Preserve draft locations through rename, Save As and document closure; resolve relative imports from an associated save location or one workspace folder.

## 0.8.23

- Separate the workspace analysis engine from request transport and editor integration.
- Use unsaved workspace imports for diagnostics, definitions, references and rename previews.
- Refresh affected open consumers when dependencies change or close, and discard superseded analysis.

## 0.8.22

- Reuse verified workspace analysis when unchanged files open or close, while refreshing after edits and disk changes.

## 0.8.21

- Stop startup, references and rename requests waiting indefinitely when the workspace index disconnects.

## 0.8.20

- Avoid restarting workspace analysis for unchanged document notifications or an unchanged startup snapshot.

## 0.8.19

- Keep captured-source references available when VS Code closes or reopens the underlying file document during indexing.
- Reject changed source text before expanding it for debugger references.

## 0.8.18

- Preserve nested prefixes and prefixed selective imports when renaming exported definitions.
- Leave unused syntax templates unchanged during import rename.
- Release expansion state between files to reduce rename memory use.

## 0.8.17

- Rename explicit import aliases locally, preserve simple prefixes, and update selective imports when renaming workspace definitions.
- Reject ambiguous export selectors while retaining binding, capture and stale-source checks.

## 0.8.16

- Honor quiet RackUnit output and send failing suite summaries to stderr while retaining Test Explorer results.
- Avoid repeated linear searches when tracking generated and selected test cases.

## 0.8.15

- Run, debug and collect coverage for nested and generated RackUnit cases, including suites held in variables.
- Add a Test Explorer profile that uses raco test for package policies.

## 0.8.14

- Run, debug and collect coverage for individual inline named RackUnit suites from Test Explorer.

## 0.8.13

- Insert λ using the native Racket lambda snippet or a reconfigurable Alt+backslash shortcut.

## 0.8.12

- Add a file session option for the plain REPL, with separate terminals and selection routing for each saved file.

## 0.8.11

- Read shared language-server settings at window scope while preserving the selected Racket executable.

## 0.8.10

- Allow separate debugging and test settings for each workspace folder.

## 0.8.9

- Preserve each execution and returned value when a macro gives a generated wrapper its argument's source range. Stepping and breakpoint selection use expansion origins to prefer the source expression.

## 0.8.8

- Show macro-renamed local state, including unit variables, under its source names in the debugger and Debug REPL. Variable edits update the running program.
- Stop once at a source conditional instead of repeatedly stopping on nested expansion forms with the same range. Separate executions retain their breakpoints.

## 0.8.7

- Apply the language's runtime configuration before debugging and retain it in the Debug REPL, including custom printing and legacy language configuration.

## 0.8.6

- Report teaching-language check counts, failures and signature violations through Test Explorer, and load each test file's language runtime configuration.
- Include constants and references in test coverage so untaken literal branches and unused constant function bodies are visible.

## 0.8.5

- Run tests with native VS Code coverage controls and highlight executed expressions across loaded source files, keeping results tied to the source that ran.

## 0.8.4

- Discover direct named RackUnit cases without running project code, and run or debug a selected case using Test Explorer and editor test controls.

## 0.8.3

- Preview binding-checked renames across workspace files, rejecting incomplete analysis, stale snapshots, and unsupported import transformations.

## 0.8.1

- Distinguish pending evaluation, returned values, and waiting callers in the
  call stack; point return stops at the expression's closing parenthesis.
- Enable Go to Definition and Find References in captured debugger sources
  while their contents match the current project file.

## 0.8.0

- Use the Racket project logo as the extension icon, with its upstream notice.
- Open selected Racket forms or a complete module in Racket's macro stepper,
  using the current buffer and a separate owned process.
- Add independently implemented Rhombus highlighting and editor configuration,
  and connect saved `.rhm` files to the existing language server.
- Add packaged-editor acceptance checks for macro expansion and Rhombus editing.

- Add CI builds and core tests on Linux, Windows and macOS, plus installed Linux
  editor checks against the minimum and current stable VS Code releases.
- Correct the minimum VS Code version to 1.90, which supplies the selected
  debug stack frame API used by debugger commands.

## 0.7.1

- Preserve nested continuation-mark semantics and release completed target namespaces.
- Keep worker startup cancellable, bound the complete handshake, and clean up
  owned process groups after worker or adapter failure on Unix systems.
- Execute and display one captured source snapshot, select late external
  breakpoints at load time, and validate breakpoint coordinates and ranges.
- Recover from stalled language-server initialization and retain ownership of
  pending debug launches during disposal. Allow a configurable startup deadline
  for cold language-server compilation.
- Preserve open language-server buffers when delayed file-creation notifications arrive.
- Allow selection evaluation inside a paused Debug REPL call and enforce
  captured-source session ownership for Continue to Cursor.
- Lock the packager dependency, consolidate headless checks, and verify fresh
  editor runs against an exact artifact and its source manifest.

## 0.7.0

Initial Racketeer development release.

- DAP source debugging with expression breakpoints, stepping across modules and
  packages, live lexical inspection, evaluation, mutation, and returned values.
- Conditional breakpoints, hit counts, logpoints, exception stops, resumable
  pause, cancellation, GUI callbacks, and captured source views.
- Bundled Racket language tools for highlighting, diagnostics, completion,
  navigation, rename, documentation, and formatting.
- Plain and Debug REPLs with file loading, selection evaluation, restart, and
  repeated debuggable interactions.
- Test Explorer Run and Debug profiles, structured RackUnit failures, source
  locations, and validation using the extension's own suites.
- Package install, link, update, remove, build, test, and source-opening commands
  using native Racket scopes, dependency checks, and package test metadata.
- Recorded language-server fix for highlighting ranges beyond document bounds.
- Multi-file and linked-package examples with reproducible validation workflows.
