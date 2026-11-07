<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# Lazy schema 2 expansion sessions

The extension uses schema 2 for the linked Before and After panes. Schema 1 is the eager
worker interface. Both schemas use the same syntax-preserving printer. Schema 2 requires
`session: true` and a captured `snapshot: {sourceHash, sourceVersion}` (SHA-256 and
document version). Requests and answers are newline-delimited JSON over one owned
worker's stdin/stdout. Send requests sequentially. Every answer carries `schemaVersion:
2`, `mode` and the snapshot; structured failures carry `failed` and `failureCode`.

The first answer has `mode: "summary"`, `stepCount`, `steps`, boolean `final`,
nullable diagnostic ID `error`, nullable error `message`, source provenance,
`nextGroup`, `relationPhase: 0`, `availablePhases` and capabilities including `lazy-positions`.
Each step contains only `id`, nullable `eventKey`, `expansionPoint`, `kind` (rewrite/error/remark),
`label`, nullable `macro`, `source`, `sourceFoci` and nullable diagnostic ID
`error`. No programs or term inspections are printed or inspected for this
answer. The terminal position always exists: navigation counts `stepCount + 1`.
`final` says whether the finished program exists; otherwise `error` identifies
the expansion failure.

Initial requests accept `includeRenamingSteps: false` by default. When true,
the worker admits the seven named scope/resolution transitions after applying
the hiding policy. They use `kind: "rewrite"` and the model's exact descriptions
and focus regions. Synchronisation and unnamed scope tracking remain excluded.
`reexpand` accepts the same Boolean and reuses the captured derivation and
foreground partition. Hidden regions do not acquire extra transitions.

`expansionPoint` is the nonnegative integer of the model's Before-state
expansion sequence number. Points are stable across renaming filters of the
same derivation and hiding policy; several transitions can share a point. Navigation saves this point
or an explicit end destination. A renaming toggle seeks the first retained point
at or after the saved point, falling back to completion; without a saved point,
it starts at position 1. The toggle does not replace the saved point.

## Requested position

```json
{"mode":"position","snapshot":{"sourceHash":"<SHA-256>","sourceVersion":7},"position":1}
```

Positions are one-based: steps first, then the finished/stopped program. The
reply includes `position`, `count`, nullable `record`, nullable `final`, nullable
`error`, `diagnostics`, `terms`, `sources`, `relationPhase`, `availablePhases`
and `inspectedPhases: []`. `nextGroup` is the next unused foreground number. A step record adds its complete `before` and `after`
Sections and transformer `contexts` to the summary metadata. An error step has
`after: null`. The terminal position has `record: null` and either the finished
Section or its error diagnostic. Diagnostics retain their message, failing
program, implicated syntax and outer-to-inner transformer contexts.

The paired view sends `panes: true`. At completion, `terminalBefore` holds the
last step's input, rendered before the final output; its syntax identities belong
to the terminal position. Without this flag, `terminalBefore` is null.

Sections retain the complete printed program, UTF-16 ranges, focus, occurrences
(including parent identity, delimiters, phase and `macroScopeGroup`), binder occurrences and
binding edges `{id, binder, reference, certainty, phase}`. Certainty first uses
an exact identifier-object lookup in the displayed state's resolved-use table,
then its directly listed forward module-relocation targets in recorded order.
A nonfalse numeric phase makes an edge definite; scope-equivalent identifiers,
relocation predecessors, binders and inspection facts do not. Only binders at
that phase participate, matched by binding identity. Without a resolved phase,
edges are possible at every matching recorded binder phase, including `"label"`.
Origins include the representative binder's displayed forward targets; both
endpoints belong to the same printed term, with no self pair. Final displays the
finished expansion syntax with completion tables. Completion alone does not
make an edge definite. `terms[syntaxId]` contains only
the inexpensive display facts: kind, name, source, artificial status, hygiene
group and bound/free relation classes. Binding inspection, properties and
scopes are absent. Source records retain kind, value and nullable fingerprint;
no later disk read is presented as captured provenance.

A marked occurrence additionally has `taint: "armed" | "disarmed" | "tainted"`
and positive integer `taintCount`. Both are omitted when there is no mark.
The mark is anchored before `range[0]`, including before reader prefixes and
opening delimiters. Taint takes precedence over the expander's unlocked
annotation, which takes precedence over armed lexical context. A tainted
occurrence suppresses all descendant marks within that rendering. Proper-list
tails, omitted quotation heads, hash keys and prefab keys have no independent
printed occurrence. Repeated identical marked objects accumulate prefixes
within one rendering (`taintCount` 1, 2, 3); independent sections start afresh.
Every syntax section uses this rule, including remarks, diagnostic syntax,
contexts and the finished program. Literal prose never receives marks.

These fields describe presentation independently of inspected tamper status. The host
sends `taintIcons: "codicons" | "unicode" | "none"` in pane `state` messages from the
remembered `racketdap.macroSteps.taintIcons` setting (default `codicons`). Changes
update decorations in every pane without a worker request. Monaco injected decorations
use lock/yellow, unlock/green and zap/red, or 🔒/🔓/💥. They never enter model text,
ranges, suffixes, selections or clipboard contents. The window printer overwrites the
mark on pair-shaped square/curly bracket forms; those occurrences have no visible mark
here either, while a tainted parent still suppresses descendant marks. Decorations keep
the program's bracket text intact.

Every printed occurrence reports a nonnegative `macroScopeGroup`, including
compounds and atoms. The partition compares ordered scope identity lists from
`syntax-debug-info` at its default phase, keeping only origins named `macro`
by default, or every scope under `all`. Empty context is group 0. New lists
receive successive positive numbers when displayed, enclosing syntax before
contents, left to right. Both panes share the partition across navigation and
hiding. Expansion alone allocates no numbers. Rendering and foreground colouring
of each term finish before the next term; before and after precede contexts.

Group 0 retains ordinary token colours. Groups 1 through 17 use distinct
resolved chart and terminal ANSI palette entries, excluding arrow yellow;
spare ANSI entries replace duplicate resolved values. Groups above 17 retain
ordinary token colours. Theme changes resolve the palette again without resetting
numbers. Monaco's bracket colours and focus backgrounds retain priority.

Default suffix display is `over-limit`: only identifiers with groups above 17
receive `:N`, appended to the symbol name before normal symbol escaping.
Initial and `position` requests accept `suffixOption: "over-limit"` or
`"always"`. A position request changes rendering with the existing partition;
it does not reset numbering or re-expand. The window's Always Suffix Marked
Identifiers checkbox chooses between those two values and starts unchecked in
each independent window. This option has no saved setting. `always` leaves
group 0 unsuffixed. The printer's `never` option is internal and is not admitted
by the session protocol or exposed in menus. Ordinary name ranges exclude a
trailing suffix. Escaped symbols retain their full token range because the suffix can fall inside vertical bars.
`colorRange` includes the suffix, so its foreground follows its identifier.

Reader shorthand is enabled by default for the eight quote/syntax heads. A
proper two-element form qualifies when its head is bound-identifier equivalent
to the same symbol in the enclosing form's context, and form and head agree on
source, line, column, position, original status and source module. Span is not
compared. The abbreviated head and list tail are omitted from numbering;
the operand is rendered normally. Eligibility precedes suffixes, so an eligible
group-44 quotation can print `'a:44`. Explicit or relocated forms that fail the
test stay full lists.

