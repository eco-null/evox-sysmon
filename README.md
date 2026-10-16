# evoX Kaynak İzleyici

evoX için T1 (trusted-node) yerel plugin. Tuşlarda halka göstergeyle **CPU**, **GPU**, **RAM** ve **Disk** gösterir.

| Aksiyon | Gösterilen | Kaynak |
| --- | --- | --- |
| CPU | kullanım %, sıcaklık | Node `os` · sıcaklık için LibreHardwareMonitor |
| GPU | kullanım %, sıcaklık, VRAM | `nvidia-smi` · yoksa LibreHardwareMonitor |
| RAM | kullanım %, kullanılan/toplam GB | Node `os` |
| Disk | doluluk %, boş alan; tek sürücü ya da tümü sırayla | `fs.statfs` |

Halka rengi: yeşil < %60 ≤ sarı < %85 ≤ kırmızı. Tuşa basınca hemen yenilenir; "Tüm sürücüler" kipinde sıradaki sürücüye geçer.

## Kurulum

```bash
npm install
```

evoX → **Eklentiler** → **Geliştirici** → **Proje seç** → bu klasör → güveni onayla → **Başlat**. Ardından **Tuşlar** ekranında aksiyonları tuşlara sürükleyin.

CPU sıcaklığı için [LibreHardwareMonitor](https://github.com/LibreHardwareMonitor/LibreHardwareMonitor) çalışmalı ve **Options → Remote Web Server** açık olmalı (varsayılan adres `http://localhost:8085/data.json`).

## Neden yeniden yazıldı

Eski `evox-toolkit` (SDK 0.1.x) evoX 0.3.x ile "Tekrarlanan hatalar nedeniyle kapatıldı" durumuna düştü: host süreci 5 sn içinde handshake bekler, 5 dakikada 3'ten fazla çökmede plugini kapatır. Eski plugin `sharp` ve `systeminformation`'ı handshake'ten önce yüklüyordu. Bu sürüm:

- SDK 0.2.0 kullanır (`sdkVersion` manifest ile aynı yerden okunur).
- Handshake'ten önce yalnız hafif modülleri yükler; `sharp` ilk çizimde gelir. `systeminformation` bağımlılığı yok.
- Host hatalarında (`RATE_LIMITED`, `CONTEXT_EXPIRED`) süreci düşürmez; hata loglarını dakikada bir ile sınırlar.
- Görsel yalnız değiştiğinde gönderilir (host sınırı: bağlam başına 5/sn, ≤128 KiB, ≤256 px).

## Test

```bash
npm test
```
