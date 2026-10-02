# Racketeer: Organised Racket

*Racket debugging, editing and REPL for VS Code.*

By [Eric Parsonage](https://github.com/lamestllama).

Racketeer's DAP server brings source-level Racket debugging to VS Code:
set breakpoints, step across modules and packages, and inspect or evaluate
live lexical bindings. The extension also bundles `racket-langserver`, REPL
workflows, Test Explorer integration, and package management.

**Status:** development release, version 0.8.6. Tested on Linux ARM64
with Racket 9.1 CS and VS Code 1.98.1. Requires **VS Code 1.90 or newer** and the
**full Racket 9.1 or newer distribution**. No separate language-server installation, Magic Racket, Node.js,
or npm is needed to use the extension. It does not automatically install Racket packages.

## Install and try it

Install `dist/racketeer-0.8.6.vsix` using VS Code's **Extensions: Install from
VSIX…**, or:

```sh
code --install-extension dist/racketeer-0.8.6.vsix
```

Open a trusted folder and a saved `.rkt` file: the language tools start
automatically. Run **Racket: Run Current File**, **Test Current File**,
**Load Current File in REPL**, or **Debug Current File** from the Command Palette.
Set `racketdap.racketExecutable` if Racket is not on PATH. The extension ID is
`lamestllama.racketeer`; the debugger type and settings prefix are `racketdap`.
Remove the earlier `lamestllama.racketdap` development extension before
installing Racketeer. Disable Magic Racket if installed to use our bundled client.

Try [examples/demo.rkt](examples/demo.rkt): place a breakpoint on line 4,
evaluate `(+ subtotal 20)` in the Debug Console, then `(set! subtotal 200)`.
Step Over displays `20` in the Results scope; continuing prints `220` and `20`.
See the [extension guide](vscode/README.md) for launch configuration and controls.
The [stepping walkthrough](docs/stepping.md) explains the initial stop and why an
expression can stay highlighted after a step.
The [workflow example](examples/workflow/main.rkt) connects two source files,
tests, and Debug REPL interactions. [Workflow design](docs/workflows.md) records
the execution model and current limits.

## What works

- Expression breakpoints, Step In/Over/Out, Continue, and resumable asynchronous Pause.
- Conditional breakpoints, hit counts, and logpoints with Racket expressions.
- Uncaught runtime exception stops, lexical frames, and exception details.
- Call stack, lexical locals, Watches, Debug Console evaluation, and variable
  assignment against the actual paused program's bindings.
- Before/after expression breakpoints, one-time Continue to Cursor, skipping
  expressions, replacing returned values, and printing values to Debug Console.
- Results scopes distinguishing zero, one, and multiple returned values.
- Source-variable hover, printing, and assignment, including module variables.
- GUI callbacks and eventspace lifetime, additional module languages, and plain
  non-module files through the launch `language` setting.
- Bounded inspection of pairs, vectors, boxes, and hashes without forcing
  promises or invoking custom writers.
- Individual Racket thread stops, separate target process, captured stdout and
  stderr, and termination even while an evaluation is blocked.
- Workspace source instrumentation, pending breakpoint resolution, Unicode
  source coordinates, and captured source available after on-disk edits.
- Script launch, automatic `main` submodule, explicit submodules such as `test`,
  exported entry procedure, arguments, working directory, and environment.
- Persistent Debug Console sessions (`"interactive": true`) whose function calls
  can hit breakpoints, plus cooperative **Racket: Cancel Evaluation**.
- Integrated terminal line input/output (`"console": "integratedTerminal"`),
  EOF, and interruption. Try [examples/input.rkt](examples/input.rkt).

- Bundled language server: completion, hover documentation, definition,
  references, rename, diagnostics, symbols, and formatting.
- Syntax highlighting, bracket matching, commenting, and two-space indentation.
- Rhombus `.rhm` highlighting and language-server integration when the Rhombus
  language is installed in the selected Racket environment.
- Macro expansion through Racket's macro stepper, for selected expressions or
  complete modules. See [editor tools](docs/editor-tools.md).
- Run tasks and Test Explorer with Run/Debug profiles, failure locations, and cancellation.
- Plain and debugging REPLs, file loading/reloading, selection evaluation, and
  module-specific Debug REPL restart.
- A File Actions menu connecting Run, Debug, Test, and REPL workflows.
- Package install/link/update/remove, build and test commands, and source
  debugging of named installed packages, including links outside the workspace.

The [debugger parity matrix](docs/parity/DEBUGGER.md) maps debugger
controls to this extension and records the tested scope. Runtime instrumentation
accepts additional module languages through their own module-begin expansion;
regressions cover Scheme, Typed Racket, teaching languages, and custom languages.
Selected modules permit interactive assignment to their definitions.

Caught-exception tracing, transformer-phase stepping, arbitrary-process attach,
reverse execution, and a full TTY are outside this release. Cancellation and Pause
respect Racket's break-disable regions. Effects already performed are not undone.
The CI matrix also checks the core on Linux x64, Windows x64, and macOS ARM64;
installed-editor coverage remains on Linux. Consult the results for the exact
revision and environment before relying on a platform claim.
The [release quality requirements](docs/quality.md) record acceptance checks,
support boundaries, and validation still needed before a production release.
The [0.7.1 validation record](docs/releases/0.7.1.md) identifies the tested
artifact, results, reproducible commands, and remaining platform work.

## Build and verify

[Continuous integration](docs/ci.md) runs core checks on Linux, Windows and macOS,
and verifies installed extension workflows on Linux with the minimum and current
stable editor versions. Each run retains its test reports and artifact identities.

For a hands-on REPL walkthrough, use the [multi-file example](examples/multi-file/README.md).
It follows four calls through nested folders and explains the breakpoint,
console input, expected locals, results, and restart commands.
For package workflows, see [package development](docs/packages.md) and the
[linked-package example](examples/packages/README.md).

We use this extension to test itself. Open this repository in VS Code with the
extension installed, open **Testing**, and select **Run All Tests**. The checked-in
workspace settings discover our RackUnit suites, excluding fixtures and support
modules. Set a breakpoint in a test and select **Debug Test** to inspect it.
See [tests/README.md](tests/README.md) for the test format and developer workflow.

Node.js 20 or newer is needed to build the extension and run protocol tests.
The package script stages the Racket sources, bundles the JavaScript client
with esbuild, and uses the locked local `@vscode/vsce` 3.9.2 dependency.
After `npm ci`, packaging works offline; it does not fetch a packager through `npx`.
The resulting VSIX includes all JavaScript runtime dependencies and their
license notices. Vendored source versions and reproduction instructions are
in [vendor/README.md](vendor/README.md).

```sh
npm ci --prefix vscode
node scripts/package-extension.js
node scripts/test-headless.js
```

On Linux, test the packaged VSIX in a separate VS Code profile and extension
directory with Python 3 and Xvfb available:

```sh
python3 scripts/test-gui.py
python3 scripts/test-vscode.py --artifact dist/racketeer-0.8.6.vsix
python3 scripts/test-vscode.py --rhombus --artifact dist/racketeer-0.8.6.vsix
python3 scripts/test-vscode.py --dogfood --artifact dist/racketeer-0.8.6.vsix
```

Use `--code` and `--xvfb` to select those executables. Each run creates fresh
workspace, editor profile, extension, and Racket addon directories under
`.test-output/integration/run-*/` or `.test-output/dogfood/run-*/`. Each parent
directory has a `latest.json` pointing to the latest run and report. Existing
runs remain available for review. Dogfooding drives Test Explorer, test debugging,
and failure reporting against a disposable copy of the real repository suites.

Packaging writes a `.vsix.build.json` beside the VSIX. Editor checks require
that manifest, reject artifacts whose source or test inputs have changed,
and verify the installed files against the archive. Reports record the artifact
SHA256 and build-input identity. Rebuild after changing those inputs, including
editor tests. `npm test --prefix vscode` and the headless editor task both use
`scripts/test-headless.js`; `--list` shows its discovered suites. GUI and editor
checks remain explicit because they require a display or VS Code.

The semantic fixtures compare source-loaded normal and instrumented execution
for tail recursion, multiple values, `begin0`, continuations, cross-thread
continuation invocation, `dynamic-wind`, macros, modules, submodules, and
compile-time effects. Protocol tests exercise stepping, mutation, handle
expiration, Unicode, thread control, and process termination. These are fixture
results, not general language-compatibility guarantees.

The editor integration test covers the packaged language server with an empty
Racket addon directory, editing providers, unsaved diagnostics and repair,
run/test tasks, REPL file loading and selection execution, restart/disable,
and the debugger in the same extension host. Test files are copied into the
fresh run's workspace so source examples remain unchanged.

## Implementation

`racketdap/main.rkt` speaks DAP over stdio. It launches
`racketdap/worker/main.rkt` as a separate Racket process and communicates over
an authenticated loopback connection. Program output has separate pipes.
The VS Code extension registers the debugger and launches this adapter.
It separately starts the source-bundled language server through
`vscode/language-server.rkt`, adding private collection paths only in that
process. Language analysis may run expansion-time code, so VS Code workspace
trust applies to the entire extension. Unsaved new files get syntax highlighting;
save them to enable the filesystem-based language server.

The headless `run-module` API remains available from `worker/load.rkt`.
Its single `#:on-event` callback receives live stops; use `stop-kind`
to select `before` or `after` events. Import the component API directly from
`racketdap/instrumentation/instrument.rkt`.
Run `racket experiments/headless-demo.rkt` for an editor-free demonstration.
Instrumentation uses a fresh namespace and custodian, bypasses selected
bytecode caches, and does not overwrite `.zo` files. The expression instrumenter
and frame/binding runtime are under `racketdap/instrumentation/`; their
[component design](racketdap/instrumentation/DESIGN.md) describes the shared API.
The bundled language server uses Racket’s installed language-analysis libraries,
including check-syntax. Its sources, pinned archive hashes, local patch,
and licence notices are documented in [vendor/README.md](vendor/README.md).

[DESIGN.md](DESIGN.md) records the longer-term architecture and acceptance plan;
its delivery gates include work beyond this release.

## Licence

Copyright © 2026 Eric Parsonage. Racketeer's original code, examples, tests,
and documentation are available under [Apache-2.0 OR MIT](LICENSE), at your
choice. Bundled dependencies retain their own copyright and licence notices;
see [vendor/README.md](vendor/README.md).
