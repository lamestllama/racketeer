// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// Creates the page state shared by the view components.
/* global MacroView, MacroModel, MacroGeometry, MacroProtocol, MacroEditor, MacroMonaco, acquireVsCodeApi */
globalThis.MacroView = {};
MacroView.createState = function (runtime) {
  'use strict';
  const vscode = acquireVsCodeApi(), M = MacroModel, G = MacroGeometry, P = MacroProtocol, E = MacroEditor, monaco = MacroMonaco;
  const app = document.getElementById('app'), live = document.getElementById('live');
  const dynamic = document.getElementById('geometry').sheet;
  const saved = vscode.getState() || {};
  const clientInstanceId = `client${Date.now()}`;
  let navigationSequence = 0;
  let drawn = [];
  let boxes = [], tokenSections = {}, tokenStyles = [], themeName = '';
  let editor, editorModel, tokenProvider, editorSettings = {};
  let decorationIds = [], focusReveal = null, positionEdit = null, modelEdits = [], modelChanges = [], lineSnapshot = [];
  let themeSignature = '';
  let env, projection, selected = { selected: null, related: [], syntaxId: null, properties: null }, state = {}, serial = 0;
  let hover = null, focused = null, frame = 0, testEnabled = false, loading = false, restoring = true, renderingPosition = false;
  let sections = [];
  let inspectionTimer = null, inspectionTarget = null;
  const bindingFacts = new Map(), pendingInspections = new Set();
  const pendingDrives = new Set();
  let expanded = Array.isArray(saved.expanded) ? new Set(saved.expanded) : null;
  const partsBySection = new Map(), geometryRules = new Map();
  return {
    monaco,
    geometryRules,
    dynamic,
    get env() { return env; },
    set env(value) { env = value; },
    vscode,
    get serial() { return serial; },
    set serial(value) { serial = value; },
    clientInstanceId,
    get navigationSequence() { return navigationSequence; },
    set navigationSequence(value) { navigationSequence = value; },
    live,
    get state() { return state; },
    set state(value) { state = value; },
    app,
    get projection() { return projection; },
    set projection(value) { projection = value; },
    saved,
    get editor() { return editor; },
    set editor(value) { editor = value; },
    get expanded() { return expanded; },
    set expanded(value) { expanded = value; },
    E,
    M,
    get tokenStyles() { return tokenStyles; },
    set tokenStyles(value) { tokenStyles = value; },
    get editorModel() { return editorModel; },
    set editorModel(value) { editorModel = value; },
    partsBySection,
    get tokenSections() { return tokenSections; },
    set tokenSections(value) { tokenSections = value; },
    get tokenProvider() { return tokenProvider; },
    set tokenProvider(value) { tokenProvider = value; },
    get themeName() { return themeName; },
    set themeName(value) { themeName = value; },
    get editorSettings() { return editorSettings; },
    set editorSettings(value) { editorSettings = value; },
    get themeSignature() { return themeSignature; },
    set themeSignature(value) { themeSignature = value; },
    P,
    get hover() { return hover; },
    set hover(value) { hover = value; },
    get renderingPosition() { return renderingPosition; },
    set renderingPosition(value) { renderingPosition = value; },
    get testEnabled() { return testEnabled; },
    set testEnabled(value) { testEnabled = value; },
    get lineSnapshot() { return lineSnapshot; },
    set lineSnapshot(value) { lineSnapshot = value; },
    get modelEdits() { return modelEdits; },
    set modelEdits(value) { modelEdits = value; },
    get modelChanges() { return modelChanges; },
    set modelChanges(value) { modelChanges = value; },
    get selected() { return selected; },
    set selected(value) { selected = value; },
    get focused() { return focused; },
    set focused(value) { focused = value; },
    get sections() { return sections; },
    set sections(value) { sections = value; },
    get positionEdit() { return positionEdit; },
    set positionEdit(value) { positionEdit = value; },
    get restoring() { return restoring; },
    set restoring(value) { restoring = value; },
    get focusReveal() { return focusReveal; },
    set focusReveal(value) { focusReveal = value; },
    get decorationIds() { return decorationIds; },
    set decorationIds(value) { decorationIds = value; },
    G,
    get frame() { return frame; },
    set frame(value) { frame = value; },
    get drawn() { return drawn; },
    set drawn(value) { drawn = value; },
    get boxes() { return boxes; },
    set boxes(value) { boxes = value; },
    get inspectionTimer() { return inspectionTimer; },
    set inspectionTimer(value) { inspectionTimer = value; },
    get inspectionTarget() { return inspectionTarget; },
    set inspectionTarget(value) { inspectionTarget = value; },
    bindingFacts,
    pendingInspections,
    pendingDrives,
    get loading() { return loading; },
    set loading(value) { loading = value; }
  };
};
