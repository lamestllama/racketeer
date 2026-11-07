// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { tick, plain, root, racket } = require('./support/macro-common');
const { fakeStepper, opened, fakeTimers } = require('./support/macro-stepper');
const { fakeSession, request } = require('./support/macro-worker');
const { createMacroSession } = require('../vscode/macro-steps/worker-session');
const { createMacroProcess } = require('../vscode/macro-process');
const Data = require('../vscode/macro-view-data');
const Model = require('../vscode/macro-view/model');
const worker = path.join(root, 'tests/support/macro-checkpoint-worker.rkt');
const stopMessage = 'Macro expansion was stopped because it took too many steps.';
const snapshot = { sourceHash: '0'.repeat(64), sourceVersion: 1 };
const checkpoint = (snapshot, count = 16) => ({ schemaVersion: 2, mode: 'checkpoint', snapshot, count });

test('the modal has exact wording, keeps both panes busy, and dismissal means Continue', async () => {
  for (const response of ['Continue', undefined, 'Stop']) {
    const ui = fakeStepper();
    try {
      let choose;
      const dialogs = [];
      ui.window.showWarningMessage = (...args) => { dialogs.push(args); return new Promise(resolve => { choose = resolve; }); };
      await ui.source('checkpoint'); const opening = ui.open(true); await tick();
      const process = ui.pending[0];
      ui.finish(process, checkpoint(process.request.snapshot)); await tick();
      assert.deepEqual(plain(dialogs), [[
        'Macro expansion has taken a suspiciously large number of steps.',
        { modal: true, detail: 'Click Stop to stop macro expansion and see the steps taken so far, or click Continue to let it run a bit longer.' },
        { title: 'Continue', isCloseAffordance: true }, { title: 'Stop' }
      ]]);
      const state = await ui.command('_observe');
      assert.equal(state.busy, true); assert.equal(state.count, undefined);
      for (const pane of ui.panels) {
        assert.match(pane.title, /Expanding/);
        assert.equal(pane.projection, undefined);
        assert.ok(!pane.messages.some(m => m.type === 'positionBegin'));
      }
      assert.equal(process.queries, undefined, 'No summary or position exchange overtakes the decision');
      choose(response === undefined ? undefined : { title: response }); await tick();
      assert.deepEqual(plain(process.queries), [{ mode: 'checkpointDecision', snapshot: plain(process.request.snapshot),
        count: 16, decision: response === 'Stop' ? 'stop' : 'continue' }]);
      assert.equal((await ui.command('_observe')).busy, true);
      ui.answer(process); await opening;
      assert.equal((await ui.command('_observe')).busy, false);
    } finally { ui.dispose(); }
  }
});

test('closing, Refresh, replacement and progress cancellation reap a pending worker and discard late decisions', async () => {
  for (const action of ['close', 'refresh', 'replace', 'cancel', 'exit']) {
    const ui = fakeStepper();
    try {
      let choose;
      ui.window.showWarningMessage = () => new Promise(resolve => { choose = resolve; });
      const document = await ui.source('cancelled'); const opening = ui.open(true); await tick();
      const process = ui.pending[0]; ui.finish(process, checkpoint(process.request.snapshot)); await tick();
      let replacing;
      if (action === 'close') ui.panels[0].dispose();
      if (action === 'refresh') replacing = ui.command('refresh');
      if (action === 'replace') { await ui.window.showTextDocument(document); replacing = ui.open(true); }
      if (action === 'cancel') ui.cancel();
      if (action === 'exit') process.handlers.finished();
      await tick(); await opening;
      if (action !== 'exit') assert.equal(process.stopped, true);
      choose({ title: 'Stop' }); await tick();
      assert.equal(process.queries, undefined, 'A stale response never reaches the closed lease');
      if (replacing) { assert.equal(ui.pending.length, 2); ui.answer(ui.pending[1]); await replacing; }
    } finally { ui.dispose(); }
  }
});

