<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Changelog

## 0.8.55

- Vastly improved workspace indexing: indexing a 53-file project fell from 97.9 s to 8.9 s with one worker and from 37.0 s to 5.3 s with three. Results were identical.
- Debugger launch to first stop about halved: about 470 ms to 220 ms with its compile cache. Memory use fell by about a third: 169 MB to 115 MB.
- On Linux and macOS each language server and index server is supervised from the extension instead of by two Racket wrapper processes: supervision falls from about 179 MB to about 2 MB per server, and a server and everything it starts still end together. Windows keeps one wrapper per server.
- Macro steps open in two linked editor panes beside the source, Before above After. Each shows the whole program, with the rewritten forms highlighted. The tabs can move between editor groups. Closing either closes the pair. **Racket: Step Through Macros on This Line** (**Alt+Shift+M**) starts at the line or selection. **Racket: Step Through Macros in This File** starts at the first step. A module line expands with its language, imports and macros. Unsaved buffers are used without saving. The old separate-window commands and **Alt+Shift+Enter** are removed.
- The macro panes use the editor's font, syntax colours, bracket colours, selection and copying. Each program starts line numbering at 1. Reader brackets and eligible quote shorthand are preserved. Scope groups distinguish macro-introduced syntax with 17 colours, then numbered suffixes. Numbers follow display order and remain stable while stepping. The panes retain their text position and avoid flicker. Source highlights follow the current step without taking keyboard focus; source locations use lines and columns.
- Navigate with First, Previous, Next and Finish Macro Steps, or jump to a position number or `end`. The Before title counts positions, including completion; After names the transformation or says Finished or Error. **F10** and **Alt+Right** advance, and **Alt+Left** goes back. F10 remains Step Over during debugging.
- Inspect a selected macro term's bindings, implicit bindings, source, scopes, built-in properties and additional properties with **Show Details**. The inspector resizes and moves below the program in a narrow pane. More/fewer phase links control scope inspection. Errors retain failing syntax and transformer contexts where available.
- Macro binding arrows connect a binder to its visible uses within a section. Definite connections are green; possible ones are yellow and marked `?`. Binders are underlined. Hover boxes both endpoints and explains the binding beneath the program. **Go to Binder** (**F12**) and **Show Uses** (**Shift+F12**) follow visible connections. **Keep Arrows**, **Release Kept Arrows** and **Clear Kept Arrows** control retained connections. **Copy** handles partial and multiple text selections, or the selected term. **Escape** clears syntax selection. A suffix redraw preserves partial and spanning text selections.
- **Macro Hiding...**, also on **Ctrl+K H** (**Cmd+K H** on macOS), offers Standard, Disable and Custom. Custom has switches for enabling hiding, Racket syntax, library syntax, contract-generated names and phases above zero. **Hide This Macro** and **Show This Macro** add binding-specific rules; the newest match wins. **Macro Hiding Rules...** removes selected rules. Renamed imports of a binding match; unrelated names with the same spelling do not. Ordinary Custom pairs share their in-memory policy. Hiding reuses the captured derivation without running transformers again.
- **Include Renaming Steps** adds named scope and identifier-resolution transitions. **Always Suffix Marked Identifiers** adds scope numbers to all nonzero groups. **Highlight Redex/Contractum** controls change backgrounds; **Draw Binding Arrows** controls arrows and clears kept arrows when turned off. Their defaults omit renaming steps and always-on suffixes, with highlighting and arrows enabled.
- **One Term at a Time** splits each transformation into Before and After positions. **Factor Out Common Context** shows changed fragments with shared outer syntax under `In context:` and `[ HOLE ]` at the insertion site. Both default to off. Layout toggles save defaults for future pairs and preserve each existing pair's choice. Selection follows syntax identity through layout and position changes.
- **Taint Icons** marks armed, disarmed and tainted syntax with lock, unlock and zap Codicons. Unicode and Do not show are alternatives. Marks do not enter selections or copied text.
- **Reset Mark Numbering** starts the active pair's scope numbers afresh while preserving position, grouping, suffix choice, selection, arrows and scroll position. **Foreground Colors** chooses grouping by macro scopes or all scopes and resets numbering.
- **Duplicate Stepper** and **Duplicate Stepper (Current Term Only)** open independent pairs on the same recording without running transformers again. Each pair holds one term. Copies start at position 1 with saved defaults, fresh numbering, checked Custom switches, empty Custom rules, and no selection or kept arrows. **Remove Selected Term** empties a pair without closing it. Refresh replaces only its addressed pair's recording.
- A macro expansion reaching 40,000 applications asks whether to Continue or Stop. Continue doubles the next threshold; dismissal means Continue. Stop keeps the completed history and reports an expansion error. Rebuilding an evicted worker replays the recorded decisions, including Stop. Each recording has a 1000 MiB memory ceiling; each answer has a 64 MiB text ceiling. The progress notification cancels expansion and releases its process tree.
- Macro positions and term details load on demand with bounded caches. Two unshared sessions can remain resident; a pair hidden for 60 seconds releases its worker. Later navigation or inspection can rebuild the captured source and rerun transformers. Duplicated recordings stay resident until their last retained term is released. Edits mark recordings stale; **Refresh Macro Steps** captures current source. **Open Saved Macro Source** opens an untitled source's saved file.
- Internal macro-stepper failures offer a details link. **Copy Details** copies the error message; **Show Error** opens its report in the Macro stepper output channel. **Dump Debugging File** saves readable diagnostic events and stack context when available. Cancelling the chooser writes nothing.
- Index workers are reused through discovery and one pass, with fresh namespaces and custodians per file. Each worker reuses compiled project dependencies within that pass. Original read observations and fingerprints remain attached to cached code. Modules with registered external reads compile again, so reused code cannot hide a changed read. Workers end with the pass or sooner on cancellation, timeout, failure or an unreadable reply.
- Workspace indexing collects binding contributions without constructing hover, documentation, completion, diagnostics, Typed Racket, semantic-token, inlay-hint or tail-position results. Index workers avoid documentation-index, database, HTTP and TLS libraries. Language-server documentation helpers load on first use. Indexing also skips expansion-log interception. Full language-server analysis retains its services. Allocation failures still reach the worker controller and make the index partial.
- The default index worker count also respects available memory on Linux, including container limits. A worker at 288 MiB is replaced between files, preserving its completed result. Linux measures resident memory; other systems use managed memory. The 2 GiB per-analysis allocation allowance remains. Explicit worker counts override the default.
- The debugger loads package-management and WXME decoding libraries on first use. Successful Racket version checks are reused while the executable's identity and environment match. Failed checks are not retained. Application log capture waits for events and flush deadlines without idle polling, and closes its thread and custodian with the session. Disconnecting an attached debugger also releases its logging resources. Inspecting ordinary numbers avoids plot-library loading.
- A workspace index connection that stops answering is disposed of with its process. References fall back to the language server; rename reports the stall. The request's timers and cancellation listeners are released.
- Captured debugger source checks detect file replacement even when size and modification date stay the same. POSIX checks include file identity and change time; recent changes and Windows use text comparisons. Debug image previews use the same PNG validation as Interactions. Protocol header reads are bounded while bytes arrive, including headers without a newline. Macro-source watchers ignore unrelated files and read fingerprints asynchronously. Panels and workers release resources with their owners.
- A launch stops at its start unless its configuration says otherwise, as **Debug Current File** does. A configuration without `stopOnEntry` used to run through. A session with no executable entry stop now explains that the file ran to the end and suggests debugging a file that uses its definitions. The adapter's own default is unchanged.
- A macro template under the source roots has stops where it is written, including in another file. A breakpoint stops at each use, and stepping enters the macro's file and returns. Locals lists template variables while stopped there: `tmp` in a swap macro. They stay hidden in code passed to the macro.
- The documentation covers VSCodium installation through Open VSX, attachment to embedded running hosts, and the language server and workspace indexing server over LSP alongside the debug adapter over DAP. First-party text files carry copyright and licence notices. Macro-stepper host, page and worker modules are split by responsibility, and packaging tests load the shipped modules and bundled editor resources. The package excludes loose bundled host modules and vendored test suites.

