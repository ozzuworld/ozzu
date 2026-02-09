#!/bin/bash
# Quick build & deploy to Android TV
# Usage: ./deploy.sh [--skip-build]

set -e

export ANDROID_HOME=/opt/android-sdk
export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64

TV_IP="172.168.0.56:33813"
APK_PATH="frontend/android/app/build/outputs/apk/debug/app-debug.apk"
PACKAGE="com.anonymous.ozzu"

cd "$(dirname "$0")"

if [ "$1" != "--skip-build" ]; then
  echo "=> Building debug APK..."
  cd frontend/android
  ./gradlew assembleDebug -q
  cd ../..
  echo "=> Build complete"
fi

echo "=> Installing on TV ($TV_IP)..."
adb install -r "$APK_PATH"

echo "=> Launching app..."
adb shell am start -n "$PACKAGE/.MainActivity"

echo "=> Done!"
