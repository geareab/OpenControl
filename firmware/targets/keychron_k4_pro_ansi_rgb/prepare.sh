#!/usr/bin/env bash
# Copyright 2026 OpenControl contributors
# SPDX-License-Identifier: MIT

set -Eeuo pipefail

repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../../.." && pwd)"
target_dir="$repo_root/firmware/targets/keychron_k4_pro_ansi_rgb"
module_dir="$repo_root/firmware/modules/opencontrol"
dist_root="$repo_root/dist/firmware"
bundle="$dist_root/k4p-h3"

keychron_repo="https://github.com/Keychron/qmk_firmware.git"
keychron_branch="bluetooth_playground"
upstream_revision="618127a725a1773e85f13455602cf6f72ab4de17"
qmk_target="keychron/k4_pro/ansi/rgb"
qmk_image="ghcr.io/qmk/qmk_cli@sha256:b7d7fa8fb4432b569931de5ad59098cb788f440ed61a62c5126746b71aee0f4a"
factory_url="https://cdn.shopify.com/s/files/1/0059/0630/1017/files/k4_pro_us_rgb_v1.00.bin?v=1672368297"
factory_sha256="bda30aac7a192f748afba731d0c5ddda0cf42313b48ad6c94eeb93060f5d5493"
factory_bytes="58316"
appdirs_url="https://files.pythonhosted.org/packages/3b/00/2344469e2084fb287c2e0b57b72910309874c3245463acd6cf5e3db69324/appdirs-1.4.4-py2.py3-none-any.whl"
appdirs_sha256="a841dacd6b99318a741b166adb07e19ee71a274450e68237b4650ca1055ab128"
build_jobs="${OPENCONTROL_BUILD_JOBS:-2}"

work_root=""
bundle_stage=""

die() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

cleanup() {
  if [[ -n "$work_root" && -d "$work_root" && "$work_root" == /tmp/opencontrol-k4p-h3.* ]]; then
    rm -rf -- "$work_root"
  fi
  if [[ -n "$bundle_stage" && -d "$bundle_stage" && "$bundle_stage" == "$dist_root"/.k4p-h3-stage.* ]]; then
    rm -rf -- "$bundle_stage"
  fi
}
trap cleanup EXIT

for command in git docker curl node sha256sum cp cmp find sort xargs install awk wc tail chmod mv mktemp; do
  command -v "$command" >/dev/null 2>&1 || die "required command is missing: $command"
done
[[ "$build_jobs" =~ ^[1-9][0-9]*$ ]] || die "OPENCONTROL_BUILD_JOBS must be a positive integer"
[[ ! -L "$bundle" ]] || die "refusing to replace symlink bundle path: $bundle"

umask 077
mkdir -p -- "$dist_root"
work_root="$(mktemp -d /tmp/opencontrol-k4p-h3.XXXXXXXX)"
bundle_stage="$(mktemp -d "$dist_root/.k4p-h3-stage.XXXXXXXX")"
mkdir -p -- "$bundle_stage/evidence" "$bundle_stage/source/opencontrol"

printf '[1/8] Validating the repository target and adapter\n'
node "$target_dir/validate-target.mjs"

printf '[2/8] Fetching the exact Keychron source and required submodules\n'
git clone --quiet --depth 1 --single-branch --branch "$keychron_branch" "$keychron_repo" "$work_root/keychron"
actual_commit="$(git -C "$work_root/keychron" rev-parse HEAD)"
[[ "$actual_commit" == "$upstream_revision" ]] ||
  die "Keychron branch drift: expected $upstream_revision, received $actual_commit"
git -C "$work_root/keychron" submodule update --init --depth 1 \
  lib/chibios lib/chibios-contrib lib/lufa lib/printf
git -C "$work_root/keychron" diff --quiet
git -C "$work_root/keychron" diff --cached --quiet
git -C "$work_root/keychron" apply --check "$target_dir/keychron-opencontrol.patch"

printf '[3/8] Creating three separate clean build trees\n'
cp -a --reflink=auto "$work_root/keychron" "$work_root/baseline"
cp -a --reflink=auto "$work_root/keychron" "$work_root/custom-a"
cp -a --reflink=auto "$work_root/keychron" "$work_root/custom-b"

install_custom_target() {
  local tree="$1"
  local keymap_path="$tree/keyboards/keychron/k4_pro/ansi/rgb/keymaps/opencontrol"

  mkdir -p -- "$keymap_path/opencontrol"
  cp -- "$target_dir/config.h" "$target_dir/keymap.c" "$target_dir/rules.mk" "$keymap_path/"
  cp -- "$module_dir/opencontrol.c" "$module_dir/opencontrol.h" "$keymap_path/opencontrol/"
  git -C "$tree" apply --check "$target_dir/keychron-opencontrol.patch"
  git -C "$tree" apply "$target_dir/keychron-opencontrol.patch"
  git -C "$tree" diff --check
  node "$target_dir/validate-target.mjs" --qmk-tree "$tree"
}

install_custom_target "$work_root/custom-a"
install_custom_target "$work_root/custom-b"

