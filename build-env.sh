#!/usr/bin/env bash
# 在 Git Bash 里准备 Rust/Tauri 的 MSVC 构建环境。
#
# 用法：
#   source 客户端-Tauri/build-env.sh
#   cd 客户端-Tauri/src-tauri && cargo build
#
# 为什么需要这个文件（三个必踩的坑）：
#   1. Git Bash 自带 /usr/bin/link.exe（硬链接工具），会抢在 MSVC 的 link.exe 前面 →
#      cargo 报 "linking with link.exe failed"。必须把 MSVC 的 bin 目录前置到 PATH 最前。
#   2. cargo / tauri 不在 PATH 里（~/.cargo/bin 默认没被 Git Bash 继承）。
#   3. 只给 PATH 不够：MSVC 的 link.exe 还要靠 LIB / INCLUDE 找库和头文件，
#      这两个变量在非 vcvars 环境下是空的，必须手动设（用 Windows 分号分隔的路径）。

set -u

# ---- 自动探测最新版本，避免写死版本号后 VS/SDK 升级就失效 ----
_find_msvc() {
  local base="/c/Program Files/Microsoft Visual Studio/2022"
  local hit
  # 兼容 Community / Professional / Enterprise / BuildTools 四种安装
  hit=$(ls -d "$base"/*/VC/Tools/MSVC/*/ 2>/dev/null | sort -V | tail -1)
  if [ -z "$hit" ]; then
    hit=$(ls -d "/c/Program Files (x86)/Microsoft Visual Studio/2022"/*/VC/Tools/MSVC/*/ 2>/dev/null | sort -V | tail -1)
  fi
  printf '%s' "${hit%/}"
}

_find_sdk() {
  local base="/c/Program Files (x86)/Windows Kits/10"
  local ver
  ver=$(ls -1 "$base/bin" 2>/dev/null | grep -E '^10\.' | sort -V | tail -1)
  printf '%s' "$ver"
}

MSVC_DIR="$(_find_msvc)"
SDK_VER="$(_find_sdk)"
SDK_DIR="/c/Program Files (x86)/Windows Kits/10"

if [ -z "$MSVC_DIR" ] || [ ! -d "$MSVC_DIR" ]; then
  echo "[build-env] 没找到 MSVC 工具链，请先装 Visual Studio 生成工具" >&2
  return 1 2>/dev/null || exit 1
fi
if [ -z "$SDK_VER" ]; then
  echo "[build-env] 没找到 Windows SDK（Windows Kits/10/bin）" >&2
  return 1 2>/dev/null || exit 1
fi

# ---- PATH：MSVC 的 x64 工具链放最前，压过 /usr/bin/link.exe ----
export PATH="$MSVC_DIR/bin/Hostx64/x64:$SDK_DIR/bin/$SDK_VER/x64:$HOME/.cargo/bin:$PATH"

# ---- LIB / INCLUDE：Windows 风格（分号分隔 + 反斜杠），link.exe 只认这个 ----
_w() { cygpath -w "$1" 2>/dev/null || printf '%s' "$1"; }
export LIB="$(_w "$MSVC_DIR/lib/x64");$(_w "$SDK_DIR/Lib/$SDK_VER/ucrt/x64");$(_w "$SDK_DIR/Lib/$SDK_VER/um/x64")"
export INCLUDE="$(_w "$MSVC_DIR/include");$(_w "$SDK_DIR/Include/$SDK_VER/ucrt");$(_w "$SDK_DIR/Include/$SDK_VER/um");$(_w "$SDK_DIR/Include/$SDK_VER/shared")"

echo "[build-env] MSVC  : $MSVC_DIR"
echo "[build-env] SDK   : $SDK_VER"
echo "[build-env] link  : $(command -v link || echo '(未找到)')"
echo "[build-env] cargo : $(command -v cargo || echo '(未找到)')"
