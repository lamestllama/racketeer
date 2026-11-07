# Racketeer: Organised Racket

**A Racket IDE for VS Code and VSCodium.** Debug, run, test, navigate and package Racket in one extension, with nothing to install but Racket itself.

Racketeer provides a language server and a workspace indexing server, both over LSP, and a debug adapter over DAP.

By [Eric Parsonage](https://github.com/lamestllama).

- **Debug** with breakpoints on lines and on the calls within a line, stepping across files and chosen packages, and live variables.
- **Attach the debugger to a running Racket program that embeds the debug host.** Inspect servers, long-running jobs and programs started outside the editor.
- **See results beside the code:** text, images, picts and plots as a program prints them. While debugging, zoom and rotate a plot in its own window.
- **Test** from VS Code's Testing view: run, debug or measure coverage of a file, or of a single RackUnit case in plain modules and suites.
- **Work interactively** in an Interactions window, with pictures inline and errors that link to their source, or in a plain Racket REPL in the terminal.
- **Navigate** with hover documentation, completion, go to definition and live diagnostics, from the bundled [racket-langserver](https://github.com/jeapostrophe/racket-langserver).
- **Find and rename across a project's module files,** including ones that are not open, with an index that uses no CPU until asked. Default exclusions include: `build` and `dist`.
- **Macro stepping inside VS Code:** step through macros in two linked panes beside the code, Before and After, in the editor theme, with syntax colouring, scope colours, binding arrows and term details. Choose which macros and renaming steps appear, factor out common context or show one term at a time. Duplicate the stepper to compare expansions.
- **Build** with package management, executables and distributions.
- **Edit** WXME documents with embedded boxes, and Rhombus with the separate `rhombus` package.

Version 0.8.55 needs **VS Code or VSCodium 1.91 or newer** and the **full Racket 9.1 or newer distribution**, and needs no separate language server, Magic Racket, Node.js or npm. It is tested on Linux x64 and ARM64, Windows x64 and macOS ARM64 with Racket 9.1, and with VS Code 1.91 on Linux and the newest VS Code on all three. Resyntax suggestions are optional and need the separate `resyntax` package. Interactive plots and the WXME editor need a graphical display.

![A Racket file beside its Results: a curve, a 3D surface and a picture](docs/images/results-with-plots.png)

![Stopped at a breakpoint, with Variables and the Call Stack showing](docs/images/debugging.png)

![The Testing view with one failed case, and its failure shown in the editor](docs/images/test-explorer.png)

![Source beside linked Before and After macro panes, with the swap! rewrite highlighted and binding arrows connecting tmp to its uses](docs/images/macro-steps.png)

## Install and try it

Install [Racket 9.1 or newer](https://download.racket-lang.org/), the full distribution, and put it on PATH or set `racketdap.racketExecutable`.

Install **Racketeer** from the Extensions view: VS Code installs it from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=lamestllama.racketeer), and VSCodium from [Open VSX](https://open-vsx.org/extension/lamestllama/racketeer). Or build `dist/racketeer-0.8.55.vsix` as described under [Build and test](#build-and-test) and choose **Extensions: Install from VSIX…**. From a terminal:

```sh
code --install-extension dist/racketeer-0.8.55.vsix
```

Open a trusted folder and a saved `.rkt` file: the language tools start automatically. Click the play icon at the top right of the editor to see its Results, or the debug icon beside it to stop and inspect it.

Try [examples/demo.rkt](examples/demo.rkt) from the repository: place a breakpoint on line 4, evaluate `(+ subtotal 20)` in the Debug Console, then `(set! subtotal 200)`. Step Over displays `20` in the Return values scope; continuing prints `220` and `20`.

The extension ID is `lamestllama.racketeer`; the debugger type and settings prefix are `racketdap`. Remove the earlier `lamestllama.racketdap` development extension before installing. Disable Magic Racket, if installed, to use the bundled client. While Magic Racket's language server is enabled, the status bar shows **Racket: external LSP**, and Racketeer's language tools and workspace index stay off. Disable that server and reload, or accept **Use Racketeer's Tools**.

## Read more

- [The Marketplace page](vscode/README.md) introduces the features, commands and settings. The guide starts with [execution](docs/workflows.md), [editing](docs/editor-tools.md) and [debugging](docs/debugger.md).
- [Understanding the stops](docs/stepping.md) walks through the initial stop and why an expression can stay highlighted after a step.
- [Debugger features](docs/debugger.md) records what the debugger does and how it is tested, and [attaching to an embedded program](docs/debugger.md#attach-to-an-embedded-racket-program).
- [Run, Debug, Test and REPL execution](docs/workflows.md), [editing and macro expansion](docs/editor-tools.md), [package development](docs/packages.md), [building applications](docs/application-builds.md), [module dependencies](docs/module-dependencies.md) and [WXME editing](docs/wxme-editor.md) give the details.
- Examples: [multi-file](examples/multi-file/README.md) follows four calls through nested folders, [workflow](examples/workflow/main.rkt) connects two source files, tests and the Debug REPL, and [packages](examples/packages/README.md) shows a linked package.

Limits on what is offered are stated in [the extension guide](vscode/README.md#limits). The [release quality requirements](docs/quality.md) and [0.8.55 validation record](docs/releases/0.8.55.md) state what has been checked and what is still needed.

## Build and test

Node.js 20 or newer is needed to build the extension and run the protocol tests. After `npm ci`, packaging works offline.

```sh
npm ci --prefix vscode
node scripts/package-extension.js
node scripts/test-headless.js
```

On Linux, with Python 3 and Xvfb available, run the native GUI checks and test the packaged VSIX in an isolated VS Code profile:

```sh
python3 scripts/test-gui.py
python3 scripts/test-vscode.py --artifact dist/racketeer-0.8.55.vsix
python3 scripts/test-vscode.py --rhombus --artifact dist/racketeer-0.8.55.vsix
python3 scripts/test-vscode.py --dogfood --artifact dist/racketeer-0.8.55.vsix
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
