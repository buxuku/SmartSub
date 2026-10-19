#!/usr/bin/env bash
# TEMPORARY (issue #547) — 在干净的 Fedora 44 容器里复刻提问者的用户态环境，加载【新构建的 1302 addon】：
#   - Fedora 44 + NVIDIA 官方 Fedora 44 源的 CUDA 13.4 运行时（cudart / cublas，和提问者的 13.4.92 一致）
#   - libcuda 驱动桩（容器没有显卡，只为让 libcuda.so.1 能被解析）
#   - 故意不装 NCCL（NVIDIA 的 Fedora 源里本来就没有 libnccl）
# 同一个容器里还要跑两个对照，保证“新包能加载”有意义：
#   bad  = 2026-10-13 的 latest：必须失败，且报 libnccl.so.2: cannot open shared object file（问题在这个环境里确实复现）
#   good = 2026-06-11 的旧包：必须能加载（环境本身没问题）
# 输入（挂载在 /work）：bad/addon.node good/addon.node new/addon.node；共用的 /pf/dlopen-check.js
# 不用 set -e：要把所有用例跑完再统一判定。
set -uo pipefail

CUDA_LIB=/usr/local/cuda-13.4/targets/x86_64-linux/lib
RES=/work/fedora-results.tsv
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

group "Container"
grep -E '^(PRETTY_NAME|VERSION_ID)=' /etc/os-release
uname -m
endgroup

group "Install the CUDA 13.4 runtime from NVIDIA's Fedora 44 repo (no NCCL)"
cat >/etc/yum.repos.d/cuda-fedora44.repo <<'EOF'
[cuda-fedora44-x86_64]
name=cuda-fedora44-x86_64
baseurl=https://developer.download.nvidia.com/compute/cuda/repos/fedora44/x86_64
enabled=1
gpgcheck=1
gpgkey=https://developer.download.nvidia.com/compute/cuda/repos/fedora44/x86_64/73CD9B30.pub
EOF
dnf -y install --setopt=install_weak_deps=False nodejs libgomp cuda-cudart-13-4 libcublas-13-4 cuda-driver-devel-13-4
install_rc=$?
endgroup
rec "dnf install of node + CUDA 13.4 runtime" 0 "$install_rc"
[ "$install_rc" -eq 0 ] || exit 1
# 没有显卡驱动：用 CUDA 自带的 libcuda 桩顶替 libcuda.so.1，仅用于让依赖可被解析
ln -sf "$CUDA_LIB/stubs/libcuda.so" "$CUDA_LIB/libcuda.so.1"

group "Installed environment"
rpm -q glibc nodejs libgomp cuda-cudart-13-4 libcublas-13-4 cuda-driver-devel-13-4
node --version
echo "--- NCCL on this system (expected: none):"
rpm -qa | grep -i nccl || echo "no nccl package installed"
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

# 最小的 Fedora 镜像里不一定有 ldd，退回直接用动态链接器列依赖
lddx() { if command -v ldd >/dev/null 2>&1; then ldd "$@"; else /lib64/ld-linux-x86-64.so.2 --list "$@"; fi; }
for k in bad good new; do
  group "ldd: $k addon (no LD_LIBRARY_PATH)"
  lddx "/work/$k/addon.node" 2>&1 || true
  endgroup
done
nf=$(lddx /work/new/addon.node 2>&1 | grep -c 'not found' || true)
rec "ldd of the NEW addon: no 'not found'" 0 "$nf"

echo
echo "=== dlopen (one fresh node process per case; the app uses process.dlopen with default flags) ==="
run "bad  (2026-10-13 latest): must fail" FAIL /work/bad/addon.node
case "$LAST_OUT" in *"libnccl.so.2: cannot open shared object file"*) x=yes ;; *) x=no ;; esac
rec "bad: failure is exactly the reported libnccl.so.2 error" yes "$x"
run "good (2026-06-11): loads" OK /work/good/addon.node
run "NEW addon: loads (the app's way)" OK /work/new/addon.node
run "NEW addon: loads with RTLD_NOW (stricter, informational)" info /work/new/addon.node --now
run "good addon with RTLD_NOW (baseline for the line above)" info /work/good/addon.node --now

echo
if awk -F'\t' '$4=="FAIL"{f=1} END{exit f?0:1}' "$RES"; then
  echo "::error::fedora-load: at least one expectation failed"
  exit 1
fi
echo "fedora-load: all expectations met"
