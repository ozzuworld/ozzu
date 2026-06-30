// libozzubridge.so — injected into android.hardware.audio@2.0-service-mediatek (32-bit)
// Runs IN the HAL process. Two triggers (mtime-guarded, fire once per touch):
//   ozzu_beep  -> BGS (Background Sound) inject to UPLINK so the REMOTE caller hears it.
//                 Optional file content "ulGain dlGain rate openA openB" to tune params.
//   ozzu_cap   -> Record2Way capture (8s) -> ozzu_cap.pcm

#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <math.h>
#include <stdint.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <errno.h>
#include <android/log.h>

#define TAG "OzzuBridge"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, TAG, __VA_ARGS__)
#define HAL32a "/vendor/lib/hw/audio.primary.mt6757.so"
#define HAL32b "/system/vendor/lib/hw/audio.primary.mt6757.so"
#define DUMPDIR "/sdcard/mtklog/audio_dump"
#define BEEP_TRIG  DUMPDIR "/ozzu_beep"
#define CAP_TRIG   DUMPDIR "/ozzu_cap"
#define CAP_OUT    DUMPDIR "/ozzu_cap.pcm"
#define LOOP_TRIG  DUMPDIR "/ozzu_loop"
#define PCAP_TRIG  DUMPDIR "/ozzu_pcap"   // PASSIVE capture (hook VoiceDL provider) + BGS loopback
#define PCAP_OUT   DUMPDIR "/ozzu_pcap.pcm"

typedef void* (*get_t)(void);
typedef void* (*getself_t)(void*);
typedef int   (*self_t)(void*);
typedef int   (*self_i_t)(void*, int);
typedef int   (*self_ii_t)(void*, int, int);
typedef void* (*create_t)(void*, unsigned, unsigned, int);
typedef int   (*putdata_t)(void*, void*, char*, int);
typedef int   (*rw_t)(void*, void*, int);
typedef int   (*open_t)(void*, void*, int, int);
typedef int   (*destroy_t)(void*, void*);
typedef int   (*write3_t)(void*, void*, void*, unsigned);
typedef void* (*openin_t)(void*, unsigned, int*, unsigned*, unsigned*, int*, int, unsigned);
typedef int   (*readin_t)(void*, void*, int);   // 32-bit ARM: read(void*, int)

// speech factory / driver
static get_t Fac_Get; static getself_t Fac_GetDrv;
// PCM2Way capture
static self_i_t LAD_On; static self_t LAD_Off;
static get_t Rec_Get; static self_t Rec_Start, Rec_Stop, Rec_Cnt; static rw_t Rec_Read;
// BGS inject
static self_ii_t BGS_Config;     // SpeechDriverLAD::BGSoundConfig(uchar,uchar)
static self_t    BGS_On, BGS_Off;
static self_i_t  LAD_UlSrcMute;  // SpeechDriverLAD::SetUplinkSourceMute(bool) — mute CAT mic
static get_t     SM_Get;         // AudioALSAStreamManager::getInstance
static self_i_t  SM_UlMute, SM_DlMute;
static openin_t  SM_OpenIn;      // openInputStream(devices,fmt,ch,rate,status,acoustics,source)
static readin_t  In_Read;        // AudioALSAStreamIn::read(void*, long)
static self_t    In_Open, In_Close;
static get_t     BP_Get;         // BGSPlayer::GetInstance
static open_t    BP_Open;        // Open(SpeechDriverInterface*, uchar, uchar) -> we pass (drv, a, b)
static create_t  BP_Create;      // CreateBGSPlayBuffer(rate, ch, fmt) -> BGSPlayBuffer*
static putdata_t BP_PutData;     // PutData(buf, char*, ushort)
static write3_t  BP_Write;       // BGSPlayer::Write(buf, void*, uint) — does bit-convert + SRC
static destroy_t BP_Destroy;     // DestroyBGSPlayBuffer(buf)
static self_t    BP_Close;
static int g_resolved = 0;

