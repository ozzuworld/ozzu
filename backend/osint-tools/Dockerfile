# OSINT CLI Tools Container
# Runs idle — bridge calls tools via `docker exec osint-tools <command>`
FROM python:3.12-slim

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
    sherlock-project \
    dnstwist

# theHarvester — install from git (PyPI package is broken/empty)
RUN pip install --no-cache-dir git+https://github.com/laramies/theHarvester.git || \
    echo "theHarvester install failed — will be unavailable"

# PhoneInfoga — Go pre-built binary
RUN curl -sL "https://github.com/sundowndev/phoneinfoga/releases/latest/download/phoneinfoga_Linux_x86_64.tar.gz" | \
    tar xz -C /usr/local/bin phoneinfoga && \
    chmod +x /usr/local/bin/phoneinfoga || echo "PhoneInfoga install failed — will be unavailable"

# Amass — Go pre-built binary (download to file first, then extract)
RUN curl -sL "https://github.com/owasp-amass/amass/releases/latest/download/amass_linux_amd64.tar.gz" -o /tmp/amass.tar.gz && \
    tar xzf /tmp/amass.tar.gz -C /tmp && \
    cp /tmp/amass_linux_amd64/amass /usr/local/bin/amass && \
    chmod +x /usr/local/bin/amass && \
    rm -rf /tmp/amass* || echo "Amass install failed — will be unavailable"

# Nuclei — Go pre-built binary
RUN NUCLEI_VERSION=$(curl -s https://api.github.com/repos/projectdiscovery/nuclei/releases/latest | grep tag_name | cut -d'"' -f4 | tr -d v) && \
    curl -sL "https://github.com/projectdiscovery/nuclei/releases/latest/download/nuclei_${NUCLEI_VERSION}_linux_amd64.zip" -o /tmp/nuclei.zip && \
    unzip /tmp/nuclei.zip nuclei -d /usr/local/bin/ && \
    chmod +x /usr/local/bin/nuclei && \
    rm /tmp/nuclei.zip && \
    nuclei -update-templates || echo "Nuclei install failed — will be unavailable"

# Shared data volume mount point
RUN mkdir -p /tmp/osint-data

WORKDIR /tmp/osint-data

# Run idle — bridge calls via docker exec
CMD ["tail", "-f", "/dev/null"]
