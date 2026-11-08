<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Debug a linked package outside the workspace

This example has two independent directories:

- `app/`: the program to run.
- `racketdap-example-lib/`: a package providing the `racketdap-example` collection.

1. Open **app/** as your VS Code workspace.
2. Run **Racket: Link Local Package** and choose the sibling directory
   `racketdap-example-lib`. Racket installs a link in user scope and resolves
   the dependencies declared in `info.rkt`.
3. Open `app/main.rkt` and run **Racket: Debug Current File**. Step In at
   `(twice value)` to enter the linked package's `math.rkt` outside the workspace.
4. Or run **Racket: Load Current File in Debug REPL**, set a breakpoint in
   `math.rkt` on `(+ value value)`, and enter `(answer 7)` in **Debug Console**.
   Inspect `value = 7`, then continue to receive `14`.
5. Run **Racket: Test Package** and select `racketdap-example-lib`. Its RackUnit
   test passes through the standard package runner.
6. When finished, **Racket: Remove Package** removes the link; the source
   directory remains available.

The checked-in `app/.vscode/settings.json` selects `racketdap-example-lib` for
debugging. You can also select it using **Racket: Choose Packages to Debug**.
The installed package name differs from the collection name in
`(require racketdap-example/math)`.

Command-line equivalents from this example directory:

```sh
raco pkg install --scope user --auto --link ./racketdap-example-lib
racket app/main.rkt
raco test --package racketdap-example-lib
raco pkg remove --scope user racketdap-example-lib
```