static int resolve(void) {
    void* h = dlopen(HAL32a, RTLD_NOLOAD | RTLD_NOW);
    if (!h) h = dlopen(HAL32b, RTLD_NOLOAD | RTLD_NOW);
    if (!h) h = dlopen(HAL32a, RTLD_NOW);
    if (!h) { LOGI("dlopen failed: %s", dlerror()); return -1; }
    Fac_Get    = (get_t)    dlsym(h, "_ZN7android19SpeechDriverFactory11GetInstanceEv");
    Fac_GetDrv = (getself_t)dlsym(h, "_ZN7android19SpeechDriverFactory15GetSpeechDriverEv");
    LAD_On     = (self_i_t) dlsym(h, "_ZN7android15SpeechDriverLAD9PCM2WayOnEb");
    LAD_Off    = (self_t)   dlsym(h, "_ZN7android15SpeechDriverLAD10PCM2WayOffEv");
    Rec_Get    = (get_t)    dlsym(h, "_ZN7android10Record2Way11GetInstanceEv");
    Rec_Start  = (self_t)   dlsym(h, "_ZN7android10Record2Way5StartEv");
    Rec_Stop   = (self_t)   dlsym(h, "_ZN7android10Record2Way4StopEv");
    Rec_Cnt    = (self_t)   dlsym(h, "_ZN7android10Record2Way18GetBufferDataCountEv");
    Rec_Read   = (rw_t)     dlsym(h, "_ZN7android10Record2Way4ReadEPvi");
    BGS_Config = (self_ii_t)dlsym(h, "_ZN7android15SpeechDriverLAD13BGSoundConfigEhh");
    BGS_On     = (self_t)   dlsym(h, "_ZN7android15SpeechDriverLAD9BGSoundOnEv");
    BGS_Off    = (self_t)   dlsym(h, "_ZN7android15SpeechDriverLAD10BGSoundOffEv");
    LAD_UlSrcMute = (self_i_t) dlsym(h, "_ZN7android15SpeechDriverLAD19SetUplinkSourceMuteEb");
    SM_Get     = (get_t)    dlsym(h, "_ZN7android22AudioALSAStreamManager11getInstanceEv");
    SM_UlMute  = (self_i_t) dlsym(h, "_ZN7android22AudioALSAStreamManager12setBGSUlMuteEb");
    SM_DlMute  = (self_i_t) dlsym(h, "_ZN7android22AudioALSAStreamManager12setBGSDlMuteEb");
    SM_OpenIn  = (openin_t) dlsym(h, "_ZN7android22AudioALSAStreamManager15openInputStreamEjPiPjS2_S1_20audio_in_acoustics_tj");
    In_Read    = (readin_t) dlsym(h, "_ZN7android17AudioALSAStreamIn4readEPvi");
    In_Open    = (self_t)   dlsym(h, "_ZN7android17AudioALSAStreamIn4openEv");
    In_Close   = (self_t)   dlsym(h, "_ZN7android17AudioALSAStreamIn5closeEv");
    BP_Get     = (get_t)    dlsym(h, "_ZN7android9BGSPlayer11GetInstanceEv");
    BP_Open    = (open_t)   dlsym(h, "_ZN7android9BGSPlayer4OpenEPNS_21SpeechDriverInterfaceEhh");
    BP_Create  = (create_t) dlsym(h, "_ZN7android9BGSPlayer19CreateBGSPlayBufferEjji");
    BP_PutData = (putdata_t)dlsym(h, "_ZN7android9BGSPlayer7PutDataEPNS_13BGSPlayBufferEPct");
    BP_Write   = (write3_t) dlsym(h, "_ZN7android9BGSPlayer5WriteEPNS_13BGSPlayBufferEPvj");
    BP_Destroy = (destroy_t)dlsym(h, "_ZN7android9BGSPlayer20DestroyBGSPlayBufferEPNS_13BGSPlayBufferE");
    BP_Close   = (self_t)   dlsym(h, "_ZN7android9BGSPlayer5CloseEv");
    LOGI("resolve BGS: cfg=%p on=%p SM=%p ulmute=%p bp=%p open=%p create=%p put=%p",
         BGS_Config, BGS_On, SM_Get, SM_UlMute, BP_Get, BP_Open, BP_Create, BP_PutData);
    return (Fac_GetDrv && BGS_On && BP_Get && BP_Create && BP_PutData) ? 0 : -2;
}

