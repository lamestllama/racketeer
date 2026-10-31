'use strict';
const { createHash } = require('node:crypto');
const limit = 32 * 1024 * 1024;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const boundary = (s, n) => Number.isInteger(n) && n >= 0 && n <= s.length &&
  !(n && n < s.length && /[\uD800-\uDBFF]/.test(s[n - 1]) && /[\uDC00-\uDFFF]/.test(s[n]));
function validText(s) {
  if (typeof s !== 'string') throw new Error('Invalid WXME text.');
  for (const char of s) if (char.length === 1 && /[\uD800-\uDFFF]/.test(char)) throw new Error('Text contains an incomplete Unicode character.');
}
function boxMode(node) {
  const key = node.kind === 'xml' ? 'eliminateWhitespace' : node.kind === 'racket' ? 'splicing' : undefined;
  if (!key) return {};
  if (typeof node[key] !== 'boolean') throw new Error('Invalid XML or Racket box mode.');
  return { [key]: node[key] };
}
function normalize(parts) {
  const result = [{ kind: 'text', text: '' }];
  for (const part of parts) {
    if (part.kind === 'text') result.at(-1).text += part.text;
    else {
      if (!['image', 'editor', 'comment', 'xml', 'racket'].includes(part.kind)) throw new Error('This document contains an object that cannot be edited safely.');
      boxMode(part);
      result.push(part.parts ? { ...part, parts: normalize(part.parts) } : { ...part }, { kind: 'text', text: '' });
    }
  }
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freeze); Object.freeze(value);
  }
  return value;
}