`configure` with `grouping: "macro"` or `"all"` creates a fresh partition and
returns a summary. The host clears cached positions and redraws the current
before/after terms. Reset Mark Numbering uses the current grouping. A new view
starts fresh. Refresh preserves the next unused number for its newly captured
expansion via the initial request's `nextGroup` and `grouping` fields.

The extension caches at most three recent positions with a combined 32 MiB
budget. A cache miss requests exactly one position. The worker retains engine
syntax and the current position's syntax identities, never printed answers.
Position-local IDs are deterministic across reconstruction, so inspection of a
cached position can restore that position's syntax without rerunning expansion.
Selections, pins and relations continue to use the complete displayed Section.

The host's `state` message carries Boolean `highlightRedexContractum` (default true). A
change updates decorations immediately, without a position transfer or worker request.
Only Before/After change backgrounds, including transformer context foci, obey this
flag. Selection, related identifiers, arrows, binding underlines, foreground colours and
suffixes are independent. Remark snippets, error syntax and final terms have no change
background; no frontier regions are rendered. The corresponding saved settings are
`racketdap.macroSteps.highlightRedexContractum` and
`racketdap.macroSteps.includeRenamingSteps` (default false).

A suffix-only position transfer sets `preserveSelection: true` in its view
projection. Deterministic position-local identities preserve the selected
occurrence and pins while text and ranges redraw. The host clears printed
position caches, retaining the partition and numbering replay journal.