static void* get_drv(void) { void* fac = Fac_Get(); return Fac_GetDrv(fac); }

// BGS inject: play loud 1kHz beeps to the UPLINK (remote hears), DL muted (phone silent).
static void run_bgs(int ulGain, int dlGain, int rate, int openA, int openB) {
    void* drv = get_drv();
    LOGI("BGS: drv=%p ul=%d dl=%d rate=%d open=%d,%d", drv, ulGain, dlGain, rate, openA, openB);
    if (!drv) { LOGI("BGS: no drv"); return; }
    if (BGS_Config) BGS_Config(drv, ulGain, dlGain);
    if (BGS_On) LOGI("BGS: BGSoundOn=%d", BGS_On(drv));
    void* mgr = SM_Get ? SM_Get() : NULL;
    if (mgr) { if (SM_UlMute) SM_UlMute(mgr, 0); if (SM_DlMute) SM_DlMute(mgr, 1); LOGI("BGS: UL unmuted, DL muted (mgr=%p)", mgr); }
    void* bp = BP_Get();
    if (BP_Open) LOGI("BGS: Open=%d", BP_Open(bp, drv, openA, openB));
    void* buf = BP_Create ? BP_Create(bp, (unsigned)rate, 1u, 1) : NULL;   // rate, mono, PCM_16_BIT
    LOGI("BGS: bp=%p buf=%p write=%p putdata=%p", bp, buf, BP_Write, BP_PutData);
    if (!buf) { LOGI("BGS: buffer NULL, abort"); if (BGS_Off) BGS_Off(drv); return; }
    usleep(300000);                                       // let modem engage BGS before feeding
    int16_t frame[160];
    double ph = 0, st = 2.0 * M_PI * 1000.0 / (double)rate;
    long wrote = 0; int r0 = -99, r1 = -99, r2 = -99;
    for (int blk = 0; blk < 300; blk++) {                // 6s
        int on = ((blk % 30) < 20);
        for (int s = 0; s < 160; s++) { frame[s] = on ? (int16_t)(26000.0 * sin(ph)) : 0; ph += st; if (ph > 2*M_PI) ph -= 2*M_PI; }
        int w = -99;
        if (BP_Write) w = BP_Write(bp, buf, frame, (unsigned)sizeof(frame));
        else if (BP_PutData) w = BP_PutData(bp, buf, (char*)frame, (int)sizeof(frame));
        if (blk == 0) r0 = w; else if (blk == 1) r1 = w; else if (blk == 2) r2 = w;
        if (w > 0) wrote += w;
        usleep(20000);
    }
    LOGI("BGS: wrote=%ld firstRets=%d,%d,%d", wrote, r0, r1, r2);
    if (BP_Destroy) BP_Destroy(bp, buf);
    if (BP_Close) BP_Close(bp);
    if (mgr && SM_UlMute) SM_UlMute(mgr, 1);
    if (BGS_Off) BGS_Off(drv);
    LOGI("BGS done");
}

// Capture the CALLER via an in-HAL input stream (bypasses framework policy block).
// source: 3=VOICE_DOWNLINK (caller only), 4=VOICE_CALL (UL+DL mix), 2=VOICE_UPLINK (mic)
static void run_capture(int source, int rate, unsigned dev) {
    void* mgr = SM_Get ? SM_Get() : NULL;
    if (!mgr || !SM_OpenIn || !In_Read) { LOGI("CAP: missing openInput symbols (mgr=%p open=%p read=%p)", mgr, SM_OpenIn, In_Read); return; }
    int fmt = 1;                       // AUDIO_FORMAT_PCM_16_BIT
    unsigned ch = 0x10u;               // AUDIO_CHANNEL_IN_MONO
    unsigned r = (unsigned)rate;
    int status = -1;
    void* in = SM_OpenIn(mgr, dev, &fmt, &ch, &r, &status, 0, (unsigned)source);
    LOGI("CAP openInput: in=%p status=%d fmt=%d ch=0x%x rate=%u src=%d dev=0x%x", in, status, fmt, ch, r, source, dev);
    if (!in) { LOGI("CAP: openInputStream NULL"); return; }
    if (In_Open) LOGI("CAP: open=%d", In_Open(in));
    FILE* f = fopen(CAP_OUT, "wb");
    char buf[2048]; long total = 0; long target = (long)(r ? r : 8000) * 2 * 8;  // ~8s
    int iters = 0;
    while (total < target && iters < 1000) {
        int n = In_Read(in, buf, (int)sizeof(buf));
        if (n > 0) { if (f) fwrite(buf, 1, (size_t)n, f); total += n; }
        else usleep(10000);
        iters++;
    }
    if (f) fclose(f);
    LOGI("CAP: total=%ld iters=%d (src=%d rate=%u)", total, iters, source, r);
    if (In_Close) In_Close(in);
}