## 0.8.54

- Hovering over a variable shows the binding that name refers to where it is written. A use that a later binding of the name hides shows its own value, a caller's variable shows while the function it called is stopped, and a local of a function that is not running shows nothing, or the module variable of its name if there is one.
- A rename while a file is being saved runs a fresh pass. It could be refused with "Resolve its errors" when the file had none.
- The debugger tells the editor about a breakpoint only when its answer changes.

## 0.8.53

- A breakpoint on a line with no place to stop, such as an empty line or a comment, moves to the next line that has one. It used to stay unverified.
- Programs that use the `#%foreign-inline` form added in Racket 9.2 can be debugged. The debugger refused them with "unsupported expanded runtime form".
- A read-only captured source tab has basic colouring only. It no longer offers hover, Go to Definition or Find References, which worked only in the rare case that its text matched the file.
- The bundled language server moves to the upstream commit that holds the fixes it carried as patches.

## 0.8.52

- Debugging a file no longer opens a second, read-only copy of it in a new tab on every run. A stop shows the file itself, with its own breakpoints. A read-only captured copy appears only when a saved edit has left the running text behind, or for a WXME document.
- Pressing F9 on a breakpoint removes it, however the file was named: a breakpoint no longer moves to the name the debugger loaded the file under, which added another one on the same line.
- A breakpoint set in a captured copy ends with its session. Any left over from an earlier version can be removed from the Breakpoints view.
- A breakpoint set in the file after a saved edit stays unverified and says to restart. It used to take its line number from the new text and apply it to the old, so the program could stop on another expression. One already placed stays where it was.

