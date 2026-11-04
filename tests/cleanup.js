// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

const fs = require('node:fs');

const stacks = new WeakMap();

// Release resources in reverse acquisition order.
function deferCleanup(t, operation) {
  let stack = stacks.get(t);
  if (!stack) {
    stack = [];
    stacks.set(t, stack);
    t.after(async () => {
      const errors = [];
      for (const release of stack.reverse()) {
        try { await release(); }
        catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors,
        'Test resource cleanup failed:\n' + errors.map(error => error.message || String(error)).join('\n'));
    });
  }
  stack.push(operation);
}

// For a folder a later test could see. A temporary one stays in the run's scratch
// folder instead. Cleanup is not what a test checks, so it cannot fail one.
function removeQuietly(directory) {
  try { fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); }
  catch { /* A folder still busy stays behind. */ }
}

module.exports = { deferCleanup, removeQuietly };