// Live loopback: pipe the DOWNLINK (caller) straight to BGS uplink so the caller hears
// themselves. Validates capture+inject together, in real time, before wiring to June.
static void run_loopback(int ulGain, int durSec, int mode) {
    void* mgr = SM_Get ? SM_Get() : NULL;
    if (!mgr || !SM_OpenIn || !In_Read || !BP_Get || !BP_Create || !BP_Write) { LOGI("LOOP: missing symbols"); return; }
    int fmt = 1; unsigned ch = 0x10u, r = 48000; int status = -1;
    void* in = SM_OpenIn(mgr, 0x80000040u, &fmt, &ch, &r, &status, 0, 3);  // VOICE_DOWNLINK 48k
    if (!in) { LOGI("LOOP: capture open NULL status=%d", status); return; }
    if (In_Open) In_Open(in);
    void* drv = get_drv();
    if (BGS_Config) BGS_Config(drv, ulGain, 0);
    if (BGS_On) BGS_On(drv);
    if (SM_UlMute) SM_UlMute(mgr, 0);
    if (SM_DlMute) SM_DlMute(mgr, 1);
    if (LAD_UlSrcMute) LAD_UlSrcMute(drv, 1);   // mute CAT mic: caller hears only the bridge
    void* bp = BP_Get();
    if (BP_Open) BP_Open(bp, drv, 0, 0);
    void* buf = BP_Create(bp, 8000u, 1u, 1);   // BGS at 8k (proven); average capture 48k->8k
    LOGI("LOOP: in=%p capRate=%u bp=%p buf=%p ulGain=%d dur=%d mode=%d (BGS@8k avg/6 x3)", in, r, bp, buf, ulGain, durSec, mode);
    if (!buf) { if (BGS_Off) BGS_Off(drv); if (In_Close) In_Close(in); return; }
    FILE* dbg = fopen(DUMPDIR "/ozzu_loop_cap.pcm", "wb");   // raw 48k capture during loopback
    char cbuf[4096]; int16_t sbuf[1024]; long total = 0, written = 0; long target = (long)durSec * (long)r * 2;
    double ph = 0, st = 2.0 * M_PI * 1000.0 / 8000.0;   // for mode=1 beep-while-capturing
    LOGI("LOOP: mode=%d (0=echo your voice, 1=beep while capture open)", mode);
    while (total < target) {
        int n = In_Read(in, cbuf, (int)sizeof(cbuf));
        if (n > 0) {
            if (dbg) fwrite(cbuf, 1, (size_t)n, dbg);
            int outn = 0;
            if (mode == 1) {                                // clean loud beep, capture still open
                int want = n / 12; if (want > 1024) want = 1024;
                for (int i = 0; i < want; i++) { sbuf[i] = (int16_t)(26000.0 * sin(ph)); ph += st; if (ph > 2*M_PI) ph -= 2*M_PI; }
                outn = want;
            } else {                                        // echo: 48k->8k average + 3x boost
                int16_t* src = (int16_t*)cbuf; int nsamp = n / 2;
                for (int i = 0; i + 5 < nsamp && outn < 1024; i += 6) {
                    int sum = 0; for (int j = 0; j < 6; j++) sum += src[i + j];
                    int v = (sum / 6) * 3;
                    if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
                    sbuf[outn++] = (int16_t)v;
                }
            }
            if (outn > 0) { int w = BP_Write(bp, buf, sbuf, (unsigned)(outn * 2)); if (w > 0) written += w; }
            total += n;
            if ((total / (int)sizeof(cbuf)) % 80 == 0) {   // ~every 1.7s: re-assert BGS in case capture knocked it down
                if (BGS_On) BGS_On(drv);
                if (SM_UlMute) SM_UlMute(mgr, 0);
                if (SM_DlMute) SM_DlMute(mgr, 1);
            }
        } else usleep(5000);
    }
    if (dbg) fclose(dbg);
    LOGI("LOOP: capturedDL=%ld bytes, BGSwrote=%ld bytes", total, written);
    if (BP_Destroy) BP_Destroy(bp, buf);
    if (BP_Close) BP_Close(bp);
    if (LAD_UlSrcMute) LAD_UlSrcMute(drv, 0);   // unmute CAT mic
    if (SM_UlMute) SM_UlMute(mgr, 1);
    if (BGS_Off) BGS_Off(drv);
    if (In_Close) In_Close(in);
    LOGI("LOOP done");
}

