# Racketeer: Organised Racket

*Racket source debugging and editing for VS Code.*

By [Eric Parsonage](https://github.com/lamestllama).

Racketeer is the only Racket extension for VS Code that debugs Racket source: set breakpoints, step through expressions and inspect live values in the editor, as with any other VS Code language.

Racketeer's DAP server provides expression breakpoints, stepping across files
and packages, live lexical inspection and evaluation. Run a source file to see
text and images beside the editor, or debug it with breakpoints and stepping.
Bundled language tools, testing and package commands complete the development workflow.

Requires the **full Racket 9.1 or newer distribution**. Minimal Racket alone
does not include all the standard libraries and documentation used by the
language server. No separate `raco pkg install racket-langserver`, Magic Racket,
Node.js or npm is needed. The extension does not automatically install packages into the
Racket environment. Tested on Linux ARM64 with Racket 9.1 CS and
VS Code 1.98.1; other operating systems are not yet verified.

## Install and start

1. In Extensions, choose **Install from VSIX…** and select the packaged `racketeer-<version>.vsix`.
2. Open a trusted folder containing a Racket program and a saved `.rkt` file.
3. Language tools start automatically; **Racket: ready** appears in the status bar.
4. Click **Run Current File** above the source to see its Results, or choose
   **Debug Current File** to stop and inspect it. Debugging uses
   F5/F10/F11/Shift+F11 for Continue/Over/Into/Out.

If Racket is not on PATH, set `racketdap.racketExecutable` in Settings.
Debugger and language-server startup errors offer **Open Settings**, which opens
the relevant setting; language-server errors also offer **Show Output**.
The extension ID is `lamestllama.racketeer`. Remove the earlier
`lamestllama.racketdap` development extension before installing Racketeer.
Existing `racketdap` launch configurations and settings remain usable.

## Debugging

For a reusable launch configuration:

```json
{
  "version": "0.2.0",
  "configurations": [
    {
      "type": "racketdap",
      "request": "launch",
      "name": "Debug Racket file",
      "program": "${file}",
      "stopOnEntry": true,
      "interactive": false,
      "console": "integratedTerminal"
    }
  ]
}
```

The root module loads first, then its `main` submodule runs when present. Use
`"submodule": ["test"]` for tests or `"submodule": []` to load only the root.
Use `"entry": "run"` to call an exported zero-argument procedure afterward.
`args`, `cwd`, `env` and `sourceRoots` are also configurable.
`"testMode": true` selects test execution and reporting; it cannot be combined
with `interactive`, `submodule`, `entry` or `language`. For a plain file
without a `#lang` or module declaration, set `"language": "racket/base"` (or another
language module such as `r5rs`). Leave `language` unset for module programs.

By default, the session ends after the entry action and GUI work complete;
visible windows, timers and queued callbacks keep GUI programs alive. With `"interactive": true`, the module stays
loaded until Stop. The Debug Console evaluates expressions and defines session
bindings. Calls into instrumented functions can hit breakpoints and
be stepped through. Console errors return to the interaction loop. Returned
values can be expanded until the next interaction; paused-frame references
expire when that stop resumes.

With `"console": "integratedTerminal"`, program output and line input use a
terminal named **Racket: …**. Enter submits a line, Ctrl+D sends EOF on an empty
line and Ctrl+C interrupts the running interaction or program. Closing the
terminal sends EOF. This provides line input over pipes; it is not a shell or a
full TTY for curses/raw-mode applications. The default `internalConsole` sends
output to Debug Console and gives the program EOF on stdin. Debug Console input
always evaluates Racket expressions.

## Breakpoints and exceptions

Click the gutter to the left of a line number, press **F9** or right-click
and choose **Add Breakpoint**. These controls work in the captured source tab
opened by the debugger as well as in the source file. Press F9 again to remove
the breakpoint. A normal session exits when the program finishes; enable
`"interactive": true` only when the Debug Console should remain running.

The bundled language server supplies semantic highlighting and documentation
for ordinary files and matching captured debugger sources. For example,
`values` is highlighted as a procedure. If the file is edited while debugging,
the captured source keeps its original text and basic colouring; language-server
results are used only when the two versions match. Common built-in procedures
also have basic syntax colouring before server analysis completes.

Breakpoints bind to expressions beginning on the selected line, preferring the
outermost expression. Use an inline breakpoint to select a later expression
on the line. An inline breakpoint on a non-tail expression's final character
stops after it returns. **Racket: Continue to Cursor** runs to one selected boundary
once while retaining ordinary breakpoints. A breakpoint stays pending until its module is loaded; if there
is no expression at that location it remains unverified with an explanation.
Breakpoints do not silently move into another function. A breakpoint added to
an already loaded, uninstrumented dependency needs a fresh launch.

Right-click a breakpoint to add a **condition** or **hit count**:

- Conditions are Racket expressions in the current lexical environment, such as
  `(> subtotal 100)`. Only `#f` is false. A condition must return one value.
- Hit counts accept `N`, `=N`, `>=N`, `>N`, `<=N`, `<N` and `%N`, where N is a
  positive integer. `%3` means every third hit. Counts include all encounters
  across program threads, before testing the condition. Editing a breakpoint
  resets its count; re-sending an unchanged breakpoint preserves it.
- Logpoints interpolate expressions: `subtotal={subtotal}, tax={(* subtotal rate)}`.
  Use `{{` and `}}` for literal braces. Conditions and hit counts also apply to
  logpoints. Logpoints write to Debug Console and continue without stopping.
- A condition/log expression error stops at the breakpoint with a diagnostic.
  These expressions can have real effects, like ordinary console evaluation.

Use **Uncaught Racket exceptions** (enabled by default) in the Breakpoints pane to stop at an
uncaught runtime error. Call Stack, lexical variables, Exception scope and exception details
remain available. Continue propagates the same exception: a script usually ends,
while an interactive console call reports the error and leaves the module loaded.
The program's error display and escape handlers retain their original context;
a custom `error-escape-handler` can recover and continue after the stop.
Racket values raised with `raise` need not be exception objects. Exceptions
handled by the program are not intercepted. Source information comes from the
available instrumented context; expansion/load errors without such a context
are reported as diagnostics rather than source-level exception stops.

## Stepping and evaluation

The default launch's `stopOnEntry: true` stops before the first instrumented
expression inside `module+ main`. Without `main`, it starts in the program's
module body. An explicit submodule selection or test launch uses the selected
submodule. Explicit breakpoints still work during initialisation, including in
required files. Set `stopOnEntry` to `false` to run directly to a breakpoint.

To inspect initialisation before reaching `main`, set
`"stopOnEntryMode": "firstExpression"` alongside `"stopOnEntry": true` in
`launch.json`, or choose **Racket: debug initialization** from **Add
Configuration**. This pauses at the first instrumented expression, including
initialisation in debugged dependencies. The default mode, `"entryPoint"`,
keeps the entry-module behaviour above. Neither mode pauses in uninstrumented
or compile-time code, and both are ignored by Run Without Debugging.

VS Code keeps its native **Continue**, **Step Into**, **Step Over** and **Step
Out** controls. **Call Stack**, **Variables** and **Watch** also keep
their native VS Code names.

Step Into visits expression starts and completions. Step Over can stop at an
expression's completion. When a function returns, this completion stop remains
at its call site, so its return values can be inspected before advancing to the
next expression. The **Return values** scope includes a count, such as **Return
values (0)**, **Return values (1)** or **Return values (2)**; zero values and one
`#<void>` value remain distinct. Tail calls have no artificial
return boundary: stepping over a tail expression follows the enclosing return
context and can finish the program. Step Out follows the current function's
return context. Continuation transfers outside a step target are identified in
the stop description.

Call Stack distinguishes **Before evaluation** from **Returned N values**.
At a return stop the marker moves to the expression's closing parenthesis;
open **Return values** to inspect its values. **Waiting for return** identifies a caller
whose calculation is still pending. Stepping is by expression, so several stops
can share a source line. Expanded forms can also share a larger source range,
which currently makes some stops highlight a whole function.

Captured debugger sources support hover, Go to Definition and Find References
through the language server. Navigation opens current project files. These
features require the captured source to match the current file and are disabled
for that view if its file changes or the debug session ends.

Select a frame in **Call Stack** to inspect its lexical variables in
**Variables → Locals**, or evaluate a Racket expression in the Debug Console,
for example `(+ subtotal 20)` or `(set! subtotal 200)`. **Locals** is the native
scope name for the lexical variables visible in the selected frame. Evaluation
uses those live variables. `set!` and other evaluation effects are real;
selected module definitions remain editable, while imported bindings retain
Racket's assignment protections. **Watch** also evaluates Racket code. Hover reads
lexical or module variables without expanding user macros.

A variable a macro binds is listed when the source refers to it, as `it` from an
anaphoric macro is, or an accessor of a local structure that the source reads.
Temporaries of a macro's own, such as `tmp` or `for-loop`, are not.

In a class's methods and initialisers, **Locals** has a row named `this`, which hover,
**Watch** and the Debug Console read too. It opens to the object's fields, numbered,
since the object holds no field names; a field not yet set shows `<uninitialized>`.
Field names themselves are not variables, because a field read in the source expands
to a call on the object: hover and the console refuse them, and
`(get-field count this)` in the console reads a public field.

The editor context menu and Command Palette provide **Skip Expression** before
an expression, **Change Return Values** and **Print Return Values to Console**
after it, plus **Print Variable Value to Console** and **Set Variable Value
(set!)** for the variable at the cursor. Variable actions use the selected stack
frame. Expression actions use the executing frame. Replacement expressions can
return `(values ...)`,
including `(values)` for zero values; changes take effect when execution resumes.
Variable assignment uses `set!` semantics on the live lexical or module variable.
Explicit Print actions use full Racket printing, including custom writers, and
can be interrupted with Cancel Evaluation.

Run **Racket: Cancel Evaluation** to interrupt a blocked console, watch,
condition or logpoint evaluation. The session and paused frames remain usable
when cancellation succeeds. Cancellation is cooperative: code that disables or
catches breaks may keep running; Stop still terminates the worker. Effects that
already happened are not rolled back. When a console call is paused and another
evaluation runs inside that stop, Cancel targets the inner evaluation.

Lists, vectors, hashes and inspector-visible structures show bounded contents
in their previews. Pairs, vectors, boxes, hashes and visible structure fields
can be expanded. Syntax objects show a datum preview and expand to the datum
and source coordinates; procedures expand to show arity. Procedure names appear
when they can be obtained without invoking program callbacks; other procedures
can remain `#<procedure>`.

Automatic inspection does not force promises, call custom writers or invoke
wrapped accessors. Wrapped values retain conservative previews; use explicit
console evaluation to run their code. A stopped program's source
remains available even if its file is edited; start a fresh session to debug the
edited version.

## Language tools

The bundled upstream [racket-langserver](https://github.com/jeapostrophe/racket-langserver)
provides completion, hover documentation, definition, references, rename,
diagnostics, symbols, semantic tokens, signature help, inlay hints and code
actions. Support varies with the program's `#lang` and available documentation.
Hover an expression's opening delimiter or operator for its relative tail
positions. This information clears after edits until fresh analysis succeeds.
Unused imports appear as informational **unused require** diagnostics.
Syntax-template identifiers show **Predicted binding** when their binding is
unconfirmed. These labels refresh with source analysis after edits.
Formatting uses bundled `fixw`; choose the other value through the
`racket-langserver.formatting.documentFormatter` or `indentationFormatter` settings.
Basic syntax highlighting, bracket pairing and commenting also work before
the server is ready. Save new files to enable semantic language tools.

Cold startup loads the bundled source packages and can take longer on a busy
machine. Startup has a three-minute deadline by default; set
`racketdap.languageServer.startupTimeoutSeconds` to an integer from 1 to 3600
if the machine needs more time. Invalid values use the default. Restarting or
shutting down cancels a pending startup immediately, regardless of this limit.
Click the status item or run **Racket: Show Language Server Output** for details.
**Racket: Restart Language Server** restarts analysis.
`racketdap.languageServer.enabled` disables it without disabling the
debugger or commands. Advanced users can set `racketdap.languageServer.source`
to `installed` to use their own `racket-langserver` package; the default is `bundled`.
Optional Resyntax suggestions require a separately installed `resyntax` package
and `racket-langserver.resyntax.enable`; they are off by default.

Magic Racket is not required. If its language client is enabled, this extension
defers language-server startup to it to avoid duplicate providers. Disable
Magic Racket and reload the window to use this extension alone. No other
extensions or global Racket packages are disabled or changed automatically.

## Module dependencies

Use **Racket: Browse Module Dependencies** on the current named source file, or
from its Explorer context menu. The **Racket Dependencies** tree shows imports,
their phase shifts and submodules. Select an entry to open its source file;
expand it to follow dependencies. Repeated modules stop expanding within a branch.

Open Racket/Rhombus buffers, including unsaved dependency edits, participate in
analysis without being saved. The tree refreshes after source changes; its Refresh
button retries failed branches. Compilation runs readers and compile-time code in
a trusted workspace. Analysis uses public Racket APIs.

A phase label gives an import's shift relative to its parent module, not a phase
accumulated from the root: phase 0 is an ordinary import, phase +1 a compile-time
import and label phase a `for-label` import. Each request has a 20-second
deadline. A view accepts at most 32 MiB of open buffers and 200 analysed files;
a result is limited to 8 MiB, 2,000 modules, 64 levels of submodules and 20,000
imports per module. Reaching a limit reports an error rather than a partial tree;
browse a smaller module as a new root instead.

## Lambda insertion

Press **Alt+\\** (**Option+\\** on macOS) in an editable Racket buffer to insert
`λ`. The **Racket lambda** snippet is also available through **Insert Snippet**
and the `lmb` completion prefix. Change or remove the shortcut through VS Code's
**Keyboard Shortcuts** editor or `keybindings.json`; it uses the built-in
`editor.action.insertSnippet` command.

## Macro expansion

**Racket: Open Line or Selection in Macro Stepper** (**Alt+Shift+Enter**) opens
complete selected forms, or the current line, in Racket's macro-stepper window.
Fragments use a fresh Racket namespace. **Racket: Open File in Macro Stepper**
expands the entire module with its own imports and macro definitions. Both use
the current buffer, including unsaved edits.

Expansion runs compile-time code, but does not execute the module's runtime
body. These commands use the full Racket installation's public macro-debugger
library and require a graphical desktop. The stepper is a separate window;
startup and expansion errors appear in its terminal.
Close the stepper window to finish, or close its **Racket Macro Stepper**
terminal to cancel. Inspection does not save the buffer.

## Rhombus editing

Open a `.rhm` file for Rhombus highlighting, comments, brackets and indentation.
Saved files use the existing language-server connection. Install the `rhombus`
package in the Racket environment selected by `racketdap.racketExecutable` to
enable semantic analysis; **Racket: Install Package** can do this. The language
runtime is not bundled or installed automatically. `rhombus-lib` supplies the
language without documentation.

Automatic Rhombus formatting is disabled because the bundled default formatter
handles Racket S-expressions. Rhombus uses its own basic indentation rules.

Rhombus support covers editing. Rhombus source debugging, Debug REPL and Test
Explorer compatibility are not established by these checks.

## Running, testing and REPL

- **Racket: Run Current File** saves and runs the root module and its `main`
  submodule once. Text and images appear in **Results** beside the source.
  The program exits after its work completes; Results remains available.
- **Racket: Debug Current File** opens the same Results view with native
  breakpoints, stepping, Call Stack and Variables. It stops on entry.
- Click an image to enlarge it, or use **Save image…**. Click an error location
  to inspect its source when a location is available; changed files open the
  captured source read-only. Run uses Racket's error locations, which can be
  absent or approximate; Debug can identify instrumented expressions precisely.
- **Run again** or **Debug again** saves the file and starts a fresh execution,
  replacing that file's output. **Stop** retains output; closing Results stops
  its execution. Results is bounded to 32 MiB / 1,000 entries and is not saved
  when the view closes. Program input accepts lines and EOF.
- **Racket: Run Current File in Terminal** runs a VS Code process task. Use it
  for terminal applications or programs requiring native process streams.
  Results captures Racket output through a custom port and provides line input,
  rather than a full terminal. Existing `launch.json` configurations keep their
  configured console behaviour.
- **Racket: Test Current File** saves and runs the file through Test Explorer.
- **Racket: Debug Tests in Current File** runs the same tests with source
  breakpoints and stepping enabled.
- File actions use the workspace folder as their working directory, or the
  file's directory when no folder is open.
- **Racket: Start REPL** opens a persistent Racket terminal for the workspace.
- **Racket: Load Current File in REPL** saves and uses `racket/enter` to load or
  reload the module and enter its namespace, including its private definitions.
- **Racket: Evaluate Selection in REPL** sends the selected complete expression
  to the current workspace REPL. Load a file first to use its definitions.

Set `racketdap.repl.sessionScope` to `file` to keep a separate plain REPL for
each saved file. Start, Load and Evaluate Selection then use that file's terminal,
named with its workspace-relative path. Load the file before evaluating its
definitions, and load again after editing to reload it through `racket/enter`.
Closing or exiting a REPL lets the next command create a fresh session.

The default, `workspace`, shares a REPL within each workspace folder. Unsaved
files and commands without an active source file use that workspace session in
either mode. Switching modes leaves existing sessions available; switching back
reuses them. A renamed file gets a separate session in file mode.

The editor toolbar has Run, Debug and **File Actions…** controls. File Actions
also offers testing and both kinds of REPL.

### Test Explorer

Open VS Code's Testing view to discover workspace `.rkt` files. Discovery does
not execute code. Expand a file or open it in the editor to discover direct,
literal-named RackUnit `test-case` forms in standard `racket` and `racket/base`
modules. Run or Debug a case from its gutter control, Test Explorer or the
normal **Test at Cursor** commands. Duplicate names remain separate cases.
Calls to `run-tests` are also discoverable, including suites held in variables
or built dynamically. Run a suite to see its nested cases and individual results.
Each nested case supports Run, Debug and Coverage. Suite construction and
fixtures still run when selecting a case; other case bodies are skipped.
Generated tests need stable names and ordering for individual reruns. Run the
suite again to refresh its inventory. Opening or refreshing files never executes
their tests. Other readers, custom runners and mixed test forms retain
whole-file execution. Run or Debug one file, a workspace folder,
or all discovered files. Each file runs its `test` submodule if present, otherwise its module body;
it does not automatically run `main`. Each file has a fresh process. Cancel
stops the current test and skips queued files without stopping other sessions.

Results include logged check counts, test output and clickable failure
locations for direct RackUnit checks and cases inside discovered suites.
Explicitly run suites also contribute their RackUnit counts; custom runners
that replace the reporting hooks may provide details only in test output.
Teaching-language checks such as `check-expect` also report counts and failure
locations. Signature violations fail the file; registered checks that never run
produce an incomplete result. Plain Racket modules using
`test-engine/racket-tests` must invoke `(test)` themselves.
An individual run preserves module setup and skips the other discovered cases.
Source changes are checked before execution so a stale selection cannot run a
different case. Uncaught
runtime errors can stop in the debugger; handled RackUnit failures are reported
normally, so set a source breakpoint to investigate them.

Configure `racketdap.testing.include` and `racketdap.testing.exclude` to choose
files. Generated directories, vendored code and `info.rkt` are excluded by
default. These settings govern discovery; **Test Current File** explicitly runs
the selected file. Choose **Run with package policies (raco test)** on files to
apply omissions, arguments, timeouts and other native policies. This profile
reports file results and shows native output in its task terminal; cancellation
stops its task. Ordinary Run, Debug and Coverage retain individual results and
instrumentation without imposing package policies. **Racket: Test Package**
runs an entire installed package. Changes to source invalidate previous results.

Use VS Code's **Run Tests with Coverage** controls to see executed and unexecuted
expressions in the Test Coverage view and editor. Coverage combines completed
tests and their loaded dependencies under `racketdap.testing.sourceRoots`.
It measures executed expressions, including constants and references, rather
than branch or function coverage. Transformer code and files that were never
loaded are not measured.
Changed sources are omitted. Run coverage again after editing.

### Debug REPL

**Racket: Run in Interactions** loads the saved root module into a fresh session
and opens its Interactions view beside the source. Text and image results appear
automatically, including expressions at the top level of the file. Try
`examples/images.rkt`: its three pictures appear as soon as the file loads.
Click a picture to open it full-size, or use **Save image…** beneath it.

Enter expressions at the prompt and press Enter; Shift+Enter inserts a newline.
Up/Down recalls previous expressions. **Interrupt** cancels evaluation or image
conversion. **Run again** saves the file and starts a fresh session; **Stop**
leaves its output visible. **Program input** supplies lines or EOF to `read-line`
and other input operations. Closing the Interactions tab stops its session.
Output is retained until cleared, restarted or closed, within a 32 MiB/1,000-entry
limit. It is not saved across editor reloads. Image conversion runs as part of
printing and can execute the value's converter; failures appear in the output.

Errors include clickable source locations when the evaluator has retained the
relevant source. Try `(broken)` from `examples/errors.rkt`. If an exception
breakpoint pauses execution, choose **Continue** to finish reporting the error.
Clicking a location
opens and selects the expression in the source editor. If its file has been
changed or deleted since execution, a read-only **Captured** document shows the
text that ran. Links remain usable after the session stops while the error is in
the transcript. Clearing, restarting or closing Interactions releases that
history; an already opened captured document remains available until its tab closes.

Malformed input links to the entered text. **Submitted expression** opens the
whole expression when no exact location within it is available. **Context:**
labels approximate stack locations. Arbitrary error-message text is never parsed
as a file link. Each error retains at most eight locations and 1 MiB of captured
source, counted within the transcript limit. Omissions caused by these limits
are reported. Locations in uncaptured libraries or embedded WXME editors may be
unavailable. The normal error formatter and debugger exception controls remain
in effect.

**Racket: Load Current File in Debug REPL** reuses this file's session and
Interactions view. These commands do not execute `main` or `test`. The native
Debug Console remains available. To evaluate an expression selected in the source,
press **Shift+Enter** or choose **Racket: Evaluate Selection in Debug REPL**. Calls can hit breakpoints
in any instrumented workspace file. At a stop, the selected stack frame supplies
the lexical environment; at the interaction prompt, the module's namespace
includes private definitions.

Change or remove the shortcut in VS Code's **Keyboard Shortcuts** editor by
searching for **Racket: Evaluate Selection in Debug REPL**, or use `keybindings.json`.

Both selection commands support multiple selections. Select complete expressions;
they run from top to bottom, ignoring empty cursors. The Debug REPL prints each
result and stops the batch if an expression fails or is cancelled.

Each file has its own Debug REPL. Loading again reuses it. Use **Racket: Restart
Debug REPL for Current File** to load saved edits into a fresh session. Restart
and Stop affect that session only. With several sessions open, use the Debug
Console's session selector to choose where manually typed expressions go.
Selection commands always target the source file's Debug REPL. Cancel Evaluation
interrupts evaluation in the active Racket debug session; Stop ends the session.

Plain REPL terminals continue to run ordinary Racket through `racket/enter`.
Debug REPL program input uses its associated integrated terminal.

For a saved WXME source file, use **Open With → Racketeer WXME Viewer** to read
text and embedded bitmap images in source order. The viewer is read-only and
does not run the program. Ordinary Racket files still open in the text editor.
Nested editors, comment boxes, XML boxes and Racket boxes retain their boundaries
and contents. XML labels show the whitespace mode; Racket labels distinguish
single values from splicing. Other object classes are reported as unsupported. A changed file is
marked in the view; close and reopen it to refresh. Unsaved text edits must be
saved or reverted before viewing.

Choose **Open With → Racketeer WXME Editor** to edit text around embedded
images and inside nested editors or comment boxes. It supports VS Code's
Undo, Redo, Save, Save As, Revert and unsaved-document recovery. Use the toolbar
to insert a PNG image, comment box or nested editor at the cursor. Selecting
text before inserting a box moves that text inside it. The × button removes an
object and its contents; Undo restores them. XML and Racket boxes support text
editing, insertion and removal. Box controls change XML whitespace handling or
Racket splicing, with normal Undo/Redo. Their original object types and nested
contents survive saving. The writer uses Racket's public editor libraries.
Unsupported box versions, other object classes and linked or
missing images cannot be edited. PNG imports are limited to 8 MiB and 4096 pixels
in either dimension.
Save As opens its destination in the configured default editor. Use Open With
to continue in the WXME editor if needed.

Editing requires the full Racket installation's GUI libraries and a working
graphical display on the extension host. It opens inside VS Code; no separate
Racket window is shown. The read-only viewer also works without a display.
Saving preserves supported objects and unchanged text styles through Racket's
editor codec and can change the file's binary representation. Text placed in a
comment box takes the framework's standard comment-box style. If the file
changes externally, use Revert to reload it or Save As to keep the edited version.

**Racket: Run Current File** and **Racket: Debug Current File** save and launch
the active WXME document from either the editor or viewer. A dirty editable view
of the same file is saved before launch. Debugging opens a read-only source snapshot with an
object replacement character (U+FFFC) for each image or box. Use that snapshot
for breakpoints and stepping through the surrounding source text. The program
executes from the original WXME bytes; the snapshot remains fixed if the file
is edited during a stop. Language services, breakpoints in the custom editor and
locations inside embedded boxes are not yet available.

The Interactions view draws returned and printed image values automatically.
For the native Debug Console, after an expression returns an image, choose **Racket: View Image** from the
Command Palette or the preview button on the debug toolbar.
It opens a PNG snapshot in VS Code's built-in image editor. Use **Racket: Save
Image As…** from that editor to keep a copy. Try `tile`, `drawing` and `chart`
in `examples/images.rkt` for `2htdp/image`, pict and plot examples.
If an expression returns several image values, such as `(values tile drawing chart)`,
the command asks which one to view. The labels retain each value's position in the
complete result, including any non-image values.
The picker lists up to 200 images from that result; evaluate a particular value
separately to view one beyond that limit.

While paused, right-click an image in **Variables** and choose **Racket: View
Image**. This also works for image fields inside expanded structures and images
in the **Return values** scope. It uses the selected value directly, without evaluating
an expression or changing the last console result. Previews share one editor
group so opening several images keeps the source visible.

Viewing converts the retained value; it does not evaluate the expression again.
Conversion can execute the value's code: use **Racket: Cancel Evaluation** to
interrupt it. The live result expires when another interaction starts or the
program resumes. A rendered snapshot remains available until its last tab is
closed or the editor reloads. PNG previews are limited to 8 MiB. Inline image
output is provided by the Interactions view; the native Debug Console remains textual.

For a live value returned by `plot`, `plot3d`, `plot-snip` or `plot3d-snip`, choose
**Racket: Open Interactive Plot** from the Command Palette, debug toolbar or
Variables context menu. It opens an independent copy in a Racket GUI window.
Drag within a 2D plot to zoom; click to undo a zoom. Drag a 3D plot to rotate it.
Mouse overlays installed through the plot API remain active. **Save PNG…** saves
the current view. Try `curve` and `surface` in `examples/interactive-plots.rkt`.
Static values from `plot/pict`, `plot/bitmap` or `plot/no-gui` remain snapshots.

Opening a view uses the retained value without reevaluating the expression.
Copying may execute user code; **Racket: Cancel Evaluation** interrupts opening.
Close a plot window to release that view. Stopping or restarting its debug
session closes all its plot windows. Subsequent REPL evaluations leave open
windows available. Racket GUI libraries and a working display on the Racket
host are required; these windows are separate from VS Code's image editor.
In a plain terminal REPL, `(require plot)` and `(plot-new-window? #t)` make later
`plot` and `plot3d` calls open their own windows using Racket's public plot API.

The workflow follows Racket's [picture-value model](https://docs.racket-lang.org/quick/)
using the public [conversion protocol](https://docs.racket-lang.org/file/convertible.html).
Interactions displays these values inline, with a native image preview available
by clicking the picture.

## Application logs

Choose **Racket: Show Application Log**, or **Logs** in Interactions, to open a
session's messages in the native Output panel. If several sessions are available,
choose one by its file and session number. **Racket: Set Application Log Filter…**
changes capture for a running session. **Racket: Clear Application Log** clears
its retained messages.

The default filter is `error`, which captures errors and fatal messages. Start a
filter with `none`, `fatal`, `error`, `warning`, `info` or `debug`, then optionally
add exact topic overrides. `warning debug@network none@storage` captures warnings
and more severe messages generally, all network messages and no storage messages.
The last override for a repeated topic wins. Filters affect new messages; earlier
messages remain visible. `none` disables capture. Set `racketdap.logs.filter` for
new sessions, or `logFilter` in a launch configuration to override that setting.

Try `examples/logging.rkt` in Interactions. Open its log, change the filter to
`warning debug@network`, then evaluate `(sample-logs)` to see the difference.
Capture begins before module loading. Stopped sessions keep their received logs;
new sessions start with a fresh log and their configured filter. Up to ten stopped
session logs are retained until the editor reloads. Each session retains at most
1,000 messages and 1 MiB of message text, with omission notices. Individual messages
are truncated at 16,384 characters. Large pending bursts can be omitted at filter
changes or program exit; those omissions are reported. Forced termination can
lose messages still waiting in the worker.

Capture uses the public [Racket logging API](https://docs.racket-lang.org/reference/logging.html)
for the program's current logger and descendants, including child threads and
REPL evaluations. Loggers detached from that hierarchy and other processes are
outside this stream. Existing stderr logging remains active. Opaque log data is
not inspected or printed. Terminal-only runs use Racket's own logging facilities;
this view belongs to debugger-backed sessions, including Interactions and tests.

Adapter clients can select an initial `logFilter` at launch and change it with
`racketdap/logFilter` (`{ "filter": "warning debug@network" }`). Ordered
`racketdap/log` events carry batches of `entries` with `level`, `topic` (string or
false) and `message`, plus an omitted-message count `dropped` and a boolean
`discardedBacklog`. The worker uses bounded batches; clients should bound their
own retained history as well.

## Packages

Use **Racket: Manage Packages** to install, link, update, remove, build, test
or open package source. Management changes use user scope for the configured
Racket installation. Dependencies, locking and package test metadata are
handled by the native `raco` commands in task terminals. Successful changes
restart language analysis; restart existing REPLs to load changed code.

Use **Racket: Choose Packages to Debug** to include installed or linked package
source outside the workspace in Debug, Debug Test and Debug REPL. This sets
`racketdap.debug.packages`; launch configurations can override it with
`debugPackages`. Package names may differ from the collection names in
`require`. Source must be available, and selection is not transitive.

**Racket: Test Package** honours `info.rkt` policies through `raco test --package`.
Test Explorer still runs individual RackUnit files and does not yet implement
all package test metadata.

## Current limits

This remains a development release. Runtime debugging is tested with
`racket/base`, `racket`, Scheme, Typed Racket, teaching languages, custom module
languages, plain files and GUI callbacks. Other languages and operating systems
need further testing. The repository's `docs/parity/DEBUGGER.md` records the
debugger feature mapping and validation scope.

Caught-exception tracing, transformer-phase stepping, arbitrary-process attach,
reverse execution, full TTY input and a graphical source editor are
outside this release. Local syntax transformers are not reconstructed for console
evaluation. Standard text sources are used in VS Code.

A breakpoint stops only the triggering Racket thread. Other threads continue;
shared values can change. Pause can interrupt a blocked primitive while retaining
live frames; its location is marked approximate in the stop description. If a
break arrives without an instrumented frame, stopping waits for the next source
expression. Code that disables breaks defers interruption. Source files under the
workspace folder are instrumented by default; collection dependencies normally
run without instrumentation. GUI callbacks continue to dispatch while an
interactive session waits for console input.

The debugger's expression instrumentation and frame/binding support are under
`runtime/racketdap/instrumentation/`, alongside the component design.
The language server uses Racket’s installed language-analysis
libraries, including check-syntax. Bundled language-server sources,
archive hashes and licence notices are under `language-server/`; JavaScript
dependency notices are in `out/THIRD_PARTY_NOTICES.txt`.

Copyright © 2026 Eric Parsonage. Racketeer's original code and documentation
are licensed under Apache-2.0 OR MIT, at the licensee's option. The extension includes
`LICENSE`, `LICENSE-APACHE`, `LICENSE-MIT` and `COPYRIGHT`. Bundled dependencies
retain their own copyright and licence notices.

### Building applications

Use **Racket: Create Launcher…** or **Racket: Build Executable…** with a source
module open, choose Console or GUI mode and select the output path. Use
**Racket: Create Distribution…** on an executable to collect its runtime
dependencies. Builds run as native VS Code tasks; **Tasks: Terminate Task**
cancels them. A launcher needs its original source and Racket installation;
an executable embeds code but can still need runtime files. Distributions
target compatible operating systems and architectures and may need system libraries.

The `racket-build` task type supports `action` (`launcher`, `executable` or
`distribution`), `source`, `output`, `gui` and additional `libraries`/`languages`
for embedded executables. Paths are relative to the task's workspace folder;
native task variables and `dependsOn` are supported. The selected folder's
`racketdap.racketExecutable` setting supplies the build tools. Try
`examples/application/console.rkt` and `examples/application/gui.rkt` in the
source checkout. Declare data files with `define-runtime-path` for distribution.
The public tools control overwrite and partial-output behaviour; check task
completion before using a build.

### Workspace references

Racketeer analyses unopened Racket module files in trusted workspaces using a
separate indexing service. It works with either the bundled or installed language
server, reusing the bundled analysis libraries.
Nothing is analysed until a request asks: the first Find All References or Rename
after a change waits for an analysis pass, which can be cancelled and which keeps
what it finished. A pass analyses again only the files whose text or dependencies
changed.
Unsaved editor buffers remain authoritative for their source files, including where
another file imports them; closing a buffer returns that file to disk analysis.
A file read by `include` and its like is read from disk, whatever a buffer holds.

The status bar counts the files of a pass and warns when references are partial.
Use **Racket: Refresh Workspace References** after external package changes or
to retry failed analysis. **Rename Symbol** uses the same workspace scope and
previews binding-checked edits across unopened files. It preserves explicit
import aliases, nested prefixes and prefixes around selective imports.
Selectors over composed imports, phase-shifted uses and selectors shared by multiple export
phases may be refused.
Files that fail analysis make the index partial; rename refuses incomplete or
stale snapshots, and says which file and limit stopped a worker. Background diagnostics are not part of this feature.

Settings under `racket-langserver.workspaceAnalysis` control whether analysis
is enabled, excluded directory names, file count, maximum source size and the
time limit per file. Defaults are 1,000 files, 1 MiB per file and 20 seconds per
file. A request stops waiting and says so when sources keep changing, as under a
generator or a build, and no more files have been analysed for that time limit. A pass runs at most three workers at once and no
more than half the number of processors, each in a process of its own, and gives the
same answers as one at a time. Compile-time code in different files can therefore run at
the same moment. Each worker adds about 260 MB to the index's memory, more with heavy
libraries, and has a
2 GiB limit on the memory its analysis adds to its own libraries. Analysing a
file of 1 MiB can need about 1 GiB; the limit is there to stop compile-time code
that never releases what it allocates, and it applies to each worker rather than
to a pass, because a worker's memory ends with it. A pass accepts at most 16 MiB
of source input and 200,000 reference/definition locations. Excluded directories and symbolic links are not scanned. Reaching
a limit or failing to analyse a file produces a partial index.

Changes within watched workspace directories mark the analysis out of date, and
changes to files that are not source files are noted when the next request arrives.
A pass then checks every file each analysis loaded or registered with the compiler,
wherever it is, so a change outside those directories is seen at the next pass. A
change while a pass runs replaces it, and the new pass starts 2 seconds after that
change. A macro reading a file it does not register sees that file only
at the next change to a file loaded with it, after a refresh or a restart.
Excluded files, environment changes and nondeterministic macros also require a
manual refresh. Initial indexing can take time, especially
when dependencies are not compiled. These limits bound work and retained facts;
they are not a total process memory limit. Both language tools use Racket's
compilation cache under the Racket addon directory's `racketeer`
subdirectory, keeping generated bytecode outside the project.
