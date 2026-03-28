#!/bin/bash
set -x -e -v

# This script is for fetching and repacking the Android SDK (for macOS),
# the tools required to produce Android packages.

cd $GECKO_PATH

export UPLOAD_DIR=${UPLOAD_DIR:-../artifacts}
mkdir -p $UPLOAD_DIR

# Set JAVA_HOME to the fetched JDK (macOS JDK has Contents/Home structure)
export JAVA_HOME=$MOZ_FETCHES_DIR/jdk/jdk-17.0.17+10/Contents/Home

# Populate $HOME/.mozbuild/android-sdk-macosx.
./mach python python/mozboot/mozboot/android.py --artifact-mode --no-interactive --list-packages

tar cavf $UPLOAD_DIR/android-sdk-macos.tar.zst -C $HOME/.mozbuild android-sdk-macosx bundletool.jar

ls -al $UPLOAD_DIR
