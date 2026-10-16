#!/usr/bin/env bash
# TEMPORARY (issue #547) — runs inside a clean Fedora 44 container, see
# .github/workflows/addon-load-repro.yml.
#
# 复刻提问者的 CUDA 用户态环境，并验证 addon 能否被 Node 的 process.dlopen 加载：
#   - Fedora 44
#   - NVIDIA 官方 Fedora 44 源的 CUDA 13.4 运行时（cudart / cublas，和提问者的 13.4.92 一致）
#   - libcuda 驱动桩：容器没有显卡，只为让 libcuda.so.1 能被解析
#   - 故意不安装 NCCL（NVIDIA 的 Fedora 源里本来就没有 libnccl）
#
# 不使用 set -e：坏包加载失败是预期结果，需要把所有用例跑完再统一判定。
set -uo pipefail

CUDA_LIB=/usr/local/cuda-13.4/targets/x86_64-linux/lib
RESULTS=/work/results.tsv
VERDICT=/work/verdict.md
BAD_TAG="${BAD_TAG:-bad}"
GOOD_TAG="${GOOD_TAG:-good}"

group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }

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
dnf -y install --setopt=install_weak_deps=False \
  nodejs libgomp cuda-cudart-13-4 libcublas-13-4 cuda-driver-devel-13-4
install_rc=$?
endgroup
if [ "$install_rc" -ne 0 ]; then
  echo "::error::dnf install failed (rc=$install_rc)"
  exit 10
fi

# 没有显卡驱动：用 CUDA 自带的 libcuda 桩顶替 libcuda.so.1，仅用于让依赖可被解析
ln -sf "$CUDA_LIB/stubs/libcuda.so" "$CUDA_LIB/libcuda.so.1"

group "Installed environment"
rpm -q glibc nodejs libgomp cuda-cudart-13-4 libcublas-13-4 cuda-driver-devel-13-4
node --version
ls -l "$CUDA_LIB"
echo "--- NCCL on this system (expected: none):"
rpm -qa | grep -i nccl || echo "no nccl package installed"
find / -xdev \( -name 'libnccl*' -o -name 'nccl.h' \) -not -path '/work/*' 2>/dev/null | grep . ||
  echo "no libnccl / nccl.h anywhere on disk"
endgroup

# 和应用一致：main/helpers/addonLoader.ts 的 tryLoadCandidate 是
#   process.dlopen(module, path)  （不带 flags，即 Node 默认的 RTLD_LAZY），
# 并要求加载后 exports.whisper 是函数。mode=now 额外用 RTLD_NOW 做更严格的检查（仅供参考）。
cat >/tmp/dlopen-check.js <<'EOF'
const os = require('os');
const [file, mode] = process.argv.slice(2);
const mod = { exports: { whisper: null } };
try {
  if (mode === 'now') {
    process.dlopen(mod, file, os.constants.dlopen.RTLD_NOW);
  } else {
    process.dlopen(mod, file);
  }
  if (typeof mod.exports.whisper !== 'function') {
    throw new Error('Addon loaded but exports no whisper()');
  }
  console.log('DLOPEN_OK whisper=' + typeof mod.exports.whisper);
} catch (e) {
  console.log('DLOPEN_FAIL ' + String((e && e.message) || e).replace(/\s+/g, ' '));
  process.exitCode = 3;
}
EOF

show_deps() { # label addon [extra_ld_path]
  group "ldd: $1"
  if command -v ldd >/dev/null 2>&1; then
    LD_LIBRARY_PATH="${3:+$3:}$CUDA_LIB" ldd "$2" 2>&1
  else
    LD_LIBRARY_PATH="${3:+$3:}$CUDA_LIB" /lib64/ld-linux-x86-64.so.2 --list "$2" 2>&1
  fi
  endgroup
}

: >"$RESULTS"
run_case() { # name addon extra_ld_path mode(app|now)
  local name=$1 addon=$2 extra=$3 mode=$4 out rc status
  out=$(LD_LIBRARY_PATH="${extra:+$extra:}$CUDA_LIB" node /tmp/dlopen-check.js "$addon" "$mode" 2>&1)
  rc=$?
  out=${out//$'\n'/ }
  case "$out" in
    DLOPEN_OK*) status=OK ;;
    DLOPEN_FAIL*) status=FAIL ;;
    *) status="ABNORMAL(rc=$rc)" ;;
  esac
  echo "[$name | $mode] $status :: $out"
  printf '%s\t%s\t%s\t%s\n' "$name" "$mode" "$status" "$out" >>"$RESULTS"
}

show_deps "bad  ($BAD_TAG) without NCCL" /work/bad/addon.node
show_deps "bad  ($BAD_TAG) with the stub libnccl.so.2" /work/bad/addon.node /work/stub
show_deps "good ($GOOD_TAG) without NCCL" /work/good/addon.node

echo
echo "=== dlopen results (one fresh node process per case) ==="
run_case bad-no-nccl /work/bad/addon.node "" app
run_case bad-no-nccl /work/bad/addon.node "" now
run_case bad-stub-nccl /work/bad/addon.node /work/stub app
run_case bad-stub-nccl /work/bad/addon.node /work/stub now
run_case good-no-nccl /work/good/addon.node "" app
run_case good-no-nccl /work/good/addon.node "" now

field() { # name mode column
  awk -F'\t' -v n="$1" -v m="$2" -v c="$3" '$1==n && $2==m {print $c; exit}' "$RESULTS"
}
a_status=$(field bad-no-nccl app 3)
a_msg=$(field bad-no-nccl app 4)
b_status=$(field bad-stub-nccl app 3)
c_status=$(field good-no-nccl app 3)

repro=no
if [ "$a_status" = FAIL ] && [[ "$a_msg" == *"libnccl.so.2: cannot open shared object file"* ]]; then
  repro=yes
fi
control=no
[ "$b_status" = OK ] && control=yes
workaround=no
[ "$c_status" = OK ] && workaround=yes

{
  echo "- 复现问题（当前 latest = \`$BAD_TAG\` 的 addon 在无 NCCL 的 Fedora 44 环境加载失败，且报 \`libnccl.so.2: cannot open shared object file\`）: **$repro**"
  echo "- 对照（同一个坏包 + stub \`libnccl.so.2\` 能加载，说明环境本身没问题、缺的只是 NCCL）: **$control**"
  echo "- 临时方案（\`$GOOD_TAG\` 的历史 addon 在同一环境能加载）: **$workaround**"
} >"$VERDICT"

echo
echo "=== verdict ==="
cat "$VERDICT"

if [ "$repro" = yes ] && [ "$control" = yes ] && [ "$workaround" = yes ]; then
  exit 0
fi
echo "::error::expectations not met (repro=$repro control=$control workaround=$workaround)"
exit 1
