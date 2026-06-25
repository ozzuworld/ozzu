"""
OzzuLab Hikvision IP Camera Simulator
Simulates a Hikvision DS-2CD2143G2-IU running firmware V5.7.11 build 230830

Vulnerabilities (progressive difficulty):
  1. Info disclosure: /ISAPI/System/deviceInfo (no auth) leaks model, firmware, serial, MAC
  2. Default credentials: admin / 12345 (Digest auth on ISAPI, Basic on login form)
  3. CVE-2021-36260: Command injection via PUT /SDK/webLanguage (no auth required)
  4. CVE-2017-7921: Config backup leak via /System/configurationFile?auth=YWRtaW46MTIK
  5. RTSP unauthenticated: streams on port 554 (separate server)

Flags:
  flag1.txt (/opt/hikvision/) — readable after default-cred auth (GET /ISAPI/Security/adminAccess)
  flag2.txt (/opt/hikvision/) — readable via CVE-2021-36260 RCE
  flag3.txt (/root/)          — readable via config backup leak or post-RCE escalation
"""

import hashlib
import os
import subprocess
import time
from functools import wraps
from flask import Flask, request, Response, render_template, jsonify, make_response

app = Flask(__name__)

ADMIN_USER = "admin"
ADMIN_PASS = "12345"
DEVICE_SERIAL = "DS-2CD2143G2-IU20230415AAWRH83012345"
FIRMWARE_VERSION = "V5.7.11"
BUILD_DATE = "build 230830"
MAC_ADDRESS = "c0:56:e3:a1:b2:c3"
DEVICE_MODEL = "DS-2CD2143G2-IU"

REALM = "IP Camera"
NONCE_STORE = {}

sessions = {}


def generate_nonce():
    return hashlib.md5(os.urandom(16)).hexdigest()


def check_digest_auth(req):
    auth_header = req.headers.get("Authorization", "")
    if not auth_header.startswith("Digest "):
        return False

    parts = {}
    for item in auth_header[7:].split(","):
        item = item.strip()
        if "=" in item:
            k, v = item.split("=", 1)
            parts[k.strip()] = v.strip().strip('"')

    username = parts.get("username", "")
    nonce = parts.get("nonce", "")
    uri = parts.get("uri", "")
    response_hash = parts.get("response", "")
    nc = parts.get("nc", "")
    cnonce = parts.get("cnonce", "")
    qop = parts.get("qop", "")

    if username != ADMIN_USER:
        return False

    ha1 = hashlib.md5(f"{ADMIN_USER}:{REALM}:{ADMIN_PASS}".encode()).hexdigest()
    ha2 = hashlib.md5(f"{req.method}:{uri}".encode()).hexdigest()

    if qop:
        expected = hashlib.md5(f"{ha1}:{nonce}:{nc}:{cnonce}:{qop}:{ha2}".encode()).hexdigest()
    else:
        expected = hashlib.md5(f"{ha1}:{nonce}:{ha2}".encode()).hexdigest()

    return response_hash == expected


def require_digest_auth(f):
    @wraps(f)
    def decorated(*args, **kwargs):
        if check_digest_auth(request):
            return f(*args, **kwargs)
        nonce = generate_nonce()
        resp = make_response("Unauthorized", 401)
        resp.headers["WWW-Authenticate"] = (
            f'Digest realm="{REALM}", '
            f'nonce="{nonce}", '
            f'qop="auth", '
            f'algorithm=MD5'
        )
        resp.headers["Server"] = "webs"
        return resp
    return decorated


def hikvision_headers(resp):
    resp.headers["Server"] = "webs"
    resp.headers["X-Powered-By"] = "DNVRS-Webs"
    resp.headers["Connection"] = "keep-alive"
    return resp


@app.after_request
def add_server_header(response):
    response.headers["Server"] = "webs"
    return response


# --- Web UI ---

@app.route("/")
def index():
    return render_template("login.html")


@app.route("/doc/page/login.asp")
def login_asp():
    return render_template("login.html")


@app.route("/doc/page/main.asp")
@require_digest_auth
def main_page():
    return "<html><body><h1>DS-2CD2143G2-IU</h1><p>Configuration portal</p></body></html>"


# --- ISAPI endpoints ---

