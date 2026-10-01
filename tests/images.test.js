'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { DapClient } = require('./dap-client');
const execute = promisify(execFile);
const root = path.resolve(__dirname, '..');

async function ok(request) {
  const response = await request;
  assert.equal(response.success, true, response.message);
  return response.body;
}
async function session(t, source) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-images-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'images.rkt');
  await fs.writeFile(program, source);
  const client = new DapClient(undefined, { timeout: 60000 });
  t.after(() => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, cwd: directory, interactive: true }));
  await ok(client.request('configurationDone'));
  await client.event('racketdap/ready');
  return { client, directory, program };
}
async function evaluate(client, expression) {
  const value = await ok(client.request('evaluate', { expression, context: 'repl' }));
  await client.event('racketdap/ready');
  return value;
}
async function render(client, value) {
  const image = await ok(client.request('racketdap/renderImage', { variablesReference: value.variablesReference }));
  await client.event('racketdap/ready');
  assert.equal(image.mimeType, 'image/png');
  return Buffer.from(image.data, 'base64');
}

test('image, pict and plot results match public PNG conversion without reevaluation', { timeout: 180000 }, async t => {
  const source = await fs.readFile(path.join(root, 'examples/images.rkt'), 'utf8');
  const { client, directory, program } = await session(t, source + '\n(define evaluations 0)\n');
  const script = `(require racket/port)
    (parameterize ([current-output-port (open-output-nowhere)]) (dynamic-require '(file ${JSON.stringify(program)}) #f))
    (define ns (module->namespace '(file ${JSON.stringify(program)})))
    (parameterize ([current-namespace ns])
      (define convert (dynamic-require 'file/convertible 'convert))
      (for ([name '(tile drawing chart)])
        (call-with-output-file (build-path ${JSON.stringify(directory)} (format "~a.png" name))
          (lambda (out) (write-bytes (convert (eval name) 'png-bytes) out)))))`;
  await execute('racket', ['-e', script], { timeout: 60000 });
  for (const [name, width, height] of [['tile', 64, 32], ['drawing', 48, 32], ['chart', 240, 160]]) {
    const value = await evaluate(client, `(begin (set! evaluations (add1 evaluations)) ${name})`);
    assert.equal(value.racketdapImage, true);
    const png = await render(client, value);
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    assert.deepEqual(png, await fs.readFile(path.join(directory, `${name}.png`)));
    assert.deepEqual(await render(client, value), png);
  }
  const multiple = await evaluate(client, '(begin (set! evaluations (add1 evaluations)) (values tile 42 drawing chart))');
  assert.equal(multiple.type, 'values');
  assert.deepEqual(multiple.racketdapImages.map(value => value.name), ['value 1', 'value 3', 'value 4']);
  for (const [index, name] of ['tile', 'drawing', 'chart'].entries()) {
    assert.deepEqual(await render(client, multiple.racketdapImages[index]), await fs.readFile(path.join(directory, `${name}.png`)));
  }
  const all = await ok(client.request('variables', { variablesReference: multiple.variablesReference }));
  await client.event('racketdap/ready');
  assert.equal(all.variables[1].value, '42', 'ordinary multiple-value inspection is preserved');
  assert.equal((await evaluate(client, 'evaluations')).result, '4');
  const stale = await client.request('racketdap/renderImage', { variablesReference: multiple.racketdapImages[0].variablesReference });
  assert.equal(stale.success, false);
  assert.match(stale.message, /Expired/);
});

test('image references expire on the next interaction and ordinary values have no image capability', async t => {
  const { client } = await session(t, '#lang racket/base\n(require pict)\n(define picture (disk 8))\n');
  const value = await evaluate(client, 'picture');
  assert.equal(value.racketdapImage, true);
  const ordinary = await evaluate(client, '42');
  assert.equal(ordinary.racketdapImage, undefined);
  assert.equal(ordinary.__vscodeVariableMenuContext, undefined);
  const stale = await client.request('racketdap/renderImage', { variablesReference: value.variablesReference });
  assert.equal(stale.success, false);
  assert.match(stale.message, /Expired/);
});

test('converter code runs only on explicit rendering and conversion errors leave the REPL usable', async t => {
  const { client } = await session(t, `#lang racket/base
    (require file/convertible)
    (define conversions 0)
    (struct picture () #:property prop:convertible
      (lambda (_value _format _default) (set! conversions (add1 conversions)) (error "conversion failed")))
    (define image (picture))`);
  const multiple = await evaluate(client, '(values image "caption" image)');
  assert.deepEqual(multiple.racketdapImages.map(value => value.name), ['value 1', 'value 3']);
  assert.equal((await evaluate(client, 'conversions')).result, '0', 'enumerating image choices does not invoke converters');
  const value = await evaluate(client, '(vector image image)');
  const { variables } = await ok(client.request('variables', { variablesReference: value.variablesReference }));
  await client.event('racketdap/ready');
  assert.equal(variables[0].racketdapImage, true);
  assert.equal(variables[0].__vscodeVariableMenuContext, 'racketdap.image');
  const result = await client.request('racketdap/renderImage', { variablesReference: variables[0].variablesReference });
  assert.equal(result.success, false);
  assert.match(result.message, /conversion failed/);
  await client.event('racketdap/ready');
  assert.equal((await evaluate(client, 'conversions')).result, '1');
});

