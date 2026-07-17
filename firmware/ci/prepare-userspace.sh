#!/usr/bin/env bash
# SPDX-License-Identifier: GPL-2.0-or-later

set -euo pipefail

if [[ $# -ne 1 ]]; then
  echo "usage: $0 DESTINATION" >&2
  exit 2
fi

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
firmware_dir="$(cd -- "$script_dir/.." && pwd)"
destination="$1"

if [[ -e "$destination" ]]; then
  echo "destination already exists: $destination" >&2
  exit 2
fi

mkdir -p "$destination/modules"
cp -R "$script_dir/userspace/." "$destination/"
cp -R "$firmware_dir/modules/opencontrol" "$destination/modules/opencontrol"

echo "Prepared OpenControl QMK userspace at $destination"
