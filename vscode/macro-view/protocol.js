// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
(function (root) {
  'use strict';
  const VERSION = 1, LIMIT = 64 * 1024 * 1024, CHUNK = 256 * 1024, ACTION_LIMIT = 16 * 1024;
  const bytes = text => new TextEncoder().encode(text).length;
  const id = x => typeof x === 'string' && x.length > 0 && x.length <= 200;
  const pair = x => x === null || (x && id(x.sectionId) && id(x.occurrenceId) && Object.keys(x).length === 2);
  const shapes = {
    navigate: ['action', 'position', 'key', 'clientInstanceId', 'navigationSequence'], setHiding: ['mode', 'clearLineReveal'], refresh: [], internalDetails: [], openSavedSource: [], retry: [],
    select: ['sectionId', 'occurrenceId', 'textSelections'], inspect: ['sectionId', 'occurrenceId'], pin: ['action', 'sectionId', 'occurrenceId'],
    copyTerm: [], goToSource: [], definition: [], references: [], morePhases: ['phases'],
    presentation: ['propertiesVisible', 'splitFraction', 'expandedSections'],
    focus: ['focusWithin', 'inputFocus', 'focusedOccurrence', 'menuOpen'],
    transferAck: ['transferId', 'lastSequence', 'success', 'reason'],
    rendered: ['transferId', 'sections', 'focus', 'mounted', 'observation'],
    testResult: ['replyTo', 'observation']
  };
  const envelope = ['v', 'type', 'sessionId', 'generation', 'positionRevision', 'requestId'];
  function validateAction(m, state) {
    if (!m || bytes(JSON.stringify(m)) > ACTION_LIMIT || m.v !== VERSION) throw Error('Invalid message version or size');
    if (m.type === 'ready') {
      if (!id(m.clientInstanceId) || Object.keys(m).some(k => !['v', 'type', 'clientInstanceId'].includes(k))) throw Error('Invalid ready');
      return m;
    }
    const allowed = shapes[m.type];
    if (!allowed || Object.keys(m).some(k => !envelope.includes(k) && !allowed.includes(k)) || !id(m.requestId) ||
        m.sessionId !== state.sessionId || m.generation !== state.generation || m.positionRevision !== state.positionRevision) throw Error('Unknown or stale request');
    switch (m.type) {
      case 'navigate': if (!id(m.clientInstanceId) || !Number.isSafeInteger(m.navigationSequence) || m.navigationSequence < 1 ||
        !['start', 'previous', 'next', 'end', 'jump'].includes(m.action) ||
        (m.key !== undefined && (m.key !== 'F10' || m.action !== 'next')) ||
        (m.action === 'jump' && !(Number.isSafeInteger(m.position) || typeof m.position === 'string' && m.position.length <= 32))) throw Error('Invalid navigation'); break;
      case 'setHiding': if (!['standard', 'disable'].includes(m.mode) || m.clearLineReveal !== undefined && typeof m.clearLineReveal !== 'boolean') throw Error('Invalid hiding'); break;
      case 'select':
        if (m.textSelections !== undefined && (!Array.isArray(m.textSelections) || m.textSelections.length > 256 || !m.textSelections.every(r =>
          Array.isArray(r) && r.length === 2 && r.every(Number.isSafeInteger) && r[0] >= 0 && r[1] >= r[0]))) throw Error('Invalid text selection');
        if (!pair({ sectionId: m.sectionId, occurrenceId: m.occurrenceId }) && !(m.sectionId === null && m.occurrenceId === null)) throw Error('Invalid selection'); break;
      case 'inspect': if (!pair({ sectionId: m.sectionId, occurrenceId: m.occurrenceId })) throw Error('Invalid inspection'); break;
      case 'pin': if (!['tack', 'release', 'clear'].includes(m.action) || m.action !== 'clear' && !pair({ sectionId: m.sectionId, occurrenceId: m.occurrenceId })) throw Error('Invalid pin'); break;
      case 'morePhases': if (m.phases !== undefined && (!Array.isArray(m.phases) || m.phases.length > 256 || !m.phases.every(Number.isSafeInteger))) throw Error('Invalid inspection phases'); break;
      case 'presentation':
        if (m.propertiesVisible !== undefined && typeof m.propertiesVisible !== 'boolean' ||
            m.splitFraction !== undefined && !(m.splitFraction >= .2 && m.splitFraction <= .7) ||
            m.expandedSections !== undefined && (!Array.isArray(m.expandedSections) || m.expandedSections.length > 16 || !m.expandedSections.every(id))) throw Error('Invalid presentation'); break;
      case 'focus': if (typeof m.focusWithin !== 'boolean' || typeof m.inputFocus !== 'boolean' || m.menuOpen !== undefined && typeof m.menuOpen !== 'boolean' || !pair(m.focusedOccurrence)) throw Error('Invalid focus'); break;
      case 'transferAck': if (!id(m.transferId) || !Number.isSafeInteger(m.lastSequence) || typeof m.success !== 'boolean' || m.reason !== undefined && (typeof m.reason !== 'string' || m.reason.length > 200)) throw Error('Invalid acknowledgement'); break;
      case 'rendered': if (!id(m.transferId) || !Array.isArray(m.sections) || !m.sections.every(id) || !pair(m.focus) || typeof m.mounted !== 'boolean') throw Error('Invalid render report'); break;
    }
    return m;
  }
  const hostShapes = {
    init: ['pairId', 'sourceName', 'source', 'wholeFile', 'range', 'testEnabled', 'editorSettings'],
    state: ['position', 'count', 'busy', 'atStart', 'atEnd', 'hiding', 'lineReveal', 'note', 'selected', 'pins',
      'propertiesVisible', 'splitFraction', 'highlightRedexContractum', 'drawBindingArrows', 'taintIcons', 'oneTermAtATime', 'factorCommonContext', 'hasSelection', 'hasSource', 'refreshAvailable', 'source', 'wholeFile', 'range', 'savedSourceAvailable', 'error'],
    sourceStatus: ['stale', 'reason', 'refreshAvailable'],
    positionBegin: ['transferId', 'payloadKind', 'totalBytes', 'chunkCount'],
    positionChunk: ['transferId', 'sequence', 'chunk'], positionCommit: ['transferId', 'totalBytes'],
    transferAbort: ['transferId', 'reason', 'retryable'], actionResult: ['replyTo', 'success', 'message'],
    clear: [], collapseSelection: [], focusTarget: ['target'], bindingFacts: ['target', 'bindings'], testDrive: ['operation', 'pane']
  };
  function validateHost(m, state) {
    const shape = m && hostShapes[m.type];
    if (!shape || m.v !== VERSION || !id(m.sessionId) || !id(m.requestId) ||
        !Number.isSafeInteger(m.generation) || m.generation < 0 || !Number.isSafeInteger(m.positionRevision) || m.positionRevision < 0 ||
        bytes(JSON.stringify(m)) > CHUNK || Object.keys(m).some(k => !envelope.includes(k) && !shape.includes(k))) throw Error('Invalid host message');
    if (state && (m.sessionId !== state.sessionId || m.generation < state.generation ||
        m.generation === state.generation && m.positionRevision < state.positionRevision || m.type !== 'init' && m.generation !== state.generation)) throw Error('Stale host message');
    if (m.type === 'init' && m.editorSettings && (!Number.isSafeInteger(m.editorSettings.tabSize) || m.editorSettings.tabSize < 1 || m.editorSettings.tabSize > 32 ||
      typeof m.editorSettings.lineHeight !== 'number' || m.editorSettings.lineHeight < 0 || m.editorSettings.lineHeight > 150)) throw Error('Invalid editor settings');
    if (m.type === 'state' && (!Number.isSafeInteger(m.position) || !Number.isSafeInteger(m.count) || m.position < 1 || m.position > m.count ||
      !Array.isArray(m.pins) || m.pins.length > 256 || !m.pins.every(pin => pin && pair({ sectionId: pin.sectionId, occurrenceId: pin.occurrenceId }) &&
        Object.keys(pin).every(key => ['sectionId', 'occurrenceId', 'edgeIds'].includes(key)) &&
        (pin.edgeIds === undefined || Array.isArray(pin.edgeIds) && pin.edgeIds.every(id))) || !pair(m.selected) ||
      m.highlightRedexContractum !== undefined && typeof m.highlightRedexContractum !== 'boolean' ||
      m.drawBindingArrows !== undefined && typeof m.drawBindingArrows !== 'boolean' ||
      m.taintIcons !== undefined && !['codicons', 'unicode', 'none'].includes(m.taintIcons) ||
      m.oneTermAtATime !== undefined && typeof m.oneTermAtATime !== 'boolean' ||
      m.factorCommonContext !== undefined && typeof m.factorCommonContext !== 'boolean')) throw Error('Invalid view state');
    if (m.type === 'sourceStatus' && (typeof m.stale !== 'boolean' || typeof m.refreshAvailable !== 'boolean' || typeof m.reason !== 'string')) throw Error('Invalid source status');
    if (m.type === 'focusTarget' && m.target !== 'jump' && !pair(m.target)) throw Error('Invalid focus target');
    if (m.type === 'bindingFacts' && (!pair(m.target) || !Array.isArray(m.bindings))) throw Error('Invalid binding facts');
    return m;
  }
  // Each envelope, including escaping overhead, fits the transport ceiling.
  function chunks(value, envelopeBytes = 1024) {
    const json = JSON.stringify(value);
    if (bytes(json) > LIMIT) throw Error('Position exceeds the answer limit');
    const result = []; let chunk = '', size = 2;
    for (const scalar of json) {
      const cost = bytes(JSON.stringify(scalar)) - 2;
      if (size + cost + envelopeBytes > CHUNK) { result.push(chunk); chunk = ''; size = 2; }
      chunk += scalar; size += cost;
    }
    if (chunk) result.push(chunk);
    return { chunks: result, totalBytes: bytes(json) };
  }
  class Receiver {
    constructor(validate = x => x) { this.validate = validate; }
    abort() { this.pending = null; }
    begin(m) {
      this.abort();
      if (!id(m.transferId) || !['position', 'selection', 'colors'].includes(m.payloadKind) ||
          !Number.isSafeInteger(m.totalBytes) || m.totalBytes < 0 || m.totalBytes > LIMIT ||
          !Number.isSafeInteger(m.chunkCount) || m.chunkCount < 1 || m.chunkCount > 1024) throw Error('Invalid transfer');
      this.pending = { ...m, chunks: [], received: 0 };
      return -1;
    }
    chunk(m) {
      const p = this.pending;
      if (!p || m.transferId !== p.transferId || m.sequence !== p.chunks.length || p.chunks.length >= p.chunkCount ||
          typeof m.chunk !== 'string' || bytes(JSON.stringify(m)) > CHUNK) { this.abort(); throw Error('Out of order transfer'); }
      p.received += bytes(m.chunk);
      if (p.received > p.totalBytes) { this.abort(); throw Error('Transfer exceeds declared size'); }
      p.chunks.push(m.chunk); return m.sequence;
    }
    commit(m) {
      const p = this.pending; this.abort();
      if (!p || p.transferId !== m.transferId || p.chunks.length !== p.chunkCount ||
          p.received !== p.totalBytes || m.totalBytes !== p.totalBytes) throw Error('Incomplete transfer');
      return { kind: p.payloadKind, value: this.validate(JSON.parse(p.chunks.join('')), p.payloadKind), sequence: p.chunkCount };
    }
  }
  const api = { VERSION, LIMIT, CHUNK, ACTION_LIMIT, bytes, validateAction, validateHost, chunks, Receiver };
  if (typeof module === 'object') module.exports = api; else root.MacroProtocol = api;
})(globalThis);