// ===== PASSIVE CAPTURE via inline-hooking the VoiceDL provider's record-data path =====
// RingBuf layout (from RingBuf_getDataCount/copyToLinear disasm): {+0 pBufBase, +4 pRead, +8 pWrite, +12 pad, +16 size}
struct ozzu_ring { char* base; char* rd; char* wr; uint32_t pad; uint32_t size; };
typedef int  (*ringcnt_t)(void*);                 // RingBuf_getDataCount(const RingBuf*)
typedef int  (*ringcopy_t)(void*, void*, int);    // RingBuf_copyFromRingBuf(dst, src, count)
typedef int  (*ringlin_t)(char*, void*, int);     // RingBuf_copyToLinear(dst, src, count)
typedef void (*provide_t)(void*, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t);  // (this, RingBuf-by-value=5 words)
static ringcnt_t  RB_Count;
static ringcopy_t RB_CopyFrom;
static ringlin_t  RB_ToLinear;
static provide_t  g_tramp = NULL;                 // trampoline -> original provideModemRecordDataToProvider

#define PCAP_CAP (48000 * 2 * 4)                  // 4s of 48k mono S16LE
static char g_pcap_buf[PCAP_CAP];                 // PLAIN SPSC circular: hook writes (g_widx), consumer reads (g_ridx)
static volatile int g_widx = 0, g_ridx = 0;
static volatile int g_pcap_on = 0;
static volatile long g_hook_calls = 0, g_hook_bytes = 0;

// The hook: provider pushes the raw DOWNLINK record RingBuf by value. Extract it to linear via the
// HAL helper (on a COPY so the original's read ptr is untouched), append to our own plain circular
// buffer, then fall through to the original via the trampoline so the normal HAL flow continues.
static void ozzu_record_hook(void* thiz, uint32_t w0, uint32_t w1, uint32_t w2, uint32_t w3, uint32_t w4) {
    if (g_pcap_on && RB_Count && RB_ToLinear) {
        struct ozzu_ring src; src.base=(char*)w0; src.rd=(char*)w1; src.wr=(char*)w2; src.pad=w3; src.size=w4;
        int cnt = RB_Count(&src);
        g_hook_calls++;
        if (cnt > 0) {
            // Read cnt bytes directly from the src ring [rd..wr) with wrap, into our plain buffer.
            // (cnt comes from RB_getDataCount which is wrap-aware; rd/base/size from the by-value struct.)
            char* base = src.base; char* rd = src.rd; int sz = (int)src.size;
            int w = g_widx;
            for (int i = 0; i < cnt; i++) {
                g_pcap_buf[w] = *rd;
                if (++w >= PCAP_CAP) w = 0;
                if (++rd >= base + sz) rd = base;
            }
            __sync_synchronize();
            g_widx = w;
            g_hook_bytes += cnt;
        }
    }
    if (g_tramp) g_tramp(thiz, w0, w1, w2, w3, w4);
}

