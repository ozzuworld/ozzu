// udp_sender.h — UDP client for sending reports to Rock Pi hub
#pragma once

#include "config.h"
#include "protocol.h"

// Initialize UDP socket
void udp_sender_init(const node_config_t *cfg);

// Send CSI presence report
void udp_send_csi_report(const csi_report_t *report);

// Send BLE sighting report (header + devices)
void udp_send_ble_report(const ble_report_header_t *header, const ble_device_t *devices);
