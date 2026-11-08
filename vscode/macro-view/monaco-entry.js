// Copyright (c) 2026 Eric Parsonage
// SPDX-License-Identifier: Apache-2.0 OR MIT
// The editor API plus the contributions used by a read-only text preview.
export * from '../node_modules/monaco-editor/esm/vs/editor/editor.api.js';
export { KeybindingsRegistry } from '../node_modules/monaco-editor/esm/vs/platform/keybinding/common/keybindingsRegistry.js';
export { isMacintosh } from '../node_modules/monaco-editor/esm/vs/base/common/platform.js';
import '../node_modules/monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js';
import '../node_modules/monaco-editor/esm/vs/editor/browser/coreCommands.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/find/browser/findController.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations.js';
import '../node_modules/monaco-editor/esm/vs/editor/contrib/tokenization/browser/tokenization.js';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css';
import '../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css';
import { Registry } from '../node_modules/monaco-editor/esm/vs/platform/registry/common/platform.js';
import { Extensions } from '../node_modules/monaco-editor/esm/vs/platform/theme/common/colorUtils.js';
export const colorIds = Registry.as(Extensions.ColorContribution).getColors().map(c => c.id);
// This view has no language services or workers. Any core editor computation
// uses the same synchronous implementation as Monaco's built-in fallback.
import { EditorWorker } from '../node_modules/monaco-editor/esm/vs/editor/common/services/editorWebWorker.js';
export const services = { IWebWorkerService: { createWorkerClient() {
  const proxy = new EditorWorker(null);
  return { proxy, setChannel() {}, dispose() { proxy.dispose(); } };
} } };

import { StandaloneServices } from '../node_modules/monaco-editor/esm/vs/editor/standalone/browser/standaloneServices.js';
StandaloneServices.initialize(services);

// Complete the supplied line tokens before rendering the transaction. Keep
// this adapter beside the pinned editor imports: tokenization is model internals.
export function tokenizeModel(model) {
  model.tokenization.forceTokenization(model.getLineCount());
}