// Inline-hook an ARM function: patch first 8 bytes (push;sub sp — position-independent) with a
// jump to our hook; build a trampoline = [saved 8 bytes][ldr pc,[pc,#-4]][orig+8] to reach the body.
static void* hook_install(void* target, void* hookfn) {
    uint32_t* t = (uint32_t*)target;
    // Trampoline: W^X — map RW, write, then flip to R+X (avoids RWX which hal_audio SELinux may deny).
    void* tramp = mmap(NULL, 32, PROT_READ|PROT_WRITE, MAP_PRIVATE|MAP_ANONYMOUS, -1, 0);
    if (tramp == MAP_FAILED) { LOGI("PCAP: tramp mmap failed errno=%d", errno); return NULL; }
    uint32_t* tr = (uint32_t*)tramp;
    tr[0] = t[0]; tr[1] = t[1]; tr[2] = 0xe51ff004u; tr[3] = (uint32_t)target + 8;   // [orig insn0][orig insn1][ldr pc,[pc,#-4]][orig+8]
    if (mprotect(tramp, 32, PROT_READ|PROT_EXEC) != 0) { LOGI("PCAP: tramp mprotect RX failed errno=%d (execmem denied?)", errno); return NULL; }
    __builtin___clear_cache((char*)tramp, (char*)tramp + 32);
    // Patch target: make text page writable, write the jump, restore R+X.
    uintptr_t pa = (uintptr_t)target & ~0xFFFu;
    if (mprotect((void*)pa, 0x2000, PROT_READ|PROT_WRITE) != 0) { LOGI("PCAP: text mprotect RW failed errno=%d (execmod denied?)", errno); return NULL; }
    t[0] = 0xe51ff004u; t[1] = (uint32_t)hookfn;   // ldr pc,[pc,#-4]; hookfn (ldr-pc interworks ARM/Thumb)
    if (mprotect((void*)pa, 0x2000, PROT_READ|PROT_EXEC) != 0) LOGI("PCAP: text mprotect RX-restore failed errno=%d", errno);
    __builtin___clear_cache((char*)target, (char*)target + 8);
    LOGI("PCAP: hook installed target=%p hookfn=%p tramp=%p", target, hookfn, tramp);
    return tramp;
}

