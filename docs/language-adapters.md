<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Writing a language adapter

This guide specifies the language-adapter interface. Descriptor discovery,
editor policy, source-detail and formatting switches are supported, with adapter
dependencies included in cache validation. Rhombus has a built-in descriptor and
`bindings` provider. Scheme+/SRFI-105 has a reader descriptor and isolated
debugger interaction provider. Starter commands and the later capabilities
identified in the design remain specifications. The [maintainer design](language-adapters-design.md)
records implementation paths, acceptance tests and support order.

An adapter is one small profile shared by three Racketeer tools: the debugger,
the language server with its workspace index, and the macro stepper. Most fields
select existing hooks. Optional Racket procedures supply language knowledge that
expansion cannot supply alone. The same profile applies to a language's files
and imported modules; there is no separate index adapter.

The first release built on adapters adds Rhombus 1.1.0.1 debugging, language
server and workspace index. It requires their shared foundation and ships
without Rhombus macro stepping. F11, F12 and R7 in the maintainer design remain
later work requiring a Rhombus user-procedure transformation event capability.
The second adapter supports Scheme-PLUS-for-Racket 20.1 with
SRFI-105-for-Racket 17.1. It uses the packages' source locations and native
interaction reader. Racketeer ships only its descriptor and provider; users
install the language packages in their selected Racket installation.
The maintainer design records the [owner's decisions](language-adapters-design.md#decisions).

## When no adapter is needed

A language often needs no adapter when its reader preserves source locations,
its expansion retains scoped binding identities and Check Syntax metadata, and
its runtime configuration supplies usable interaction reading and printing.
Generic instrumentation follows expanded runtime forms. Generic editor services
follow actual bindings. Generic macro stepping traces expansion and prints
syntax in Racket notation.

The reader remains the authority on program meaning. A profile cannot infer
arbitrary dynamic members or restore a local variable that expansion removed
from runtime storage. Native notation, statement boundaries, source-name
mappings or special import rules can need providers. An empty profile is valid:

```racket
(profile)
```

No registration is necessary to obtain that generic behaviour. A successful
expansion alone does not establish complete language support. Test representative
source bindings, interactions and macro output before adding overrides.

## Establish a baseline

Prepare a small valid module, an importing module and a file containing a local
binding macro. Include source expressions, expected values and intended binding
relationships. Also include a deliberately incomplete call or member access.
The tests should distinguish source names from implementation helpers.

Use the proposed starter command from a Racketeer source checkout:

```sh
racket racketdap/tools/language-adapter.rkt discover --source /path/to/sample.rkt --output /tmp/adapter-start.rktd
```

`discover` reads the source in a fresh namespace, resolves its reader and
language identities, checks known info keys, captures configured runtime hooks
in a separate execution context, and examines locations and expanded bindings.
It writes a starter descriptor with diagnostics. It does not install packages,
edit the language, run the module's ordinary body or guess all possible binding
forms. Optional hooks that require a graphical display are reported unavailable.
There is no protocol for enumerating every reader info key.

The output separates observed facts from capabilities still requiring an
author's expectations. Keep defaults for facts already handled correctly.
Preserve reader/expander identity metadata where possible. A source provider can
supply explicit source evidence, but cannot invent missing binding identities.

## Write and register a profile

Profiles are plain Racket data. Read them with reader, language and compiled
directives disabled. Omitted sections and fields use generic defaults. Strings
and symbols inside procedure references are data; embedded lambdas are invalid.
For example:

```racket
(profile
 (version 1)
 (editor (body-mode sexp))
 (macro-stepper (hide-modules ((module mylang)))))
```

The preferred registration is a reader `get-info` answer under
`racketeer:language-profile`. Preserve the reader's answers to other keys. A
reader built with `syntax/module-reader` can supply the answer through its
`#:info` function, as in the [complete example](#minimal-language-example).
Custom readers must expose the ordinary reader information protocol; a private
helper called `get-info` is insufficient if the reader does not export it.

The answer may be a profile datum or a provider reference. A lazy answer avoids
loading language tooling just to ask unrelated reader questions:

```racket
#(mylang/racketeer profile #f)
```

That module exports a two-argument function. It receives a request whose
`operation` is `profile`, and returns the descriptor:

```racket
#lang racket/base
(provide profile)
(define (profile request data)
  '(profile (editor (body-mode sexp))))
```

Selection uses the first available complete descriptor in this order:

1. The launch module's explicit `languageAdapter` descriptor file.
2. The owning project's `.racketeer/language-adapters.rktd` override.
3. The source reader's `racketeer:language-profile` answer.
4. The same key on the legacy module-language information function.
5. Racketeer's built-in registry.
6. Generic defaults.

A selected descriptor replaces lower-priority descriptors; its omitted fields
inherit generic defaults, not another adapter's providers. Invalid explicit
configuration is diagnosed rather than silently ignored. An absent key uses
the next source. Returning `(profile)` deliberately selects generic behaviour.

The project file contains a list of descriptors or profile-provider references.
Each result needs an explicit `match`; duplicate matching entries are errors.
For example:

```racket
((profile
  (match (language mylang))
  (editor (body-mode sexp))))
```

An empty project list means no override. It does not disable language support.
For an override based on a built-in adapter, copy the effective descriptor from
starter output before changing fields. Package-provider module paths resolve
in the selected Racket installation. `(file "relative.rkt")` resolves relative
to the data file, or the supplying reader/info module for inline descriptors.
Use collection module paths for portable language packages.

The proposed `languageAdapter` launch option is a descriptor-file path, absent
by default. Absolute paths are used directly; relative paths resolve against
`cwd`, or the owning workspace folder when `cwd` is absent. The file contains
one profile datum or profile-provider reference, selected directly without
requiring `match` or an available identity. A profile request receives
`selection` as `#f` when identity is unavailable. This option applies only to
the launch module; imported modules resolve independently. A written submodule
uses its own language, resolved against its owning module's full identity. A
submodule generated by a macro uses its enclosing module's adapter even if it
declares a different language. Invalid files stop launch rather than falling
through to another descriptor.

For an identity-less compiled launch, select a descriptor in `launch.json`:

```json
{
  "type": "racketdap",
  "request": "launch",
  "name": "Compiled module",
  "program": "sample.zo",
  "cwd": "${workspaceFolder}",
  "languageAdapter": ".racketeer/compiled-profile.rktd",
  "debugCache": false
}
```

Keep reader wrappers intact. A meta-reader can change interaction syntax even
when its underlying language is Racket. Reader identities come from resolution,
not a filename suffix or a split of arbitrary header text. `variants` names
explicit additional languages using the same descriptor. Compiled modules with
no language identity require saved debug-cache identity or `languageAdapter`;
the loader must report an unknown identity rather than guess. Test an
identity-less compiled launch with this option and no saved cache, and verify
that omitting the option reports unknown identity.

The number is unrelated to the macro stepper's wire schema version.

## Format reference

Every field below is optional. Duplicate fields, unknown fields and unsupported
versions are errors. `P` denotes a procedure reference of this exact shape:

```racket
#(module-path export-symbol immutable-data)
```

The module path can be a collection module path or an explicit file module
path. The export must be a procedure accepting `(request data)`. `data` is the
third vector element, commonly `#f`; it contains serialisable immutable Racket
data, without procedures, ports or syntax objects.

### Shared fields

| Field | Values | Default and meaning |
| --- | --- | --- |
| `version` | `1` | `1`; common schema version. |
| `match` | Any number of `(language module-path)`, `(reader module-path)` and `(variants module-path ...)` clauses | The identity supplying the profile. Explicit clauses are alternatives; variants are additional language identities. Project/registry entries require explicit matching identities because they have no supplying reader. |
| `bootstrap` | `auto` or `(auto P)` | Normal source reading, then the launched module's `configure-runtime` submodule followed by legacy configuration. An optional provider supplies fresh debugger interaction, complete print and error-display services after that configuration, including isolation before interaction reading and evaluation. It never runs in editor analysis or macro stepping. |
| `source` | `reader` or `(reader+ P)` | Syntax ranges, origins and originalness supplied by the reader. An optional provider supplies an explicit source map. It cannot claim guessed positions or replace reader semantics. |
| `bindings` | `expanded` or `(expanded+ P)` | Expanded core binders, Check Syntax and retained source metadata. A provider adds written component identities, coherent binding families and runtime aliases. The three tools share these facts. |

`match` never changes the reader used by a file. Runtime parameters do not come
from a hypothetical `get-info` key named `read-interaction`: the expression
service captures `current-read-interaction` after configuration.

### Scheme+ and SRFI-105

The built-in descriptor matches `(reader SRFI-105)` for
`#lang reader SRFI-105`. Scheme+ forms are enabled by `(require Scheme+)` in the
module. Scheme+ 20.1 and SRFI-105 17.1 retain locations through infix conversion
and annotations. Source, bindings, runtime sites and editor services use defaults.

```racket
(profile
  (match (reader SRFI-105))
  (bootstrap (auto #((file "adapters/schemeplus.rkt") interactions #f))))
```

The provider initialises the package's own interaction hook from the captured
source in a fresh namespace for each interaction. It does not execute the
programme while doing so. Watches and console expressions use infix such as
`{x + 2}` and neoteric calls such as `{add1(x)}` with the selected frame's locals.
The configured printer supplies ordinary Racket value notation.

Each interaction starts with the module's final reader state. Watches cannot
change later reader state, but selecting a frame in an earlier pragma region
does not restore that region's state. Source is required for initialisation.
The [feature suite](../tests/schemeplus-adapter.rkt) documents the checked
behaviour, including empty-profile controls for native expressions. Constant
definitions can move breakpoints to the next executable expression, and generic
outlines omit local `:=` declarations. Contribution-only analysis retains
navigation and outlines while omitting display products. Macro stepping retains
the existing generic behaviour.

### Debugger section

Place debugger fields inside `(debugger ...)`:

| Field | Values | Default and meaning |
| --- | --- | --- |
| `expressions` | `(runtime-interaction identity)` or `(runtime-interaction P)` | Native configured interaction reading inside a context isolated before reading and retained through evaluation, with no additional lowering. A provider converts the native interaction syntax to one expression acceptable to selected-frame evaluation. |
| `values` | `(runtime-print preview-fallback)` or `(P preview-fallback)` | Native notation for all textual value displays, including Variables previews, watch results and hovers, by default when the adapter supplies a printer. Keep existing output/time limits and structural fallback on timeout, output limit or error. Capture the complete print context, including port print handlers and conversion parameters as well as `current-print`; printed text need not be evaluable. Console output keeps its existing printing path. Variable children remain structural. |
| `steps` | `expanded` or `(expanded+ P)` | Existing expression stop sites. A provider can identify authored statement ranges or suppress language housekeeping, with explicit result/replacement semantics. |

The expression service is shared by watches, console input, conditions,
assignments and replacement expressions. An interaction must read exactly one
form followed by EOF. A bridge must preserve lexical context; converting syntax
to a datum and rebuilding it without scopes can select the wrong local binding.
An imported frame uses its module's adapter rather than the launch module's
syntax by accident. The console outside a frame uses the launch context.

Reading can itself mutate run-time state. In teaching languages the interaction
reader sets a REPL flag; evaluation then resets the test object, reducing a
two-check suite to zero checks. Establish isolation before reading and retain
it through lowering and evaluation. The host invokes bootstrap's
`call-with-interaction-context` wrapper around that whole operation; the default
uses the captured private module context. An adapter whose configured hooks
share mutable program state must supply a safe wrapper or replacement hooks
through `(bootstrap (auto P))`. Otherwise native interactions are unavailable.
An `expressions` provider runs after reading and cannot supply this isolation.
Preserve native grammar, test registrations/results and incidental run-time
bookkeeping even on failure. Explicit assignments retain their selected-frame
language semantics.

Logpoint native expressions use explicit segments. A string is literal output;
an expression record is parsed by the same expression service. For example:

```json
["result: ", {"expression": "native_expression_here"}]
```

The existing DAP `logMessage` brace-template grammar remains available for
compatibility. Infix braces cannot be guessed safely from it. Hit counts retain
their language-independent grammar.

Use the language's own notation everywhere values appear, including console
output, Variables view previews, watch results and hovers. There is no opt-in
setting for native previews when an adapter supplies a printer. Native printers
can execute custom printing code; their side effects during previews are
accepted. For previews, invoke them only on request under the existing
output/time limits, with an explicit structural fallback on failure or exceeded
bounds. Capture and apply `current-print`, global and per-port print handlers,
and conversion parameters, including on the preview port. Teaching configuration
can change those hooks while leaving `current-print` unchanged. Native text is
for display; a printed closure does not reconstruct its captured state.

Error text uses a shared configured service captured with bootstrap. By default
it invokes the captured `error-display-handler` in the module's configured
context with the message and exception, redirecting `current-error-port` to a
bounded private port. A bootstrap provider can replace `error-display`; failure or exceeded output/time limits falls back
to raw `exn-message`. Exception objects and locations remain separate. This
preserves language rewrites: for example, `posn-x: expects a posn, given 7`.

Debugger metadata alone cannot make erased bindings visible or make an
immutable binding assignable.

### Editor section

Place editor fields inside `(editor ...)`. Existing policy means the
`Language-Policy` already derived for that source, including Racket and Typed
Racket hint sources. For an unknown language, expansion and required-header
checks default to enabled, body mode to `unknown`, formatting to ineligible
unless an existing reader hook permits it, and hint sources to empty.

| Field | Values | Default and meaning |
| --- | --- | --- |
| `body-mode` | `sexp`, `non-sexp`, `unknown` | Existing policy; selects structural services, not parsing. |
| `expand?` | Boolean | Existing policy; `#t` for unknown languages. Turning expansion off removes any promise of binding/rename coverage. |
| `require-header?` | Boolean | Existing policy; `#t` for unknown languages. Controls header diagnostics. |
| `source-details` | `auto`, `sexp`, `shrubbery`, `none` | `auto`; use current structural hover ranges or declaration extents. |
| `declarations` | `generic` or `P` | Existing outline plus confirmed generic binders. A provider adds declaration trees, native signatures, kinds and declared annotations. |
| `calls` | `generic` or `P`, optionally followed by `(triggers string ...)` | Generic list-head/documentation-tag signature lookup; triggers space, `)` and `]`. A provider identifies native callees and arguments and can return signatures or documentation tags. Native trigger declarations do not extend the global capability. |
| `completion` | `expanded` or `(expanded+ P)`, optionally followed by `(triggers string ...)` | Expanded source-facing names and module paths; trigger `(`. A provider adds contextual members and incomplete-syntax recovery. |
| `rename` | `expanded-graph` or `(expanded-graph P)` | Generic validated binding rename with proven Racket token/import rules. A provider supplies native name, component/family and import/export rules. Capture validation is mandatory in both local-server and workspace routes, including reserved-name rejection. |
| `inlay-hints` | `policy` or a list of `P` | Existing policy sources. A provider list adds hints; `()` adds none. |
| `formatting` | `policy` or `off` | Existing eligibility, indentation hooks and client restrictions; `off` disables document, range and on-type formatting. |

Trigger strings extend the generic trigger set; they do not supply language
semantics. Declaration kinds feed semantic highlighting and source hover.
Declared annotations are useful without inferred types. Documentation still
requires installed documentation and a resolvable tag. Member completion must
not execute a receiver to discover its members.

The index runs contribution-only analysis, which skips display services.
Essential source-name mappings belong in `bindings`, not a hover, token or hint
provider. They must survive the same declaration graph used by both servers.
The index still discovers source files through installed module-suffix metadata;
an adapter does not register a VS Code grammar or a new disk suffix.

### Macro stepper section

Place macro fields inside `(macro-stepper ...)`:

| Field | Values | Default and meaning |
| --- | --- | --- |
| `context` | `auto` or `module` | Whole-module tracing with line/selection anchoring. `auto` retains the headerless Racket fragment fallback; `module` refuses it. Use `module` for syntax needing the language's imports, blocks or spaces. |
| `hide-modules` | A list of `(module module-path)` and `(collection symbol)` selectors | `()`; additional defining modules hidden by Standard policy. Selectors use resolved defining identities, including submodules. A split collection can span packages; one `collection-path` directory is insufficient. |
| `terms` | `syntax` or `P` | Existing syntax-preserving Racket layout. A provider can lay out native terms if it retains occurrence-to-syntax mappings; unsupported terms use generic layout. |

An adapter with language hiding starts a fresh view at Standard unless a user
preference exists. Generic views retain their existing default. Disable reveals
all language macros. Explicit identifier rules take priority; Custom provides
a Language switch for adapters with language hiding. Same-spelling user macros
are distinguished by binding identity. Line mode can reveal language macros
written explicitly in the requested source range.

The trace starts after reading: reader transformations are not macro reductions.
Panes mix the language's own notation where the adapter can map retained syntax
with expanded Racket forms elsewhere. Each section has an explicit notation
label; there is no inverse-expansion promise. Runtime value printing is a
different operation from syntax layout.

Source links use original syntax locations or a validated source map. Display
ranges use offsets in the printed section, never offsets in the source file.
Hiding and printing must retain phases, hygiene groups, suffixes, taint marks,
binding-edge certainty and stale-snapshot checks. The existing
[macro-stepper schema](macro-stepper-schema.md) specifies those transport facts.

Rhombus macro stepping is later work. Individual user macro transformations
require a Rhombus change: about 30 lines around the user procedure in
`expr-macro.rkt` emitting `local-artificial-step` before result enforestation,
with actual input, returned syntax and unconsumed tail. Language hiding alone
erases these steps, even with emitted events. F11/R7 must retain event provenance
and show independent local histories with phase-aware identity rules outside
language hiding, preserving enclosing phase/context, expansion order and errors.
These are local snapshots, without a continuous whole-module rewrite promise.
F12 must validate raw shrubbery text against retained structure or use core
fallback. Enable support only with the required Rhombus capability/version.

## Provider requests and results

Providers add facts to existing services. They must not start another language
server, maintain an independent index or re-expand a file for each display
request. A provider may share immutable derived facts within one accepted
analysis snapshot. Editor declaration and call providers release reader syntax before analysis
returns; retained records contain only immutable source data. Syntax objects
must not escape into another namespace or a later snapshot. Let the host serialise module identities across workers.

All calls receive an immutable hash and the reference's `data`. The common
request keys are as follows; unavailable values are `#f`:

| Key | Value |
| --- | --- |
| `operation` | One of the operation symbols in the table below. |
| `uri`, `text` | Source URI string and captured source text; compiled-only contexts can lack text. |
| `reader`, `language`, `submodules` | Resolved reader chain, module-language identity and submodule symbol list. |
| `pre`, `expanded` | Reader syntax and expanded syntax in the current analysis namespace. |
| `phase`, `space` | Current phase, including `#f` for label phase, and binding-space symbol or `#f` for the default space. |
| `position` | Zero-based source character offset for a cursor request, otherwise `#f`. |
| `facts` | Already accepted generic binding/declaration facts, using the records below. |
| `cancelled?` | Zero-argument predicate. Long traversals must check it. |
| `hooks` | Host operations specific to the request; absent operations are unavailable. |

`facts` is an immutable hash. Binding requests supply `names`, `families`,
`runtime`, `sites` and `declarations` lists, each empty when unavailable. Editor
cursor requests carry cached `declarations` and `calls` without scoped identifiers.
A binding `snapshot` entry identifies the source and adapter fingerprints. A query after an edit can
receive older semantic facts for recovery, but their snapshot remains explicit;
they cannot authorise edits in the new source. `pre` and `expanded` always belong
to the current request, and are `#f` when unavailable.

Additional operation inputs and outputs are as follows:

| Field / operation | Additional input | Result |
| --- | --- | --- |
| Profile reference / `profile` | `selection`: resolved identity being selected | A profile datum. Explicit `match` required for a project/registry reference. |
| `bootstrap` / `bootstrap` | `hooks` contains configured `read-interaction`, `print` with its complete context, `error-display` and `call-with-interaction-context` procedures, plus immutable `state` where available | Hash with replacement keys of those names as needed; omitted keys retain captured services. Reader takes `(source input-port)` and returns syntax or EOF; printer takes `(value output-port)` and returns void. `error-display` takes `(message exception output-port)` and returns void; its default redirects the captured handler to that port. `call-with-interaction-context` takes a zero-argument thunk and returns its results, wrapping reading, lowering and selected-frame evaluation in isolated incidental reader/evaluator state. The default uses the private captured module context; adapters must replace unsafe shared hooks or the wrapper before any read. |
| `source` / `source` | Reader/expanded syntax and captured `text` | A list of source-map records, or `#f` to retain reader locations without additions. |
| `bindings` / `bindings` | Reader/expanded syntax and generic facts | Hash of `names`, `families` and `runtime` lists; omitted lists are empty. |
| `expressions` / `expression` | `term`: one natively read interaction; `hooks.lexical-identifier`: `(name) -> identifier or #f` for the selected frame | Syntax for one expression, preserving language/frame context. No evaluation by the provider. |
| `values` / `value` | `value`: runtime value; `hooks.print`: bounded `(value output-port)` printer retaining the complete configured print context | Native string preview for Variables, watch results and hovers. On failure, decline or exceeded output/time limits, the host supplies structural fallback. |
| `steps` / `steps` | Expanded syntax and generic site facts | List of site records. |
| `declarations` / `declarations` | Pre-expansion syntax and binding facts; expansion may be absent while typing | List of declaration records. |
| `calls` / `calls` | Reader syntax during analysis; no cursor | Immutable native call records, retained for this text and adapter snapshot. Contribution-only analysis omits these and declaration records. |
| `calls` / `call` | Source cursor, cached `facts.calls` and `hooks.declaration-at` for binding-backed declaration lookup; no reader syntax | Call record with signatures or a documentation tag. |
| `completion` / `completion` | Current source cursor, including incomplete syntax; last accepted semantic facts with their snapshot identity | Hash with `items`, `range`, `prefix` and `incomplete?` keys. An empty item list means known empty members; `#f` means use ordinary completion. |
| `rename` / `rename` | `stage`: `prepare` or `plan`; `target`: name/family facts; `new-name`: string or `#f`; `sources`: immutable URI-to-text hash | Rename policy record. The host, not the provider, applies edits to an in-memory proposal and validates bindings. |
| `inlay-hints` / `hints` | Declaration/call facts and `range`: requested source range | List of hint records. |
| `terms` / `term` | `term`: exact retained syntax; `hooks.layout`: generic subtree renderer; `hooks.group`: scope-group lookup; `columns`: positive width; `suffix-option`: `over-limit` or `always`; `grouping`: `macro` or `all` | Native layout record or `#f` to use generic layout. |

For `profile`, `#f` means no descriptor and permits the next discovery source.
For other optional providers, `#f` declines that operation and retains its
generic default. A required bootstrap error stops launch. Exceptions, invalid
records, conflicts and resource exhaustion are diagnosed with the field name.
They must not turn an incomplete rename into a successful partial edit.

All source ranges below are pairs `(start . end)`, zero-based, end-exclusive
Racket character offsets into captured text. Syntax positions are one-based
reader-port coordinates; counted ports can collapse CRLF, so subtracting one
does not always give a raw-text offset. The host converts both range endpoints
using the captured text and the port's coordinate convention, including any
consumed prefix. `hooks.source-range` takes a syntax object and returns its
raw-text range in the current source snapshot, or `#f` when its source,
position or conversion is unavailable or unverified. Providers use this hook
for syntax-derived ranges when available. Without it, syntax locations require
a reader port that already maps positions to the captured text. The editor already compensates through
[text-port.rkt](../vendor/collects/racket-langserver/doclib/textbuffer/text-port.rkt);
debugger and macro-source ports need equivalent conversion. Require CRLF tests
in the debugger, editor and macro stepper, including spans and consumed prefixes.
LSP offsets are UTF-16 and are converted by the host. Ranges must be within
their stated source snapshot. A missing position remains unavailable; a
zero-width range is not proof of an editable source name.

### Binding and source records

Records are immutable hashes with symbol keys. Required keys are listed first
in each description; optional keys state their defaults:

| Record | Keys and rules |
| --- | --- |
| Source map | `term`: exact syntax object; `uri`: source URI; `range`: authored source range. Optional `origin`: syntax object, default `#f`; `original?`: Boolean, default `#f`. A map associates real reader/expander evidence with the exact syntax object, never a search for matching text. Repeated generated terms can share an origin without becoming the same binding. |
| Name | `range`, `identifier`: actual scoped identifier, `role`: `definition`, `use` or `export`. Optional `phase`: `0`; `space`: `#f`; `uri`: request URI; `canonical`: actual defining identifier, default `#f`; `family`: family key, default `#f`; `root`: another name range for a member, default `#f`; `kind`: declaration kind, default `unknown`; `certainty`: `confirmed` or `predicted`, default `confirmed`; `editable?`: default `#f`. Imported identifiers retain their module binding and phase/space. An editable name needs a positive authored range and proven source ownership. |
| Family | `key`: stable immutable datum local to one declaration; `canonical`: identifier; `members`: list of hashes containing `identifier`, `phase`, `space`, `role` and `anchor`. `anchor` is a stable structural datum within that declaration; a generated spelling is insufficient. Optional `complete?`: default `#f`. Completeness asserts that every affected static identity/component is described; before/after validation must still prove the assertion. |
| Runtime alias | `name`: source string; `identifier`: actual runtime storage identifier; `scope`: source range of visibility. Optional `phase`: `0`; `space`: `#f`; `mutable?`: `#f`; `family`: `#f`. The instrumenter must find the claimed identifier in expanded storage. Metadata cannot substitute an arbitrary evaluation expression for a cell. |
| Site | `term`: expanded syntax; `range`: authored source extent. Optional `visible?`: `#t`; `role`: `expression` or `statement`, default `expression`; `result`: result-producing syntax or `#f`, default `#f`; `replaceable?`: default `#f`. Replacement requires a proven result expression; hiding a site does not delete exception/frame information. |

For example, a provider can add a member use only after resolving its actual
identifier in the current expansion:

```racket
(define (member-fact member-range resolved-id)
  (hasheq 'range member-range
          'identifier resolved-id
          'role 'use
          'phase 0
          'space #f
          'editable? #t))
```

The host compares scoped identifiers within a namespace and serialises known
module bindings with path, submodules, phase/space and identity. It never joins
names merely because their text or ranges match. Several identities at one
written range stay distinct; only a proven family permits a coherent rename.
Predicted template bindings can appear in hover but cannot authorise edits.

### Declaration, call and edit records

| Record | Keys and rules |
| --- | --- |
| Declaration | `name`: string; `kind`: `variable`, `function`, `macro`, `class`, `field`, `method`, `namespace`, `operator`, `struct`, `module` or `unknown`; `selection`: name range; `range`: complete declaration extent. Optional `identifier`: `#f`; `phase`: `0`; `space`: `#f`; `children`: declaration list, default `()`; `signatures`: signature list, default `()`; `annotations`: list of declared-information strings, default `()`; `certainty`: default `confirmed`. Unconfirmed structural declarations may support outline recovery but cannot supply edit identities. |
| Signature | `label`: native signature string; `parameters`: list of hashes with `label` strings. Optional parameter/signature `documentation`: string or `#f`, default `#f`. Parameter order is source order, including explicit keyword labels. |
| Call | `callee`: source range; `argument`: zero-based active argument; optional `identifier`: `#f`; `signatures`: default `()`; `active-signature`: `0`; `active-parameter`: defaults to `argument`; `documentation-tag`: existing documentation tag or `#f`. Resolve overloads or keyword ordering from language facts, without executing a receiver. |
| Completion item | `label`: string. Optional `kind`: declaration kind, default `unknown`; `detail`: string or `#f`; `insert-text`: defaults to label; `identifier`: scoped identifier or `#f`. The enclosing result requires a replacement `range`, `prefix` string, `items` list and `incomplete?` Boolean. Current syntax must validate any use of retained facts from an older snapshot. |
| Rename policy | `valid?`: Boolean; `complete?`: Boolean. Optional `reason`: refusal string or `#f`; `canonical`: identifier or `#f`; `family`: key or `#f`; `edits`: list, default `()`. Each extra edit has `uri`, `range`, `old-text` and `new-text` strings. Edits must be justified selectors/components of the target, not arbitrary source rewrites. Generic occurrence edits remain the host's responsibility. |
| Hint | `position`: zero-based source character offset; `label`: string; `kind`: `parameter` or `type`. Optional `padding-left?`, `padding-right?`: default `#f`; `tooltip`: string or `#f`. Type hints must have a declared or otherwise justified producer. |

At rename preparation, check the target's native token class, space and family
without requiring a replacement. At planning, validate the complete new token
against reserved words/operators and supply only proven extra import/export
edits. Refuse unknown aliases or dynamic families with `complete? #f`. The host
re-expands before/after snapshots, maps binders by source/structural anchors and
checks every occurrence, including unchanged names and unused binders. A provider
cannot switch that validation off. Local and workspace rename obey the same
rule.

### Native term layout records

A term result has `text`, `notation` (`racket` or the native language symbol)
and `occurrences`. Its text is the exact displayed text before transport.
Each occurrence contains `term` (an exact retained syntax object), `range`
(name/term display range), `full-range` (including any printed suffix),
`parent` (occurrence list index or `#f`), `delimiters` (display range list),
`group` (host scope-group number), and optional `taint`/`taint-count` as in the
macro schema. List order is display traversal order; repeated occurrences of
one syntax object are separate entries.

Layout ranges use zero-based character offsets into `text`. The host converts
them to UTF-16 and assigns occurrence IDs. Source ranges stay on the syntax
objects. Every visible identifier, focus and binder must have an occurrence.
The host derives focus, binding edges, phase and certainty from the original
trace, not from printer assertions. A provider must obey the host's suffix and
taint options and must not mutate syntax to obtain different scope groups.

`hooks.layout` takes a retained subtree and returns a generic layout record in
the same character-offset form. Embedding it requires shifting all its display
ranges and parent indices. `hooks.group` takes a syntax object and returns the
existing partition's group number. Returning `#f` for the entire term is always
valid when native layout would lose identity. Plain text from `syntax->datum`
without occurrence mapping is insufficient.

Do not trim indentation, truncate output or insert suffixes after recording
ranges unless the ranges are transformed through the same edits. Use an
upstream native printer's syntax-range hooks where available. A value printer
does not satisfy this syntax-layout contract.

## Make user-defined binding forms work

Forward original identifier syntax into core binding forms whenever possible.
Keep source ranges and origins when constructing syntax. For erased surface
forms, retain the standard `disappeared-binding` and `disappeared-use` properties
with the appropriately scoped identifiers. `original-for-check-syntax` can
identify retained syntax for Check Syntax; it does not manufacture a binding.
Metadata must describe the identifier after the relevant scope introduction.

The generic analyser can then discover definitions, references, source-facing
completion and outlines without knowing the macro's name. A macro-introduced
scope is not a reason to hide an authored binder. Generated implementation
helpers remain separate. A macro-defined function may legitimately create
several related bindings; add family facts only when generic core-binder anchors
cannot establish that correspondence.

Use `bindings` for native written components whose actual identifiers survive
but whose locations/originalness do not reach Check Syntax. An arbitrary dotted
suffix, generated identifier suffix or equal source span is never enough.
Dynamic dispatch with no static identity must remain unresolved. Missing static
coverage can permit partial navigation results, but must refuse a rename that
would omit occurrences.

For Rhombus namespace/import paths, a non-original expanded identifier carries
the real binding over the whole written path, while `origin` identifiers carry
each prefix and its span. Map a part to the matching component of the written
text, keeping the scoped identifier as its identity. Static members and
generated method names already have exact member ranges: for example, `Point.x`
and `norm2`, respectively. Dynamic receivers have no member binding and link to
nothing; literal receivers yield no member identifier. No Rhombus change is needed for R1.

The built-in provider in `racketdap/adapters/rhombus.rkt` adds these component
uses through the existing phase-aware core walk. It accepts only exact written
name ranges and leaves unmatched components, including parenthesised operators,
unresolved. The provider adds no family metadata; families are left to rename
support.

Teaching-language descriptors match exact readers `htdp/bsl/lang/reader`,
`htdp/isl+/lang/reader` and `htdp/asl/lang/reader` with module identities
`lang/htdp-beginner`, `lang/htdp-intermediate-lambda` and `lang/htdp-advanced`,
respectively. Use `source reader` and a shared `expanded+` binding bridge for
structure families, BSL first-order function identities and ISL+/ASL redirected
locals. Consume scoped identifiers and retained `sub-range-binders` and
`stepper-orig-name` metadata rather than spelling. Keep structure hover, exact
field definition anchors and local rename for `define-struct` and `struct`
families when adding graph multiplicity. Shared declarations must recover nested
`local` definitions/signatures/kinds, exclude spurious `cond` children and
respect local completion scopes. Variables and watches need local functions and
captured state where storage survives: for example, ISL+ `shift`/`bump` and ASL
`state`. Native previews use teaching notation: `make-posn`/`make-point`, nested
`cons` in BSL and `list` in ISL+/ASL, without implementation fields or a promise
that printed closures are evaluable. Validate safe teaching family renames and
reject reserved words and capture in both server routes.

Teaching-language adapters have no macro-stepper part: programs in these languages
cannot define macros, so the macro stepper keeps its existing Standard hiding.
The [teaching-language plan](language-adapters-design.md#teaching-language-outlines)
specifies T1–T3 acceptance, including interaction isolation before reading,
unchanged test totals/results, native previews/errors and local-server rename safety.

For runtime inspection, ensure the desired binding still has storage. An unused
name erased by expansion cannot become a local merely by adding a source label.
The same distinction applies to mutability: an adapter records the actual
language rule; it does not grant assignment rights.

## Minimal language example

The following package uses Racket syntax and adds `define-answer`. Its adapter
needs only sexp policy and language-macro hiding. Binding, runtime reading,
printing and macro term layout all use defaults. The source language itself is
ordinary executable Racket; the adapter key takes effect once the proposed
loader exists.

Create a collection named `mylang` with these two files. `mylang/main.rkt`
provides the language and its definition macro:

```racket
#lang racket/base
(provide (all-from-out racket/base) define-answer)
(define-syntax-rule (define-answer name expression)
  (define name expression))
```

`mylang/lang/reader.rkt` delegates parsing to the ordinary reader and answers
the profile key:

```racket
#lang s-exp syntax/module-reader
mylang
#:info language-info

(define (language-info key default default-info)
  (case key
    [(racketeer:language-profile)
     '(profile
       (editor (body-mode sexp))
       (macro-stepper (hide-modules ((module mylang)))))]
    [else (default-info key default)]))
```

The `#:info` function takes three arguments; its third argument preserves
information supplied by `syntax/module-reader` for other keys. The enclosing
reader supplies the identity, so no `match` is needed. Resolving
`mylang` identifies its defining `main.rkt` module for the hiding selector. The
macro forwards the original `name` syntax into `define`, retaining identity
without any provider.

A representative `sample.rkt` contains a language macro and a user macro:

```racket
#lang mylang
(define-answer answer (+ 40 2))
(define-syntax-rule (twice e) (+ e e))
(twice answer)
```

With the collection on the selected Racket installation's collection path,
ordinary execution produces `84`. Expected editor results are one definition of
`answer` and its written use, completion containing `answer`, an outline entry
whose extent covers `define-answer`, and safe rename of both written names.
The duplicated expanded uses of `answer` still represent one written source
occurrence. A helper with the same spelling would remain a different binding.

At a stop on the last line, a watch of `answer` produces `42`. Standard macro
hiding hides the language's `define-answer` implementation but leaves the
file's `twice` reduction visible. Disable reveals both. Both before/after terms
use Racket notation with source links and binding arrows. The adapter does not
replace or reimplement any of those services.

## Generate and run conformance tests

Keep the sample and an expectation manifest beside the language's own tests.
The proposed manifest is a `(samples ...)` datum containing `(sample ...)`
records. `file` is relative to the manifest; `adapter` is optional; `checks` is
a list of check records. Source markers use literal `text` plus a one-based
`occurrence` number when repeated; an omitted number means `1`. Their ranges
are resolved against the captured source before running a test.

For the minimal package, use these independent expectations:

```racket
(samples
 (sample
  (file "sample.rkt")
  (checks
   (output "84\n")
   (binding (definition (text "answer" 2))
            (uses (text "answer" 3)))
   (completion (at (text "answer" 3)) (contains "answer"))
   (declaration (name "answer") (kind variable)
                (selection (text "answer" 2))
                (extent (text "(define-answer answer (+ 40 2))")))
   (rename (at (text "answer" 3)) (to "result")
           (edits (text "answer" 2) (text "answer" 3)))
   (watch (stop (text "(twice answer)"))
          (expression "answer") (printed "42"))
   (macro (hiding standard) (shown "twice") (hidden "define-answer")))))
```

`output` compares ordinary and instrumented execution. `binding` checks the
definition and deduplicated source uses. `completion` checks inclusion, not an
implementation-dependent total list. `declaration` checks source extent/kind.
`rename` checks a complete edit set and validates the proposal. `watch` arms an
authored stop and evaluates in its selected frame. `macro` checks actual
reduction identities as well as labels. These are the minimum check forms;
generated extended fixtures can additionally state expected provider records,
breakpoint/step/caller/error destinations and native layout facts.

Generate and execute the proposed tests from a Racketeer checkout:

```sh
racket racketdap/tools/language-adapter.rkt generate --samples /path/to/samples.rktd --output /tmp/mylang-adapter-tests
racket racketdap/tools/language-adapter.rkt verify --tests /tmp/mylang-adapter-tests
```

`generate` writes test fixtures and unresolved expectation entries to the output
directory; it never derives expected bindings from the same result under test.
`verify` runs fixtures sequentially with time/memory bounds, reports unsupported
capabilities distinctly, and exits unsuccessfully for failed or required
unresolved checks. An optional `adapter` entry names a descriptor file relative
to the manifest and selects it for that sample only; it does not install a
project override. Output files stay outside source trees unless explicitly
chosen as language test fixtures.

Expand the suite as language features are added:

- Debugging: line/column stops; In, Over and Out destinations and values;
  shadowed, mutable and unused locals; native expressions on every input route;
  zero/multiple values; native notation in Variables previews, watch results and
  hovers without opt-in; complete print context, display without an evaluability
  promise, configured error wording and raw-message fallback; printer effects
  and structural fallback on errors or output/time limits; isolation before interaction reading and through evaluation,
  retaining test registrations/results and incidental run-time state even on
  errors; exceptions; imported modules; source and compiled launches.
- Editing: definitions, hover, references, completion, outline, signatures and
  tokens for macro-defined names, native components and distinct phases/spaces.
  Check both servers, unopened consumers, modified buffers and untitled local
  analysis. Native formatting stays disabled until independently validated.
- Rename: declaration/use requests, family members, selectors and aliases;
  deliberate capture in both directions, changed unused binders, reserved names,
  incomplete syntax and dynamic members in both server routes. Preserve structure
  hover, exact field definition anchors and local rename for `define-struct` and
  `struct` families. Refusals must return no partial edits.
- Macro stepping: whole-file and line selections, language hiding and explicit
  user rules, native/core term fallback, repeated syntax, phases, scope colours,
  suffixes, taint, Unicode/CRLF ranges and stale source links.

Printed values need not be readable expressions in every language. Test
read/print round-trips only where the language promises them. Record intended
reader state for pragma-sensitive languages; do not let a watch change the
state of subsequent reads. Include reader, provider and descriptor edits to
verify cache invalidation across all three tools.

Existing project harnesses are identified in the
[maintainer test plan](language-adapters-design.md#samples-generated-tests-and-acceptance).
An external language package needs the profile, its provider module if any, its
normal installation metadata and its sample expectations. No Racketeer fork or
second indexing implementation is required.

### Debugger host call points

The worker accepts resolved choices without resolving or loading a profile.
`serve-session` in `racketdap/worker/session.rkt` accepts an optional
`#:module-context` procedure. It receives the selected frame's `site` and module
namespace, or two `#f` arguments for the launch console, and returns a stable context hash or `#f`. Its
`expressions` hash contains the configured two-argument `read-interaction`
and optionally `lower`, a procedure accepting an expression request. Its
`values` hash contains the configured two-argument `print` and optionally
`render`, a procedure accepting a value request. A `call-with-print-context`
wrapper in that hash applies the captured printing parameters to its thunk.
The `print` procedure prints in that context without restoring parameters itself.
The loader binds provider data and captures each module's execution parameters. The worker
does not instantiate modules to obtain them. Context identity includes the
module instance and adapter identity; a changed selection needs a new context.
For breakpoint validation before execution, the resolver receives a source-only
site and a `#f` namespace. It must report whether that source selects native
expressions without configuring or loading it. Modules without native expression
choices retain immediate Racket condition parsing and its diagnostics.

The context's `call-with-interaction-context` takes a zero-argument thunk and
returns its results. The worker invokes it before native reading and retains it
through lowering and selected-frame evaluation, including console input,
conditions, logpoint segments, assignments and replacements. It must isolate
incidental reader/evaluator state and retain programme test registrations and
results on success and failure. Native input without this service is refused
before reading. Explicit assignments still change their selected live binding.

The context's optional `error-display` takes `(message exception output-port)`.
Its optional `call-with-error-context` enters the captured error parameterisation
before invoking its thunk. The worker passes this entry wrapper to the renderer,
which then installs its owned custodian, debugger controls and bounded ports.
The formatter must not restore parameters inside those guards.
The worker uses this configured service for exception stops/details and input,
condition and logpoint errors, with the same 4096-byte and 100 ms limits as
previews. Failure or exceeded limits falls back to the raw exception message.
The original exception and its location metadata remain available separately.

`read-expression` accepts the expression choices through `#:expressions` and
the selected frame's alias lookup through `#:lexical-identifier`. A bridge gets
these identifiers through `hooks.lexical-identifier`; they denote the evaluator's
live-cell aliases. Native syntax retains its scopes. Breakpoint conditions and
explicit expression segments are read on first use and cached by expression
context identity, including its module instance; lowering still runs for the selected activation on each use. Legacy
`logMessage` expressions retain the Racket template grammar. DAP clients pass
explicit segments in the additional `logSegments` breakpoint field and omit
`logMessage`. **Racket: Edit Logpoint Segments** edits the same representation
on an ordinary source breakpoint and retains its condition and hit-count
condition. The palette and source menu show this command only for a selected
source with native expression capability. Segment metadata is stored separately
in workspace state against that breakpoint's identity; ordinary log text is
always literal template input, including text that resembles metadata.

`value-preview` accepts value choices through `#:values`. Native previews have
a 4096-byte output limit and a 100 ms time limit, including optional provider
execution. The print hook supplied to a value provider shares the output budget.
Failure, refusal or exceeding either limit yields the existing preview with a
`[structural]` prefix. Printing runs with the requesting execution's parameters,
with the captured printing context applied first. The renderer then overrides
the programme custodian and debugger controls, installs bounded output/error
ports and copies the captured per-port handlers onto them. It closes its owned
printing threads and resources afterwards. A printing hook must use this context
wrapper rather than restore a parameterisation inside `print`, which would
override those guards. Structural child enumeration remains unchanged. Without
choices, the original parser and structural text remain in use.

`instrument-module` accepts already resolved `#:runtime-bindings` and
`#:site-facts` lists for the expanded expression being instrumented, together
with captured `#:source-text` for their ranges. It matches scoped storage
identifiers at lexical binders or the module declarations recorded by
`record-module-bindings!`. It rejects claims for missing storage. Aliases use
live getters, optional setters and the declared visibility range. Site terms
must be exact expanded runtime syntax. Hidden sites retain their internal frame
descriptors. Statement values require an explicit result on every return path;
replacement also requires `replaceable?`. Raw ranges are converted through a
counted port over the captured text, including CRLF. No fact lists means the
existing discovery rules apply.
