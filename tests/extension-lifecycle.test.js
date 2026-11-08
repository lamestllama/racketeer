// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const assert = require('node:assert/strict');
const test = require('./support/node-test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { once } = require('node:events');
const { spawnSync } = require('node:child_process');
const { createLanguageProcess } = require('../vscode/language-process');

test('JSON-RPC write failures reject the request without an unhandled rejection', () => {
  const result = spawnSync(process.execPath, ['--unhandled-rejections=strict', '-e', `
    const assert = require('node:assert/strict');
    const { PassThrough, Writable } = require('node:stream');
    const rpc = require(${JSON.stringify(require.resolve('vscode-jsonrpc/node', { paths: [require('node:path').join(__dirname, '../vscode')] }))});
    (async () => {
      for (const failure of ['header', 'body', 'encoding']) {
        let writes = 0;
        const input = new PassThrough();
        const output = new Writable({ write(_chunk, _encoding, done) {
          writes++;
          queueMicrotask(() => done(writes === (failure === 'header' ? 1 : 2)
            ? new Error('closed language-server pipe') : undefined));
        } });
        const connection = rpc.createMessageConnection(input, output);
        connection.listen();
        const params = {};
        if (failure === 'encoding') params.cycle = params;
        await assert.rejects(connection.sendRequest('shutdown', params), error => {
          assert.equal(error.code, rpc.ErrorCodes.MessageWriteError);
          assert.match(error.message, failure === 'encoding' ? /circular/i : /closed language-server pipe/);
          return true;
        });
        await new Promise(resolve => setImmediate(resolve));
        connection.dispose(); input.destroy(); output.destroy();
      }
    })().catch(error => { console.error(error); process.exitCode = 1; });
  `], { encoding: 'utf8', timeout: 240000 });
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

function load(name, dependencies) {
  const filename = path.join(__dirname, '..', 'vscode', name);
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, setTimeout, clearTimeout,
    require: name => Object.hasOwn(dependencies, name) ? dependencies[name] : localRequire(name)
  }, { filename });
  return module.exports;
}
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function event() {
  const callbacks = new Set();
  return {
    subscribe(callback) { callbacks.add(callback); return { dispose: () => callbacks.delete(callback) }; },
    fire(value) { for (const callback of callbacks) callback(value); },
    get size() { return callbacks.size; }
  };
}
const disposable = () => ({ dispose() {} });
const target = { program: '/workspace/example.rkt', cwd: '/workspace', racketExecutable: 'racket' };

test('file debugging retains native controls while Run and Interactions suppress them', async () => {
  const started = event(), terminated = event(), launches = [];
  const vscode = { workspace: { isTrusted: true }, debug: {
    registerDebugAdapterTrackerFactory: disposable,
    onDidStartDebugSession: started.subscribe, onDidTerminateDebugSession: terminated.subscribe,
    async startDebugging(_folder, configuration, options) {
      const session = { id: String(launches.length), configuration };
      launches.push(options); started.fire(session); return true;
    },
    async stopDebugging(session) { terminated.fire(session); }
  } };
  const context = { subscriptions: [] };
  const sessions = load('sessions.js', { vscode, './execution': { launchConfiguration: (_target, config) => config } }).registerSessions(context);
  for (const [interactive, noDebug] of [[false, false], [false, true], [true, false]]) {
    const record = await sessions.start(target, { interactive, racketdapRichInteractions: true }, { noDebug });
    const options = launches.at(-1);
    assert.equal(options.suppressDebugToolbar, interactive || noDebug);
    assert.equal(options.suppressDebugView, interactive || noDebug);
    assert.equal(options.suppressDebugStatusbar, noDebug);
    await record.stop(); await record.done;
  }
  context.subscriptions.forEach(item => item.dispose());
});

test('Results reruns save dirty source and custom WXME editors without text-editor conversion', async () => {
  const uri = { toString: () => 'file:///workspace/picture.rkt' };
  const tab = { input: new (class {})(), isDirty: true }; let saved = 0, opened = 0;
  const vscode = { TabInputCustom: tab.input.constructor,
    window: { tabGroups: { all: [{ tabs: [tab] }] } },
    workspace: { textDocuments: [],
      async save(actual) { assert.equal(actual, uri); saved++; tab.isDirty = false; return uri; },
      async openTextDocument() { opened++; return { isDirty: true, save: async () => { saved++; return true; } }; }
    }
  };
  Object.assign(tab.input, { uri, viewType: 'racketeer.wxmeEditor' });
  const { saveTarget } = load('execution.js', { vscode });
  await saveTarget({ ...target, uri, format: 'wxme' }); assert.equal(saved, 1); assert.equal(opened, 0);
  await saveTarget({ ...target, uri }); assert.equal(saved, 2); assert.equal(opened, 1);
  tab.isDirty = true; vscode.workspace.save = async () => uri;
  await assert.rejects(saveTarget({ ...target, uri, format: 'wxme' }), /could not be saved/);
  vscode.workspace.textDocuments = [{ uri, isDirty: true }];
  await assert.rejects(saveTarget({ ...target, uri, format: 'wxme' }), /text editor has unsaved changes/);
});

test('disposal retains ownership until a pending workflow starts and terminates', async () => {
  const started = event(), terminated = event(), launch = deferred();
  let configuration, factory, factoryDisposed = false;
  const stopped = [];
  const vscode = { workspace: { isTrusted: true }, debug: {
    registerDebugAdapterTrackerFactory(_type, value) {
      factory = value; return { dispose() { factoryDisposed = true; } };
    },
    onDidStartDebugSession: started.subscribe,
    onDidTerminateDebugSession: terminated.subscribe,
    startDebugging(_folder, config) { configuration = config; return launch.promise; },
    async stopDebugging(session) { stopped.push(session.id); terminated.fire(session); }
  } };
  const context = { subscriptions: [] };
  const sessions = load('sessions.js', { vscode, './execution': { launchConfiguration: (_target, config) => config } }).registerSessions(context);
  const pending = sessions.start(target, {});
  context.subscriptions.forEach(item => item.dispose());
  assert.equal(factoryDisposed, false);
  const session = { id: 'late', configuration };
  assert.ok(factory.createDebugAdapterTracker(session));
  started.fire(session);
  launch.resolve(true);
  const record = await pending;
  await record.done;
  assert.ok(stopped.includes('late'));
  assert.equal(record.ended, true);
  assert.equal(factoryDisposed, true);
  assert.equal(started.size, 0);
  assert.equal(terminated.size, 0);
  await assert.rejects(sessions.start(target, {}), /stopped/);
});

test('failed pending startup releases disposal listeners', async () => {
  const launch = deferred();
  const started = event(), terminated = event();
  const vscode = { workspace: { isTrusted: true }, debug: {
    registerDebugAdapterTrackerFactory: disposable,
    onDidStartDebugSession: started.subscribe,
    onDidTerminateDebugSession: terminated.subscribe,
    startDebugging: () => launch.promise
  } };
  const context = { subscriptions: [] };
  const sessions = load('sessions.js', { vscode, './execution': { launchConfiguration: (_target, config) => config } }).registerSessions(context);
  const pending = sessions.start(target, {});
  context.subscriptions.forEach(item => item.dispose());
  launch.resolve(false);
  await assert.rejects(pending, /cancelled or failed/);
  assert.equal(started.size, 0);
  assert.equal(terminated.size, 0);
});

test('paused selection inspection preserves the pending outer interaction', async () => {
  const outer = deferred(), entered = deferred();
  const session = { id: 'owned', async customRequest(_method, args) {
    if (args.frameId === undefined) { entered.resolve(); return outer.promise; }
    assert.equal(args.frameId, 23);
    return { result: '4' };
  } };
  const record = { session, phase: 'ready', ready: Promise.resolve(session), done: new Promise(() => {}) };
  const vscode = { commands: { executeCommand: async () => {
    // Focusing the console can clear or change the editor's selected frame.
    vscode.debug.activeStackItem = undefined;
  } }, debug: {} };
  const repl = load('debug-repl.js', { vscode }).registerDebugRepl({ start: async () => record });
  const evaluating = repl.evaluate(target, ['(f 4)']);
  await entered.promise;
  record.phase = 'paused';
  await assert.rejects(repl.evaluate(target, ['x']), /Select a stack frame/);
  vscode.debug.activeStackItem = { session: { id: 'another-session' }, frameId: 23 };
  await assert.rejects(repl.evaluate(target, ['x']), /Select a stack frame/);
  vscode.debug.activeStackItem = { session, frameId: 23 };
  assert.equal((await repl.evaluate(target, ['x'])).result, '4');
  record.phase = 'running';
  await assert.rejects(repl.evaluate(target, ['(f 5)']), /already evaluating/);
  outer.resolve({ result: '8' });
  assert.equal((await evaluating).result, '8');
});

for (const name of ['sendSelection', 'sendSelectionToDebugRepl']) {
  test(`${name} sends all nonempty selections in source order without changing the editor`, async () => {
    const commands = new Map(), sent = [], errors = [];
    let launches = 0;
    const selection = (line, text) => ({ isEmpty: !text, text, start: { line, compareTo: other => line - other.line } });
    const selections = Object.freeze([selection(9, ''), selection(8, '(+ x 2)'), selection(3, '(define x 40) ; first')]);
    const editor = { selections, selection: selections[0],
      document: { uri: { scheme: 'file', fsPath: target.program }, languageId: 'racket', getText: range => range.text } };
    const terminal = { show() {}, sendText: text => sent.push(text) };
    const vscode = {
      workspace: { isTrusted: true, getWorkspaceFolder: () => undefined,
        getConfiguration: () => ({ get: () => 'racket' }) },
      window: { activeTextEditor: editor, onDidCloseTerminal: disposable,
        createTerminal: () => { launches++; return terminal; }, showErrorMessage: text => errors.push(text) },
      commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); } }
    };
    const debugRepl = { evaluate: async (actualTarget, expressions) => {
      assert.equal(actualTarget, target);
      launches++; sent.push(...expressions);
    } };
    load('commands.js', { vscode, './macro-stepper': { registerMacroStepper: () => () => {} },
      './execution': { activeTarget: async () => target } })
      .registerFileCommands({ subscriptions: [] }, {}, {}, debugRepl);
    const command = commands.get(`racketdap.${name}`);
    await command();
    assert.deepEqual(sent, ['(define x 40) ; first', '(+ x 2)']);
    assert.equal(editor.selections, selections);
    assert.equal(launches, 1);
    editor.selections = [selection(0, '')];
    await command();
    assert.match(errors.pop(), /Select a complete Racket expression/);
    editor.document.languageId = 'plaintext';
    await command();
    assert.match(errors.pop(), /Open a Racket editor/);
    assert.equal(launches, 1);
  });
}