test('image conversion uses existing request cancellation and retains the live value', async t => {
  const { client } = await session(t, `#lang racket/base
    (require file/convertible)
    (struct picture () #:property prop:convertible
      (lambda (_value _format _default)
        (displayln "image-conversion-started") (flush-output) (sync never-evt)))
    (define image (picture))`);
  const value = await evaluate(client, 'image');
  const requestId = client.sequence + 1;
  const pending = client.request('racketdap/renderImage', { variablesReference: value.variablesReference });
  await client.event('output', event => event.body.output.includes('image-conversion-started'));
  await ok(client.request('cancel', { requestId }));
  const response = await pending;
  assert.equal(response.success, false);
  assert.match(response.message, /cancelled/i);
  await client.event('racketdap/ready');
  assert.ok(await ok(client.request('variables', { variablesReference: value.variablesReference })));
  await client.event('racketdap/ready');
  assert.equal((await evaluate(client, '(+ 20 22)')).result, '42');
});

test('non-PNG and oversized conversions fail without breaking the protocol', async t => {
  const { client } = await session(t, `#lang racket/base
    (require file/convertible)
    (struct picture (data) #:property prop:convertible (lambda (v _format _default) (picture-data v)))
    (define unsupported (picture #f))
    (define invalid (picture #"not a PNG"))
    (define oversized (picture (bytes-append #"\\211PNG\\r\\n\\032\\n" (make-bytes (* 8 1024 1024)))))`);
  for (const name of ['unsupported', 'invalid', 'oversized']) {
    const value = await evaluate(client, name);
    const response = await client.request('racketdap/renderImage', { variablesReference: value.variablesReference });
    assert.equal(response.success, false);
    assert.match(response.message, /PNG/);
    await client.event('racketdap/ready');
  }
  assert.equal((await evaluate(client, '(+ 1 2)')).result, '3');
});

test('image choices include values beyond the text preview and exclude empty or ordinary results', async t => {
  const { client } = await session(t, '#lang racket/base\n(require pict)\n(define picture (disk 8))\n');
  for (const expression of ['(values)', '(values 1 2)', '42']) {
    const result = await evaluate(client, expression);
    assert.equal(result.racketdapImage, undefined);
    assert.equal((result.racketdapImages || []).length, 0);
  }
  const result = await evaluate(client, '(apply values (append (for/list ([i (in-range 200)]) 0) (list picture)))');
  assert.deepEqual(result.racketdapImages.map(value => value.name), ['value 201']);
  assert.equal((await render(client, result.racketdapImages[0])).readUInt32BE(16), 8);
  const many = await evaluate(client, '(apply values (for/list ([i (in-range 2000)]) picture))');
  assert.equal(many.racketdapImages.length, 200, 'large results have bounded picker metadata');
  assert.equal(many.racketdapImages.at(-1).name, 'value 200');
  assert.equal((await render(client, many.racketdapImages.at(-1))).readUInt32BE(16), 8);
});

test('a paused frame can render a retained image and resuming expires its reference', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'racket-paused-image-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const program = path.join(directory, 'image.rkt');
  await fs.writeFile(program, '#lang racket/base\n(require pict)\n(define picture (disk 8))\n(void)\n');
  const client = new DapClient();
  t.after(() => client.close());
  await ok(client.request('initialize', { adapterID: 'racketdap' }));
  await ok(client.request('launch', { program, cwd: directory, interactive: true }));
  await ok(client.request('setBreakpoints', { source: { path: program }, breakpoints: [{ line: 4 }] }));
  await ok(client.request('configurationDone'));
  const stopped = await client.event('stopped');
  const { stackFrames } = await ok(client.request('stackTrace', { threadId: stopped.body.threadId }));
  const value = await ok(client.request('evaluate', { frameId: stackFrames[0].id, expression: 'picture', context: 'repl' }));
  assert.equal(value.racketdapImage, true);
  const response = await ok(client.request('racketdap/renderImage', { variablesReference: value.variablesReference }));
  assert.equal(Buffer.from(response.data, 'base64').readUInt32BE(16), 8);
  await ok(client.request('continue', { threadId: stopped.body.threadId }));
  await client.event('racketdap/ready');
  const stale = await client.request('racketdap/renderImage', { variablesReference: value.variablesReference });
  assert.equal(stale.success, false);
  assert.match(stale.message, /Expired/);
});
