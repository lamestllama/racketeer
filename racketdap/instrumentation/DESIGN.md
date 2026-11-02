# Runtime-expression instrumentation: current unified API

This component instruments expanded Racket expressions and exposes execution
events, live lexical bindings, and expression results to the debugger.

## Expansion and execution

instrument-module accepts a fully expanded runtime expression, source path and
fresh site-ID allocator, plus the form's (unit . index) name, optional live module
context, snapshot module bindings, and initial tail-position flag. It returns the
rewritten expression, the visible site descriptors, and every descriptor in slot
order with whether it is visible.
It does not expand source, read files, or select modules. The loader owns those
operations and must preserve one ordinary set of expansion effects.

Generated code holds no debugger state, so it can be compiled to a file. A form
quotes its unit symbol and index, and asks form-sites for its entry when it is
instantiated: the descriptors, the event callback, the gate and the armed flags. The
loader fills that entry with register-form-sites!, during expansion or, for code read
from the cache, from the saved record. An instance with no entry gets a closed gate
and no callback, and delivers nothing, which is also how a helper instance above phase
zero stays quiet.
A unit's symbol must stay reachable while its forms can start: the table is
weak in it, and code read from a file does not intern the symbol until it runs.

Runtime forms are recognised by binding identity. Arbitrary rename-in/prefix-in
aliases are supported, and familiar printed names do not override their actual
bindings. Input binding identifiers retain their syntax scopes. Literal values,
identifier reads, variable-reference construction, and function construction
have stop sites only when they are complete module body expressions or plain
loaded top-level expressions. Atomic definition initialisers and operands inside
larger expressions remain without their own sites. Descriptors retain original
source coordinates and expanded expression data; duplicated macro occurrences
receive independent site IDs.
A macro use written in the source can expand to code located in the macro's own
file or nowhere. The top of that expansion takes the location of the use's macro
name, which the expander records in its origin, so the line that holds the use
has a site. Code located anywhere in the source keeps that location, including
a macro's chosen range within its use.
Binding containers introduced for internal definitions have neither an operator
source nor an expansion origin. Their inherited enclosing-body range is not a
separate stop; their initialisers and body are still traversed and instrumented.
Explicit and macro-originated binding forms retain their normal stops.
The containers stay in the frame for exception and asynchronous Pause inspection,
but are omitted from breakpoint sites and expression callbacks.

## What a site costs

Most programs spend almost all of their time at sites nothing wants, so a site with
nothing to do is two reads, a branch and a store: no call and no allocation, whatever
the depth of the stack. It enters the debugger only when the gate is open or its own
armed flag is set. The gate is a box owned by the loader's creator, open while a step,
Pause or entry stop is pending. An armed flag is set while a breakpoint or run-to
target is at that site. The program runs while breakpoints change, so the session changes
flags one holder at a time, sets new ones first, and clears only those no longer wanted:
a breakpoint that is staying is never unarmed for the program to pass. A loader created without a gate gets one that stays open, and
delivers every site. Code that calls no site at all, such as a procedure returning its
argument, makes no frame.

A call makes one frame, as a mark set when the call begins. Tail calls replace it, so
tail recursion stays bounded. A frame is a vector: slot 1 is the running site, which a
site stores on entry and its parent's slot restores on completion, as a Python frame
holds its last instruction. A scope that binds source names makes one closure when it is
entered, a procedure that returns its live bindings, and those bindings are built only
when a stop asks. Every variable a site can show is assigned through that closure, so the
compiler boxes it. The scope also sets a mark, as below. That is the remaining cost, and
it is per call and per variable, not per site.

An expression evaluation's identity is its frame and site, and its enclosing
evaluations follow from each site's parent. Tokens naming them are made when a stepper
asks, kept on the frame so they stay eq?, and include the host boundary marks attach
sets. A stop reads its frames and contexts from its marks when asked, so a callback that
lets the program go on does not pay for the depth of the stack. A step asks only whether
its target is still in progress, which needs no list of contexts.

A frame holds what is true of the call as a whole, and the mark holds what belongs to the
continuation. The frame-key mark set by a call and by each scope that binds source names
pairs the frame with that scope's variables, in tail position, so nested scopes on one
continuation replace each other's marks and a scope that is finished has left the
continuation with its mark. A stop takes the innermost mark for each frame, and adjacent
marks for one frame are one call. Re-entering a continuation therefore restores the
variables of the continuation that was captured: Locals, Evaluate and Set Variable address
the cells that continuation's code will read.