test('Refresh clears the old total while waiting at a new checkpoint', async () => {
  const ui = fakeStepper();
  try {
    await opened(ui); await ui.command('last');
    let choose;
    ui.window.showWarningMessage = () => new Promise(resolve => { choose = resolve; });
    const refreshing = ui.command('refresh'); await tick(); const process = ui.pending[1];
    ui.finish(process, checkpoint(process.request.snapshot)); await tick();
    assert.equal((await ui.command('_observe')).count, undefined);
    for (const pane of ui.panels) {
      assert.match(pane.title, /Expanding/);
      const state = pane.messages.findLast(m => m.type === 'state');
      assert.equal(state.busy, true); assert.equal(state.position, 1); assert.equal(state.count, 1);
    }
    choose({ title: 'Continue' }); await tick(); ui.answer(process); await refreshing;
  } finally { ui.dispose(); }
});

test('checkpoint events do not resolve the request or unblock queued history requests', async () => {
  let choose;
  const f = fakeSession({ checkpoint: () => new Promise(resolve => { choose = resolve; }) });
  try {
    const opening = f.session.start(); let answered = false; opening.then(() => { answered = true; });
    const position = f.session.request({ mode: 'position', position: 1 });
    f.reply(JSON.stringify(checkpoint(undefined)) + '\n'); await tick();
    assert.equal(answered, false); assert.deepEqual(f.sent, []);
    choose(undefined); await tick();
    assert.equal(f.sent[0].decision, 'continue'); assert.equal(answered, false);
    f.reply('{"mode":"summary"}\n'); await opening; await tick();
    assert.equal(f.sent[1].mode, 'position'); f.reply('{"mode":"position"}\n'); await position;
  } finally { await f.session.stop(); }
});

test('resource failures after Continue retain their original failure codes and messages', async () => {
  for (const [failureCode, failed] of [['memory', 'Showing these macro steps would need more than 1 GB of memory.'],
    ['answer-size', 'These macro steps are too long to show.']]) {
    const f = fakeSession({ checkpoint: async () => 'continue' });
    try {
      const opening = f.session.start();
      f.reply(JSON.stringify(checkpoint(undefined)) + '\n'); await tick();
      f.reply(JSON.stringify({ failed, failureCode }) + '\n');
      assert.deepEqual(await opening, { failed, failureCode });
      assert.equal(f.sent[0].decision, 'continue'); assert.notEqual(failed, stopMessage);
    } finally { await f.session.stop(); }
  }
});

test('terminal failures during a pending decision retain diagnostics, reap, and ignore late answers', async () => {
  for (const failure of [{ failed: 'Memory exhausted', failureCode: 'memory' },
    { failed: 'Answer too long', failureCode: 'answer-size' },
    { failed: 'Worker failed', failureCode: 'expansion' }, { failed: 'Worker failed' }]) {
    for (const late of ['stop', 'continue']) {
      let choose;
      const f = fakeSession({ checkpoint: () => new Promise(resolve => { choose = resolve; }) });
      const opening = f.session.start();
      f.reply(JSON.stringify(checkpoint(undefined)) + '\n'); await tick();
      f.reply(JSON.stringify(failure) + '\n');
      assert.deepEqual(await opening, failure); assert.equal(f.stopped, 1);
      choose(late); await tick(); assert.deepEqual(f.sent, []);
      await assert.rejects(f.session.request({ mode: 'position' }), /expired/);
    }
  }
});

test('a checkpoint with the same version and a different source hash is rejected before prompting', async () => {
  let prompts = 0;
  let output, stopped = false;
  const session = createMacroSession('unused', [], { snapshot }, {
    checkpoint() { prompts++; return 'stop'; },
    factory(_command, _helper, _request, handlers) {
      output = handlers.output;
      return { start() {}, send() { return true; }, stop() { stopped = true; handlers.finished(); return Promise.resolve(); } };
    }
  });
  try {
    const opening = session.start().catch(error => error);
    output(JSON.stringify(checkpoint({ ...snapshot, sourceHash: '1'.repeat(64) })) + '\n');
    await tick(); assert.equal(prompts, 0); assert.equal(stopped, true);
    assert.match((await opening).message, /unreadable/);
  } finally { await session.stop(); }
});

