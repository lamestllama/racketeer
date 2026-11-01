// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
'use strict';

// Exclusions apply to descendants even when the request explicitly includes
// a descendant instead of its parent. Deduplicate overlapping selections.
function selectTests(roots, request) {
  const excluded = new Set((request.exclude || []).map(item => item.id));
  const result = new Map();
  function visit(item) {
    for (let ancestor = item; ancestor; ancestor = ancestor.parent) {
      if (excluded.has(ancestor.id)) return;
    }
    function excludesChild(parent) {
      let found = false;
      parent.children?.forEach(child => { if (excluded.has(child.id) || excludesChild(child)) found = true; });
      return found;
    }
    if (item.uri && !excludesChild(item)) result.set(item.id, item);
    else item.children?.forEach(visit);
  }
  if (request.include) request.include.forEach(visit); else roots.forEach(visit);
  return [...result.values()].filter(item => {
    for (let parent = item.parent; parent; parent = parent.parent) {
      if (result.has(parent.id)) return false;
    }
    return true;
  });
}

module.exports = { selectTests };
