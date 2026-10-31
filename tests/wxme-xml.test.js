'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { spawnSync } = require('node:child_process');
const { decodeWxme, requestWxme } = require('../vscode/wxme-process');
const { renderWxme } = require('../vscode/wxme-render');
const { DapClient } = require('./dap-client');
const expected = require('./fixtures/wxme-xml/expected.json');
const fixture = name => path.join(__dirname, 'fixtures/wxme-xml', name + '.wxme');
const viewer = path.resolve(__dirname, '../racketdap/tools/wxme-view.rkt');
const editor = path.resolve(__dirname, '../racketdap/tools/wxme-edit.rkt');
const decode = name => decodeWxme('racket', viewer, fixture(name));

test('XML viewing retains nested Racket expressions, splicing and both whitespace modes', async () => {
  for (const name of ['preserve', 'eliminate']) {
    const bytes = fs.readFileSync(fixture(name)), result = await decode(name), box = result.parts[1];
    assert.equal(box.kind, 'xml'); assert.equal(box.eliminateWhitespace, name === 'eliminate');
    assert.equal(box.parts[0].text, '<root title="λ😀">\n  <first>');
    assert.equal(box.parts[1].kind, 'racket'); assert.equal(box.parts[1].splicing, false);
    assert.equal(box.parts[1].parts[0].text, '(number->string (+ base 2))');
    assert.equal(box.parts[3].kind, 'racket'); assert.equal(box.parts[3].splicing, true);
    assert.equal(box.parts[3].parts[0].text, '(list \'(item () "α") \'(item () "😀"))');
    const html = renderWxme(result, name);
    assert.match(html, /aria-label="Racket box"/); assert.match(html, /aria-label="Racket splice box"/);
    assert.ok(html.includes(name === 'eliminate' ? 'eliminate empty-tag whitespace' : 'preserve whitespace'));
    assert.deepEqual(fs.readFileSync(fixture(name)), bytes);
  }
});

test('empty and mixed XML boxes render without evaluating their contents', async () => {
  const boxes = (await decode('boxes')).parts;
  assert.deepEqual(boxes.map(b => [b.kind, b.eliminateWhitespace ?? b.splicing]),
    [['xml', false], ['xml', true], ['racket', false], ['racket', true]]);
  assert.ok(boxes.every(b => b.parts.length === 0));
  const result = await decode('mixed');
  assert.equal(result.parts[0].parts[1].kind, 'comment');
  const html = renderWxme(result, 'mixed');
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;&amp;/);
  assert.doesNotMatch(html, /<script/); assert.match(html, /not-evaluated/);
  assert.throws(() => renderWxme({ parts: [{ kind: 'xml', parts: [] }] }, 'bad'), /Invalid.*mode/);
});

test('XML editing without a display preserves every source byte', async () => {
  const previous = process.env.DISPLAY; process.env.DISPLAY = ':9876';
  try {
    for (const name of ['preserve', 'eliminate', 'boxes', 'mixed']) {
      const bytes = fs.readFileSync(fixture(name));
      await assert.rejects(requestWxme('racket', editor, fixture(name), { version: 1, bytes: bytes.toString('base64') }), /Editing requires Racket GUI libraries and a working display/);
      assert.deepEqual(fs.readFileSync(fixture(name)), bytes);
    }
  } finally { if (previous === undefined) delete process.env.DISPLAY; else process.env.DISPLAY = previous; }
});

test('nested XML streams cannot load a document-supplied reader', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wxme-reader-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const collection = path.join(directory, 'racketeer-fixture'); fs.mkdirSync(collection);
  const marker = path.join(directory, 'loaded');
  fs.writeFileSync(path.join(collection, 'reader.rkt'), `#lang racket/base\n(call-with-output-file ${JSON.stringify(marker)} (lambda (out) (display "loaded" out)))\n(error "READER LOADED")\n`);
  const previous = process.env.PLTCOLLECTS; process.env.PLTCOLLECTS = directory + path.delimiter + (previous || '');
  try {
    const bytes = fs.readFileSync(fixture('nested-custom'));
    await assert.rejects(decode('nested-custom'), /Unsupported WXME object reader/);
    await assert.rejects(requestWxme('racket', editor, fixture('nested-custom'), { version: 1, bytes: bytes.toString('base64') }), /Unsupported WXME object reader/);
    assert.equal(fs.existsSync(marker), false); assert.deepEqual(fs.readFileSync(fixture('nested-custom')), bytes);
  } finally { if (previous === undefined) delete process.env.PLTCOLLECTS; else process.env.PLTCOLLECTS = previous; }
});

test('source projections replace an outer XML box with one position', () => {
  const module = path.resolve(__dirname, '../racketdap/wxme-source.rkt');
  for (const name of ['preserve', 'eliminate']) {
    const result = spawnSync('racket', ['-e', `(require racket/file (file ${JSON.stringify(module)})) (display (source-text (file->bytes ${JSON.stringify(fixture(name))})))`], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 0, result.stderr); assert.equal(result.stdout, expected.projection);
  }
});

for (const name of ['preserve', 'eliminate']) test(`XML ${name} execution and outer-source breakpoints retain their semantics`, async t => {
  const bytes = fs.readFileSync(fixture(name)), client = new DapClient(); t.after(() => client.close());
  const ok = async promise => { const response = await promise; assert.equal(response.success, true, response.message); return response.body; };
  await ok(client.request('initialize', { adapterID: 'racketdap', linesStartAt1: true, columnsStartAt1: true }));
  await ok(client.request('launch', { program: fixture(name), cwd: path.dirname(fixture(name)) })); await client.event('initialized');
  await ok(client.request('setBreakpoints', { source: { path: fixture(name) }, breakpoints: [{ line: 4, column: 1 }] }));
  await ok(client.request('configurationDone')); const stop = await client.event('stopped');
  assert.equal(stop.body.reason, 'breakpoint');
  const frame = (await ok(client.request('stackTrace', { threadId: stop.body.threadId }))).stackFrames[0];
  assert.equal(frame.line, 4); assert.equal(frame.column, 1);
  const source = await ok(client.request('source', { sourceReference: frame.source.sourceReference }));
  assert.equal(source.content, expected.projection);
  await ok(client.request('continue', { threadId: stop.body.threadId })); await client.event('terminated');
  assert.equal((await client.event('exited')).body.exitCode, 0);
  assert.equal(client.events.filter(e => e.event === 'output' && e.body.category === 'stdout').map(e => e.body.output).join(''), expected[name]);
  assert.deepEqual(fs.readFileSync(fixture(name)), bytes);
});
