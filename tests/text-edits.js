// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

function edited(text, edits = []) {
  const offset = position => text.split('\n').slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character;
  for (const edit of [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start))) {
    const start = offset(edit.range.start), end = offset(edit.range.end);
    text = text.slice(0, start) + edit.newText + text.slice(end);
  }
  return text;
}

module.exports = { edited };
