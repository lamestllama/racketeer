// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

const stacks = new WeakMap();

// Release resources in reverse acquisition order. In particular, a debugger
// must release its working directory before a fixture can remove it on Windows.
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

module.exports = { deferCleanup };