test('cancellation before dispatch suppresses the prompt and malformed checkpoints close the lease', async () => {
  let prompts = 0;
  const f = fakeSession({ checkpoint: async () => { prompts++; return 'continue'; } });
  const opening = f.session.start(), rejected = assert.rejects(opening, /closed/);
  f.reply(JSON.stringify(checkpoint(undefined)) + '\n'); await f.session.stop(); await rejected; await tick();
  assert.equal(prompts, 0); assert.deepEqual(f.sent, []);
  for (const event of [{ ...checkpoint(undefined), count: 0 },
    { ...checkpoint(undefined), snapshot }, { ...checkpoint(undefined), schemaVersion: 1 }]) {
    const invalid = fakeSession({ checkpoint: async () => { prompts++; return 'stop'; } });
    const result = invalid.session.start(), rejected = assert.rejects(result, /unreadable/);
    invalid.reply(JSON.stringify(event) + '\n'); await rejected;
    assert.equal(invalid.stopped, 1); assert.equal(prompts, 0);
  }
});

test('the page hides previously rendered terms until an answer arrives', () => {
  const { fakeMacroPage } = require('./support/macro-page');
  const { page } = fakeMacroPage();
  page.state = { busy: true, refreshAvailable: true };
  page.updateState();
  assert.equal(page.work.hidden, true); assert.equal(page.connections.hidden, true);
  assert.equal(page.note.textContent, '');
  page.state.busy = false; page.updateState();
  assert.equal(page.work.hidden, false); assert.equal(page.connections.hidden, false);
  assert.equal(page.note.textContent, '');
});

