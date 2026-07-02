# Ozzu GSM Gateway

Turns a cellular modem into a **GSM ↔ SIP gateway** for the Ozzu call pipeline — incoming
mobile calls are bridged to Asterisk and answered by **June** (the AI receptionist, Gemini
Live). The goal: King Kazuma's number forwards to the gateway; June screens/answers; legit
calls ring through to the iPhone via VoIP.

---

## ⚠️ STATUS (2026-06-30) — read this first

**The CAT S41 (phone) path is capped at HALF-DUPLEX by a hard MediaTek modem limit.**
Full reverse-engineering is documented below so nobody re-derives it. **Full-duplex 4G↔SIP
has pivoted to the Rock Pi 4B + USB SIM modem** (`dir_1782783211595`), because a USB
cellular modem *exposes the call audio to the host* and the CAT's integrated modem does not.

| Hardware path | How we reach call audio | Duplex | State |
|---|---|---|---|
| **CAT S41 (MediaTek MT6757 phone)** | reverse-engineered in-HAL injection | **half-duplex only** (turn-taking) | R&D complete; modem-limited |
| **Rock Pi 4B + USB SIM modem** | modem exposes audio as a host PCM/USB stream (chan_dongle pattern) | **full-duplex** | next — `dir_1782783211595` |

---

## Why a phone modem is hard, and a USB modem isn't

There are two kinds of cellular modems, and they could not be more different for this use case:

1. **Host-audio modems** (USB dongles, SIM7600, Quectel EC25/EG25, Huawei sticks). The modem
   hands the call audio to the host as a **clean digital stream** — it shows up as a USB sound
   card / PCM device. You read the downlink and write the uplink like any audio device.
   Full-duplex, no DSP hacking, no conflict. This is what Asterisk `chan_dongle` and commercial
   GSM gateways use. **This is the easy "two sinks" path.**

