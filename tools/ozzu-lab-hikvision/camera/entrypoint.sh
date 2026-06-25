#!/bin/bash
python3 /app/rtsp_server.py &
python3 /app/sdk_server.py &
exec python3 /app/app.py
