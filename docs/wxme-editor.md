<!-- Copyright (c) 2026 Eric Parsonage. SPDX-License-Identifier: Apache-2.0 OR MIT -->
# WXME editing

## Viewer and editor

For a saved WXME source file, **Open With → Racketeer WXME Viewer** reads text and
embedded bitmap images in source order. The viewer is read-only and does not run the
program. Ordinary Racket files still open in the text editor. Nested editors, comment
boxes, XML boxes and Racket boxes retain their boundaries and contents. XML labels show
the whitespace mode; Racket labels distinguish single values from splicing. Other object
classes are reported as unsupported. A changed file is marked in the view; close and
reopen it to refresh. Unsaved text edits must be saved or reverted before viewing.

**Open With → Racketeer WXME Editor** edits text around embedded images and inside nested
editors or comment boxes. It supports VS Code's Undo, Redo, Save, Save As, Revert and
unsaved-document recovery. The toolbar inserts a PNG image, comment box or nested editor at
the cursor. Selecting text before inserting a box moves that text inside it. The × button
removes an object and its contents; Undo restores them. XML and Racket boxes support text
editing, insertion and removal. Box controls change XML whitespace handling or Racket
splicing, with normal Undo/Redo. Their original object types and nested contents survive
saving. The writer uses Racket's public editor libraries. Unsupported box versions, other
object classes and linked or missing images cannot be edited. PNG imports are limited to
8 MiB and 4096 pixels in either dimension. Save As opens its destination in the configured
default editor; use Open With to continue in the WXME editor if needed.

Editing requires the full Racket installation's GUI libraries and a working graphical display
on the extension host. It opens inside VS Code; no separate Racket window is shown. The read-only
viewer also works without a display. Saving preserves supported objects and unchanged text styles
through Racket's editor codec and can change the file's binary representation. Text placed in a
comment box takes the framework's standard comment-box style. If the file changes externally,
use Revert to reload it or Save As to keep the edited version.

**Racket: Run Current File** and **Racket: Debug Current File** save and launch the active WXME
document from either the editor or viewer. A dirty editable view of the same file is saved before
launch. Debugging opens a read-only source snapshot with an object replacement character (U+FFFC)
for each image or box. Use that snapshot for breakpoints and stepping through the surrounding source
text. The program executes from the original WXME bytes; the snapshot remains fixed if the file is
edited during a stop. Language services, breakpoints in the custom editor and locations inside
embedded boxes are not yet available.

## How the editor is built

The editor uses VS Code's `CustomEditorProvider` lifecycle. A document has one
model shared by all its views. The provider reports undoable edits to VS Code,
which owns dirty state, undo/redo, save commands and backup scheduling.

## Boundaries

- `vscode/wxme-document.js` owns the document tree, validation and transactions.
  It has no editor API dependency.
- `vscode/wxme-editor.js` adapts the model to VS Code and owns codec jobs.
- `vscode/wxme-editor-view.js` handles selection and input. The shared renderer
  in `wxme-render.js` escapes content and restricts webview resources.
- `vscode/wxme-storage.js` handles bounded reads and staged file replacement.
- `racketdap/tools/wxme-edit.rkt` handles the process protocol and input lease.
  `wxme-codec.rkt` uses public Racket editor APIs to copy and serialise content.
- `wxme-editable.rkt` validates decoded object kinds and modes before GUI
  libraries are loaded. `wxme-xml.rkt` supplies independent XML/Racket snip
  classes using the public Racket editor stream APIs.

## Document and transactions

An editor contains alternating text and object nodes, beginning and ending with
a text node. Text slots can be empty. Supported objects are embedded bitmap
images, comment boxes, nested text editors, XML boxes and Racket boxes. XML nodes
carry `eliminateWhitespace`; Racket nodes carry `splicing`. Both are booleans,
retained by text edits, structural changes, mode changes and recovery. Each node has a stable identity.
Original identities name normalised paths; inserted identities use a monotonic
sequence. Moving surrounding text does not renumber existing objects.