test('selection batches keep the selected frame and evaluation lock, stopping after an error', async () => {
  const pending = deferred(), entered = deferred(), requests = [];
  const session = { id: 'owned', async customRequest(_method, args) {
    requests.push(args);
    if (args.expression === 'first') { entered.resolve(); return pending.promise; }
    if (args.expression === 'fail') throw new Error('Evaluation cancelled');
    return { result: '42' };
  } };
  const record = { session, phase: 'paused', ready: Promise.resolve(session), done: new Promise(() => {}) };
  const selected = { session, frameId: 23 };
  const vscode = { debug: { activeStackItem: selected }, commands: {
    executeCommand: async () => { vscode.debug.activeStackItem = undefined; }
  } };
  const repl = load('debug-repl.js', { vscode }).registerDebugRepl({ start: async () => record });
  const batch = repl.evaluate(target, ['first', 'fail', 'must-not-run']);
  await entered.promise;
  vscode.debug.activeStackItem = selected;
  await assert.rejects(repl.evaluate(target, ['concurrent']), /already evaluating/);
  pending.resolve({ result: '1' });
  await assert.rejects(batch, /Evaluation cancelled/);
  assert.deepEqual(requests.map(args => args.expression), ['first', 'fail']);
  assert.ok(requests.every(args => args.frameId === 23 && args.racketdapEcho));
  vscode.debug.activeStackItem = selected;
  assert.equal((await repl.evaluate(target, ['retry'])).result, '42');
});

