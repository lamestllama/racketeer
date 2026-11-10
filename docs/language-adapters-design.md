<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Language adapters: design

This document describes the adapter interface and its implementation. The loader,
registry and debugger interaction services are implemented; the later
capabilities identified below remain specifications. The companion
[language author guide](language-adapters.md) defines the complete author-facing
contract, including provider records and a minimal language package.

One adapter, also called a profile, supplies optional facts and policy for a
language's debugger, language server with workspace index, and macro stepper.
Every field is optional. An empty `(profile)` uses generic hooks. A language
whose reader preserves locations and whose macros preserve binding metadata
can work without registering an adapter at all.

The implementation order is the shared foundation, including user-defined
binding forms in plain Racket and the author guide, followed by Rhombus debugging,
language server and workspace index. These are the first release's scope, with
Rhombus its only added adapter. F11, F12 and R7 are later macro-stepper work and
are excluded from that release's required foundation and acceptance set.
SRFI-105 with Scheme+ is the second built-in adapter. All five teaching levels have descriptors using shared providers with explicit level data.

## Evidence and architectural boundaries

Generic instrumentation handles the sampled Scheme+ forms, Typed Racket and
at-exp. SRFI-105 17.1 and Scheme+ 20.1 retain source locations through infix
conversion and annotation. Breakpoints, frame locations, locals and editor
navigation use those locations directly. Native interactions require the
reader's own hook in an isolated context before reading and evaluation.

Both servers support direct Rhombus bindings, but lack dotted components,
member completion and structured outlines. A Rhombus function can create two
identities at one written name, while the rename validator adjusts only one of
them. Retained scoped identifiers supply static dotted-component identities.
These are identity and source-mapping problems, not evidence for a second
analyser. Documentation packages were absent from that runtime, so missing documentation does not establish a tag-protocol defect.
Native Rhombus frame evaluation remains unverified.

The present code supplies the following reusable boundaries:

| Existing boundary | Proposed insertion; reason |
| --- | --- |
| [Runtime loader](../racketdap/worker/load.rkt), especially `execute` and runtime configuration | Resolve the module's adapter alongside its reader and expansion. Capture isolated interaction, complete print and error-display contexts after configuration. Preserve `configure-runtime` submodule before legacy language-info configuration. |
| [Instrumenter](../racketdap/instrumentation/instrument.rkt), `instrument-module` | Consume additional scoped binding/site facts at the existing alias and site-discovery points. Keep expanded core forms, live cells, continuations, exception marks and stepping tokens generic. |
| [Language policy](../vendor/collects/racket-langserver/doclib/doc-lang.rkt), `Language-Spec` and `Language-Policy` | Apply adapter policy over existing language defaults. Do not invent a second policy dispatch table. |
| [Expansion](../vendor/collects/racket-langserver/doclib/check-syntax.rkt), `expand-source` and `check-syntax` | Resolve source identity and compute binding augmentation in the expansion namespace. Feed existing declaration services in full and contribution-only analysis. |
| [Trace](../vendor/collects/racket-langserver/doclib/doc-trace.rkt), `build-trace%` | Keep `declaration%` as the binding graph; carry additional facts through its existing lifecycle. Other services consume the same accepted facts. |
| [Workspace analysis](../vscode/workspace-analysis.rkt), `analyse` | Continue calling `doc-expand!` with contribution-only analysis. The index receives the corrected graph and existing contributions. |
| [Macro expansion](../racketdap/tools/macro-steps/expansion.rkt), `expansion-steps` | Keep `trace*`, `reductions+`, checkpoints and cached derivations. Add adapter hiding and term layout at their existing boundaries. |

The common loader is `racketdap/language-adapters.rkt`, with a built-in data
registry beside it and language provider modules where necessary. It has no
editor or DAP dependency. The bundled server receives a resolver through a parameter installed
by Racketeer's existing server launchers; without that resolver it retains
generic behaviour. This avoids a vendored package importing a path inside the
extension. [Environment setup](../vscode/racket-environment.rkt) already prepares
the bundled analysis libraries, and [language server startup](../vscode/language-server.rkt)
already has a Racketeer entry point. Index workers and rename namespaces must
receive the same resolver, including fresh places/namespaces.

Separate schemas, analyser processes, indexes, binding grammars per macro name
and general type inference are unnecessary. Additional graph multiplicity is
necessary because one source spelling demonstrably has several identities.
Additional term layout is necessary because the current printer assumes Racket
notation. Everything else fits existing dispatch and lifecycle points.

## Adapter format and defaults

The following is the complete field inventory. Version 2 replaces the
unpublished debugger profile proposal; it is independent of macro-stepper wire
schema 2. Fields not listed here are errors. Repeated fields are errors.
`P` means a provider reference `#(module-path export-symbol data)`. A reference
contains data, never an expression to evaluate. All provider exports take
`(request data)`; the guide specifies their requests and results.

| Field | Accepted value and default | Meaning and consumers |
| --- | --- | --- |
| `version` | `1`; default `1` | Validate the common contract before any provider is called. |
| `match` | Zero or more `(language module-path)`, `(reader module-path)`, `(variants module-path ...)`; default the identity that supplied the profile | Alternative exact identities, with variants using the same profile. Debugger, editor and stepper resolve the same selection. No regular expressions or suffix guesses. |
| `bootstrap` | `auto` or `(auto P)`; default `auto` | Normal source reading and existing runtime configuration, optionally followed by a per-execution bootstrap provider supplying isolated interaction, printing and error-display services. Debugger only; editor and stepper never run runtime configuration. |
| `source` | `reader` or `(reader+ P)`; default `reader` | Retain ranges, origins and originalness from syntax. Optional explicit mapping adds trustworthy locations for all three tools. No guessed offsets or replacement semantics. |
| `bindings` | `expanded` or `(expanded+ P)`; default `expanded` | Generic core binders, origins, disappeared bindings and Check Syntax facts; optional written-component, family and runtime-identifier facts shared by all three tools. |
| `debugger` | Optional section; default empty | Omitted children inherit their defaults. |
| `debugger.expressions` | `(runtime-interaction identity)` or `(runtime-interaction P)`; default the former | Use configured `current-read-interaction` inside the isolated interaction context established before reading and evaluation; optionally lower syntax into one frame-evaluable expression. Used by watches, console, conditions, replacements, assignments and expression segments in logpoints. |
| `debugger.values` | `(runtime-print preview-fallback)` or `(P preview-fallback)`; default the former | Native notation for all textual value displays, including Variables previews, watch results and hovers, by default when the adapter supplies a printer. Keep output/time bounds and structural fallback on failure or exceeded bounds. Capture port print handlers and conversion parameters as well as `current-print`; native text need not be evaluable. Console retains its existing output route. |
| `debugger.steps` | `expanded` or `(expanded+ P)`; default `expanded` | Existing expression sites; optional statement ranges, housekeeping suppression and explicit result/replacement semantics. |
| `editor` | Optional section; default empty | Includes the workspace index wherever binding facts are involved. |
| `editor.body-mode` | `sexp`, `non-sexp`, `unknown`; default existing policy | Controls structural services, never changes the reader. Unknown languages keep the current `unknown` policy. |
| `editor.expand?` | Boolean; default existing policy, `#t` for unknown languages | Controls ordinary analysis. Disabling it cannot advertise binding or rename completeness. |
| `editor.require-header?` | Boolean; default existing policy, `#t` for unknown languages | Header diagnostics only. Missing/incomplete headers retain their current distinction. |
| `editor.source-details` | `auto`, `sexp`, `shrubbery`, `none`; default `auto` | Existing structural source-hover walkers; `auto` selects from policy and supplied declarations. The existing Rhombus walker becomes the `shrubbery` option. |
| `editor.declarations` | `generic` or `P`; default `generic` | Augment the existing structural outline with binding-backed declaration trees, signatures and declared annotations. Share kinds with semantic tokens and source hover. |
| `editor.calls` | `generic` or `P`, optionally followed by `(triggers string ...)`; default `generic` with existing triggers | Native callee/argument recognition and signature/documentation-tag lookup. Generic triggers are space, `)` and `]`. |
| `editor.completion` | `expanded` or `(expanded+ P)`, optionally followed by `(triggers string ...)`; default `expanded` with `(` | Ordinary identifiers/module paths plus optional contextual members and incomplete-syntax recovery. |
| `editor.rename` | `expanded-graph` or `(expanded-graph P)`; default `expanded-graph` | Native name validation, component/family selection and proven import/export edit plans. Before/after binding validation always remains generic and mandatory. |
| `editor.inlay-hints` | `policy` or a list of `P`; default `policy` | Existing hint sources, optionally extended by language producers of constructor labels or declared information. An empty list adds none; it does not remove existing policy hints. |
| `editor.formatting` | `policy` or `off`; default `policy` | Existing formatter eligibility and indentation hooks, or no document/range/on-type formatting. No new formatter protocol. |
| `macro-stepper` | Optional section; default empty | Shares identity, source and bindings, without debugger runtime bootstrap. |
| `macro-stepper.context` | `auto` or `module`; default `auto` | Existing whole-module trace and line anchoring. `auto` retains the Racket fragment fallback for headerless input; `module` refuses that fallback. |
| `macro-stepper.hide-modules` | List of `(module module-path)` or `(collection symbol)` selectors; default `()` | Additional resolved defining-module identities, including submodules, hidden by Standard policy. Explicit user hiding choices still win. |
| `macro-stepper.terms` | `syntax` or `P`; default `syntax` | Existing syntax-preserving Racket printer, or native layout with syntax occurrence mapping and per-term generic fallback. Separate from runtime value printing. |