Text uses a piece table. A piece is either literal inserted text or a span of an
original text node. Span offsets use UTF-16 code units and cannot split a Unicode
character. The codec converts these offsets to Racket character positions and
copies the original text snips, retaining styles on unchanged text. Original
objects are copied through their public `copy` method before nested content is
updated. The original serialisation remains available throughout undo history.
The public comment-box reader applies its standard text style when loading;
moving styled text into a comment box follows that behaviour. Undo restores the
original spans and their styles. Ordinary nested editors retain moved styles.

Each edit produces immutable before/after trees. Inserting a box moves the
selected text into it; inserting an image replaces the selection. Removing an
object removes its contents and joins the neighbouring text slots. Undo restores
content, identities and original spans. Structural changes replace each view's
document and generation token; messages from an older view are refused.

## Codec and persistence

Codec requests and responses use protocol version 1. A request contains the
original base64 `bytes` and an optional `tree`, or an `image` containing a PNG to
import. The response contains version, serialised bytes and decoded parts.
Original readers are checked before loading. A no-edit round trip must preserve
decoded content before editing opens. Each edited save is compared with the
model's content before any file is replaced. Opening and saving do not evaluate
the source program.

XML and Racket boxes use the version-1 snip formats: an integer mode flag followed
by nested editor content through `write-to-file`/`read-from-file`. Flag zero means
whitespace elimination or splicing; flag one means preservation or a single value.
The codec registers its own classes before reading and refuses other versions.
Copying a box retains its mode, nested objects and text styles. GUI loading cannot
resolve additional reader modules, including those hidden in nested streams.
The writer needs the Racket GUI libraries; it does not load GUI application modules
or the XML and Racket box GUI readers.

Unchanged saves retain exact original bytes. Edited saves can change binary
serialisation. Replacement checks the saved-file hash, stages bytes beside the
destination, retains permissions and follows existing symlinks. A conflicting
external change requires Revert or Save As. Cancellation or a changed revision
during encoding leaves the file intact. Saves for one document run in order.

Backup version 2 stores original bytes, saved-file hash, current tree and identity
sequence. Version 1 text-edit backups remain readable. Recovery validates the
complete tree before replacing state. Tree validation limits nesting to 32
levels, nodes to 10000, text spans to 100000 and content to 32 MiB. Imported PNGs
are limited to 8 MiB and 4096 pixels in either dimension.

Editing requires Racket GUI libraries and a display on the extension host. The
read-only viewer does not. The model's source spans describe retained original
content; they are not LSP positions or debugger coordinates.

## Execution and debugger sources

Run and Debug capture the active editor or viewer tab's URI and save a dirty document
through `workspace.save`. A failed save or conflicting dirty text buffer stops
the launch. Other text-dependent commands still require a text editor.

The viewer distinguishes XML whitespace modes and Racket splicing modes through
the public headless readers. XML boxes can contain independent WXME streams;
the outer stream's class list does not describe all nested readers.
`wxme-readers.rkt` preloads supported headless readers in one namespace and
restricts module resolution throughout decoding, including nested streams.
Document-supplied readers cannot load through an embedded XML box.

The loader reads source bytes once. `wxme-source.rkt` recognises the WXME header before
loading `wxme-decode.rkt`, so ordinary text debugging does not load WXME libraries. For
supported WXME files, the decoder builds a display snapshot, replacing each outer object
with one U+FFFC character. It uses the viewer's reader allowlist and does not call
embedded objects' `read-special` methods. Decoded source is limited to 32 MiB. The
program reader still consumes the original bytes. Reader positions therefore align with
the snapshot without flattening nested editors or turning images into executable text.

The existing DAP source-reference lifecycle, position-to-UTF-16 conversion,
breakpoint resolution and stack handling use this snapshot. Saving a later edit
does not change a running session's captured source. Breakpoints and stepping
are available in the native debug source view for surrounding executable text;
the custom editor has no breakpoint gutter. Locations within embedded editors
and LSP services for WXME remain unsupported.

Returning to a hidden editor renders its current document model. Webviews can
be recreated from their initial HTML, so transient webview state never owns
the saved text, undo history or edits made in another view.
