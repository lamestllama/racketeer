// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
// Drive one scripted debug session and keep every message the adapter sends, for
// comparing whole sessions. The stream is parsed apart from the client's own use.
const { DapClient } = require('../dap-client.js');

function record(client) {
  const messages = [];
  let buffer = Buffer.alloc(0);
  client.child.stdout.on('data', data => {
    buffer = Buffer.concat([buffer, data]);
    for (;;) {
      const end = buffer.indexOf('\r\n\r\n');
      if (end < 0) return;
      const length = Number(/^Content-Length: (\d+)$/i.exec(buffer.subarray(0, end).toString())[1]);
      if (buffer.length < end + 4 + length) return;
      messages.push(JSON.parse(buffer.subarray(end + 4, end + 4 + length).toString()));
      buffer = buffer.subarray(end + 4 + length);
    }
  });
  return messages;
}
const ok = async request => {
  const response = await request;
  if (!response.success) throw new Error(response.message);
  return response.body;
};
// Runs script(session) with breakpoints set; the session ends when the program does.
async function session(launch, breakpoints, script) {
  const client = new DapClient(undefined, { timeout: 120000, closeTimeout: 10000 });
  const messages = record(client);
  const context = { client, ok, messages, breakpointResponses: {} };
  try {
    await ok(client.request('initialize', { adapterID: 'racketdap', linesStartAt1: true, columnsStartAt1: true }));
    await ok(client.request('launch', launch));
    await client.event('initialized');
    for (const [path, lines] of Object.entries(breakpoints)) {
      context.breakpointResponses[path] = await ok(client.request('setBreakpoints', {
        source: { path }, breakpoints: lines.map(line => ({ line }))
      }));
    }
    if (script) await ok(client.request('setExceptionBreakpoints', { filters: ['uncaught'] }));
    await ok(client.request('configurationDone'));
    if (script) await script(context);
    await client.event('exited');
    await client.event('terminated').catch(() => {});
    return context;
  } finally {
    await client.close().catch(() => {});
  }
}
// Program output arrives through its own pump, so its place among other messages
// and the sequence numbers around it vary from run to run. It is compared as text
// per stream, and every other message in order, whole.
function normalized(messages) {
  const text = {};
  const others = [];
  for (const { seq, ...message } of messages) {
    if (message.event === 'output') text[message.body.category] = (text[message.body.category] || '') + message.body.output;
    else others.push(JSON.stringify(message));
  }
  return [JSON.stringify(text), ...others];
}
// A partial rebuild checks and builds dependencies before it loads them, so files
// are announced in another order and take other source reference numbers. Compare
// by path, with the announcements as sets; everything else stays in order.
function normalizedByFile(messages) {
  const names = new Map();
  for (const { event, body } of messages) {
    if (event === 'loadedSource') names.set(body.source.sourceReference, body.source.path);
  }
  const lines = normalized(messages).map(line => line.replace(/"sourceReference":(\d+)/g,
    (_, number) => `"sourceReference":${JSON.stringify(names.get(Number(number)) || number)}`))
    .map(line => {
      const message = JSON.parse(line);
      if (!message.body || !Array.isArray(message.body.sources)) return line;
      message.body.sources.sort((a, b) => a.path.localeCompare(b.path));
      return JSON.stringify(message);
    });
  const announcement = line => line.includes('"event":"loadedSource"') || line.includes('"event":"breakpoint"');
  return [...lines.filter(announcement).sort(), ...lines.filter(line => !announcement(line))];
}
module.exports = { session, normalized, normalizedByFile };