There is deliberately no second `editor.names` provider: `bindings` supplies
source-name facts. There is no separate semantic-kind, type or documentation
provider: declarations supply known kinds/annotations, and calls can resolve a
documentation tag. These combine the evidence-backed extension points while
keeping the field set small. Sample expectations belong to the starter tool's
input, not the production adapter.

Existing defaults mean the policy obtained for that document before applying
adapter fields, including current Racket and Typed Racket hint sources. They do
not mean that every language is assigned Racket syntax. Extensions add facts;
they cannot contradict established identities silently. Conflicting facts mark
the affected binding unresolved and prohibit rename.

## Discovery, precedence and lifetime

Read the source language using Racket's reader protocols in the tool's existing
bounded worker. Query `racketeer:language-profile` on the reader's `get-info`
procedure with default `#f`. The answer is a profile datum or `P` whose `profile`
request returns one. Reader `get-info`, compiled module-language information
and configured runtime parameters are distinct protocols. A key named
`read-interaction` is not assumed to exist on `get-info`.

Selection is by the first available complete descriptor, in this order:

1. Explicit launch descriptor: proposed `languageAdapter` descriptor-file path,
   absent by default. Absolute paths are used directly; relative paths resolve
   against `cwd`, or the owning workspace folder when `cwd` is absent. The file
   contains one profile datum or provider reference, selected directly without
   requiring `match` or an available identity. A profile request receives
   `selection` as `#f` when identity is unavailable. This option applies only to
   the launch module; imports resolve independently. Invalid files stop launch.
2. Project override: proposed `.racketeer/language-adapters.rktd` in the owning
   workspace folder. Its value is a list of profiles or provider references;
   each resolves to a descriptor with an explicit `match`. `()` disables the
   override, not language support. At most one matching entry is allowed.
3. The source reader's `racketeer:language-profile` answer.
4. The same optional key on the legacy module-language info function, especially
   for compiled launches where reader information is unavailable.
5. Racketeer's small built-in registry, initially covering Rhombus variants and
   later the languages specified below.
6. An empty profile over existing generic policy.

The chosen descriptor replaces lower-priority descriptors; only its omitted
fields inherit generic defaults. This avoids mixing incompatible provider
versions. The starter can materialise the effective descriptor for a project
override. File module paths in descriptors resolve relative to the containing
data file, or the supplying reader/info module for inline data. Collection
module paths use the selected Racket installation. Built-ins use runtime paths
inside the packaged extension, with no new global collection registration.

An absent key permits fallback. Invalid data, duplicate matches, unavailable
explicit providers or unsupported versions produce a diagnostic identifying
the source and field; they do not quietly select another adapter. Independent
generic read-only services can continue with the failed capability marked
unavailable. Rename refuses incomplete identity facts. Missing optional native
term layout falls back explicitly to `syntax`; an invalid source map cannot be
used for navigation or debugging. Runtime bootstrap failure stops launch.

