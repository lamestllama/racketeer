// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// A wait ends the moment its condition holds, so a long deadline costs a passing
// test nothing and a slow machine cannot fail one. The deadline only names a hang,
// and falls within a test's own five minutes.
const deadline = 240000;
// Taken now, so a wait still polls in a test that mocks timers to hold a product's deadline.
const pollAfter = setTimeout;
async function until(check, description = String(check), details = () => '') {
  const limit = Date.now() + deadline;
  for (;;) {
    const result = await check();
    if (result) return result;
    if (Date.now() >= limit) {
      const named = typeof description === 'function' ? description() : description;
      throw new Error(`Timed out: ${named} ${details()}`.trimEnd());
    }
    await new Promise(resolve => pollAfter(resolve, 25));
  }
}
function exited(pid) {
  try { process.kill(pid, 0); return false; }
  catch (error) { if (error.code === 'ESRCH') return true; throw error; }
}
module.exports = { until, exited, deadline };
