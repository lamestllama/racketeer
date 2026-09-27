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
    if (item.uri) result.set(item.id, item);
    else item.children.forEach(visit);
  }
  if (request.include) request.include.forEach(visit); else roots.forEach(visit);
  return [...result.values()];
}

module.exports = { selectTests };
