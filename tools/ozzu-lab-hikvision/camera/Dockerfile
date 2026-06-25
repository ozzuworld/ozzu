FROM python:3.11-slim

RUN apt-get update && \
    DEBIAN_FRONTEND=noninteractive apt-get install -y \
      net-tools iputils-ping curl && \
    rm -rf /var/lib/apt/lists/*

RUN pip install --no-cache-dir flask==3.1.1

WORKDIR /app
COPY app.py rtsp_server.py sdk_server.py entrypoint.sh ./
COPY templates/ ./templates/
COPY static/ ./static/

RUN mkdir -p /opt/hikvision

COPY flags/ /opt/hikvision/flags/
RUN mv /opt/hikvision/flags/flag1.txt /opt/hikvision/flag1.txt && \
    mv /opt/hikvision/flags/flag2.txt /opt/hikvision/flag2.txt && \
    mv /opt/hikvision/flags/flag3.txt /root/flag3.txt && \
    rmdir /opt/hikvision/flags && \
    chmod 600 /root/flag3.txt && \
    chmod 644 /opt/hikvision/flag1.txt /opt/hikvision/flag2.txt

RUN chmod +x entrypoint.sh

EXPOSE 80 554 8000

CMD ["./entrypoint.sh"]
