# Debugger parity target

The initial target is the behaviour of a graphical Racket debugger.
The overall target includes IDE facilities, presented through native
VS Code workflows. This matrix covers the debugger portion; it does not establish
full IDE parity.

| Debugger operation | Extension behaviour | Regression evidence |
| --- | --- | --- |
| Start paused | Debug Current File / `stopOnEntry` | DAP and editor suites |
| Go, Stop | Continue; Stop terminates the worker and descendants | DAP suite |
| Step | Step Into visits expression starts and completions | debugger-parity suite |
| Over, Out | Step Over and Step Out follow expression/activation return targets; bounded tail frames | stepping and conformance suites |
| Pause | Resumable breaks, live lexical variables, approximate source location | blocked primitive and interactive-call regressions |
| Boundary breakpoints | Inline start/end locations; completion Return values scope | debugger-parity suite |
| Continue to a point | One-use target independent of ordinary breakpoints | protocol and editor suites |
| Skip expression | Skip Expression substitutes evaluated zero/one/multiple values | component, protocol, editor suites |
| Change returned values | Change Return Values updates the pending values in the Return values scope | component, protocol, editor suites |
| Print returned values | Print Return Values to Console uses full printing in Debug Console | protocol and editor suites |
| Hover a lexical variable | Read lexical/module values without running macros | component and protocol suites |
| Print or assign a variable | Print Variable Value to Console and Set Variable Value (set!) use the selected live frame | component, protocol, editor suites |
| Stack and lexical variables | Select a frame in Call Stack; inspect Variables → Locals or evaluate in Watch and Debug Console | original DAP and editor suites |
| Unhandled exceptions | Inspect before unwind; Continue preserves the program's error display and escape handlers, including custom recovery | DAP, interactive, GUI suites |
| Multiple source files | Workspace roots, breakpoint files, and modules loaded during macro expansion | module, language, and DAP suites |
| Value inspection | Escaped symbol/keyword names; bounded containers and syntax; procedure arity; port direction and safely known names/state, without invoking custom printers | inspection and DAP suites |
| Image results | Native image editor for Variables and Debug Console results; native picker for multiple images | image protocol and editor suites |
| Non-module programs | Sequential source loading with explicit `language` | language and protocol suites |
| GUI programs | Eventspace lifetime, callback stops, interactive dispatch | GUI suite under Xvfb |

The native VS Code names Continue, Step Into, Step Over, Step Out, Call Stack,
Variables, and Watch remain unchanged. Locals contains the selected frame's
lexical variables. A binding a macro generated is one of them when an identifier
in the file refers to it, anywhere in its scope and also after the stop: `it` from
an anaphoric macro, a name made by `format-id`, `local-pt-x` from a local structure
whose accessor the source reads. It is the binding that identifier refers to, not
another of the same name. Hover, Watch, the Debug Console and assignment reach it as
they reach any variable. Names no source identifier refers to, such as `tmp`,
`or-part` and `for-loop`, stay hidden. The Return values scope includes the number of returned
values, including zero; assignment to a variable uses Racket's `set!` semantics.
Racketeer deliberately retains the completion stop at a function's call site
after it returns, so its return values can be inspected before advancing.

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

This is a tested feature mapping, not a guarantee for every third-party language
or platform. Validation uses Linux ARM64, Racket 9.1 CS, and VS Code 1.98.1. Text
sources are the current editor input. WXME documents, graphical syntax,
and inline rich Interactions rendering remain outstanding IDE capabilities. Static
image previews support choosing among multiple returned values; interactive plots
and embedded editor objects remain outside that slice. Compiler-phase debugging,
tracing every caught exception, reverse execution, and arbitrary-process attach
are not part of the documented graphical-debugger baseline mapped here.

Pause and cancellation respect Racket's break-disable regions. Nonselected
code supplies only the nearest instrumented frame. Local syntax transformers
are not reconstructed for console evaluation. Stop actions are thread-specific;
other threads may keep changing shared data. No full-parity claim beyond these
recorded operations and validation boundaries is implied.
