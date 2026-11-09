<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Debugger features

What the debugger does, and the regression evidence for each behaviour.

| Feature | Behaviour | Regression evidence |
| --- | --- | --- |
| Start paused | Debug Current File and extension launches default to `stopOnEntry: true`; `entryPoint` selects the entry module | DAP and editor suites |
| Attach to a running host | Embedded debug host, token-authenticated loopback connection, host survives disconnect | attach native and protocol suites |
| Continue, Stop | Continue runs to the next stop; Stop terminates the worker and descendants | DAP suite |
| Step Into | Visits expression starts and completions | debugger-parity suite |
| Step Over, Step Out | Follow expression/activation return targets; bounded tail frames | stepping and conformance suites |
| Pause | Resumable breaks, live lexical variables, approximate source location | blocked primitive and interactive-call regressions |
| Boundary breakpoints | Inline start/end locations; completion Return values scope | debugger-parity suite |
| Continue to a point | One-use target independent of ordinary breakpoints | protocol and editor suites |
| Skip expression | Racket: Skip Current Expression substitutes evaluated zero/one/multiple values | component, protocol, editor suites |
| Change returned values | Racket: Change Return Values updates the pending values in the Return values scope | component, protocol, editor suites |
| Print returned values | Racket: Print Return Values uses full printing in Debug Console | protocol and editor suites |
| Hover a lexical variable | Read lexical/module values without running macros | component and protocol suites |
| Print or assign a variable | Racket: Print Variable Value and Racket: Set Variable Value use the selected live frame | component, protocol, editor suites |
| Stack and lexical variables | Select a frame in Call Stack; inspect Variables → Locals or evaluate in Watch and Debug Console | original DAP and editor suites |
| Unhandled exceptions | Inspect before unwind; Continue preserves the program's error display and escape handlers, including custom recovery | DAP, interactive, GUI suites |
| Multiple source files | Workspace roots, breakpoint files, and modules loaded during macro expansion | module, language, and DAP suites |
| Value inspection | Escaped symbol/keyword names; bounded containers and syntax; procedure arity; port direction and safely known names/state, without invoking custom printers | inspection and DAP suites |
| Image results | Native image editor for Variables and Debug Console results; native picker for multiple images | image protocol and editor suites |
| Non-module programs | Sequential source loading with explicit `language` | language and protocol suites |
| GUI programs | Eventspace lifetime, callback stops, interactive dispatch | GUI suite under Xvfb |

The native VS Code names Continue, Step Into, Step Over, Step Out, Call Stack,
Variables, and Watch remain unchanged. Locals contains the selected frame's lexical
variables. A binding a macro generated is one of them when an identifier in the file
refers to it, anywhere in its scope and also after the stop: `it` from an anaphoric
macro, a name made by `format-id`, `local-pt-x` from a local structure whose accessor
the source reads. It is the binding that identifier refers to, not another of the same
name. Hover, Watch, the Debug Console and assignment reach it as they reach any
variable. Names no source identifier refers to stay hidden. For example: `or-part` and
`for-loop`. A macro in the program's own files is the exception: while a stop is in its
template, the template's own variables are listed too. For example: `tmp` in a swap
macro. They do not show in the code passed to the macro, so they hide no name of that
code. In a class's methods and initialisers, and in closures made there, Locals has a
row named `this` for the object, read by hover, Watch and the Debug Console too. It
cannot be assigned, and a parameter the source names `this` is what the row shows. It
opens to the object's fields as the program's inspector allows: numbered, because the
object holds no field names, and shown as `<uninitialized>` until set. A field that a
method's code reads or assigns, public, private or inherited, is also a row of that
method and its closures, with its name in the source: hover, Watch and the Debug Console
read it, and Set Value goes through the field's mutator. A method's own variable of that
name wins, a field that method does not touch stays a numbered row under `this`, and
`get-field` and `set-field!` make no row. An inherited field can be assigned only if its
class assigns it, and an inherited field the class only assigns has no row, since the
expansion names no accessor for it. A row over an object a program has chaperoned shows
it is wrapped rather than run the program's code; the Debug Console runs it when asked.
A request with no count returns every row of a scope, however many, and Variables asks
that way. A container reports its size as `indexedVariables` or `namedVariables`, so a
client pages a long one by `start` and `count`, as the Variables panel does; a list
opens to its `car` and `cdr`, so it reports two named rows. A container's reply to a
request with no count stops at 10,000 rows, with a last row saying how many more there
are. The Return values scope includes the number of returned values, including zero;
assignment to a variable uses Racket's `set!` semantics. Racketeer deliberately retains
the completion stop at a function's call site after it returns, so its return values can
be inspected before advancing.

