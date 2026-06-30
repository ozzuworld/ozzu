# CAT S41 in-HAL audio bridge (`libozzubridge.c`)

Reverse-engineered helper injected into the MediaTek MT6757 audio HAL process
(`android.hardware.audio@2.0-service-mediatek`, 32-bit) to reach cellular call audio.
**Proves both capture and inject work in-HAL — but the modem caps it at half-duplex.**
See `../README.md` (R&D Findings) and Cipher memory `reference_cat_s41_gsm_gateway_audio`
for the full story and the symbol map.

## What it does (trigger files under `/sdcard/mtklog/audio_dump/`)
- `ozzu_beep`  — BGS uplink inject (remote hears it). Content: `ulGain dlGain rate openA openB`.
- `ozzu_cap`   — downlink capture probe → `ozzu_cap.pcm`.
- `ozzu_loop`  — input-stream loopback (the path that CONFLICTS with BGS). `ulGain dur mode`.
- `ozzu_pcap`  — **passive** capture via the VoiceDL provider hook + BGS loopback. `ulGain dur mode`.

## Build (32-bit ARM, NDK r25c)
```
armv7a-linux-androideabi26-clang -O2 -shared -fPIC libozzubridge.c -o libozzubridge.so -llog -lm -ldl
```

## Deploy (Magisk module `ozzu-hal-bridge`)
1. `patchelf --add-needed libozzubridge.so` on the 32-bit `audio.primary.mt6757.so`.
2. Overlay the patched `.so` + `libozzubridge.so` under `system/vendor/lib[/hw]/`
   (`chcon u:object_r:vendor_file:s0`).
3. `sepolicy.rule`: `allow mtk_hal_audio mtk_hal_audio process execmem` +
   `allow mtk_hal_audio vendor_file file execmod`.
4. Reboot. **A bad lib crashes the audio HAL — remove the module + reboot to recover.**

## Key result
Capture (VoiceDL provider hook, 16 kHz) and inject (BGS) each work alone and coexist with the
*encoded* recorder, but the modem firmware refuses the **raw** recorder + BGS at the same instant.
→ half-duplex only on this phone; full-duplex needs a host-audio modem (Rock Pi path).
