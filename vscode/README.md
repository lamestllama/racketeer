# Racketeer: Organised Racket

**A Racket IDE for VS Code.** Debug, run, test, navigate and package Racket in one extension, with nothing to install but Racket itself.

By [Eric Parsonage](https://github.com/lamestllama).

- **Debug** with breakpoints on lines and on the calls within a line, stepping across files and chosen packages, and live variables. Racketeer is the only Racket extension on the VS Code Marketplace that debugs Racket source.
- **See results beside the code:** text, images, picts and plots as a program prints them. While debugging, zoom and rotate a plot in its own window.
- **Test** from VS Code's Testing view: run, debug or measure coverage of a file, or of a single RackUnit case in plain modules and suites.
- **Work interactively** in an Interactions window, with pictures inline and errors that link to their source, or in a plain Racket REPL in the terminal.
- **Navigate** with hover documentation, completion, go to definition and live diagnostics, from the bundled [racket-langserver](https://github.com/jeapostrophe/racket-langserver).
- **Find and rename across a project's module files,** including ones that are not open, with an index that uses no CPU until asked. Folders such as `build` and `dist` are left out by default.
- **Expand and build** with the macro stepper, package management, executables and distributions.
- **Edit** WXME documents with embedded boxes, and Rhombus with the separate `rhombus` package.

![A Racket file beside its Results: a curve, a 3D surface and a picture](https://raw.githubusercontent.com/lamestllama/racketeer/main/docs/images/results-with-plots.png)

![Stopped at a breakpoint, with Variables and the Call Stack showing](https://raw.githubusercontent.com/lamestllama/racketeer/main/docs/images/debugging.png)

![The Testing view with one failed case, and its failure shown in the editor](https://raw.githubusercontent.com/lamestllama/racketeer/main/docs/images/test-explorer.png)

## Install and start

1. Install [Racket 9.1 or newer](https://download.racket-lang.org/), the full distribution, and put it on PATH or set `racketdap.racketExecutable`.
2. Install **Racketeer** from the Extensions view.
3. Open a trusted folder and a saved `.rkt` file. **Racket: ready** appears in the status bar when the language tools have started. With Magic Racket installed, the status bar shows **Racket: external LSP** until it is disabled and the window reloaded, and the language tools and workspace index stay off.
4. Click the play icon at the top right of the editor to see its Results, or the debug icon beside it to stop and inspect it.

Debugging uses F5, F10, F11 and Shift+F11 for Continue, Step Over, Step Into and Step Out.

If Racket is not on PATH, set `racketdap.racketExecutable` in Settings. An older Racket is refused on Run, Debug, Test Explorer, the language server and the workspace index, with a message naming its version, its path and that setting. Minimal Racket alone lacks standard libraries and documentation the language tools use.

Resyntax suggestions are optional and need the separate `resyntax` package. The macro stepper, interactive plots and the WXME editor need a graphical display.

Racketeer needs no separate `racket-langserver`, Magic Racket, Node.js or npm, and installs no packages into Racket by itself. To install from a package file, choose **Install from VSIX…** in the Extensions view. Remove the earlier `lamestllama.racketdap` development extension first; existing `racketdap` launch configurations and settings keep working.

It is tested on Linux x64 and ARM64, Windows x64 and macOS ARM64 with Racket 9.1, and with VS Code 1.91 on Linux and the newest VS Code on all three.

## Run a file and see its results

Run a program and read its text and images beside the source, without leaving the editor. The editor toolbar has Run, Debug and **File Actions…** controls.

| Command | What it does |
| --- | --- |
| **Racket: Run Current File** | Saves the file, runs its root module and `main` submodule once, and shows the output in **Results**. Results stays open after the program exits. |
| **Racket: Debug Current File** | Opens the same Results view with breakpoints, stepping, Call Stack and Variables, and stops on entry. |
| **Racket: Run Current File in Terminal** | Runs the file as a VS Code task, for terminal applications and programs that need native process streams. |
| **Racket: File Actions…** | Offers running, debugging, testing and both kinds of REPL for the current file. |

In Results:

- Click an image to enlarge it, or use **Save image…**.
- Click an error location to open its source. A file that has changed since the run opens as the captured source, read-only.
- **Run again** or **Debug again** saves the file and starts afresh, replacing that file's output. **Stop** keeps the output. Closing Results stops its execution.
- **Program input** sends lines and end of input to the program.

These commands use the workspace folder as their working directory, or the file's directory when no folder is open.

**Good to know:** a Results view is not saved when it closes, and it holds a limited amount of output. It offers line input, not a real terminal, so a program that needs one should use **Racket: Run Current File in Terminal**. Run takes error locations from Racket, which can leave them absent or approximate; Debug locates instrumented expressions precisely.

Details: [Run, Debug, Test and REPL execution](https://github.com/lamestllama/racketeer/blob/main/docs/workflows.md#results-view).

## Debug with breakpoints

Stop a program on a line, or at a call or form within one, in any file of the workspace or a chosen package, and look at what it holds.

Click the gutter to the left of a line number, press **F9** or right-click and choose **Add Breakpoint**. Press F9 again to remove it. This works in the source file and in the captured source tab the debugger opens.

- A breakpoint binds to the outermost expression that begins on its line. Use an inline breakpoint to choose a later expression on the line. On the final character of a non-tail expression, an inline breakpoint stops after that expression returns.
- **Racket: Continue to Cursor** runs to one chosen point, once, and keeps ordinary breakpoints in force.
- A breakpoint stays pending until its module loads. With no expression at that place, it stays unverified and says why. It never moves into another function.
- A constant, a bare variable, a definition of either, a `struct` form, quoted data and compile-time code have no place to stop, so a breakpoint there remains unverified with an explanation. A `require`, and a line that holds only a function's header, have none either, so set the breakpoint on a line of its body.

Right-click a breakpoint to add a condition, a hit count or a log message:

| Kind | Example | What it does |
| --- | --- | --- |
| Condition | `(> subtotal 100)` | Stops when the Racket expression is true. Only `#f` is false. |
| Hit count | `%3` | Stops by count: `N`, `=N`, `>=N`, `>N`, `<=N`, `<N`, or `%N` for every Nth hit. |
| Log message | `subtotal={subtotal}, tax={(* subtotal rate)}` | Writes to the Debug Console and continues. `{{` and `}}` give literal braces. |

**Good to know:** these expressions really run, so they can have effects, and an error in one stops at the breakpoint with a diagnostic. A breakpoint added to an already loaded dependency that is not instrumented needs a fresh launch. A breakpoint stops only the Racket thread that hit it, so other threads carry on and shared values can change.

Details: [Breakpoints](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md#breakpoints).

### Stop on uncaught exceptions

**Uncaught Racket exceptions** in the Breakpoints pane is on by default. It stops at an uncaught runtime error with the Call Stack, lexical variables, an Exception scope and the exception's details all available. **Continue** then lets the same exception go on: a script usually ends, and an interactive console call reports the error and leaves the module loaded.

**Good to know:** exceptions the program handles are not intercepted. Expansion and load errors with no instrumented context appear as diagnostics, not as stops.

Details: [Uncaught exceptions](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md#uncaught-exceptions).

## Step through expressions

Stepping goes expression by expression and shows both the start of an expression and what it returned, so a return value can be read before moving on. VS Code's own controls and panels do the work:

| Control | What it does |
| --- | --- |
| **Continue** (F5) | Runs until a breakpoint, an exception or the end of the program. |
| **Step Into** (F11) | Visits expression starts and completions, entering calls. |
| **Step Over** (F10) | Evaluates the expression with its calls, then stops at the call site when it returns. |
| **Step Out** (Shift+F11) | Leaves the current function. With no caller to return to, it finishes the evaluation around the stop. |

**Call Stack** marks each stop **Before evaluation** or **Returned N values**. After a return, the marker sits on the closing parenthesis; open **Return values** to read the values. Its heading gives the count, such as **Return values (2)**, so zero values and one `#<void>` stay distinct. **Waiting for return** marks a caller whose calculation is still pending.

**Choose where a session first stops.** The default launch stops before the first instrumented expression inside `module+ main`, or in the module body when there is no `main`. An explicit submodule selection or a test launch uses that submodule. Explicit breakpoints still work during initialisation, including in required files.

- Set `stopOnEntry` to `false` to run directly to a breakpoint.
- Set `"stopOnEntryMode": "firstExpression"` beside `"stopOnEntry": true`, or choose **Racket: debug initialization** from **Add Configuration**, to pause before `main`, at the first instrumented expression, including initialisation in debugged dependencies. The default mode is `"entryPoint"`.

**Good to know:** the debugger does not stop in macro-time code or in code that is not instrumented, and Run Without Debugging ignores both stop modes. Several stops can share a source line, and some stops highlight a whole function. A tail call has no return stop of its own, so stepping over a tail expression can finish the program. Code a macro generates has no stops at the place of an expression written there, so the value shown against that expression is its own.

Details: [Understanding the stops](https://github.com/lamestllama/racketeer/blob/main/docs/stepping.md), a walkthrough of a real program.

## Inspect and change values

Read and change the live state of a stopped program.

- Select a frame in **Call Stack** to see its lexical variables in **Variables → Locals**.
- Evaluate Racket in the **Debug Console** or **Watch**: for example, `(+ subtotal 20)` or `(set! subtotal 200)`.
- Hover over a variable to read it. Hover does not expand user macros.
- Open a pair, vector, box, hash or visible structure to see inside it. A long container opens in groups of rows. Fields of a structure are numbered, since Racket does not record their names at run time.
- A variable a macro binds is listed when the source refers to it, such as `it` from an anaphoric macro. Temporaries such as `tmp` are not.
- In a class's methods and initialisers, **Locals** has a row named `this` that opens to the object's fields. A field the method reads or assigns also has a row under its own name, which **Set Value** writes.

From the editor context menu or the Command Palette:

| Command | When | What it does |
| --- | --- | --- |
| **Racket: Skip Current Expression** | Before an expression | Skips it and asks for the values to return in its place. |
| **Racket: Change Return Values** | After an expression | Replaces its results. `(values)` gives zero values. |
| **Racket: Print Return Values** | After an expression | Prints its results in the Debug Console with full Racket printing. |
| **Racket: Print Variable Value** | At a variable | Prints the variable under the cursor for the selected frame. |
| **Racket: Set Variable Value** | At a variable | Assigns to the variable under the cursor with `set!`. |
| **Racket: Cancel Evaluation** | While evaluating | Interrupts a blocked console, watch, condition or logpoint evaluation. |

Hover, Go to Definition and Find References also work in captured debugger sources while they match the file on disk.

**Good to know:** evaluation and assignment take real effect, and cancelling does not roll anything back. Cancellation is cooperative, so code that disables or catches breaks may keep running; **Stop** still ends it. Automatic inspection does not force promises, call custom writers or invoke wrapped accessors, so evaluate an expression in the console to run them. Imported bindings keep Racket's assignment protections. A stopped program's source stays available if its file is edited; start a new session to debug the edited version.

Details: [Evaluation and values](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md#evaluation-and-values) and [debugger features](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md).

## Save a launch configuration

Keep the way a program starts in `launch.json`:

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

| Attribute | What it does |
| --- | --- |
| `program`, `args`, `cwd`, `env` | The file, its arguments, working directory and environment. |
| `racketExecutable` | The Racket executable for this launch. |
| `submodule` | The submodule to run, such as `["test"]`. `[]` loads only the root module. By default `main` runs when present. |
| `entry` | An exported zero-argument procedure to call after loading, such as `"run"`. |
| `language` | The language for a plain file without `#lang` or a module declaration, such as `"racket/base"` or `"r5rs"`. Leave it unset for module programs. |
| `testMode` | Runs tests and reports them. It cannot be combined with `interactive`, `submodule`, `entry` or `language`. |
| `interactive` | Keeps the module loaded until **Stop**, so the Debug Console can call into it. Calls can hit breakpoints and be stepped through. |
| `console` | `integratedTerminal` for line input and output in a **Racket: …** terminal. The default, `internalConsole`, sends output to the Debug Console and gives the program end of input. |
| `stopOnEntry`, `stopOnEntryMode` | Where a session first stops. |
| `sourceRoots`, `debugPackages` | The directories and installed packages to debug. |
| `logFilter` | The application log filter for this launch. |
| `debugCache` | Whether to keep instrumented compiled code between sessions. |

Without `interactive`, the session ends after the entry action and any GUI work: visible windows, timers and queued callbacks keep a GUI program alive.

In the integrated terminal, Enter submits a line, Ctrl+D on an empty line sends end of input and Ctrl+C interrupts the running interaction or program. Closing the terminal sends end of input. Debug Console input always evaluates Racket.

Instrumented code is kept between sessions, so a program that has not changed starts without being expanded and compiled again. `racketdap.debug.compiledCache`, on by default, turns this off for new sessions. A macro that reads a file should register it with `register-external-file` so that a change to the file is seen.

A program that embeds the debugger library can be reached with `"request": "attach"`, its `port` and its secret `token`. This does not attach to an arbitrary process.

Details: [launching a program](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md#launching-a-program), [compiled code](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md#compiled-code) and [attaching](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md#attach-to-an-embedded-racket-program).

## Work interactively

Keep a program loaded and try expressions against it, in an Interactions window with pictures inline and errors that link to their source, or in a plain Racket REPL in the terminal.

### Interactions and the Debug REPL

**Racket: Run in Interactions** loads the saved root module into a fresh session and opens its Interactions view beside the source. Text and images appear automatically, including expressions at the top level of the file. Try [examples/images.rkt](https://github.com/lamestllama/racketeer/blob/main/examples/images.rkt) from [the repository](https://github.com/lamestllama/racketeer): its three pictures appear as soon as the file loads.

- Enter an expression at the prompt and press Enter. Shift+Enter inserts a newline, and Up and Down recall earlier expressions.
- Click a picture to open it full-size, or use **Save image…** beneath it.
- Click an error's location to open and select the expression in the source. A file changed or deleted since the run shows a read-only **Captured** copy of the text that ran. Try `(broken)` in [examples/errors.rkt](https://github.com/lamestllama/racketeer/blob/main/examples/errors.rkt) from [the repository](https://github.com/lamestllama/racketeer).
- **Interrupt** cancels evaluation or image conversion. **Run again** saves the file and starts a fresh session. **Stop** leaves the output visible. **Program input** supplies lines or end of input to `read-line` and other input operations. **Logs** opens the session's application log.

| Command | What it does |
| --- | --- |
| **Racket: Load Current File in Debug REPL** | Reuses this file's session and Interactions view. |
| **Racket: Evaluate Selection in Debug REPL** (Shift+Enter) | Evaluates the selected complete expressions, top to bottom, in the file's Debug REPL. It stops at the first that fails or is cancelled. |
| **Racket: Restart Debug REPL for Current File** | Loads saved edits into a fresh session for that file. |

Calls can hit breakpoints in any instrumented workspace file. At a stop, the selected stack frame supplies the variables; at the prompt, the module's namespace includes its private definitions. Each file has its own Debug REPL. With several open, the Debug Console's session selector chooses where typed expressions go.

To change or remove the shortcut, search for **Racket: Evaluate Selection in Debug REPL** in the **Keyboard Shortcuts** editor, or use `keybindings.json`.

**Good to know:** these commands do not run `main` or `test`. Closing the Interactions tab stops its session, and its output is not saved across editor reloads. If an exception breakpoint pauses execution, choose **Continue** to finish reporting the error. Image conversion can execute the value's converter.

Details: [Interactions and the Debug REPL](https://github.com/lamestllama/racketeer/blob/main/docs/workflows.md#interactions-and-the-debug-repl), and a [four-file walkthrough](https://github.com/lamestllama/racketeer/blob/main/examples/multi-file/README.md).

### A plain REPL

For ordinary Racket in a terminal, without the debugger:

| Command | What it does |
| --- | --- |
| **Racket: Start REPL** | Opens a persistent Racket terminal for the workspace. |
| **Racket: Load Current File in REPL** | Saves the file, then loads or reloads it with `racket/enter` and enters its namespace, including private definitions. |
| **Racket: Evaluate Selection in REPL** | Sends the selected complete expressions to the current REPL. Load a file first to use its definitions. |

Set `racketdap.repl.sessionScope` to `file` for a separate REPL per saved file, named with its workspace-relative path. The default, `workspace`, shares one within each workspace folder. Closing or exiting a REPL lets the next command create a fresh one.

Details: [REPL terminals](https://github.com/lamestllama/racketeer/blob/main/docs/workflows.md#repl-terminals).

## View images and plots

Results and Interactions draw the images, picts and plots a program prints. Only printed values become pictures: a value at the top level of a module or passed to `print` is drawn, while `displayln`, `display` and `write` of a pict show `#<pict>`. In a debug session:

| Command | Where | What it does |
| --- | --- | --- |
| **Racket: View Image** | Command Palette, debug toolbar, or right-click an image in **Variables** | Opens a PNG snapshot in VS Code's image editor. After an expression returning several images, it asks which. Also works for image fields in expanded structures and in **Return values**. |
| **Racket: Save Image As…** | That image editor | Keeps a copy. |
| **Racket: Open Interactive Plot** | Command Palette, debug toolbar, or the **Variables** context menu | Opens a live value from `plot`, `plot3d`, `plot-snip` or `plot3d-snip` in a Racket window. Drag within a 2D plot to zoom and click to undo a zoom. Drag a 3D plot to rotate it. **Save PNG…** saves the current view. |

Try `tile`, `drawing` and `chart` in [examples/images.rkt](https://github.com/lamestllama/racketeer/blob/main/examples/images.rkt) for `2htdp/image`, pict and plot examples, and `curve` and `surface` in [examples/interactive-plots.rkt](https://github.com/lamestllama/racketeer/blob/main/examples/interactive-plots.rkt), both from [the repository](https://github.com/lamestllama/racketeer).

**Good to know:** the Debug Console stays textual. Viewing uses the value already held and does not evaluate the expression again, but conversion or copying can run the value's code; **Racket: Cancel Evaluation** interrupts it. The live value expires when another interaction starts or the program resumes. PNG previews are limited to 8 MiB. Interactive plots need Racket's GUI libraries and a working display, and stopping or restarting the session closes its plot windows. Values from `plot/pict`, `plot/bitmap` or `plot/no-gui` stay snapshots.

Details: [Images and plots](https://github.com/lamestllama/racketeer/blob/main/docs/workflows.md#images-and-plots).

## Test

VS Code's **Testing** view finds workspace `.rkt` files without executing anything. Run, debug or measure coverage for one file, a workspace folder or all discovered files, and for one case where the Testing view can list it.

- Expand a file or open it to see its direct, literal-named RackUnit `test-case` forms, in a plain `#lang racket` or `#lang racket/base` module that holds only definitions and those cases. Run a `run-tests` suite to see its nested cases with individual results.
- Run or debug a case from its gutter control, the Testing view or VS Code's **Test at Cursor** commands.
- Results show check counts, test output and clickable failure locations. Teaching-language checks such as `check-expect` report counts and failure locations too.
- Choose **Run Tests with Coverage** to see executed and unexecuted expressions in the Test Coverage view and the editor.
- Choose **Run with package policies (raco test)** on files to apply `info.rkt` omissions, arguments and timeouts. This reports per file, in a task terminal.

| Command | What it does |
| --- | --- |
| **Racket: Test Current File** | Saves and runs the file through the Testing view. |
| **Racket: Debug Tests in Current File** | Runs the same tests with source breakpoints and stepping. |
| **Racket: Test Package** | Runs an entire installed package, honouring `info.rkt` policies through `raco test --package`. |

| Setting | Default | What it does |
| --- | --- | --- |
| `racketdap.testing.include` | `**/*.rkt` | Files to discover. |
| `racketdap.testing.exclude` | Generated directories, vendored code and `info.rkt` | Files to leave out of discovery. |
| `racketdap.testing.sourceRoots` | `["."]` | Directories instrumented by Debug Test and Coverage. |

These run, debug and measure coverage as a whole file, with no single case to choose:

- a top-level `struct`, macro or expression beside `module+ test`
- `check-equal?` or another check beside `test-case`
- a `test-case` with a computed name
- `#lang typed/racket`, `#lang racket/gui` and every other language or reader
- a custom runner

**Good to know:**

- Each file runs in a fresh process, using its `test` submodule if it has one and otherwise its module body, never `main`.
- Running one case still runs suite construction and fixtures, and skips the other case bodies. Generated tests need stable names and ordering for individual reruns.
- The Testing view does not yet implement all package test metadata.
- A handled RackUnit failure is reported normally rather than stopping the debugger, so set a source breakpoint to investigate it.
- A plain Racket module using `test-engine/racket-tests` must call `(test)` itself.
- Coverage measures executed expressions, not branches or functions. It does not measure transformer code or files never loaded, and it omits edited files until coverage runs again.

Details: [Test discovery and reporting](https://github.com/lamestllama/racketeer/blob/main/docs/workflows.md#test-discovery-and-reporting).

## Navigate and edit

The bundled [racket-langserver](https://github.com/jeapostrophe/racket-langserver) provides completion, hover documentation, go to definition, find references, rename, live diagnostics, symbols, semantic highlighting, signature help, inlay hints and code actions. What it offers varies with the program's `#lang` and the documentation available. Syntax highlighting, bracket pairing and commenting work before the server is ready.

- Hover an expression's opening delimiter or operator to see its [tail positions](https://github.com/lamestllama/racketeer/blob/main/examples/tail-positions.rkt).
- Unused imports appear as informational **unused require** diagnostics.
- Identifiers in syntax templates show **Predicted binding** when their binding is unconfirmed.
- Format with the bundled `fixw`, or set a formatter setting below to `language` to indent by the rules of the file's own language, which leaves all but each line's leading space alone.
- Press **Alt+\\** (**Option+\\** on macOS) in an editable Racket buffer to insert `λ`. The **Racket lambda** snippet is also available through **Insert Snippet** and the `lmb` completion prefix. Change or remove the shortcut in the **Keyboard Shortcuts** editor or `keybindings.json`.

Click the status bar item or run **Racket: Show Language Server Output** to see what the server is doing. **Racket: Restart Language Server** restarts analysis.

| Setting | Default | What it does |
| --- | --- | --- |
| `racket-langserver.analysisWaitMilliseconds` | `250` | How long the bundled server waits after an edit before analysing, from 0 to 10000. A request a person makes, such as hover, starts analysis at once. |
| `racket-langserver.formatting.documentFormatter` | `fixw` | Formatter for whole documents: `fixw` or `language`. |
| `racket-langserver.formatting.indentationFormatter` | `fixw` | Formatter for selections and typing: `fixw` or `language`. |
| `racket-langserver.resyntax.enable` | `false` | Offers Resyntax suggestions. Needs the separately installed `resyntax` package. |
| `racketdap.languageServer.enabled` | `true` | Turns the language tools off without affecting the debugger or commands. |
| `racketdap.languageServer.source` | `bundled` | `installed` uses a `racket-langserver` package installed separately. |
| `racketdap.languageServer.startupTimeoutSeconds` | `180` | Startup deadline, from 1 to 3600. Raise it for a slow first start on a busy machine. |

**Good to know:** Magic Racket is not required. If its language client is enabled, Racketeer leaves the language server to it, to avoid duplicate providers, and offers, until you answer or dismiss it, to turn off only Magic Racket's language server and reload the window. To use Racketeer alone, disable Magic Racket and reload. No other extension or global Racket package is changed automatically. A new file not yet saved gets the bundled server's tools within that file; a relative import needs a save location, and references across a project need the file saved. Analysis runs readers and macros, which is why Racketeer works only in a trusted folder.

Details: [Language server](https://github.com/lamestllama/racketeer/blob/main/docs/editor-tools.md#language-server) and [editing and macro expansion](https://github.com/lamestllama/racketeer/blob/main/docs/editor-tools.md).

## Find and rename across a project

**Find All References** and **Rename Symbol** (F2) follow references through the module files of a trusted workspace, including files that are not open: `.rkt`, `.ss`, `.scm` and `.scrbl`, up to 1,000 files of 1 MiB each and 16 MiB in all. Unsaved buffers count as their files' text. Nothing is analysed until a request asks: the first request after a change waits for a pass, which can be cancelled and keeps what it finished, and while the window stays open the next pass analyses again only what changed. A pass analyses three files at once on six or more processors, two on four or five, and one on fewer. The status bar counts the files of a pass and warns when references are partial.

**What a rename leaves unchanged.** By default the index leaves out folders named `.git`, `compiled`, `node_modules`, `.test-output`, `dist` and `build` at any depth, symbolic links, and files of other types such as `.rktl`. A rename does not change callers in those folders and files, and the index still reports ready, so check them by hand. A module in an excluded folder counts only while it is open in the editor. To change the folders, set `racket-langserver.workspaceAnalysis.excludedDirectories`: its value replaces the whole list. No setting changes the file types.

A file over a limit is different: it makes the index partial, and rename then refuses.

Rename shows VS Code's usual preview and checks that identifiers keep their bindings before offering edits. It keeps explicit import aliases, nested prefixes and prefixes around selective imports.

**Racket: Refresh Workspace References** analyses again after external package changes, or retries a failed analysis.

| Setting | Default | What it does |
| --- | --- | --- |
| `racket-langserver.workspaceAnalysis.enabled` | `true` | Analyses unopened workspace files for references. Rename needs it. |
| `racket-langserver.workspaceAnalysis.excludedDirectories` | `.git`, `compiled`, `node_modules`, `.test-output`, `dist`, `build` | Directory names to skip. |
| `racket-langserver.workspaceAnalysis.maxFiles` | `1000` | Most files in a pass. |
| `racket-langserver.workspaceAnalysis.maxFileBytes` | `1048576` | Largest source file analysed. |
| `racket-langserver.workspaceAnalysis.timeoutSeconds` | `20` | Time limit per file. A request also stops waiting, and says so, once sources keep changing for this long with no more files analysed. |

**Good to know:** a file that fails analysis, or a file over a limit, makes the index partial, and rename then refuses. The **Racket Language Server** output names a file that failed or went over the size limit. The limits on file count and file size are settings; the 16 MiB in all is not. Rename can also refuse a selector over composed imports, a phase-shifted use, or a selector shared by several export phases. Compile-time code in different files can run at the same moment. Each extra worker adds about 260 MB while a pass runs. A macro that reads a file it does not register sees that file only at the next change to a file loaded with it, after **Racket: Refresh Workspace References**, or after a restart. Excluded files, environment changes and nondeterministic macros also need a refresh.

Details: [Workspace references](https://github.com/lamestllama/racketeer/blob/main/docs/editor-tools.md#workspace-references) and [rename across files](https://github.com/lamestllama/racketeer/blob/main/docs/editor-tools.md#rename-across-files).

## Browse module dependencies

See what a module imports, through which phases, and follow the chain into each file. Run **Racket: Browse Module Dependencies** on a named source file, or from its Explorer context menu, to fill the **Racket Dependencies** tree.

- Select an entry to open its source file; expand it to follow its own dependencies. A module repeated in a branch stops expanding.
- A phase label gives an import's shift relative to its parent: phase 0 is an ordinary import, phase +1 a compile-time import and label phase a `for-label` import.
- Open buffers count, including unsaved edits to dependencies, and nothing is saved.
- **Racket: Refresh Module Dependencies**, the tree's Refresh button, retries failed branches. The tree also refreshes after source changes.

**Good to know:** compiling runs readers and compile-time code, so this needs a trusted workspace. A very large module reports an error rather than a partial tree; browse a smaller module as a new root instead.

Details: [Module dependencies](https://github.com/lamestllama/racketeer/blob/main/docs/module-dependencies.md).

## Expand macros

See what a macro does, step by step, in Racket's macro-stepper window.

| Command | What it does |
| --- | --- |
| **Racket: Open Line or Selection in Macro Stepper** (**Alt+Shift+Enter**) | Opens the complete selected forms, or the current line, in a fresh Racket namespace. |
| **Racket: Open File in Macro Stepper** | Expands the entire module with its own imports and macro definitions. |

Both use the current buffer, including unsaved edits, and do not save it. Close the stepper window to finish, or close its **Racket Macro Stepper** terminal to cancel. Startup and expansion errors appear in that terminal. Try [examples/macro-stepper.rkt](https://github.com/lamestllama/racketeer/blob/main/examples/macro-stepper.rkt) from [the repository](https://github.com/lamestllama/racketeer).

**Good to know:** expansion runs compile-time code, but not the module's runtime body. The stepper is a separate window that needs the full Racket installation and a graphical desktop.

Details: [Macro stepper](https://github.com/lamestllama/racketeer/blob/main/docs/editor-tools.md#macro-stepper).

## Manage packages

**Racket: Manage Packages** offers everything below, and each is also a command of its own. Changes run the native `raco` commands in task terminals, in user scope, for the configured Racket installation, and **Tasks: Terminate Task** cancels a running one. A successful change restarts language analysis; restart existing REPLs to load the changed code.

| Command | What it does |
| --- | --- |
| **Racket: Install Package** | Installs by package name, Git URL, archive or local directory. |
| **Racket: Link Local Package** | Links a directory, so edits apply to the package's source. |
| **Racket: Update Package** | Updates one package. |
| **Racket: Remove Package** | Removes one package. |
| **Racket: Build Package** | Runs `raco setup` for a package. |
| **Racket: Test Package** | Runs the package's tests with `raco test --package`. |
| **Racket: Open Package Source** | Opens the package directory in a new window. |
| **Racket: Choose Packages to Debug** | Includes package source outside the workspace in Debug, Debug Test and Debug REPL. |

**Racket: Choose Packages to Debug** sets `racketdap.debug.packages`; a launch configuration can override it with `debugPackages`.

**Good to know:** package names can differ from the collection names in `require`. Debugging a package needs its source to be available, and selecting one does not select its dependencies.

Details: [Package development](https://github.com/lamestllama/racketeer/blob/main/docs/packages.md), and a [linked-package example](https://github.com/lamestllama/racketeer/blob/main/examples/packages/README.md).

## Build applications

Turn a module into something that runs on its own. With a source module open, run a command, choose Console or GUI mode and select the output path. Builds run as VS Code tasks; **Tasks: Terminate Task** cancels one.

| Command | What it makes |
| --- | --- |
| **Racket: Create Launcher…** | A launcher that runs the original source. It needs that source and the Racket installation. |
| **Racket: Build Executable…** | An executable with the code embedded. It can still need runtime files. |
| **Racket: Create Distribution…** | A directory holding an executable and its runtime dependencies. |

For a repeatable build, add a `racket-build` task to `.vscode/tasks.json`, with `action` (`launcher`, `executable` or `distribution`), `source`, `output`, `gui`, and `libraries` or `languages` for embedded executables. Paths are relative to the task's workspace folder, and task variables and `dependsOn` work as usual. The folder's `racketdap.racketExecutable` setting supplies the build tools. Try [examples/application](https://github.com/lamestllama/racketeer/tree/main/examples/application) from [the repository](https://github.com/lamestllama/racketeer).

**Good to know:** a distribution targets compatible operating systems and architectures, and may need system libraries on the destination. Declare data files with `define-runtime-path` so that they are distributed. A cancelled or failed build can leave partial output, so check that the task completed before using a build.

Details: [Building applications](https://github.com/lamestllama/racketeer/blob/main/docs/application-builds.md).

## Read a program's logs

See what a program logs through Racket's logger, filtered by level and topic, in the Output panel.

| Command | What it does |
| --- | --- |
| **Racket: Show Application Log** | Opens a session's messages. **Logs** in Interactions does the same. With several sessions, choose one by file and session number. |
| **Racket: Set Application Log Filter…** | Changes capture for a running session. |
| **Racket: Clear Application Log** | Clears the retained messages. |

A filter starts with `none`, `fatal`, `error`, `warning`, `info` or `debug`, then optionally adds overrides by topic. For example, this captures warnings and more severe messages generally, all network messages and no storage messages:

```text
warning debug@network none@storage
```

The default is `error`. Set `racketdap.logs.filter` for new sessions, or `logFilter` in a launch configuration to override it.

Try [examples/logging.rkt](https://github.com/lamestllama/racketeer/blob/main/examples/logging.rkt) from [the repository](https://github.com/lamestllama/racketeer) in Interactions: open its log, change the filter to `warning debug@network`, then evaluate `(sample-logs)`.

**Good to know:** a filter affects new messages only. Logs belong to debugger-backed sessions, including Interactions and tests, so a run in the terminal uses Racket's own logging facilities. Stopped sessions keep their logs until the editor reloads, within limits, and omissions are reported.

Details: [Application logs](https://github.com/lamestllama/racketeer/blob/main/docs/workflows.md#application-logs).

## Edit Rhombus

Open a `.rhm` file for Rhombus highlighting, comments, brackets and indentation. For semantic analysis, install the `rhombus` package in the Racket environment selected by `racketdap.racketExecutable`; **Racket: Install Package** can do this, and `rhombus-lib` supplies the language without documentation. Racketeer does not bundle or install the language.

**Good to know:** Rhombus support covers editing and has no debugging: source debugging, the Debug REPL and the Testing view are not established for it. Automatic formatting is off, because the bundled default formatter handles Racket S-expressions.

Details: [Rhombus](https://github.com/lamestllama/racketeer/blob/main/docs/editor-tools.md#rhombus).

## Read and edit WXME documents

Work with files saved in the WXME format of Racket's editor, with their embedded images and boxes, inside VS Code. Choose **Open With** on a saved file:

- **Racketeer WXME Viewer** reads text and embedded bitmap images in source order. It is read-only and does not run the program.
- **Racketeer WXME Editor** edits text around images and inside nested editors, comment boxes, XML boxes and Racket boxes, with Undo, Redo, Save, Save As, Revert and unsaved-document recovery. The toolbar inserts a PNG image, comment box or nested editor at the cursor, and the × button removes an object and its contents.

**Racket: Run Current File** and **Racket: Debug Current File** work from either view. Debugging opens a read-only snapshot of the source text, with a replacement character for each image or box, for breakpoints and stepping.

**Good to know:** editing needs the full Racket installation's GUI libraries and a working display; the viewer does not. Saving can change the file's binary form. Language tools, breakpoints in the custom editor and locations inside embedded boxes are not available. Unsupported box versions, other object classes and linked or missing images cannot be edited. PNG imports are limited to 8 MiB and 4096 pixels in either dimension. If the file changes elsewhere, use Revert to reload it or Save As to keep the edited version.

Details: [Viewer and editor](https://github.com/lamestllama/racketeer/blob/main/docs/wxme-editor.md#viewer-and-editor).

## Limits

- Debugging is tested with `racket/base`, `racket`, Scheme, Typed Racket, teaching languages, custom module languages, plain files and GUI callbacks. Other languages and operating systems need further testing, and [debugger features](https://github.com/lamestllama/racketeer/blob/main/docs/debugger.md) records the tested scope.
- Racket older than 9.1 is refused: Run, Debug, the Testing view, the language server and the workspace index do not start on it.
- The debugger has no stepping in macro-time code, no reverse execution, no tracing of caught exceptions and no attaching to an arbitrary process. Local syntax transformers are not available to console evaluation.
- There is no full terminal for curses or raw-mode programs in a debug session: line input only.
- Sources are edited as text; there is no graphical source editor apart from WXME documents.
- Code that disables breaks defers **Pause** and cancellation. A **Pause** in a blocked primitive marks its location approximate.
- Source files under the workspace folder are instrumented by default. Collection dependencies normally run without instrumentation, unless chosen with **Racket: Choose Packages to Debug**.
- The language tools use one Racket installation per window, chosen by the first workspace folder. Use separate windows for different installations.
- On Windows, which has no status-change time, a library replaced with the same size and date goes unseen by the compiled debugger.

## Licence

Copyright © 2026 Eric Parsonage. Racketeer's original code and documentation are licensed under Apache-2.0 OR MIT, at the licensee's option. The extension includes `LICENSE`, `LICENSE-APACHE`, `LICENSE-MIT` and `COPYRIGHT`. Bundled dependencies keep their own copyright and licence notices: `language-server/` holds the bundled language-server sources, archive hashes and notices, and `out/THIRD_PARTY_NOTICES.txt` the JavaScript dependency notices.
