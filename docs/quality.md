# Release quality requirements

The extension is a development release. A passing test count is evidence for
the behaviors exercised on the recorded environment; it is not a declaration
of production readiness on other platforms or configurations.

## Required evidence for each release

1. Build the VSIX from the reviewed tree and record its SHA256. Install that
   artifact in an isolated editor profile and test the installed code.
2. Run the RackUnit suites both directly and through our Test Explorer's Run
   and Debug profiles. Verify the expected suite inventory and case counts,
   a real breakpoint with live locals, a deliberate assertion failure and its
   source location, and a successful rerun after correction.
3. Run protocol, language, GUI, and workflow regressions. Cover termination at
   the end of a program, cancellation while blocked, repeated REPL evaluations,
   concurrent session ownership, and stale-source handling.
4. Exercise package operations in a private Racket package scope. Verify source
   debugging outside the workspace, dependency and metadata delegation,
   failed-operation recovery, and cancellation with child-process cleanup.
   An update test must change the installed source, not only return success.
5. Preserve component invariants and dependency licences. Record the source
   hashes of the instrumentation files. Retain reports,
   logs, environment versions, reproduction commands, and known limitations.

See [the test workflow](../tests/README.md) for executable checks and
[release records](releases/) for evidence. A failing required check blocks the
release; disabling a check or relabeling a failure as success is not a fix.

## Clean-room development of new features

Specify new features from public language and protocol documentation and
observable behavior. Implementation and regression tests must be written
independently, without copying, translating, or consulting the corresponding
implementation or tests in another tool.

A source-aware comparison must hand off only behavioral requirements to an
implementer who has not seen the compared implementation. Record the sources
used for the specification and the checks establishing the resulting behavior.
Do not describe source-informed rewriting as clean-room work.

Existing third-party dependencies remain explicitly identified dependencies,
with their licences and legitimate attribution preserved. Using their public
APIs does not make their implementations original Racketeer code.

## Current support and outstanding validation

The recorded [0.8.0 local release environment](releases/0.8.0.md) is Linux
ARM64, full Racket 9.1 CS, VS Code 1.98.1.
Before declaring broader production support, run the installed-artifact tests
on Windows, macOS, and Linux x64, on the advertised minimum and current editor
versions, and on each supported Racket version. The editor harness supports
Linux, Windows and macOS; record passing results for each selected configuration.

Package tests use local links and archives without depending on the network.
Catalog and Git installation, interrupted downloads, proxy/authentication
failures, and simultaneous external package changes need dedicated integration
coverage. So do long-running sessions and resource/performance measurements on
representative large projects.

The [CI workflow](../.github/workflows/ci.yml) builds the extension and runs the
core suites on Linux x64, Windows x64 and macOS ARM64, with Racket 9.1 and the
current stable release. Linux jobs also exercise the installed extension,
Test Explorer, GUI callbacks and bundled language-server regressions on the
minimum and current stable editor versions. [CI details](ci.md) describe the
installed-editor checks on Windows and macOS as well. A configured
job establishes support only once its results pass for the revision in question.

Owned process cleanup passes the [native lifecycle and macro-stepper checks](https://github.com/lamestllama/racketeer/actions/runs/36821772249)
on Windows x64 with Racket 9.1 and 9.3, Linux x64 and macOS ARM64 with Racket 9.1.
The Unix implementation retains a separate live group leader; processes that
deliberately leave that group are outside its ownership. Windows uses a Job
Object owned by the adapter or macro-stepper supervisor. Its worker joins before
running project code; closing the owner's handle terminates the job, including
on owner death. Checks cover children and grandchildren, startup cancellation,
Stop, Disconnect, worker and adapter crashes, preservation of unrelated processes,
and cancellation of a stuck macro transformer with a child process. These checks
are separate from installed VS Code extension checks.

The [native validation run](https://github.com/lamestllama/racketeer/actions/runs/36855276354)
at revision `a5ad68e` passes all eleven jobs. The six core configurations use
Racket 9.1 and 9.3 on Linux x64, Windows x64 and macOS ARM64. Each runs all
110 RackUnit cases and 138 Node tests, with the recorded platform-specific skips. Each of the five
editor configurations passes 91 ordinary checks, 100 checks with the pinned
Rhombus runtime, GUI regressions, and all 110 RackUnit cases through each
Test Explorer profile. The recorded editors are VS Code 1.90.0 for the minimum
version and 1.140.0 for stable; [CI details](ci.md) list the selected combinations.

The macOS installation now preserves source and bytecode timestamps, preventing
the installation itself from invalidating bundled bytecode. Workspace discovery
and analysis run in disposable places so cancelling work does not terminate a
thread sharing the controller's module-loading state. Regression checks cover
active expansion cancellation, worker failure and recovery, and references across
unopened files.

The pinned `vscode-jsonrpc` dependency has a narrow write-failure correction:
failed requests reject their callers without an additional unhandled rejection.
The public transport regression exercises failed header writes, body writes and
encoding with Node's strict unhandled-rejection handling. See the
[dependency patch record](../vendor/README.md#javascript-language-client-reliability).

Known product boundaries remain explicit:

- Test Explorer discovers direct named RackUnit cases and `run-tests` calls.
  Bound and generated suites report nested results during explicit execution.
  Nested selection retains suite construction and fixtures; dynamic tests need
  stable names and ordering for reruns. Mixed forms, custom runners and teaching
  checks retain file-level execution. The separate raco profile delegates package
  policies to Racket, with native task output and file-level exit results.
- The language client uses one Racket installation per window, selected by the
  first workspace folder. Use separate windows for different installations.
- Package mutation commands operate in user scope. Debugging requires source
  files and explicitly selected packages; dependencies are not automatically
  instrumented.
- Remote development has not been validated. Debugger semantic coverage is
  recorded in the [parity matrix](parity/DEBUGGER.md); claims must stay within
  that tested scope.

Production release review must resolve the applicable gaps or define a narrower
supported configuration with evidence. Development artifacts remain useful for
testing while that work continues.
