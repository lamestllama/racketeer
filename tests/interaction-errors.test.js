// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const test = require('./support/node-test'), assert = require('node:assert/strict');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const { InteractionOutput } = require('../vscode/interaction-output');
const mainSource = '#lang racket/base\n(define (fail) (let ([emoji "😀"]) (/ 1 0)))\n';
async function start(t, source = mainSource, files = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket error λ '));
  deferCleanup(t, () => fs.rm(directory, { recursive: true, force: true }));
  for (const [name, text] of Object.entries({ 'main λ.rkt': source, ...files })) await fs.writeFile(path.join(directory, name), text);
  const program = path.join(directory, 'main λ.rkt');
  const client = new DapClient(undefined, { timeout: 30000 }); deferCleanup(t, () => client.close());
  async function ok(value) { const r = await value; assert.equal(r.success, true, r.message); return r.body; }
  await ok(client.request('initialize')); await ok(client.request('launch', { program, cwd: directory, sourceRoots: [directory], interactive: true, racketdapRichInteractions: true }));
  await ok(client.request('configurationDone'));
  return { client, program, directory, ok, ready: () => client.event('racketdap/ready'),
    evaluate: expression => client.request('evaluate', { context: 'repl', expression }) };
}
function targets(detail) { return detail.locations.map(location => ({ ...location, ...detail.sources[location.source] })); }

test('runtime errors link loaded expression snapshots with Unicode columns and keep the REPL usable', async t => {
  const h = await start(t); await h.ready();
  const response = await h.evaluate('(fail)'); assert.equal(response.success, false); await h.ready();
  const places = targets(response.body.racketdapError);
  const exact = places.find(place => place.path === h.program && !place.approximate); assert.ok(exact, JSON.stringify(places));
  assert.equal(exact.content, mainSource); assert.equal(exact.line, 2);
  assert.equal(exact.column, mainSource.split('\n')[1].indexOf('(/ 1 0)') + 1);
  assert.equal(exact.endColumn - exact.column, '(/ 1 0)'.length);
  assert.ok(places.some(place => place.submitted && place.content === '(fail)'));
  await fs.writeFile(h.program, '#lang racket/base\n(define (fail) 42)\n');
  const again = await h.evaluate('(fail)'); await h.ready(); assert.equal(targets(again.body.racketdapError)[0].content, mainSource);
  assert.equal((await h.evaluate('(+ 20 22)')).body.result, '42'); await h.ready();
});

test('malformed submitted input has a located snapshot, and later evaluations cannot change it', async t => {
  const h = await start(t); await h.ready(); const input = '(let ([x "😀"])\n  (+ x 1)';
  const failed = await h.evaluate(input); await h.ready(); assert.equal(failed.success, false);
  const detail = failed.body.racketdapError; assert.ok(targets(detail).some(place => !place.submitted && place.name === 'Interaction' && place.line === 1));
  assert.equal(detail.sources[0].content, input);
  await h.evaluate('(error "another")'); await h.ready(); assert.equal(detail.sources[0].content, input);
});

test('located expression reading preserves datum reader forms and safe-reader restrictions', async t => {
  const h = await start(t); await h.ready();
  assert.equal((await h.evaluate("(equal? '#0=(a b) '(a b))")).body.result, '#t'); await h.ready();
  assert.equal((await h.evaluate('#reader "missing.rkt" 1')).success, false); await h.ready();
  assert.equal((await h.evaluate('1 2')).success, false); await h.ready();
  assert.equal((await h.evaluate('(+ 1 2)')).body.result, '3'); await h.ready();
});

test('module syntax and runtime failures report source links before termination', async t => {
  for (const source of ['#lang racket/base\n(define x missing-name)\n', '#lang racket/base\n(/ 1 0)\n']) {
    const h = await start(t, source); await h.client.event('terminated');
    const errors = h.client.events.filter(event => event.event === 'racketdap/interactionError');
    assert.equal(errors.length, 1); const places = targets(errors[0].body);
    assert.ok(places.some(place => place.path === h.program && place.line === 2 && place.content === source), JSON.stringify(errors));
  }
});

test('dependency failures keep their actual source and raised values do not fabricate locations', async t => {
  const dependency = '#lang racket/base\n(provide broken)\n(define (broken) (error "dependency λ"))\n';
  const h = await start(t, '#lang racket/base\n(require "dep.rkt")\n(define (raw) (raise 7))\n', { 'dep.rkt': dependency }); await h.ready();
  const failed = await h.evaluate('(broken)'); await h.ready();
  assert.ok(targets(failed.body.racketdapError).some(place => place.path === path.join(h.directory, 'dep.rkt') && place.content === dependency && !place.approximate));
  const raised = await h.evaluate('(raw)'); await h.ready(); assert.equal(raised.success, false);
  assert.ok(targets(raised.body.racketdapError).some(place => place.path === h.program));
});

test('error snapshots count toward history limits and never travel to the webview as source contents', () => {
  const messages = [], output = new InteractionOutput(message => messages.push(message), 512);
  const detail = { sources: [{ name: 'one.rkt', path: '/one.rkt', content: 'x'.repeat(300) }], locations: [{ source: 0, line: 1, column: 1, endLine: 1, endColumn: 2 }], omitted: false };
  output.error('failure', detail); const first = output.entries[0].id;
  const visible = messages.at(-1).entry; assert.equal(visible.sources[0].content, undefined); assert.equal(visible.sources[0].path, undefined);
  output.error('second', detail); assert.equal(output.entries.some(entry => entry.id === first), false); assert.ok(output.bytes <= 512);
  output.clear(); output.error('fallback', detail, true); output.append('stderr', 'custom printer λ\n');
  assert.equal(output.entries[0].text, 'custom printer λ\n'); output.append('input', 'next'); output.append('stderr', 'later');
  assert.equal(output.entries[0].text, 'custom printer λ\n');
  output.error('large printer', detail, true); output.append('stderr', 'x'.repeat(1024));
  assert.equal(output.reporting, undefined); assert.ok(output.bytes <= 512);
  output.clear(); output.error('malformed', { sources: detail.sources, locations: [{ ...detail.locations[0], line: 0 }] });
  assert.equal(output.entries[0].locations.length, 0);
});
