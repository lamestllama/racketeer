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
| First F10 | Same definition | Function value has been produced |
| Second F10 | `(quote-order)` on line 10 | About to call the function |
| Third F10 | Same call | The call has returned; inspect Results |
| Fourth F10 | `printf` on line 11 | About to print the result |

For a walkthrough of the actual calculation, set a breakpoint on `(quote-order)`
at line 10 and use **Continue** to reach it. **F11 / Step Into** enters the body
at line 6; further steps enter `app/orders.rkt` and its required files.
**F10 / Step Over** evaluates the selected expression, including its calls,
and stops when it returns. **Shift+F11 / Step Out** follows the current function's
return context. **F5 / Continue** runs until a breakpoint, exception, or completion.
You can set `stopOnEntry` to `false` to run directly to your first breakpoint.

Check the stop description: **Before expression** means it has not executed;
**Expression returned** means its result is available. The Results scope can
contain zero, one, or several values. A repeated highlight does not necessarily
mean the expression ran twice.

The current display has a limitation: expanded forms can share the source range
of an enclosing function, producing broad or repeated highlights. That does not
mean the function definition is being executed again. More precise source
selection and clearer distinction between startup, expression entry, and
expression results remain usability improvements.
