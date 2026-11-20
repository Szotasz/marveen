// Plain JavaScript keeps eval workers independent of the TS loader and dist paths.
export const BROKER_SOURCE = String.raw`
const { spawn } = require('node:child_process');
// Use descriptor I/O so protocol streams do not depend on Node's stdio wrappers.
const { writeSync, createReadStream } = require('node:fs');
const send = value => {
  const data = Buffer.from(JSON.stringify(value) + '\n');
  for (let offset = 0; offset < data.length;) offset += writeSync(1, data, offset);
};
const errors = error => error && Object.fromEntries(
  ['code', 'errno', 'syscall', 'path', 'spawnargs', 'message'].map(key => [key, error[key]])
);
const execute = r => {
  let child, timer, error = null, timedOut = false, maxBufferExceeded = false;
  const chunks = { stdout: [], stderr: [] }, sizes = { stdout: 0, stderr: 0 };
  const limit = r.maxBuffer ?? 1024 * 1024;
  const kill = () => child.kill(r.killSignal || 'SIGTERM');
  const collect = (name, chunk) => {
    if (maxBufferExceeded) return;
    const length = r.sync ? chunk.length : Buffer.byteLength(chunk, 'utf8');
    sizes[name] += length;
    // spawnSync limits the combined buffers; execFile limits each stream.
    const size = r.sync ? sizes.stdout + sizes.stderr : sizes[name];
    if (size > limit) {
      maxBufferExceeded = name;
      chunks[name].push(r.sync ? chunk : chunk.slice(0, Math.max(0, limit - (sizes[name] - length))));
      kill();
    } else chunks[name].push(chunk);
  };
  try {
    child = spawn(r.file, r.args, { cwd: r.cwd, env: r.env,
      stdio: ['ignore', r.stdout, 'pipe'] });
    if (!r.sync) {
      child.stdout?.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
    }
    child.stdout?.on('data', chunk => collect('stdout', chunk));
    child.stderr.on('data', chunk => collect('stderr', chunk));
    child.on('error', err => { error = errors(err); });
    if (r.timeout > 0) timer = setTimeout(() => { timedOut = true; kill(); }, r.timeout);
    child.on('close', (status, signal) => {
      clearTimeout(timer);
      send({ id: r.id, pid: child.pid || 0, status: status < 0 ? null : status, signal,
        stdout: r.stdout === 'ignore' ? null : (r.sync ? Buffer.concat(chunks.stdout) : Buffer.from(chunks.stdout.join(''), 'utf8')).toString('base64'),
        stderr: (r.sync ? Buffer.concat(chunks.stderr) : Buffer.from(chunks.stderr.join(''), 'utf8')).toString('base64'), error, timedOut, maxBufferExceeded });
    });
  } catch (err) {
    send({ id: r.id, pid: 0, status: null, signal: null, stdout: r.stdout === 'ignore' ? null : '',
      stderr: '', error: errors(err), timedOut, maxBufferExceeded });
  }
};
// Treat only stdin EOF as parent death; NDJSON does not need readline's lifecycle.
let input = '';
const inputStream = createReadStream(null, { fd: 0, autoClose: false });
inputStream.setEncoding('utf8');
inputStream.on('data', data => {
  input += data;
  let end;
  while ((end = input.indexOf('\n')) !== -1) {
    const line = input.slice(0, end);
    input = input.slice(end + 1);
    execute(JSON.parse(line));
  }
});
inputStream.on('end', () => process.exit(0));
send({ ready: true, pid: process.pid });
`;

export const WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { spawn } = require('node:child_process');
const { createInterface } = require('node:readline');
const { syncPort, asyncPort, shared, source, execPath, execArgv } = workerData;
const state = new Int32Array(shared), pending = new Map();
let broker, stopping = false, restartTimer, stableTimer, backoff = 1000;
const reply = (entry, value) => {
  clearTimeout(entry.timer);
  pending.delete(value.id);
  entry.port.postMessage(value);
  if (entry.port === syncPort) { Atomics.add(state, 0, 1); Atomics.notify(state, 0); }
};
const killGroup = child => {
  if (child?.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
};
const lose = marker => {
  Atomics.store(state, 1, 0);
  for (const [id, entry] of pending) reply(entry, { id, marker });
};
const start = () => {
  parentPort.postMessage({ type: 'starting', restart: broker !== undefined });
  const child = broker = spawn(execPath, [...execArgv, '-e', source], {
    stdio: ['pipe', 'pipe', 'pipe'], detached: true
  });
  child.unref();
  // Bound stderr lines even when a preload emits an unterminated stream.
  let stderr = '';
  child.stderr.on('data', data => {
    stderr += data.toString();
    let end;
    while ((end = stderr.indexOf('\n')) !== -1) {
      parentPort.postMessage({ type: 'stderr', line: stderr.slice(0, end).slice(0, 2048) });
      stderr = stderr.slice(end + 1);
    }
    if (stderr.length > 2048) {
      parentPort.postMessage({ type: 'stderr', line: stderr.slice(0, 2048) });
      stderr = '';
    }
  });
  child.stdin.on('error', () => {}); // An exit below settles all in-flight writes.
  createInterface({ input: child.stdout }).on('line', line => {
    let value;
    try { value = JSON.parse(line); } catch { killGroup(child); return; }
    if (child !== broker || stopping) return;
    if (value.ready) {
      Atomics.store(state, 1, value.pid);
      parentPort.postMessage({ type: 'up', pid: value.pid });
      stableTimer = setTimeout(() => { backoff = 1000; }, 60000);
    } else {
      const entry = pending.get(value.id);
      if (entry) reply(entry, value);
    }
  });
  let ended = false;
  const died = detail => {
    if (ended) return;
    ended = true;
    clearTimeout(stableTimer);
    if (stderr) parentPort.postMessage({ type: 'stderr', line: stderr.slice(0, 2048) });
    killGroup(child); // Do not leave children behind after a broker crash.
    lose('BROKER_LOST');
    if (stopping) { parentPort.postMessage({ type: 'stopped' }); return; }
    parentPort.postMessage({ type: 'down', detail, restartMs: backoff });
    restartTimer = setTimeout(start, backoff);
    backoff = Math.min(backoff * 2, 30000);
  };
  child.on('error', err => died(err.message));
  child.on('exit', (code, signal) => died({ code, signal }));
};
const dispatch = (port, r) => {
  if (!Atomics.load(state, 1)) { reply({ port }, { id: r.id, marker: 'BROKER_DOWN' }); return; }
  const entry = { port, timer: setTimeout(() => {
    lose('BROKER_TIMEOUT');
    killGroup(broker);
  }, r.timeout + 1000) };
  pending.set(r.id, entry);
  broker.stdin.write(JSON.stringify(r) + '\n');
};
syncPort.on('message', r => dispatch(syncPort, r));
asyncPort.on('message', r => dispatch(asyncPort, r));
parentPort.on('message', message => {
  if (message.type === 'expire') {
    // The PID prevents a late main-thread timer from killing a replacement broker.
    if (broker?.pid === message.pid) { lose('BROKER_TIMEOUT'); killGroup(broker); }
  } else if (message.type === 'stop') {
    stopping = true;
    clearTimeout(restartTimer); clearTimeout(stableTimer);
    lose('BROKER_LOST');
    if (broker?.exitCode === null && broker?.signalCode === null) killGroup(broker);
    else parentPort.postMessage({ type: 'stopped' });
  }
});
start();
`;
