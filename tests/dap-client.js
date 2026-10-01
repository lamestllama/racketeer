'use strict';
const { spawn } = require('node:child_process');
const path = require('node:path');

class DapClient {
  constructor(adapter = path.resolve(__dirname, '../racketdap/main.rkt'), options = {}) {
    this.child = (options.spawn || spawn)('racket', [adapter], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.timeout = options.timeout ?? 15000;
    this.closeTimeout = options.closeTimeout ?? 3000;
    this.sequence = 0;
    this.lastReceived = 0;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.events = [];
    this.waiters = [];
    this.stderr = '';
    this.fatalError = null;
    this.closing = false;
    this.closed = new Promise(resolve => { this.resolveClosed = resolve; });
    this.child.stderr.on('data', data => { this.stderr += data; });
    this.child.stderr.on('error', error => this.fail(error));
    this.child.stdin.on('error', error => this.fail(error));
    this.child.stdout.on('error', error => this.fail(error));
    this.child.stdout.on('data', data => {
      if (this.fatalError) return;
      try {
        this.buffer = Buffer.concat([this.buffer, data]);
        for (;;) {
          const end = this.buffer.indexOf('\r\n\r\n');
          if (end < 0) break;
          const header = this.buffer.subarray(0, end).toString();
          const match = /^Content-Length: (\d+)$/i.exec(header);
          if (!match) throw new Error(`Invalid DAP header: ${header}`);
          const length = Number(match[1]);
          if (!Number.isSafeInteger(length) || length > 16 * 1024 * 1024) throw new Error('Invalid DAP content length');
          if (this.buffer.length < end + 4 + length) break;
          const message = JSON.parse(this.buffer.subarray(end + 4, end + 4 + length).toString());
          this.buffer = this.buffer.subarray(end + 4 + length);
          if (!Number.isSafeInteger(message.seq) || message.seq <= this.lastReceived) throw new Error('Non-monotonic DAP sequence');
          this.lastReceived = message.seq;
          if (message.type === 'response') {
            const pending = this.pending.get(message.request_seq);
            if (!pending) throw new Error('Response to an unknown request');
            this.pending.delete(message.request_seq);
            clearTimeout(pending.timer);
            pending.resolve(message);
          } else if (message.type === 'event' && typeof message.event === 'string') {
            const index = this.waiters.findIndex(w => w.name === message.event && w.predicate(message));
            if (index < 0) this.events.push(message);
            else {
              const [waiter] = this.waiters.splice(index, 1);
              clearTimeout(waiter.timer);
              waiter.resolve(message);
            }
          } else throw new Error('Invalid DAP message type');
        }
      } catch (error) { this.fail(error); }
    });
    this.child.on('error', error => this.fail(error));
    this.child.on('exit', (code, signal) => {
      if (!this.closing || code !== 0 || signal) {
        this.fail(new Error(`Adapter exited unexpectedly (${signal || code}): ${this.stderr}`));
      }
    });
    this.child.on('close', () => {
      if (this.buffer.length) this.fail(new Error('Truncated DAP message at adapter shutdown'));
      if (this.pending.size || this.waiters.length) this.fail(new Error('Adapter closed with outstanding requests or events'));
      this.resolveClosed();
    });
  }
  fail(error) {
    this.fatalError ||= error;
    for (const pending of [...this.pending.values(), ...this.waiters]) {
      clearTimeout(pending.timer); pending.reject(this.fatalError);
    }
    this.pending.clear(); this.waiters = [];
  }
  request(command, args = {}, split = false) {
    if (this.fatalError || this.closing) return Promise.reject(this.fatalError || new Error('DAP client is closing'));
    const seq = ++this.sequence;
    const body = Buffer.from(JSON.stringify({ seq, type: 'request', command, arguments: args }));
    const data = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body]);
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new Error(`Timeout waiting for ${command}: ${this.stderr}`)), this.timeout);
      this.pending.set(seq, { resolve, reject, timer });
    });
    try {
      if (split) {
        for (let i = 0; i < data.length; i += 3) this.child.stdin.write(data.subarray(i, i + 3));
      } else this.child.stdin.write(data);
    } catch (error) { this.fail(error); }
    return result;
  }
  event(name, predicate = () => true) {
    if (this.fatalError || this.closing) return Promise.reject(this.fatalError || new Error('DAP client is closing'));
    const index = this.events.findIndex(e => e.event === name && predicate(e));
    if (index >= 0) return Promise.resolve(this.events.splice(index, 1)[0]);
    return new Promise((resolve, reject) => {
      const waiter = { name, predicate, resolve, reject };
      waiter.timer = setTimeout(() => this.fail(new Error(
        `Timeout waiting for ${name}: ${this.stderr}. Events: ${JSON.stringify(this.events.slice(-20))}`)), this.timeout);
      this.waiters.push(waiter);
    });
  }
  close() {
    this.closePromise ||= this.shutdown();
    return this.closePromise;
  }
  async shutdown() {
    this.closing = true;
    this.child.stdin.end();
    let timer;
    const closed = await Promise.race([
      this.closed.then(() => true),
      new Promise(resolve => { timer = setTimeout(() => resolve(false), this.closeTimeout); })
    ]);
    clearTimeout(timer);
    if (!closed) {
      this.fail(new Error('Adapter did not exit after stdin closed; forced SIGKILL cleanup'));
      this.child.kill('SIGKILL');
      await Promise.race([
        this.closed,
        new Promise(resolve => { timer = setTimeout(resolve, this.closeTimeout); })
      ]);
      clearTimeout(timer);
    }
    if (this.fatalError) throw this.fatalError;
  }
}
module.exports = { DapClient };
