# Debugger parity target

The initial target is the behavior of a graphical Racket debugger.
The overall target includes IDE facilities, presented through native
VS Code workflows. This matrix covers the debugger portion; it does not establish
full IDE parity.

| Debugger operation | Extension behavior | Regression evidence |
| --- | --- | --- |
| Start paused | Debug Current File / `stopOnEntry` | DAP and editor suites |
| Go, Stop | Continue; terminate the worker and descendants | DAP suite |
| Step | Before and after expression events | debugger-parity suite |
| Over, Out | Expression/activation return targets; bounded tail frames | stepping and conformance suites |
| Pause | Resumable breaks, live locals, approximate source location | blocked primitive and interactive-call regressions |
| Boundary breakpoints | Inline start/end locations; completion Results | debugger-parity suite |
| Continue to a point | One-use target independent of ordinary breakpoints | protocol and editor suites |
| Skip expression | Substitute evaluated zero/one/multiple values | component, protocol, editor suites |
| Change returned values | Pending replacement visible in Results | component, protocol, editor suites |
| Print returned values | Explicit full printing to Debug Console | protocol and editor suites |
| Hover a binding | Read lexical/module values without running macros | component and protocol suites |
| Print or assign a binding | Cursor commands use selected live frame | component, protocol, editor suites |
| Stack and locals | Select frame; inspect or evaluate in its environment | original DAP and editor suites |
| Unhandled exceptions | Inspect before unwind; continue propagates exception | DAP, interactive, GUI suites |
| Multiple source files | Workspace roots, breakpoint files, and modules loaded during macro expansion | module, language, and DAP suites |
| Structure values | Paged fields in Variables and Watch without invoking custom printers | inspection and DAP suites |
| Image results | Native image editor for Variables and Debug Console results; native picker for multiple images | image protocol and editor suites |
| Non-module programs | Sequential source loading with explicit `language` | language and protocol suites |
| GUI programs | Eventspace lifetime, callback stops, interactive dispatch | GUI suite under Xvfb |

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
