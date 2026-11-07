// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

// Admission waits for reaping before replacing a worker. In-flight requests
// hold a lease so eviction cannot interrupt a protocol exchange.
function createSessionPool(limit = 2) {
  const slots = new Map();
  let tail = Promise.resolve(), clock = 0;
  const waiters = new Set();
  const wake = () => { for (const resolve of waiters) resolve(); waiters.clear(); };
  function touch(owner) { const slot = slots.get(owner); if (slot) slot.used = ++clock; }
  async function stop(owner) {
    const slot = slots.get(owner);
    if (!slot) return;
    slot.stopping ||= Promise.resolve(slot.worker.stop()).then(() => {
      if (slots.get(owner) === slot) slots.delete(owner);
      wake();
    });
    await slot.stopping;
  }
  function forget(owner, worker) {
    if (slots.get(owner)?.worker === worker) slots.delete(owner);
    wake();
  }
  async function use(owner, create, work) {
    const admission = tail.then(async () => {
      let slot = slots.get(owner);
      if (slot?.stopping) { await slot.stopping; slot = undefined; }
      while (!slot && slots.size >= limit) {
        const oldest = [...slots.entries()].sort((a, b) => a[1].used - b[1].used)[0];
        if (!oldest[1].users && !oldest[1].stopping) await stop(oldest[0]);
        else await new Promise(resolve => waiters.add(resolve));
        slot = slots.get(owner);
      }
      if (!slot) {
        const worker = create();
        slot = { worker, users: 0, used: 0 };
        slots.set(owner, slot);
      }
      slot.users++; touch(owner);
      return slot;
    });
    tail = admission.then(() => {}, () => {});
    const slot = await admission;
    try { return await work(slot.worker); }
    finally { slot.users--; wake(); }
  }
  return { use, stop, forget, touch };
}
module.exports = { createSessionPool };
