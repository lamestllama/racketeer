# Understanding the stops

Racketeer currently steps through expressions and exposes both their start and
their returned values. It does not simply move to the next source line.

In [the multi-file example](../examples/multi-file/main.rkt), the default launch
stops at `(quote-order)` on line 10, the first executable expression inside
`module+ main`. Module initialisation has created the function on lines 5–7;
its body has not run yet. `stopOnEntry` waits for the selected entry module,
while explicit breakpoints can still stop during initialisation.

Without a `main` submodule, entry is the first instrumented expression in the
program's module body. An explicit submodule selection uses that submodule;
test mode uses `test` when present. Plain files start at their first instrumented
expression. An entry module without executable stops runs to completion.

To pause before initialisation, add this to your launch configuration:

```json
"stopOnEntry": true,
"stopOnEntryMode": "firstExpression"
```

The default mode is `"entryPoint"`. `"firstExpression"` pauses at the first
instrumented expression, including initialisation in debugged dependencies.
In the multi-file example it stops at the function setup on line 5, before
`main` runs. Files outside the configured debug sources and compile-time code
are not covered by this stop. Use **Racket: debug initialization** from
**Add Configuration** in `launch.json` to insert a complete configuration.
`stopOnEntry: false` disables the automatic stop in either mode; Run Without
Debugging also ignores it. Breakpoints remain independent of the chosen mode.

In the default `entryPoint` mode, Step Over produces these stops:

| Stop | Highlight | Meaning |
| --- | --- | --- |
| Initial stop | `(quote-order)` on line 10 | About to call the function |
| First F10 | Call's closing parenthesis on line 10 | The call has returned; inspect Return values |
| Second F10 | `printf` on line 11 | About to print the result |

From the initial stop, **F11 / Step Into** enters the body
at line 6; further steps enter `app/orders.rkt` and its required files.
**F10 / Step Over** evaluates the selected expression, including its calls,
and stops at the call site when it returns, before advancing to the next
expression. This completion stop lets you inspect or change the return values.
**Shift+F11 / Step Out** follows the current function's
return context. **F5 / Continue** runs until a breakpoint, exception, or completion.
You can set `stopOnEntry` to `false` to run directly to your first breakpoint.

**Call Stack**, **Variables**, and **Watch**
retain their native VS Code labels. The **Locals** scope in Variables contains
the lexical variables visible in the selected frame.

Call Stack labels each stop **Before evaluation** or **Returned N values**.
Before evaluation, the expression is highlighted; after it returns, the marker
moves to its closing parenthesis. Open **Return values** to inspect those values.
The scope includes the count, such as **Return values (1)**; **Return values
(0)** is distinct from one `#<void>` value.
**Waiting for return** identifies a caller whose calculation is still pending.
These are two stages of one evaluation, not two executions of the expression.

Hover, Go to Definition, and Find References also work in captured debugger
sources. Navigation opens the current project files. Language-server results
are used only while the captured source matches the current file; editing that
file suspends these features until the contents match again or debugging restarts.

Internal definitions expand into binding containers whose source range can
cover the whole function. Those generated containers are not separate stepping
stops. Step Into enters the first executable initialiser, and Step Over advances
through the remaining initialisers and body expressions. Explicit binding forms
such as `let` and `letrec` retain their own expression stops. Macros can still
execute a source expression more than once. Each execution retains its start
and returned-value stops. When expansion metadata identifies the source
expression inside a generated wrapper with the same range, that expression
owns the stop. Step Over then completes one execution, not the whole wrapper.

Standalone expressions in a module body or plain file also have stops when
they are a literal, a variable reference, or a function expression. Atomic
operands inside larger expressions and atomic definition initialisers remain
outside the stepping sequence.

Structures show bounded field previews and expand in Variables and Watch.
Fields are numbered in visible
superclass-to-subclass order; Racket's runtime reflection does not provide field
names. Inspection uses Racket's inspector API and does not run custom printers,
name callbacks, or wrapped accessors. Structures outside the debugger's inspector
remain opaque. Use an explicit console expression to invoke a custom accessor.

Symbol and keyword previews use Racket escaping, including inside containers
and syntax objects, so `|blue bud|` remains distinguishable from two symbols.
Ports show their input/output direction. When an instrumented call invokes a
known Racket port constructor directly or through an unchanged alias, the preview
also shows its name; expanding it exposes direction, name, and `closed?`.
Inspection does not read, write, flush, or close the port. Ports obtained through
unobserved library calls, `apply`, keyword or optimised constructor dispatch,
wrapped constructors, or
delegating structures retain a conservative direction-only preview. These paths
can involve user callbacks, so their names and state are not queried implicitly.
Racket can use optimised dispatch for file constructors even without explicit
keywords; calling the unchanged constructor through a local alias retains its
identity and allows metadata inspection.
