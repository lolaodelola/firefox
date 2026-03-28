#!/bin/bash
set -x -e -v

# This script is for fetching and repacking the Android AVD (for macOS)

cd $GECKO_PATH

export UPLOAD_DIR=${UPLOAD_DIR:-../artifacts}
AVD_JSON_CONFIG="$1"

mkdir -p $HOME/artifacts $UPLOAD_DIR

# Set JAVA_HOME to the fetched JDK (macOS JDK has Contents/Home structure)
export JAVA_HOME=$MOZ_FETCHES_DIR/jdk/jdk-17.0.17+10/Contents/Home

# Populate $HOME/.mozbuild/android-device
./mach python python/mozboot/mozboot/android.py --artifact-mode --prewarm-avd --avd-manifest="$AVD_JSON_CONFIG" --no-interactive --list-packages

tar cavf $UPLOAD_DIR/android-avd-macos.tar.zst -C $HOME/.mozbuild android-device

ls -al $UPLOAD_DIR