test('captured source ownership gates Continue to Cursor and output does not update contexts', async () => {
  const factories = [], commands = new Map(), contextCalls = [], requests = [];
  const terminated = event();
  const uri = { scheme: 'debug', toString: () => 'debug:session-B/source-1' };
  const session = { id: 'A', type: 'racketdap', async customRequest(method, args) { requests.push({ method, args }); } };
  const vscode = {
    EventEmitter: class { event = () => disposable(); fire() {} dispose() {} },
    debug: {
      activeDebugSession: session, activeStackItem: { session, threadId: 1, frameId: 2 },
      registerDebugAdapterTrackerFactory(_type, factory) { factories.push(factory); return disposable(); },
      onDidChangeActiveDebugSession: disposable, onDidTerminateDebugSession: terminated.subscribe,
      asDebugSourceUri: () => uri,
      breakpoints: [
        { location: { uri: { scheme: 'debug', query: 'session=B&ref=1' } } },
        { location: { uri: { scheme: 'debug', query: 'session=C&ref=1' } } },
        { location: { uri: { scheme: 'file', query: '' } } },
        { functionName: 'no location' }
      ],
      removeBreakpoints(removed) { vscode.debug.breakpoints = vscode.debug.breakpoints.filter(item => !removed.includes(item)); }
    },
    window: { showErrorMessage() {}, activeTextEditor: { document: { uri }, selection: { active: { line: 8, character: 2 } } } },
    workspace: { onDidChangeTextDocument: disposable },
    languages: { onDidChangeDiagnostics: disposable },
    commands: {
      registerCommand(id, command) { commands.set(id, command); return disposable(); },
      async executeCommand(...args) { contextCalls.push(args); }
    }
  };
  const context = { subscriptions: [] };
  const sources = load('debug-sources.js', { vscode }).registerDebugSources(context);
  factories[0].createDebugAdapterTracker({ id: 'B' }).onDidSendMessage({
    type: 'event', event: 'loadedSource', body: { reason: 'new', source: { path: target.program, sourceReference: 1 } }
  });
  assert.equal(sources.pathFor(uri), target.program);
  assert.equal(sources.pathFor(uri, 'A'), undefined);
  assert.equal(sources.pathFor(uri, 'B'), target.program);
  const framed = factories[0].createDebugAdapterTracker({ id: 'C' });
  const frameOf = sourceReference => ({ type: 'response', command: 'stackTrace',
    body: { stackFrames: [{ source: { path: target.program, sourceReference } }, {}] } });
  terminated.fire({ id: 'B' });
  assert.deepEqual(vscode.debug.breakpoints.map(item => item.location?.uri.query), ['session=C&ref=1', '', undefined],
    'A session takes only its own captured breakpoints with it');
  framed.onDidSendMessage(frameOf(0));
  assert.equal(sources.pathFor(uri, 'C'), undefined, 'A file needs no captured source');
  framed.onDidSendMessage(frameOf(1));
  assert.equal(sources.pathFor(uri, 'C'), target.program, 'A saved edit gives its session a captured source');
  load('debug-actions.js', { vscode }).registerDebugActions(context, sources);
  const tracker = factories[1].createDebugAdapterTracker(session);
  tracker.onDidSendMessage({ type: 'event', event: 'stopped', body: { threadId: 1, racketdapActions: ['racketdap/continueToLocation'] } });
  const updates = contextCalls.length;
  for (let i = 0; i < 1000; i++) tracker.onDidSendMessage({ type: 'event', event: 'output', body: { output: 'line\n' } });
  assert.equal(contextCalls.length, updates);
  await assert.rejects(commands.get('racketdap.continueToCursor')(), /current Racket debug session/);
  assert.equal(requests.length, 0);
  terminated.fire(session);
  assert.ok(contextCalls.some(args => args[1] === 'racketdap.continueToCursor.enabled' && args[2] === false));
});