## 0.8.51

- When Magic Racket's language server is what keeps Racketeer's language tools off, Racketeer offers to turn off only that server and reload the window. Magic Racket stays installed. The notice waits in the notification list until it is answered or dismissed, and is not shown again after that. A workspace's own value of the setting is changed there, so that it does not override the choice.
- Three tests read a process number from a file as soon as the file existed, and could read it empty. Each now waits for the number, which removes an intermittent failure. A fourth counted build folders before the builder had cleared an abandoned one, and now waits for that too.
- Linux CI runs on every push, and macOS and Windows on demand.

## 0.8.50

- Debugging starts more than twice as fast: a small program goes from launch to exit in about 0.9 s instead of about 2.5 s. An extension package cannot hold compiled files, so Racket compiled the debugger in memory on every launch. It is now compiled once for each Racket version and VM into the extension's storage, in the background after the first launch begins, and that first launch runs as before. A program and the processes it starts see the same compiled-file settings, environment and command line as without this. If the compiled folder is damaged, out of date, older than a library the debugger uses, or cannot be written, the debugger runs from source and, where it can, compiles again.
- The compiled debugger notes the size, date and status-change time of each library it was compiled against: source, compiled file and metadata, or that one is absent. A library that changes, even replaced under the same size and date, sends the debugger back to source and to compiling again, and a build that sees one change while it runs is not kept. This costs about 5 ms in each process the debugger starts. Windows has no status-change time, so a library replaced there with the same size and date goes unseen.
- Test discovery, the package list, WXME files, the macro stepper and the supervisors of the language server and workspace index start from the same compiled debugger files, which saves up to about 0.15 s each time. Opening a window compiles them, so the first debug session usually finds them ready.
- The workspace index analyses up to three files at once, one worker per file, on half the processors. The first Find All References on a 52-file project takes about 26 s instead of about 62 s, one after editing a file others load about 10 s instead of about 23 s, and a rename with nothing analysed about 69 s instead of about 108 s. The answers, progress counts, failures, their reasons and the limits on a pass are the same to the byte as one worker's, whichever worker ends first. Each extra worker adds about 260 MB while a pass runs, more with heavy libraries, so the index's peak goes from about 640 MB to about 1.15 GB on that project, or about 910 MB on a 4-core machine, which runs two. Each worker keeps its own 2 GiB limit. Validating a rename still takes one worker, and as long as before. Compile-time code in different files can now run at the same moment.
- The workspace index runs only when Find All References or Rename asks for it. A workspace where nobody asks does no index work: its process does not start, and an edit or a file event only marks the index out of date. The first request after a change waits for a pass, and the status bar counts its files. Cancelling that request stops the pass, and what it finished is kept for the next one. Requests that refuse a partial index still do. An open or close starts nothing, and a change while a pass runs replaces the pass, the new one starting 2 seconds after the change so that a run of edits does not start and stop a worker each time. A file event outside the source suffixes is held and sent before the next request, so a program writing logs cannot hold up a request that is waiting, while a file an analysis registered is still noticed whatever its name, and moving in or deleting a folder with a dot in its name, such as `my.project`, still marks the index out of date.
- A references or rename request stops waiting once sources have kept changing for `timeoutSeconds` with no more files analysed, and says so, rather than wait for as long as a generator or a build goes on rewriting them. It answers from no older view of the sources. A burst of changes that ends sooner is waited out, and so is a long pass that a change replaces now and then, as each one carries on from what the last finished. A document closing does not count as a change.
- A pass keeps a file's result unless its text or something it read has changed, so a request after a one-file edit analyses that file and the files that depend on it instead of every file. An open buffer counts as its file's text. A macro changing in another file, through any depth of dependencies, a file registered with the compiler such as one read by `include`, a file added that shadows another, and a collection link changing all count as changes, and the answers are the same as a fresh pass's. A file that failed is tried again by every pass. Nothing is written to disk. A macro that reads a file it does not register sees that file only at the next change to a file loaded with it, after Refresh Workspace References, or after a restart.
- Rename works across directories and in more projects. A file importing through a parent directory, such as `"../definition.rkt"`, stopped rename with "Cannot analyse", and quoted data such as `'(module module*)`, a parameter called `module`, or a selector over `'#%kernel` or a quoted submodule ended it with an internal error. A core form imported under another name is now read as that form, so a rename no longer edits a symbol quoted with it.
- A file or rename that needs a lot of memory no longer fails with `analysis worker exited`. Each analysis worker could use only 256 MB including its own libraries, which an ordinary rename on macOS came within a few megabytes of. It may now add 2 GiB to its libraries, and a worker that goes over a limit says so and names the file, in the rename that failed and in the Racket Language Server output, while the index carries on with the other files.
- The workspace index analyses each file in a process of its own. Compile-time code that blocks in a C call no longer holds up the index until the call returns, code that ends its process loses only its file, and the reason is reported. The index server keeps about 260 MB rather than up to 600 MB between passes.
- The workspace index is a standalone server that speaks standard LSP: its lifecycle and position encoding, `textDocument/references`, `prepareRename` and `rename`, work-done progress for a pass and a versioned workspace edit for a rename. Private messages stay only where no standard request says the same, under `racketeer/`, such as references for a captured source. A rename is refused and asks to be run again if its documents, the disk, the settings or the folders changed while it ran, or if a buffer it edits closed in that time.
- Commands act on the editor showing the active tab in the active group. While the window had no focus, they could use another group's editor or cursor.
- The formatter that indents by the rules of the file's own language is the value `language` of `racket-langserver.formatting.documentFormatter` and `indentationFormatter`. A value the settings no longer offer gives the default, `fixw`.
- Continuous integration uses Node.js 22 and current GitHub actions.
- Keep instrumented compiled code between debug sessions, so a program that has not changed starts without being expanded and compiled again. The code lives in the extension's storage, never beside sources. A hash of each source and of everything it depends on, including macros in other files and files registered with the compiler, decides what is reused, and the Racket version, the library paths, what each collection link says and the debugger's own files form part of the key. Stepping, variables, assignment, exception stops and captured source behave as they do without it. `racketdap.debug.compiledCache` and the `debugCache` launch attribute turn it off. Test runs, coverage, plain-file languages and attached hosts run as before.
- Instrumented code no longer quotes debugger objects. It reads its sites and callback from a table when it starts, which is what lets it be saved, and which leaves syntax literals unread until a stop inspects them.
- Programs run far faster under the debugger when nothing needs to stop them, though still slower than without it: `fib(30)` takes about 0.1 s instead of 48 s, against 4 ms without the debugger. A place the debugger could stop costs two reads and a store until a breakpoint is set there or a step or Pause is pending, whatever the depth of the stack, instead of a call into the debugger at every expression. Breakpoints, conditional and hit-count breakpoints, Run to Cursor, stepping, Pause, exception stops with their frames and variables, thread reporting and coverage behave as before; a breakpoint costs only at the places it is set. Stepping over a long computation still visits every expression in it, at half the former cost. Two things can differ from a record per expression, and only in where a frame says it is: a frame re-entered through a continuation shows a later line until its next expression runs, and an exception object kept after its frames have moved on shows where they are now. Variables, Evaluate and Set Value use the cells of the continuation that stopped.
- Making a closure no longer registers it in a table for the debugger, which cost about 150 ns per closure and grew the weak table the collector walks. A procedure's name is now read when a value is inspected, and procedures from code the debugger did not instrument show their names too.
- Long function bodies load in close to linear time. Expanding the instrumented code again nested one scope per internal definition, which made loading quadratic in the length of a body: one function of 700 definitions took 54 s to compile and now loads in about 1.4 s. The definitions still allocate their variables exactly as they do without the debugger, including when an initialiser returns more than once through a continuation, and every 16 definitions the rest of the body now moves into a procedure outside those scopes. The variables shown at a stop are the same, and definitions run in the same order.
- Instrumented code is written in core forms and has no macros left to expand, and nested calls no longer double the code at each level of nesting, which grew exponentially with depth.
- Debug programs with long function bodies without waiting minutes for them to load. Each scope now builds its list of visible variables once and every expression in it shares that list, as does the list of module bindings in each definition, so the instrumented program grows in proportion to its source instead of with the square of a body's length. A 350-line program of two long functions that took nearly two minutes and over 4 GB now loads in under a second and about 240 MB. Stops show the same variables, values and shadowing, and Set Value assigns them as before.
- When the debug worker ends before the program finishes, while loading or running, the Debug Console names its exit code or signal and the session ends. A worker killed by signal 9 is reported as the way the system ends a process that runs out of memory.
- A breakpoint on a line whose code comes from a macro in another file that drops the line's source location, such as `(define dir (make-temporary-directory))` or `(log-warning "writing ~a" dir)`, is verified on that line and stops there, at module level, in function bodies and in submodules. The site takes the location of the macro's name; lines whose code keeps its location are unchanged.
- Frames no longer carry a copy of their expression's syntax: the site each frame already holds supplies the source, position and span that stack traces and failure locations show. Debugging long function bodies uses less memory: a 1,400-line program of two long functions peaks at about 310 MB.
- Bundle the later commits of the language server pull requests for UTF-16 positions and unsaved imports: columns are counted in UTF-16 after tabs and in CRLF documents, and the server no longer hangs after an analysis is cancelled, times out or is superseded. A column past the end of a line still means the end of that line, in a local patch, so an edit cannot delete the start of the next line.
- The language server waits 250 ms after the last edit of a document before analysing it, and the open documents that load it wait too, so typing no longer starts a whole-file Check Syntax at every keystroke. Typing 5 keys per second for 30 s into a 232-line module used 29.3 s of CPU without the wait and uses 3.5 s with it, on Linux ARM64. An edit still stops a running analysis at once. A request a person makes, such as hover, definition, references or code actions, starts it at once for the current text. Semantic tokens and inlay hints, which the editor sends by itself during typing, wait with it and answer from the current text when it finishes. Diagnostics stay as they were until the new analysis publishes, so they appear 250 ms later than before when nothing asks first. Done in a local patch.
- The wait after an edit is a setting, `racket-langserver.analysisWaitMilliseconds`, an integer from 0 to 10000 with a default of 250. A change applies from the next edit, with no restart. 0 starts each analysis at once, as the unpatched server does, and any other value uses the default. Hover and the other requests a person makes end the wait whatever its length.
- The workspace index writes one message at a time. A large references or rename result written while the editor was slow to read could be mixed with a status report, which the editor cannot read.
- A breakpoint stops when its path names the file differently from the program, through a symbolic link or, where the file system ignores case, in another case. It was silently missed. A request replaces the breakpoints of its own spelling only, and a file required under two names keeps a breakpoint on the name it was set on.
- Step In enters a dependency when the program, the working directory and the source roots reach the project through different spellings of a path, and the dependency loads as a source. It used to step past the call without saying why. A file belongs to a source root if the root is one of its folders, whichever path names that folder.
- A relative `program` in a launch configuration is relative to its `cwd`, or without one to the workspace folder. The debugger looked for it in the folder the adapter started in, and the extension refused it unless it happened to exist there.
- A breakpoint added in a captured source tab no longer replaces the breakpoints set in the file's own tab, which stayed displayed but stopped nothing, and clearing one tab's breakpoints leaves the other's.
- A variable a macro binds is listed in **Variables**, and reached by hover, **Watch**, the Debug Console and Set Value, when the source refers to it: `it` from an anaphoric macro, a name made by `format-id`, `local-pt-x` from a local structure. The console called these undefined and hover refused them. A macro's own temporaries stay hidden, and the row is always the binding the source refers to, never another of the same name.
- Inside a class, **Variables** has a row named `this` in methods and initialisers, and hover, **Watch** and the Debug Console read `this`. The row opens to the object's fields, numbered, with a field not yet set shown as `<uninitialized>`. An object whose class guards its unset fields no longer shows as a wrapped value that cannot be opened.
- A class field the method's code reads or assigns is a row under its name, public, private or inherited, with its real value. Hover, **Watch** and the Debug Console read it and Set Value writes it through the field's mutator. A field the method does not touch stays a numbered row under `this`. An inherited field can be set only if the class assigns it. A row over an object the program has chaperoned says it is wrapped instead of running the program's code.
- Rows past the first 100 no longer vanish. **Variables** asks for a scope with no count and got 100 rows, so in a frame with more names the arguments and the oldest names were missing, and a vector of 150 opened to 100 rows. A scope now returns every row. Vectors, hashes and structures report their sizes, so VS Code opens a long one in groups and asks for each as it is opened, at any start; a vector of a million opens at once. A client that ignores the sizes gets 10,000 rows of a container and a last row saying how many more there are.
- A function expression has no stops of its own when a body returns it, as in `(define (make) (lambda (x) x))`, or when a definition in a plain file holds it. Both had a before and an after stop on the function expression, so a `language` launch stopped twice on `(define (f x) x)` where a module does not. A function expression standing alone in a module body or plain file keeps its stops.
- Code a macro generates no longer has stops at the location of source text it did not evaluate to. A `for` clause such as `(list 1 2)` stopped four more times on each iteration, showing `#t`, `1` and `(2)` as if `(list 1 2)` had returned them, and a breakpoint on it fired 12 times for two elements; it now stops once, with `(1 2)`. An iteration of a `for` loop stops at its body's expressions, and `for/list`, `match` and a keyword function's body no longer stop on their whole form each time round. A macro argument used twice stops at each use, and the stops at a macro's name and template remain. An operation generated around a constant or a variable keeps its stops at that text but shows no value there, so `lst` in `(for ([i lst]) ...)` no longer shows the parts of a sequence as if `lst` had returned them: Call Stack says **Returned, value not shown**. Test coverage follows the same rule: a range holding code written there counts as covered only if that code ran, not because generated code located at it did.
- Step Out with no function to leave, as at module level, finishes the evaluation around the stop. It acted as Step and could enter a function: from `(g 3)` in `(f 1 v (g 3))` it went into `g`, and now stops when `(f 1 v (g 3))` has returned. At a whole module-level expression it stops when that expression has returned. Step Out inside a function still leaves the function. With no caller and nothing around the stop, as at a tail expression in a thread's function or a callback, it goes to the next source boundary as before, which can be inside a function.
- A Racket older than 9.1 is named plainly wherever it is found: `Racket 9.0 at /usr/local/bin/racket is too old: Racketeer needs Racket 9.1 or newer. Set racketdap.racketExecutable to a newer Racket.` Run and Debug said only that 9.1 was required. A Test Explorer result said `Racket launch was cancelled or failed`. The language server and the workspace index started on it without saying anything about the version; they now do not start. A version check that does not answer is stopped, and a check that fails says so.

