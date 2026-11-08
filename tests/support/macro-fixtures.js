// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Builds worker answers, projections and lightweight editor models.
'use strict';
const Model = require('../../vscode/macro-view/model');
const Data = require('../../vscode/macro-view-data');
const { decodeTerm } = require('../../vscode/macro-stepper-codec');
function fakeModel(text) {
  const starts = Model.lineStarts(text), lines = text.split('\n');
  return { getPositionAt(offset) { const n = Model.lineAt(starts, offset); return { lineNumber: n + 1, column: offset - starts[n] + 1 }; },
    getOffsetAt(p) { return starts[p.lineNumber - 1] + p.column - 1; },
    getLineMaxColumn(n) { return lines[n - 1].length + 1; }, getValue: () => text,
    getValueInRange(r) { return text.slice(this.getOffsetAt({ lineNumber: r.startLineNumber, column: r.startColumn }), this.getOffsetAt({ lineNumber: r.endLineNumber, column: r.endColumn })); } };
}
function fixtureAnswer(snapshot, result = '(x x)\n') {
  const term = { kind: 'identifier', name: [0], relations: [1], inspectedPhases: [2] };
  const shared = ['x', { bound: [0], free: [0] }, [0], term, { kind: 'compound', inspectedPhases: [2] }];
  const part = id => ({ id, text: result, focus: [[1, 2], [3, 4]], binderOccurrences: ['b'],
    occurrences: [{ id: 'root', syntaxId: 'compound', parentId: null, range: [0, 5], delimiterRanges: [[0, 1], [4, 5]], phase: null, macroScopeGroup: 0 },
      { id: 'b', syntaxId: 'x', parentId: 'root', range: [1, 2], delimiterRanges: [], phase: 0, macroScopeGroup: 0 },
      { id: 'r', syntaxId: 'x', parentId: 'root', range: [3, 4], delimiterRanges: [], phase: 0, macroScopeGroup: 0 }],
    edges: [{ id: 'edge', binder: 'b', reference: 'r', certainty: 'definite', phase: 0 }] });
  return { schemaVersion: 2, snapshot, termEncoding: 'shared-v1', shared, terms: { x: 3, compound: 4 }, sources: {}, diagnostics: {},
    relationPhase: 0, inspectedPhases: [0], availablePhases: [0, 1, -1, 'label'], capabilities: Data.capabilities,
    steps: [1, 2].map(n => ({ id: `s${n}`, label: 'Macro transformation', macro: 'x', kind: 'rewrite',
      before: part(`b${n}`), after: part(`a${n}`), source: null, sourceFoci: [], contexts: [], error: null })), final: part('final'), error: null };
}
function summaryOf(a) {
  return { ...a, mode: 'summary', stepCount: a.steps.length, final: !!a.final,
    terms: undefined, shared: undefined, diagnostics: undefined,
    steps: a.steps.map(({ before, after, contexts, ...metadata }) => metadata) };
}
function project(a, position) {
  Model.jump(position, a.steps.length + 1);
  const record = a.steps[position - 1] || null, error = record?.error || (!record && a.error) || null;
  const p = { schemaVersion: 2, mode: 'position', snapshot: a.snapshot,
    tokenSections: {}, tokenStyles: [], themeName: 'test',
    position, count: a.steps.length + 1, record, final: record ? null : a.final,
    error, diagnostics: error ? { [error]: a.diagnostics[error] } : {}, terms: {}, sources: {},
    relationPhase: a.relationPhase, inspectedPhases: [], availablePhases: a.availablePhases };
  const source = location => { if (location?.sourceId && a.sources[location.sourceId]) p.sources[location.sourceId] = a.sources[location.sourceId]; };
  source(record?.source); record?.sourceFoci?.forEach(source);
  for (const { section } of Model.sections(p)) for (const o of section.occurrences) {
    const term = decodeTerm(a.shared, a.terms[o.syntaxId], ['kind', 'name', 'source', 'relations', 'artificial']);
    p.terms[o.syntaxId] = term; source(term.source);
  }
  return p;
}
const pair = (sectionId = 'b1', occurrenceId = 'b') => ({ sectionId, occurrenceId });
const envelope = { v: 1, sessionId: 'session', generation: 2, positionRevision: 3 };
const message = (type, fields = {}) => ({ ...envelope, type, requestId: 'req1',
  ...(type === 'navigate' ? { clientInstanceId: 'client', navigationSequence: 1 } : {}), ...fields });
module.exports = { fakeModel, fixtureAnswer, summaryOf, project, pair, envelope, message };
