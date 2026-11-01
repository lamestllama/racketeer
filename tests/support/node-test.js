// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Every test has its own deadline: the timeout it states, or three minutes.
// The runner then needs no budget for a whole file, whose total is the sum of
// its tests' times.
const nodeTest = require('node:test');
const timeout = 180000;
function test(name, options, fn) {
  if (typeof options === 'function') [options, fn] = [{}, options];
  return nodeTest(name, { timeout, ...options }, fn);
}
module.exports = Object.assign(test, nodeTest, { test });