The language loader retains each language's module-begin processing and annotates
runtime forms. Regression languages include `scheme/base`, `scheme`,
`typed/racket/base`, `typed/racket`, `htdp/asl`, `htdp/bsl`, and a relative custom
language, alongside the original `racket/base` and `racket` fixtures. The custom
language regression compares expansion effects without evaluation requests;
explicit console evaluation can itself visit transformer code, as ordinary
Racket evaluation does.

Selected source modules compile with constant enforcement disabled so debugger
assignments can change their definitions. This uses Racket's documented
[debugging compilation setting](https://docs.racket-lang.org/guide/module-set.html).
Unselected dependencies retain normal loading and assignment protections.

This is a tested feature list, not a guarantee for every third-party language
or platform. Validation uses Racket 9.1 CS on Linux ARM64 and x64 with VS Code 1.91.0 and
1.144.1, and on Windows x64 and macOS ARM64 with VS Code 1.144.1. Text sources are the current editor input. A WXME document is debugged through a read-only
text snapshot. Results and Interactions draw printed images, picts and plots inline, and an error
there links to its source. **Racket: View Image** can choose among multiple returned
values, **Racket: Open Interactive Plot** opens a live plot in a Racket window, and
the WXME editor edits embedded objects. Sources are otherwise edited as text.
Compiler-phase debugging, tracing every caught exception, reverse execution, and
arbitrary-process attach are not provided.

Pause and cancellation respect Racket's break-disable regions. Nonselected
code supplies only the nearest instrumented frame. Local syntax transformers
are not reconstructed for console evaluation. Stop actions are thread-specific;
other threads may keep changing shared data. Nothing beyond these recorded
operations and validation boundaries is claimed.

## Third-party programs

The packaged extension debugged these unmodified programs, pinned at the revisions
shown, through its public debugger UI and protocol, on Racket 9.1 on Linux ARM64. The
source licences stay with the programs; the regression programs are original.

| Program | Revision | Scenario |
| --- | --- | --- |
| [Typed Racket examples](https://github.com/racket/typed-racket/blob/266429b235fbf624882456bfff55a5df761a301d/typed-racket-test/succeed/icfp-examples.rkt) | `266429b235fbf624882456bfff55a5df761a301d` | Break in `f`, inspect `x`, step through the predicate, return to its caller and finish. |
| [Asteroids](https://github.com/ericclack/racket-examples/blob/ee858daac3577ead0c8463b9701a8653220039de/asteroids1.rkt) | `ee858daac3577ead0c8463b9701a8653220039de` | Break in the first timer callback's `move-pos`, inspect position and speed, step over angle conversion, step out and stop. Fetch `util.rkt` from the same revision. |
| [Memory](https://github.com/racket/games/blob/eba5c6fa54c524871badb8b0e205fe37640d6c3e/memory/memory.rkt) | `eba5c6fa54c524871badb8b0e205fe37640d6c3e` | Invoke `game@`, click a card, break in `flip-and-match`, inspect enclosing unit state and step through the first predicate. |

For Asteroids, a separate launcher loads the module and calls its private `go`
procedure through the public `module->namespace` API, with `random-seed` set to 4242.
For Memory, a launcher requires `memory.rkt` and uses `(invoke-unit game@)`. Memory uses
its own clock seed, so its results are state transitions rather than shuffled card
identities.

Memory exposed a missing capture of macro-renamed unit state in Racketeer 0.8.7. The
original regressions in `tests/annotator-conformance.test.js` cover source names,
unused state, shadowing, live mutation, separate instances and an independently written
renaming macro. Memory also exposed repeated breakpoint hits on nested conditionals
expanded from one `cond`. The source expression now owns one stepping boundary across
those nested forms. Separate calls and duplicated expressions retain their own
breakpoint hits.

The fix uses the documented
[`disappeared-binding` property](https://docs.racket-lang.org/reference/stxprops.html)
and [identifier binding equality](https://docs.racket-lang.org/reference/stxcmp.html).
It does not infer source names from generated identifier spellings.

`tests/debug-third-party-program.test.js` also debugs a Tetris program of about a
thousand lines, fetched at a pinned commit and hash.

These are specific debugger scenarios, not complete tests of each application.
Keyboard handlers, every game path, other Racket versions and other operating systems
are not covered by them.

## Launching a program

Extension launches stop on entry by default. Set `stopOnEntry` to false to run to a
breakpoint. The default `entryPoint` mode starts in the selected entry module;
`firstExpression` starts before initialisation. See [Understanding the
stops](stepping.md) for the full sequence.

The root module loads first, then its `main` submodule runs when present. Use
`"submodule": ["test"]` for tests or `"submodule": []` to load only the root. Use
`"entry": "run"` to call an exported zero-argument procedure afterwards. `args`, `cwd`,
`env` and `sourceRoots` are also configurable. `"testMode": true` selects test execution
and reporting; it cannot be combined with `interactive`, `submodule`, `entry` or
`language`. For a plain file without a `#lang` or module declaration, set `"language":
"racket/base"` or another language module. For example: `r5rs`. Leave `language` unset
for module programs. A relative `program` is relative to its `cwd` or the workspace
folder.

By default, the session ends after the entry action and GUI work complete; visible
windows, timers and queued callbacks keep GUI programs alive. With
`"interactive": true`, the module stays loaded until Stop. The Debug Console
evaluates expressions and defines session bindings. Calls into instrumented
functions can hit breakpoints and be stepped through. Console errors return to the
interaction loop. Returned values can be expanded until the next interaction;
paused-frame references expire when that stop resumes.

With `"console": "integratedTerminal"`, program output and line input use a terminal
named **Racket: …**. Enter submits a line, Ctrl+D sends EOF on an empty line and
Ctrl+C interrupts the running interaction or program. Closing the terminal sends
EOF. This provides line input over pipes; it is not a shell or a full TTY for
curses/raw-mode applications. The default `internalConsole` sends output to Debug
Console and gives the program EOF on stdin. Debug Console input always evaluates
Racket expressions.

The debugger keeps a separate target process, captures stdout and stderr, and can
terminate a program even while an evaluation is blocked. Source coordinates handle
Unicode text.

### Launch configuration reference

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
| `submodule` | The submodule to run. For example: `["test"]`. `[]` loads only the root module. By default `main` runs when present. |
| `entry` | An exported zero-argument procedure to call after loading, for example: `"run"`. |
| `language` | The language for a plain file without `#lang` or a module declaration. For example: `"racket/base"` or `"r5rs"`. Leave it unset for module programs. |
| `testMode` | Runs tests and reports them. It cannot be combined with `interactive`, `submodule`, `entry` or `language`. |
| `interactive` | Keeps the module loaded until **Stop**, so the Debug Console can call into it. Calls can hit breakpoints and be stepped through. |
| `console` | `integratedTerminal` for line input and output in a **Racket: …** terminal. The default, `internalConsole`, sends output to the Debug Console and gives the program end of input. |
| `stopOnEntry`, `stopOnEntryMode` | Where a session first stops. |
| `sourceRoots`, `debugPackages` | The directories and installed packages to debug. |
| `logFilter` | The application log filter for this launch. |
| `debugCache` | Whether to keep instrumented compiled code between sessions. |

`racketdap.debug.compiledCache` defaults to `true` for new sessions; see
[compiled code](#compiled-code) for cache lifetime and external-file registration.

## Breakpoints

Click the gutter beside a line number, press **F9** or choose **Add Breakpoint** from
the context menu. Press F9 again to remove it. These controls also work in read-only
captured source tabs. After a saved edit, a new breakpoint in the changed file stays
unverified until restart; a breakpoint in captured source ends with the session.
See [captured source and stepping](stepping.md) for the full source lifecycle.

A macro template under the source roots has stops where it is written, including in
another file. A breakpoint there stops at each use; stepping enters its file and
returns. Right-click a breakpoint to add a condition, hit count or log message.

Breakpoints bind to expressions beginning on the selected line, preferring the
outermost expression. An inline breakpoint selects a later expression on the line,
and on a non-tail expression's final character it stops after that expression
returns. **Racket: Continue to Cursor** runs to one selected boundary once while
retaining ordinary breakpoints. A breakpoint stays pending until its module is
loaded. An empty line, a comment, a `require`, an atomic definition initialiser,
a `struct` form, compile-time code and a line that holds only a
function's header have no place to stop, so a breakpoint there moves to the next line that
has one, which can be in the next function. With none later, or set inline where the line has
none, it remains unverified with an explanation. A breakpoint added to an already loaded,
uninstrumented dependency needs a fresh launch. Standalone constants, variable
references and quoted data do have stops.

- Conditions are Racket expressions in the current lexical environment. For example:
  `(> subtotal 100)`. Only `#f` is false. A condition must return one value.
- Hit counts accept `N`, `=N`, `>=N`, `>N`, `<=N`, `<N` and `%N`, where N is a
  positive integer. `%3` means every third hit. Counts include all encounters
  across program threads, before testing the condition. Editing a breakpoint
  resets its count; re-sending an unchanged breakpoint preserves it.
- Logpoints interpolate expressions: `subtotal={subtotal}, tax={(* subtotal rate)}`.
  `{{` and `}}` give literal braces. Conditions and hit counts also apply to
  logpoints. Logpoints write to Debug Console and continue without stopping.
  For a selected source with native expressions, the source menu and palette
  expose **Racket: Edit Logpoint Segments**, which accepts an array such as
  `["result: ", {"expression": "native text"}]` for a language adapter's native
  syntax. Strings are literal output, including braces; expression records use
  the selected module's interaction reader. The original brace grammar stays
  available in ordinary log messages. Explicit segment metadata is retained
  separately against the edited breakpoint in workspace state.
- A condition or log expression error stops at the breakpoint with a diagnostic.
  These expressions can have real effects, like ordinary console evaluation.

## Uncaught exceptions

**Uncaught Racket exceptions**, enabled by default in the Breakpoints pane, stops at
an uncaught runtime error. Call Stack, lexical variables, Exception scope and
exception details remain available. Continue propagates the same exception: a script
usually ends, while an interactive console call reports the error and leaves the
module loaded. The program's error display and escape handlers retain their original
context; a custom `error-escape-handler` can recover and continue after the stop.
Racket values raised with `raise` need not be exception objects. Exceptions handled
by the program are not intercepted. Source information comes from the available
instrumented context; expansion and load errors without such a context are reported
as diagnostics rather than source-level exception stops.

## Evaluation and values

Evaluation uses the live variables of the selected frame. `set!` and other
evaluation effects are real; selected module definitions remain editable, while
imported bindings retain Racket's assignment protections. Watch also evaluates Racket
code. Hover reads lexical or module variables without expanding user macros. It reads the binding
the name refers to where it is written: a use that a later binding of the name hides shows its
own value, and a caller's variable shows while its callee is stopped. A local of a function
that is not running shows nothing, or the module variable of its name if there is one.

Variable actions use the selected stack frame. Expression actions use the executing
frame. Replacement expressions can return `(values ...)`, including `(values)` for
zero values; changes take effect when execution resumes. Variable assignment uses
`set!` semantics on the live lexical or module variable. Explicit Print actions use
full Racket printing, including custom writers, and can be interrupted with
**Racket: Cancel Evaluation**.

**Racket: Cancel Evaluation** interrupts a blocked console, watch, condition or
logpoint evaluation. The session and paused frames remain usable when cancellation
succeeds. Cancellation is cooperative: code that disables or catches breaks may keep
running; Stop still terminates the worker. Effects that already happened are not
rolled back. When a console call is paused and another evaluation runs inside that
stop, Cancel targets the inner evaluation.

Lists, vectors, hashes and inspector-visible structures show bounded contents in
their previews. Pairs, vectors, boxes, hashes and visible structure fields can be
expanded. Syntax objects show a datum preview and expand to the datum and source
coordinates; procedures expand to show arity. Procedure names appear when they can
be obtained without invoking program callbacks; other procedures can remain
`#<procedure>`.

Automatic inspection does not force promises, call custom writers or invoke wrapped
accessors. Wrapped values retain conservative previews; explicit console evaluation
runs their code. A stopped program's source remains available even if its file is
edited; a fresh session debugs the edited version.

### Value and expression commands

From the editor context menu or the Command Palette:

| Command | When | What it does |
| --- | --- | --- |
| **Racket: Skip Current Expression** | Before an expression | Skips it and asks for the values to return in its place. |
| **Racket: Change Return Values** | After an expression | Replaces its results. `(values)` gives zero values. |
| **Racket: Print Return Values** | After an expression | Prints its results in the Debug Console with full Racket printing. |
| **Racket: Print Variable Value** | At a variable | Prints the variable under the cursor for the selected frame. |
| **Racket: Set Variable Value** | At a variable | Assigns to the variable under the cursor with `set!`. |
| **Racket: Edit Logpoint Segments** | At a source location with native expressions selected | Edits literal text and native expression segments from the source menu or palette, preserving the breakpoint's condition and hit-count condition. |
| **Racket: Cancel Evaluation** | While evaluating | Interrupts a blocked console, watch, condition or logpoint evaluation. |

A long container opens in groups of rows. Structure fields are numbered because
Racket does not record their names at run time. See [structure inspection](stepping.md)
for ordering and inspector boundaries.

## Threads, Pause and what is instrumented

A breakpoint stops only the triggering Racket thread. Other threads continue; shared
values can change. Pause can interrupt a blocked primitive while retaining live
frames; its location is marked approximate in the stop description. If a break
arrives without an instrumented frame, stopping waits for the next source expression.
Code that disables breaks defers interruption. Source files under the workspace
folder are instrumented by default; collection dependencies normally run without
instrumentation. Choose **Racket: Choose Packages to Debug** to add installed package
sources; a launch can override the selection with `debugPackages`. GUI callbacks
continue to dispatch while an interactive session waits for console input.

Caught-exception tracing, transformer-phase stepping, arbitrary-process attach,
reverse execution, full TTY input and a graphical source editor apart from WXME
documents are outside this release. Standard text sources are used in VS Code.

## Compiled code

The debugger is compiled once for each Racket version and VM into the extension's
storage, in the background after the first launch begins. It notes each library it
was compiled against, and runs from source when one changes. Windows has no
status-change time, so a library replaced there with the same size and date goes
unseen by the compiled debugger.

Instrumented code is kept in the extension's storage between debug sessions and reused
while the hashes of each source and of everything it depends on match. Like `raco make`,
a macro's output is reused until a file it depends on changes, so a macro that reads a
file should register it with `register-external-file`. `racketdap.debug.compiledCache`
and the `debugCache` launch attribute turn this off. Instrumentation uses a fresh
namespace and custodian, bypasses selected bytecode caches on a cache miss and does not
overwrite the project's `.zo` files.

The debugger loads package-management and WXME decoding libraries on first use. Ordinary
text programs avoid the WXME and test libraries. Successful executable-version checks
are reused while executable identity and the environment match. Application log capture
waits for messages or its flush deadline without idle polling. Its thread and custodian
close with the session.

Measured launch to first stop about halved: about 470 ms to 220 ms with the compile
cache. Memory use fell by about a third: 169 MB to 115 MB.

## Attach to an embedded Racket program

Attach the debugger to a running Racket program that embeds the debug host. This suits
servers, long-running jobs and programs started outside the editor. Racket's own editor
cannot attach to a running process.

An embedding host can load `racketdap/worker/attach.rkt` and expose a loopback
listener. Connect with a `racketdap` debug configuration whose `request` is `attach`,
with the returned `port` and secret `token`; no `program` is required. `sourceRoots`
and `debugPackages` select source as for a launch, with the host's exclusions taking
precedence even over breakpoints. The extension fills roots from the workspace and
packages from `racketdap.debug.packages`.

For example:

```json
{
  "type": "racketdap",
  "request": "attach",
  "name": "Attach to Racket host",
  "port": 49152,
  "token": "replace-with-the-host-token"
}
```

Code must be loaded through the embedded host's instrumentation hooks. Already loaded,
uninstrumented code does not gain stops retroactively. This is cooperative attachment to
a host using the library. The host owns program input, output and thread lifetime.
Interrupt is refused. Disconnect and Terminate close only the debugger connection and
release held stops; they never kill the host. Host disconnection produces `terminated`,
without `exited`.

See the [host contract](../racketdap/instrumentation/DESIGN.md#embedding-host-contract)
for API and inspector, thread and lock requirements. Keep tokens private.

## How the pieces connect

`racketdap/main.rkt` speaks DAP over stdio. It launches `racketdap/worker/main.rkt` as a
separate Racket process and communicates over an authenticated loopback connection.
Program output has separate pipes. The VS Code extension registers the debugger and
launches this adapter. Racketeer also provides a language server and a workspace
indexing server, both over LSP. The language server starts through
`vscode/language-server.rkt`; the index server starts on the first references or rename
request through `vscode/workspace-index-server.rkt`. Each uses private collection paths
in its own process. Language analysis may run expansion-time code, so VS Code workspace
trust applies to the entire extension.

The headless `run-module` API remains available from `worker/load.rkt`. Its single
`#:on-event` callback receives live stops; `stop-kind` selects `before` or `after`
events. The component API is imported directly from
`racketdap/instrumentation/instrument.rkt`. `racket experiments/headless-demo.rkt`
gives an editor-free demonstration. The expression instrumenter and frame/binding
runtime are under `racketdap/instrumentation/`, packaged as
`runtime/racketdap/instrumentation/`; their
[component design](../racketdap/instrumentation/DESIGN.md) describes the shared API.
