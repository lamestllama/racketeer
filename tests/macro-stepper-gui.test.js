'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const net = require('node:net');
const { createMacroProcess } = require('../vscode/macro-process');
const root = path.resolve(__dirname, '..');
const helper = path.join(root, 'racketdap/tools/macro-stepper.rkt');
const racket = process.env.RACKET || 'racket';
function request(text, mode = 'fragment') {
  return { text, mode, source: 'untitled:macro-test', sourceIsFile: false, prefix: '', directory: root, cwd: root };
}
function owned(command, program, input) {
  let output = '', errors = [], code;
  const process = createMacroProcess(command, program, input, {
    output: text => { output += text; }, failure: error => errors.push(error), finished: value => { code = value; }
  });
  return { process, get output() { return output; }, get errors() { return errors; }, get code() { return code; } };
}
const gui = { timeout: 30000 };
if (process.platform === 'linux' && !process.env.DISPLAY) throw new Error('Run this suite through scripts/test-gui.py with an isolated display.');
test('native GUI shows a real rewrite, navigates to expansion, and closes through public window APIs', gui, async () => {
  const child = spawn(racket, [path.join(__dirname, 'support/macro-stepper-gui.rkt')], { cwd: root });
  let stdout = '', stderr = '';
  child.stdout.on('data', text => { stdout += text; }); child.stderr.on('data', text => { stderr += text; });
  child.stdin.end(JSON.stringify(request('(or #f (+ 20 22))')));
  const [code] = await once(child, 'close');
  assert.equal(code, 0, stderr);
  const result = JSON.parse(stdout);
  assert.match(result.labels.join(' '), /Macro stepper/);
  assert.match(result.before, /Macro transformation/);
  assert.match(result.after, /if/);
  assert.notEqual(result.before, result.after);
});

test('owned GUI terminal cancellation kills a stuck transformer and its child process', gui, async t => {
  const server = net.createServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  let socket;
  const connected = new Promise(resolve => server.once('connection', connection => { socket = connection; resolve(); }));
  const childCode = `require('net').connect(${server.address().port},'127.0.0.1'); setInterval(()=>{},1000)`;
  const literal = value => JSON.stringify(value);
  const input = request(`#lang racket/base\n(require (for-syntax racket/base))\n(begin-for-syntax (define-values (p out in err) (subprocess #f #f #f ${literal(process.execPath)} "-e" ${literal(childCode)})) (sync never-evt))`, 'module');
  const session = owned(racket, helper, input);
  t.after(async () => { await session.process.stop(); socket?.destroy(); await new Promise(resolve => server.close(resolve)); });
  session.process.start();
  let timer;
  try {
    await Promise.race([connected, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Descendant did not connect: ' + session.output)), 15000); })]);
  } finally { clearTimeout(timer); }
  const disconnected = new Promise((resolve, reject) => {
    socket.once('close', resolve);
    // Forced process termination can reset the connection on Windows.
    socket.once('error', error => { if (error.code !== 'ECONNRESET') reject(error); });
  });
  await Promise.all([session.process.stop(), disconnected]);
  assert.deepEqual(session.errors, []);
  assert.equal(session.code, 0);
});