## Selected-term inspection

```json
{"mode":"inspect","snapshot":{"sourceHash":"<SHA-256>","sourceVersion":7},"position":1,"term":"<syntaxId>"}
```

Selection fetches only this term's bindings, implicit bindings, source, phases,
properties, scopes and built-in properties. Initial bindings and implicit bindings
include phases 0 and 1, plus the scope phases; absent bindings are omitted from
the details presentation. An explicit `phases` request inspects exactly those
phases for bindings and scopes. `inspectedPhases` describes scope inspection.
Omitted `phases` means phase zero, requested expansion phases and the term's
observed engine phases. The view initially shows only phase-zero scopes.
Its `morePhases` action accepts optional integer `phases` (at most 256); the scope
link requests successive pairs `[N, -N]`, filtered to those not already inspected.
Fewer phases reduces the visible range without discarding cached facts. Scope
presentation orders phases 0, positive ascending, then negative descending; it
does not display the label phase. A command without `phases` inspects the
remaining available phases. Integers and `"label"` are accepted, at most 256.
No inspection runs transformers. Unknown identities or mismatched snapshots
produce structured failures.

Property `value.text` uses Racket's expression printer, including quotation and
syntax representations with source basenames. Bounded containers and opaque values
retain truncation reasons. Scope `description` uses write notation. Binding
`definedIn`, `importedFrom` and built-in `sourceModule` use collapsed module
paths in write notation, with `this module` for a self index.

An inspection reply includes `position`, `term`, `termData`, `shared` and
`sources`. `termData` indexes the reply's **own** `shared` table. Tables never
accumulate across replies. Every string/object/array is interned; within an
entry, `[index]` references a preceding entry, while numbers and booleans are
literal values. Decode using `decode-term` or `decodeTerm`. Both restore omitted
defaults: nullable fields to null, arrays to empty, phase/group to zero,
artificial/original/truncated to false, binding status to absent, scope status
to known, inspection status to complete and tamper status to unarmed. Symbol
status defaults to interned for identifiers and not-applicable otherwise.
Zero coordinates remain zero and label phase remains `"label"`.

Missing phase records mean uninspected; present empty scope records mean
inspected with no scopes. Unavailable results and bounded property displays
retain their status and reason. Merge More replies by phase, retaining other
inspected phases. The host caches at most 32 selected inspections within 8 MiB
and clears them on position changes. Reject obsolete selection, position and
generation replies before updating the page. The page still receives bounded,
acknowledged chunk transfers for one position or selected inspection.

## Re-expansion and lifetime

During the initial expansion the worker may emit a checkpoint instead of its
summary. This is an event within the pending request, not its answer:

```json
{"schemaVersion":2,"mode":"checkpoint","snapshot":{"sourceHash":"<SHA-256>","sourceVersion":7},"count":40000}
```

The worker is suspended on entry to that macro application. No partial history,
programs or total are published. Both panes remain busy. The host uses a modal
`showWarningMessage` with message "Macro expansion has taken a suspiciously large
number of steps.", detail "Click Stop to stop macro expansion and see the steps
taken so far, or click Continue to let it run a bit longer.", and Continue and
Stop buttons. Continue has `isCloseAffordance: true`, preventing an additional
Cancel button and making dismissal mean Continue. The host sends this control message
directly while the original request remains pending:

```json
{"mode":"checkpointDecision","snapshot":{"sourceHash":"<SHA-256>","sourceVersion":7},"count":40000,"decision":"continue"}
```

`decision` is `continue` or `stop`; snapshot and count must match the waiting
checkpoint. Continue resumes the same trace without replay and sets the next
checkpoint to twice the cumulative count. Each expansion starts at 40,000;
there is no threshold setting or unlimited response. Stop abandons the pending
application and returns the retained history through the ordinary summary and
position protocol. Completed rewrites precede an error position and a distinct
terminal error, both with "Macro expansion was stopped because it took too many
steps." There is no finished result or resumable continuation. The diagnostic
adds no failing-program Section. Hiding and layout use the retained derivation.

