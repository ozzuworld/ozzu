"""
Minimal Hikvision SDK protocol responder on port 8000.
Responds to TCP probes with a binary header that fingerprints as Hikvision SDK.
Real Hikvision SDK uses a proprietary binary protocol — this just returns enough
for nmap/probe scripts to identify the service.
"""

import socket
import struct
import threading

HIK_SDK_BANNER = (
    b"\x48\x49\x4b\x56"  # "HIKV" magic bytes
    b"\x01\x00\x00\x00"  # protocol version
    b"\x00\x00\x00\x00"  # session id
    b"\x00\x00\x00\x04"  # payload length
    b"\x00\x00\x00\x00"  # payload (empty response)
)


def handle_client(conn, addr):
    try:
        data = conn.recv(1024)
        if data:
            if b"GET" in data or b"HTTP" in data:
                conn.sendall(
                    b"HTTP/1.1 400 Bad Request\r\n"
                    b"Server: Hikvision-SDK/V5.7\r\n"
                    b"Content-Length: 0\r\n"
                    b"\r\n"
                )
            else:
                conn.sendall(HIK_SDK_BANNER)
    except Exception:
        pass
    finally:
        conn.close()


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", 8000))
    server.listen(5)
    print("[sdk] Listening on port 8000")

    while True:
        conn, addr = server.accept()
        t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
        t.start()


if __name__ == "__main__":
    main()
