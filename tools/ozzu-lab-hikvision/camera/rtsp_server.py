"""
Minimal RTSP server that responds to OPTIONS/DESCRIBE like a Hikvision camera.
Serves on port 554. Does NOT stream real video — just protocol-level responses
so nmap/RTSP probes identify it correctly.
"""

import socket
import threading

RTSP_RESPONSES = {
    "OPTIONS": (
        "RTSP/1.0 200 OK\r\n"
        "CSeq: {cseq}\r\n"
        "Public: OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER\r\n"
        "Server: HiIpcam/V5.7.11\r\n"
        "\r\n"
    ),
    "DESCRIBE": (
        "RTSP/1.0 200 OK\r\n"
        "CSeq: {cseq}\r\n"
        "Content-Type: application/sdp\r\n"
        "Content-Length: {length}\r\n"
        "Server: HiIpcam/V5.7.11\r\n"
        "\r\n"
        "{sdp}"
    ),
}

SDP_BODY = (
    "v=0\r\n"
    "o=- 1 1 IN IP4 0.0.0.0\r\n"
    "s=Hikvision Media Server V5.7.11\r\n"
    "c=IN IP4 0.0.0.0\r\n"
    "t=0 0\r\n"
    "a=control:*\r\n"
    "m=video 0 RTP/AVP 96\r\n"
    "a=rtpmap:96 H264/90000\r\n"
    "a=fmtp:96 profile-level-id=4d001f\r\n"
    "a=control:trackID=1\r\n"
    "m=audio 0 RTP/AVP 8\r\n"
    "a=rtpmap:8 PCMA/8000\r\n"
    "a=control:trackID=2\r\n"
)


def parse_rtsp_request(data):
    lines = data.split("\r\n")
    if not lines:
        return None, None, {}

    parts = lines[0].split(" ")
    method = parts[0] if parts else ""
    uri = parts[1] if len(parts) > 1 else ""

    headers = {}
    for line in lines[1:]:
        if ": " in line:
            k, v = line.split(": ", 1)
            headers[k] = v

    return method, uri, headers


def handle_client(conn, addr):
    try:
        data = conn.recv(4096).decode("utf-8", errors="replace")
        if not data:
            return

        method, uri, headers = parse_rtsp_request(data)
        cseq = headers.get("CSeq", "1")

        if method == "OPTIONS":
            response = RTSP_RESPONSES["OPTIONS"].format(cseq=cseq)
        elif method == "DESCRIBE":
            sdp = SDP_BODY
            response = RTSP_RESPONSES["DESCRIBE"].format(
                cseq=cseq, length=len(sdp), sdp=sdp
            )
        else:
            response = (
                f"RTSP/1.0 401 Unauthorized\r\n"
                f"CSeq: {cseq}\r\n"
                f'WWW-Authenticate: Digest realm="IP Camera", '
                f'nonce="abc123", algorithm=MD5\r\n'
                f"Server: HiIpcam/V5.7.11\r\n"
                f"\r\n"
            )

        conn.sendall(response.encode("utf-8"))
    except Exception:
        pass
    finally:
        conn.close()


def main():
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(("0.0.0.0", 554))
    server.listen(5)
    print("[rtsp] Listening on port 554")

    while True:
        conn, addr = server.accept()
        t = threading.Thread(target=handle_client, args=(conn, addr), daemon=True)
        t.start()


if __name__ == "__main__":
    main()
