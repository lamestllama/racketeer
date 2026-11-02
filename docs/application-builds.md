# Building applications

Use **Racket: Create Launcher…** or **Racket: Build Executable…** with a source
module open. The command saves that document, asks for Console or GUI mode, and
asks for an output path. Build errors appear in a native task terminal. Use
**Tasks: Terminate Task** to cancel a build. A build runs in a process tree
Racketeer owns, a process group on Linux and macOS and a job object on
Windows, so cancelling it also ends processes it started, such as a child
started by compile-time code.

A launcher runs the original source using the selected Racket installation and
its user packages. An executable embeds the module and its ordinary imports,
but can still need Racket libraries and runtime files from the build machine.
Use **Racket: Create Distribution…** on that executable to collect its runtime
dependencies into a directory. The distribution command does not rebuild source.

The commands use the folder's `racketdap.racketExecutable` setting and run
`racket -l raco -- exe` or `racket -l raco -- distribute` with separate process
arguments. No shell command is constructed. Both console and GUI programs use
the same workflow. Windows outputs have an `.exe` suffix; macOS GUI outputs are
`.app` bundles. Distributions target compatible operating systems and
architectures; required system libraries, such as GUI libraries on Linux, still
need to be installed on the destination machine.

Declare data files with `define-runtime-path` so the distribution tool can copy
them and adjust their paths. Modules loaded dynamically may need `++lib`, and
languages used by dynamically read source may need `++lang`. The corresponding
task properties are `libraries` and `languages`.

For a repeatable build, add tasks to `.vscode/tasks.json`:

```json
{
  "version": "2.0.0",
  "tasks": [
    {
      "label": "Build application",
      "type": "racket-build",
      "action": "executable",
      "source": "examples/application/console.rkt",
      "output": "application",
      "gui": false,
      "group": "build",
      "problemMatcher": []
    },
    {
      "label": "Distribute application",
      "type": "racket-build",
      "action": "distribution",
      "source": "application",
      "output": "application-dist",
      "dependsOn": "Build application",
      "dependsOrder": "sequence",
      "problemMatcher": []
    }
  ]
}
```

On Windows, set both executable paths to `application.exe`. For a macOS GUI
build, use `gui: true` and `application.app`. Paths are relative to the task's
workspace folder; absolute paths and native task variables such as
`${workspaceFolder}` are supported. Parent directories must exist.
Tasks use saved source and VS Code's normal save-before-run policy. Native task
dependencies can sequence compilation and distribution. Build tasks require a
trusted workspace and are not discovered by scanning every module.

To include a dynamic import, add, for example, `"libraries": ["racket/math"]`
to the executable task. `"languages": ["at-exp racket/base"]` includes that
language's reader support. These options do not apply to launchers or the
distribution step.

Builds write directly to the selected paths using the public tools' overwrite
behaviour. A cancelled or failed build can leave partial output; successful task
completion is required before using the result.

References: [executable and launcher creation](https://docs.racket-lang.org/raco/exe.html),
[distributions](https://docs.racket-lang.org/raco/exe-dist.html), and
[VS Code task providers](https://code.visualstudio.com/api/extension-guides/task-provider).
