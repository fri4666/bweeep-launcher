import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Disposable CI runner only');
assert.equal(process.platform, 'win32', 'Native Windows runner required');
const [portText, root, version, output] = process.argv.slice(2);
const port = Number(portText);
assert.ok(Number.isInteger(port) && port >= 1024 && port <= 65535);
assert.ok(path.isAbsolute(root) && path.isAbsolute(output));
assert.match(version, /^\d+\.\d+\.\d+$/);
const storage = 'https://tmwvrglzjfzauuygofpp.supabase.co/storage/v1/object/public/bweeep-launcher-updates';
const timeline = [];
const save = async (phase, detail = {}) => {
  timeline.push({ at: new Date().toISOString(), phase, ...detail });
  await fsp.writeFile(path.join(output, 'inspector-diagnostics.json'), JSON.stringify(timeline, null, 2));
};
let socket;
const pending = new Map();
let serial = 0;
const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++serial;
  const timeout = setTimeout(() => { pending.delete(id); reject(new Error('Inspector command timed out: ' + method)); }, 10_000);
  pending.set(id, { resolve, reject, timeout });
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (response.exceptionDetails) throw new Error('Controlled inspector evaluation failed: ' + (response.exceptionDetails.text || 'exception'));
  return response.result?.value;
};
try {
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
  await call('Runtime.runIfWaitingForDebugger');
  const packageFile = path.join(root, 'resources', 'app', 'package.json');
  const setup = `(() => {
    const require = process.getBuiltinModule('module').createRequire(${JSON.stringify(packageFile)});
    if (process.execPath.toLowerCase() !== ${JSON.stringify(path.join(root, 'Bweeep.exe').toLowerCase())}) throw new Error('Unexpected inspector executable');
    const { net, app } = require('electron');
    app.once('before-quit', () => require('node:inspector').close());
    const original = net.fetch.bind(net);
    const prefix = ${JSON.stringify(storage)};
    const target = ${JSON.stringify(version)};
    globalThis.__bweeepUpdateProbe = { requests: [], mappedChannelRequests: 0 };
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
  await fsp.writeFile(path.join(output, 'inspector-ready.json'), JSON.stringify({ ...installed, targetVersion: version, mapping: 'exact-stable-x64-channel-to-versioned-signed-manifest', signatureBypass: false }, null, 2));
  await call('Debugger.resume').catch(() => undefined);
  const moduleUrl = pathToFileURL(path.join(root, 'resources', 'app', 'dist', 'src', 'main', 'launcher-update.js')).href;
  let previous = '';
  for (let index = 0; index < 450; index++) {
    await new Promise(resolve => setTimeout(resolve, 2000));
    let snapshot;
    try {
      snapshot = await evaluate(`(async () => {
        const update = await import(${JSON.stringify(moduleUrl)});
        return { version: process.versions.electron, update: update.getLauncherUpdateStatus(), probe: globalThis.__bweeepUpdateProbe };
      })()`);
    } catch { await save('main-inspector-closed'); break; }
    const serialized = JSON.stringify(snapshot);
    if (serialized !== previous) { previous = serialized; await save('updater-snapshot', snapshot); }
  }
} catch (error) {
  await save('probe-failed', { error: error.message });
  process.exitCode = 1;
} finally {
  socket?.close();
}