Preserve reader wrappers as an ordered identity chain. Ask the outer reader
first; use an inner identity only when the wrapper delegates its info query or
is already known to pass through that policy. An at-exp readtable must survive
selection of the underlying language. `rhombus/and_meta` is an explicit variant,
not a text-prefix heuristic. A required library such as Scheme+ is a dependency,
not a new `#lang` identity. Arbitrary custom reader payloads are not split by
whitespace to guess a module. Compiled modules lacking identity require a saved
cache identity or the explicit `languageAdapter` launch option; report unknown
identity rather than guessing from bytecode or filename. The guide supplies
the [launch configuration example](language-adapters.md#write-and-register-a-profile).

Resolve per module, including selected imports and submodules. A written child
uses its own language, resolved against its owning module's full identity; a
submodule generated by a macro uses its enclosing module's adapter even if it
declares a different language. Debugger hooks belong to the selected frame's
module; only the launched module configures the global console context. Do not
configure imported modules globally. Capture a separate interaction/print/error
context for each module that needs one, in a fresh
namespace, without instantiating its ordinary runtime body. Language-specific
bootstrap supplies explicit dialect state where a reader uses mutable state.
Editor and stepper providers must work without that runtime context.

All tools use the same resolver algorithm and descriptor fingerprint. Extend
existing source/dependency/cache bases with descriptor contents, provider and
reader dependencies, resolved identities, override contents and schema version.
Record provider loads through the existing source-snapshot observer; external
reads use its existing registration rules. Provider edits invalidate live
analysis, index contributions, compiled debugger cache entries and stepper
recordings. A retained derivation can be re-rendered only while its adapter
fingerprint is unchanged. No global cache retains syntax across namespaces.
Transport only declarative records and existing module identities across
workers; scoped syntax stays in the namespace that established it.

Project code and providers execute under the same workspace trust, cancellation
and resource boundaries as existing analysis. Descriptor reading disables reader,
language and compiled directives. Loading a descriptor does not run the target's
runtime body. Provider output goes to diagnostic channels, never protocol stdout.

## User-defined forms and binding identity

Support for macros that define or bind names is foundation work for every
language, including `racket/base`. Adding known head spellings to a table cannot
solve this: macros can introduce names, erase surface binders, generate helpers,
bind in several spaces or share a written range. The generic contract is scoped
identifiers plus actual core binder/occurrence relations, with Check Syntax
metadata for disappeared source forms. If expansion erases all evidence of a
source name, its macro must retain metadata; an adapter cannot reconstruct intent.

The exact paths and required changes are as follows:

| Path today | Identity retained or lost | Surgical change |
| --- | --- | --- |
| `expand-source` in [check-syntax.rkt](../vendor/collects/racket-langserver/doclib/check-syntax.rkt) → `make-traversal`, `add-syntax`, `done` | Scoped expanded syntax and Check Syntax arrows survive, including macro bindings supplied by the language. Missing source ranges/originalness can prevent callbacks. | Preserve this traversal. Collect generic core-binder anchors and adapter facts in the same namespace before discarding expansion. Consume standard `origin`, `disappeared-binding`, `disappeared-use` and `original-for-check-syntax` metadata without treating every property as a confirmed binding. |
| `get-or-create-def`, `alloc-use`, `attach-module-binding!` in [declaration.rkt](../vendor/collects/racket-langserver/doclib/service/declaration.rkt) | Definitions are keyed only by source range. `attach-module-binding!` removes the previous reverse identity. `alloc-use` replaces the range's use entry. Lexical arrows ignore `actual?` and use range owners, without preserving phase distinctions. | Keep range lookup but let each occurrence carry identity/phase/space/role/certainty edges. Keep all module identities at a range and all their reverse joins. De-duplicate repeated callbacks by identity, not range alone. Resolve unambiguous source identities or explicit families; never merge unrelated bindings because their ranges coincide. |
| Pending module-language arrows and `syncheck:unused-binder` in that service | Language fallback uses are intentionally local; unused binders enter without arrows. | Preserve both behaviours. Additional facts must not turn leftover language uses into cross-file definitions or lose unused binders. Confirmed edges supersede only predictions of the same identity and phase. |
| `module-binding-at`, `module-binding-uses`, `module-binding-definitions` → `build-trace%.get-contribution` in [doc-trace.rkt](../vendor/collects/racket-langserver/doclib/doc-trace.rkt) | Existing `Module-Binding` includes path, submodules, phase/space and ID. Contribution hashes can store several keys pointing to one location, but the graph currently supplies only the last identity. | Enumerate all confirmed identities in contributions. Retain singular queries for unambiguous cases; add a plural internal query for family-aware consumers. Do not change a binding key to its printed name. |
| `walk`, `visible?` in [autocomplete/user-defined.rkt](../vendor/collects/racket-langserver/doclib/autocomplete/user-defined.rkt) → [completion service](../vendor/collects/racket-langserver/doclib/service/completion.rkt) | Core binders and `disappeared-binding` are visited, but names become bare symbols; any macro scope makes a binder invisible. Lists are not scoped to the cursor. | Derive source-facing candidates from accepted binder facts and lexical visibility, then convert to labels only at LSP output. Retain the generic export/module-path fallback. A macro scope alone must not hide an authored binder or expose a helper. |
| `doc-symbols-hierarchical`, `*definition-form-kinds*` in [doc.rkt](../vendor/collects/racket-langserver/doclib/doc.rkt) | Outline recognises a fixed set of surface heads; a user-defined definition macro is invisible. | Supplement structural outlines with confirmed declarations from generic binder/origin facts. Anchor full extent in the pre-expansion enclosing form. Unknown callable kind stays variable/unknown. Provider declarations supply richer kinds/nesting; keep lexical recovery for incomplete buffers. |
| `walk-expanded-stx`, `tag-of-atom-stx` in [highlight.rkt](../vendor/collects/racket-langserver/doclib/service/highlight.rkt) | Function heuristics match surface spellings of expanded forms and require original syntax. Generated, remapped source names can lose their category. | Classify confirmed declaration/occurrence facts using actual core-form identity, with existing lexical colour as fallback. Never mark a textual lookalike as a function merely because its head spells `lambda`. |
| Source hover in [hover/service.rkt](../vendor/collects/racket-langserver/doclib/service/hover/service.rkt) and [hover/detail.rkt](../vendor/collects/racket-langserver/doclib/service/hover/detail.rkt) | Source extent already uses structure rather than a macro-head table. Predicted bindings are already separate by identity and phase. | Reuse those walkers and prediction rules. Add declaration extent/kind/annotation facts; do not rebuild binding discovery in hover. |
| `analyse` in [workspace-analysis.rkt](../vscode/workspace-analysis.rkt) → `doc-expand!` → `get-contribution` → `contribution->datum` | The index preserves supplied `Module-Binding` keys and adds unopened files. Contribution-only mode runs only the declaration service, so facts added just to completion/highlighting disappear. | Compute binding augmentation in the declaration path in both modes. Existing serialisation/store/query joins remain; extend their dependency basis for adapter invalidation. Test before/after contributions for identity equality. |
| [workspace-index.rkt](../vscode/workspace-index.rkt), `operations` and `serve` | Routes references and prepare/rename to workspace analysis; has no language semantics. | Keep protocol, snapshots, cancellation and stale-result rejection. Pass adapter configuration/fingerprint with the existing analysis basis. No language-specific branch here. |
| `analyse`, `expansion-bindings`, `source-bindings-at`, `source-binding-at` in [workspace-rename.rkt](../vscode/workspace-rename.rkt) | Raw expansion preserves sets of module bindings, but accepts a source identifier only if its exact printed spelling matches the source substring. Generated component identities can be dropped; multi-binding origin requests are refused. | Retain identifiers and binder anchors from the same shared facts. Replace the spelling gate only where a confirmed component-to-identifier mapping exists. Select a canonical identity/family explicitly; ambiguous requests still refuse. Include lexical anchors, unused binders, phases and spaces. |
| `identifier-name`, `standard-imports`, `import-plan`, `selector-status`, `imported-range` in that file | Single-token and import-edit rules are intentionally Racket-specific and conservative. | Keep proven Racket import handling. Ask adapter rename rules for native tokens, operators and supported component/import/export edits. Family metadata must prove which selectors refer to which exported identities; suffix matching cannot establish membership. |
| `bindings` and final before/after comparison in that file | Only the selected `Module-Binding` ID is changed to the new spelling. A generated helper's new identity then looks like accidental capture. | Compare occurrence-to-binder relations using a checked identity bijection, described below. Preserve all capture, alias and snapshot checks. |
| `doc-rename` and `doc-prepare-rename` in [doc.rkt](../vendor/collects/racket-langserver/doclib/doc.rkt) | Direct document rename replaces local ranges without validating new tokens or capture. Untitled documents use this route. | Reuse a small extracted proposal validator from workspace rename for document-local snapshots, including virtual URIs. Keep file routing and external-definition restrictions. Unsafe or incomplete families must not return partial edits on this route. |

### Identity comparison for rename

Retain core-binder anchors during analysis: source declaration/expansion origin,
submodule path, phase/space, core binder role and a stable structural position
within that declaration. A generated family can have several different anchors
at one written range. Anchors are correspondence evidence, not binding equality.
Binding equality within an expansion still uses scoped identifiers; cross-file
joins still use `Module-Binding`.

Construct edits from confirmed component facts. Re-expand the immutable proposed
snapshot. Translate source anchors through the edit map and establish a bijection
between before and after binders. Check binder role, module/submodule, phase and
space, family cardinality and structural context. Provider family keys may
disambiguate anchors when generic structure is insufficient. Numeric generated
suffixes and printed helper names are never a correspondence rule.

Then compare every authored occurrence, including unchanged uses and unused
binders, through that bijection. Unresolved names must remain unresolved. All
unaffected external identities must remain equal. Local shadowing and alias
ownership must remain equal. Edited names must resolve to the mapped target;
unrelated names at the same range must retain their own relationships. Missing,
new or ambiguous correspondences refuse the edit. Expansion changes outside
this proven correspondence also refuse. Thus a helper changing from `square.1`
to `renamed_square.1` is acceptable only when its binder and uses correspond;
ignoring every non-target identity is never acceptable.

This extends existing `Source`/`expansion-bindings` and final comparison rather
than building a second rename engine. Local validation uses the same helper
with one source descriptor; saved-file workspace rename retains the current
immutable source loader, worker deadlines and exclusions. References may return
known facts for incomplete static knowledge, but rename requires proven complete
coverage for the selected editable family.

Reuse `core-form` and `code-parts` from workspace rename for the phase-aware
core walk, factoring only those helpers into an internal analysis utility.
The existing pre-expansion structural walker is not a replacement for this
binding-aware walk: quoted data and renamed core forms must retain the current
rename regressions. Debugger instrumentation consumes the resulting facts at
its existing alias hooks; it keeps its runtime-specific traversal.

Cross-file queries also need to preserve multiplicity after graph construction.
Extend the existing `Document-Reference-Result` in
[internal-types.rkt](../vendor/collects/racket-langserver/doclib/internal-types.rkt)
to carry the confirmed lookup-key list for a selected coherent family, retaining
the singular fast path for ordinary bindings. `doc-references` must populate it.
Then [reference-locations](../vendor/collects/racket-langserver/lsp/compose/references.rkt)
queries the existing workspace store once per key and de-duplicates identical
source locations introduced by that union. It must retain the existing rule
that current-document results replace its older contributed locations. Do not
union unrelated identities merely because they occupy the same range.

`analyse` and `workspace-analysis-query` in `workspace-analysis.rkt` must
serialise/restore that key list rather than their present single `binding`
query result. `contribution->datum` already preserves distinct binding keys and
needs no new language grammar or alternate storage. This is an internal worker
record change; the LSP result remains a location list. For definition/source
hover, `doc-definition` selects a proven canonical identity and leaves ambiguous
requests unresolved, so existing
[definition-query](../vendor/collects/racket-langserver/lsp/compose/definition.rkt)
and [hover-query](../vendor/collects/racket-langserver/lsp/compose/hover.rkt)
can continue their bounded single-target lookup. The canonical identity is a
source-facing selection, not a replacement of every member's actual identity.

## Debugger integration

[session.rkt](../racketdap/worker/session.rkt) names a helper `read-interaction`
that currently calls the Racket-only `read-expression` in
[expressions.rkt](../racketdap/worker/expressions.rkt). Other assignment and
replacement paths call `read-expression` directly; logpoints have their own
brace parser. Route all of these through one adapter-aware expression service.
Keep hit-count grammar language-independent. Bind conditions lazily after the
breakpoint's module context is known, and cache by module/adapter identity.

The native reader consumes exactly one interaction followed by EOF, preserving
syntax context; an optional bridge lowers it for `stop-evaluate` without
discarding the selected frame's lexical identifiers. Reject empty or multiple
interactions. Do not instantiate target runtime bodies to obtain hooks. Preserve
existing restrictions on local transformers that frame evaluation cannot
reconstruct. Route reader chatter separately from returned values.

Interaction reading itself can change run-time state. In teaching languages,
the configured reader sets a REPL flag and subsequent evaluation resets the test
object: a suite with two registered checks can become a suite with zero checks.
Establish isolation before invoking the reader, and retain it through lowering
and evaluation. A lowering provider called after reading cannot repair this.
The shared service runs each request through bootstrap's
`call-with-interaction-context` wrapper, whose default uses the captured private
module context. Where native hooks share mutable state with the program, an
adapter must supply a safe wrapper or replacement hooks through
`(bootstrap (auto P))`; if it cannot, native interactions are unavailable.
Preserve test registrations, results and incidental run-time bookkeeping,
including on failed reads/evaluations, without bypassing native grammar. Explicit assignments still
obey the selected frame's language semantics.

For logpoints, retain the existing Racket template parser for compatibility and
add a language-independent explicit segment representation: strings and
`{"expression": "native text"}` records. The worker runs each expression segment
through the same service. Expose a small segment editor through the existing
breakpoint commands for native syntax. A DAP `logMessage` alone continues to use
the documented legacy grammar; native infix braces must not be guessed from it.

[inspect.rkt](../racketdap/worker/inspect.rkt) deliberately avoids custom printers
for structural previews. Keep that renderer as fallback and retain structural
variable children. Use the language's own notation for all textual value
displays, including Variables view previews, watch results and hovers. Native
text rendering is the default when the adapter supplies a printer, with no
opt-in setting. It runs under the execution context with the existing time and
output limits and a visibly identified structural fallback on failure or when
either limit is exceeded.
Capture the whole configured print context: `current-print`, global and
per-port print handlers, and conversion parameters. Teaching languages can
leave `current-print` unchanged while changing the other hooks. Apply this
context to the preview port as well as the value printer. Console printing
retains its stream/image handling. Printed text is a display, with no promise
that evaluating it reconstructs the value: for example, a printed closure
`(lambda (a1) ...)` does not reconstruct its captured state.
Rendering must never silently evaluate a receiver or mutate a value to discover
its members. Printer side effects during previews are accepted. For previews,
invoke custom printers only on request, never while constructing instrumentation
or evaluating breakpoint location data.

The worker currently sends raw `exn-message`, while a language's configured
`error-display-handler` can rewrite that text. Use one shared configured error
service, captured with bootstrap, for debugger exception and evaluation error
text. Its default invokes the captured handler in that module's configured
context with the message and exception, redirecting `current-error-port` to a
bounded private port; bootstrap can replace `error-display`. On failure or exceeded output/time limits, return raw
`exn-message`. Keep exception objects and source locations separate from display
text. Teaching display rewrites the raw contract-violation wording: for example,
`posn-x: expects a posn, given 7`.

Binding providers add actual live runtime identifiers, scope and mutability at
the existing alias-discovery point. A name erased from storage cannot be made
inspectable by metadata alone; the language must retain that storage. Site facts
may refine authored statement boundaries and suppress housekeeping while
retaining the underlying hidden frames/exception data. A displayed statement
must explicitly identify its result expression before return-value replacement
is enabled. Imported-module selection remains the existing loader policy.

## Macro stepper integration

### Trace and source selection

[macroTarget](../vscode/macro-steps/target.js) currently accepts only the
`racket` language ID. Extend this existing gate to supported Racket-backed
documents when macro support is enabled; Rhombus support is later work. Language
selection comes from the source header. VS Code grammar/language-ID registration is a separate
extension facility, not an adapter field. The index continues using installed
module-suffix metadata for disk discovery.

The [session](../vscode/macro-steps/session.js) already traces the captured whole
module and anchors navigation to a selected line. Preserve this for native
languages, including multi-line groups, imports, syntax spaces and local macros.
Use the entire selected range when locating intersecting source foci. With
`context module`, a missing/incomplete header produces the reader's diagnostic;
do not expand the line as Racket. `auto` retains the current headerless Racket
fragment mode. [macro-source.rkt](../racketdap/tools/macro-source.rkt) continues
reading captured text and counting its actual prefix. Neither runtime bootstrap
nor module runtime instantiation belongs in macro expansion.

Read-time transformations have already happened when `trace*` starts. Adapters
cannot invent expansion events for reader rewrites. All recorded events remain
actual macro reductions over syntax objects, with existing phase, scope,
taint, binding-edge certainty and checkpoint semantics.

### Surface notation and expanded forms

Without a term provider, show syntax using the existing
[printing.rkt](../racketdap/tools/macro-steps/printing.rkt), retaining brackets,
eligible quote abbreviations, scope groups and suffixes. It therefore shows
the representation returned by the reader and later expanded Racket forms.

A native term provider prints reader-level or intermediate language syntax
where it can map displayed occurrences back to the exact retained syntax
objects. Panes mix the language's own notation for those terms with expanded
Racket forms elsewhere. Rhombus uses shrubbery/Rhombus notation for mapped terms
and Racket notation for core expansions, labelled with the chosen notation per
section. No reverse expansion or pretty reconstruction of a lost source form.
Every position remains inspectable even when its notation changes. The final
expanded program is ordinarily Racket core syntax.

Extend `layout` with an optional layout delegate and keep the current renderer
as fallback. A native layout must report repeated occurrences, parents, source
objects, name-only and suffix-inclusive ranges, delimiter ranges, focus and
scope/taint information. The generic section builder still computes bindings
and phases; a printer cannot assert definite edges. The guide defines the
layout record. Use the existing byte/character-to-UTF-16 conversion path once;
source coordinates and display ranges remain distinct.

The installed shrubbery printer source supplies `#:register-stx-range` and
`#:render-stx-hook` hooks. These justify adapting that printer rather than
inventing a parser/printer. Its raw output path can subsequently strip
indentation and truncate text; those transforms would invalidate earlier
ranges. Disable them, or recompute ranges through an explicit edit map. Its
datum-writing fallback alone supplies insufficient occurrence data. Use the
generic printer for any subtree whose native output cannot retain identity,
including generated terms without suitable raw properties. Test suffixes,
taint and mixed native/core terms before enabling that path.

### Hiding and navigation

Extend [prepare-hiding-policy](../racketdap/tools/macro-steps/policy.rkt)
for adapter hiding. Rhombus additionally requires explicit event recording and
reduction integration as described below. Standard policy also hides
adapter-selected language implementation macros by resolved defining module/collection and phase,
including submodules. A collection can span packages: resolve actual defining
paths rather than assuming one `collection-path` directory covers it.
Racket, library, contract and phase policies remain. A user macro with the same
spelling is not hidden by a language rule. Source-file macros remain visible
unless explicitly hidden. Explicit Show/Hide identifier rules take priority.

For adapters with non-empty `hide-modules`, a fresh view starts with Standard
unless a user hiding preference exists. The current generic fresh-view default
is Disable; keep it for empty hide lists. Saved Disable always reveals all
language macros. Custom gains a Language switch only for such adapters, with
missing stored values interpreted as enabled. Line mode may reveal language
macros explicitly written in the requested range, retaining the existing
line-reveal purpose. Hiding changes reuse the captured derivation and preserve
navigation by expansion point as they do now.

Keep [schema 2](macro-stepper-schema.md) and its lazy inspection. Add optional
section notation and adapter fingerprint metadata through the existing codec
validators. [source.js](../vscode/macro-steps/source.js) retains snapshot checks;
source links use captured syntax locations or explicit maps, never printed
offsets. Missing locations remain unavailable; edits mark the recording stale.
No parallel native-language stepper UI is needed.

## Rhombus adapter

The supported release is Rhombus 1.1.0.1. The runtime lock pins its packages to
commit
`796055f913730b241f30af4ab739b8bbf8f072f1`.

Use one CI language-package lock file and provisioning routine for Rhombus and
SRFI-105/Scheme+ tests. Record exact package versions, source revisions,
archive checksums and dependency pins, and provision isolated Racket installations
on CI runners from that lock. Include Rhombus documentation in provisioning.
Install SRFI-105-for-Racket and Scheme-PLUS-for-Racket only on CI runners for
testing; neither package nor its LGPL code is shipped with Racketeer. The
adapter uses the published package in the user's selected Racket installation.

This is the proposed first-release descriptor, stored in the built-in registry. File
references below resolve against the proposed registry beside the common
loader. The provider exports do not yet exist:

```racket
(profile
 (version 1)
 (match (language rhombus) (variants rhombus/and_meta))
 (bootstrap auto)
 (source reader)
 (bindings (expanded+ #((file "adapters/rhombus.rkt") bindings #f)))
 (debugger
  (expressions (runtime-interaction identity))
  (values (runtime-print preview-fallback))
  (steps expanded))
 (editor
  (body-mode non-sexp)
  (expand? #t)
  (require-header? #t)
  (source-details shrubbery)
  (declarations #((file "adapters/rhombus.rkt") declarations #f))
  (calls #((file "adapters/rhombus.rkt") calls #f)
         (triggers "(" ","))
  (completion (expanded+ #((file "adapters/rhombus.rkt") completion #f))
              (triggers "."))
  (rename (expanded-graph #((file "adapters/rhombus.rkt") rename #f)))
  (inlay-hints (#((file "adapters/rhombus.rkt") hints #f)))
  (formatting off)))
```

| Export | Required behaviour and boundary |
| --- | --- |
| `bindings` | Associate each written root/member/operator range with actual scoped identifiers and canonical declaration identity. Consume name-root/dot-provider/static receiver information and retained origins. Keep annotation/binding spaces, helpers and exported identities distinct; explicitly describe coherent families. Supply runtime bindings, including unused authored locals, when storage survives. Unknown dynamic receivers stay unresolved. |
| `declarations` | Use shrubbery groups/blocks and the existing range aggregation for ordinary `def`, `fun`, class, field, method, namespace, operator and macro declarations. Return nesting, selection/full ranges, kinds, parameters/results and declared annotations. Supplement macro-defined declarations with shared binding metadata rather than a closed head-name grammar. |
| `calls` | Recognise direct and dotted native calls, active argument/parameter, overloads and keyword arguments from syntax/static facts. Reuse source signatures and installed documentation tags. No evaluation to infer types or discover methods. |
| `completion` | Enumerate namespace/import exports and statically known receiver members. Recover trailing `List.`, `Tools.`, `model.` and annotated `obj.` in a fresh incomplete buffer. Keep root/member replacement ranges separate; ordinary identifier completion remains the fallback. |
| `rename` | Validate native identifiers, operators, keywords and the relevant spaces. Select coherent families and component edits, and prove supported imports, exports and aliases. Unknown dynamic members or incomplete family coverage refuse. Never use generated-name suffix replacement to validate identity. |
| `hints` | Constructor field labels and declared annotation/static information, through the existing hint-source mechanism. No new inference engine. |
| `terms` (later work) | Native shrubbery layout for identity-preserving terms; syntax printer fallback for expanded core forms or unmappable terms. Integrate the existing partition/suffix/taint behaviour. |

For R1, namespace and import members retain a non-original expanded identifier
with the real binding and a range spanning the whole written path. Identifiers
in its `origin` metadata retain each prefix and its span. Match each part to the
corresponding component of that written text, retaining its actual scoped
identifier; spelling alone does not establish identity. Static members and
generated method names already sit exactly on the member text: for example,
`Point.x` and `norm2`, respectively. Dynamic receivers carry no member binding
and link to nothing; literal receivers yield no member identifier. No Rhombus change is needed for
this binding bridge.

These exports share facts cached only within the current snapshot/namespace.
They do not each expand or parse the file again. The common binding producer
must be usable by debugger instrumentation, full editor analysis and
contribution-only index/rename analysis; service-specific producers are lazy.

The four established editor failures have concrete acceptance criteria:

| Failure | Required result |
| --- | --- |
| Simple function rename refused | Rename from declaration, direct call and importing file succeeds, including generated helpers under the checked bijection; deliberate capture still refuses. Exported constants receive separate coverage. |
| Missing dotted identities | `model.square`, `Tools.scale`, static `List.map`, fields and methods have component-sized definition/reference facts shared by both servers. Calls, declarations and exports join correctly. Unsupported dynamic members remain explicit limitations, and cannot produce partial rename. |
| No member completion | A fresh buffer ending in a dot receives static members with correct replacement ranges, without depending on a previous successful expansion. |
| Empty outline | Both hierarchical and flat clients receive the same declaration tree, flattened only at transport. User-defined binding macros appear through metadata. |

Add the optional completion branch in `doc-completion`; add declaration dispatch
before the non-sexp early return in `doc-symbols-hierarchical`; flatten that tree
in [text-document.rkt](../vendor/collects/racket-langserver/lsp/text-document.rkt).
Native call dispatch precedes list-head lookup in `doc-signature-help`.
Advertise the union of generic and adapter triggers at
[methods.rkt](../vendor/collects/racket-langserver/lsp/methods.rkt) initialisation
and register additional triggers when an adapter appears later. Per-document
dispatch ignores irrelevant triggers. Formatting stays off through policy and
the existing [client veto](../vscode/language-client.js).

Debugger expressions initially inherit configured runtime reading. This is a
testable default, not a claim that Rhombus interactions already work in a selected
frame. If native parsing produces module/interaction syntax unsuitable for
`stop-evaluate`, implement a `lower-expression` export and change only
`debugger.expressions`. Test native local lookup and assignment, shadowing,
mutable/unused locals, return values, errors and imported modules. Add a site
provider only if those tests establish authored statement-boundary failures.

Install Rhombus documentation in the validation runtime before deciding that a
documentation-tag translation is needed. Declared annotations can appear on
hover; inferred types require an actual producer and are outside this adapter.
The first release built on adapters requires Rhombus debugging, language server
and workspace index, with their required shared foundation. It ships without
Rhombus macro stepping; F11, F12 and R7 remain later work.

Individual user macro steps require a Rhombus change. In `expr-macro.rkt`, about
30 lines around the user procedure call can capture its actual input, returned
syntax and unconsumed tail before result enforestation, emitting
`local-artificial-step` through `emit-local-step`. Rhombus 1.1.0.1 has no supported
adapter-only hook for that boundary. Language hiding alone erases user
transformations inside parser reductions, even when these events are emitted.
A native printer cannot recover absent events.

Later F11/R7 work must retain explicit event provenance and reduce those exact
event-derived nodes as independent local histories, with phase-aware
binding-identity Show/Hide rules applied independently of language hiding.
Preserve expansion order, enclosing phase/context, suffixes, error behaviour and
final expanded-program relocation maps. Local snapshots are not a continuous
whole-module rewrite sequence; nested execution needs invocation/parent records.
Gate support on a Rhombus version/capability providing these events and validate
the released demodulated build and macro protocols before enabling it. Later F12
must validate raw shrubbery text against retained structure or use core fallback:
raw text can still spell `twice(7)` after the syntax represents `(7 + 7)`.
Source links and arrows continue to use retained syntax and binding facts.
The later descriptor adds module context, hiding selectors for resolved Rhombus,
shrubbery and enforest defining modules/submodules, and the `terms` provider.

## SRFI-105 and Scheme+

The tested versions are SRFI-105-for-Racket 17.1 and Scheme-PLUS-for-Racket
20.1. The public entry point is `#lang reader SRFI-105`, followed by a module
using `(require Scheme+)` for Scheme+ forms. SRFI-105 alone also supports curly
infix. Scheme+ used with Racket's ordinary reader retains generic support.

The built-in registry matches the exact `SRFI-105` reader identity. Source,
bindings, runtime sites, printing and editor services use existing defaults.
The packages supply the locations through infix conversion and `ANNOTATION-ON`.
The extension contains the descriptor and an interaction provider; both packages
come from the user's selected Racket installation.

The descriptor selects `(bootstrap (auto P))`. The debugger invokes that
provider after ordinary runtime configuration. The provider reads the captured
source in a fresh namespace before each interaction and uses the reader's own
`current-read-interaction` hook. Its parser state is private to that interaction;
watch pragmas do not affect the programme or subsequent watches. Evaluation
still uses the selected frame's live bindings. No package is required when the
provider module itself is loaded.

Interactions use the source module's final reader state. Selecting a frame does
not select an earlier pragma region. Source is required to initialise that state.
Neoteric calls follow SRFI-105 syntax inside braces, such as `{add1(x)}`.
Reader output during initialisation is suppressed; interaction output follows
the debugger's existing bounded output handling.

The [feature suite](../tests/schemeplus-adapter.rkt) is enabled with
`RACKETDAP_TEST_SCHEMEPLUS=1` and the installed packages. It exercises infix and
neoteric expressions, a nested block, a loop, definitions, annotations, exact
breakpoint/frame/error locations, In/Over/Out, locals, native interactions and
full/contribution-only editor analysis. Native interaction cases include an
explicit empty-profile control. A constant definition can relocate its line
breakpoint to the next executable expression. Generic outlines omit the local
`:=` declaration and include the loop as an object. Contribution-only analysis
retains navigation and outlines but omits hover, diagnostics and semantic tokens.
Macro stepping keeps its existing behaviour; the sampled programme has no
visible reductions under Standard hiding.

## Teaching-language outlines

Each teaching level has a built-in descriptor using shared providers with
explicit level data. The levels are enabled in acceptance order:

| Level | Reader identity | Module identity | State |
| --- | --- | --- | --- |
| BSL | `htdp/bsl/lang/reader` | `lang/htdp-beginner` | Enabled |
| ISL+ | `htdp/isl+/lang/reader` | `lang/htdp-intermediate-lambda` | Enabled |
| ASL | `htdp/asl/lang/reader` | `lang/htdp-advanced` | Enabled |
| BSL+ | `htdp/bsl+/lang/reader` | `lang/htdp-beginner-abbr` | Enabled |
| ISL | `htdp/isl/lang/reader` | `lang/htdp-intermediate` | Enabled |

The baseline already supplies expansion, top-level outlines, module structure
hover and exact module field anchors on the language server, ordinary parameters,
restricted grammar and teaching tests. Without providers, workspace navigation
targets the whole structure declaration, including for local fields. Keep those generic services and `source reader`, with existing
sexp body, source and formatting policy. Structural debugger previews expose an
extra structure field and lack native constructors; unconfigured selector errors
have raw contract wording. The teaching bootstrap restores native printing and
errors and reads with installed reader options without the mutable REPL flag that resets
programme tests. Isolation starts before reading, including failing watch and
console expressions.

The shared `expanded+` provider consumes scoped component directives, first-order
transformer targets and returned-binder edges. Explicit provider names assert
scoped occurrences at their supplied ranges, even alongside another core binder.
Workspace analysis preserves those assertions while filtering stale generic
transformer contexts. Generic conflicts and before/after binding validation still
apply. A family connects generated procedures; it does not make separately
written components one declaration. Matching text cannot authorise an edit.
The native policy refuses when the scoped identity and family facts cannot
distinguish components with the same spelling, such as a structure type and field
both named `point`. Proven structure and field components retain exact edits at
every level; ambiguous requests refuse.

ISL+, ASL and ISL also support structures inside `local`. Their flattened
expansions lose component directives. The binding provider maps the written
structure grammar to retained scoped definitions at that declaration, keeping
outer and local owners distinct. The workspace binding service lets a confirmed
provider definition refine a containing generic anchor for the same scoped owner.
Equal-range owners, disjoint anchors and predicted facts retain their existing
meaning. Go to Definition, highlights and local references use this service;
exact local-field acceptance follows that route. A query at a shadowing local
type declaration can still include its outer declaration; the exact-field result
does not establish exact type-declaration navigation.

Local structure-field hover still uses the language server and can cover the
whole local declaration. This is a known gap until hover moves to the index and
is excluded from exact-field acceptance. Outlines, completion and signature help
also remain on the language server. Source signatures cover both
`(define (f x y) ...)` and `(define f (lambda (x y) ...))` at all five levels,
including nested `local` definitions at ISL, ISL+ and ASL. Computed function values
do not acquire inferred signatures. Retain those signatures, nested declarations,
function kinds, lexical scopes and phase-zero imported exports when the features
move.

| Part | BSL | ISL+ | ASL | BSL+ | ISL |
| --- | --- | --- | --- | --- | --- |
| Debugger | Restricted grammar, parameters and tests; nested `cons` previews. | Local functions, higher-order calls, anonymous functions and closures, including `shift`/`bump`. | Assignment, captured `state` and stateful closures through live cells. | BSL restrictions with native `list` notation and quasiquote. | Local functions and captured state, with anonymous functions still restricted. |
| Editor and index | Scoped structure and first-order families, exact anchors and proven component renames; ambiguous components refuse. | Nested `local` declarations/signatures/kinds, lexical completion and exact local structure anchors. | Mutable locals, reads and assignments retain scoped identities. | Shared structure and first-order bridges. | Shared redirected-local bridges and lexical completion. |

Original-name metadata identifies actual redirected storage, retaining live
getters and ASL setters. Metadata cannot recreate erased storage or grant forbidden assignment rights.
Native previews use the complete print context: structures use
`make-posn`/`make-point`, lists use nested `cons` in BSL and `list` at other levels.
Reader options and module procedure-printing flags both matter. Printed closures
do not promise evaluability. Keep configured error wording, ordinary Run/Debug
registrations, Test/Debug Test results, located failures and test-body breakpoints.
Compiled debugger replay uses the same native services; Test modes retain the
loader's source execution policy.

Declarations exclude spurious `cond` children and implementation helpers.
Completion respects current lexical scopes and retains unused phase-zero imported
exports without running dependency bodies. Workspace rename rejects reserved
names such as `if` and capture by a parameter such as `n`. Untitled buffers must
request saving before prepare or rename. These adapters have no macro-stepper
part; Standard hiding stays unchanged.

## Samples, generated tests and acceptance

Implement one starter command at `racketdap/tools/language-adapter.rkt`, proposed
with `discover`, `generate` and `verify` subcommands as specified in the guide.
It discovers resolved reader identities, available known hooks, source fidelity,
expanded binder facts and effective adapter selection in fresh namespaces.
There is no enumeration of all info keys, universal sample grammar or safe
inference of binding intent. Missing optional headless hooks are reported.

Authors supply representative sources and an expectation manifest containing
source markers, intended binding families, frame expressions/results, stepping
destinations, declaration trees, completion members and expansion expectations.
The generator writes runnable Racketeer test fixtures plus unresolved
expectations. Discovery never silently blesses its own observed result as the
expected answer. The guide's minimal manifest establishes the file/record syntax.
Extended expectations use the same provider record shapes for names,
declarations and members, plus explicit source markers for destinations.

| Suite | Required coverage |
| --- | --- |
| Loader | Empty profile; every omitted field; malformed/duplicate/unknown fields; precedence; info-provider failure; wrappers; variants; explicit projects; package/provider edits; mixed languages/submodules; source and compiled identity; no runtime instantiation during analysis. |
| Generic binding forms | Plain Racket macros forwarding a binder, introducing names with `format-id`, anaphoric names, local/unused/mutable binders, duplicated source ranges, helper families, several phases/spaces/submodules, disappeared bindings/uses and predicted template names. Definition/hover/references/completion/outline/tokens agree; helpers stay hidden. |
| Rename | Requests from declarations and uses; shorter/longer/Unicode names; safe family bijections; capture in either direction; unused binders; alias/prefix/export selectors; unrelated identities at one range; unresolved names; incomplete facts; document-local and workspace routes. Failures produce no partial edits. |
| Index and lifecycle | Full/contribution-only identity parity, unopened importers, modified dependency buffers, untitled local fallback, saved-file routing, provider dependencies, stale results, cancellation, resource failures and exclusion scope. Ready status does not assert complete language knowledge. |
| Debugger | Armed line/column breakpoints, In/Over/Out destinations and results, caller/error locations, shadowed/mutable/unused locals, selected-frame native expressions on every input route with isolation established before reading/evaluation and unchanged tests, zero/multiple results, native notation in Variables previews, watch results and hovers without opt-in, printer side effects and structural fallback on errors or output/time limits, imported modules, plain versus instrumented behaviour and compiled launches. |
| Macro stepper | Whole-file and line/selection module context; native/core mixed layout; source provenance; binding arrows, phases, scopes, suffixes, taint, repeated terms, Unicode/CRLF; Standard/Disable/Custom/line policies; same-spelling user macros; lazy inspection, checkpoints, stale recordings and worker replacement. |
| Rhombus | All four failure criteria above; direct/imported/namespace/static receiver components, functions/classes/fields/methods/operators/macros, spaces and aliases, fresh incomplete buffers, signatures/annotations/hints, installed documentation, native debugger bridge. Native/core macro layout and event histories are later F11/F12/R7 acceptance work. |
| Scheme+ and later languages | SRFI-105/Scheme+ source locations, native interactions and full/contribution-only document services. Teaching-language restrictions, binding bridges, local/captured Variables, native previews/errors, outline/scope fidelity, local-server rename safety and test-state isolation before interaction reading/evaluation at each level. |

Reuse [debugger language tests](../tests/parity-languages.rkt),
[workspace rename tests](../tests/workspace-rename.test.js),
[expansion-aware rename tests](../tests/workspace-rename-expansion.test.js),
[import selector tests](../tests/workspace-import-selectors.test.js),
[macro policy tests](../tests/macro-stepper-policy.rkt) and
[macro printing tests](../tests/macro-stepper-printing.rkt). Extend the existing
stdio LSP/DAP and editor-host harnesses for end-to-end behaviour. Run generated
language suites sequentially under the existing process and memory bounds;
correctness fixtures are small and deterministic. No new performance claims
are required for acceptance.

## Implementation sequence

F1–F10, R1–R6/R8 and the S and T rows form the first release's required set.
F11, F12 and R7 are later work, gated on Rhombus transformation events, and F13
is later work too. Each row is intended as one small commit with its own acceptance
test. Adjacent rows may require several similarly bounded commits when a provider is large.
Each commit must preserve the generic regression suites; none requires switching
off validation to make a later feature usable.

| Order | Change | Acceptance test |
| --- | --- | --- |
| F1 | Common data validator, defaults and provider calling convention. | Empty profile and every optional field load; malformed/duplicate/version cases fail with field diagnostics. |
| F2 | Reader/legacy discovery, built-in registry, project precedence and explicit `languageAdapter` selection through existing launchers. | All tools select the same descriptor; wrappers work; an identity-less compiled launch selects the explicit file without a saved cache, while omitting the option reports unknown identity; no runtime body runs during selection. |
| F2a | Apply `body-mode`, `expand?` and `require-header?` overrides to the existing `Language-Policy`, and `source-details` and `formatting` at the existing hover and formatting service boundaries. | Toggle each override and assert the resulting structural service behaviour, expansion, header diagnostics, source hover and document/range/on-type formatting edits; omitted fields preserve existing defaults. |
| F3 | Snapshot dependency observation and adapter fingerprints in existing cache bases. | Editing descriptor/provider/dependency invalidates editor, index, debugger cache and macro recording; stale results cannot publish. |
| F4 | Preserve multiple declaration and occurrence identities, phases and certainty in `declaration%`. | Callback-order permutations, shared ranges, unused binders and leftover language uses retain correct joins. |
| F5 | Generic binder/origin collection and optional shared `bindings` augmentation. | Plain Racket binding macros work in full and contribution-only analysis with identical exported identities; F4 multiplicity preserves `define-struct` and `struct` family structure hover, exact field definition anchors and local rename. |
| F5a | Family lookup keys through existing reference composition and index query records. | References from every family member include unopened-file uses and deduplicated declarations; unrelated shared-range bindings stay separate; `define-struct` and `struct` families retain structure hover, exact field definition anchors and local rename. |
| F6 | Completion, declaration outline and semantic kinds consume confirmed facts. | A custom Racket definition/binding macro appears in completion and outline; generated helpers and predictions do not become authored declarations; `define-struct` and `struct` families retain structure hover, exact field definition anchors and local rename after F4. |
| F7 | Rename binder anchors and checked before/after bijection. | Generic multi-binding macro rename succeeds from declaration/use; `define-struct` and `struct` families retain local rename, structure hover and exact field definition anchors after F4; unrelated shared-range identities and deliberate capture still refuse. |
| F8 | Reuse token/proposal validation for document-local rename. | Untitled/local macro rename validates names and rejects capture or incomplete families without edits. |
| F9 | Adapter-aware debugger expression service, including explicit logpoint segments. | Native expressions work on every input route in selected frames with isolation established before reading and retained through evaluation; watches/console leave a two-check teaching suite at two checks with unchanged failures and incidental run-time state, including on errors; legacy Racket templates retain results. |
| F10 | Default bounded native value rendering, shared configured error display and optional binding/site facts. | Capture the whole print context, including port print handlers and conversion parameters as well as `current-print`; Variables previews, watches and hovers use native notation without implying evaluability. Printer effects are accepted; errors and output/time limits fall back structurally. Configured error wording is used, with raw `exn-message` fallback on failure/limits; locations stay intact. Local functions/captured state, mutation, results and instrumented behaviour remain correct. |
| F11 (later) | Macro adapter discovery, context gate, language hiding and event recording/reduction integration. | Requires the Rhombus `expr-macro.rkt` user-procedure event capability; retain provenance, enclosing phase/context and event-derived local histories independently of language hiding. Generic module context, preferences and identity hiding pass. |
| F12 (later) | Optional term layout delegate and codec metadata. | Rhombus user-step layout requires F11 and its Rhombus event capability; validate raw text against structure or use core fallback. Generic output remains equivalent; native layout retains occurrence/source/UTF-16 invariants. |
| F13 (later) | Starter discovery, sample generation and guide examples. | Minimal package runs with generic defaults and generates tests from independently stated expectations; unresolved capabilities remain visible. |
| R1 | Rhombus descriptor, shared source components and family metadata. | Use whole-path bound non-original identifiers and prefix `origin` spans to map namespace/import components; static fields/generated methods use exact member spans. Both servers agree; dynamic receivers link to nothing, literal receivers yield no member identifier. No Rhombus change is needed. |
| R2 | Rhombus rename token/import/export policy on the generic validator. | Function/constant/family rename and supported aliases succeed; spaces/operators/capture regressions pass. |
| R3 | Rhombus declaration trees, source signatures, annotations and semantic kinds. | Hierarchical and flat outlines agree; source hover and signatures resolve direct/dotted declarations. |
| R4 | Rhombus incomplete member completion and capability triggers. | Fresh trailing-dot buffers return static members with correct replacement ranges. |
| R5 | Rhombus hints and installed documentation lookup. | Constructor labels/declared annotations and installed tags work; no fabricated inferred types. |
| R6 | Rhombus debugger conformance; expression bridge only if needed. | Native local expressions, values, bindings, stepping, errors and imports pass source/compiled tests. |
| R7 (later) | Rhombus user-transformation histories, native macro layout and implementation hiding. | Requires the Rhombus user-procedure `local-artificial-step` capability and F11/F12; separate event histories survive language hiding, preserve phase/context, expansion order, suffixes and errors, and show native syntax or core fallback with valid arrows/source links. No continuous whole-module sequence is promised. |
| R8 | Debugger, language-server/index regression, packaged paths and guide conformance. | F1–F10 and R1–R6 pass stdio/editor-host tests; both Rhombus variants work and all first-release promises have tests. First release gate: Rhombus debugging, language server and index, without Rhombus macro stepping; F11/F12/R7 remain later work. |
| S1 | SRFI-105 reader descriptor using generic source, binding and site services. | Scheme+ 20.1 and SRFI-105 17.1 retain exact source locations; absent packages leave other languages unchanged. |
| S2 | Isolated native interaction provider through the existing bootstrap field. | Infix and neoteric watches and console expressions work with selected locals; empty-profile controls fail those expressions. |
| S3 | Feature tests and document-service conformance. | In/Over/Out, locals, runtime errors, definitions, references, hover, outlines, tokens and diagnostics retain their observed full/contribution-only behaviour. |
| T1–T3 | BSL, ISL+ and ASL are implemented with shared providers and explicit level data. | Each level passes restrictions; scoped structure/function/redirect bridges; module structure hover and exact field anchors through workspace navigation, including local structures where allowed; nested outline/scope fidelity; Variables local functions/captured state; native previews using the complete print context and configured errors; and workspace reserved-name and capture rejection, with untitled buffers requesting a save. Before reading any watch/console expression, isolate reader/evaluation state and prove a two-check suite retains both checks and unchanged failures, including on errors, before the next level is enabled. |
| T4–T5 | BSL+ and ISL follow ASL using the same providers and explicit level data. | The same acceptance applies, with native list/quasiquote grammar for BSL+ and local functions without anonymous lambda in ISL. |

## Decisions

- Macro panes mix the language's syntax where the adapter can map it with
  expanded Racket forms elsewhere.
- Values use native notation everywhere, including Variables previews, watches
  and hovers. Native previews are the default when an adapter supplies a printer,
  without opt-in. Printer effects are accepted; existing output/time bounds and
  structural fallback on failure or exceeded bounds remain. Capture port print
  handlers and conversion parameters as well as `current-print`; display text
  carries no evaluability promise. Error text uses the shared configured display
  service, with raw exception-message fallback on failure or limits.
- Use `racketeer:language-profile` and `.racketeer/language-adapters.rktd`.
- Support Rhombus 1.1.0.1 for debugging, language server and workspace index.
- Pin SRFI-105-for-Racket 17.1 and Scheme-PLUS-for-Racket 20.1 for tests.
  Use their source locations and native interaction hook.
- Ship only the Scheme+ descriptor and provider. The language packages are
  installed separately and are not load-time dependencies of the provider.
- The first release adds Rhombus only: finish the shared foundation and complete
  Rhombus debugging, language server and index before release. F11, F12 and R7
  remain later work requiring the Rhombus user-procedure event capability; the
  first release ships without Rhombus macro stepping.