// PASSIVE capture: open the VoiceDL provider (feeds the record path WITHOUT StreamIn routing),
// hook its provideModemRecordDataToProvider to grab the caller's downlink, BGS-inject it back.
static void run_passive_capture(int ulGain, int durSec, int mode) {
    void* h = dlopen(HAL32a, RTLD_NOLOAD|RTLD_NOW); if (!h) h = dlopen(HAL32b, RTLD_NOLOAD|RTLD_NOW);
    if (!h) { LOGI("PCAP: dlopen failed"); return; }
    get_t  VDL_Get   = (get_t) dlsym(h, "_ZN7android35AudioALSACaptureDataProviderVoiceDL11getInstanceEv");
    self_t VDL_Open  = (self_t)dlsym(h, "_ZN7android35AudioALSACaptureDataProviderVoiceDL4openEv");
    self_t VDL_Close = (self_t)dlsym(h, "_ZN7android35AudioALSACaptureDataProviderVoiceDL5closeEv");
    void*  hooktgt   = dlsym(h, "_ZN7android35AudioALSACaptureDataProviderVoiceDL32provideModemRecordDataToProviderENS_7RingBufE");
    RB_Count    = (ringcnt_t) dlsym(h, "_ZN7android20RingBuf_getDataCountEPKNS_7RingBufE");
    RB_CopyFrom = (ringcopy_t)dlsym(h, "_ZN7android23RingBuf_copyFromRingBufEPNS_7RingBufES1_i");
    RB_ToLinear = (ringlin_t) dlsym(h, "_ZN7android20RingBuf_copyToLinearEPcPNS_7RingBufEi");
    if (!VDL_Get || !hooktgt || !RB_Count || !RB_CopyFrom || !RB_ToLinear) {
        LOGI("PCAP: missing syms vdl=%p tgt=%p cnt=%p cp=%p lin=%p", VDL_Get, hooktgt, RB_Count, RB_CopyFrom, RB_ToLinear); return;
    }
    g_widx = 0; g_ridx = 0;
    g_hook_calls = 0; g_hook_bytes = 0;
    if (!g_tramp) g_tramp = (provide_t)hook_install(hooktgt, (void*)ozzu_record_hook);
    if (!g_tramp) { LOGI("PCAP: hook install failed"); return; }
    void* vdl = VDL_Get();
    // BGS inject setup FIRST + engage (mirror run_bgs, which produced AUDIBLE BGS), THEN start record.
    void* drv = get_drv();
    if (BGS_Config) BGS_Config(drv, ulGain, 0);
    if (BGS_On) BGS_On(drv);
    void* mgr = SM_Get ? SM_Get() : NULL;
    if (SM_UlMute) SM_UlMute(mgr, 0);
    if (SM_DlMute) SM_DlMute(mgr, 1);
    if (LAD_UlSrcMute) LAD_UlSrcMute(drv, 1);          // mute CAT mic only (MSG_A2M_MUTE_SPH_UL_SOURCE); BGS stays
    void* bp = BP_Get(); if (BP_Open) BP_Open(bp, drv, 0, 0);
    void* buf = BP_Create(bp, 8000u, 1u, 1);
    usleep(300000);                                    // let the modem ENGAGE BGS before the record starts
    int oret = VDL_Open ? VDL_Open(vdl) : -1;          // start DL record -> feeds the hook
    g_pcap_on = 1;
    LOGI("PCAP: vdl=%p open=%d hooktgt=%p tramp=%p bp=%p buf=%p ulGain=%d dur=%d mode=%d", vdl, oret, hooktgt, g_tramp, bp, buf, ulGain, durSec, mode);
    if (!buf) { g_pcap_on = 0; if (BGS_Off) BGS_Off(drv); if (VDL_Close) VDL_Close(vdl); return; }
    FILE* dbg = fopen(PCAP_OUT, "wb");
    char tmp[4096]; int16_t sbuf[1024];   // 4096B = 2048 samp @16k -> /2 -> 1024 samp @8k
    long total = 0, written = 0; long target = (long)durSec * 48000 * 2;
    double ph = 0, stp = 2.0 * M_PI * 1000.0 / 8000.0;
    for (int it = 0; it < durSec * 400 && total < target; it++) {
        int w = g_widx, r = g_ridx;
        int avail = w - r; if (avail < 0) avail += PCAP_CAP;
        if (avail >= (int)sizeof(tmp)) {
            int n = (int)sizeof(tmp);
            for (int i = 0; i < n; i++) { tmp[i] = g_pcap_buf[r]; if (++r >= PCAP_CAP) r = 0; }
            g_ridx = r;
            if (n > 0) {
                if (dbg) fwrite(tmp, 1, (size_t)n, dbg);
                int outn = 0;
                if (mode == 1) {                                       // beep while capture flows (diagnostic)
                    int want = n / 4; if (want > 1024) want = 1024;    // n bytes @16k -> n/4 samp @8k
                    for (int i = 0; i < want; i++) { sbuf[i] = (int16_t)(26000.0 * sin(ph)); ph += stp; if (ph > 2*M_PI) ph -= 2*M_PI; }
                    outn = want;
                } else {                                               // echo caller: 16k->8k avg /2 + 3x boost
                    int16_t* s = (int16_t*)tmp; int ns = n / 2;
                    for (int i = 0; i + 1 < ns && outn < 1024; i += 2) {
                        int v = ((s[i] + s[i + 1]) / 2) * 3;
                        if (v > 32767) v = 32767; else if (v < -32768) v = -32768;
                        sbuf[outn++] = (int16_t)v;
                    }
                }
                if (outn > 0) { int w = BP_Write(bp, buf, sbuf, (unsigned)(outn * 2)); if (w > 0) written += w; }
                total += n;
            }
        } else usleep(2500);
    }
    if (dbg) fclose(dbg);
    g_pcap_on = 0;
    LOGI("PCAP: hookCalls=%ld hookBytes=%ld captured=%ld BGSwrote=%ld", g_hook_calls, g_hook_bytes, total, written);
    if (BP_Destroy) BP_Destroy(bp, buf);
    if (BP_Close) BP_Close(bp);
    if (LAD_UlSrcMute) LAD_UlSrcMute(drv, 0);          // unmute CAT mic
    if (SM_UlMute) SM_UlMute(mgr, 1);
    if (BGS_Off) BGS_Off(drv);
    if (VDL_Close) VDL_Close(vdl);
    LOGI("PCAP done");
}

