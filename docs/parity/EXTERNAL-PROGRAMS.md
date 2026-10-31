# External debugger comparisons

Compare the same unmodified application sources in the Racket IDE and the packaged
VS Code extension. Pin revisions and retain the source licences. Observe only
the public debugger UI and protocol; do not consult the reference tool's implementation
or tests when defining a missing feature. Write original regression programs.

The initial comparison used Racket 9.1 on Linux ARM64 and these revisions:

| Program | Revision | Scenario |
| --- | --- | --- |
| [Typed Racket examples](https://github.com/racket/typed-racket/blob/266429b235fbf624882456bfff55a5df761a301d/typed-racket-test/succeed/icfp-examples.rkt) | `266429b235fbf624882456bfff55a5df761a301d` | Break in `f`, inspect `x`, step through the predicate, return to its caller and finish. |
| [Asteroids](https://github.com/ericclack/racket-examples/blob/ee858daac3577ead0c8463b9701a8653220039de/asteroids1.rkt) | `ee858daac3577ead0c8463b9701a8653220039de` | Break in the first timer callback's `move-pos`, inspect position and speed, step over angle conversion, step out and stop. Fetch `util.rkt` from the same revision. |
| [Memory](https://github.com/racket/games/blob/eba5c6fa54c524871badb8b0e205fe37640d6c3e/memory/memory.rkt) | `eba5c6fa54c524871badb8b0e205fe37640d6c3e` | Invoke `game@`, click a card, break in `flip-and-match`, inspect enclosing unit state and step through the first predicate. |

For Asteroids, use a separate launcher to load the module and call its private
`go` procedure through the public `module->namespace` API, with `random-seed`
set to 4242. For Memory, require `memory.rkt` and use `(invoke-unit game@)`.
Open the same source and launcher files in both editors. Memory uses its own
clock seed, so compare state transitions rather than shuffled card identities.

Typed Racket produced the same values and final output. Asteroids produced the
same angle and updated position; the Racket IDE displayed an additional enclosing
expression frame. Memory exposed a missing capture of macro-renamed unit state
in Racketeer 0.8.7. The original regressions in
`tests/annotator-conformance.test.js` cover source names, unused state, shadowing,
live mutation, separate instances and an independently written renaming macro.

Memory also exposed repeated breakpoint hits on nested conditionals expanded
from one `cond`. The source expression now owns one stepping boundary across
those nested forms. Separate calls and duplicated expressions retain their own
breakpoint hits.

The fix uses the documented
[`disappeared-binding` property](https://docs.racket-lang.org/reference/stxprops.html)
and [identifier binding equality](https://docs.racket-lang.org/reference/stxcmp.html).
It does not infer source names from generated identifier spellings.

These are specific debugger scenarios, not complete tests of each application
or a claim of full IDE parity. Keyboard handlers, every game path, other Racket
versions and other operating systems need separate comparisons.
