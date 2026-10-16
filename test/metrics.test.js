import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpuTotals, loadBetween, memo, normalizeDrive, parseLhm, parseLhmNumber, parseNvidiaSmi, readDrive } from '../src/metrics.js';

test('CPU yükü iki örnek arasındaki boşta kalma farkından hesaplanır', () => {
  const a = cpuTotals([{ times: { user: 100, nice: 0, sys: 50, idle: 850, irq: 0 } }]);
  const b = cpuTotals([{ times: { user: 200, nice: 0, sys: 100, idle: 1700, irq: 0 } }]);
  assert.ok(Math.abs(loadBetween(a, b) - 15) < 1e-9);
  assert.equal(loadBetween(b, b), null);
});

test('LHM yerelleştirilmiş sayıları okur', () => {
  assert.equal(parseLhmNumber('90,9 °C'), 90.9);
  assert.equal(parseLhmNumber('2640 MB'), 2640);
  assert.equal(parseLhmNumber(''), null);
});

test('LHM ağacından CPU sıcaklığı ve GPU değerleri seçilir', () => {
  const sensor = (SensorId, Type, Text, Value) => ({ SensorId, Type, Text, Value, Children: [] });
  const root = { Children: [{ Children: [
    { HardwareId: '/amdcpu/0', Children: [
      sensor('/amdcpu/0/temperature/3', 'Temperature', 'CCD1 (Tdie)', '81,5 °C'),
      sensor('/amdcpu/0/temperature/2', 'Temperature', 'Core (Tctl/Tdie)', '90,9 °C'),
    ] },
    { HardwareId: '/gpu-nvidia/0', Children: [
      sensor('/gpu-nvidia/0/load/0', 'Load', 'GPU Core', '7,0 %'),
      sensor('/gpu-nvidia/0/temperature/0', 'Temperature', 'GPU Core', '63,0 °C'),
      sensor('/gpu-nvidia/0/smalldata/1', 'SmallData', 'GPU Memory Used', '2640 MB'),
      sensor('/gpu-nvidia/0/smalldata/2', 'SmallData', 'GPU Memory Total', '8151 MB'),
    ] },
  ] }] };
  assert.deepEqual(parseLhm(root), { cpuTemp: 90.9, gpu: { util: 7, temp: 63, memUsed: 2640, memTotal: 8151 } });
  assert.deepEqual(parseLhm({}), { cpuTemp: null, gpu: null });
});

test('nvidia-smi CSV satırı ayrıştırılır', () => {
  assert.deepEqual(parseNvidiaSmi('5, 62, 2640, 8151\r\n'), { util: 5, temp: 62, memUsed: 2640, memTotal: 8151 });
  assert.equal(parseNvidiaSmi('No devices were found'), null);
});

test('sürücü harfi normalize edilir', () => {
  assert.equal(normalizeDrive(' c: '), 'C');
  assert.equal(normalizeDrive('D:\\'), 'D');
  assert.equal(normalizeDrive('CD'), '');
});

test('statfs sonucu bayt ve yüzdeye çevrilir', async () => {
  const drive = await readDrive('C', { statfsImpl: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }) });
  assert.deepEqual(drive, { drive: 'C:', total: 4096000, free: 1024000, used: 3072000, percent: 75 });
});

test('memo eşzamanlı çağrıları tek isteğe indirir ve süre dolunca yeniler', async () => {
  let clock = 0;
  let calls = 0;
  const get = memo(async () => ++calls, 1000, () => clock);
  assert.deepEqual(await Promise.all([get(), get()]), [1, 1]);
  clock = 500;
  assert.equal(await get(), 1);
  clock = 1600;
  assert.equal(await get(), 2);
});
