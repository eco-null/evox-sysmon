// Sistem ölçümleri. Ağır bağımlılık yok: CPU/RAM Node `os`, disk `fs.statfs`, GPU nvidia-smi,
// sıcaklıklar isteğe bağlı LibreHardwareMonitor web sunucusu. Her kaynak kısa süre önbelleğe
// alınır ve eşzamanlı çağrılar tek isteği paylaşır; aynı ölçümü gösteren birden çok tuş
// sistemi ayrı ayrı yormaz.
import os from 'node:os';
import { statfs } from 'node:fs/promises';
import { execFile } from 'node:child_process';

export const DEFAULT_LHM_URL = 'http://localhost:8085/data.json';

// Aynı anahtar için `maxAgeMs` içinde sonucu yeniden kullanır, uçuştaki isteği paylaşır.
export function memo(fn, maxAgeMs, now = Date.now) {
  const entries = new Map();
  return (key = '') => {
    const hit = entries.get(key);
    if (hit && (hit.pending || now() - hit.at < maxAgeMs)) return hit.promise;
    const entry = { at: now(), pending: true, promise: null };
    entry.promise = Promise.resolve()
      .then(() => fn(key))
      .finally(() => { entry.pending = false; entry.at = now(); });
    entries.set(key, entry);
    return entry.promise;
  };
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TIMEOUT')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// --- CPU ---------------------------------------------------------------------------------------

export function cpuTotals(cpus) {
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

export function loadBetween(prev, next) {
  const total = next.total - prev.total;
  if (!(total > 0)) return null;
  return Math.min(100, Math.max(0, (1 - (next.idle - prev.idle) / total) * 100));
}

export function createCpuSampler({ cpus = os.cpus, wait = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let last = null;
  return async () => {
    if (!last) {
      last = cpuTotals(cpus());
      await wait(250);
    }
    const next = cpuTotals(cpus());
    const load = loadBetween(last, next);
    last = next;
    return load;
  };
}

// --- RAM ---------------------------------------------------------------------------------------

export function readMemory({ totalmem = os.totalmem, freemem = os.freemem } = {}) {
  const total = totalmem();
  const used = total - freemem();
  return { used, total, percent: total > 0 ? (used / total) * 100 : null };
}

// --- Disk --------------------------------------------------------------------------------------

export function normalizeDrive(value) {
  const letter = String(value ?? '').trim().toUpperCase().replace(/[:\\/]+$/, '');
  return /^[A-Z]$/.test(letter) ? letter : '';
}

export async function readDrive(letter, { statfsImpl = statfs } = {}) {
  const s = await withTimeout(statfsImpl(`${letter}:\\`), 1500);
  const total = Number(s.blocks) * Number(s.bsize);
  const free = Number(s.bavail) * Number(s.bsize);
  if (!(total > 0)) throw new Error('DRIVE_EMPTY');
  return { drive: `${letter}:`, total, free, used: total - free, percent: ((total - free) / total) * 100 };
}

// A: ve B: disket harfleridir; taranmaz.
export async function listDrives(options) {
  const letters = 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  const results = await Promise.allSettled(letters.map((l) => readDrive(l, options)));
  return results.filter((r) => r.status === 'fulfilled').map((r) => r.value);
}

// --- LibreHardwareMonitor ----------------------------------------------------------------------

// LHM değerleri yerelleştirilmiş metindir: "90,9 °C", "26,4 %", "2640 MB".
export function parseLhmNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const match = String(value ?? '').replace(',', '.').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function lhmHardware(root) {
  const hardware = [];
  (function walk(node, current) {
    if (!node || typeof node !== 'object') return;
    const id = typeof node.HardwareId === 'string' ? node.HardwareId : '';
    const owner = id ? { id, sensors: [] } : current;
    if (id) hardware.push(owner);
    if (owner && typeof node.SensorId === 'string') {
      owner.sensors.push({ type: String(node.Type ?? ''), text: String(node.Text ?? ''), value: parseLhmNumber(node.Value) });
    }
    if (Array.isArray(node.Children)) for (const child of node.Children) walk(child, owner);
  })(root, null);
  return hardware;
}

function pickSensor(sensors, type, names) {
  for (const name of names) {
    const hit = sensors.find((s) => s.type === type && s.text.startsWith(name) && s.value != null);
    if (hit) return hit.value;
  }
  return null;
}

const CPU_TEMP_NAMES = ['Core (Tctl/Tdie)', 'CPU Package', 'Package', 'Core Max', 'CCDs Max', 'Tctl', 'Core Average'];
const GPU_PREFIXES = ['/gpu-nvidia', '/gpu-amd', '/gpu-intel'];

export function parseLhm(root) {
  const hardware = lhmHardware(root);
  const cpu = hardware.find((h) => /^\/(amdcpu|intelcpu)/.test(h.id));
  const gpu = GPU_PREFIXES.map((p) => hardware.find((h) => h.id.startsWith(p))).find(Boolean);
  const temp = (v) => (v != null && v > 0 && v < 130 ? v : null);
  return {
    cpuTemp: cpu ? temp(pickSensor(cpu.sensors, 'Temperature', CPU_TEMP_NAMES)) : null,
    gpu: gpu ? {
      util: pickSensor(gpu.sensors, 'Load', ['GPU Core']),
      temp: temp(pickSensor(gpu.sensors, 'Temperature', ['GPU Core', 'GPU Hot Spot'])),
      memUsed: pickSensor(gpu.sensors, 'SmallData', ['GPU Memory Used', 'D3D Dedicated Memory Used']),
      memTotal: pickSensor(gpu.sensors, 'SmallData', ['GPU Memory Total']),
    } : null,
  };
}

export async function fetchLhm(url, { fetchImpl = fetch } = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) return null;
  try {
    const res = await fetchImpl(target, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    return parseLhm(await res.json());
  } catch {
    return null;
  }
}

// --- NVIDIA ------------------------------------------------------------------------------------

export function parseNvidiaSmi(stdout) {
  const line = String(stdout ?? '').split(/\r?\n/).find((l) => l.trim());
  if (!line) return null;
  const [util, temp, memUsed, memTotal] = line.split(',').map((s) => Number.parseFloat(s.trim()));
  if (!Number.isFinite(util)) return null;
  const num = (v) => (Number.isFinite(v) ? v : null);
  return { util, temp: num(temp), memUsed: num(memUsed), memTotal: num(memTotal) };
}

export function createNvidiaReader({ exec = execFile, now = Date.now } = {}) {
  let missingUntil = 0;
  return () => new Promise((resolve) => {
    if (now() < missingUntil) return resolve(null);
    exec('nvidia-smi', ['--query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total', '--format=csv,noheader,nounits'],
      { timeout: 3000, windowsHide: true }, (error, stdout) => {
        const parsed = error ? null : parseNvidiaSmi(stdout);
        // nvidia-smi yoksa (NVIDIA olmayan sistem) her saniye süreç açmamak için bir dakika bekle.
        if (!parsed) missingUntil = now() + 60_000;
        resolve(parsed);
      });
  });
}

// --- Birleşik ölçüm yüzeyi ---------------------------------------------------------------------

export function createMetrics() {
  const cpuLoad = memo(createCpuSampler(), 900);
  const lhm = memo((url) => fetchLhm(url), 900);
  const nvidia = memo(createNvidiaReader(), 900);
  const drives = memo(() => listDrives(), 30_000);
  const drive = memo((letter) => readDrive(letter).catch(() => null), 900);

  return {
    async cpu({ lhmUrl }) {
      const [load, sensors] = await Promise.all([cpuLoad(), lhm(lhmUrl)]);
      return { load, temp: sensors?.cpuTemp ?? null };
    },
    async gpu({ lhmUrl }) {
      const nv = await nvidia();
      if (nv) return nv;
      return (await lhm(lhmUrl))?.gpu ?? null;
    },
    async ram() {
      return readMemory();
    },
    async disk(letter) {
      return drive(letter);
    },
    async drives() {
      return drives();
    },
  };
}
