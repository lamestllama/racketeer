# Testing the extension with itself

[Continuous integration](../docs/ci.md) uses these same suites and installed
artifact checks. Its matrix and retained reports are described there.

Install the current VSIX and open the repository root in VS Code. Open the
**Testing** view and choose **Run All Tests**. Our workspace settings select
`tests/*.rkt` and `experiments/lexical-eval.rkt`; fixtures and helpers live in
subdirectories and are not separate tests. `node scripts/test-headless.js --list`
shows the current native and Node suite inventory. Editor dogfooding also checks
each native suite's expected case count in `tests/vscode-dogfood.js`.

Each file is an ordinary Racket module with a `module+ test` submodule:

```racket
#lang racket/base

(module+ test
  (require rackunit)
  (test-case "addition"
    (check-equal? (+ 20 22) 42)))
```

Add new suites directly under `tests/`, helpers under `tests/support/`, and
programs used as test inputs under `tests/fixtures/`. The same assertions run
in our extension and with `raco test`; there is no extension-specific test DSL
or subprocess wrapper that turns another runner's exit code into a RackUnit
assertion. The lexical evaluator experiment remains in its original location
and is explicitly included in both workflows.

To debug a real test, open `tests/protocol-inspection.rkt`, set a breakpoint on
`(define in (open-input-bytes ...))`, and run **Racket: Debug Tests in Current
File**. Inspect `message`, step, or continue to finish the suite. **Debug Test**
in the Testing view uses the same profile. Direct named cases and `run-tests`
calls appear under their files. Running a suite adds its nested cases with
separate results and failure locations. Select a nested case to Run, Debug or
collect Coverage; suite construction and fixtures still run. Generated cases
are discovered during execution, never by opening a file.

For package policies, choose **Run with package policies (raco test)** on files.
Racket applies omissions, arguments, timeouts and other native policies; results
are per file and output appears in the dedicated task terminal. **Racket: Test
Package** remains available for an entire installed package.

This workspace sets `racketdap.testing.sourceRoots` to `tests` and `experiments`.
That makes Debug Test instrument the test code; the debugger tests themselves
control instrumentation of their target programs. Instrumenting another copy
of the entire debugger implementation during these stress tests adds substantial
overhead. Add `racketdap` to this setting when stepping into the implementation
itself. Other projects default to debugging all sources in their workspace.

The tests execute the checkout's Racket sources. The extension running those
tests uses its installed adapter, so rebuild and reinstall after adapter
changes. The automated check below installs the freshly built package in its
own profile.

## Repeatable editor check

```sh
node scripts/package-extension.js
python3 scripts/test-vscode.py --dogfood
```

On Linux this needs VS Code and Xvfb; pass `--code` and `--xvfb` when their
executables are not on PATH. It uses a disposable copy of the actual suites,
source, and workspace discovery settings under `.test-output/dogfood/run-*/`. It
drives **Run All Tests**, **Debug All Tests** and **Run All Tests with Coverage**,
verifies every suite's RackUnit count, stops inside a
real test and reads a local, then changes an assertion in the copy to prove
failure reporting and source locations work. Finally it restores the assertion
and reruns the suite. It also checks the four-file Debug REPL example, including
its call stack and a second expression in the same session. It does not edit
the checkout or use your editor profile.

Each run has fresh workspace, profile, extensions, and Racket addon directories;
inherited collection and compiled-cache overrides are removed. The report and
logs are saved in its run directory, located through `.test-output/dogfood/latest.json`.
The report includes the VSIX SHA256 and build-input identity. The harness requires
the adjacent `.vsix.build.json`, rejects stale same-version artifacts, and verifies
installed contents before running the editor. Rebuild after changing source or
test inputs. Update the suite
inventory and counts in `tests/vscode-dogfood.js` when adding tests: those
expectations detect missing suites or tests silently not being executed.

## Other checks

The Node tests exercise the DAP transport and JavaScript extension code. The
editor tests require VS Code's extension host; GUI regressions use an isolated
display. These keep their native harnesses and are available through **Tasks:
Run Test Task** in this workspace. The default test task builds the package
and runs the dogfooding check above.

Command-line equivalents:

```sh
node scripts/test-headless.js
python3 scripts/test-gui.py
python3 scripts/test-vscode.py
python3 scripts/test-vscode.py --rhombus
```

The explicit `--rhombus` run installs a pinned Rhombus language runtime into its
private addon directory and exercises real semantic editing in `.rhm` files.
Its package installation requires network access and fails if provisioning
fails. Ordinary integration and dogfooding runs retain their fresh addon
directories without these extra language packages. Macro-stepper command
acceptance runs with the ordinary installed-editor checks on the isolated
display. Package identities and provisioning logs accompany the Rhombus report.

The GUI command includes callback debugging, event-loop Pause/Continue, macro-stepper windows, interactive
plots and WXME text, object and XML/Racket-box editing.

The headless command stages the bundled runtime and analysis dependencies before
running tests, so a fresh checkout does not need an earlier package build. It
discovers top-level `tests/*.rkt`, the lexical-evaluation
experiment, and every `tests/*.test.js` except the explicit GUI suites
`gui-parity.test.js`, `macro-stepper-gui.test.js`, `plots-gui.test.js`, and the display-dependent
cases in `debug-third-party-program.test.js`, `pause.test.js`, `wxme-edit.test.js`, `wxme-structure.test.js` and `wxme-xml-edit.test.js`. The first debugs a pinned external program downloaded into `.test-output/`; offline it skips, and in CI a failed download fails. The WXME cases cover
object insertion and removal, structural undo, versioned recovery, source spans,
styled Unicode and tabs, object-preserving saves, reader refusal and evaluation
of original fixtures. It is also
the implementation of `npm test --prefix vscode` and the headless workspace task.
The harness regression tests use Python 3; no editor or display is needed.

After installing locked build dependencies with `npm ci --prefix vscode`, an
offline packaging check is:

```sh
npm_config_offline=true node scripts/package-extension.js
```

The bundled upstream language server includes fixes for viewport ranges and
watched-file notifications. Run its native regression suites on Linux with:

```sh
PLTCOLLECTS="$PWD/vendor/collects:" raco test \
  vendor/collects/racket-langserver/tests/lib/doc-test.rkt \
  vendor/collects/racket-langserver/tests/lsp/workspace-lifecycle-test.rkt \
  vendor/collects/racket-langserver/tests/lsp/analysis-wait-test.rkt
```

This includes the upstream document cases, viewport bounds and preservation
of editor buffers through watched-file and rename notifications. The local
server patches recorded in `vendor/patches/` are exercised by
`tests/source-feedback.test.js`, `tests/predicted-bindings.test.js`,
`tests/unsaved-imports.test.js`, `tests/untitled-documents.test.js`,
`tests/source-positions.rkt` and `tests/predicted-bindings.rkt`.

The loader-isolation regression covers nested module and plain-file executions
with both Run and Debug policies. Each loader changes evaluation and compilation
only in its own module registry, so running debugger tests inside the test
runner preserves the tests' instrumentation.
