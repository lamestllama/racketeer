'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
function harness(t) {
  const commands = new Map(), channels = [], errors = [], requests = [];
  let factory, choose, picker;
  const vscode = {
    Disposable: class { constructor(dispose) { this.dispose = dispose; } },
    debug: { registerDebugAdapterTrackerFactory(_type, value) { factory = value; return { dispose() {} }; }, onDidTerminateDebugSession() { return { dispose() {} }; } },
    commands: { registerCommand(name, callback) { commands.set(name, callback); return { dispose() {} }; } },
    window: {
      createOutputChannel(name) { const channel = { name, text: '', disposed: false, replace(text) { this.text = text; }, show() {}, dispose() { this.disposed = true; } }; channels.push(channel); return channel; },
      showErrorMessage(message) { errors.push(message); },
      showQuickPick(items) { picker = items; return new Promise(resolve => { choose = resolve; }); }
    }
  };
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../vscode/application-logs.js'), 'utf8'), {
    module, require: name => name === 'vscode' ? vscode : require(name), Buffer, setTimeout, clearTimeout
  });
  const context = { subscriptions: [] }; module.exports.registerApplicationLogs(context);
  const dispose = () => context.subscriptions.forEach(value => value.dispose()); t.after(dispose);
  function session(id) {
    const value = { id, name: id, configuration: { program: '/logs.rkt' }, customRequest: async (command, args) => { requests.push({ id, command, args }); } };
    return { value, tracker: factory.createDebugAdapterTracker(value) };
  }
  return { ...module.exports, session, commands, channels, errors, requests, dispose, pick: index => choose(picker[index]) };
}
const event = text => ({ type: 'event', event: 'racketdap/log', body: { entries: [{ level: 'info', topic: 'network', message: text }], dropped: 0 } });

test('logs keep their session identity during delayed selection and remain readable after stop', async t => {
  const h = harness(t), a = h.session('a'), b = h.session('b');
  a.tracker.onDidSendMessage(event('only-a')); b.tracker.onDidSendMessage(event('only-b'));
  const showing = h.commands.get('racketdap.showApplicationLog')(); h.pick(0); await showing;
  assert.match(h.channels[0].text, /only-a/); assert.doesNotMatch(h.channels[0].text, /only-b/);
  a.tracker.onDidSendMessage({ type: 'event', event: 'terminated' });
  await h.commands.get('racketdap.showApplicationLog')('a'); assert.match(h.channels[0].text, /Stopped/);
  await h.commands.get('racketdap.filterApplicationLog')('b', 'none debug@network');
  assert.equal(h.requests[0].id, 'b'); assert.match(h.channels[1].text, /none debug@network/);
  await h.commands.get('racketdap.clearApplicationLog')('a'); assert.doesNotMatch(h.channels[0].text, /only-a/);
  assert.match(h.channels[1].text, /only-b/);
});

test('pending filter responses cannot recreate channels after disposal', async t => {
  const h = harness(t), a = h.session('a'); let finish;
  a.value.customRequest = () => new Promise(resolve => { finish = resolve; });
  const filtering = h.commands.get('racketdap.filterApplicationLog')('a', 'info');
  await new Promise(resolve => setImmediate(resolve)); h.dispose(); finish(); await filtering;
  assert.equal(h.channels.length, 0);
});

test('closing the extension during session selection releases its output views', async t => {
  const h = harness(t); h.session('a'); h.session('b');
  const showing = h.commands.get('racketdap.showApplicationLog')();
  h.dispose(); h.pick(0); await showing; assert.equal(h.channels.length, 0);
});

test('retention limits bound messages and completed sessions with explicit omissions', async t => {
  const h = harness(t), output = new h.ApplicationLog();
  output.append({ entries: Array.from({ length: 1500 }, (_, i) => ({ level: 'debug', message: 'message-' + i })), dropped: 7 });
  assert.equal(output.entries.length, 1000); assert.equal(output.dropped, 507); assert.match(output.text(), /507 older messages omitted/);
  output.append({ entries: Array.from({ length: 100 }, () => ({ level: 'info', message: 'λ'.repeat(16000) })) });
  assert.ok(output.bytes <= 1024 * 1024);
  output.clear(); assert.equal(output.text(), '');
  for (let i = 0; i < 11; i++) {
    const record = h.session(String(i)); await h.commands.get('racketdap.showApplicationLog')(String(i)); record.tracker.onExit();
  }
  assert.equal(h.channels[0].disposed, true); assert.equal(h.channels.filter(channel => !channel.disposed).length, 10);
});

test('filter entry validates topics and does not send malformed requests', async t => {
  const h = harness(t); h.session('a');
  assert.equal(h.filterError(' warning debug@network none@storage '), undefined);
  assert.equal(h.filterError('none debug@topic-λ'), undefined);
  for (const value of ['', 'trace', 'debug@network', 'info warning', 'info debug@', 'info debug@a@b']) assert.ok(h.filterError(value));
  await h.commands.get('racketdap.filterApplicationLog')('a', 'bad'); assert.equal(h.requests.length, 0); assert.equal(h.errors.length, 1);
});
