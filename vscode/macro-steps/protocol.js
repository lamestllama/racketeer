// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Validates page messages and delivers acknowledged transfers.
'use strict';
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const Model = require('../macro-view/model');
const Protocol = require('../macro-view/protocol');
function createProtocol(runtime) {
  const current = (v, generation = v.generation, revision) => !runtime.disposed && !v.disposed && v.generation === generation &&
    (revision === undefined || v.positionRevision === revision);
  const stateEnvelope = v => ({ v: 1, sessionId: v.sessionId, generation: v.generation, positionRevision: v.positionRevision });
  function post(v, type, fields = {}) {
    if (type === 'init') { fields.editorSettings = runtime.editorSettings(v); fields.pairId = runtime.owner(v).viewKey; }
    if (!v.ready || !current(v)) return Promise.resolve(false);
    return v.panel.webview.postMessage({ ...stateEnvelope(v), type, requestId: randomBytes(8).toString('hex'), ...fields });
  }
  function abortTransfer(v, reason, retryable = false) {
    const t = v.transfer; if (!t) return;
    if (t.kind === 'colors') v.recolorPending = true;
    clearTimeout(t.timer); v.transfer = null; t.reject?.(Error(reason));
    void post(v, 'transferAbort', { transferId: t.id, reason, retryable });
  }
  async function transfer(v, value, kind = 'position') {
    abortTransfer(v, 'Replaced by a newer display');
    if (!v.ready) return;
    const encoded = Protocol.chunks(value), gen = v.generation, rev = v.positionRevision;
    const t = { id: randomBytes(12).toString('hex'), expected: -1, kind }; v.transfer = t;
    const send = async (type, fields, expected) => {
      if (!current(v, gen, rev) || v.transfer !== t) throw Error('Display changed');
      t.expected = expected;
      const ack = new Promise((resolve, reject) => { t.resolve = resolve; t.reject = reject;
        t.timer = setTimeout(() => reject(Error('Display transfer timed out. Use Refresh.')), 10000);  });
      if (!await post(v, type, { transferId: t.id, ...fields })) { clearTimeout(t.timer); t.reject(Error('View is unavailable')); }
      await ack; clearTimeout(t.timer);
    };
    try {
      await send('positionBegin', { payloadKind: kind, totalBytes: encoded.totalBytes, chunkCount: encoded.chunks.length }, -1);
      for (let sequence = 0; sequence < encoded.chunks.length; sequence++) await send('positionChunk', { sequence, chunk: encoded.chunks[sequence] }, sequence);
      await send('positionCommit', { totalBytes: encoded.totalBytes }, encoded.chunks.length);
      if (v.transfer === t) v.transfer = null;
      if (kind === 'position') { v.committedTransfer = t.id; v.colorReady = true; }
      return true;
    } catch (e) {
      if (v.transfer === t) { abortTransfer(v, e.message, true); void post(v, 'actionResult', { success: false, message: e.message }); }
    } finally {
      if (v.recolorPending && current(v)) queueMicrotask(() => { void runtime.recolor(v); });
    }
  }
  async function receive(v, raw) {
    let accepted = false;
    try {
      // A drive can change the current revision before its deferred reply arrives.
      // Only a known test request may answer against its original envelope.
      const drive = v.testEnabled && raw?.type === 'testResult' && v.testWaiters.get(raw.replyTo);
      // Navigation belongs to the live page and expansion, rather than the
      // projection it last saw. Earlier commands may already have advanced
      // the revision while this request was in transit.
      const envelope = stateEnvelope(v);
      if (raw?.type === 'navigate' && raw.clientInstanceId === v.client &&
          Number.isSafeInteger(raw.positionRevision) && raw.positionRevision >= v.clientRevision &&
          raw.positionRevision <= v.positionRevision) envelope.positionRevision = raw.positionRevision;
      const m = Protocol.validateAction(raw, drive ? drive.envelope : envelope); accepted = true;
      if (m.type === 'navigate') {
        if (m.clientInstanceId !== v.client) throw Error('Unknown navigation page');
        // Messages from a page are ordered. A repeated sequence is a replay,
        // including when the first request was a no-op at an endpoint.
        if (m.navigationSequence <= v.navigationSequence) return;
        v.navigationSequence = m.navigationSequence;
      }
      if (m.type === 'ready') {
        abortTransfer(v, 'View recreated');
        // Invalidate only this page's actions when its editor is recreated.
        if (v.client && v.client !== m.clientInstanceId) v.positionRevision++;
        if (v.client !== m.clientInstanceId) {
          v.clientRevision = v.positionRevision; v.navigationSequence = 0;
        }
        v.ready = true; v.client = m.clientInstanceId; v.rendered = null;
        await post(v, 'init', { sourceName: path.basename(v.source.fsPath || v.source.path), source: v.source.toString(), wholeFile: v.wholeFile, range: v.invocationSelection ? [v.invocationSelection.start.line, v.invocationSelection.start.character, v.invocationSelection.end.line, v.invocationSelection.end.character] : null, testEnabled: v.testEnabled });
        runtime.stale(v); return runtime.showPane(v);
      }
      if (m.type === 'transferAck') {
        const t = v.transfer;
        if (!t || m.transferId !== t.id || m.lastSequence !== t.expected) throw Error('Unexpected transfer acknowledgement');
        clearTimeout(t.timer); if (m.success) t.resolve(); else t.reject(Error(m.reason || 'Transfer rejected')); return;
      }
      if (m.type === 'rendered') {
        if (!v.projection || ![v.committedTransfer, v.transfer?.id].includes(m.transferId) || !m.sections.every(id => Model.sections(v.projection).some(s => s.section.id === id))) throw Error('Unknown rendered section');
        v.rendered = { ...m, position: v.position }; return;
      }
      if (m.type === 'testResult') {
        if (!v.testEnabled) throw Error('Test adapter unavailable');
        const waiter = v.testWaiters.get(m.replyTo);
        v.testWaiters.delete(m.replyTo); waiter?.resolve(m.observation); return;
      }
      const result = await runtime.action(v, m);
      if (current(v, m.generation, m.positionRevision)) await post(v, 'actionResult', { replyTo: m.requestId, success: true, message: typeof result === 'string' ? result : null });
    } catch (error) { if (!accepted || raw.type === 'ready' || current(v, raw.generation, raw.positionRevision)) void post(v, 'actionResult', { replyTo: raw?.requestId, success: false, message: error.message.slice(0, 200) }); }
  }
  return { post, current, transfer, abortTransfer, receive, stateEnvelope };
}
module.exports = { createProtocol };
