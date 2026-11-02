# Module dependencies

Run **Racket: Browse Module Dependencies** with a named source file open, or from
its Explorer context menu. The **Racket Dependencies** tree shows imports and
submodules. Select a module to open its source file; expand it to inspect its own
imports. Built-in modules have no source file to open. A repeated module within a
branch is marked and stops expanding.

Phase labels describe the import shift relative to the parent module: phase 0 is
an ordinary import, phase +1 is a compile-time import, and label phase is a
`for-label` import. Other integer shifts are retained. These labels are not an
accumulated phase from the tree root. Submodule declarations have a separate
label, including submodules supplied by the language.

Analysis includes open Racket and Rhombus buffers with file names, including
unsaved changes in dependencies. It does not save those buffers. The selected
module is compiled from source in a fresh namespace; project intermediates use
the same source-snapshot loader as the language service. Runtime bodies are not
invoked by the browser. Readers and compile-time code run during compilation, so
workspace trust is required.

The view refreshes after buffer changes, closes, workspace or executable-setting
changes, and changes to observed files, including files outside the workspace.
**Racket: Refresh Module Dependencies** clears the current analysis and retries
failed modules. A syntax or resolution error appears in the affected branch.
Source changes during analysis invalidate the result. Failed analysis does not
mean that a module has no imports.

## Implementation

`racketdap/tools/module-dependencies.rkt` returns module identities, direct import
edges, phase shifts and nested declarations. It uses the public `get-module-code`,
`module-compiled-imports`, `module-compiled-submodules` and
`resolve-module-path-index` APIs. It has no editor or transport state and loads no
GUI application modules. The browser does not parse `require` forms or maintain another
workspace reference index.

`vscode/dependencies.js` adapts those results to VS Code's `TreeDataProvider`.
Source commands use native `vscode.open`. Analysis is lazy, serialised and cached
per file within a view generation; a refresh replaces that generation and cancels
its work. Content fingerprints and filesystem watches prevent an older result
from being accepted after an observed source change.

Each request has a 20-second deadline. The view accepts at most 32 MiB of open
source buffers and 200 analysed files per generation. Individual results are
limited to 8 MiB, 2,000 modules, 64 levels of submodules and 20,000 imports per
module. Reaching a limit reports an error rather than a complete-looking partial
tree. A smaller module can be selected as a new root.

`dependency-worker.rkt` owns the JSON boundary. The shared tool supervisor keeps
compilation and its ordinary subprocesses in an owned process group. Completion,
cancellation, timeout or loss of the extension host releases that group. The
macro stepper uses the same supervisor. The existing workspace index and LSP
protocol are unchanged.

References: [module inspection](https://docs.racket-lang.org/reference/Module_Names_and_Loading.html),
[module-processing helpers](https://docs.racket-lang.org/syntax/module-helpers.html),
[VS Code tree views](https://code.visualstudio.com/api/extension-guides/tree-view).
