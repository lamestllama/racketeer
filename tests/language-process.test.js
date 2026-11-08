// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const { until } = require('./support/wait');
const { removeQuietly } = require('./cleanup');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { once } = require('node:events');
const { promisify } = require('node:util');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');
const ownership = path.join(root, 'vscode/language-process.js');

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}

// The server never reads stdin. Its children are ordinary OS processes, with
// no EOF handling and no Racket custodian. Killing the editor or the server
// must therefore exercise the supervisor, rather than cooperative cleanup.
const backends = process.platform === 'win32' ? ['racket'] : ['native', 'racket'];
const endings = ['editor stop', 'editor killed', 'editor killed with blocked input',
  'editor exit', 'server crash', 'server exit', 'supervisor crash'];
for (const backend of backends) for (const ending of endings) {
  test(`${backend}: ${ending} leaves no owned server, child or grandchild`, async t => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'racketeer-owned-'));
    const file = name => path.join(directory, name);
    const pids = [];
    let host;
    t.after(async () => {
      host?.kill('SIGKILL');
      for (const pid of pids) if (alive(pid)) process.kill(pid, 'SIGKILL');
      removeQuietly(directory);
    });
    fs.writeFileSync(file('child.js'), `
      const { spawn } = require('node:child_process');
      const fs = require('node:fs');
      const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      fs.writeFileSync(${JSON.stringify(file('children'))}, JSON.stringify([process.pid, child.pid]));
      setInterval(() => {}, 1000);
    `);
    fs.writeFileSync(file('server.rkt'), `#lang racket/base
(require racket/os)
(define-values (child out in err)
  (subprocess #f #f #f ${JSON.stringify(process.execPath)} ${JSON.stringify(file('child.js'))}))
(call-with-output-file ${JSON.stringify(file('server'))} (lambda (out) (write (getpid) out)))
(let loop ()
  (unless (file-exists? ${JSON.stringify(file('exit'))}) (sleep 0.01) (loop)))
(exit 7)
`);
    fs.writeFileSync(file('host.js'), `
      const { createLanguageProcess, ownedArgs } = require(${JSON.stringify(ownership)});
      const context = { asAbsolutePath: file => ${JSON.stringify(path.join(root, 'vscode'))} + '/' + file };
      (async () => {
        const args = ${JSON.stringify(backend)} === 'racket'
          ? [context.asAbsolutePath('runtime/racketdap/tools/owned-command.rkt'), '--supervise-input', ${JSON.stringify(file('server.rkt'))}]
          : ownedArgs(context, [${JSON.stringify(file('server.rkt'))}]);
        const owner = createLanguageProcess('racket', args, {}, { owned: ${JSON.stringify(backend === 'native')} });
        const server = await owner.start(); owner.ready();
        server.stderr.pipe(process.stderr);
        if (${JSON.stringify(ending)} === 'editor killed with blocked input') server.stdin.write(Buffer.alloc(1024 * 1024));
        require('node:fs').writeSync(1, String(server.pid) + '\\n');
        const timer = setInterval(async () => {
          if (!require('node:fs').existsSync(${JSON.stringify(file('stop'))})) return;
          clearInterval(timer);
          if (${JSON.stringify(ending)} === 'editor stop') { await owner.dispose(); process.exit(0); }
          if (${JSON.stringify(ending)} === 'editor exit') process.exit(0);
        }, 10);
      })().catch(error => { console.error(error); process.exit(1); });
    `);
    host = spawn(process.execPath, [file('host.js')], { stdio: ['pipe', 'pipe', 'pipe'] });
    const hostClosed = once(host, 'close');
    let diagnostics = '';
    host.stderr.on('data', bytes => { diagnostics += bytes; });
    const [line] = await once(host.stdout, 'data');
    const supervisor = Number(line.toString().trim());
    assert.ok(Number.isInteger(supervisor) && supervisor > 0);
    pids.push(supervisor);
    await until(() => fs.existsSync(file('server')) && fs.existsSync(file('children')), 'Server tree started', () => diagnostics);
    const server = Number(fs.readFileSync(file('server'), 'utf8'));
    const children = JSON.parse(fs.readFileSync(file('children'), 'utf8'));
    assert.equal(children.length, 2);
    pids.push(server, ...children);
    if (process.platform !== 'win32') {
      const { stdout } = await execute('ps', ['-A', '-o', 'pid=,ppid=']);
      const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number));
      const tree = [supervisor];
      for (let i = 0; i < tree.length; i++) tree.push(...rows.filter(([, parent]) => parent === tree[i]).map(([pid]) => pid));
      for (const pid of tree) if (!pids.includes(pid)) pids.push(pid);
      assert.ok(pids.length >= 5, 'The ownership guard is running too');
    }
    for (const pid of pids) assert.ok(alive(pid), `Process ${pid} started`);
    // This independent process must survive every cleanup path.
    const unrelated = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const unrelatedClosed = once(unrelated, 'close');
    t.after(async () => { unrelated.kill('SIGKILL'); await unrelatedClosed; });
    if (ending.startsWith('editor killed')) { host.kill('SIGKILL'); await hostClosed; }
    else if (ending === 'editor stop' || ending === 'editor exit') { fs.writeFileSync(file('stop'), ''); await hostClosed; }
    else if (ending === 'server crash') process.kill(server, 'SIGKILL');
    else if (ending === 'server exit') fs.writeFileSync(file('exit'), '');
    else process.kill(supervisor, 'SIGKILL');
    await until(() => pids.every(pid => !alive(pid)), 'Every owned process exited', () => diagnostics);
    assert.deepEqual(pids.filter(alive), []);
    assert.ok(alive(unrelated.pid), 'Unrelated processes survive cleanup');
  });
}
