# Understanding the stops

Racketeer currently steps through expressions and exposes both their start and
their returned values. It does not simply move to the next source line.

In [the multi-file example](../examples/multi-file/main.rkt), the default launch
stops at the definition of `quote-order` on line 5. That expression creates the
function during module initialization. The function body has not run yet.
The `stopOnEntry` setting means the first instrumented expression, not the first
expression inside `module+ main`.

Starting there, Step Over produces these stops:

| Stop | Highlight | Meaning |
| --- | --- | --- |
| Initial stop | Function definition, lines 5–7 | About to create `quote-order` |
| First F10 | Definition's closing parenthesis on line 7 | Function value has been produced; inspect Results |
| Second F10 | `(quote-order)` on line 10 | About to call the function |
| Third F10 | Call's closing parenthesis on line 10 | The call has returned; inspect Results |
| Fourth F10 | `printf` on line 11 | About to print the result |

For a walkthrough of the actual calculation, set a breakpoint on `(quote-order)`
at line 10 and use **Continue** to reach it. **F11 / Step Into** enters the body
at line 6; further steps enter `app/orders.rkt` and its required files.
**F10 / Step Over** evaluates the selected expression, including its calls,
and stops when it returns. **Shift+F11 / Step Out** follows the current function's
return context. **F5 / Continue** runs until a breakpoint, exception, or completion.
You can set `stopOnEntry` to `false` to run directly to your first breakpoint.

The call stack labels each stop **Before evaluation** or **Returned N values**.
Before evaluation, the expression is highlighted; after it returns, the marker
moves to its closing parenthesis. Open **Results** to inspect those values.
**Waiting for return** identifies a caller whose calculation is still pending.
These are two stages of one evaluation, not two executions of the expression.

Hover, Go to Definition, and Find References also work in captured debugger
sources. Navigation opens the current project files. Language-server results
are used only while the captured source matches the current file; editing that
file suspends these features until the contents match again or debugging restarts.

Internal definitions expand into binding containers whose source range can
cover the whole function. Those generated containers are not separate stepping
stops. Step Into enters the first executable initializer, and Step Over advances
through the remaining initializers and body expressions. Explicit binding forms
such as `let` and `letrec` retain their own expression stops. Macros can still
produce several executable expressions with the same source range.

Structures expand in Variables and Watch. Fields are numbered in visible
superclass-to-subclass order; Racket's runtime reflection does not provide field
names. Inspection uses Racket's inspector API and does not run custom printers,
name callbacks, or wrapped accessors. Structures outside the debugger's inspector
remain opaque. Use an explicit console expression to invoke a custom accessor.
