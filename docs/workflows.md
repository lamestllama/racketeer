# Run, Debug, Test, and REPL execution

The extension uses VS Code's task, testing, terminal, and debug APIs. File
actions share a target resolver: saved program URI, owning workspace, working
directory, and Racket executable. The File Actions picker retains its selected
target while the picker is open.

Run, Debug, Debug REPL, and both test profiles share the existing adapter and
worker. File and test Run set DAP `noDebug`; the loader disables instrumentation
and exception stops. Debug uses the same module selection with instrumentation
enabled. Run in Terminal uses a process task. Plain REPL terminals retain
Racket's ordinary `racket/enter` behaviour.

Run Current File and Debug Current File save the source and execute its root
module and optional `main` submodule. A Results view retains text, images and
available error locations after exit. It has no expression prompt. Debug keeps
VS Code's native toolbar, Call Stack, Variables and source stepping. Existing
launch configurations retain their configured console behaviour.

Results uses the same output capture as Interactions. Image conversion shares
the public `file/convertible` property with the program even when instrumentation
is disabled. A custom output port captures Racket printing; program input uses
lines and EOF. Run in Terminal remains available for native streams and terminal
applications. Run's error locations may be absent or approximate; Debug also
has exact instrumented expression locations.

Module launches apply the language's documented
[runtime configuration](https://docs.racket-lang.org/reference/running-sa.html)
before executing the program: `configure-runtime`, then legacy language metadata
when provided. Debug REPL evaluations retain these parameters. Only the launched
module is configured; required libraries keep normal `require` behaviour. An
explicit submodule uses its own configuration. Plain files retain their chosen
top-level language, and test profiles follow the `raco test` rule below.

## Test discovery and reporting

Test Explorer discovers files through configurable workspace-relative globs.
Expanding a file or opening it in the editor reads its current buffer using the
standard datum reader, with custom readers disabled. This performs no expansion
or execution. Direct literal-named RackUnit `test-case` forms in `racket` and
`racket/base` modules become child items with source ranges. Discovery accepts
module setup definitions/imports, direct cases and `run-tests` calls, including
`begin` and merged `module+ test` bodies. Suites can be inline, held in variables,
imported or computed. Custom readers, mixed checks and cases, and unfamiliar
body forms keep whole-file execution.

Selected cases share one normal file execution, preserving module setup. Their
source positions distinguish duplicate names; a source hash rejects stale
selections before user code runs. A small syntax wrapper validates the RackUnit
binding at the original call site and delegates selected cases unchanged to
RackUnit. Explicit runner calls use the public `fold-test-results` and
`run-test-case` APIs to supply nested Test Explorer results. RackUnit retains
suite construction, fixture order and check semantics. Its public formatter
supplies failure details; Test Explorer supplies the runner summary.
Quiet runner calls suppress textual diagnostics while retaining Test Explorer
failures. Runner summaries use stderr on failure and stdout on success. Both
normal and verbose calls currently use the public default check formatter's
normal detail. Use the package-policy profile for RackUnit's native verbose
reporting.

Nested and generated cases appear after an explicit run, with suite paths and
separate results. They support Run, Debug and Coverage. Their identities combine
sibling ordinals and names; selection rejects a changed source file or a missing
runtime path. Selecting a case still traverses the suite and runs its construction
and fixtures, but skips other case bodies. Generated tests should have stable
names and ordering for individual reruns. Run the suite to refresh changed
dynamic inventories. Automatic discovery never constructs or executes tests.

Full file runs report individual results where discovery is supported.
At execution time the loader asks
Racket whether the `test` submodule exists, then loads that submodule or the
root module. It never starts `main` as a fallback or instantiates the parent of
an independent test submodule unnecessarily.

Each file runs in a separate worker and fresh namespace. The test helper is
loaded in that namespace so its RackUnit parameters and `raco/testing` counters
are the same instances the program uses. Public `current-check-around` and
`current-test-case-around` hooks observe failures and delegate execution and
logging to the original handlers. `test-report` supplies the authoritative
failure counts, including tests explicitly run with `rackunit/text-ui`.

Teaching-language checks contribute counts and failures from the public
[`test-engine/test-engine` result object](https://docs.racket-lang.org/test-engine/index.html).
The runner reads completed results without executing checks again or parsing
their output. Signature violations also fail the file. Check failures have
clickable source locations when the framework supplies a file path; its original
report retains the actual and expected values. Registered checks that did not
run make the result incomplete, including when `test-execute` disables them.
Plain Racket modules using `test-engine/racket-tests` must invoke `(test)`.

Each test profile loads the file's `configure-runtime` submodule, when present,
before its test submodule or module body, matching the documented
[`raco test` single-file default](https://docs.racket-lang.org/raco/test.html).
This lets teaching languages install their runtime reporting parameters.
An independent test submodule still does not require its enclosing module to run.

Loader hooks are restricted to their execution's module registry. A nested
execution inherits the surrounding load handlers dynamically, but those handlers
delegate unchanged when the nested execution has installed its own loader.
If selected-module expansion instead enters another namespace using the same
loader, dependency loads restore the original compilation and bytecode policy.
This prevents instrumentation settings from changing ordinary library loads.
Nested execution retains its evaluator and source events. Our own
RackUnit debugger suites exercise this path through Test Explorer; see the
[developer testing workflow](../tests/README.md).

Errors propagate through the existing loader exception handler. Reporting does
not introduce an intervening handler that would obscure the live continuation
from the debugger. Normal exceptions can therefore stop with their lexical
variables intact. RackUnit checks handled by RackUnit remain handled failures;
debug them using source breakpoints.

The worker emits `racketdap/test` events:

- `kind: "failure"`: a message and, when available, a location with an absolute
  path and one-based UTF-16 line/column. Positions are converted using captured
  source text, not a newly read file that may have changed.
- `kind: "summary"`: `status` (`passed`, `failed`, or `errored`), `failed`, and
  `total` counts. A failed or errored run exits nonzero.
- `kind: "case"`: source-position `id`, `name`, and `status` (`started`,
  `passed`, `failed`, `errored`, or `skipped`). Nested cases add a `path` array of
  `[siblingOrdinal, name]` components, including the outer suite; unnamed cases
  use `false`. `testSelection` retains `sourceHash` and root `ids`, with optional
  `cases: [{id, path}]` to restrict those roots to particular nested cases.
  Roots absent from `cases` run completely. Incomplete cases become errored,
  or skipped when cancelled.

Program stdout/stderr remain ordinary output. No terminal text is parsed to
decide success or extract failures. Missing final reports, including early
process exits, are errors rather than successful test runs.

Source details are available for direct checks, immediately executed test cases
and cases within supported runner calls. Other custom runners still contribute
logged counts and their own output.

Choose **Run with package policies (raco test)** in Test Explorer to delegate
selected files to `raco test --process --modules --timeout +inf.0`. This enables
per-file timeouts while leaving the default unlimited. Racket handles `info.rkt`
omissions, arguments, timeouts and locks. Standard error retains native behaviour. Results reflect each
native process's exit status, including a successful omission; native output
appears in the task terminal. This profile runs files and supports cancellation.
The ordinary Run, Debug and Coverage profiles provide individual results and
instrumentation, without imposing package runner policies. Use
[Test Package](packages.md) to traverse an entire installed package.
Use the include/exclude
settings to select files; the working directory is the owning workspace.
`racketdap.testing.sourceRoots` controls source instrumentation for Debug Test and coverage,
using directories relative to that workspace (or absolute paths). It defaults
to the whole workspace, and the test file is always selected. This allows
debugger stress tests to instrument the test harness while the harness manages
its own target programs.

Use the native **Run Tests with Coverage** controls for a file or selected case.
The Coverage profile runs tests without pausing and reports executed expressions
in VS Code's Test Coverage view and editor. Reports from completed test files
are combined, including their loaded dependencies under the configured source
roots. Files that are never loaded are not included. Assertion failures still
produce coverage; cancelled or incomplete processes do not.

Coverage uses the shared instrumenter, including runtime constants and references,
grouped by source range. Ordinary debugger stepping retains its existing sites.
It reports whether each expression ran, not execution counts, branch coverage,
or function coverage. Transformer execution is not measured.
Generated expressions sharing a range contribute one result. Edited sources and
different revisions loaded by separate test processes are omitted rather than
combined. Run coverage again after editing to refresh the totals.

The behaviour comparison used original examples in the Racket 9.1 IDE. Two
`check-expect` forms, one failing, produced two tests and one failure. With
syntactic test suite coverage enabled, `(if flag 'left 'right)` called with
`#t` marked `'right` as unexecuted. Racketeer's native test results and coverage
now report those same outcomes. The regression fixtures in
[`teaching-tests.test.js`](../tests/teaching-tests.test.js) and
[`test-coverage.test.js`](../tests/test-coverage.test.js) were written independently
from those observations and public documentation, without consulting that IDE's
implementation or tests. This comparison establishes these behaviours only.

The adapter accepts `coverage: true` together with `testMode: true` and
`noDebug: true`. Before the final test summary it emits `racketdap/coverage`
events containing an absolute `path`, a `sourceHash` of the captured UTF-8 text
with CRLF normalised to LF, and `statements`. Each statement has zero-based
UTF-16 `line`, `column`, `endLine`, `endColumn` (exclusive end), and a boolean
`executed`. The hash uses the same SHA-1 convention as test selection.

## Session ownership

Each workflow launch carries a unique correlation ID. A shared session manager
associates protocol events, readiness, exit status, and cancellation with that
launch. Test runs never select a process by the active debug session. Each
profile saves selected files, runs them sequentially, and skips remaining files
on cancellation. Concurrent runs remain independent. Source edits invalidate
previous Test Explorer results.

Debug REPL sessions are keyed by program, executable, and working directory.
Repeated opens reuse a session; lifecycle operations for one key are serialised.
Restart terminates that session, waits for termination, and loads a fresh saved
module. Other REPLs remain usable. Loading chooses only the root module and
does not run `main` or `test`.

File Run and Debug share a separate owner for each program, executable and
working directory. Reruns save before stopping the previous execution, then
wait for its termination before launching. Results and Interactions for the
same file retain separate output and ownership. Run again and Debug again
preserve their execution mode; closing Results stops only its execution.

Selection evaluation uses DAP `evaluate` in the owning session. While paused it
uses the explicitly selected frame from that session; otherwise it uses the
module's interaction namespace. The optional `racketdapEcho: true` argument,
valid with `context: "repl"`, emits the expression and result as console output
from the adapter. This keeps output associated with the correct session without
writing to whichever console happens to be active. Ordinary Debug Console
evaluation does not request echo and retains normal VS Code rendering.

## Validation boundaries

Protocol regressions cover file/submodule selection, RackUnit control flow,
suite counts, Unicode failure locations, exception frames, required source
debugging, `noDebug`, and cancellation isolation. Packaged editor tests exercise
the actual Testing view commands and file actions, two simultaneous Debug
REPLs, selection breakpoints, restart, and cancellation. Platform validation
remains Linux ARM64; Windows and macOS are not yet verified.

These workflows share the expression instrumenter and runtime used by ordinary
debug sessions.

Public API references: [VS Code Testing API](https://code.visualstudio.com/api/extension-guides/testing),
[RackUnit extension API](https://docs.racket-lang.org/rackunit/internals.html),
and [Racket test reporting](https://docs.racket-lang.org/raco/test.html).