printf '[4/8] Pinning the QMK build container and recording its toolchain\n'
docker pull --quiet "$qmk_image" >/dev/null
docker image inspect "$qmk_image" --format '{{json .RepoDigests}}' \
  >"$bundle_stage/evidence/container-image.json"

legacy_wheel="$work_root/appdirs-1.4.4-py2.py3-none-any.whl"
legacy_python="$work_root/legacy-python"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$legacy_wheel" "$appdirs_url"
actual_appdirs_sha="$(sha256sum "$legacy_wheel" | awk '{print $1}')"
[[ "$actual_appdirs_sha" == "$appdirs_sha256" ]] ||
  die "pinned appdirs wheel checksum changed"
mkdir -p -- "$legacy_python"

container_common=(
  docker run --rm
  --network none
  --cap-drop ALL
  --security-opt no-new-privileges
  --pids-limit 512
  --read-only
  --tmpfs /tmp:rw,nosuid,nodev,size=512m
  --user "$(id -u):$(id -g)"
  --env HOME=/tmp
  --env PYTHONPATH=/legacy-python
  --mount "type=bind,src=$legacy_python,dst=/legacy-python,readonly"
  --entrypoint /bin/bash
)

docker run --rm \
  --network none \
  --cap-drop ALL \
  --security-opt no-new-privileges \
  --pids-limit 128 \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=128m \
  --user "$(id -u):$(id -g)" \
  --env HOME=/tmp \
  --mount "type=bind,src=$work_root,dst=/bootstrap" \
  --entrypoint /bin/bash \
  "$qmk_image" \
  -c 'python3 -m pip install --disable-pip-version-check --no-deps --no-index --target /bootstrap/legacy-python /bootstrap/appdirs-1.4.4-py2.py3-none-any.whl' \
  >"$bundle_stage/evidence/legacy-python-bootstrap.log"

"${container_common[@]}" "$qmk_image" -c 'qmk --version' \
  >"$bundle_stage/evidence/qmk-version.txt"
"${container_common[@]}" "$qmk_image" -c 'arm-none-eabi-gcc --version' \
  >"$bundle_stage/evidence/arm-gcc-version.txt"
"${container_common[@]}" \
  --mount "type=bind,src=$work_root/keychron,dst=/qmk,readonly" \
  --workdir /qmk \
  "$qmk_image" -c 'qmk hello' \
  >"$bundle_stage/evidence/legacy-qmk-smoke.txt"

build_tree() {
  local tree="$1"
  local keymap="$2"
  local label="$3"
  local log="$bundle_stage/evidence/$label-build.log"

  printf '      compiling %s\n' "$label"
  if ! "${container_common[@]}" \
    --mount "type=bind,src=$tree,dst=/qmk" \
    --workdir /qmk \
    --env "OC_TARGET=$qmk_target" \
    --env "OC_KEYMAP=$keymap" \
    --env "OC_JOBS=$build_jobs" \
    "$qmk_image" \
    -c 'make -j"$OC_JOBS" SKIP_VERSION=yes "$OC_TARGET:$OC_KEYMAP"' \
    >"$log" 2>&1; then
    tail -n 80 "$log" >&2
    die "$label compilation failed"
  fi
}

inspect_tree() {
  local tree="$1"
  local stem="$2"
  local label="$3"
  local elf_rel=".build/$stem.elf"
  local map_file="$tree/.build/$stem.map"
  local bin_file="$tree/$stem.bin"

  [[ -f "$bin_file" ]] || die "missing $label binary: $bin_file"
  [[ -f "$tree/$elf_rel" ]] || die "missing $label ELF: $tree/$elf_rel"
  [[ -f "$map_file" ]] || die "missing $label linker map: $map_file"

  "${container_common[@]}" \
    --mount "type=bind,src=$tree,dst=/qmk,readonly" \
    --workdir /qmk \
    --env "OC_ELF=/qmk/$elf_rel" \
    "$qmk_image" -c 'arm-none-eabi-size "$OC_ELF"' \
    >"$bundle_stage/evidence/$label-size.txt"
  "${container_common[@]}" \
    --mount "type=bind,src=$tree,dst=/qmk,readonly" \
    --workdir /qmk \
    --env "OC_ELF=/qmk/$elf_rel" \
    "$qmk_image" -c 'arm-none-eabi-objdump -h "$OC_ELF"' \
    >"$bundle_stage/evidence/$label-objdump.txt"
  "${container_common[@]}" \
    --mount "type=bind,src=$tree,dst=/qmk,readonly" \
    --workdir /qmk \
    --env "OC_ELF=/qmk/$elf_rel" \
    "$qmk_image" -c 'arm-none-eabi-readelf -lW "$OC_ELF"' \
    >"$bundle_stage/evidence/$label-readelf.txt"

  cp -- "$map_file" "$bundle_stage/evidence/$label-linker.map"
  node "$target_dir/verify-build.mjs" \
    --bin "$bin_file" \
    --readelf "$bundle_stage/evidence/$label-readelf.txt" \
    --objdump "$bundle_stage/evidence/$label-objdump.txt" \
    --map "$bundle_stage/evidence/$label-linker.map" \
    --output "$bundle_stage/evidence/$label-memory.json" \
    --label "$label"
}

