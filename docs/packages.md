<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Package development

Run **Racket: Manage Packages** in a trusted workspace. The extension uses the
Racket executable selected by `racketdap.racketExecutable` for package commands,
programs, and debugging. In a workspace with multiple root folders, package
commands use the active file's folder (or ask for a folder). The language client
currently uses the first folder's Racket executable for the whole window; use
separate windows when folders require different Racket installations.

| Action | Behaviour |
| --- | --- |
| Install Package | Accepts a package name, Git URL, archive, or local directory; `raco pkg` resolves dependencies. |
| Link Local Package | Installs a directory link so edits apply to the package's source. |
| Update Package | Updates one selected user package and resolves required dependencies. Packages installed from local archives or copied directories prompt for a replacement source. Directory links already use their source directly; edit that source and use Build Package. |
| Remove Package | Removes one selected user package; `raco pkg` enforces dependency constraints. |
| Test Package | Runs `raco test --package`, including `info.rkt` test policies. |
| Build Package | Runs `raco setup --pkgs` for a selected user package. |
| Open Package Source | Opens the resolved package directory in a new editor window. |
| Choose Packages to Debug | Saves package names whose sources should be instrumented in future debug sessions. |

Each operation is also a Command Palette command. Install, link, update, and
remove use Racket's **user scope** for the selected installation. Their task
terminals show native output; **Tasks: Terminate Task** cancels a running task.
Successful package changes restart the bundled language client so it sees the
updated environment. Existing debug processes and REPLs retain loaded code;
restart those sessions to load changes.

The extension does not install, update, or remove anything automatically when opening a
workspace. Package management uses ordinary Racket scopes, catalogues, database locking,
and dependency checks. No separate package database or project-specific replacement
environment is introduced.

## Debug package sources

**Racket: Choose Packages to Debug** selects installed packages, including
directory links outside the workspace. The selection applies to ordinary
Debug, Debug Test, and Debug REPL. It is stored as:

```json
{
  "racketdap.debug.packages": ["racketdap-example-lib"]
}
```

A launch configuration may instead set `"debugPackages": ["package-name"]`.
An explicit empty list disables the workspace selection for that launch.
These are **package names**, which can differ from the collection names used
in `require`. The [linked-package example](../examples/packages/README.md)
demonstrates that distinction.

The worker resolves names with `pkg-directory` inside the launched Racket
environment, including launch-specific environment variables. It adds those
directories to the existing source-root selection. Step In can therefore enter
package functions without requiring a breakpoint in advance. Breakpoints can
also be added after a Debug REPL has loaded a selected package. Missing selected
packages produce an explicit diagnostic; Run without debugging ignores the
optional debug selection. Source files are required for source debugging.

Select only the packages that matter to the work at hand: instrumenting large dependencies
adds execution overhead. Package selection is explicit and is not transitive.

## Package tests and Test Explorer

**Test Package** delegates to Racket's package runner, preserving metadata such
as `test-omit-paths` and `test-command-line-arguments`. Results appear in its
task terminal. Test Explorer's **Run with package policies (raco test)** profile
uses the same task mechanism for selected files, with `--process --modules` so
Racket applies file policies. Cancelling its Test Explorer run terminates its
own task. It reports native exit results and keeps output in the task terminal.

The ordinary Run, Debug and Coverage profiles support individual RackUnit cases
and structured failures. To inspect a package test, use Debug Test or a launch
configuration with its required arguments and environment; these instrumented
runs do not reproduce the native package runner's policies.

The package API returns structured data through a small Racket helper, using `pkg/lib`
and `pkg/path`. Package-management libraries load only when a package operation or
selected debug package needs them. The editor never parses `raco pkg show` tables.
Management runs public commands through process tasks with argument arrays.

References: [Racket package commands](https://docs.racket-lang.org/pkg/cmdline.html),
[package APIs](https://docs.racket-lang.org/pkg/lib.html), and
[package test configuration](https://docs.racket-lang.org/raco/test.html).
