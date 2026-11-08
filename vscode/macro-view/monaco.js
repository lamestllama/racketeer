// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
(function (root) {
  'use strict';
  function propertiesLayout(width, height, fraction = 1 / 3, visible = true) {
    const editorMinimum = 320, panelMinimum = 180, divider = 6;
    const below = visible && width < editorMinimum + divider + panelMinimum;
    const minFraction = visible && !below ? Math.max(.2, panelMinimum / width) : .2;
    const maxFraction = visible && !below ? Math.min(.4, (width - divider - editorMinimum) / width) : .4;
    const f = Math.max(minFraction, Math.min(maxFraction, Number.isFinite(fraction) ? fraction : 1 / 3));
    const panelSize = visible ? (below ? Math.max(0, height - divider) : width) * f : 0;
    return { below, fraction: f, minFraction, maxFraction, panelSize,
      columns: visible && !below ? `minmax(320px, 1fr) 6px ${panelSize}px` : 'minmax(0, 1fr)',
      rows: below ? `minmax(0, 1fr) 6px ${panelSize}px` : 'minmax(0, 1fr)' };
  }
  const scopeColorCount = 17;
  const scopeCandidates = [
    ...['red', 'blue', 'green', 'orange', 'purple'].map(name => `--vscode-charts-${name}`),
    ...['Red', 'Green', 'Blue', 'Magenta', 'Cyan', 'White',
      'BrightRed', 'BrightGreen', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite',
      'Black', 'BrightBlack'].map(name => `--vscode-terminal-ansi${name}`)
  ];
  function scopePalette(variables) {
    if (!variables) return scopeCandidates.slice(0, scopeColorCount);
    const get = name => typeof variables.getPropertyValue === 'function' ? variables.getPropertyValue(name) : variables[name];
    const arrow = color(get('--vscode-charts-yellow'))?.toLowerCase();
    const used = new Set([arrow]), palette = [];
    // Chart and ANSI variables sometimes resolve to the same colour. Spare
    // ANSI entries keep those themes distinct without assigning yellow.
    for (const name of scopeCandidates) {
      const resolved = color(get(name))?.toLowerCase();
      if (resolved && !used.has(resolved)) { palette.push(name); used.add(resolved); }
    }
    // Missing/customized variables can leave fewer distinct values available.
    // Keep slot identities defined, while continuing to exclude arrow yellow.
    for (const name of scopeCandidates) {
      if (!palette.includes(name) && (!arrow || color(get(name))?.toLowerCase() !== arrow)) palette.push(name);
    }
    return palette.slice(0, scopeColorCount);
  }
  const scopeSlot = group => group - 1;
  const scopeVariable = (group, variables) => group > 0 && group <= scopeColorCount ? scopePalette(variables)[scopeSlot(group)] : undefined;
  // CSS variables carry resolved workbench customizations, including defaults.
  // IDs come from the bundled editor's color registry, so new editor colors
  // do not need a second, manually maintained allowlist here.
  function color(value) {
    const v = String(value || '').trim();
    if (/^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(v)) return v;
    if (/^#[\da-f]{3,4}$/i.test(v)) return '#' + [...v.slice(1)].map(c => c + c).join('');
    if (v === 'transparent') return '#00000000';
    const rgb = v.match(/^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+)(%)?)?\s*\)$/i);
    if (!rgb) return undefined;
    const bytes = rgb.slice(1, 4).map(n => Math.max(0, Math.min(255, Math.round(Number(n)))));
    if (rgb[4] !== undefined) bytes.push(Math.round(Math.max(0, Math.min(1, Number(rgb[4]) / (rgb[5] ? 100 : 1))) * 255));
    return '#' + bytes.map(n => n.toString(16).padStart(2, '0')).join('');
  }
  function theme(variables, styles, colorIds, kind = 'vscode-dark') {
    const get = name => typeof variables.getPropertyValue === 'function' ? variables.getPropertyValue(name) : variables[name];
    const colors = {};
    for (const id of colorIds) {
      const value = color(get('--vscode-' + id.replace(/\./g, '-')));
      if (value) colors[id] = value;
    }
    const rules = styles.map((s, i) => ({ token: `macro${i}`,
      foreground: (s.foreground || colors['editor.foreground'] || '').replace(/^#/, ''),
      fontStyle: ['italic', 'bold', 'underline', 'strikethrough'].filter((_, bit) => s.fontStyle & (1 << bit)).join(' ') }));
    return { base: kind.includes('high-contrast-light') ? 'hc-light' : kind.includes('high-contrast') ? 'hc-black' : kind === 'vscode-light' ? 'vs' : 'vs-dark',
      inherit: true, colors, rules: [...rules, ...rules.flatMap(rule => scopePalette(variables).map((variable, slot) => ({
        ...rule, token: `${rule.token}.scope${slot}`,
        foreground: (color(get(variable)) || colors['editor.foreground'] || '').replace(/^#/, '')
      })))] };
  }
  class LineState {
    constructor(line = 0) { this.line = line; }
    clone() { return this; }
    equals(other) { return other instanceof LineState && other.line === this.line; }
  }
  function tokenType(scopes) {
    return scopes?.some(s => /^comment(?:\.|$)/.test(s)) ? 'comment'
      : scopes?.some(s => /^(?:string|constant\.character)(?:\.|$)/.test(s)) ? 'string' : '';
  }
  function tokenLines(text, spans) {
    const starts = [0];
    for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
    const lines = starts.map(() => [{ startIndex: 0, scopes: '' }]);
    const push = (n, startIndex, scopes) => {
      const last = lines[n].at(-1);
      if (last.startIndex === startIndex) last.scopes = scopes;
      else if (last.scopes !== scopes) lines[n].push({ startIndex, scopes });
    };
    let line = 0;
    for (const t of spans) {
      while (line + 1 < starts.length && starts[line + 1] <= t.start) line++;
      const kind = t.type || tokenType(t.scopes), type = kind ? `.${kind}` : '';
      for (let n = line; n < starts.length && starts[n] < t.end; n++) {
        const start = Math.max(starts[n], t.start), end = Math.min(t.end, starts[n + 1] === undefined ? text.length : starts[n + 1] - 1);
        if (end > start) {
          push(n, start - starts[n], `macro${t.style}${t.group > 0 && t.group <= scopeColorCount ? `.scope${scopeSlot(t.group)}` : ''}${type}`);
          const lineEnd = starts[n + 1] === undefined ? text.length : starts[n + 1] - 1;
          if (end < lineEnd) push(n, end - starts[n], '');
        }
      }
    }
    return lines;
  }
  function provider(lines) {
    return { getInitialState: () => new LineState(), tokenize: (_line, state) => ({
      tokens: lines[state.line] || [{ startIndex: 0, scopes: '' }], endState: new LineState(state.line + 1)
    }) };
  }
  // The innermost printed occurrence owns each interval, including delimiters
  // and whitespace. A written child (group 0) cancels its parent's colour.
  // Splitting tokens preserves their string/comment types for bracket matching;
  // Monaco's bracket decorations still override these token foregrounds.
  function scopeTokens(section, tokens) {
    const events = [];
    section.occurrences.forEach((o, order) => {
      const range = o.colorRange || o.range;
      events.push({ at: range[0], enter: true, o, order }, { at: range[1], enter: false, o, order });
    });
    tokens.forEach(t => events.push({ at: t.start, enter: true, t }, { at: t.end, enter: false, t }));
    events.sort((a, b) => a.at - b.at || Number(a.enter) - Number(b.enter) || Number(!!b.o) - Number(!!a.o) ||
      (a.o && b.o ? (a.enter ? 1 : -1) * ((b.o.colorRange || b.o.range)[1] - b.o.range[0] - ((a.o.colorRange || a.o.range)[1] - a.o.range[0]) || a.order - b.order) : 0));
    const active = [], result = [];
    let token, previous = 0;
    const emit = end => {
      if (end <= previous) return;
      const span = { ...(token || { style: 0 }), start: previous, end, group: active.at(-1)?.macroScopeGroup || 0 };
      const last = result.at(-1);
      if (last && last.end === previous && last.style === span.style && last.type === span.type && last.scopes === span.scopes && last.group === span.group) last.end = end;
      else result.push(span);
      previous = end;
    };
    for (const event of events) {
      emit(event.at);
      if (event.o) {
        if (event.enter) active.push(event.o);
        else active.splice(active.indexOf(event.o), 1);
      } else token = event.enter ? event.t : undefined;
    }
    emit(section.text.length);
    return result;
  }
  function lineNumbers(model, parts) {
    const starts = parts.map(p => model.getPositionAt(p.start).lineNumber);
    return line => {
      let first = 1;
      for (const start of starts) { if (start > line) break; first = start; }
      return String(line - first + 1);
    };
  }
  function compose(items) {
    let text = '';
    const parts = items.map(item => {
      const raw = item.section.text, removed = [];
      for (let i = 0; i < raw.length - 1; i++) if (raw[i] === '\r' && raw[i + 1] === '\n') removed.push(i);
      text += item.prefix || '';
      const start = text.length, value = raw.replace(/\r\n/g, '\n');
      const offset = n => {
        let lo = 0, hi = removed.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (removed[mid] < n) lo = mid + 1; else hi = mid; }
        return start + n - lo;
      };
      text += value;
      if (!text.endsWith('\n')) text += '\n';
      return { ...item, start, end: start + value.length, offset };
    });
    return { text, parts };
  }
  // Keep both unchanged ends in Monaco's model and view. applyEdits bypasses
  // the undo stack; false also avoids computing an unused inverse edit.
  function editText(model, text) {
    const old = model.getValue();
    let start = 0, end = old.length, nextEnd = text.length;
    while (start < end && start < nextEnd && old[start] === text[start]) start++;
    while (end > start && nextEnd > start && old[end - 1] === text[nextEnd - 1]) { end--; nextEnd--; }
    // A common UTF-16 unit must not leave half a scalar in the model.
    if (start > 0 && /[\uD800-\uDBFF]/.test(old[start - 1])) start--;
    if (end < old.length && /[\uDC00-\uDFFF]/.test(old[end])) { end++; nextEnd++; }
    const a = model.getPositionAt(start), b = model.getPositionAt(end);
    const range = { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
    // An identical position still has one empty edit, without touching a line.
    model.applyEdits([{ range, text: text.slice(start, nextEnd) }], false);
    return { range, newEnd: model.getPositionAt(nextEnd), identical: old === text };
  }
  function range(model, part, r) {
    const a = model.getPositionAt(part.offset(r[0])), b = model.getPositionAt(part.offset(r[1]));
    return { startLineNumber: a.lineNumber, startColumn: a.column, endLineNumber: b.lineNumber, endColumn: b.column };
  }
  function decorations(model, parts, marks = {}) {
    const result = [];
    const add = (p, r, cls) => result.push({ range: range(model, p, r), options: {
      description: cls, ...((cls === 'macro-hover' || cls.startsWith('macro-word-highlight')) ? { className: cls } : { inlineClassName: cls }), stickiness: 1
    } });
    for (const p of parts) {
      for (const r of p.section.frontier || []) add(p, r, 'macro-frontier');
      if (marks.highlightRedexContractum !== false && (!marks.changeSections || marks.changeSections.includes(p.section.id))) {
        for (const r of p.section.focus) add(p, r, p.kind === 'after' ? 'macro-after' : 'macro-before');
      }
      for (const o of p.section.occurrences) {
        if (o.taint && marks.taintIcons !== 'none') result.push({
          range: range(model, p, [o.range[0], o.range[0]]), options: {
            description: 'macro-taint', stickiness: 1,
            before: { content: (marks.taintIcons === 'unicode'
              ? { armed: '🔒', disarmed: '🔓', tainted: '💥' }
              : { armed: '\uea75', disarmed: '\ueb74', tainted: '\uea86' })[o.taint].repeat(o.taintCount),
            inlineClassName: `macro-taint macro-taint-${o.taint}${marks.taintIcons === 'unicode' ? '' : ' macro-taint-codicon'}`,
            inlineClassNameAffectsLetterSpacing: true, cursorStops: 1 }
          }
        });
        if (marks.selected?.some(pair => pair.sectionId === p.section.id && pair.occurrenceId === o.id)) add(p, o.range, 'macro-selected');
        if (p.section.binderOccurrences.includes(o.id)) add(p, o.range, 'macro-binder');
        if ((marks.related || []).some(x => x.sectionId === p.section.id && x.occurrenceId === o.id)) {
          add(p, o.range, p.section.binderOccurrences.includes(o.id) || p.section.edges.some(e => e.binder === o.id)
            ? 'macro-word-highlight-strong' : 'macro-word-highlight');
        }
        for (const [key, cls] of [['boxes', 'macro-hover']]) {
          if ((marks[key] || []).some(x => x.sectionId === p.section.id && x.occurrenceId === o.id)) add(p, o.range, cls);
        }
      }
    }
    return result;
  }
  function focusViewport(editor, model, part) {
    if (!part?.section.focus.length) return null;
    const position = model.getPositionAt(part.offset(part.section.focus[0][0]));
    const left = editor.getScrollLeft(), layout = editor.getLayoutInfo();
    const point = editor.getScrolledVisiblePosition(position);
    // Content pixel coordinates, with an exclusive right edge. Measuring the
    // start alone avoids revealing the end of a long focused form.
    return { focusStart: { ...position, left: point ? left + point.left - layout.contentLeft : null },
      horizontalRange: { start: left, end: left + layout.contentWidth } };
  }
  function revealFocus(editor, model, part, scrollType) {
    if (!part?.section.focus.length) return;
    const position = model.getPositionAt(part.offset(part.section.focus[0][0]));
    const left = editor.getScrollLeft();
    if (!editor.getVisibleRanges().some(r => r.startLineNumber <= position.lineNumber && position.lineNumber <= r.endLineNumber)) {
      editor.revealLineInCenter(position.lineNumber, scrollType);
      editor.setScrollLeft(left);
    }
    const before = focusViewport(editor, model, part);
    const start = before.focusStart.left, visible = before.horizontalRange;
    if (start !== null && start < visible.start) editor.setScrollLeft(Math.floor(start), scrollType);
    else if (start !== null && start >= visible.end) {
      // Scroll by whole pixels, leaving just the first pixel of the focus in
      // view. The focus end and the horizontal centre do not affect this.
      editor.setScrollLeft(Math.floor(start - (visible.end - visible.start)) + 1, scrollType);
    }
    return { before, after: focusViewport(editor, model, part) };
  }
  const api = { propertiesLayout, color, theme, tokenType, tokenLines, scopeTokens, scopeVariable, provider, compose, editText, lineNumbers, range, decorations, focusViewport, revealFocus };
  if (typeof module === 'object') module.exports = api; else root.MacroEditor = api;
})(globalThis);