// Text is a piece table: unchanged UTF-16 spans refer to the original document;
// inserted text is literal. Stable identities survive structural changes. Undo
// restores immutable trees, including the provenance used to retain text styles.
class WxmeDocument {
  constructor(uri, bytes, decoded) {
    this.uri = uri; this.bytes = bytes; this.diskHash = hash(bytes);
    this.originals = new Map(); this.revision = 0; this.nextId = 0;
    const seed = (parts, prefix = []) => normalize(parts).map((part, index) => {
      const path = [...prefix, index], id = path.join('/'); this.originals.set(id, freeze(part));
      if (part.kind === 'text') return { kind: 'text', id, pieces: part.text ? [{ source: id, start: 0, end: part.text.length }] : [] };
      if (part.parts) return { kind: part.kind, ...boxMode(part), id, source: id, parts: seed(part.parts, path) };
      return { kind: 'image', id, source: id };
    });
    this.initial = freeze(seed(decoded.parts)); this.setTree(this.initial);
  }
  pieceText(piece) {
    if (Object.hasOwn(piece, 'text')) { validText(piece.text); return piece.text; }
    const original = this.originals.get(piece.source);
    if (original?.kind !== 'text' || !boundary(original.text, piece.start) || !boundary(original.text, piece.end) || piece.start > piece.end)
      throw new Error('Invalid original text span.');
    return original.text.slice(piece.start, piece.end);
  }
  text(node) { return node.pieces.map(p => this.pieceText(p)).join(''); }
  image(node) {
    const image = node.source === undefined ? node : this.originals.get(node.source);
    if (image?.kind !== 'image' || ![image.width, image.height].every(n => Number.isInteger(n) && n > 0 && n <= 4096) ||
        typeof image.data !== 'string' || image.data.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]+={0,2}$/.test(image.data) ||
        !Buffer.from(image.data, 'base64').subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new Error('Invalid embedded PNG image.');
    return { kind: 'image', width: image.width, height: image.height, data: image.data };
  }
  inspect(tree) {
    const nodes = new Map(), fields = new Map(); let size = 0, count = 0, pieceCount = 0;
    const visit = (parts, depth = 0, parent = undefined) => {
      if (depth > 32 || !Array.isArray(parts) || !parts.length || parts.length % 2 !== 1) throw new Error('Invalid WXME editor structure (maximum 32 levels).');
      return Array.from(parts, (node, index) => {
        if (++count > 10000) throw new Error('Document exceeds 10000 elements.');
        if (!node || typeof node.id !== 'string' || !/^(?:\d+(?:\/\d+)*|n\d+)$/.test(node.id) || node.id.length > 128 || nodes.has(node.id)) throw new Error('Invalid or duplicate element identity.');
        if ((index % 2 === 0) !== (node.kind === 'text')) throw new Error('Text and object boundaries must alternate.');
        nodes.set(node.id, { node, parent, index });
        if (node.kind === 'text') {
          if (!Array.isArray(node.pieces) || (pieceCount += node.pieces.length) > 100000) throw new Error('Too many text spans.');
          const part = { kind: 'text', text: this.text(node) }; size += Buffer.byteLength(part.text);
          fields.set(node.id, { part, node }); return part;
        }
        if (node.source !== undefined && this.originals.get(node.source)?.kind !== node.kind) throw new Error('Invalid original object reference.');
        if (node.kind === 'image') { const part = this.image(node); size += part.data.length; return part; }
        if (!['editor', 'comment', 'xml', 'racket'].includes(node.kind)) throw new Error('Unsupported WXME object.');
        return { kind: node.kind, ...boxMode(node), parts: visit(node.parts, depth + 1, node.id) };
      });
    };
    const parts = visit(tree);
    if (size > limit) throw new Error('Document content exceeds 32 MiB.');
    return { nodes, fields, parts, size };
  }
  setTree(tree) {
    const state = this.inspect(tree); this.tree = freeze(tree); Object.assign(this, state);
  }
  applyState(tree) { this.setTree(tree); this.revision++; }
  update(parts, parent, index, replacement) {
    if (parent === undefined) return [...parts.slice(0, index), ...replacement, ...parts.slice(index + 1)];
    return parts.map(node => node.id === parent ? { ...node, parts: [...node.parts.slice(0, index), ...replacement, ...node.parts.slice(index + 1)] } :
      node.parts ? { ...node, parts: this.update(node.parts, parent, index, replacement) } : node);
  }
  transact(tree, label, structural = false, id) {
    const before = this.tree; this.applyState(tree);
    return { before, after: this.tree, label, structural, id };
  }
  slice(pieces, start, end) {
    const result = []; let position = 0;
    for (const piece of pieces) {
      const text = this.pieceText(piece), a = Math.max(0, start - position), b = Math.min(text.length, end - position);
      if (a < b) result.push(Object.hasOwn(piece, 'text') ? { text: text.slice(a, b) } : { ...piece, start: piece.start + a, end: piece.start + b });
      position += text.length;
    }
    return result;
  }
  compact(pieces) {
    const result = [];
    for (const piece of pieces) {
      const last = result.at(-1);
      if (piece.text === '' || (piece.source !== undefined && piece.start === piece.end)) continue;
      if (last && Object.hasOwn(last, 'text') && Object.hasOwn(piece, 'text')) result[result.length - 1] = { text: last.text + piece.text };
      else if (last?.source !== undefined && last.source === piece.source && last.end === piece.start) result[result.length - 1] = { ...last, end: piece.end };
      else result.push(piece);
    }
    return result;
  }
  edit(id, text, before) {
    const entry = this.nodes.get(id); validText(text);
    if (entry?.node.kind !== 'text') throw new Error('Invalid WXME text edit.');
    const old = this.text(entry.node);
    if (before !== undefined && before !== old) throw new Error('The text changed in another view. Try the edit again.');
    if (old === text) return undefined;
    let prefix = 0, suffix = 0;
    while (prefix < Math.min(old.length, text.length) && old[prefix] === text[prefix]) prefix++;
    while (!boundary(old, prefix) || !boundary(text, prefix)) prefix--;
    while (suffix < Math.min(old.length, text.length) - prefix && old[old.length - suffix - 1] === text[text.length - suffix - 1]) suffix++;
    while (!boundary(old, old.length - suffix) || !boundary(text, text.length - suffix)) suffix--;
    const pieces = this.compact([...this.slice(entry.node.pieces, 0, prefix), { text: text.slice(prefix, text.length - suffix) }, ...this.slice(entry.node.pieces, old.length - suffix, old.length)]);
    const change = this.transact(this.update(this.tree, entry.parent, entry.index, [{ ...entry.node, pieces }]), 'Edit WXME text', false, id);
    return { ...change, old, text };
  }
  insert(id, start, end, kind, image) {
    const entry = this.nodes.get(id), node = entry?.node;
    if (node?.kind !== 'text' || !['image', 'comment', 'editor', 'xml', 'racket', 'splice'].includes(kind)) throw new Error('Invalid insertion location or object type.');
    const text = this.text(node);
    if (!boundary(text, start) || !boundary(text, end) || start > end) throw new Error('Selection splits a Unicode character or is out of range.');
    const identity = () => `n${this.nextId++}`;
    const object = kind === 'image' ? { ...this.image({ ...image, source: undefined }), id: identity() } :
      { kind: kind === 'splice' ? 'racket' : kind, ...(kind === 'xml' ? { eliminateWhitespace: false } :
        ['racket', 'splice'].includes(kind) ? { splicing: kind === 'splice' } : {}),
        id: identity(), parts: [{ kind: 'text', id: identity(), pieces: this.slice(node.pieces, start, end) }] };
    const replacement = [{ ...node, pieces: this.slice(node.pieces, 0, start) }, object,
      { kind: 'text', id: identity(), pieces: this.slice(node.pieces, end, text.length) }];
    return { ...this.transact(this.update(this.tree, entry.parent, entry.index, replacement), `Insert ${kind === 'editor' ? 'nested editor' : kind}`, true), focus: object.parts?.[0]?.id || node.id };
  }
  remove(id) {
    const entry = this.nodes.get(id);
    if (!entry || entry.node.kind === 'text') throw new Error('Select an embedded object to remove.');
    const siblings = entry.parent === undefined ? this.tree : this.nodes.get(entry.parent).node.parts;
    const left = siblings[entry.index - 1], right = siblings[entry.index + 1];
    const merged = { ...left, pieces: this.compact([...left.pieces, ...right.pieces]) };
    const replace = parts => parts === siblings ? [...parts.slice(0, entry.index - 1), merged, ...parts.slice(entry.index + 2)] :
      parts.map(node => node.parts ? { ...node, parts: replace(node.parts) } : node);
    return this.transact(replace(this.tree), `Remove ${entry.node.kind}`, true);
  }
  changeMode(id, value) {
    const entry = this.nodes.get(id), node = entry?.node;
    if (!node || !['xml', 'racket'].includes(node.kind) || typeof value !== 'boolean') throw new Error('Invalid XML or Racket box mode.');
    const key = node.kind === 'xml' ? 'eliminateWhitespace' : 'splicing';
    if (node[key] === value) return undefined;
    return this.transact(this.update(this.tree, entry.parent, entry.index, [{ ...node, [key]: value }]),
      node.kind === 'xml' ? 'Change XML whitespace' : 'Change Racket splicing', true);
  }
  changed() { return this.tree !== this.initial && JSON.stringify(this.tree) !== JSON.stringify(this.initial); }
  snapshot() { return { bytes: this.bytes, tree: this.tree, parts: this.parts, revision: this.revision }; }
  request() { return { version: 1, bytes: this.bytes.toString('base64'), tree: this.tree }; }
  backup() { return Buffer.from(JSON.stringify({ version: 2, bytes: this.bytes.toString('base64'), diskHash: this.diskHash, nextId: this.nextId, tree: this.tree })); }
  restore(backup) {
    if (!/^[a-f0-9]{64}$/.test(backup.diskHash)) throw new Error('Invalid WXME backup.');
    const before = this.tree, previousRevision = this.revision, previousId = this.nextId;
    try {
      if (backup.version === 1 && Array.isArray(backup.edits)) {
        for (const edit of backup.edits) this.edit(edit.path.join('/'), edit.text);
      } else if (backup.version === 2 && Number.isSafeInteger(backup.nextId) && backup.nextId >= 0) {
        this.setTree(backup.tree);
        for (const id of this.nodes.keys()) if (id.startsWith('n') && Number(id.slice(1)) >= backup.nextId) throw new Error('Invalid backup identity sequence.');
        this.nextId = backup.nextId;
      } else throw new Error('Invalid WXME backup version.');
    } catch (error) { this.setTree(before); this.revision = previousRevision; this.nextId = previousId; throw error; }
    this.diskHash = backup.diskHash;
  }
}
module.exports = { WxmeDocument, normalize, hash, limit, boundary, boxMode };
