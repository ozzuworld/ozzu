#!/bin/sh
# Run the internal-only flag service (127.0.0.1:8080) and the public preview app (:80).
python3 /app/internal.py &
exec python3 /app/app.py