Closing the input lease cancels a waiting expansion and reaps its process group.
A late modal response cannot send a decision to a stopped or replacement worker.
VS Code owns the modal's lifetime: its public message API offers no programmatic
dismissal, so a dialog already displayed still requires dismissal after cancellation.
The 1000 MiB worker and 64 MiB answer ceilings retain their existing failure
codes and diagnostics; neither is a checkpoint Stop.

```json
{"mode":"reexpand","snapshot":{"sourceHash":"<SHA-256>","sourceVersion":7},"hiding":"none"}
```

Standard (`standard`), Disable (`none`) and line reveal (`line`, with `lines`)
recompute reductions from the captured derivation in the same worker, returning
a fresh summary. Position syntax and inspections are released, while the
foreground partition and captured derivation remain. Transformers do not run
again when changing hiding. Refresh or another command for the source captures the
current buffer and replaces the old worker. Hiding uses the captured snapshot;
source changes remain marked stale until Refresh.

All expansion, retention, printing, inspection and re-expansion use one
1000 MiB custodian ceiling for the entire session. Each answer independently
has a 64 MiB UTF-8 ceiling. The extension applies that ceiling while framing
each line, resetting the counter after every answer. It serialises requests
and rejects malformed replies, timeouts and closed sessions.

Closing the panel, replacing its source expansion, extension deactivation or stdin EOF
releases the owned process group. Cancellation works during initial expansion and
re-expansion. At most two unshared worker sessions are retained in the eviction pool.
Shared recordings follow the lifetime rules below. Starting another ends the least
recently used unshared session, waiting for in-flight requests and worker exit before
admitting its replacement. A panel that remains hidden for 60 seconds also releases its
worker; a visible panel keeps its session even when it has no keyboard focus.

Cached printed positions, selection and pins survive eviction. The next uncached
position or inspection transparently re-expands the captured source with its original
snapshot identity, fragment mode and hiding policy. It also replays the recorded
Continue count and any Stop decision, without opening checkpoint dialogs. An additional
checkpoint beyond that recorded history fails and requires Refresh. This runs
transformers again; it does not capture current edits or change the displayed position.
The host replays its journal of displayed positions and hiding changes to reconstruct
numbering before answering new queries. Repeated displays can reuse cached programs; the
journal keeps each position's first encounter under a policy. An explicit numbering
reset discards the older journal. Recovery shows progress only after 500 ms. Refresh
explicitly captures the current buffer. Initial expansions are limited to two at a time.

## Optional split and factored layouts

The saved Booleans `racketdap.macroSteps.oneTermAtATime` and
`racketdap.macroSteps.factorCommonContext` both default to false. Menu toggles
update the active pair immediately and save the default for future pairs;
already open pairs keep their own values. Existing controls retain their
committed settings behaviour.

Initial and `reexpand` requests accept `oneTermAtATime`. After hiding and renaming
filtering, each visible two-sided transformation becomes consecutive Before
and After positions with the same description and macro name. Each has `side`
set to `before` or `after`, the opposite Section is null, and its expansion point
comes from its own state. The inactive pane is empty. Navigation restores the
first recorded progress point at or after the remembered point, or completion;
toggling does not overwrite that remembered point. Remarks, errors and the
terminal position remain single and retain the existing routing and labels.
Pane titles retain the existing step-position and transformation formats;
no transformation separators or completion headings are added to pane content.

Position requests accept `factorCommonContext`. With splitting off, the longest
shared outer suffix of model context frames is removed from each state. The
residual fragments remain in their respective panes. When shared context
exists, `record.commonContext` contains its syntax with `[ HOLE ]` replacing the
insertion site. After appends a blank line, `In context:` and that Section,
then the transformer contexts with their existing labels. The marker has no
binding or mark number. No shared frames means the original Sections and
routing; splitting suppresses factoring. Neither option changes the caption
`While executing macro transformer in:`.

Split and factored state Sections can carry `frontier` ranges; common context
has neither focus nor frontier backgrounds. Binding arrows stay within each
Section. Selection in an option layout follows syntax identity across panes
and position or layout changes, including while absent; equal spelling does
not replace it. Clear Selection clears that remembered identity. To preserve
that identity across a layout toggle, the host explicitly requests
`syntaxIdentities: true`; only these requested answers add session-stable
`identity` values to inexpensive term facts. Ordinary both-off answers retain
the committed schema and rendering. Optional `columns` sets a positive display
width up to 10000 (initially 60).

