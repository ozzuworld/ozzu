FROM node:22-slim

# System packages: Docker CLI, curl, git, Python 3, ExifTool
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git git-lfs git-crypt unzip ca-certificates \
    python3 python3-pip python3-venv libimage-exiftool-perl && \
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

WORKDIR /app
