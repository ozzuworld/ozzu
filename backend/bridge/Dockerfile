FROM node:22-slim

# System packages: Docker CLI, curl, git, Python 3, ExifTool, PrusaSlicer
# (PrusaSlicer needed in-container so /octoprint/print can slice locally;
#  removed dev-01 SSH dependency 2026-05-10 — dir_1778425211161)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git git-lfs git-crypt unzip ca-certificates \
    python3 python3-pip python3-venv libimage-exiftool-perl \
    openssh-client prusa-slicer && \
    rm -rf /var/lib/apt/lists/*

# Python OSINT tools in isolated venv (light — heavy tools live in osint-tools container)
RUN python3 -m venv /opt/osint-venv --system-site-packages && \
    /opt/osint-venv/bin/pip install --no-cache-dir \
    maigret holehe h8mail

# PhoneInfoga Go binary (single static file, zero deps)
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then GOARCH="x86_64"; else GOARCH="$ARCH"; fi && \
    curl -sSL "https://github.com/sundowndev/phoneinfoga/releases/latest/download/phoneinfoga_Linux_${GOARCH}.tar.gz" \
    | tar xz -C /usr/local/bin phoneinfoga && \
    chmod +x /usr/local/bin/phoneinfoga

# ADB (Android Debug Bridge) for fleet device management
RUN curl -sL https://dl.google.com/android/repository/platform-tools-latest-linux.zip -o /tmp/pt.zip && \
    unzip -o /tmp/pt.zip -d /tmp/ && \
    cp /tmp/platform-tools/adb /usr/local/bin/adb && \
    chmod +x /usr/local/bin/adb && \
    rm -rf /tmp/pt.zip /tmp/platform-tools

WORKDIR /app