static void* ozzu_thread(void* a) {
    (void)a;
    LOGI("ozzu_thread start, pid=%d", getpid());
    long lastBeep = 0, lastCap = 0, lastLoop = 0, lastPcap = 0;
    struct stat stt;
    // Ignore any STALE triggers present at startup (prevents double-fire / boot-fire):
    if (stat(BEEP_TRIG, &stt) == 0) lastBeep = stt.st_mtime;
    if (stat(CAP_TRIG,  &stt) == 0) lastCap  = stt.st_mtime;
    if (stat(LOOP_TRIG, &stt) == 0) lastLoop = stt.st_mtime;
    if (stat(PCAP_TRIG, &stt) == 0) lastPcap = stt.st_mtime;
    for (;;) {
        if (stat(BEEP_TRIG, &stt) == 0 && stt.st_mtime != lastBeep) {
            lastBeep = stt.st_mtime;
            if (!g_resolved) { g_resolved = (resolve() == 0); LOGI("resolve -> %s", g_resolved ? "OK" : "FAIL"); }
            if (g_resolved) {
                int ul = 4, dl = 0, rate = 8000, oa = 0, ob = 0;       // defaults
                FILE* tf = fopen(BEEP_TRIG, "r");
                if (tf) { if (fscanf(tf, "%d %d %d %d %d", &ul, &dl, &rate, &oa, &ob) < 3) { } fclose(tf); }
                run_bgs(ul, dl, rate, oa, ob);
            }
        }
        if (stat(CAP_TRIG, &stt) == 0 && stt.st_mtime != lastCap) {
            lastCap = stt.st_mtime;
            if (!g_resolved) { g_resolved = (resolve() == 0); LOGI("resolve -> %s", g_resolved ? "OK" : "FAIL"); }
            if (g_resolved) {
                int src = 3, rate = 8000, devsel = 1;   // VOICE_DOWNLINK; dev=VOICE_CALL(0x80000040)
                FILE* tf = fopen(CAP_TRIG, "r");
                if (tf) { if (fscanf(tf, "%d %d %d", &src, &rate, &devsel) < 1) {} fclose(tf); }
                unsigned dev = (devsel == 0) ? 0x80000004u : (devsel == 2) ? 0u : 0x80000040u;
                run_capture(src, rate, dev);
            }
        }
        if (stat(LOOP_TRIG, &stt) == 0 && stt.st_mtime != lastLoop) {
            lastLoop = stt.st_mtime;
            if (!g_resolved) { g_resolved = (resolve() == 0); LOGI("resolve -> %s", g_resolved ? "OK" : "FAIL"); }
            if (g_resolved) {
                int ul = 160, dur = 15, mode = 0;
                FILE* tf = fopen(LOOP_TRIG, "r");
                if (tf) { if (fscanf(tf, "%d %d %d", &ul, &dur, &mode) < 1) {} fclose(tf); }
                run_loopback(ul, dur, mode);
            }
        }
        if (stat(PCAP_TRIG, &stt) == 0 && stt.st_mtime != lastPcap) {
            lastPcap = stt.st_mtime;
            if (!g_resolved) { g_resolved = (resolve() == 0); LOGI("resolve -> %s", g_resolved ? "OK" : "FAIL"); }
            if (g_resolved) {
                int ul = 200, dur = 12, mode = 0;
                FILE* tf = fopen(PCAP_TRIG, "r");
                if (tf) { if (fscanf(tf, "%d %d %d", &ul, &dur, &mode) < 1) {} fclose(tf); }
                run_passive_capture(ul, dur, mode);
            }
        }
        usleep(300000);
    }
    return NULL;
}

__attribute__((constructor))
static void ozzu_init(void) {
    __android_log_print(ANDROID_LOG_INFO, TAG, "libozzubridge loaded into pid=%d", getpid());
    pthread_t t;
    if (pthread_create(&t, NULL, ozzu_thread, NULL) == 0) pthread_detach(t);
}
