'use strict';
const { StringDecoder } = require('node:string_decoder');

class InteractionOutput {
  constructor(notify, limit = 32 * 1024 * 1024) {
    this.notify = notify; this.limit = limit; this.next = 0;
    this.entries = []; this.bytes = 0; this.decoders = new Map();
  }
  clear() { this.entries = []; this.bytes = 0; this.decoders.clear(); this.notify({ type: 'clear' }); }
  append(kind, text) {
    if (!text) return;
    const last = this.entries.at(-1);
    if (last?.kind === kind && kind !== 'input' && last.text.length + text.length <= 65536) {
      last.text += text; this.bytes += Buffer.byteLength(text); this.publish(last); return;
    }
    const entry = { id: ++this.next, kind, text };
    this.entries.push(entry); this.bytes += this.size(entry); this.publish(entry);
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
  }
  size(entry) { return Buffer.byteLength(entry.data || entry.text); }
  publish(entry) {
    const removed = [];
    while (this.entries.length > 1000 || this.bytes > this.limit) {
      const old = this.entries.shift(); this.bytes -= this.size(old); removed.push(old.id);
    }
    if (removed.length) this.notify({ type: 'remove', ids: removed });
    if (this.entries.includes(entry)) this.notify({ type: 'entry', entry });
  }
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
