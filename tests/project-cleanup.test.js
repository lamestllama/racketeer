// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const { until } = require('./support/wait');
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const test = require('./support/node-test');
const { project, addon } = require('./workspace-index-project');
const running = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
const windows = process.platform === 'win32';

test('project cleanup reaps an analysis in a native call before removing its folder', async () => {
  const cleanups = [];
  const p = await project({ after: fn => cleanups.push(fn) }, { RACKETEER_INDEX_WORKERS: '1' });
  const marker = path.join(addon, `${path.basename(p.directory)}.pid`);
  let worker;
  try {
    p.write('a-blocked.rkt', `#lang racket/base
(require (for-syntax racket/base ffi/unsafe))
(begin-for-syntax
  (call-with-output-file ${JSON.stringify(marker)} #:exists 'truncate (lambda (out)
    (write ((get-ffi-obj ${windows ? '"_getpid" (ffi-lib "msvcrt")' : '"getpid" #f'} (_fun -> _int))) out)))
  ${windows ? '((get-ffi-obj "Sleep" (ffi-lib "kernel32") (_fun _uint32 -> _void)) 70000)' : '((get-ffi-obj "sleep" #f (_fun _uint -> _uint)) 70)'})
`);
    p.settings.timeoutSeconds = 90;
    await p.update();
    const asking = p.references(p.origin).catch(error => error);
    worker = await until(() => {
      const text = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : '';
      return /^\d+$/.test(text) && Number(text);
    }, () => p.diagnostics());
    assert.ok(running(worker));
    for (const cleanup of cleanups) await cleanup();
    await asking;
    assert.ok(!running(worker),
      `Worker ${worker} survived successful cleanup; source folder removed=${!fs.existsSync(p.directory)}`);
  } finally {
    if (worker && running(worker)) process.kill(worker, 'SIGKILL');
    for (const cleanup of cleanups) await cleanup();
  }
});
