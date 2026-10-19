#!/usr/bin/env bash
# TEMPORARY (issue #547) — Ubuntu 22.04 + CUDA 12.4 运行时（不装 toolkit、不装 NCCL）：加载【新构建的 1240 addon】。
# 提问者是 CUDA 13.4，1240 这个包没有真实用户环境可复刻，所以这里用最典型的「Ubuntu 22.04 + 官方 CUDA 12.4 运行时库」。
# 用 nvidia/cuda:12.4.0-base-ubuntu22.04（不是 runtime 镜像：runtime 镜像自带 libnccl2，会让“无 NCCL”这个前提不成立），
# 再只装 libcublas-12-4（cudart 在 base 镜像里已经有）。
# 同样跑两个对照：bad（2026-10-13 的 1240）必须因 libnccl.so.2 失败；good（2026-06-11 的 1240）必须能加载。
# 输入（挂载在 /work）：bad.node good.node new.node stubs/libcuda.so.1；共用的 /pf/dlopen-check.js
# 不用 set -e：要把所有用例跑完再统一判定。
set -uo pipefail

RES=/work/ubuntu-results.tsv
: >"$RES"
group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
rec() { # name expected(info=只记录) actual [note]
  local v
  if [ "$2" = info ]; then v=INFO; elif [ "$2" = "$3" ]; then v=PASS; else v=FAIL; fi
  printf '%-66s expected=%-8s actual=%-8s %s\n' "$1" "$2" "$3" "$v"
  if [ "$v" != PASS ] && [ -n "${4:-}" ]; then printf '    -> %s\n' "${4:0:400}"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$v" "${4:-}" >>"$RES"
}

group "Container + the CUDA 12.4 runtime libraries (no NCCL)"
. /etc/os-release && echo "$PRETTY_NAME"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils libgomp1 libcublas-12-4 >/dev/null
install_rc=$?
endgroup
rec "apt install of libcublas-12-4 + libgomp1 + curl" 0 "$install_rc"
[ "$install_rc" -eq 0 ] || exit 1

group "Node.js 22 (official linux-x64 tarball)"
base=https://nodejs.org/dist/latest-v22.x
tarball=$(curl -fsSL "$base/SHASUMS256.txt" | awk '/linux-x64\.tar\.xz$/ {print $2; exit}')
echo "tarball: $tarball"
curl -fsSL "$base/$tarball" | tar -xJ -C /usr/local --strip-components=1
node_rc=$?
node --version
endgroup
rec "node 22 installed" 0 "$node_rc"
[ "$node_rc" -eq 0 ] || exit 1

# 真实机器上 libcuda.so.1 由显卡驱动放在系统标准目录；这里放一个驱动桩
install -m755 /work/stubs/libcuda.so.1 /usr/local/lib/libcuda.so.1
ldconfig

group "Installed environment"
dpkg -l | awk '/^ii/ && /(libcublas|cuda-cudart|libnccl)/ {print $2, $3}'
ldconfig -p | grep -E 'libcudart|libcublas|libcuda\.so|libnccl' || true
left=$(find / -xdev \( -name 'libnccl*' -o -name 'nccl.h' \) -not -path '/work/*' 2>/dev/null || true)
echo "${left:-no libnccl / nccl.h anywhere on disk}"
endgroup
rec "no NCCL anywhere on this system" none "$(echo "${left:-none}" | tr '\n' ' ' | sed 's/ *$//')"

J=/pf/dlopen-check.js
run() { # name expected(OK|FAIL|info) args...
  local name=$1 want=$2 out got=FAIL
  shift 2
  out=$(node "$J" "$@" 2>&1)
  out=${out//$'\n'/ }
  case "$out" in DLOPEN_OK*) got=OK ;; esac
  rec "$name" "$want" "$got" "$out"
  LAST_OUT=$out
}

for k in bad good new; do
  group "ldd: $k addon (no LD_LIBRARY_PATH)"
  ldd "/work/$k.node" 2>&1 || true
  endgroup
done
nf=$(ldd /work/new.node 2>&1 | grep -c 'not found' || true)
rec "ldd of the NEW addon: no 'not found'" 0 "$nf"

echo
echo "=== dlopen (one fresh node process per case; the app uses process.dlopen with default flags) ==="
run "bad  (2026-10-13 1240): must fail" FAIL /work/bad.node
case "$LAST_OUT" in *"libnccl.so.2: cannot open shared object file"*) x=yes ;; *) x=no ;; esac
rec "bad: failure is exactly the libnccl.so.2 error" yes "$x"
run "good (2026-06-11 1240): loads" OK /work/good.node
run "NEW 1240 addon: loads (the app's way)" OK /work/new.node
run "NEW 1240 addon: loads with RTLD_NOW (stricter, informational)" info /work/new.node --now
run "good 1240 addon with RTLD_NOW (baseline for the line above)" info /work/good.node --now

echo
if awk -F'\t' '$4=="FAIL"{f=1} END{exit f?0:1}' "$RES"; then
  echo "::error::ubuntu-load: at least one expectation failed"
  exit 1
fi
echo "ubuntu-load: all expectations met"
