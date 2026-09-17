FROM node:22-slim

# System packages: Docker CLI, curl, git, Python 3, ExifTool, PrusaSlicer, ffmpeg
# (PrusaSlicer needed in-container so /octoprint/print can slice locally;
#  removed dev-01 SSH dependency 2026-05-10 — dir_1778425211161)
# (ffmpeg needed in-container for the print-camera recorder to encode MJPEG → MP4
#  locally; removed dev-01 SSH dependency 2026-05-10 — dir_1778450259617)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git git-lfs git-crypt unzip ca-certificates \
    python3 python3-pip python3-venv libimage-exiftool-perl \
    openssh-client prusa-slicer ffmpeg \
    nmap net-tools iproute2 iputils-ping dnsutils netcat-openbsd \
    whatweb gobuster proxychains4 \
    libnet-ssleay-perl libio-socket-ssl-perl libxml-writer-perl libnet-dns-perl && \
    rm -rf /var/lib/apt/lists/*
# nikto: DROPPED from Debian bookworm apt ("Unable to locate package nikto" — broke every
# image rebuild after the base left bullseye; the live image survived only because it was
# never rebuilt). Installed from the upstream git clone instead. The perl modules above are
# its runtime deps: XML::Writer was the loud one ("Required module not found" at -Version),
# Net::SSLeay/IO::Socket::SSL for https targets, Net::DNS for name resolution.
RUN git clone --depth 1 https://github.com/sullo/nikto /opt/nikto && \
    ln -sf /opt/nikto/program/nikto.pl /usr/local/bin/nikto
# SOC offense toolkit (nmap/net-tools/iproute2/iputils/dnsutils/netcat/whatweb) — the bridge is the
# toolkit host (2026-06-23): SOC execution runs LOCAL here, routing the lab /24 via wg0 → tablet
# relay → EDIFICIO. dev-01 is OUT of the offense pipeline (host-networked → wg0 already routes it).
# whatweb (web-tech fingerprint) added 2026-06-23 after live install to fix web-scan gap.

# SOC offense vuln-research layer (Phase 1, 2026-06-23): nuclei (CVE template scans) + searchsploit
# (ExploitDB) + httpx (ProjectDiscovery HTTP prober). Mapping a discovered service version → CVE →
# exploit is the field's #1 missing capability — it turns "enumerate" into "exploit".
# httpx installed live too for immediate use; this bakes it durably on the next image rebuild.
RUN curl -sL https://github.com/projectdiscovery/nuclei/releases/download/v3.9.0/nuclei_3.9.0_linux_amd64.zip -o /tmp/nuclei.zip && \
    unzip -oq /tmp/nuclei.zip nuclei -d /usr/local/bin/ && chmod +x /usr/local/bin/nuclei && rm /tmp/nuclei.zip && \
    curl -sL https://github.com/projectdiscovery/httpx/releases/download/v1.9.0/httpx_1.9.0_linux_amd64.zip -o /tmp/httpx.zip && \
    unzip -oq /tmp/httpx.zip httpx -d /usr/local/bin/ && chmod +x /usr/local/bin/httpx && rm /tmp/httpx.zip && \
    git clone --depth 1 https://gitlab.com/exploit-database/exploitdb.git /opt/exploitdb && \
    ln -sf /opt/exploitdb/searchsploit /usr/local/bin/searchsploit && \
    git clone --depth 1 https://github.com/HackTricks-wiki/hacktricks.git /opt/hacktricks && \
    git clone --depth 1 https://github.com/swisskyrepo/PayloadsAllTheThings.git /opt/payloads

# Python OSINT tools in isolated venv (light — heavy tools live in osint-tools container)
# Symlinks into /usr/local/bin: without them maigret/holehe/h8mail are invisible to PATH —
# every SOC shell step doing `command -v maigret` failed even on fresh builds (dir_1789633186984).
RUN python3 -m venv /opt/osint-venv --system-site-packages && \
    /opt/osint-venv/bin/pip install --no-cache-dir \
    maigret holehe h8mail && \
    for b in maigret holehe h8mail; do ln -sf /opt/osint-venv/bin/$b /usr/local/bin/$b; done

# PhoneInfoga Go binary (single static file, zero deps)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then GOARCH="x86_64"; else GOARCH="$ARCH"; fi && \
    curl -sSL "https://github.com/sundowndev/phoneinfoga/releases/latest/download/phoneinfoga_Linux_${GOARCH}.tar.gz" \
    | tar xz -C /usr/local/bin phoneinfoga && \
    chmod +x /usr/local/bin/phoneinfoga

# ADB (Android Debug Bridge) for fleet device management.
# Install the full platform-tools dir to /opt so the bundled libc++.so in lib64/
# resolves at runtime; the prior "copy adb only" recipe broke as soon as adb
# started dynamically linking libc++.so from its own bundle (dir_1780756261315).
RUN curl -sL https://dl.google.com/android/repository/platform-tools-latest-linux.zip -o /tmp/pt.zip && \
    unzip -oq /tmp/pt.zip -d /opt/ && \
    ln -sf /opt/platform-tools/adb /usr/local/bin/adb && \
    echo "/opt/platform-tools/lib64" > /etc/ld.so.conf.d/platform-tools.conf && \
    ldconfig && \
    rm /tmp/pt.zip

WORKDIR /app
