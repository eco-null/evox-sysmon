// evoX Kaynak İzleyici — T1 (trusted-node) giriş noktası.
// Host bu dosyayı fork eder ve 5 sn içinde handshake bekler; bu yüzden burada yalnız hafif
// modüller yüklenir. sharp ilk tuş çiziminde, ölçüm araçları ilk ihtiyaçta devreye girer.
import { readFileSync } from 'node:fs';
import { EvoxPluginClient } from '@evoxapp/plugin-sdk';
import { createNodeProcessIpcPluginTransport } from '@evoxapp/plugin-sdk/node';
import { createLogger, registerMonitor } from './src/monitor.js';
import { createMetrics } from './src/metrics.js';
import { renderPng } from './src/render.js';

const manifest = JSON.parse(readFileSync(new URL('./manifest.json', import.meta.url), 'utf8'));
const defaults = Object.fromEntries(manifest.actions.map((action) => [
  action.id,
  Object.fromEntries(action.settingsSchema.filter((f) => f.default !== undefined).map((f) => [f.key, f.default])),
]));

const log = createLogger();
// Yakalanmamış bir ret süreci düşürür ve host'un çökme bütçesini harcar; kaydedip devam et.
process.on('unhandledRejection', (error) => log('unhandledRejection', error));

const client = new EvoxPluginClient(createNodeProcessIpcPluginTransport(), {
  // Manifestteki sdkVersion ile birebir aynı olmalı; host handshake'te karşılaştırır.
  sdkVersion: manifest.sdkVersion,
  onError: (error) => log('sdk', error),
});

const monitor = registerMonitor(client, { metrics: createMetrics(), renderPng, defaults, log });

let stopped = false;
client.on('plugin.stop', () => {
  if (stopped) return;
  stopped = true;
  monitor.stopAll();
  client.dispose();
});

await client.start();