## 0.8.48

- Combine the continuous integration corrections, the re-vendored language server and debugger attachment.
- Bundle racket-langserver at upstream b7c4642, whose background analysis ends every waiting request when analysis fails, times out or is superseded. A request whose analysis failed or passed its 30-second deadline now fails with RequestFailed, as upstream answers, instead of returning an empty result. Bundle the upstream pull requests for UTF-16 positions, unsaved imports and relative imports without a directory as submitted, and keep tail-position and predicted-binding hover as local patches.
- Untitled documents follow upstream: definition no longer leads from an untitled document into the files it imports, references and rename stay within the document, the workspace index covers saved files only, and a workspace folder is no longer an import base. A relative import in an untitled document without a save location reports that one is required instead of resolving against the language server's working directory.
- Use vscode-languageclient 11.0.0 and vscode-jsonrpc 10.0.0, which contain the startup and request-write corrections formerly patched locally. VS Code 1.91 or newer is required. Language server output is a log channel with timestamps and levels, as the new client requires.
- Workspace references keep their analysis while unchanged documents open and close. A pass in progress, or a partial index, continues under the new document set, and a complete index is still verified against the disk, so Find All References no longer waits for a pause in editor activity.
- Image results keep one editor group, release their snapshot when the last tab closes and save from the active tab in VS Code 1.144 and later, whose built-in image editor tabs expose no input to extensions.
- A build runs in a process tree Racketeer owns, as the debugger's workers do, so terminating its task also ends processes it started on macOS and Windows.
- The language server and the workspace index also run in owned process trees, so they and the processes their analysis starts end with the extension host, even when it exits without warning. The index server exits once its input closes instead of waiting for a stalled worker.
- Attach to cooperative Racket hosts through a token authenticated loopback listener.
- Reuse source selection, breakpoints and inspection without owning or killing the host.
- Resolve attach configurations without a program; input and interrupt stay with the host.
- Keep the source editor active after Run File or Start Debug REPL opens Interactions beside it, so a further command on the same file finds its editor.
- Record coverage visits without constructing debugger stops: coverage reports are unchanged and no longer slow down with the depth of the stack.
- Treat build outputs that differ from their input only in case as the same file on Windows and macOS, so a build cannot replace its source there.

