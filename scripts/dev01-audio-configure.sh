#!/usr/bin/env bash
# dev-01 audio production setup — Reaper + PipeWire low-latency for TASCAM US-4x4HR.
# Idempotent — re-run to apply config changes.
# Directive: dir_1777212436024
#
# Hardware expected on dev-01:
#   - TASCAM US-4x4HR (USB audio interface, 4 in / 4 out, class-compliant)
# Hardware King Kazuma plugs into the interface:
#   - AT2035 mic       -> input 1 (XLR, +48V phantom)
#   - AP460 piano L/R  -> inputs 2 & 3 (1/4" TRS line)
#   - tablet 3.5mm     -> input 4 (via 3.5mm -> 1/4" TRS adapter)
#   - ATH-R50x         -> headphone out (front panel)
# Direct monitoring is hardware-side: front-panel MIX MONITOR knob blends inputs vs USB.

set -euo pipefail

# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd)/lib/infra.sh"

REAPER_VER="769"
REAPER_TGZ="reaper${REAPER_VER}_linux_x86_64.tar.xz"
REAPER_URL="https://www.reaper.fm/files/7.x/${REAPER_TGZ}"
SUDO_PASS="${HADMIN_SUDO_PASS:?HADMIN_SUDO_PASS not set; copy infra/secrets.example to \$HOME/.ozzu-secrets and fill in}"

ssh_sudo() { ssh dev-01 "echo '$SUDO_PASS' | sudo -S bash -c '$1'"; }

echo "=== 1. Verify TASCAM US-4x4HR is connected ==="
ssh dev-01 'grep -qi us-4x4 /proc/asound/cards' || {
  echo "TASCAM US-4x4HR not detected on dev-01. Plug it in and re-run." >&2
  exit 1
}
ssh dev-01 'cat /proc/asound/cards | grep -A1 -i us-4x4'

echo
echo "=== 2. Add hadmin to audio + realtime groups ==="
ssh_sudo '
  getent group realtime >/dev/null || groupadd realtime
  usermod -aG audio,realtime hadmin
'
ssh dev-01 'id hadmin | tr "," "\n" | grep -E "audio|realtime"'

echo
echo "=== 3. Install /etc/security/limits.d/95-audio.conf (rtprio + memlock) ==="
ssh_sudo "cat > /etc/security/limits.d/95-audio.conf <<'LIMITS'
@audio     - rtprio      95
@audio     - memlock     unlimited
@audio     - nice       -19
@realtime  - rtprio      95
@realtime  - memlock     unlimited
LIMITS"
ssh dev-01 'cat /etc/security/limits.d/95-audio.conf'

echo
echo "=== 4. PipeWire low-latency drop-in (~/.config/pipewire/pipewire.conf.d) ==="
ssh dev-01 "mkdir -p ~/.config/pipewire/pipewire.conf.d && cat > ~/.config/pipewire/pipewire.conf.d/10-low-latency.conf <<'PWCONF'
context.properties = {
    default.clock.rate          = 48000
    default.clock.allowed-rates = [ 44100 48000 88200 96000 ]
    default.clock.quantum       = 256
    default.clock.min-quantum   = 128
    default.clock.max-quantum   = 1024
}
PWCONF"

echo
echo "=== 5. Restart PipeWire user services to apply quantum ==="
ssh dev-01 'systemctl --user restart pipewire pipewire-pulse wireplumber || true'
sleep 2
ssh dev-01 'pw-metadata -n settings 0 2>/dev/null | grep -E "clock\\.(rate|quantum)" || echo "(metadata read failed — pw-metadata may need a graphical session)"'

echo
echo "=== 6. Install Reaper to /opt/REAPER ==="
if ssh dev-01 'test -x /opt/REAPER/reaper'; then
  echo "Reaper already installed at /opt/REAPER — skipping download"
else
  ssh dev-01 "
    cd /tmp
    [ -f $REAPER_TGZ ] || curl -fsSL '$REAPER_URL' -o $REAPER_TGZ
    [ -d reaper_linux_x86_64 ] || tar -xf $REAPER_TGZ
  "
  ssh_sudo "cd /tmp/reaper_linux_x86_64 && ./install-reaper.sh --install /opt --integrate-desktop --usr-local-bin-symlink --quiet"
fi
ssh dev-01 'ls -la /usr/local/bin/reaper 2>/dev/null; /opt/REAPER/reaper -version 2>&1 | head -2 || true'

echo
echo "=== 7. Install Ardour (free DAW, fallback / alternative) ==="
ssh_sudo 'DEBIAN_FRONTEND=noninteractive apt-get install -y ardour'
ssh dev-01 'ardour --version 2>&1 | head -1 || true'

echo
echo "=== 8. Verify TASCAM is visible to PipeWire ==="
ssh dev-01 '
  echo "--- ALSA cards ---"
  cat /proc/asound/cards | grep -i us-4x4 || echo "TASCAM not in ALSA"
  echo "--- PipeWire sinks (output) ---"
  pactl list short sinks 2>/dev/null | grep -i us-4x4 || echo "(no PW sink visible — may need graphical session)"
  echo "--- PipeWire sources (input) ---"
  pactl list short sources 2>/dev/null | grep -i us-4x4 || echo "(no PW source visible)"
'

echo
echo "=== Done ==="
echo
echo "King Kazuma manual steps:"
echo "  1. Log out of dev-01 desktop session and log back in (picks up audio + realtime groups)."
echo "  2. Plug cables: AT2035->in1+48V, piano L/R->in2+3, tablet->in4, ATH-R50x->phones."
echo "  3. Launch Reaper from desktop or 'reaper' on the command line."
echo "  4. Reaper > Options > Preferences > Audio > Device: choose ALSA or JACK"
echo "     - Recommended: PipeWire's JACK shim ('pw-jack reaper' if needed)."
echo "     - Buffer 256 samples / 48 kHz to match the PipeWire config."
echo "  5. Set MIX MONITOR knob on the TASCAM: blend inputs vs computer playback to taste."
