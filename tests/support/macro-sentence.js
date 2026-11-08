// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Builds binding-sentence fixtures and checks their wording.
'use strict';
const { project, fixtureAnswer, fakeModel, pair } = require('./macro-fixtures');
const Model = require('../../vscode/macro-view/model');
const Editor = require('../../vscode/macro-view/monaco');
const assert = require('node:assert/strict');
function sentenceFixture(side = 'before') {
  const p = project(fixtureAnswer({}), 1);
  p.pane = side; p.record.macro = 'swap!';
  const section = p.record[side];
  section.text = '; 😀\r\n'.repeat(20) + 'tmp\r\n tmp tmp\r\n tmp\r\n unused unless alias zzz\r\n';
  const names = [...section.text.matchAll(/tmp|unused|unless|alias|zzz/g)];
  const ids = ['binder', 'use', 'same-line', 'later', 'unused', 'import', 'renamed', 'unbound'];
  section.occurrences = names.map((match, i) => ({ id: ids[i], syntaxId: ids[i], parentId: null,
    range: [match.index, match.index + match[0].length], delimiterRanges: [], macroScopeGroup: 0, phase: 0 }));
  section.focus = [];
  section.binderOccurrences = ['binder', 'unused'];
  section.edges = ['use', 'same-line', 'later'].map(reference => ({
    id: reference, binder: 'binder', reference, certainty: 'definite', phase: 0
  }));
  for (const [i, id] of ids.entries()) p.terms[id] = { kind: 'identifier', name: names[i][0], source: { line: 900 + i } };
  return p;
}
const moduleBinding = { phase: 0, status: 'known', kind: 'module',
  definedIn: 'racket/private/cond', importedFrom: 'racket/base', originalName: 'unless' };
const sentenceCases = [
  ['a use', 'use', null, null, '`tmp` on line 22 refers to `tmp` on line 21.'],
  ['a binder with deduplicated use lines', 'binder', null, null, '`tmp` on line 21 is used on lines 22 and 23.'],
  ['one use line', 'binder', null, p => p.record.before.edges.splice(1), '`tmp` on line 21 is used on line 22.'],
  ['three use lines', 'binder', null, p => {
    const s = p.record.before; s.text += ' tmp';
    s.occurrences.push({ ...s.occurrences[1], id: 'last', range: [s.text.length - 3, s.text.length] });
    s.edges.push({ ...s.edges[0], reference: 'last' });
  }, '`tmp` on line 21 is used on lines 22, 23 and 25.'],
  ['an unused binder', 'unused', null, null, '`unused` on line 24 is not used here.'],
  ['an import', 'import', [moduleBinding], null, '`unless` comes from `racket/private/cond`, imported through `racket/base`.'],
  ['a renamed import', 'renamed', [moduleBinding], null, '`alias` comes from `racket/private/cond` as `unless`, imported through `racket/base`.'],
  ['an import through its defining module', 'import', [{ ...moduleBinding, importedFrom: moduleBinding.definedIn }], null, '`unless` comes from `racket/private/cond`.'],
  ['an unknown import route', 'import', [{ ...moduleBinding, importedFrom: null, originalName: null }], null, '`unless` comes from `racket/private/cond`.'],
  ['an unknown defining module', 'import', [{ ...moduleBinding, definedIn: null }], null, '`unless` is imported through `racket/base`.'],
  ['unknown import details', 'import', [{ ...moduleBinding, definedIn: null, importedFrom: null }], null, '`unless` is imported.'],
  ['an unbound name', 'unbound', [{ phase: 0, status: 'absent' }], null, '`zzz` is not bound here.'],
  ['a macro-introduced use', 'use', null, p => p.record.before.occurrences[1].macroScopeGroup = 2,
    '`tmp` on line 22 refers to `tmp` on line 21, introduced by `swap!`.'],
  ['an unknown macro', 'use', null, p => { p.record.before.occurrences[1].macroScopeGroup = 2; p.record.macro = null; },
    '`tmp` on line 22 refers to `tmp` on line 21.'],
  ['a compile-time use', 'use', null, p => p.record.before.edges[0].phase = 1,
    '`tmp` on line 22 refers to `tmp` on line 21 at compile time.'],
  ['a documentation use', 'use', null, p => p.record.before.edges[0].phase = 'label',
    '`tmp` on line 22 refers to `tmp` on line 21 for documentation only.'],
  ['another phase', 'use', null, p => p.record.before.edges[0].phase = -2,
    '`tmp` on line 22 refers to `tmp` on line 21 at phase -2.'],
  ['a possible binding', 'use', null, p => { p.record.before.edges[0].certainty = 'possible'; p.record.before.edges[0].phase = null; },
    '`tmp` on line 22 refers to `tmp` on line 21.'],
  ['a binder with possible uses', 'binder', null, p => p.record.before.edges[1].certainty = 'possible',
    '`tmp` on line 21 is used on lines 22 and 23.'],
  ['combined qualifications', 'use', null, p => {
    Object.assign(p.record.before.edges[0], { certainty: 'possible', phase: 1 });
    p.record.before.occurrences[1].macroScopeGroup = 3;
  }, '`tmp` on line 22 refers to `tmp` on line 21 at compile time, introduced by `swap!`.'],
  ['an imported phase', 'import', [{ ...moduleBinding, phase: 'label' }], p => p.record.before.occurrences[5].phase = 'label',
    '`unless` comes from `racket/private/cond`, imported through `racket/base` for documentation only.'],
  ['an unused compile-time binder', 'unused', null, p => p.record.before.occurrences[4].phase = 1,
    '`unused` on line 24 is not used here at compile time.'],
  ['an uninspected name', 'import', undefined, null, ''],
  ['unavailable facts', 'import', [{ phase: 0, status: 'unavailable' }], null, ''],
  ['no name', null, null, null, ''],
  ['a compound term', 'use', null, p => p.terms.use.kind = 'compound', '']
];
function checkSentenceCase(entry, formatter = Model.bindingSentence) {
  const [description, occurrenceId, bindings, change, expected] = entry, p = sentenceFixture();
  change?.(p);
  const combined = Editor.compose(Model.sections(p)), model = fakeModel(combined.text);
  const number = Editor.lineNumbers(model, combined.parts);
  const result = formatter(p, occurrenceId && pair(p.record.before.id, occurrenceId), { bindings,
    lineNumber: (section, occurrence) => number(model.getPositionAt(combined.parts.find(p => p.section === section).offset(occurrence.range[0])).lineNumber)
  });
  assert.equal(result, expected, description);
}
module.exports = { sentenceFixture, moduleBinding, sentenceCases, checkSentenceCase };
