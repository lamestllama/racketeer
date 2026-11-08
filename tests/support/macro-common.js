// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Loads extension components with fakes and shares test paths and scheduling helpers.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../..');
const helper = path.join(root, 'racketdap/tools/macro-stepper.rkt');
const racket = process.env.RACKET || 'racket';
function load(dependencies, file = 'vscode/macro-stepper.js', sources = {}) {
  const cache = new Map();
  function evaluate(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const localRequire = createRequire(filename), module = { exports: {} };
    cache.set(filename, module);
    const requireMock = name => {
      if (dependencies[name]) return dependencies[name];
      const resolved = localRequire.resolve(name);
      const key = './' + path.relative(path.join(root, 'vscode'), resolved).replace(/\\/g, '/').replace(/\.js$/, '');
      if (dependencies[key]) return dependencies[key];
      if (resolved.startsWith(path.join(root, 'vscode', 'macro-steps') + path.sep)) return evaluate(resolved);
      return localRequire(name);
    };
    vm.runInNewContext(sources[path.relative(root, filename).replace(/\\/g, '/')] ?? fs.readFileSync(filename, 'utf8'), {
      module, exports: module.exports, TextEncoder, setTimeout: dependencies.__setTimeout || setTimeout,
      clearTimeout: dependencies.__clearTimeout || clearTimeout, queueMicrotask, Buffer, console, require: requireMock
    }, { filename });
    return module.exports;
  }
  return evaluate(path.join(root, file));
}

const noVscode = { window: {}, workspace: {} };

const tick = () => new Promise(resolve => setImmediate(resolve));
const plain = value => JSON.parse(JSON.stringify(value));
module.exports = { root, helper, racket, load, noVscode, tick, plain };