2. **Integrated phone modems** (the CAT's MT6757). Built for a *phone*, so the modem is wired
   straight to an **audio codec chip in hardware** — modem → codec → speaker/mic. The host CPU
   **never sees the audio as data**; it only controls the call (dial/answer). To get the audio
   you must reverse-engineer the proprietary audio HAL, and you're then limited to whatever taps
   the *modem firmware* exposes.

The CAT is type 2 — the hard kind. Most modern phones are type 2 (iPhones give **zero** call-audio
access; most Androids block in-call recording). The CAT got us as far as it did *only* because it's
a rootable MediaTek with a HAL we could pry open. It's the unusually cooperative phone — and even
"unusually cooperative" tops out at half-duplex.

---

## R&D Findings — the in-HAL approach and the wall

Goal was full-duplex: capture the caller (downlink) for June **and** inject June (uplink) so the
caller hears her, **at the same time**. We got **both halves working separately, in the HAL,
phone-only, with no local noise** — then hit a modem-firmware wall when running them together.

### Architecture that was built

The audio HAL on this Treble phone runs in a separate 32-bit process
`android.hardware.audio@2.0-service-mediatek`, which loads
`/system/vendor/lib/hw/audio.primary.mt6757.so` and owns `/dev/ccci_aud` (the modem channel).
A separate root process can call every HAL function but gets **zero** modem data, so we inject a
helper **into** that HAL process:

- **Injection:** `patchelf --add-needed libozzubridge.so` on the 32-bit
  `audio.primary.mt6757.so`; a Magisk module (`ozzu-hal-bridge`) overlays the patched `.so` plus
  `libozzubridge.so` under `system/vendor/lib[/hw]/`. The lib's constructor spawns a worker thread
  and resolves live HAL singletons via `dlopen(..., RTLD_NOLOAD)`. **A bad lib crashes the audio
  HAL → no audio until the module is removed** (`rm -rf /data/adb/modules/ozzu-hal-bridge` +
  reboot; recoverable over ADB/WG, not a brick).
- Source: `scratchpad/pcm2way/libozzubridge.c` (in the working session's scratchpad); full symbol
  map + every gotcha is in Cipher memory `reference_cat_s41_gsm_gateway_audio`.

### What works — CAPTURE (caller → June) ✅

Passively hook the downlink record provider — **no separate input stream** (an input stream
reconfigures the call routing and kills injection):

- Open `AudioALSACaptureDataProviderVoiceDL` and inline-hook its
  `provideModemRecordDataToProvider(RingBuf)`; copy the raw downlink out of the ring buffer.
- The modem record runs at **16 kHz mono S16LE** (HD / AMR-WB), *not* 48 kHz.
- Proven: one 12 s call captured a **flawless** recording of the caller's voice (clear speech
  envelope, ~1900× silence-to-speech swing).

### What works — INJECT (June → caller) ✅

- **BGS (Background Sound)**: `SpeechDriverLAD::BGSoundConfig(ulGain,dlGain)` + `BGSoundOn()`
  sends `MSG_A2M_BGSND_ON` — the **modem** mixes the sound into the uplink so the *remote* party
  hears it. `BGSPlayer::Write` feeds PCM (gain ~160–200; lower was inaudible). King Kazuma heard
  injected beeps clearly.
- **Mic mute:** `SetUplinkSourceMute(true)` = `MSG_A2M_MUTE_SPH_UL_SOURCE` mutes **only the mic**
  (leaves BGS). `SetUplinkMute` = `MSG_A2M_MUTE_SPH_UL` mutes the **whole** uplink incl. BGS —
  do not use that one.

### The wall — the modem refuses both at once ❌

Running capture + inject together: data flows perfectly end-to-end (hook captures, buffer hands
off, BGS is fed at the correct rate) **but BGS goes silent**. Confirmed repeatedly, including with
a loud clean test beep.

- The downlink record provider's `open()` calls `recordOn(RECORD_TYPE_DL)` which actually issues
  **`RecordOn(RECORD_TYPE_MIX)`** → `MSG_A2M_PCM_REC_ON` to the modem.
- The AP-side HAL source shows **no** record↔BGS mutual exclusion (independent status masks), so
  the exclusion is enforced **inside the closed baseband firmware**: it will not run the
  **raw-PCM recorder** and the **background-sound injector** simultaneously.
- Tell: the modem's **encoded** recorder (`persist.af.vm_on`, `VoiceMemoRecordOn`) *does* coexist
  with BGS — but its output is a modem-defined encoded format, not cleanly decodable, and it does
  not feed the raw-PCM providers.

### SELinux (needed for the in-HAL hook)

The `mtk_hal_audio` domain (enforcing) lacks the permissions to install an inline hook. Granted
via a persistent Magisk `sepolicy.rule`:

```
allow mtk_hal_audio mtk_hal_audio process execmem
allow mtk_hal_audio vendor_file      file    execmod
```

(Live: `magiskpolicy --live "allow ..."`.) Without `execmem` the trampoline `mprotect` fails;
without `execmod` restoring the patched `.text` page to executable fails (and executing a
non-exec page crashes the HAL).

### Why full-duplex is impractical on the CAT

The call audio lives entirely in the **modem's domain** — it never transits AP-tappable hardware
(the in-call ALSA mixer state is byte-for-byte identical to idle; there is no PCM bus to read).
The **only** doors are the modem's own features (recorder, BGS injector), and the firmware won't
open both at once. So it isn't a missing clever hack — the audio simply isn't present where a
"read two streams" approach would need it.

### What the CAT *can* do: half-duplex June

A call is naturally half-duplex and June (Gemini Live) is turn-based — she listens, then responds.
So we can work **with** the modem limit:

- caller talking → recorder ON (June listens)
- June responding → recorder OFF, BGS ON (caller hears June)
- June done → switch back

Both halves are proven; we just alternate at turn boundaries (no barge-in / can't interrupt June
mid-sentence). This is viable but was set aside in favor of the full-duplex Rock Pi path.

---

## Conclusion / Decision (2026-06-30)

- **CAT S41 = half-duplex ceiling.** Keep it only if the must-have is "SIM physically in this
  pocket phone." Otherwise it's the wrong tool for full-duplex.
- **Full-duplex → Rock Pi 4B (10.9.0.21) + USB SIM modem** (`dir_1782783211595`). A host-audio
  modem exposes the call audio as a clean stream → full-duplex 4G↔SIP with **no** HAL hacking,
  no SELinux surgery, no modem conflict. Standard `chan_dongle`/Asterisk pattern.
- **Or skip the modem entirely:** forward the carrier number to a SIP DID and run June on the
  Asterisk/Gemini server already built. Needs carrier call-forwarding.

---

## Pipeline context (applies to whichever gateway hardware)

```
Incoming call → carrier → *21* forward → gateway (SIM)
                                            │  GSM call presented to Asterisk as a SIP trunk
                                            ▼
                                       Asterisk (bridge VM)  → June (AudioSocket → Gemini Live)
                                            │
                                  ┌─────────┴─────────┐
                             Spam/Robot           Legit call
                             → June handles      → June briefs the app; on King Kazuma's
                                                   Accept, transfer to iPhone (WebRTC/CallKit)
```

| Component | Location | Role |
|---|---|---|
| Asterisk PBX | `backend/asterisk/conf/` | SIP trunk endpoint + dialplan |
| June voice | `backend/bridge/june-voice.js` | AudioSocket ↔ Gemini Live API |
| Bridge call API | `backend/bridge/routes/soc.js` | call log / OSINT / notifications |
| Ozzu app call leg | `frontend/lib/useWebrtcCall.ts` + `useCallBriefing.ts` | iPhone: WebRTC/CallKit media + the screening-gate briefing (accept/decline). The old native SIP modules (`modules/voip-call`, `modules/sip-toolkit`) are inactive. |

**Call forwarding:** on the source phone `*21*[gateway-number]#`; cancel `##21#`.

---

## Historical: the Android-app approach (superseded by the in-HAL R&D)

The first attempt was an Android app on the CAT (`tools/gsm-gateway/android/`) that auto-answered
the GSM call and bridged audio to Asterisk via RTP using `AudioRecord(VOICE_CALL)`. That source is
**blocked by Android policy** on the MT6757 ("Invalid capture preset 4") even as a privileged app
with `CAPTURE_AUDIO_OUTPUT`, so it can only capture the near-end mic — never the caller. That dead
end is what led to the in-HAL injection R&D above. The app is kept as a historical reference /
throwaway probe.
