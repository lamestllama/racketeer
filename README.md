# Racketeer: Organised Racket

**A Racket IDE for VS Code.** Debug, run, test, navigate and package Racket in one extension, with nothing to install but Racket itself.

By [Eric Parsonage](https://github.com/lamestllama).

- **Debug** with breakpoints on lines and on the calls within a line, stepping across files and chosen packages, and live variables.
- **See results beside the code:** text, images, picts and plots as a program prints them. While debugging, zoom and rotate a plot in its own window.
- **Test** from VS Code's Testing view: run, debug or measure coverage of a file, or of a single RackUnit case in plain modules and suites.
- **Work interactively** in an Interactions window, with pictures inline and errors that link to their source, or in a plain Racket REPL in the terminal.
- **Navigate** with hover documentation, completion, go to definition and live diagnostics, from the bundled [racket-langserver](https://github.com/jeapostrophe/racket-langserver).
- **Find and rename across a project's module files,** including ones that are not open, with an index that uses no CPU until asked. Folders such as `build` and `dist` are left out by default.
- **Expand and build** with the macro stepper, package management, executables and distributions.
- **Edit** WXME documents with embedded boxes, and Rhombus with the separate `rhombus` package.

Version 0.8.50 needs **VS Code 1.91 or newer** and the **full Racket 9.1 or newer distribution**, and needs no separate language server, Magic Racket, Node.js or npm. It is tested on Linux x64 and ARM64, Windows x64 and macOS ARM64 with Racket 9.1, and with VS Code 1.91 on Linux and the newest VS Code on all three. Resyntax suggestions are optional and need the separate `resyntax` package. The macro stepper, interactive plots and the WXME editor need a graphical display.

## Install and try it

Install [Racket 9.1 or newer](https://download.racket-lang.org/), the full distribution, and put it on PATH or set `racketdap.racketExecutable`.

Install **Racketeer** from the Extensions view, or build `dist/racketeer-0.8.50.vsix` as described under [Build and test](#build-and-test) and choose **Extensions: Install from VSIX…**. From a terminal:

```sh
code --install-extension dist/racketeer-0.8.50.vsix
```

Open a trusted folder and a saved `.rkt` file: the language tools start automatically. Click the play icon at the top right of the editor to see its Results, or the debug icon beside it to stop and inspect it.

Try [examples/demo.rkt](examples/demo.rkt) from the repository: place a breakpoint on line 4, evaluate `(+ subtotal 20)` in the Debug Console, then `(set! subtotal 200)`. Step Over displays `20` in the Return values scope; continuing prints `220` and `20`.

The extension ID is `lamestllama.racketeer`; the debugger type and settings prefix are `racketdap`. Remove the earlier `lamestllama.racketdap` development extension before installing. Disable Magic Racket, if installed, to use the bundled client. With Magic Racket installed, the status bar shows **Racket: external LSP** until it is disabled and the window reloaded, and the language tools and workspace index stay off.

## Read more

- [The extension guide](vscode/README.md) describes every feature, command and setting.
- [Understanding the stops](docs/stepping.md) walks through the initial stop and why an expression can stay highlighted after a step.
- [Debugger features](docs/debugger.md) records what the debugger does and how it is tested, and [attaching to an embedded program](docs/debugger.md#attach-to-an-embedded-racket-program).
- [Run, Debug, Test and REPL execution](docs/workflows.md), [editing and macro expansion](docs/editor-tools.md), [package development](docs/packages.md), [building applications](docs/application-builds.md), [module dependencies](docs/module-dependencies.md) and [WXME editing](docs/wxme-editor.md) give the details.
- Examples: [multi-file](examples/multi-file/README.md) follows four calls through nested folders, [workflow](examples/workflow/main.rkt) connects two source files, tests and the Debug REPL, and [packages](examples/packages/README.md) shows a linked package.

Limits on what is offered are stated in [the extension guide](vscode/README.md#limits). The [release quality requirements](docs/quality.md) and [0.8.50 validation record](docs/releases/0.8.50.md) state what has been checked and what is still needed.

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

Continuous integration runs the core and the installed extension on Linux x64 at every push, with the minimum and newest VS Code, and on Windows x64 and macOS ARM64 on demand. It uses Racket 9.1 and Racket's stable release, except that the installed extension on Windows and macOS uses 9.1 alone.

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
