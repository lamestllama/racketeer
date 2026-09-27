# Changelog

## 0.8.0

- Use the Racket project logo as the extension icon, with its upstream notice.
- Open selected Racket forms or a complete module in Racket's macro stepper,
  using the current buffer and a separate owned process.
- Add independently implemented Rhombus highlighting and editor configuration,
  and connect saved `.rhm` files to the existing language server.
- Add packaged-editor acceptance checks for macro expansion and Rhombus editing.

- Add CI builds and core tests on Linux, Windows and macOS, plus installed Linux
  editor checks against the minimum and current stable VS Code releases.
- Correct the minimum VS Code version to 1.90, which supplies the selected
  debug stack frame API used by debugger commands.

## 0.7.1

- Preserve nested continuation-mark semantics and release completed target namespaces.
- Keep worker startup cancellable, bound the complete handshake, and clean up
  owned process groups after worker or adapter failure on Unix systems.
- Execute and display one captured source snapshot, select late external
  breakpoints at load time, and validate breakpoint coordinates and ranges.
- Recover from stalled language-server initialization and retain ownership of
  pending debug launches during disposal. Allow a configurable startup deadline
  for cold language-server compilation.
- Preserve open language-server buffers when delayed file-creation notifications arrive.
- Allow selection evaluation inside a paused Debug REPL call and enforce
  captured-source session ownership for Continue to Cursor.
- Lock the packager dependency, consolidate headless checks, and verify fresh
  editor runs against an exact artifact and its source manifest.

## 0.7.0

Initial Racketeer development release.

- DAP source debugging with expression breakpoints, stepping across modules and
  packages, live lexical inspection, evaluation, mutation, and returned values.
- Conditional breakpoints, hit counts, logpoints, exception stops, resumable
  pause, cancellation, GUI callbacks, and captured source views.
- Bundled Racket language tools for highlighting, diagnostics, completion,
  navigation, rename, documentation, and formatting.
- Plain and Debug REPLs with file loading, selection evaluation, restart, and
  repeated debuggable interactions.
- Test Explorer Run and Debug profiles, structured RackUnit failures, source
  locations, and validation using the extension's own suites.
- Package install, link, update, remove, build, test, and source-opening commands
  using native Racket scopes, dependency checks, and package test metadata.
- Recorded language-server fix for highlighting ranges beyond document bounds.
- Multi-file and linked-package examples with reproducible validation workflows.
