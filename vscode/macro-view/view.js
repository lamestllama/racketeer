// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Creates the macro page components and starts its message protocol.
/* global MacroView */
(function () {
  'use strict';
  const runtime = {};
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createState(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createPage(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createOverlay(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createSentence(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createDetails(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createDecorations(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createInput(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createEditor(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createLayout(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createTestHooks(runtime)));
  Object.defineProperties(runtime, Object.getOwnPropertyDescriptors(MacroView.createMessages(runtime)));
})();
