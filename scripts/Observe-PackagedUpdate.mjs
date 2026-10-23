import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable CI runner only');
assert.equal(process.platform, 'win32', 'Native Windows runner required');
const [portText, root, version, output, mode = 'FileBridge', candidateInstaller, candidatePin] = process.argv.slice(2);
const port = Number(portText);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(path.isAbsolute(root) && path.isAbsolute(output));
assert.match(version, /^\d+\.\d+\.\d+$/);
assert.ok(['FileBridge', 'LegacyBridge'].includes(mode));
const storage = 'https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates';
const timeline = [];
const localFeedRequests = [];
const save = async (phase, detail = {}) => {
  timeline.push({ at: new Date().toISOString(), phase, ...detail });
  await fsp.writeFile(path.join(output, 'inspector-diagnostics.json'), JSON.stringify(timeline, null, 2));
};
let socket;
let feedServer;
const pending = new Map();
const scripts = new Map();
const pauses = [];
let waitingPause;
const nextPause = () => new Promise((resolve, reject) => {
  if (pauses.length) return resolve(pauses.shift());
  const timer = setTimeout(() => { waitingPause = undefined; reject(new Error('Packaged application entry breakpoint was not reached')); }, 20_000);
  waitingPause = value => { clearTimeout(timer); waitingPause = undefined; resolve(value); };
});
let serial = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Inspector command timed out: ' + method)); }, 10_000);
  pending.set(id, { resolve, reject, timeout });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) {
    const description = response.exceptionDetails.exception?.description?.split('\n')[0] || response.exceptionDetails.text || 'exception';
    throw new Error('Controlled inspector evaluation failed: ' + description.replace(/https?:\/\/\S+/g, 'remote-url').slice(0, 300));
  }
  return response.result?.value;
};
try {
  let localFeed;
  if (mode === 'LegacyBridge') {
    assert.ok(candidateInstaller && path.isAbsolute(candidateInstaller));
    assert.equal(path.dirname(candidateInstaller).toLowerCase(), output.toLowerCase(), 'Candidate must be a test-owned file');
    assert.match(candidatePin, /^[a-f0-9]{64}$/);
    const sha256 = createHash('sha256');
    const sha512 = createHash('sha512');
    for await (const bytes of fs.createReadStream(candidateInstaller)) { sha256.update(bytes); sha512.update(bytes); }
    assert.equal(sha256.digest('hex'), candidatePin, 'Candidate changed after signed archive verification');
    const size = (await fsp.stat(candidateInstaller)).size;
    const digest512 = sha512.digest('base64');
    const name = `Bweeep-Setup-${version}.exe`;
    const yaml = `version: ${JSON.stringify(version)}\nfiles:\n  - url: ${JSON.stringify(name)}\n    sha512: ${JSON.stringify(digest512)}\n    size: ${size}\npath: ${JSON.stringify(name)}\nsha512: ${JSON.stringify(digest512)}\nreleaseDate: "2026-10-23T00:00:00.000Z"\n`;
    feedServer = http.createServer((request, response) => {
      const pathname = new URL(request.url, 'http://127.0.0.1').pathname;
      localFeedRequests.push({ at: new Date().toISOString(), path: pathname, method: request.method, range: /^bytes=\d+-\d*$/.test(request.headers.range || '') ? request.headers.range : undefined });
      if (!['GET', 'HEAD'].includes(request.method)) { response.writeHead(405).end(); return; }
      if (pathname === '/latest.yml') {
        response.writeHead(200, { 'Content-Type': 'text/yaml', 'Content-Length': Buffer.byteLength(yaml), 'Cache-Control': 'no-store' });
        response.end(request.method === 'HEAD' ? undefined : yaml); return;
      }
      if (pathname !== '/' + name) { response.writeHead(404).end(); return; }
      let start = 0;
      let end = size - 1;
      if (request.headers.range) {
        const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range);
        if (!range) { response.writeHead(416).end(); return; }
        start = Number(range[1]); end = range[2] ? Number(range[2]) : end;
        if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end || end >= size) { response.writeHead(416).end(); return; }
        response.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
      }
      response.writeHead(request.headers.range ? 206 : 200, { 'Content-Type': 'application/octet-stream', 'Content-Length': end - start + 1, 'Accept-Ranges': 'bytes' });
      if (request.method === 'HEAD') { response.end(); return; }
      const input = fs.createReadStream(candidateInstaller, { start, end });
      input.on('error', () => response.destroy());
      response.on('close', () => input.destroy());
      input.pipe(response);
    });
    await new Promise((resolve, reject) => { feedServer.once('error', reject); feedServer.listen(0, '127.0.0.1', resolve); });
    localFeed = `http://127.0.0.1:${feedServer.address().port}/`;
    await save('verified-local-candidate-feed', { version, sha256: candidatePin, sha512: digest512, bytes: size, host: '127.0.0.1' });
  }
  let target;
  for (let index = 0; index < 200; index++) {
    try {
      const list = await (await fetch('http://127.0.0.1:' + port + '/json/list')).json();
      target = list.find(item => item.type === 'node' && item.webSocketDebuggerUrl);
      if (target) break;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(target, 'Packaged main inspector did not start');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
  socket.addEventListener('message', ({ data }) => {
    const message = JSON.parse(data);
    if (message.method === 'Debugger.scriptParsed') scripts.set(message.params.scriptId, message.params.url);
    if (message.method === 'Debugger.paused') {
      if (waitingPause) waitingPause(message.params);
      else pauses.push(message.params);
    }
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id); clearTimeout(request.timeout);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const request of pending.values()) { clearTimeout(request.timeout); request.reject(new Error('Packaged main inspector closed')); }
    pending.clear();
  });
  await call('Runtime.enable');
  await call('Debugger.enable');
  const unpacked = await fsp.stat(path.join(root, 'resources', 'app', 'package.json')).then(() => true, () => false);
  const appPath = path.join(root, 'resources', unpacked ? 'app' : 'app.asar');
  const packageFile = path.join(appPath, 'package.json');
  const entryUrl = pathToFileURL(path.join(appPath, 'dist', 'src', 'main', 'index.js')).href;
  const breakpoint = await call('Debugger.setBreakpointByUrl', { url: entryUrl, lineNumber: 0 });
  await call('Runtime.runIfWaitingForDebugger');
  let pause = await nextPause();
  const atEntry = value => value.hitBreakpoints?.includes(breakpoint.breakpointId) || value.callFrames?.some(frame => (frame.url || scripts.get(frame.location.scriptId))?.toLowerCase() === entryUrl.toLowerCase());
  if (!atEntry(pause)) {
    await save('electron-bootstrap-paused');
    await call('Debugger.resume');
    pause = await nextPause();
  }
  assert.ok(atEntry(pause), 'Unexpected breakpoint before packaged application entry');
  await call('Debugger.removeBreakpoint', { breakpointId: breakpoint.breakpointId });
  const setup = `(() => {
    const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(packageFile)});
    if (process.execPath.toLowerCase() !== ${JSON.stringify(path.join(root, 'Bweeep.exe').toLowerCase())}) throw new Error('Unexpected inspector executable');
    const { net, app } = require('electron');
    app.once('before-quit', () => require('node:inspector').close());
    const original = net.fetch.bind(net);
    const prefix = ${JSON.stringify(storage)};
    const target = ${JSON.stringify(version)};
    globalThis.__bweeepUpdateProbe = { requests: [], mappedChannelRequests: 0, mappedLegacyFeeds: 0, runtimeErrors: [] };
    process.on('unhandledRejection', error => globalThis.__bweeepUpdateProbe.runtimeErrors.push({ name: String(error?.name || 'Error').slice(0, 80), code: /^[A-Z0-9_]+$/.test(error?.code || '') ? error.code : undefined, frames: typeof error?.stack === 'string' ? error.stack.split('\\n').slice(1, 5) : [] }));
    if (${JSON.stringify(mode)} === 'LegacyBridge') {
      const updater = require('electron-updater').autoUpdater;
      const setFeed = updater.setFeedURL.bind(updater);
      updater.setFeedURL = options => {
        if (options?.provider === 'github' && options.owner === 'fri4666' && options.repo === 'bweeep-launcher') {
          globalThis.__bweeepUpdateProbe.mappedLegacyFeeds++;
          return setFeed({ provider: 'generic', url: ${JSON.stringify(localFeed)}, channel: 'latest', useMultipleRangeRequest: false });
        }
        return setFeed(options);
      };
    }
    net.fetch = async (input, options) => {
      const originalUrl = typeof input === 'string' ? input : input.url;
      let requestUrl = originalUrl;
      if (originalUrl === prefix + '/channels/stable/x64.json') {
        requestUrl = prefix + '/manifests/' + target + '/x64/stable.json';
        globalThis.__bweeepUpdateProbe.mappedChannelRequests++;
      }
      const tracked = typeof requestUrl === 'string' && requestUrl.startsWith(prefix + '/') &&
        ['/channels/', '/manifests/', '/blobs/', '/installers/'].some(part => requestUrl.slice(prefix.length).startsWith(part));
      const record = tracked ? { path: requestUrl.slice(prefix.length), at: new Date().toISOString() } : null;
      if (record) globalThis.__bweeepUpdateProbe.requests.push(record);
      try { const response = await original(requestUrl, options); if (record) record.status = response.status; return response; }
      catch (error) { if (record) record.errorName = String(error?.name || 'Error').slice(0, 80); throw error; }
    };
    return { installed: true, pid: process.pid, version: require('electron').app.getVersion() };
  })()`;
  const installed = await evaluate(setup);
  assert.equal(installed?.installed, true);
  await save('probe-installed', installed);
  await fsp.writeFile(path.join(output, 'inspector-ready.json'), JSON.stringify({ ...installed, targetVersion: version, mapping: mode === 'LegacyBridge' ? 'github-stable-provider-to-loopback-verified-candidate-feed' : 'exact-stable-x64-channel-to-versioned-signed-manifest', signatureBypass: false }, null, 2));
  await call('Debugger.resume').catch(() => undefined);
  const moduleUrl = pathToFileURL(path.join(appPath, 'dist', 'src', 'main', 'launcher-update.js')).href;
  let previous = '';
  for (let index = 0; index < 450; index++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    let snapshot;
    try {
      snapshot = await evaluate(`(async () => {
        const update = await import(${JSON.stringify(moduleUrl)});
        return { version: process.versions.electron, ready: process.getBuiltinModule('module').createRequire(${JSON.stringify(packageFile)})('electron').app.isReady(), update: update.getLauncherUpdateStatus(), probe: globalThis.__bweeepUpdateProbe };
      })()`);
    } catch { await save('main-inspector-closed'); break; }
    const detail = { ...snapshot, ...(mode === 'LegacyBridge' ? { localFeedRequests } : {}) };
    const serialized = JSON.stringify(detail);
    if (serialized !== previous) { previous = serialized; await save('updater-snapshot', detail); }
  }
} catch (error) {
  await save('probe-failed', { error: error.message });
  process.exitCode = 1;
} finally {
  socket?.close();
  feedServer?.close();
}

