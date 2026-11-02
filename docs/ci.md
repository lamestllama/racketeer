# Continuous integration

The [GitHub Actions workflow](../.github/workflows/ci.yml) runs on pushes, pull
requests and manual dispatch. It uses read-only repository permissions and
actions pinned to commit hashes. A newer run cancels an older run of the same
branch; failures in one matrix entry do not cancel the other entries.

## Matrix

| Checks | Platform | Racket CS | VS Code |
| --- | --- | --- | --- |
| Offline package build, native and Node suites | Linux x64, Windows x64, macOS ARM64 | 9.1 and stable | Not required |
| Installed extension, Test Explorer Run/Debug, GUI and language server | Linux x64 | 9.1 | Minimum from the extension manifest and stable |
| Installed extension, Test Explorer Run/Debug, GUI and language server | Linux x64 | Stable | Stable |
| Installed extension, Test Explorer Run/Debug and GUI | Windows x64, macOS ARM64 | 9.1 | Stable |

Each entry installs the full Racket distribution, Node.js 20, Python 3.12 and
locked npm dependencies. On macOS, the installer preserves the distribution's
file timestamps so bundled bytecode remains valid. The core jobs run `scripts/test-headless.js`, the same
entry point used by the local npm and editor tasks. Platform-specific tests
retain explicit skips. Native process ownership and macro-stepper cancellation
results are recorded in the [quality requirements](quality.md).
Racket and Node test files have a three-minute timeout; individual protocol
requests retain their shorter deadlines. A blocked suite fails before the
overall job deadline.

Editor jobs download VS Code through the locked `@vscode/test-electron` development
dependency. The declared minimum is 1.91.0, the oldest version supported by
the bundled `vscode-languageclient` 11. Versions before 1.90.0 also lack the
selected debug stack frame API used by frame-sensitive commands. The resolved
editor version and commit are recorded, including when the requested version is
`stable`.

Each job builds its own VSIX and manifest. Installed tests verify that exact
artifact against its source and test inputs, then install it in fresh editor,
extension, workspace and Racket addon directories. Integration and dogfooding
runs execute sequentially to avoid competing cold language-server starts.

Editor jobs first run the ordinary integration suite with no additional
language packages. A second, explicit `--rhombus` integration run provisions
the four packages in `scripts/rhombus-runtime-lock.json` into a fresh private
addon directory and exercises Rhombus language-server behaviour. Sources are
pinned to Git commits; dependency discovery cannot fetch unlisted packages.
This step requires network access and fails on installation or identity-check
errors. Test Explorer dogfooding then runs with another pristine addon.
The Rhombus installation does not alter the ordinary user package scope.

## Results

Every job must pass; there are no allowed-failure matrix entries. Logs are
uploaded even after a failing step. Editor jobs retain the VSIX, content/input
manifest, environment, resolved editor version, and all editor reports for
14 days, including the Rhombus package identities and installation logs.
Language-server output and extension-host logs are retained to diagnose editor
failures alongside the protocol traces in the test output. Editor jobs set
`RACKETEER_INDEX_TRACE`, so that output shows when each workspace analysis worker
starts and stops, and regular lines from the index's own timer: the last worker
line names the wait a stalled index stuck in, and the timer lines show whether
the whole runtime stopped with it.
Profiles, package caches and downloaded editors are not uploaded.
GitHub also retains the full job console logs. Download an editor job's artifact
to inspect or reproduce a particular build; archive timestamps may differ
between builds, so compare the recorded hashes for the selected artifact.

Run the same commands locally as documented in [tests/README.md](../tests/README.md).
The installed-editor harness accepts `--code` pointing to the VS Code executable,
CLI launcher, or macOS application bundle. Linux requires Xvfb (`--xvfb` can
select its executable); Windows and macOS use their native desktop. On Windows,
use `python` if `python3` is unavailable. For native GUI regressions, run
`node --test --test-concurrency=1 tests/gui-parity.test.js tests/macro-stepper-gui.test.js`.
The workflow's stable entries can change versions between runs; use the recorded
environment and editor metadata when reproducing a failure.

## Boundaries

The installed-editor harness uses Xvfb on Linux and the native desktop on Windows
and macOS. A configured job establishes coverage only after its selected artifact
passes; native core results alone do not establish editor workflows. Remote development,
network package failure scenarios and sustained resource/performance tests remain
separate production requirements. See [quality requirements](quality.md).
