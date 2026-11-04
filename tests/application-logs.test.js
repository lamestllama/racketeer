// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
async function ok(value) { const response = await value; assert.equal(response.success, true, response.message); return response.body; }
const source = `#lang racket/base
(define-logger network)
(define-logger storage)
(define (sample suffix)
 (log-network-debug "debug ~a λ" suffix)
 (log-network-warning "warning ~a" suffix)
 (log-storage-info "info ~a" suffix)
 (log-storage-error "error ~a" suffix)
 (log-warning "unnamed ~a" suffix))
(sample "load")
`;
async function start(t, extra = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket logs λ '));
  const program = path.join(directory, 'main.rkt'); await fs.writeFile(program, source);
  const client = new DapClient(); deferCleanup(t, () => client.close());
  await ok(client.request('initialize')); await ok(client.request('launch', { program, interactive: true, ...extra }));
  await ok(client.request('configurationDone')); await client.event('racketdap/ready');
  const drain = () => {
    const events = client.events.filter(event => event.event === 'racketdap/log');
    client.events = client.events.filter(event => event.event !== 'racketdap/log');
    return { entries: events.flatMap(event => event.body.entries), dropped: events.reduce((n, event) => n + event.body.dropped, 0) };
  };
  const evaluate = async expression => { const result = await ok(client.request('evaluate', { expression, context: 'repl' })); await client.event('racketdap/ready'); return result; };
  return { client, drain, evaluate, filter: filter => client.request('racketdap/logFilter', { filter }), program };
}

test('application errors are captured from module loading without replacing stderr or evaluating log data', async t => {
  const h = await start(t);
  assert.deepEqual(h.drain().entries.map(entry => [entry.level, entry.topic, entry.message]), [['error', 'storage', 'storage: error load']]);
  await h.client.event('output', event => event.body.output.includes('storage: error load'));
  await h.evaluate(`(begin (struct dangerous () #:property prop:custom-write (lambda args (error "do not print data")))
    (log-message (current-logger) 'error 'network "safe message" (dangerous) #f))`);
  assert.equal(h.drain().entries.at(-1).message, 'safe message');
  assert.equal((await h.evaluate('(+ 40 2)')).result, '42');
});

test('topic and severity filters change live, reject malformed input atomically, and disable capture', async t => {
  const h = await start(t, { logFilter: 'none' }); assert.deepEqual(h.drain().entries, []);
  await ok(h.filter('warning debug@network none@storage'));
  await h.evaluate('(sample "first")');
  assert.deepEqual(h.drain().entries.map(entry => entry.message), ['network: debug first λ', 'network: warning first', 'unnamed first']);
  for (const filter of ['bogus', 'info debug', 'debug@network', 'info debug@', 'error@topic@bad', 3]) assert.equal((await h.filter(filter)).success, false);
  await h.evaluate('(sample "still")'); assert.equal(h.drain().entries.length, 3);
  await ok(h.filter('none info@storage none@storage debug@network'));
  await h.evaluate('(sample "override")'); assert.equal(h.drain().entries.length, 2);
  await ok(h.filter('none')); await h.evaluate('(sample "off")'); assert.equal(h.drain().entries.length, 0);
  assert.equal((await h.evaluate('(+ 20 22)')).result, '42');
});

test('sessions and restarts keep separate capture settings and messages', async t => {
  const a = await start(t, { logFilter: 'none debug@network' });
  const b = await start(t, { logFilter: 'none info@storage' }); a.drain(); b.drain();
  await Promise.all([a.evaluate('(sample "session-a")'), b.evaluate('(sample "session-b")')]);
  assert.ok(a.drain().entries.every(entry => entry.topic === 'network' && entry.message.includes('session-a')));
  assert.ok(b.drain().entries.every(entry => entry.topic === 'storage' && entry.message.includes('session-b')));
  await ok(a.client.request('disconnect'));
  await b.evaluate('(sample "survivor")'); assert.equal(b.drain().entries.length, 2);
  const restarted = await start(t); assert.equal(restarted.drain().entries.length, 1);
});

test('child-thread messages arrive during evaluation and final messages precede normal termination', async t => {
  const h = await start(t, { logFilter: 'none debug@network' }); h.drain();
  const pending = h.client.request('evaluate', { context: 'repl', expression: '(begin (thread (lambda () (log-network-info "child while busy"))) (sync never-evt))' });
  const message = await h.client.event('racketdap/log', event => event.body.entries.some(entry => entry.message.includes('child while busy')));
  assert.equal(message.body.entries.at(-1).topic, 'network');
  await ok(h.client.request('racketdap/cancelEvaluation')); assert.equal((await pending).success, false); await h.client.event('racketdap/ready');
  await h.client.request('evaluate', { context: 'repl', expression: '(begin (log-network-info "last before exit") (exit 0))' });
  await h.client.event('terminated'); assert.ok(h.drain().entries.some(entry => entry.message.includes('last before exit')));
});

test('large bursts have bounded batches, explicit omission counts, truncation and recovery', async t => {
  const h = await start(t, { logFilter: 'none debug@network' }); h.drain();
  await h.evaluate('(for ([i (in-range 12000)]) (log-network-debug "burst ~a" i))');
  await until(() => h.client.events.filter(event => event.event === 'racketdap/log').reduce((n, event) => n + event.body.entries.length + event.body.dropped, 0) >= 12000, 'The asynchronous receiver finishes draining the burst');
  const events = h.client.events.filter(event => event.event === 'racketdap/log');
  for (const event of events) { assert.ok(event.body.entries.length <= 1000); assert.ok(Buffer.byteLength(JSON.stringify(event.body)) < 2 * 1024 * 1024); }
  const batch = h.drain(); assert.equal(batch.entries.length + batch.dropped, 12000);
  await h.evaluate('(log-network-debug "~a" (make-string 30000 #\\λ))');
  assert.match(h.drain().entries.at(-1).message, /\[truncated\]$/);
  assert.equal((await h.evaluate('(+ 1 2)')).result, '3');
});
