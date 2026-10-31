'use strict';
const vscode = require('vscode');
const path = require('node:path');

function filterError(value) {
  if (typeof value !== 'string' || value.length > 4096) return 'Use a logging filter of at most 4096 characters.';
  if (!/^(none|fatal|error|warning|info|debug)(\s+(none|fatal|error|warning|info|debug)@[^@\s]+)*$/.test(value.trim()))
    return 'Start with a level, followed by optional level@topic overrides, for example: warning debug@network.';
}

class ApplicationLog {
  constructor() { this.clear(); }
  clear() { this.entries = []; this.bytes = 0; this.dropped = 0; this.discardedBacklog = false; }
  append(batch) {
    this.discardedBacklog ||= batch.discardedBacklog === true;
    this.dropped += Number.isSafeInteger(batch.dropped) && batch.dropped > 0 ? batch.dropped : 0;
    for (const entry of batch.entries || []) {
      if (!['fatal', 'error', 'warning', 'info', 'debug'].includes(entry.level) || typeof entry.message !== 'string') continue;
      const text = `[${entry.level}${entry.topic ? ` ${entry.topic}` : ''}] ${entry.message}\n`;
      const bytes = Buffer.byteLength(text);
      if (bytes > 1024 * 1024) { this.dropped++; continue; }
      this.entries.push({ text, bytes }); this.bytes += bytes;
      while (this.entries.length > 1000 || this.bytes > 1024 * 1024) {
        this.bytes -= this.entries.shift().bytes; this.dropped++;
      }
    }
  }
  text() {
    return (this.dropped ? `[${this.dropped} older messages omitted]\n` : '') +
      (this.discardedBacklog ? '[Additional queued messages omitted at a filter change or program exit]\n' : '') +
      this.entries.map(entry => entry.text).join('');
  }
}

function registerApplicationLogs(context) {
  const records = new Map();
  let sequence = 0, disposed = false;
  function render(record) {
    if (!record.channel) return;
    record.channel.replace(`${record.session.name} — ${record.ended ? 'Stopped' : 'Running'}\n` +
      `Capture filter: ${record.filter}\nFilters apply to new messages.\n\n` + record.output.text());
  }
  function schedule(record) {
    if (record.timer || !record.channel) return;
    record.timer = setTimeout(() => { record.timer = undefined; render(record); }, 50);
  }
  function release(record) { clearTimeout(record.timer); record.channel?.dispose(); records.delete(record.session.id); }
  function end(record) {
    record.ended = true; schedule(record);
    const ended = [...records.values()].filter(value => value.ended);
    for (const old of ended.slice(0, Math.max(0, ended.length - 10))) release(old);
  }
  async function select(target, live = false) {
    const id = typeof target === 'string' ? target : target?.id;
    if (id) {
      const record = records.get(id);
      if (!record || (live && record.ended)) throw new Error('This Racket session is no longer running.');
      return record;
    }
    const candidates = [...records.values()].filter(record => !live || !record.ended);
    if (!candidates.length) throw new Error('Start a Racket debug session or run a file in Interactions first.');
    if (candidates.length === 1) return candidates[0];
    const chosen = await vscode.window.showQuickPick(candidates.map(record => ({
      label: record.name, description: record.ended ? 'Stopped' : 'Running',
      detail: record.session.configuration.request === 'attach' ? record.session.name : record.session.configuration.program, record
    })), { title: 'Racket Application Logs', placeHolder: 'Choose the session whose log you want to use' });
    return chosen?.record;
  }
  function show(record) {
    if (disposed || records.get(record.session.id) !== record) return;
    record.channel ||= vscode.window.createOutputChannel(record.name, 'log');
    render(record); record.channel.show(true);
  }
  function command(name, action) {
    context.subscriptions.push(vscode.commands.registerCommand(`racketdap.${name}`, async (...args) => {
      try { return await action(...args); }
      catch (error) { void vscode.window.showErrorMessage(error.message); }
    }));
  }
  context.subscriptions.push(vscode.debug.registerDebugAdapterTrackerFactory('racketdap', {
    createDebugAdapterTracker(session) {
      const record = { session, output: new ApplicationLog(), filter: session.configuration.logFilter || 'error',
        name: `Racket Log ${++sequence}: ${(session.configuration.request === 'attach' ? session.name : path.basename(session.configuration.program))}`, ended: false };
      records.set(session.id, record);
      return {
        onDidSendMessage(message) {
          if (disposed || !records.has(session.id)) return;
          if (message.type === 'event' && message.event === 'racketdap/log') { record.output.append(message.body); schedule(record); }
          if (message.type === 'event' && message.event === 'terminated') end(record);
        },
        onExit() { if (!disposed && records.has(session.id)) end(record); }
      };
    }
  }), vscode.debug.onDidTerminateDebugSession(session => {
    const record = records.get(session.id); if (record) end(record);
  }), new vscode.Disposable(() => { disposed = true; for (const record of records.values()) release(record); }));
  command('showApplicationLog', async target => { const record = await select(target); if (record) show(record); });
  command('filterApplicationLog', async (target, filter) => {
    const record = await select(target, true); if (!record) return;
    filter ??= await vscode.window.showInputBox({ title: `Capture filter — ${record.name}`, value: record.filter,
      prompt: 'Levels: none, fatal, error, warning, info, debug. Topic overrides: warning debug@network.', validateInput: filterError });
    if (filter === undefined) return;
    if (disposed || record.ended || records.get(record.session.id) !== record) return;
    const error = filterError(filter); if (error) throw new Error(error);
    await record.session.customRequest('racketdap/logFilter', { filter: filter.trim() });
    if (disposed || !records.has(record.session.id)) return;
    record.filter = filter.trim(); show(record);
  });
  command('clearApplicationLog', async target => {
    const record = await select(target); if (record) { record.output.clear(); show(record); }
  });
}

module.exports = { ApplicationLog, filterError, registerApplicationLogs };
