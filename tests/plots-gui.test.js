// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DapClient } = require('./dap-client');
const { deferCleanup } = require('./cleanup');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const gui = { skip: process.platform === 'linux' && !process.env.DISPLAY };

async function ok(pending) {
  const response = await pending;
  assert.equal(response.success, true, response.message);
  return response.body;
}
test('plot windows support zoom, rotation, overlays, current-view saving and owned cleanup', gui, async () => {
  // Block the application before loading our fixture or any plotting libraries.
  const script = `(define resolver (current-module-name-resolver))
    (current-module-name-resolver
      (case-lambda
        [(p relative stx load?)
         (define result (resolver p relative stx load?))
         (when (regexp-match? #rx"drracket" (format "~a" result)) (error 'test "GUI application dependency: ~a" result)) result]
        [(p ns) (resolver p ns)]))
    (dynamic-require '(file ${JSON.stringify(path.join(root, 'tests/support/plots-gui.rkt'))}) #f)`;
  const { stdout } = await execute('racket', ['-e', script], { timeout: 240000 });
  const report = JSON.parse(stdout.trim().split('\n').at(-1));
  assert.equal(report.checks.length, 7);
});

test('live plot results, multiple results and nested variables open without reevaluation', gui, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-plots-'));
  const program = path.join(directory, 'plots.rkt');
  await fs.writeFile(program, (await fs.readFile(path.join(root, 'examples/interactive-plots.rkt'), 'utf8')) + '\n(define evaluations 0)\n');
  const client = new DapClient();
  deferCleanup(t, () => client.close());
  await ok(client.request('initialize'));
  await ok(client.request('launch', { program, cwd: directory, interactive: true }));
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  async function evaluate(expression) {
    const result = await ok(client.request('evaluate', { expression, context: 'repl' }));
    await client.event('racketdap/ready');
    return result;
  }
  async function open(value) {
    await ok(client.request('racketdap/openPlot', { variablesReference: value.variablesReference }));
    await client.event('racketdap/ready');
  }
  const value = await evaluate('(begin (set! evaluations (add1 evaluations)) curve)');
  assert.equal(value.racketdapPlot, true);
  assert.equal(value.racketdapImage, true);
  assert.equal(value.__vscodeVariableMenuContext, 'racketdap.plot');
  await open(value);
  const snapshot = await ok(client.request('racketdap/renderImage', { variablesReference: value.variablesReference }));
  await client.event('racketdap/ready');
  assert.equal(snapshot.mimeType, 'image/png');
  assert.equal(Buffer.from(snapshot.data, 'base64').readUInt32BE(16), 560);
  const multiple = await evaluate('(values curve 42 surface)');
  assert.deepEqual(multiple.racketdapImages.map(v => v.name), ['value 1', 'value 3']);
  assert.ok(multiple.racketdapImages.every(v => v.racketdapPlot));
  await open(multiple.racketdapImages[1]);
  const stale = await client.request('racketdap/openPlot', { variablesReference: value.variablesReference });
  assert.equal(stale.success, false);
  assert.match(stale.message, /Expired/);
  const nested = await evaluate('(vector curve)');
  const { variables } = await ok(client.request('variables', { variablesReference: nested.variablesReference }));
  await client.event('racketdap/ready');
  assert.equal(variables[0].racketdapPlot, true);
  await open(variables[0]);
  assert.equal((await evaluate('evaluations')).result, '1');
  const ordinary = await evaluate('(vector 1 2)');
  const rejected = await client.request('racketdap/openPlot', { variablesReference: ordinary.variablesReference });
  assert.equal(rejected.success, false);
  assert.match(rejected.message, /interactive plot/);
  await client.event('racketdap/ready');
  assert.equal((await evaluate('(+ 20 22)')).result, '42');
  await evaluate('(require racket/class racket/contract)');
  const slow = await evaluate(`(contract
    (object/c [copy (->m (flat-named-contract 'slow-copy
      (lambda (_) (displayln "plot-copy-started") (flush-output) (sync never-evt))))])
    curve 'fixture 'viewer)`);
  assert.equal(slow.racketdapPlot, true);
  const requestId = client.sequence + 1;
  const pending = client.request('racketdap/openPlot', { variablesReference: slow.variablesReference });
  await client.event('output', event => event.body.output.includes('plot-copy-started'));
  await ok(client.request('cancel', { requestId }));
  const cancelled = await pending;
  assert.equal(cancelled.success, false);
  assert.match(cancelled.message, /cancelled/i);
  await client.event('racketdap/ready');
  assert.equal((await evaluate('(+ 1 2)')).result, '3');
  await ok(client.request('terminate'));
  await client.event('terminated');
});