@app.route("/ISAPI/System/deviceInfo", methods=["GET"])
def device_info():
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<DeviceInfo version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <deviceName>{DEVICE_MODEL}</deviceName>
    <deviceID>88</deviceID>
    <deviceDescription>IPCamera</deviceDescription>
    <deviceLocation>EDIFICIO</deviceLocation>
    <systemContact>Hikvision.China</systemContact>
    <model>{DEVICE_MODEL}</model>
    <serialNumber>{DEVICE_SERIAL}</serialNumber>
    <macAddress>{MAC_ADDRESS}</macAddress>
    <firmwareVersion>{FIRMWARE_VERSION}</firmwareVersion>
    <firmwareReleasedDate>{BUILD_DATE}</firmwareReleasedDate>
    <bootVersion>V1.3.4</bootVersion>
    <bootReleasedDate>100316</bootReleasedDate>
    <hardwareVersion>0x0</hardwareVersion>
    <encoderVersion>V5.0</encoderVersion>
    <encoderReleasedDate>build 230830</encoderReleasedDate>
    <deviceType>IPCamera</deviceType>
    <telecontrolID>88</telecontrolID>
    <supportBeep>true</supportBeep>
    <supportVideoLoss>false</supportVideoLoss>
    <firmwareVersionInfo>B-R-H3-0</firmwareVersionInfo>
</DeviceInfo>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/System/status", methods=["GET"])
def system_status():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<DeviceStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <currentDeviceTime>2026-06-25T10:30:00-05:00</currentDeviceTime>
    <deviceUpTime>864000</deviceUpTime>
    <CPUList>
        <CPU><cpuDescription>DSP</cpuDescription><cpuUtilization>35</cpuUtilization></CPU>
    </CPUList>
    <MemoryList>
        <Memory><memoryDescription>RAM</memoryDescription><memoryUsage>60</memoryUsage><memoryAvailable>256</memoryAvailable></Memory>
    </MemoryList>
</DeviceStatus>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/System/activate", methods=["GET"])
def activate_status():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<ActivateStatus>
    <isActivated>false</isActivated>
    <passwordStrength>weak</passwordStrength>
</ActivateStatus>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/System/activate", methods=["PUT"])
def activate_camera():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <requestURL>/ISAPI/System/activate</requestURL>
    <statusCode>1</statusCode>
    <statusString>OK</statusString>
    <subStatusCode>ok</subStatusCode>
</ResponseStatus>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/Security/users", methods=["GET"])
@require_digest_auth
def security_users():
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<UserList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <User>
        <id>1</id>
        <userName>{ADMIN_USER}</userName>
        <userLevel>Administrator</userLevel>
        <loginPassword>{ADMIN_PASS}</loginPassword>
    </User>
</UserList>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/Security/adminAccess", methods=["GET"])
@require_digest_auth
def admin_access():
    try:
        with open("/opt/hikvision/flag1.txt") as f:
            flag = f.read().strip()
    except Exception:
        flag = "FLAG_READ_ERROR"

    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<AdminAccessProtocol version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <enabled>true</enabled>
    <protocol>HTTP</protocol>
    <portNo>80</portNo>
    <adminAccess>full</adminAccess>
    <recoveryKey>{flag}</recoveryKey>
    <sshEnabled>false</sshEnabled>
    <telnetEnabled>true</telnetEnabled>
</AdminAccessProtocol>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/Streaming/channels", methods=["GET"])
def streaming_channels():
    xml = """<?xml version="1.0" encoding="UTF-8"?>
<StreamingChannelList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <StreamingChannel>
        <id>101</id>
        <channelName>Camera 01</channelName>
        <enabled>true</enabled>
        <Transport>
            <ControlProtocolList><ControlProtocol><streamingTransport>RTSP</streamingTransport></ControlProtocol></ControlProtocolList>
        </Transport>
        <Video>
            <videoCodecType>H.264</videoCodecType>
            <videoResolutionWidth>2688</videoResolutionWidth>
            <videoResolutionHeight>1520</videoResolutionHeight>
            <maxFrameRate>2500</maxFrameRate>
        </Video>
    </StreamingChannel>
    <StreamingChannel>
        <id>102</id>
        <channelName>Camera 01 - Sub</channelName>
        <enabled>true</enabled>
        <Video>
            <videoCodecType>H.264</videoCodecType>
            <videoResolutionWidth>704</videoResolutionWidth>
            <videoResolutionHeight>576</videoResolutionHeight>
        </Video>
    </StreamingChannel>
</StreamingChannelList>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


@app.route("/ISAPI/System/Network/interfaces", methods=["GET"])
@require_digest_auth
def network_interfaces():
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<NetworkInterfaceList version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <NetworkInterface>
        <id>1</id>
        <IPAddress><ipVersion>v4</ipVersion><addressingType>static</addressingType>
            <ipAddress>192.168.1.19</ipAddress><subnetMask>255.255.255.0</subnetMask>
            <DefaultGateway><ipAddress>192.168.1.1</ipAddress></DefaultGateway>
        </IPAddress>
        <MACAddress>{MAC_ADDRESS}</MACAddress>
    </NetworkInterface>
</NetworkInterfaceList>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


# --- CVE-2021-36260: Command Injection via /SDK/webLanguage ---

@app.route("/SDK/webLanguage", methods=["PUT"])
def web_language_vuln():
    data = request.get_data(as_text=True)
    if "$(" in data or "`" in data or ";" in data or "|" in data or "&" in data:
        import re
        cmd = None
        m = re.search(r'\$\((.+?)\)', data)
        if m:
            cmd = m.group(1)
        else:
            m = re.search(r'`(.+?)`', data)
            if m:
                cmd = m.group(1)
            else:
                for sep in [";", "|", "&&"]:
                    if sep in data:
                        parts = data.split(sep, 1)
                        cmd = parts[1].strip() if len(parts) > 1 else None
                        break

        if cmd:
            try:
                result = subprocess.run(
                    cmd, shell=True, capture_output=True, text=True, timeout=10
                )
                output = result.stdout + result.stderr
            except subprocess.TimeoutExpired:
                output = "Command timed out"
            except Exception as e:
                output = str(e)

            xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <requestURL>/SDK/webLanguage</requestURL>
    <statusCode>4</statusCode>
    <statusString>Invalid Operation</statusString>
    <subStatusCode>invalidOperation</subStatusCode>
    <errorMsg>{output}</errorMsg>
</ResponseStatus>"""
            resp = make_response(xml, 500)
            resp.content_type = "application/xml"
            return hikvision_headers(resp)

    xml = """<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="1.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <requestURL>/SDK/webLanguage</requestURL>
    <statusCode>1</statusCode>
    <statusString>OK</statusString>
    <subStatusCode>ok</subStatusCode>
</ResponseStatus>"""
    resp = make_response(xml)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


