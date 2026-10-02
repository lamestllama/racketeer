'use strict';
const vscode = require('vscode');
const { createHash } = require('node:crypto');

const details = new WeakMap();
async function sourceMatches(uri, sourceHash) {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    // Consult buffers after the asynchronous read, including newly opened ones.
    const document = vscode.workspace.textDocuments.find(doc => doc.uri.toString() === uri.toString());
    const text = document ? document.getText() : Buffer.from(bytes).toString('utf8');
    return createHash('sha1').update(text.replace(/\r\n/g, '\n')).digest('hex') === sourceHash;
  } catch { return false; }
}

class TestCoverage {
  constructor() { this.files = new Map(); }

  add(report) {
    let file = this.files.get(report.path);
    if (!file) {
      file = { sourceHash: report.sourceHash, statements: new Map() };
      this.files.set(report.path, file);
    }
    // Different test processes may have loaded different revisions. Such
    // results cannot be combined, even if the file is later changed back.
    if (file.sourceHash !== report.sourceHash) file.sourceHash = undefined;
    if (!file.sourceHash) return;
    for (const statement of report.statements) {
      const key = [statement.line, statement.column, statement.endLine, statement.endColumn].join(':');
      const previous = file.statements.get(key);
      file.statements.set(key, { ...statement, executed: statement.executed || !!previous?.executed });
    }
  }

  async publish(run, token) {
    for (const [path, file] of this.files) {
      if (token.isCancellationRequested) return;
      const uri = vscode.Uri.file(path);
      if (!file.sourceHash || !await sourceMatches(uri, file.sourceHash)) {
        run.appendOutput(`Coverage omitted for changed source: ${path}\r\n`);
        continue;
      }
      if (token.isCancellationRequested) return;
      const statements = [...file.statements.values()].map(statement => new vscode.StatementCoverage(
        statement.executed, new vscode.Range(statement.line, statement.column, statement.endLine, statement.endColumn)));
      if (!statements.length) continue;
      const coverage = new vscode.FileCoverage(uri, {
        covered: statements.filter(statement => statement.executed).length, total: statements.length
      });
      details.set(coverage, { sourceHash: file.sourceHash, statements });
      run.addCoverage(coverage);
    }
  }
}

async function loadDetailedCoverage(_run, coverage, token) {
  const file = details.get(coverage);
  return file && !token.isCancellationRequested && await sourceMatches(coverage.uri, file.sourceHash)
    && !token.isCancellationRequested ? file.statements : [];
}

module.exports = { TestCoverage, loadDetailedCoverage };
