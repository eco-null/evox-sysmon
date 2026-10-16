// Tuş (binding) yaşam döngüsü: willAppear'da zamanlayıcı kurar, willDisappear'da kaldırır,
// her adımda ölçümü alıp görseli yalnız değiştiyse gönderir. Host hataları hiçbir zaman
// süreci düşürmez; düşen süreç host'un çökme bütçesini (5 dk'da 3) tüketir ve plugin kapanır.
import { normalizeDrive } from './metrics.js';
import { buildKeySvg, tempColor, viewText } from './render.js';

export function percentText(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${Math.round(value)}%` : '—';
}

export function gigabytes(bytes) {
  const g = bytes / 1024 ** 3;
  return g >= 100 ? String(Math.round(g)) : g.toFixed(1);
}

export function freeText(bytes) {
  const g = bytes / 1024 ** 3;
  return g >= 1000 ? `${(g / 1024).toFixed(1)} TB boş` : `${Math.round(g)} GB boş`;
}

function tempText(celsius) {
  return typeof celsius === 'number' ? `${Math.round(celsius)}°C` : '';
}

export const PANELS = Object.freeze({
  async cpu(settings, metrics) {
    const { load, temp } = await metrics.cpu({ lhmUrl: settings.lhmUrl });
    return { label: 'CPU', percent: load, value: percentText(load), sub: tempText(temp), subColor: tempColor(temp) };
  },
  async gpu(settings, metrics) {
    const gpu = await metrics.gpu({ lhmUrl: settings.lhmUrl });
    const util = gpu?.util ?? null;
    const vram = gpu?.memUsed != null && gpu?.memTotal > 0 ? `${(gpu.memUsed / 1024).toFixed(1)}G` : '';
    return { label: 'GPU', percent: util, value: percentText(util), corner: vram, sub: tempText(gpu?.temp ?? null), subColor: tempColor(gpu?.temp ?? null) };
  },
  async ram(settings, metrics) {
    const { used, total, percent } = await metrics.ram();
    return { label: 'RAM', percent, value: percentText(percent), sub: total > 0 ? `${gigabytes(used)}/${gigabytes(total)} GB` : '' };
  },
  async disk(settings, metrics, binding) {
    if (settings.mode === 'all') {
      const drives = await metrics.drives();
      if (!drives.length) return { label: 'Disk', percent: null, value: '—' };
      const index = binding.cursor % drives.length;
      binding.cursor = index + 1;
      return diskView(drives[index], drives.length > 1 ? `${index + 1}/${drives.length}` : '');
    }
    const letter = normalizeDrive(settings.drive) || 'C';
    const drive = await metrics.disk(letter);
    return drive ? diskView(drive, '') : { label: `${letter}:`, percent: null, value: '—', sub: 'bulunamadı' };
  },
});

function diskView(drive, corner) {
  return { label: drive.drive, percent: drive.percent, value: percentText(drive.percent), corner, sub: freeText(drive.free) };
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

// Boş değerler manifest varsayılanına düşer (host boş alanı '' olarak gönderebilir).
export function mergeSettings(defaults, provided) {
  const merged = { ...defaults };
  if (isPlainObject(provided)) {
    for (const [key, value] of Object.entries(provided)) {
      if (value !== '' && value !== null && value !== undefined) merged[key] = value;
    }
  }
  return merged;
}

export function intervalMs(settings) {
  const seconds = Number(settings.interval);
  return Math.min(60, Math.max(1, Number.isFinite(seconds) ? seconds : 2)) * 1000;
}

// Aynı hatayı dakikada bir kez yazar; host log hızını (1 MiB/dk) aşan plugin kapatılır.
export function createLogger(write = (line) => console.error(line), now = Date.now) {
  const seen = new Map();
  return (key, error) => {
    const at = now();
    if (at - (seen.get(key) ?? -Infinity) < 60_000) return;
    seen.set(key, at);
    write(`[sysmon] ${key}: ${String(error?.code || '')} ${String(error?.message || error || '')}`.slice(0, 300));
  };
}

const CONTEXT_GONE = new Set(['CONTEXT_EXPIRED', 'PLUGIN_DISABLED']);

export function registerMonitor(client, { metrics, renderPng, defaults = {}, log = createLogger() }) {
  const bindings = new Map();

  function stop(id) {
    const binding = bindings.get(id);
    if (!binding) return;
    binding.stopped = true;
    clearInterval(binding.timer);
    bindings.delete(id);
  }

  async function present(binding, view) {
    const id = binding.id;
    const svg = buildKeySvg(view);
    if (svg === binding.lastSvg) return;
    try {
      const png = await renderPng(svg);
      await client.setImage(id, { kind: 'raster', mimeType: 'image/png', dataBase64: png.toString('base64') });
      binding.lastSvg = svg;
      if (binding.titled) {
        binding.titled = false;
        await client.setTitle(id, '');
      }
      return;
    } catch (error) {
      if (CONTEXT_GONE.has(error?.code)) throw error;
      if (error?.code === 'RATE_LIMITED') return;
      log(`image:${binding.actionId}`, error);
    }
    // Görsel olmadı (sharp yüklenemedi ya da host reddetti): metinle göster, sonraki adımda yine dene.
    await client.setTitle(id, viewText(view));
    binding.titled = true;
  }

  async function refresh(binding) {
    if (binding.busy || binding.stopped) return;
    binding.busy = true;
    try {
      const view = await PANELS[binding.actionId](binding.settings, metrics, binding);
      if (!binding.stopped) await present(binding, view);
    } catch (error) {
      if (CONTEXT_GONE.has(error?.code)) stop(binding.id);
      else log(`refresh:${binding.actionId}`, error);
    } finally {
      binding.busy = false;
    }
  }

  async function start(event) {
    const context = event?.context;
    if (!context || !Object.hasOwn(PANELS, context.actionId)) return;
    const id = context.bindingInstanceId;
    stop(id);
    const binding = { id, actionId: context.actionId, settings: {}, timer: null, busy: false, stopped: false, lastSvg: null, titled: false, cursor: 0 };
    bindings.set(id, binding);
    let provided = event.payload?.settings;
    if (!isPlainObject(provided)) provided = await client.getSettings(id).catch(() => ({}));
    if (binding.stopped) return;
    binding.settings = mergeSettings(defaults[binding.actionId], provided);
    binding.timer = setInterval(() => { void refresh(binding); }, intervalMs(binding.settings));
    await refresh(binding);
  }

  const guard = (handler) => async (event) => {
    try { await handler(event); } catch (error) { log(`event:${event?.event}`, error); }
  };

  client.on('action.willAppear', guard(start));
  client.on('action.settingsChanged', guard(start));
  client.on('action.willDisappear', guard((event) => stop(event?.context?.bindingInstanceId)));
  // Basınca hemen yenile; "tüm sürücüler" kipinde bir sonraki sürücüye geçer.
  client.on('action.keyDown', guard(async (event) => {
    const binding = bindings.get(event?.context?.bindingInstanceId);
    if (!binding) return;
    binding.lastSvg = null;
    await refresh(binding);
  }));

  return {
    bindings,
    stopAll() { for (const id of [...bindings.keys()]) stop(id); },
  };
}
