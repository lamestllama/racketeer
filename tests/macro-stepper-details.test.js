// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { racket, helper, plain, tick } = require('./support/macro-common');
const { request } = require('./support/macro-worker');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const { decodeTerm } = require('../vscode/macro-stepper-codec');
const Model = require('../vscode/macro-view/model');
const { fakeMacroPage } = require('./support/macro-page');
const { fakeStepper, opened } = require('./support/macro-stepper');
const { pair, message, envelope } = require('./support/macro-fixtures');
const Protocol = require('../vscode/macro-view/protocol');

const sections = [
  ['binding', 'Apparent identifier binding', true],
  ['implicit-top', 'Binding if used for #%top', false],
  ['implicit-app', 'Binding if used for #%app', false],
  ['implicit-datum', 'Binding if used for #%datum', false],
  ['source', 'Source location', true], ['scopes', 'Scopes', true],
  ['builtins', 'Built-in properties', true], ['properties', 'Additional properties', true]
];
function panel(term, sources, sourceText) {
  const { page } = fakeMacroPage(), sent = [];
  page.selected = { syntaxId: 'selection', properties: term,
    sourceLocation: Model.sourceLabel(term.source, sources[term.source?.sourceId], sourceText) };
  page.projection = { position: 1, sources };
  page.send = (type, data) => sent.push({ type, ...data });
  page.expanded = null;
  page.renderInspector();
  const group = name => page.inspector.children.find(c => c.dataset.name === name);
  const body = name => group(name).querySelector('.property');
  const link = id => body('scopes').children[0].children.find(c => c.id === id);
  return { page, sent, group, body, link };
}
const phaseBinding = (phase, defined, imported, as = '') =>
  `In phase ${phase}${phase === 1 ? ' (transformer phase)' : ''}:\n  Defined in: ${defined}${as ? `\n    As: ${as}` : ''}\n  Imported from: ${imported}`;
const core = '(quote #%core)', base = '(lib "racket/base.rkt")';

// These selections and expected words are taken from the recorded window text.
const fixtures = [
  { file: 'keep.rkt', text: '#lang racket/base\n\n(define-syntax-rule (keep a) (let ([x a]) x))\n(keep 1)\n', selections: [
    ['introduced-x', 'x))', 'after', 1, 'none', false],
    ['original-keep', 'keep a', 'after', 1, phaseBinding(0, 'this module', 'this module'), true],
    ['literal-one', '1)', 'after', 1, 'Not applicable', true],
    ['compound-keep-call', '(keep 1)', 'before', 1, 'Not applicable', true]
  ] },
  { file: 'main.rkt', text: '#lang racket/base\n(require "lib.rkt")\n' +
      '(define-syntax-rule (percent v) (clamp v 0 100))\n' +
      '(define (show n) (when-positive n (percent n)))\n(show 150)\n', selections: [
    ['imported-clamp', 'clamp v', 'after', 1, phaseBinding(0, '"lib.rkt"', '"lib.rkt"'), true],
    ['introduced-value', 'value))', 'after', 3, 'none', false, 'lib.rkt'],
    ['original-n', 'n) (when', 'after', 1, 'In phase 0: lexical', true]
  ] },
  { file: 'details-fixture.rkt', text: '#lang racket/base\n(require (for-syntax racket/base))\n' +
      '(define-syntax (annotate stx)\n  (syntax-case stx ()\n    [(_ input)\n' +
      "     (syntax-property #'(let ([introduced input]) (list introduced input))\n" +
      "                      'review-note '(alpha 7))]))\n" +
      '(define original 11)\n(annotate original)\n(or #f original)\n(when original (void))\n', selections: [
    ['property-bearing-compound', '(let ([introduced input])', 'after', 1, 'Not applicable', false],
    ['introduced-identifier', 'introduced input))', 'after', 1, 'none', false],
    ['original-identifier', 'original (void)', 'after', 1, phaseBinding(0, 'this module', 'this module'), true],
    ['imported-identifier', 'void)', 'after', 1, [0, 1].map(p => phaseBinding(p, '(quote #%runtime)', base)).join('\n'), true],
    ['literal', '11)', 'after', 1, 'Not applicable', true],
    ['original-compound', '(annotate original)', 'before', 1, 'Not applicable', true]
  ] }
];

