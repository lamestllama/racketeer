// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const { InteractionOutput } = require('../vscode/interaction-output');
async function ok(request) { const r = await request; assert.equal(r.success, true, r.message); return r.body; }
async function start(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket results λ '));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'main λ.rkt'); await fs.writeFile(program, source);
  const client = new DapClient(undefined, { timeout: 60000 }); deferCleanup(t, () => client.close());
  await ok(client.request('initialize'));
  await ok(client.request('launch', { program, cwd: directory, sourceRoots: [directory], noDebug: true,
    interactive: false, console: 'integratedTerminal', racketdapRichInteractions: true }));
  await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
  await ok(client.request('configurationDone'));
  return { client, program, output() {
    const model = new InteractionOutput(() => {});
    for (const event of client.events.filter(e => e.event === 'racketdap/interactionOutput')) model.output(event.body);
    return model.entries;
  } };
}
const text = entries => entries.filter(e => e.kind !== 'image').map(e => e.text).join('');

test('Run emits root and main output once, retains images, and exits without a REPL', async t => {
  const h = await start(t, `#lang racket/base
(require pict)
(displayln "root λ")
(disk 24)
(module+ main (displayln "main 😀") (disk 12))
(module+ test (error "must not run tests"))
`);
  await h.client.event('terminated');
  assert.equal((await h.client.event('exited')).body.exitCode, 0);
  assert.equal(text(h.output()), 'root λ\n\nmain 😀\n\n');
  const images = h.output().filter(e => e.kind === 'image');
  assert.deepEqual(images.map(e => Buffer.from(e.data, 'base64').readUInt32BE(16)), [24, 12]);
  assert.ok(!h.client.events.some(e => ['stopped', 'racketdap/ready'].includes(e.event)));
});

test('Run reports located reader, syntax and runtime errors and exits without pausing', async t => {
  for (const expression of ['(define broken', '(define broken missing-name)', '(define (broken x) (displayln (/ 1 x)))\n(broken 0)']) {
    const source = '#lang racket/base\n' + expression + '\n', h = await start(t, source);
    await h.client.event('terminated');
    assert.equal((await h.client.event('exited')).body.exitCode, 1);
    assert.ok(!h.client.events.some(e => e.event === 'stopped'));
    const detail = h.client.events.find(e => e.event === 'racketdap/interactionError')?.body;
    assert.ok(detail, text(h.output()));
    assert.ok(detail.locations.some(l => detail.sources[l.source].path === h.program && detail.sources[l.source].content === source), JSON.stringify(detail));
  }
});

test('Run accepts Unicode line input and EOF before normal termination', async t => {
  const h = await start(t, '#lang racket/base\n(displayln "waiting")\n(flush-output)\n(displayln (read-line))\n(displayln (eof-object? (read-line)))\n');
  await h.client.event('racketdap/terminalOutput', e => e.body.output.includes('waiting'));
  await ok(h.client.request('racketdap/input', { text: 'λ😀\n' }));
  await ok(h.client.request('racketdap/input', { eof: true }));
  await h.client.event('terminated');
  assert.equal((await h.client.event('exited')).body.exitCode, 0);
  assert.equal(text(h.output()), 'waiting\nλ😀\n#t\n');
});

test('Stop terminates a blocked image converter without discarding earlier output', async t => {
  const h = await start(t, `#lang racket/base
(require file/convertible)
(struct picture () #:property prop:convertible
  (lambda (v format default) (displayln "converting") (flush-output) (sync never-evt)))
(displayln "retained")
(picture)
`);
  await h.client.event('racketdap/terminalOutput', e => e.body.output.includes('converting'));
  await ok(h.client.request('disconnect', { terminateDebuggee: true }));
  await h.client.event('terminated');
  assert.match(text(h.output()), /retained\nconverting/);
});