# --- CVE-2017-7921: Config backup leak ---

@app.route("/System/configurationFile", methods=["GET"])
def config_file_leak():
    auth_param = request.args.get("auth", "")
    if auth_param == "YWRtaW46MTIK":
        try:
            with open("/root/flag3.txt") as f:
                flag = f.read().strip()
        except Exception:
            flag = "FLAG_READ_ERROR"

        config = f"""# Hikvision Configuration Backup
# Device: {DEVICE_MODEL}
# Serial: {DEVICE_SERIAL}
# Exported: 2026-06-25

[system]
deviceName={DEVICE_MODEL}
deviceLocation=EDIFICIO
firmwareVersion={FIRMWARE_VERSION}

[network]
ipAddress=192.168.1.19
subnetMask=255.255.255.0
gateway=192.168.1.1
dns1=8.8.8.8
macAddress={MAC_ADDRESS}

[users]
admin.password={ADMIN_PASS}
admin.level=Administrator

[security]
recoveryKey={flag}
telnetEnabled=1
sshEnabled=0
onvifAuth=digest/basic

[streaming]
rtspPort=554
mainStream=h264,2688x1520,25fps
subStream=h264,704x576,25fps
rtspAuth=none

[storage]
nasEnabled=0
nasServer=
nasPath=
"""
        resp = make_response(config)
        resp.content_type = "application/octet-stream"
        resp.headers["Content-Disposition"] = "attachment; filename=configurationFile"
        return hikvision_headers(resp)

    nonce = generate_nonce()
    resp = make_response("Unauthorized", 401)
    resp.headers["WWW-Authenticate"] = (
        f'Digest realm="{REALM}", nonce="{nonce}", qop="auth", algorithm=MD5'
    )
    return hikvision_headers(resp)


# --- ONVIF discovery hint ---

@app.route("/onvif/device_service", methods=["GET", "POST"])
def onvif_service():
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<s:Envelope xmlns:s="http://www.w3.org/2003/05/soap-envelope"
            xmlns:tds="http://www.onvif.org/ver10/device/wsdl">
    <s:Body>
        <tds:GetDeviceInformationResponse>
            <tds:Manufacturer>Hikvision</tds:Manufacturer>
            <tds:Model>{DEVICE_MODEL}</tds:Model>
            <tds:FirmwareVersion>{FIRMWARE_VERSION}</tds:FirmwareVersion>
            <tds:SerialNumber>{DEVICE_SERIAL}</tds:SerialNumber>
            <tds:HardwareId>0x0</tds:HardwareId>
        </tds:GetDeviceInformationResponse>
    </s:Body>
</s:Envelope>"""
    resp = make_response(xml)
    resp.content_type = "application/soap+xml"
    return hikvision_headers(resp)


# --- Catch-all for ISAPI that needs auth ---

@app.route("/ISAPI/<path:subpath>", methods=["GET", "PUT", "POST", "DELETE"])
@require_digest_auth
def isapi_catchall(subpath):
    xml = f"""<?xml version="1.0" encoding="UTF-8"?>
<ResponseStatus version="2.0" xmlns="http://www.isapi.org/ver20/XMLSchema">
    <requestURL>/ISAPI/{subpath}</requestURL>
    <statusCode>6</statusCode>
    <statusString>Invalid XML Content</statusString>
    <subStatusCode>badXmlContent</subStatusCode>
</ResponseStatus>"""
    resp = make_response(xml, 400)
    resp.content_type = "application/xml"
    return hikvision_headers(resp)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=80)
