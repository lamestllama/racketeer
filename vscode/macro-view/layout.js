// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Responds to layout, font and theme changes.
/* global MacroView */
MacroView.createLayout = function (runtime) {
  'use strict';
  const layoutObserver = new ResizeObserver(() => runtime.layoutProperties());
  layoutObserver.observe(runtime.work);
  layoutObserver.observe(runtime.syntax);
  document.fonts?.ready.then(() => { runtime.updateDecorations(); runtime.schedule(); });
  window.addEventListener('resize', () => { runtime.layoutProperties(); runtime.updateDecorations(); });
  window.addEventListener('scroll', runtime.persist, { passive: true });
  const themeObserver = new MutationObserver(() => { runtime.rebuildTheme(); runtime.configureEditor(); });
  for (const target of [document.documentElement, document.body]) {
    themeObserver.observe(target, { attributes: true, attributeFilter: ['class', 'style', 'data-vscode-theme-id', 'data-vscode-theme-kind'] });
  }
  return {};
};
