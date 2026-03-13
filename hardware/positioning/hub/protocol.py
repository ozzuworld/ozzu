"""protocol.py — Binary packet parsing for ESP32 node UDP reports.
Keep in sync with esp32-csi/main/protocol.h
"""

import struct
from dataclasses import dataclass
from typing import Optional

MAGIC_CSI = 0x4F5A4301  # "OZC\x01"
MAGIC_BLE = 0x4F5A4201  # "OZB\x01"

# CSI report: 20 bytes
#   uint32 magic, uint8 node_id, uint8 presence, uint8 motion_level,
#   uint8 confidence, int8 rssi, 3x uint8 reserved, uint32 uptime_sec, uint32 seq
CSI_FMT = "<IBBBB b3x II"
CSI_SIZE = struct.calcsize(CSI_FMT)

# BLE report header: 12 bytes
#   uint32 magic, uint8 node_id, uint8 device_count, uint16 scan_duration_ms, uint32 seq
BLE_HDR_FMT = "<IBBHI"
BLE_HDR_SIZE = struct.calcsize(BLE_HDR_FMT)

# BLE device entry: 10 bytes
#   6x uint8 addr, int8 rssi, uint8 addr_type, uint16 reserved
BLE_DEV_FMT = "<6s b B H"
BLE_DEV_SIZE = struct.calcsize(BLE_DEV_FMT)

PRESENCE_EMPTY = 0
PRESENCE_STATIC = 1
PRESENCE_MOVING = 2
PRESENCE_NAMES = {0: "empty", 1: "static", 2: "moving"}


@dataclass
class CsiReport:
    node_id: int
    presence: int  # 0=empty, 1=static, 2=moving
    motion_level: int
    confidence: int
    rssi: int
    uptime_sec: int
    seq: int

    @property
    def presence_name(self) -> str:
        return PRESENCE_NAMES.get(self.presence, "unknown")


@dataclass
class BleDevice:
    addr: str  # "AA:BB:CC:DD:EE:FF"
    rssi: int
    addr_type: int  # 0=public, 1=random


@dataclass
class BleReport:
    node_id: int
    scan_duration_ms: int
    seq: int
    devices: list  # list of BleDevice


def parse_packet(data: bytes) -> Optional[object]:
    """Parse a UDP packet from an ESP32 node."""
    if len(data) < 4:
        return None

    magic = struct.unpack_from("<I", data, 0)[0]

    if magic == MAGIC_CSI and len(data) >= CSI_SIZE:
        fields = struct.unpack_from(CSI_FMT, data, 0)
        return CsiReport(
            node_id=fields[1],
            presence=fields[2],
            motion_level=fields[3],
            confidence=fields[4],
            rssi=fields[5],
            uptime_sec=fields[6],
            seq=fields[7],
        )

    if magic == MAGIC_BLE and len(data) >= BLE_HDR_SIZE:
        hdr = struct.unpack_from(BLE_HDR_FMT, data, 0)
        node_id = hdr[1]
        device_count = hdr[2]
        scan_duration = hdr[3]
        seq = hdr[4]

        devices = []
        offset = BLE_HDR_SIZE
        for _ in range(device_count):
            if offset + BLE_DEV_SIZE > len(data):
                break
            dev = struct.unpack_from(BLE_DEV_FMT, data, offset)
            addr_bytes = dev[0]
            addr_str = ":".join(f"{b:02X}" for b in addr_bytes)
            devices.append(BleDevice(addr=addr_str, rssi=dev[1], addr_type=dev[2]))
            offset += BLE_DEV_SIZE

        return BleReport(
            node_id=node_id,
            scan_duration_ms=scan_duration,
            seq=seq,
            devices=devices,
        )

    return None
