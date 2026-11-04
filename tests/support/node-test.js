// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Every test has one deadline, which only names a hang. The runner then needs no
// budget for a whole file, whose total is the sum of its tests' times.
const nodeTest = require('node:test');
const timeout = 300000;
function test(name, options, fn) {
  if (typeof options === 'function') [options, fn] = [{}, options];
  return nodeTest(name, { timeout, ...options }, fn);
}
module.exports = Object.assign(test, nodeTest, { test });
