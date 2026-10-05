'use strict';
const { createHash } = require('node:crypto');
const limit = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

function normalize(parts) {
  const result = [{ kind: 'text', text: '' }];
  for (const part of parts) {
    if (part.kind === 'text') result.at(-1).text += part.text;
    else {
      if (!['image', 'editor', 'comment'].includes(part.kind)) throw new Error('This document contains an object that cannot be edited safely.');
      result.push(part.parts ? { ...part, parts: normalize(part.parts) } : { ...part }, { kind: 'text', text: '' });
    }
  }
  return result;
}

class WxmeDocument {
  constructor(uri, bytes, decoded) {
    this.uri = uri; this.bytes = bytes; this.diskHash = hash(bytes);
    this.parts = normalize(decoded.parts); this.fields = new Map(); this.revision = 0;
    const visit = (parts, prefix = []) => parts.forEach((part, index) => {
      const path = [...prefix, index];
      if (part.kind === 'text') this.fields.set(path.join('/'), { part, original: part.text, path });
      else if (part.parts) visit(part.parts, path);
    });
    visit(this.parts);
    this.size = [...this.fields.values()].reduce((n, { part }) => n + Buffer.byteLength(part.text), 0);
  }
  edit(id, text, before) {
    const field = this.fields.get(id);
    if (!field || typeof text !== 'string') throw new Error('Invalid WXME text edit.');
    if (before !== undefined && before !== field.part.text) throw new Error('The text changed in another view. Try the edit again.');
    const size = this.size - Buffer.byteLength(field.part.text) + Buffer.byteLength(text);
    if (size > limit) throw new Error('Edited text exceeds 32 MiB.');
    const old = field.part.text;
    if (old === text) return undefined;
    field.part.text = text; this.size = size; this.revision++;
    return { old, text };
  }
  edits() {
    return [...this.fields.values()].filter(f => f.original !== f.part.text)
      .map(f => ({ path: f.path, text: f.part.text }));
  }
  backup() {
    return Buffer.from(JSON.stringify({ version: 1, bytes: this.bytes.toString('base64'), diskHash: this.diskHash, edits: this.edits() }));
  }
  restore(backup) {
    if (backup.version !== 1 || !Array.isArray(backup.edits) || !/^[a-f0-9]{64}$/.test(backup.diskHash)) throw new Error('Invalid WXME backup.');
    for (const edit of backup.edits) this.edit(edit.path.join('/'), edit.text);
    this.diskHash = backup.diskHash;
  }
}

module.exports = { WxmeDocument, normalize, hash, limit };
