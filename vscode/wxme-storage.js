// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { hash, limit } = require('./wxme-document');

async function readBytes(file, maximum = limit) {
  const handle = await fs.open(file, 'r');
  try {
    if ((await handle.stat()).size > maximum) throw new Error('WXME file exceeds its size limit.');
    const chunks = []; let size = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      size += chunk.length;
      if (size > maximum) throw new Error('WXME file exceeds its size limit.');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  } finally { await handle.close(); }
}

async function currentHash(file) {
  try { return hash(await readBytes(file)); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}

async function replaceFile(file, bytes, expected, check) {
  // Follow an existing symlink without replacing the link itself.
  const target = await fs.realpath(file).catch(error => { if (error.code === 'ENOENT') return file; throw error; });
  const mode = await fs.stat(target).then(s => s.mode, error => { if (error.code === 'ENOENT') return 0o666 & ~process.umask(); throw error; });
  const temporary = path.join(path.dirname(target), `.racketeer-wxme-${randomBytes(12).toString('hex')}`);
  try {
    const handle = await fs.open(temporary, 'wx', mode);
    try { await handle.chmod(mode); await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
    if (await currentHash(file) !== expected) throw new Error('The file changed outside this editor. Revert to reload it, or use Save As to keep your edits.');
    check();
    await fs.rename(temporary, target);
  } finally { await fs.rm(temporary, { force: true }); }
}

module.exports = { readBytes, currentHash, replaceFile };