for (const fixture of fixtures) test(`recorded details selections: ${fixture.file}`, async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-details-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const library = '#lang racket/base\n(provide clamp when-positive)\n' +
    '(define-syntax-rule (when-positive n body) (when (> n 0) body))\n' +
    '(define-syntax-rule (clamp x low high) (let ([value x]) value))\n';
  fs.writeFileSync(path.join(directory, 'lib.rkt'), library);
  const source = path.join(directory, fixture.file);
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(fixture.text).digest('hex'), sourceVersion: 1 };
  const session = createMacroSession(racket, helper, { ...request(fixture.text, 'module'), source, sourceIsFile: true,
    directory, schemaVersion: 2, session: true, snapshot });
  t.after(() => session.stop());
  const summary = await session.start();
  assert.equal(summary.failed, undefined);
  for (const [name, needle, side, position, apparent, original, sourceFile = fixture.file] of fixture.selections) {
    const text = sourceFile === 'lib.rkt' ? library : fixture.text;
    const sourcePosition = text.indexOf(needle) + 1;
    assert.ok(sourcePosition > 0, name);
    const projection = await session.request({ mode: 'position', snapshot, position, panes: true });
    assert.equal(projection.failed, undefined, name);
    const occurrence = projection.record[side].occurrences.findLast(o => {
      const term = projection.terms[o.syntaxId];
      return term.source?.position === sourcePosition &&
        projection.sources[term.source.sourceId]?.value === path.join(directory, sourceFile);
    });
    assert.ok(occurrence, name);
    const inspection = await session.request({ mode: 'inspect', snapshot, position, term: occurrence.syntaxId });
    const term = decodeTerm(inspection.shared, inspection.termData);
    const view = panel(term, inspection.sources, text);
    assert.deepEqual(view.page.inspector.children.map(c => [c.dataset.name, c.children[0].textContent, c.open]), sections, name);
    assert.equal(view.body('binding').textContent, apparent, name);
    const bindingPhases = fixture.file === 'details-fixture.rkt' ? [0, 1] : [0];
    for (const key of ['top', 'app', 'datum']) {
      const defined = key === 'app' ? '(lib "racket/private/kw.rkt")' : core;
      assert.equal(view.body(`implicit-${key}`).textContent,
        bindingPhases.map(p => phaseBinding(p, defined, base, key === 'app' ? 'new-app' : '')).join('\n'), name);
    }
    assert.equal(view.body('builtins').textContent,
      `Tamper status: unarmed\nSource module: ${sourceFile === 'lib.rkt' ? '"lib.rkt"' : 'this module'}\nOriginal?: ${original ? '#t' : '#f'}`, name);
    const sourcePath = path.join(directory, sourceFile).replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
    assert.match(view.body('source').textContent, new RegExp(`^${sourcePath}, Ln \\d+, Col \\d+ to Ln \\d+, Col \\d+$`), name);
    assert.match(view.body('scopes').textContent, /^Scopes at phase 0:\n/);
    assert.doesNotMatch(view.body('scopes').textContent, /phase 1:|phase label:|scope\d|Inspected phases/);
    for (const scope of term.scopes.find(s => s.phase === 0).scopes) assert.match(scope.description, /^#\([^ ]+ (module|macro|local|use-site|intdef)/);
    if (name === 'property-bearing-compound') {
      assert.equal(view.body('properties').textContent,
        "review-note: '(alpha 7)\norigin: '(#<syntax:details-fixture.rkt:9:1 annotate>)");
      assert.equal(term.inspectionStatus, 'complete');
    } else assert.equal(view.body('properties').textContent, 'No additional properties available.', name);
    assert.doesNotMatch(view.page.inspector.textContent, /Current term|Bindings at inspected phases|BindingId|Inspection:|originalName|definitionPhase/);
  }
});

