'use strict';
const { StringDecoder } = require('node:string_decoder');

class InteractionOutput {
  constructor(notify, limit = 32 * 1024 * 1024) {
    this.notify = notify; this.limit = limit; this.next = 0;
    this.entries = []; this.bytes = 0; this.decoders = new Map(); this.reporting = undefined;
  }
  clear() { this.entries = []; this.bytes = 0; this.decoders.clear(); this.reporting = undefined; this.notify({ type: 'clear' }); }
  append(kind, text) {
    if (!text) return;
    if (kind === 'stderr' && this.reporting && this.entries.includes(this.reporting)) {
      const entry = this.reporting; this.bytes -= this.size(entry);
      if (!entry.displayed) { entry.text = ''; entry.displayed = true; }
      entry.text += text; this.bytes += this.size(entry); this.publish(entry); return;
    }
    this.reporting = undefined;
    const last = this.entries.at(-1);
    if (last?.kind === kind && kind !== 'input' && last.text.length + text.length <= 65536) {
      last.text += text; this.bytes += Buffer.byteLength(text); this.publish(last); return;
    }
    const entry = { id: ++this.next, kind, text };
    this.entries.push(entry); this.bytes += this.size(entry); this.publish(entry);
  }
  error(text, detail, captureStderr = false) {
    const { sources, locations, omitted } = errorDetail(detail);
    const entry = { id: ++this.next, kind: 'error', text: text + '\n', sources, locations, omitted };
    this.entries.push(entry); this.bytes += this.size(entry); this.publish(entry);
    this.reporting = captureStderr && this.entries.includes(entry) ? entry : undefined;
  }
  output(body) {
    if (body.category === 'image') {
      const data = pngBytes(body);
      const entry = { id: ++this.next, kind: 'image', data: data.toString('base64') };
      this.entries.push(entry); this.bytes += this.size(entry); this.publish(entry);
    } else if (['stdout', 'stderr'].includes(body.category)) {
      let decoder = this.decoders.get(body.category);
      if (!decoder) this.decoders.set(body.category, decoder = new StringDecoder('utf8'));
      this.append(body.category, body.text || decoder.write(Buffer.from(body.data || '', 'base64')));
    }
  }
  finish() {
    for (const [kind, decoder] of this.decoders) this.append(kind, decoder.end());
    this.decoders.clear();
    this.reporting = undefined;
  }
  size(entry) { return Buffer.byteLength(entry.data || entry.text) + (entry.sources ? Buffer.byteLength(JSON.stringify(entry.sources)) + Buffer.byteLength(JSON.stringify(entry.locations)) : 0); }
  visible(entry) {
    if (entry.kind !== 'error') return entry;
    return { id: entry.id, kind: entry.kind, text: entry.text, locations: entry.locations,
      sources: entry.sources.map(source => ({ name: source.name })), omitted: entry.omitted };
  }
  snapshot() { return this.entries.map(entry => this.visible(entry)); }
  publish(entry) {
    const removed = [];
    while (this.entries.length > 1000 || this.bytes > this.limit) {
      const old = this.entries.shift(); this.bytes -= this.size(old); removed.push(old.id);
      if (old === this.reporting) this.reporting = undefined;
    }
    if (removed.length) this.notify({ type: 'remove', ids: removed });
    if (this.entries.includes(entry)) this.notify({ type: 'entry', entry: this.visible(entry) });
  }
}
function errorDetail(detail) {
  const empty = { sources: [], locations: [], omitted: !!detail?.omitted };
  if (!Array.isArray(detail?.sources) || !Array.isArray(detail.locations) || detail.sources.length > 8 || detail.locations.length > 8) return empty;
  let bytes = 0;
  for (const source of detail.sources) {
    if (typeof source?.content !== 'string' || typeof source.name !== 'string' || source.name.length > 4096 ||
        !(source.path === false || typeof source.path === 'string')) return empty;
    bytes += Buffer.byteLength(source.content); if (bytes > 1024 * 1024) return empty;
  }
  const locations = detail.locations.filter(location => {
    if (!Number.isInteger(location?.source) || location.source < 0 || location.source >= detail.sources.length) return false;
    if (!['line', 'column', 'endLine', 'endColumn'].every(key => Number.isSafeInteger(location[key]) && location[key] >= 1)) return false;
    const lines = detail.sources[location.source].content.split('\n');
    return location.line <= location.endLine && location.endLine <= lines.length &&
      location.column <= lines[location.line - 1].length + 1 && location.endColumn <= lines[location.endLine - 1].length + 1 &&
      (location.line < location.endLine || location.column <= location.endColumn);
  });
  return { sources: detail.sources, locations, omitted: !!detail.omitted };
}
function pngBytes(value) {
  if (value?.mimeType !== 'image/png' || typeof value.data !== 'string' || value.data.length > 12 * 1024 * 1024)
    throw new Error('Invalid image response.');
  const data = Buffer.from(value.data, 'base64');
  if (data.length > 8 * 1024 * 1024 || !data.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
    throw new Error('Invalid PNG image.');
  return data;
}
module.exports = { InteractionOutput, pngBytes };