test('a real looping worker waits, doubles checkpoints, and returns a navigable stopped prefix without replay', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-checkpoint-'));
  const marker = path.join(directory, 'effects');
  const text = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    '(begin-for-syntax (define effects 0))\n' +
    '(define-syntax (forever stx) (set! effects (add1 effects))\n' +
    `(call-with-output-file ${JSON.stringify(marker)} #:exists 'append (lambda (out) (displayln effects out)))\n` +
    "#'(forever))\n(forever)\n";
  const seen = []; let decide, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const session = createMacroSession(racket, worker, { ...request(text, 'module'), schemaVersion: 2, session: true, hiding: 'none', snapshot }, {
    checkpoint(event) {
      seen.push(event.count);
      if (event.count < 128) return 'continue';
      reached(); return new Promise(resolve => { decide = resolve; });
    }
  });
  t.after(async () => { await session.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  let delivered = false;
  const opening = session.start().then(answer => { delivered = true; return answer; });
  await waiting;
  assert.deepEqual(seen, [16, 32, 64, 128]); assert.equal(delivered, false);
  const effects = fs.readFileSync(marker, 'utf8'); await tick();
  assert.equal(fs.readFileSync(marker, 'utf8'), effects, 'The live transformer is suspended');
  const values = effects.trim().split('\n').map(Number);
  assert.deepEqual(values, Array.from({ length: values.length }, (_, i) => i + 1));
  decide('stop'); const summary = await opening; Data.validateAnswer(summary, snapshot);
  assert.equal(summary.final, false); assert.equal(summary.message, stopMessage);
  assert.ok(summary.steps.some(s => s.kind === 'rewrite' && s.macro === 'forever'));
  assert.equal(summary.steps.at(-1).kind, 'error');
  for (const position of [summary.stepCount, summary.stepCount + 1]) {
    const answer = await session.request({ mode: 'position', position, panes: true, snapshot });
    Data.validatePosition(answer, summary, position);
    assert.equal(answer.final, null);
    assert.equal(answer.diagnostics[answer.error].message, stopMessage);
    assert.equal(answer.diagnostics[answer.error].program, null);
    assert.ok(Model.sections({ ...answer, pane: 'after' }).every(s => s.label !== 'After' && s.label !== 'Expansion finished'));
    assert.equal(answer.record === null, position === summary.stepCount + 1);
  }
  const rewrite = summary.steps.findIndex(s => s.macro === 'forever') + 1;
  const before = await session.request({ mode: 'position', position: rewrite, snapshot });
  const occurrence = before.record.before.occurrences.find(o => before.terms[o.syntaxId]?.name === 'forever');
  const rule = await session.request({ mode: 'hidingRule', snapshot, position: rewrite, term: occurrence.syntaxId,
    id: 'hide-loop', action: 'hide', rules: [] });
  const hidden = await session.request({ mode: 'reexpand', snapshot, hiding: 'custom', custom: {
    enabled: true, racket: true, library: true, contracts: true, phase: true, rules: [rule]
  } });
  Data.validateAnswer(hidden, snapshot); assert.equal(hidden.stepCount, 1); assert.equal(hidden.message, stopMessage);
  for (const options of [{ oneTermAtATime: true }, { includeRenamingSteps: true }, { oneTermAtATime: false }]) {
    const changed = await session.request({ mode: 'reexpand', snapshot, hiding: 'none', ...options });
    Data.validateAnswer(changed, snapshot); assert.equal(changed.message, stopMessage);
    const end = await session.request({ mode: 'position', snapshot, position: changed.stepCount + 1, factorCommonContext: true });
    assert.equal(end.diagnostics[end.error].message, stopMessage);
  }
  assert.equal(fs.readFileSync(marker, 'utf8'), effects); assert.equal(seen.length, 4);
});

test('EOF while a real worker awaits a decision reaps the expansion without sending Stop', async t => {
  let reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const text = '#lang racket/base\n(define-syntax-rule (forever) (forever))\n(forever)';
  const session = createMacroSession(racket, worker, { ...request(text, 'module'), schemaVersion: 2, session: true, snapshot }, {
    checkpoint: () => { reached(); return new Promise(() => {}); }
  });
  t.after(() => session.stop());
  const opening = session.start(); const rejected = assert.rejects(opening, /closed/);
  await waiting; await session.stop(); await rejected;
});

test('a real stopped history starts at the beginning and keeps error routing, titles and options in both panes', async () => {
  const processes = [];
  const ui = fakeStepper({ workerFactory: realFactory(processes) });
  try {
    let warnings = 0;
    ui.window.showWarningMessage = async () => ({ title: ++warnings < 4 ? 'Continue' : 'Stop' });
    const document = await ui.source('stopped-panes');
    document.text = '#lang racket/base\n(define-syntax-rule (forever) (forever))\n(forever)';
    const opening = ui.open(true); await tick();
    assert.equal(processes.length, 1, 'The injected factory starts a real process');
    await opening;
    const state = await ui.command('_observe');
    assert.equal(state.position, 1); assert.equal(state.busy, false); assert.equal(state.failure, null);
    assert.match(ui.panels[0].title, /Before - Step 1 of/);
    assert.match(ui.panels[1].title, /After - \[Macro transformation\]/);
    await ui.command('last');
    for (const pane of ui.panels) {
      assert.equal(pane.projection.final, null);
      assert.equal(pane.projection.diagnostics[pane.projection.error].message, stopMessage);
    }
    assert.match(ui.panels[1].title, /After - Error/);
    assert.doesNotMatch(ui.panels[1].title, /Finished/);
    await ui.command('previous');
    assert.equal(ui.panels[1].projection.record.kind, 'error');
    assert.equal(ui.panels[1].projection.diagnostics[ui.panels[1].projection.error].message, stopMessage);
    const sessionId = (await ui.command('_observe')).workerSession;
    await ui.command('showAll');
    assert.equal((await ui.command('_observe')).workerSession, sessionId);
    assert.equal(warnings, 4);
  } finally { ui.dispose(); await Promise.all(processes.map(p => p.done)); }
});

function realFactory(processes, observe = () => {}) {
  return (_command, _helper, request, handlers) => {
    let buffer = '';
    const process = createMacroProcess(racket, worker, { ...request, directory: root, cwd: root }, {
      ...handlers, output(text) {
        buffer += text;
        let end;
        while ((end = buffer.indexOf('\n')) >= 0) {
          const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
          if (line.trim()) observe(JSON.parse(line));
        }
        handlers.output(text);
      }
    });
    return { ...process, start() { processes.push(process); process.start(); } };
  };
}

for (const launch of ['line', 'selection']) {
  test(`a real fresh Stop from a ${launch} opens at 1 and later options preserve progress`, async () => {
    const processes = [], ui = fakeStepper({ workerFactory: realFactory(processes) });
    try {
      ui.window.showWarningMessage = async () => ({ title: 'Stop' });
      const document = await ui.source(launch);
      document.text = '#lang racket/base\n(define-syntax-rule (early) 7)\n(define-syntax-rule (forever) (forever))\n(early)\n(forever)';
      ui.window.activeTextEditor.selection = new ui.window.activeTextEditor.selection.constructor(4, 0, 4, launch === 'line' ? 0 : 9);
      // Module setup has already passed 16; allow the early rewrite to finish.
      let warnings = 0;
      ui.window.showWarningMessage = async () => ({ title: ++warnings < 4 ? 'Continue' : 'Stop' });
      const opening = ui.open(false); await tick(); assert.equal(processes.length, 1); await opening;
      assert.equal((await ui.command('_observe')).position, 1);
      assert.equal(ui.panels[0].projection.record.macro, 'early');
      await ui.command('last');
      await ui.command('oneTermAtATime');
      const changed = await ui.command('_observe');
      assert.equal(changed.position, changed.count); assert.equal(changed.busy, false);
      assert.equal(ui.panels[0].projection.position, changed.count);
      assert.equal(ui.panels[1].projection.diagnostics[ui.panels[1].projection.error].message, stopMessage);
      assert.equal(warnings, 4);
    } finally { ui.dispose(); await Promise.all(processes.map(p => p.done)); }
  });
}

async function waitFor(predicate) {
  for (let n = 0; n < 1000; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('Expected worker state did not arrive');
}

for (const ending of ['Continue', 'Stop']) for (const release of ['hidden', 'eviction']) {
  test(`real ${ending} history replays decisions after ${release} for navigation, inspection and hiding`, async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-restore-'));
    const marker = path.join(directory, 'effects'), timers = fakeTimers(), processes = [];
    let ui, sourceHash, replay = false, replayCheckpoints = 0;
    const summaries = [], replayStates = [];
    ui = fakeStepper({ timers, workerFactory: realFactory(processes, reply => {
      if (reply.mode === 'summary') {
        sourceHash ||= reply.snapshot.sourceHash;
        if (reply.snapshot.sourceHash === sourceHash) summaries.push(reply);
      }
      if (replay && reply.mode === 'checkpoint') {
        replayCheckpoints++;
        for (const pane of ui.panels.slice(0, 2)) {
          replayStates.push({ busy: pane.messages.findLast(m => m.type === 'state').busy, title: pane.title });
        }
      }
    }) });
    try {
      let warnings = 0;
      ui.window.showWarningMessage = async () => ({ title: ++warnings % 4 === 0 && ending === 'Stop' ? 'Stop' : 'Continue' });
      const document = await ui.source('restored');
      document.text = '#lang racket/base\n(require (for-syntax racket/base))\n' +
        '(begin-for-syntax (define effects 0))\n' +
        '(define-syntax (countdown stx) (set! effects (add1 effects))\n' +
        `(call-with-output-file ${JSON.stringify(marker)} #:exists 'append (lambda (out) (displayln effects out)))\n` +
        '(define n (syntax-e (cadr (syntax->list stx))))\n' +
        "(if (zero? n) #'0 #`(countdown #,(sub1 n))))\n(countdown 150)";
      const opening = ui.open(true); await tick(); assert.equal(processes.length, 1); await opening;
      const original = await ui.command('_observe'), effects = fs.readFileSync(marker, 'utf8'), dialogs = warnings;
      const history = summaries[0];
      assert.ok(dialogs >= 4); assert.equal(original.failure, null);
      const a = ui.panels[0];
      async function discard() {
        replay = false; replayCheckpoints = 0; replayStates.length = 0;
        if (release === 'hidden') {
          for (const pane of ui.panels.slice(0, 2)) { pane.visible = false; pane.viewState.fire(); }
          await timers.advance(60000);
          await processes.at(-1).done;
        } else {
          for (let n = 0; n < 2; n++) {
            const other = await ui.source(`other-${processes.length}`); other.text = '#lang racket/base\n1'; await ui.open(true);
          }
        }
        a.reveal(); await tick();
        assert.equal((await ui.command('_observe')).workerSession, null);
        summaries.length = 0;
        fs.writeFileSync(marker, ''); replay = true;
      }
      async function unchanged() {
        const state = await ui.command('_observe');
        assert.equal(state.count, original.count); assert.equal(state.failure, null); assert.equal(state.busy, false);
        assert.equal(warnings, dialogs, 'Restoration never opens another dialog');
        assert.equal(fs.readFileSync(marker, 'utf8'), effects, 'Each rebuild executes exactly the fresh expansion prefix');
        assert.ok(replayCheckpoints >= 4);
        for (const state of replayStates) { assert.equal(state.busy, true); assert.match(state.title, /Expanding/); }
        assert.deepEqual(summaries[0].steps, history.steps, 'The rebuilt expansion retains the same complete history');
        assert.equal(summaries[0].message, history.message);
        assert.equal(summaries[0].error, history.error);
        assert.equal(summaries[0].final, history.final);
      }
      await discard(); await ui.command('last'); await unchanged();
      const terminal = plain(a.projection);
      if (ending === 'Stop') {
        assert.equal(terminal.final, null); assert.equal(terminal.diagnostics[terminal.error].message, stopMessage);
      } else { assert.ok(terminal.final); assert.equal(terminal.error, null); }
      await ui.command('first');
      const section = Model.sections(a.projection).find(({ section }) => section.occurrences.some(o => a.projection.terms[o.syntaxId]?.kind === 'identifier'));
      const occurrence = section.section.occurrences.find(o => a.projection.terms[o.syntaxId]?.kind === 'identifier');
      await discard();
      a.send('select', { sectionId: section.section.id, occurrenceId: occurrence.id });
      await waitFor(async () => !!(await ui.command('_observe')).properties); await unchanged();
      await discard(); await ui.command('showAll');
      // Disable changes the visible total; returning to Standard recovers it.
      await ui.command('showMine'); await unchanged();
      await ui.command('last');
      const restoredTerminal = plain(a.projection);
      // Visiting more syntax advances the numbering allocator independently
      // of the retained history and terminal contents.
      delete restoredTerminal.nextGroup; delete terminal.nextGroup;
      assert.deepEqual(restoredTerminal, terminal);
    } finally {
      ui.dispose(); await Promise.all(processes.map(p => p.done)); fs.rmSync(directory, { recursive: true, force: true });
    }
  });
}

test('real memory exhaustion during a pending modal retains its diagnostic and ignores the late choice', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'macro-pending-memory-')), marker = path.join(directory, 'allocate');
  let choose, reached;
  const waiting = new Promise(resolve => { reached = resolve; });
  const sent = [];
  const text = '#lang racket/base\n(require (for-syntax racket/base))\n' +
    `(begin-for-syntax (thread (lambda () (let wait () (unless (file-exists? ${JSON.stringify(marker)}) (sleep 0.01) (wait)))\n` +
    '(let loop ([held null]) (collect-garbage) (loop (cons (make-bytes (* 1024 1024)) held))))))\n' +
    '(define-syntax-rule (forever) (forever))\n(forever)';
  const session = createMacroSession(racket, worker, { ...request(text, 'module'), schemaVersion: 2, session: true, snapshot, testMemoryLimit: 160 * 1024 * 1024 }, {
    factory(command, helper, input, handlers) {
      const process = createMacroProcess(command, helper, input, handlers);
      return { ...process, send(query) { sent.push(query); return process.send(query); } };
    },
    checkpoint(event) {
      if (event.count < 128) return 'continue';
      reached(); return new Promise(resolve => { choose = resolve; });
    }
  });
  try {
    const opening = session.start(); await waiting; fs.writeFileSync(marker, 'allocate');
    assert.deepEqual(await opening, { failed: 'Showing these macro steps would need more than 1 GB of memory.', failureCode: 'memory' });
    await session.done; const before = sent.length;
    choose('stop'); await tick(); assert.equal(sent.length, before);
    await assert.rejects(session.request({ mode: 'position' }), /expired/);
  } finally { await session.stop(); fs.rmSync(directory, { recursive: true, force: true }); }
});
