# OSINT CLI Tools Container
# Runs idle — bridge calls tools via `docker exec osint-tools <command>`
FROM python:3.11-slim

# System packages
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    wget \
    unzip \
    git \
    libimage-exiftool-perl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Python OSINT tools
RUN pip install --no-cache-dir \
    maigret \
    holehe \
    h8mail \
    theHarvester

# PhoneInfoga — Go pre-built binary from GitHub releases
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then PIF_ARCH="linux_amd64"; \
    elif [ "$ARCH" = "arm64" ]; then PIF_ARCH="linux_arm64"; \
    else PIF_ARCH="linux_amd64"; fi && \
    curl -sL "https://github.com/sundowndev/phoneinfoga/releases/latest/download/phoneinfoga_${PIF_ARCH}.tar.gz" | \
    tar xz -C /usr/local/bin phoneinfoga && \
    chmod +x /usr/local/bin/phoneinfoga || echo "PhoneInfoga install failed — will be unavailable"

# Amass — Go pre-built binary
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then AMASS_ARCH="linux_amd64"; \
    elif [ "$ARCH" = "arm64" ]; then AMASS_ARCH="linux_arm64"; \
    else AMASS_ARCH="linux_amd64"; fi && \
    curl -sL "https://github.com/owasp-amass/amass/releases/latest/download/amass_${AMASS_ARCH}.zip" -o /tmp/amass.zip && \
    unzip -j /tmp/amass.zip '*/amass' -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/amass && \
    rm /tmp/amass.zip || echo "Amass install failed — will be unavailable"

# Nuclei — Go pre-built binary
RUN ARCH=$(dpkg --print-architecture) && \
    if [ "$ARCH" = "amd64" ]; then NUC_ARCH="linux_amd64"; \
    elif [ "$ARCH" = "arm64" ]; then NUC_ARCH="linux_arm64"; \
    else NUC_ARCH="linux_amd64"; fi && \
    curl -sL "https://github.com/projectdiscovery/nuclei/releases/latest/download/nuclei_$(curl -s https://api.github.com/repos/projectdiscovery/nuclei/releases/latest | grep tag_name | cut -d'"' -f4 | tr -d v)_${NUC_ARCH}.zip" -o /tmp/nuclei.zip && \
    unzip /tmp/nuclei.zip nuclei -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/nuclei && \
    rm /tmp/nuclei.zip && \
    nuclei -update-templates || echo "Nuclei install failed — will be unavailable"

# Shared data volume mount point
RUN mkdir -p /tmp/osint-data

WORKDIR /tmp/osint-data

# Run idle — bridge calls via docker exec
CMD ["tail", "-f", "/dev/null"]