test('scope links reveal phase pairs in window order, hide them again and reset on selection', () => {
  const phases = [0, 1, -1, 'label', 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
  const term = { kind: 'atom', bindings: [], implicitBindings: { top: [], app: [], datum: [] }, properties: [], builtins: { tamperStatus: 'unarmed', original: false },
    inspectedPhases: phases, scopes: phases.map(phase => ({ phase, status: 'known', scopes: [{ id: 'scope123', kind: 'module', description: '#(123 module)' }] })) };
  const view = panel(term, {}, '');
  assert.equal(view.body('scopes').textContent, 'Scopes at phase 0:\n#(123 module)Show scopes at more phases.');
  for (let depth = 1; depth <= 6; depth++) {
    view.link('more-phases').listeners.click({ preventDefault() {} });
    assert.deepEqual(plain(view.sent.at(-1)), { type: 'morePhases', phases: [depth, -depth] });
    const order = [0, ...Array.from({ length: depth }, (_, i) => i + 1), ...Array.from({ length: depth }, (_, i) => -i - 1)];
    assert.deepEqual([...view.body('scopes').textContent.matchAll(/Scopes at phase (-?\d+):/g)].map(m => Number(m[1])), order);
    assert.match(view.body('scopes').textContent, /Show scopes at more phases \| fewer phases\.$/);
    assert.doesNotMatch(view.body('scopes').textContent, /scope123|label/);
  }
  for (let i = 0; i < 6; i++) view.link('fewer-phases').listeners.click({ preventDefault() {} });
  assert.equal(view.sent.length, 6, 'Fewer phases uses cached facts');
  assert.equal(view.link('fewer-phases'), undefined);
  view.link('more-phases').listeners.click({ preventDefault() {} });
  view.page.selected.syntaxId = 'another-term'; view.page.renderInspector();
  assert.equal(view.link('fewer-phases'), undefined);
  assert.doesNotMatch(view.body('scopes').textContent, /phase 1:/);
});

test('scope phase requests are validated and forwarded to the retained worker', async t => {
  const action = message('morePhases', { phases: [6, -6] });
  assert.equal(Protocol.validateAction(action, envelope), action);
  for (const phases of ['6', ['label'], [1.5], [Number.MAX_SAFE_INTEGER + 1], Array(257).fill(1)]) {
    assert.throws(() => Protocol.validateAction(message('morePhases', { phases }), envelope), /Invalid inspection phases/);
  }
  const ui = fakeStepper(); t.after(() => ui.dispose()); await opened(ui);
  const pane = ui.panels[0], worker = ui.pending[0];
  pane.send('select', pair()); await tick();
  pane.send('morePhases', { phases: [6, -6] }); await tick();
  assert.deepEqual(plain(worker.queries.at(-1).phases), [6, -6]);
});

test('transformer context captions keep the recorded wording in sentence case', async t => {
  const text = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    '(define-syntax (outer stx) (local-expand #\'(missing) \'expression null))\n(outer)\n';
  const snapshot = { sourceHash: require('node:crypto').createHash('sha256').update(text).digest('hex'), sourceVersion: 1 };
  const session = createMacroSession(racket, helper, { ...request(text, 'module'), schemaVersion: 2, session: true, snapshot });
  t.after(() => session.stop());
  const summary = await session.start();
  let captions = [];
  for (let position = 1; position <= summary.stepCount; position++) {
    const reply = await session.request({ mode: 'position', snapshot, position });
    captions.push(...reply.record.contexts.map(c => c.label));
  }
  assert.ok(captions.length);
  assert.deepEqual([...new Set(captions)], ['While executing macro transformer in:']);
});
