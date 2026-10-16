import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, freeText, intervalMs, mergeSettings, registerMonitor } from '../src/monitor.js';
import { buildKeySvg, renderPng } from '../src/render.js';

function sdkError(code) {
  return Object.assign(new Error(code), { code });
}

function fakeClient({ setImage } = {}) {
  const handlers = new Map();
  const calls = [];
  return {
    calls,
    on(name, fn) { handlers.set(name, [...(handlers.get(name) || []), fn]); },
    async emit(name, actionId, id, payload = {}) {
      for (const fn of handlers.get(name) || []) await fn({ event: name, context: { bindingInstanceId: id, actionId, controller: 'Keypad' }, payload });
    },
    async getSettings() { return {}; },
    async setImage(id, image) { calls.push(['image', id, image.mimeType]); if (setImage) await setImage(id); },
    async setTitle(id, title) { calls.push(['title', id, title]); },
  };
}

const metrics = {
  ram: async () => ({ used: 8 * 1024 ** 3, total: 16 * 1024 ** 3, percent: 50 }),
  cpu: async () => ({ load: 12, temp: null }),
  gpu: async () => null,
  disk: async () => null,
  drives: async () => [],
};
const fakePng = async (svg) => Buffer.from(svg);

test('willAppear görseli gönderir, değişmeyen değer tekrar gönderilmez, basış zorla yeniler', async (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const client = fakeClient();
  const monitor = registerMonitor(client, { metrics, renderPng: fakePng, defaults: { ram: { interval: '2' } }, log: () => {} });
  await client.emit('action.willAppear', 'ram', 'k1', { settings: {} });
  t.mock.timers.tick(2000);
  await flush();
  assert.deepEqual(client.calls, [['image', 'k1', 'image/png']]);
  await client.emit('action.keyDown', 'ram', 'k1');
  assert.deepEqual(client.calls, [['image', 'k1', 'image/png'], ['image', 'k1', 'image/png']]);
  const binding = monitor.bindings.get('k1');
  await client.emit('action.willDisappear', 'ram', 'k1');
  assert.equal(monitor.bindings.size, 0);
  assert.equal(binding.stopped, true);
});

test('tanınmayan aksiyon yok sayılır', async () => {
  const client = fakeClient();
  const monitor = registerMonitor(client, { metrics, renderPng: fakePng, log: () => {} });
  await client.emit('action.willAppear', 'counter', 'k1');
  assert.equal(monitor.bindings.size, 0);
  assert.deepEqual(client.calls, []);
});

test('CONTEXT_EXPIRED tuşu durdurur, süreç düşmez', async () => {
  const client = fakeClient({ setImage: async () => { throw sdkError('CONTEXT_EXPIRED'); } });
  const monitor = registerMonitor(client, { metrics, renderPng: fakePng, log: () => {} });
  await client.emit('action.willAppear', 'cpu', 'k1');
  assert.equal(monitor.bindings.size, 0);
});

test('görsel çizilemezse metin başlığa düşer, görsel dönünce başlık temizlenir', async () => {
  let fail = true;
  const client = fakeClient();
  const logged = [];
  const monitor = registerMonitor(client, {
    metrics,
    renderPng: async (svg) => { if (fail) throw new Error('sharp yok'); return Buffer.from(svg); },
    log: (key) => logged.push(key),
  });
  await client.emit('action.willAppear', 'cpu', 'k1');
  assert.deepEqual(client.calls, [['title', 'k1', 'CPU\n12%']]);
  fail = false;
  await client.emit('action.keyDown', 'cpu', 'k1');
  assert.deepEqual(client.calls.slice(1), [['image', 'k1', 'image/png'], ['title', 'k1', '']]);
  assert.deepEqual(logged, ['image:cpu']);
  monitor.stopAll();
});

test('RATE_LIMITED sessizce atlanır', async () => {
  const client = fakeClient({ setImage: async () => { throw sdkError('RATE_LIMITED'); } });
  const logged = [];
  const monitor = registerMonitor(client, { metrics, renderPng: fakePng, log: (key) => logged.push(key) });
  await client.emit('action.willAppear', 'ram', 'k1');
  assert.deepEqual(logged, []);
  assert.equal(client.calls.filter(([kind]) => kind === 'title').length, 0);
  monitor.stopAll();
});

test('ayarlar varsayılanlarla birleşir, aralık sınırlanır', () => {
  assert.deepEqual(mergeSettings({ interval: '2', drive: 'C' }, { drive: '', interval: '5' }), { interval: '5', drive: 'C' });
  assert.equal(intervalMs({ interval: '0' }), 1000);
  assert.equal(intervalMs({ interval: 'x' }), 2000);
  assert.equal(intervalMs({ interval: '600' }), 60000);
});

test('boş alan metni GB/TB seçer', () => {
  assert.equal(freeText(87 * 1024 ** 3), '87 GB boş');
  assert.equal(freeText(1.5 * 1024 ** 4), '1.5 TB boş');
});

test('logger aynı hatayı dakikada bir kez yazar', () => {
  let clock = 0;
  const lines = [];
  const log = createLogger((line) => lines.push(line), () => clock);
  log('a', new Error('x'));
  log('a', new Error('x'));
  clock = 61_000;
  log('a', new Error('x'));
  assert.equal(lines.length, 2);
});

test('PNG host sınırları içinde (<=128 KiB, 144x144) ve metin kaçışlı', async () => {
  const svg = buildKeySvg({ label: 'C:', percent: 91, value: '91%', corner: '1/3', sub: '<87> GB & boş' });
  assert.match(svg, /&lt;87&gt; GB &amp; boş/);
  const png = await renderPng(svg);
  assert.ok(png.length > 0 && png.length <= 128 * 1024);
  assert.equal(png.readUInt32BE(16), 144);
  assert.equal(png.readUInt32BE(20), 144);
});
