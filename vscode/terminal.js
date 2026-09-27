'use strict';
const vscode = require('vscode');

// A line-oriented terminal for target stdin/stdout, with no shell process.
// Debug Console expressions continue to use DAP evaluate independently.
function createProgramTerminal(session) {
  const write = new vscode.EventEmitter();
  let opened = false;
  let ended = false;
  let line = '';
  let pending = '';
  function output(text) {
    const normalized = text.replace(/\r?\n/g, '\r\n');
    if (opened) write.fire(normalized); else pending += normalized;
  }
  async function request(command, args = {}) {
    if (ended) return;
    try { await session.customRequest(command, args); }
    catch (error) { if (!ended) output(`\n${error.message}\n`); }
  }
  const pty = {
    onDidWrite: write.event,
    open() { opened = true; write.fire(pending); pending = ''; },
    close() { void request('racketdap/input', { eof: true }); write.dispose(); },
    handleInput(data) {
      if (ended) return;
      // Arrow/function keys are not program text. This is line input, not a TTY.
      const text = data.replace(/\x1b\[[0-9;]*[A-Za-z~]/g, '').replace(/\r\n/g, '\r');
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          output('\n'); void request('racketdap/input', { text: `${line}\n` }); line = '';
        } else if (char === '\x7f' || char === '\b') {
          const characters = Array.from(line);
          if (characters.length) { characters.pop(); line = characters.join(''); output('\b \b'); }
        } else if (char === '\x04') {
          void request('racketdap/input', line ? { text: line } : { eof: true }); line = '';
        } else if (char === '\x03') {
          line = ''; output('^C\n'); void request('racketdap/interrupt');
        } else if (char === '\t' || char >= ' ') {
          line += char; output(char);
        }
      }
    }
  };
  const terminal = vscode.window.createTerminal({ name: `Racket: ${session.name}`, pty });
  terminal.show(true);
  return {
    output,
    end() { ended = true; output('\n[Debug session ended]\n'); },
    dispose() { ended = true; terminal.dispose(); write.dispose(); }
  };
}
module.exports = { createProgramTerminal };