## 0.8.47

- Combine the thread pausing and suspension work with the editor, debugger view and test tooling releases.
- Suspend paused threads without delivering application breaks, so programs that catch breaks keep their behaviour. Inspect a suspended thread's live source frames with its captured parameterisation, and keep evaluation cancellation scoped to the selected program thread.
- Pause requests a source stop in every registered application thread and focuses the first executing expression. Blocked calls remain suspended, and resuming cancels a pending pause.
- Step from a GUI or other callback to the next source boundary when no return target is observable.
- Label debugger results as Return values with a count, clarify lexical variables and `set!`, and align expression and printing commands while retaining native VS Code controls and call-site completion stops.
- Stop at standalone module and plain-file expressions such as literals and variable references, while keeping atomic operands out of the stepping sequence.
- Preserve custom error display and escape handlers after an exception stop so program recovery can continue in its original context.
- Show bounded list, vector, hash, structure and syntax previews, expandable syntax source details, and procedure arity without invoking custom printers or wrapped accessors.
- Escape symbol and keyword names consistently, and show port direction plus safely known names and state without performing port I/O or invoking user callbacks.
- Start debugging at the first expression in main, preserving explicit breakpoints during module initialisation.
- Offer `stopOnEntryMode: "firstExpression"` to pause before initialisation, with a launch configuration snippet for that mode.
- Step into function initialisers without stopping on generated binding containers that make Step Over skip the remaining body.
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

- Honour quiet RackUnit output and send failing suite summaries to stderr while retaining Test Explorer results.
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
- Recover from stalled language-server initialisation and retain ownership of
  pending debug launches during disposal. Allow a configurable startup deadline
  for cold language-server compilation.
- Preserve open language-server buffers when delayed file-creation notifications arrive.
- Allow selection evaluation inside a paused Debug REPL call and enforce
  captured-source session ownership for Continue to Cursor.
- Lock the packager dependency, consolidate headless checks, and verify fresh
  editor runs against an exact artefact and its source manifest.

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