test('language startup deadline terminates a real unresponsive child', async t => {
  const timeout = deferred();
  const server = createLanguageProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, {
    timeout: 80, onTimeout: timeout.resolve
  });
  t.after(() => server.dispose());
  const child = await server.start();
  const exited = once(child, 'exit');
  assert.match((await timeout.promise).message, /timed out/);
  await exited;
  assert.equal(server.cancelled, true);
  await assert.rejects(server.start(), /cancelled/);
});

test('ready language processes clear the startup deadline and are reaped on disposal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let timedOut = false;
  const server = createLanguageProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, {
    timeout: 50, onTimeout: () => { timedOut = true; }
  });
  t.after(() => server.dispose());
  const child = await server.start();
  server.ready();
  t.mock.timers.tick(50);
  assert.equal(timedOut, false);
  t.mock.timers.reset();
  assert.equal(child.exitCode, null);
  const exited = once(child, 'exit');
  await server.dispose();
  await exited;
});

test('language cancellation closes owned pipes while a fixture descendant retains inherited stdio', async () => {
  const connected = deferred();
  let socket;
  let socketError;
  const cleanupServer = net.createServer(connection => {
    socket = connection;
    socket.on('error', error => { socketError = error; });
    connected.resolve(connection);
  });
  cleanupServer.listen(0, '127.0.0.1');
  await once(cleanupServer, 'listening');
  const descendant = `
    const socket = require('node:net').connect(${cleanupServer.address().port}, '127.0.0.1');
    let input = '';
    socket.on('data', chunk => {
      input += chunk;
      let end;
      while ((end = input.indexOf('\\n')) >= 0) {
        const command = input.slice(0, end);
        input = input.slice(end + 1);
        if (command === 'ping') socket.write('alive');
      }
    });
    socket.on('error', () => { process.exitCode = 1; });
    socket.on('close', () => process.exit(process.exitCode || 0));
  `;
  // Detach the fixture descendant so it can outlive its parent on Windows.
  // Its private control connection still owns its lifetime and cleanup.
  const parent = `
    require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {
      stdio: 'inherit', detached: true, windowsHide: true
    });
    setInterval(() => {}, 1000);
  `;
  const server = createLanguageProcess(process.execPath, ['-e', parent], {});
  let timer;
  try {
    const child = await server.start();
    await Promise.race([connected.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Fixture descendant did not connect')), 3000);
    })]);
    clearTimeout(timer);
    async function ping(stage) {
      const response = once(socket, 'data');
      socket.write('ping\n');
      try {
        const [answer] = await Promise.race([response, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Fixture descendant did not answer ${stage}`)), 1000);
        })]);
        assert.equal(answer.toString(), 'alive');
      } finally { clearTimeout(timer); }
    }
    await ping('before parent termination');
    server.cancelStart();
    await Promise.race([server.dispose(), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Inherited stdio blocked language process disposal')), 1000);
    })]);
    clearTimeout(timer);
    assert.ok(child.exitCode !== null || child.signalCode !== null, 'Owned child has exited');
    assert.ok(child.stdin.destroyed && child.stdout.destroyed && child.stderr.destroyed);
    // The descendant is still alive. Cleanup uses this private fixture socket,
    // never a numeric PID that could have been recycled after the parent exits.
    await ping('after parent termination');
  } finally {
    clearTimeout(timer);
    // The private control connection owns the fixture descendant's lifetime.
    // Closing it also releases inherited stdio if cancellation itself failed,
    // so cleanup cannot hide that failure behind a blocked close handshake.
    socket?.destroy();
    await new Promise(resolve => cleanupServer.close(resolve));
    await server.dispose();
  }
  assert.ifError(socketError);
});

for (const mode of ['cancel', 'reject', 'timeout']) test({
  cancel: 'restart and disposal cancel language initialization before joining its queue',
  reject: 'initialization failure reports once and SDK stop reaps the starting process',
  timeout: 'configured language startup deadline reaps its process and gives timeout-specific advice'
}[mode], async t => {
  const initializeFails = mode === 'reject';
  const configuredTimeout = mode === 'timeout' ? 1 : mode === 'cancel' ? 240 : 'unbounded';
  const commands = new Map(), starting = [];
  const children = [];
  const errors = [];
  const logs = [];
  const changes = event();
  const vscode = {
    StatusBarAlignment: { Left: 1 },
    window: {
      createOutputChannel: () => ({ appendLine() {}, append() {}, dispose() {}, show() {} }),
      createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {} }),
      showErrorMessage: async message => { errors.push(message); }, onDidChangeActiveTextEditor: disposable
    },
    workspace: {
      isTrusted: true, textDocuments: [], workspaceFolders: [],
      getConfiguration: () => ({ get: (key, fallback) => key === 'languageServer.startupTimeoutSeconds' ? configuredTimeout : fallback }),
      createFileSystemWatcher: disposable, onDidOpenTextDocument: disposable, onDidChangeConfiguration: changes.subscribe
    },
    extensions: { getExtension() {} },
    commands: { registerCommand(id, command) { commands.set(id, command); return disposable(); } }
  };
  class Client {
    constructor(_id, _name, factory, options) {
      this.factory = factory; this.options = options; this.state = event();
      this.diagnostics = disposable();
      this.entered = deferred(); starting.push(this.entered.promise);
    }
    createDefaultErrorHandler() { return { error: () => ({}), closed: () => ({ action: 'restart' }) }; }
    onDidChangeState = callback => this.state.subscribe(callback);
    onNotification = disposable;
    isRunning() { return false; }
    dispose() { return this.stop(); }
    async stop() { throw new Error('SDK cannot stop an initializing connection'); }
    error(message, data, showNotification) {
      logs.push({ message, data });
      if (showNotification) errors.push(message);
    }
    async start() {
      const child = await this.factory(); children.push(child); this.entered.resolve();
      if (!initializeFails) {
        await once(child, 'close');
        assert.equal(this.options.errorHandler.closed().action, 'stop');
      }
      const failure = new Error(initializeFails ? 'Initialize rejected' : 'Connection closed');
      assert.equal(this.options.initializationFailedHandler(failure), false);
      // Match the SDK failure path: its public stop is intentionally unawaited.
      // The owned client must make that operation valid during initialization.
      void this.stop();
      this.error('Client could not start', failure, true);
      throw failure;
    }
  }
  const language = load('language-client.js', {
    vscode,
    'vscode-languageclient/node': { LanguageClient: Client, State: {}, CloseAction: { DoNotRestart: 'stop' } },
    './workspace-index': { createWorkspaceIndex: () => ({ cancelStart() {}, async dispose() {} }) },
    './language-process': { ownedArgs: require('../vscode/language-process').ownedArgs, createLanguageProcess: (_command, _args, _options, lifecycle) => {
      assert.equal(lifecycle.timeout, mode === 'timeout' ? 1000 : mode === 'cancel' ? 240000 : 180000);
      return createLanguageProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {}, lifecycle);
    } }
  }).registerLanguageTools({ subscriptions: [], asAbsolutePath: value => value });
  t.after(() => language.dispose());
  const first = commands.get('racketdap.restartLanguageServer')();
  while (!starting.length) await Promise.resolve();
  await starting[0];
  if (mode !== 'cancel') {
    await first;
    await language.dispose();
    assert.equal(children.length, 1);
    assert.equal(errors.length, 1);
    assert.equal(logs.length, 1);
    assert.ok(logs[0].data instanceof Error, 'Client diagnostic detail is retained');
    if (initializeFails) assert.match(errors[0], /Initialize rejected/);
    else {
      assert.match(errors[0], /timed out after 1 seconds/);
      assert.match(errors[0], /startupTimeoutSeconds/);
      assert.doesNotMatch(errors[0], /Check racketdap.racketExecutable/);
    }
    assert.ok(children[0].exitCode !== null || children[0].signalCode !== null);
    return;
  }
  const second = commands.get('racketdap.restartLanguageServer')();
  await first;
  while (starting.length < 2) await Promise.resolve();
  await starting[1];
  await language.dispose();
  await second;
  assert.equal(children.length, 2);
  assert.deepEqual(errors, []);
  assert.equal(logs.length, 2, 'Cancelled startup diagnostics remain in Output');
  assert.ok(children.every(child => child.exitCode !== null || child.signalCode !== null));
});

function configurationProvider(version = 'Welcome to Racket v9.1 [cs].', context = {}) {
  let provider;
  let probes = 0;
  const errors = [];
  const vscode = { workspace: { isTrusted: true, getConfiguration: () => ({ get: (_key, fallback) => fallback }) },
    window: { showErrorMessage: async message => { errors.push(message); } },
    debug: { registerDebugConfigurationProvider(_type, value) { provider = value; return disposable(); },
      registerDebugAdapterDescriptorFactory: disposable, registerDebugAdapterTrackerFactory: disposable },
    commands: { registerCommand: disposable } };
  const dependencies = { vscode, 'node:child_process': { execFile(_file, _args, _options, done) {
    if (typeof _options === 'function') { _options(null, '', ''); return; }
    probes++;
    done(null, { stdout: version, stderr: '' });
  } } };
  for (const [name, methods] of Object.entries({
    terminal: ['createProgramTerminal'], 'language-client': ['registerLanguageTools'], commands: ['registerFileCommands'],
    'debug-actions': ['registerDebugActions'], 'debug-images': ['registerDebugImages'], 'debug-sources': ['registerDebugSources'],
    sessions: ['registerSessions'], testing: ['registerTesting'], 'debug-repl': ['registerDebugRepl'],
    interactions: ['registerInteractions'], 'file-runs': ['registerFileRuns'], packages: ['registerPackages'],
    'application-builds': ['registerApplicationBuilds'], 'application-logs': ['registerApplicationLogs'],
    'wxme-viewer': ['registerWxmeViewer'], 'wxme-editor': ['registerWxmeEditor'], dependencies: ['registerDependencies']
  })) dependencies[`./${name}`] = Object.fromEntries(methods.map(method => [method, () => ({})]));
  dependencies['./application-logs'].filterError = () => undefined;
  load('extension.js', dependencies).activate({ subscriptions: [], asAbsolutePath: file => path.join('/extension', file), ...context });
  return { provider, errors, vscode, probes: () => probes };
}

test('debug configurations share and reuse a successful executable version check', async () => {
  const { provider, errors, probes } = configurationProvider();
  const resolve = () => provider.resolveDebugConfigurationWithSubstitutedVariables(undefined,
    { request: 'attach', racketExecutable: process.execPath });
  assert.ok((await Promise.all([resolve(), resolve()])).every(Boolean));
  assert.ok(await resolve());
  assert.equal(probes(), 1);
  assert.deepEqual(errors, []);
});

test('a launch stops at its start unless it says otherwise, and an attach has no start', async () => {
  const { provider } = configurationProvider();
  const resolve = extra => provider.resolveDebugConfigurationWithSubstitutedVariables(
    { uri: { fsPath: path.dirname(__filename) } }, { type: 'racketdap', program: __filename, ...extra });
  assert.equal((await resolve({ request: 'launch' })).stopOnEntry, true);
  assert.equal((await resolve({ request: 'launch', stopOnEntry: false })).stopOnEntry, false);
  assert.equal((await resolve({ request: 'attach', port: 12345, token: 'private' })).stopOnEntry, undefined);
});

test('attach resolves without a program and inherits workspace selection', async () => {
  const { provider, errors } = configurationProvider();
  const configuration = { type: 'racketdap', request: 'attach', port: 12345, token: 'private' };
  Object.defineProperty(configuration, 'program', { get() { throw new Error('attach read program'); } });
  const result = await provider.resolveDebugConfigurationWithSubstitutedVariables({ uri: { fsPath: '/workspace' } }, configuration);
  assert.equal(result, configuration);
  assert.deepEqual(Array.from(result.sourceRoots), ['/workspace']);
  assert.deepEqual(Array.from(result.debugPackages), []);
  assert.equal(result.racketExecutable, 'racket');
  assert.deepEqual(errors, []);
  const noFolder = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach' });
  assert.deepEqual(Array.from(noFolder.sourceRoots), []);
});

test('launch still requires an existing program and resolves its directory', async () => {
  const { provider, errors } = configurationProvider();
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'launch' }), undefined);
  const program = path.resolve(__dirname, '../examples/demo.rkt');
  const result = await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'launch', program });
  assert.equal(result.program, program);
  assert.equal(result.cwd, path.dirname(program));
  assert.deepEqual(Array.from(result.sourceRoots), [path.dirname(program)]);
  assert.equal(errors.length, 1);
});

test('a relative program in a launch is relative to its working directory, or else to the workspace folder', async () => {
  const { provider, errors } = configurationProvider();
  const examples = path.resolve(__dirname, '../examples');
  const program = path.join(examples, 'demo.rkt');
  const resolve = (folder, extra) => provider.resolveDebugConfigurationWithSubstitutedVariables(folder, { request: 'launch', program: 'demo.rkt', ...extra });
  assert.equal((await resolve(undefined, { cwd: examples })).program, program);
  const fromFolder = await resolve({ uri: { fsPath: examples } }, {});
  assert.equal(fromFolder.program, program);
  assert.equal(fromFolder.cwd, examples);
  assert.equal(await resolve({ uri: { fsPath: examples } }, { cwd: __dirname }), undefined);
  assert.equal(errors.length, 1);
});

test('launch keeps compiled code in the extension storage, as the setting and attribute say', async () => {
  const storage = path.join(path.sep, 'storage');
  const { provider, vscode } = configurationProvider(undefined, { globalStorageUri: { fsPath: storage } });
  const program = path.resolve(__dirname, '../examples/demo.rkt');
  const resolve = extra => provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'launch', program, ...extra });
  const defaults = await resolve({});
  assert.equal(defaults.debugCache, true);
  assert.equal(defaults.debugCacheDirectory, path.join(storage, 'debug-cache'));
  assert.equal((await resolve({ debugCache: false })).debugCache, false);
  vscode.workspace.getConfiguration = () => ({ get: (key, fallback) => key === 'debug.compiledCache' ? false : fallback });
  assert.equal((await resolve({})).debugCache, false);
  assert.equal((await resolve({ debugCache: true })).debugCache, true);
});

test('attach keeps the Racket version and workspace trust checks', async () => {
  const { provider, errors, vscode } = configurationProvider('Welcome to Racket v8.18 [cs].');
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach' }), undefined);
  assert.match(errors[0], /Racket 9.1/);
  vscode.workspace.isTrusted = false;
  assert.equal(await provider.resolveDebugConfigurationWithSubstitutedVariables(undefined, { request: 'attach' }), undefined);
});

test('attach trackers do not read a launch program or create an Interactions view', () => {
  let logFactory, interactionsFactory;
  const vscode = { Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    debug: { registerDebugAdapterTrackerFactory(_type, factory) { logFactory = factory; return disposable(); },
      onDidTerminateDebugSession: disposable }, commands: { registerCommand: disposable } };
  const context = { subscriptions: [] };
  load('application-logs.js', { vscode }).registerApplicationLogs(context);
  const configuration = { request: 'attach', racketdapRichInteractions: true };
  Object.defineProperty(configuration, 'program', { get() { throw new Error('attach read program'); } });
  const session = { id: 'attachment', name: 'Embedded program', configuration };
  assert.ok(logFactory.createDebugAdapterTracker(session));
  vscode.debug.registerDebugAdapterTrackerFactory = (_type, factory) => { interactionsFactory = factory; return disposable(); };
  load('interactions.js', { vscode, './error-sources': { registerErrorSources: () => ({}) } }).registerInteractions(context, {});
  assert.equal(interactionsFactory.createDebugAdapterTracker(session), undefined);
  context.subscriptions.forEach(item => item.dispose());
});

function staleEditorFixture(sameDocument = false) {
  const callbacks = new Map(), requests = [];
  let factory;
  const uri = file => ({ scheme: 'file', fsPath: file, toString: () => `file://${file}` });
  const editor = (file, viewColumn, line, name) => ({
    viewColumn,
    document: { uri: uri(file), getWordRangeAtPosition: () => ({}), getText: () => name },
    selection: { isEmpty: true, active: { line, character: 0 } }
  });
  const stale = editor(sameDocument ? '/workspace/intended.rkt' : '/workspace/old.rkt', 1, 1, 'wrong');
  const intended = editor('/workspace/intended.rkt', 2, 3, 'right');
  const session = { id: 'session', type: 'racketdap', customRequest: async (method, args) => { requests.push({ method, args }); } };
  const vscode = {
    window: { activeTextEditor: stale, visibleTextEditors: [stale, intended],
      tabGroups: { activeTabGroup: { viewColumn: 2, activeTab: { input: { uri: intended.document.uri } } } },
      showErrorMessage() {}, showInputBox() { throw Error('unexpected prompt'); } },
    debug: { activeDebugSession: session, activeStackItem: { session, threadId: 1, frameId: 2 },
      registerDebugAdapterTrackerFactory(_type, value) { factory = value; return disposable(); },
      onDidChangeActiveDebugSession: disposable, onDidTerminateDebugSession: disposable },
    commands: { registerCommand(id, callback) { callbacks.set(id, callback); return disposable(); }, executeCommand: async () => {} }
  };
  load('debug-actions.js', { vscode }).registerDebugActions({ subscriptions: [] }, {});
  factory.createDebugAdapterTracker(session).onDidSendMessage({ type: 'event', event: 'stopped',
    body: { threadId: 1, racketdapActions: ['racketdap/continueToLocation', 'racketdap/printBinding', 'racketdap/setBinding'] } });
  return { callbacks, requests };
}
for (const same of [false, true]) test(`Continue to Cursor chooses the intended editor; same document = ${same}`, async () => {
  const { callbacks, requests } = staleEditorFixture(same);
  await callbacks.get('racketdap.continueToCursor')();
  assert.equal(requests[0].args.source.path, '/workspace/intended.rkt');
  assert.equal(requests[0].args.line, 4);
});
test('implicit Print Binding and Set Binding use the intended selection', async () => {
  const { callbacks, requests } = staleEditorFixture();
  await callbacks.get('racketdap.printBinding')();
  await callbacks.get('racketdap.setBinding')(undefined, '10');
  assert.deepEqual(requests.map(request => request.args.name), ['right', 'right']);
});
test('selected editor follows the active group and leaves editors outside the groups', () => {
  const { selectedEditor } = require('../vscode/selected-editor');
  const stale = { viewColumn: 1 }, shown = { viewColumn: 2 }, panel = {};
  const inGroup = viewColumn => ({ activeTabGroup: { viewColumn } });
  assert.equal(selectedEditor({ activeTextEditor: stale }), stale);
  assert.equal(selectedEditor({ activeTextEditor: panel, visibleTextEditors: [shown], tabGroups: inGroup(2) }), panel);
  assert.equal(selectedEditor({ activeTextEditor: stale, visibleTextEditors: [stale, shown], tabGroups: inGroup(1) }), stale);
  assert.equal(selectedEditor({ activeTextEditor: stale, visibleTextEditors: [stale, shown], tabGroups: inGroup(2) }), shown);
  // An active group that shows no text editor has no current editor.
  assert.equal(selectedEditor({ activeTextEditor: stale, visibleTextEditors: [stale, shown], tabGroups: inGroup(3) }), undefined);
});