The frame's running site is mutable and is not restored. Two differences follow, and they
are accepted, because a site says only where a frame is:
- Re-entering a continuation captured in a frame that has since moved on leaves the frame
  showing a later site until the next site runs. A call whose continuation is composed
  directly on itself, with no other call's mark between, lists as one frame.
- An exception object kept and read again after its frames have moved on shows the current
  site of a frame that has been reused, not the site that was running when it was raised.
  Its variables are the ones its marks captured. A fresh exception shows its site exactly.
Neither is a historical trace of past execution. Completion events name their own site, and
nothing else observes the difference from a mark per site. A suspended thread's parameters
are read from its marks up to its root, past its prompts, as current-parameterization
reads them in the thread itself.

Non-tail expressions preserve all returned values through a completion continuation.
Tail wrappers retain the original expression or supplied skip values in tail position
and have no completion event. A with-continuation-mark body is tail relative to its
marked continuation, including when the entire mark expression is non-tail. Its tail
paths have no separate completion wrapper: same-key user marks must replace each other
on that continuation. The enclosing non-tail mark expression still supplies its normal
completion event and return token.

When the gate is open there is one before callback delivery and, when available, one
after delivery per dynamic expression evaluation. Consumer breakpoint filtering and
stepping decisions happen inside that one callback. Each delivery has a fresh optional
action box. stop-skip! selects actual values at entry; stop-replace-results!
selects actual values at completion and immediately changes stop-results.
Repeated actions update the pending list. Empty lists preserve zero values;
objects are forwarded without copying. Re-entered completions create fresh
stops and decisions. Callback return values do not replace program results.

## Frames and binding operations

A frame carries its site descriptor, which supplies the source, position and
span that stack traces and failure locations report.

Source-visible lexical bindings have live accessors over the real program cells. Inner
scopes shadow outer names; generated macro bindings do not hide source-authored
identifiers merely because their printed names coincide. Each scope that binds source
names has one procedure returning its live bindings, in front of its parent's, and
every site in the scope finds it through the scope's mark. Each instrumented form likewise
holds its module binding identifiers once, in a thunk that a stop calls, so syntax
literals are not read until something inspects them. Generated code therefore grows
with the source, not with the number of sites times the visible bindings.
The ordinary-expansion hook's introduction scope is removed only for the
syntax-original? source-classification check.

