# Racketeer: Organised Racket

**The Racket IDE for VS Code.** Debug, run, test, navigate and package Racket in one extension, with nothing else to install.

By [Eric Parsonage](https://github.com/lamestllama).

- **Debug** with breakpoints on any expression, stepping across files and packages, and live variables.
- **See results beside the code:** text, images and picts as a program runs, and plots to zoom and rotate.
- **Test** from VS Code's Testing view: run, debug or measure coverage, down to a single RackUnit case.
- **Work interactively** in an Interactions window or a REPL, with pictures inline and errors that link to their source.
- **Navigate** with hover documentation, completion, go to definition and live diagnostics, from the bundled [racket-langserver](https://github.com/jeapostrophe/racket-langserver) that waits for a pause in typing before it analyses.
- **Find and rename across a whole project:** a workspace index follows references through every file, including ones that are not open. It uses no CPU until asked, analyses files in parallel, and reuses what has not changed.
- **Expand and build** with the macro stepper, package management, executables and distributions.
- **Edit Rhombus** and WXME documents with embedded boxes.

Version 0.8.50 needs **VS Code 1.91 or newer** and the **full Racket 9.1 or newer distribution**, and needs no separate language server, Magic Racket, Node.js or npm. It is tested on Linux, Windows and macOS.

## Install and try it

Install **Racketeer** from the Extensions view in VS Code, or build a package as below and install it with **Extensions: Install from VSIX…** or:

```sh
code --install-extension dist/racketeer-0.8.50.vsix
```

Open a trusted folder and a saved `.rkt` file: the language tools start automatically. Click **Run Current File** to see text and images in Results beside the source, or **Debug Current File** for breakpoints, stepping and Variables. Set `racketdap.racketExecutable` if Racket is not on PATH.

Try [examples/demo.rkt](examples/demo.rkt): place a breakpoint on line 4, evaluate `(+ subtotal 20)` in the Debug Console, then `(set! subtotal 200)`. Step Over displays `20` in the Return values scope; continuing prints `220` and `20`.

The extension ID is `lamestllama.racketeer`; the debugger type and settings prefix are `racketdap`. Remove the earlier `lamestllama.racketdap` development extension before installing. Disable Magic Racket, if installed, to use Racketeer's bundled language client.

## Read more

- [The extension guide](vscode/README.md) describes every feature, command and setting.
- [Understanding the stops](docs/stepping.md) walks through the initial stop and why an expression can stay highlighted after a step.
- [Debugger features](docs/debugger.md) records what the debugger does and how it is tested, and [attaching to an embedded program](docs/debugger.md#attach-to-an-embedded-racket-program).
- [Run, Debug, Test and REPL execution](docs/workflows.md), [editing and macro expansion](docs/editor-tools.md), [package development](docs/packages.md), [building applications](docs/application-builds.md), [module dependencies](docs/module-dependencies.md) and [WXME editing](docs/wxme-editor.md) give the details.
- Examples: [multi-file](examples/multi-file/README.md) follows four calls through nested folders, [workflow](examples/workflow/main.rkt) connects two source files, tests and the Debug REPL, and [packages](examples/packages/README.md) shows a linked package.

Limits on what is offered are stated in [the extension guide](vscode/README.md#limits). This is a development release: the [release quality requirements](docs/quality.md) and [release records](docs/releases/) state what has been checked and what is still needed.

## Build and test

Node.js 20 or newer is needed to build the extension and run the protocol tests. After `npm ci`, packaging works offline.

```sh
npm ci --prefix vscode
node scripts/package-extension.js
node scripts/test-headless.js
```

On Linux, with Python 3 and Xvfb available, test the packaged VSIX in a separate VS Code profile and extension directory:

```sh
python3 scripts/test-gui.py
python3 scripts/test-vscode.py --artifact dist/racketeer-0.8.50.vsix
python3 scripts/test-vscode.py --rhombus --artifact dist/racketeer-0.8.50.vsix
python3 scripts/test-vscode.py --dogfood --artifact dist/racketeer-0.8.50.vsix
```

The extension tests itself. Open this repository in VS Code with the extension installed, open **Testing**, and select **Run All Tests**. Set a breakpoint in a test and select **Debug Test** to inspect it.

Details: [the test workflow](tests/README.md), and [continuous integration and local checks](docs/ci.md).

## Layout

| Path | What is there |
| --- | --- |
| `racketdap/` | The debug adapter, its worker and the [instrumentation](racketdap/instrumentation/DESIGN.md). |
| `vscode/` | The extension client, language-server launcher and manifest. |
| `vendor/` | Bundled language-server sources, patches and notices: see [vendor/README.md](vendor/README.md). |
| `tests/` | RackUnit and Node suites, helpers and fixtures. |
| `scripts/` | Packaging and test harnesses. |
| `examples/` | Programs to try each feature on. |
| `experiments/` | The headless demonstration and the lexical evaluator. |
| `docs/` | Feature details, quality requirements and release records. |

[DESIGN.md](DESIGN.md) records the longer-term architecture and acceptance plan; its delivery gates include work beyond this release. [How the pieces connect](docs/debugger.md#how-the-pieces-connect) gives the process structure.

## Licence

Copyright © 2026 Eric Parsonage. Racketeer's original code, examples, tests and documentation are available under [Apache-2.0 OR MIT](LICENSE), at the licensee's choice. Bundled dependencies retain their own copyright and licence notices: see [vendor/README.md](vendor/README.md).
