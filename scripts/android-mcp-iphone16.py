#!/usr/bin/env python3
"""Wrapper to launch android-mcp targeting the iPhone 16 mirror Redroid instance (localhost:5560)."""
import sys
import os

# Patch sys.argv before android_mcp parses args
sys.argv = [sys.argv[0]]

# uiautomator2 uses adb under the hood — ensure our device is connected
os.system("adb connect localhost:5560 > /dev/null 2>&1")

# Monkey-patch the Mobile class to always connect to our device
from android_mcp.mobile import service as mobile_service
_orig_init = mobile_service.Mobile.__init__

def _patched_init(self, device=None):
    _orig_init(self, device="localhost:5560")

mobile_service.Mobile.__init__ = _patched_init

# Now run the MCP server
from android_mcp.__main__ import main
main()