stop-binding-value reads a single symbol/string binding without evaluating user
syntax. It checks lexical getters first, then source module aliases and ordinary
namespace mappings. Direct namespace reads reject syntax-only bindings without
invoking macro or set!-transformer bodies. Real top-level variables are recognised
through identifier-binding's top-level-symbol? option. Uninitialised variables
produce (unavailable 'uninitialized); absent and syntax-only names raise errors.
Strings are treated as literal binding names, never parsed as expressions.

stop-evaluate evaluates an expression through lexical set!-transformers and
module rename aliases in the executing frame's namespace. It retains dynamic
parameters and arbitrary returned value counts, suppresses recursive debugger
callbacks, and runs behind a continuation barrier.

stop-set-binding! is the only assignment API. Its optional #:scope accepts
'visible (default) or 'lexical. Target resolution and scope validation happen
before evaluating the replacement. A lexical miss raises immediately, without
namespace lookup or replacement evaluation. Lexical targets use their captured
setters. Visible module targets use a hygienically bound core set! expression
through the existing frame evaluator, retaining native constant and imported
binding restrictions even when user code has a binding named set!. Assignment
returns the selected binding's resulting value. stop-locals remains lexical-only.

Every stop inspection, evaluation, or action validates the executing thread,
callback lifetime, and selected frame index. dynamic-wind expires a stop when
its callback exits; callback/evaluator continuation barriers prevent a captured
continuation from re-entering an expired stop.

## Source phase metadata

site-phases supplies the available expression event phases from the site's
tail-position flag. site-boundary-position validates the requested phase and
returns the positive one-based source position for before, or the last included
character position for after. Missing position/span data and zero-width
completion spans return #f as applicable. A tail site's after phase is rejected.
Breakpoints and
location requests can use these helpers without duplicating boundary arithmetic.

## Module contexts and loader contract

Ship instrument.rkt and runtime.rkt together. Attach both module instances into
each target namespace and establish the runtime dependency for instrumented
program modules. A plain-file namespace likewise requires the runtime before
evaluating generated expressions.

For complete module binding visibility:
- Create a root with make-module-binding-context.
- Use module-binding-context-child! with the parent, child name, and inheritance
  flag. All fragments of one module+ use the same context; inherited-language
  children use a live parent link.
- Feed expanded define-values/define-syntaxes declarations to
  record-module-bindings! before their initialisers.
- Pass the context via instrument-module's #:module-context keyword.

A context has a symbol key, which is all generated code quotes. A module records
its declarations in its first expansion pass and instruments in its second, and
children expand after their parents, so the catalog is complete when the module's
first form is instrumented. That form registers the identifiers as syntax literals,
for the module and its inherited parents, and includes later module+ fragments.
It also registers the owning module namespace,
separately per namespace registry and only at phase zero. Inherited parents
with only transformer definitions are located through the actual runtime
module ancestry. Actual expander binding symbols resolve renamed names without
guessing from printed suffixes. Source constants and imported variables retain
their ordinary assignment protections. Snapshot #:module-bindings support
remains available but does not supply complete live-fragment visibility.

The context-to-registry and registry-to-namespace maps use ephemeron associations.
Namespaces retain their registry and the context keys their code quotes, so
ordinary weak-key maps would keep completed targets alive through their values.
An externally live target retains its binding registrations; the maps alone do
not retain a target after its execution and consumer references are gone.

The loader's own module/declaration/compile-time selection must respect binding
identity. The runtime also suppresses callback delivery from any instantiation
outside phase zero.

## Exceptions and approximate pause

call-with-exception-stop receives a raised value, captures its exception marks
(or current marks for values without them), and synchronously delivers an
exception stop when source frames exist. Results contain the exact raised
value in a one-element list. Break exceptions are excluded. The helper returns
the raised value unchanged and installs no program exception handler.

call-with-pause-stop receives a break before the loader unwinds the executing
program. It delivers kind 'pause from captured source marks, with no results
or expression token. stop-approximate? reports true. The callback runs with
breaks disabled, recursive callbacks suppressed, and a continuation barrier.
The helper returns the identical break; its caller can invoke the break's
resume continuation after the helper returns.
No-frame/no-callback/hang-up/termination cases pass through without a pause
callback. Skip/result replacement reject exception and pause stops.

DAP Pause requests stops from all registered application threads, including the
requested thread. Each stops at its next source expression. The first source
stop takes editor focus; subsequent stops preserve it. This lets a GUI callback
take focus when the launch thread is waiting for the event loop. Threads first
registered while Pause is pending also stop before executing source.

After 100 milliseconds, threads that have not reached source are suspended with
call-with-thread-stop. Their captured continuation marks support approximate
inspection on a service thread. Continue or Step resumes them without running
application break handlers or unwinding dynamic-wind frames. Threads inside a
debugger callback or holding a debugger protocol lock are retried after that
operation finishes. A thread waiting outside source can have no frames;
Continue remains available. Stop events report each thread individually;
uninstrumented library threads are not claimed to be stopped.

Continue and ordinary stepping cancel pending pauses and resume the other
stopped threads. DAP singleThread requests leave other threads stopped. Step
Over and Step Out use the next source boundary when a callback has no observable
caller or expression-completion target, rather than waiting for a nonexistent
return stop.

Approximate-pause evaluation uses the suspended thread's parameterisation, read
from its marks up to its root, and live bindings on the service thread, which has
its own thread identity and thread cells. Breakpoint, step and
exception evaluation still runs on the target thread. Operations that require
the target's thread identity should be evaluated at an expression stop.

## Validation

The native consumer suites execute source through the public loader. They cover
live lexical and module bindings, evaluation and mutation, continuation re-entry,
tail recursion, multiple values, event actions, thread ownership, expired stops,
language expansion, and loader isolation. instrumentation-lifetime.rkt compares
nested user continuation marks with ordinary execution, exercises marked skip,
replacement and step-out behaviour, and checks target collection using weak
references while preserving binding access for live targets.

Run from the repository root:

```sh
raco test tests/instrumentation-lifetime.rkt tests/headless.rkt tests/stepping.rkt tests/parity-languages.rkt tests/loader-isolation.rkt
node --test --test-concurrency=1 tests/annotator-conformance.test.js tests/debugger-parity.test.js
```

The Node suites exercise the shipped DAP consumer, including source locations,
module fragments, binding identity, result edits, and asynchronous pause.

The production artifact list remains only instrument.rkt and runtime.rkt.

## Compiled code on disk

Generated code is written only in core forms, so the expander has no macro to apply to
it, and a known primitive stays inline; any other operator goes through a check for port
constructors once, in a call that takes no copy of the arguments.

The expander splits a body's internal definitions from one definition context into nested
binding forms. Expanding those again adds a scope per definition to everything below it, and
each identifier below carries them all: quadratic in the length of the body, far more than
any macro use. Racket's compile always expands its input, including fully expanded code, and
offers no way to pass that step, so the input has to be cheap to expand.

The nesting cannot be flattened into one letrec-values. A non-recursive binding allocates its
variable when its initialiser returns, once for each return. A composable or re-entered
continuation captured in an initialiser returns again, and needs new variables for that
definition and every one after it. A letrec-values allocates them all once, so the second
return would overwrite the first one's variables and change what the program computes. Any
initialiser that calls an unknown procedure can do this, which is nearly all of them.

So the nesting stays, and is cut off: after every 16 definitions the rest of the body moves
into a procedure, which the code before it tail-calls in the place the rest of the body was.
The moved code is not inside those binding forms and carries none of their scopes, so nothing
nests deeper than 16 definitions and the cost of expanding a body is linear in its length. A
body of 16 or fewer definitions is written just as it was. The procedures sit in one
letrec-values around the body, and nothing else about the body changes: a variable is still
allocated where the expander put it, the call keeps the tail position and the continuation
marks of what it replaced, and every return of an initialiser runs the rest again with new
variables. An earlier part's variable is the same variable: code in a later part reaches it
through a case-lambda, built where the variable is in scope, that reads it or assigns it, so
assignments, use before definition and the debugger's own accessors are unchanged. Only
variables a later part uses are passed, and a variable's own part reads it directly. A later
part's reference to such a variable through #%variable-reference says it is not constant,
which is what any variable a stop can assign already says.

The worst case for this is a late expression using every earlier definition: each part then
receives every variable before it, which is quadratic in the number of definitions with a
small constant, since parts are only argument lists, not nested scopes.

The program's own expansion to a syntax object has a quadratic term the instrumenter cannot
touch: at 2800 definitions, plain `expand` takes most of the load time and most of the peak
memory. Compiling the same module without asking for its expansion does not pay it.

Compiled instrumented code is an ordinary module apart from three things. It imports
runtime.rkt and worker/expand.rkt by absolute path, so the cache key includes
their location. Its identifiers must not carry the loader's scope, whose imports do
not exist in the program's namespace: the loader's rewrites take their context from
the source form. Its descriptors have #f for the expression: only tests read that
field, it grows with size times depth, and it can hold values that cannot be saved.

## Embedding host contract

Load `worker/attach.rkt` under an inspector superior to the inspector used
to declare program structures. Check `attach-api-version` (currently `1`)
before using the API. The library attaches its instrumentation modules to
each program namespace; hosts may create fresh namespaces.

- `(start-attach #:exclude excluded? #:on-pause on-pause #:thread-name name)`
  creates an attachment. The predicate receives source paths and wins over
  all module selection. The callback receives the program thread when a
  Racket Pause belongs to host code outside an attached call.
- `(attachment-listen! a)` returns a loopback port and a fresh secret token.
  Call again after a connection ends to accept a new session.
- `(attachment-ready-evt a)` becomes ready after `configurationDone`;
  `(attachment-ended-evt a)` becomes ready when that connection ends.
- `(call-with-attached-program a thunk)` marks the program thread and installs
  load handlers there. Other host threads do not deliver source stops.
- `(call-with-attached-code a thunk #:step-in? step-in?)` establishes a call
  boundary and returns three values: the thunk's results as a list, a pending
  step flag, and whether instrumented code ran. Exceptions propagate after
  the debugger's exception stop. An unused entry remains a pending step.
- `(attachment-pause! a thread)` forwards a host Pause inside an attached call.
- `(close-attachment! a)` releases held stops and closes the connection,
  without killing host threads or acquiring a program lock. Call it after
  killing the program thread as well as on ordinary shutdown.

The host must hold no lock in its program thread that another host thread
needs while stopped. Protect unavoidable lock regions with the exported
`debugger-active-key` from `instrumentation/runtime.rkt`; Pause defers
suspension there. Keep protocol output on a separate service thread.
Source roots and package selection come only from the authenticated client
configuration. A host does not set selection policy through `start-attach`.
The adapter proves the token with a version 1 hello before forwarding DAP
requests. Input and interrupt remain the host's responsibility; connection
closure releases the debugger without changing host lifetime.