Factored printing encounters Before, After, common context and transformer
contexts in that order. Layout redraws preserve the foreground partition and
numbering replay journal. A suffix redraw uses the same redraw mechanism.

## Independent windows and internal failures

Each recorded source expansion is one retained term in a pane pair. Duplicate
Stepper and Duplicate Stepper (Current Term Only) therefore copy the same term;
the latter does nothing after Remove Selected Term has emptied the pair. A full
duplicate of an empty pair is empty. This source-driven stepper has no stream
of additional recorded terms. Refresh explicitly captures a replacement term
in its addressed pair; existing duplicates keep the previous recording.

A worker request can name a `view` (a nonempty string, initially `main`). Each
view owns its reduction policy, display options, partition and inspector.

```json
{"mode":"duplicate","snapshot":{"sourceHash":"<SHA-256>","sourceVersion":7},"view":"main","newView":"another-window","hiding":"none","custom":{"enabled":true,"racket":true,"library":true,"contracts":true,"phase":true,"rules":[]},"includeRenamingSteps":false,"oneTermAtATime":false}
```

The reply is a summary for the new view. It reuses the captured syntax, events
and derivation without tracing again. Numbering starts fresh at 1 with macro
scope grouping and the default suffix option. The host starts at position 1,
without selection, pins or copied scroll position. Its initial projections carry
`suppressSelection: true` to avoid selecting syntax at the untouched editor caret. Saved display settings and
the latest saved hiding mode apply at creation; custom rules and switches start
fresh. Already open pairs retain their independent live controls.

`closeView` removes only the named view and replies with `{"mode":"closed"}`.
The host releases a shared recording when its last retained term is closed,
removed or refreshed. Duplicated recordings stay resident, including while
hidden, so later navigation cannot rerun transformers. They are excluded from
the two-session eviction pool for unshared recordings; the 1000 MiB ceiling
still applies to each recording, shared by all its views. Extension shutdown
stops both pooled and shared workers. A failed shared worker requires Refresh.
If an unshared worker has already been evicted, Duplicate Stepper reports that
the recording is unavailable instead of rerunning expansion. Ordinary navigation
or Refresh can obtain an available recording before duplication.

Reset Mark Numbering keeps position, grouping, suffix choice, selection, pins
and the visible text position. It clears only the addressed view's partition,
printed caches and replay history, then transfers both pane projections with
`preserveSelection: true`. Removing a term sends `clear` to each page, releases
its recording reference and disables navigation without closing the panes.
A reset at completion can set `retainTerminalBefore: true` on the position
request to reconstruct the already displayed input without losing its identities.
The host's `init` message and persisted page state carry `pairId`, keeping
restored pairs distinct when several show the same source.

An interpreter failure produces a summary with `error: "internal"` and a single
terminal position. Its diagnostic has `kind: "internal"`, `stage: "steps"` or
`"derivation"`, Boolean `details`, `title`, and the exact window heading in
`message`. `program` contains original syntax only for a steps failure. The
message and stack context stay out of the initial display. Interruptions use
"Macro stepper was interrupted"; non-exception failures omit the details link.
Normal expansion errors keep their existing diagnostic kinds and presentation.

The page's `internalDetails` action has no arguments and uses the normal
session, generation and revision checks. The host requests `internalDetails`
from that worker view. Its reply contains `title`, the complete prefixed
`message` (`Internal error:` followed by a newline and the exception message),
`report` from Racket's ordinary error display handler, and `diagnostic` text
(or false when expansion events are unavailable). The diagnostic includes the
recorded events, error message and saved stack context with available source
positions. It is a readable diagnostic rather than a loadable expansion file.

A VS Code notification offers Copy Details, Show Error, Dump Debugging File and
Cancel. Copy Details copies the entire prefixed message, including long and
multiline messages. Show Error writes the ordinary exception report to the
Macro stepper output channel. Dump Debugging File uses the editor's save chooser
without an initial filename and writes the diagnostic to the selected URI;
cancelling writes nothing. Missing events produce a message instead of a partial
file. Navigation and closing remain independent of notification dismissal.