printf '[5/8] Compiling untouched VIA baseline, then two clean custom trees\n'
build_tree "$work_root/baseline" via baseline-via
inspect_tree "$work_root/baseline" keychron_k4_pro_ansi_rgb_via baseline-via
build_tree "$work_root/custom-a" opencontrol custom-a
inspect_tree "$work_root/custom-a" keychron_k4_pro_ansi_rgb_opencontrol custom-a
build_tree "$work_root/custom-b" opencontrol custom-b
inspect_tree "$work_root/custom-b" keychron_k4_pro_ansi_rgb_opencontrol custom-b

baseline_bin="$work_root/baseline/keychron_k4_pro_ansi_rgb_via.bin"
custom_a_bin="$work_root/custom-a/keychron_k4_pro_ansi_rgb_opencontrol.bin"
custom_b_bin="$work_root/custom-b/keychron_k4_pro_ansi_rgb_opencontrol.bin"
cmp -s -- "$custom_a_bin" "$custom_b_bin" ||
  die "clean custom builds produced different binaries"

printf '[6/8] Fetching and verifying the pinned official recovery binary\n'
factory_bin="$work_root/keychron-k4-pro-k4p-h3-ansi-rgb-factory-v1.00.bin"
curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 \
  --output "$factory_bin" "$factory_url"
actual_factory_sha="$(sha256sum "$factory_bin" | awk '{print $1}')"
actual_factory_bytes="$(wc -c <"$factory_bin")"
[[ "$actual_factory_sha" == "$factory_sha256" ]] ||
  die "official recovery firmware checksum changed"
[[ "$actual_factory_bytes" == "$factory_bytes" ]] ||
  die "official recovery firmware size changed"

cp -- "$custom_a_bin" "$bundle_stage/opencontrol-k4p-h3-experimental.bin"
cp -- "$factory_bin" "$bundle_stage/keychron-k4-pro-k4p-h3-ansi-rgb-factory-v1.00.bin"
cp -- "$target_dir/RECOVERY.md" "$bundle_stage/RECOVERY.md"

printf '[7/8] Assembling manifest, GPL source, patch, and build evidence\n'
cp -- "$target_dir/SOURCE.md" "$bundle_stage/source/README.md"
cp -- "$target_dir/keymap.c" "$target_dir/config.h" "$target_dir/rules.mk" \
  "$target_dir/keychron-opencontrol.patch" "$bundle_stage/source/"
cp -- "$module_dir/opencontrol.c" "$module_dir/opencontrol.h" \
  "$bundle_stage/source/opencontrol/"
cp -- "$work_root/custom-a/keyboards/keychron/k4_pro/k4_pro.c" \
  "$bundle_stage/source/keychron-k4_pro.c"
cp -- "$work_root/custom-a/keyboards/keychron/bluetooth/indicator.c" \
  "$bundle_stage/source/keychron-bluetooth-indicator.c"
cp -- "$work_root/keychron/license_GPLv2.md" "$bundle_stage/source/license_GPLv2.md"
mkdir -p -- "$bundle_stage/source/toolchain"
cp -- "$legacy_wheel" "$bundle_stage/source/toolchain/"
git -C "$work_root/keychron" submodule status --recursive \
  >"$bundle_stage/source/qmk-submodules.txt"
printf '%s\n' "$upstream_revision" >"$bundle_stage/source/qmk-commit.txt"

node "$target_dir/write-manifest.mjs" \
  --bundle "$bundle_stage" \
  --baseline-bin "$baseline_bin" \
  --custom-a-bin "$custom_a_bin" \
  --custom-b-bin "$custom_b_bin" \
  --factory-bin "$factory_bin" \
  --memory-report "$bundle_stage/evidence/custom-a-memory.json" \
  --qmk-version "$bundle_stage/evidence/qmk-version.txt" \
  --gcc-version "$bundle_stage/evidence/arm-gcc-version.txt" \
  --image-inspect "$bundle_stage/evidence/container-image.json" \
  --submodules "$bundle_stage/source/qmk-submodules.txt" \
  --appdirs-wheel "$legacy_wheel"

printf '[8/8] Generating and checking bundle-wide SHA-256 checksums\n'
(
  cd -- "$bundle_stage"
  find . -type f ! -name SHA256SUMS -print0 |
    sort -z |
    xargs -0 sha256sum >SHA256SUMS
  sha256sum --check --quiet SHA256SUMS
)
chmod -R go-rwx -- "$bundle_stage"

if [[ -e "$bundle" ]]; then
  [[ -d "$bundle" && ! -L "$bundle" ]] ||
    die "refusing to replace non-directory bundle path: $bundle"
  rm -rf -- "$bundle"
fi
mv -- "$bundle_stage" "$bundle"
bundle_stage=""

printf 'Prepared (not flashed): %s\n' "$bundle"
printf 'Custom SHA-256: %s\n' "$(sha256sum "$bundle/opencontrol-k4p-h3-experimental.bin" | awk '{print $1}')"
