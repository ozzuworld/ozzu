# ESP-IDF project for CSI room presence + BLE scanner
# Requires ESP-IDF v5.1+ and esp-radar component
cmake_minimum_required(VERSION 3.16)

set(EXTRA_COMPONENT_DIRS
    $ENV{IDF_PATH}/examples/common_components/protocol_examples_common
)

include($ENV{IDF_PATH}/tools/cmake/project.cmake)
project(ozzu-room-node)
