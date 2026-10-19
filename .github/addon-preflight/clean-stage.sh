#!/usr/bin/env bash
# TEMPORARY (issue #547) — 干净的 Debian 12 + Node 22 容器：没有 CUDA toolkit、没有 NCCL，只有一个 libcuda 驱动桩。
# 用 devel-stage 产出的 Full 包（addon + libcudart / libcublas / libcublasLt）验证：用户解压后，
# SmartSub 的加载方式（main/helpers/addonLoader.ts setupLibraryPath：加载前才改运行中进程的 LD_LIBRARY_PATH）
# 到底能不能找到包里的库。结论只看实测，不靠推断。
set -uo pipefail

OUT=/work/out
RES="$OUT/clean-results.tsv"
: >"$RES"
rec() { # name expected(info=只记录) actual [note]
  local verdict
  if [ "$2" = info ]; then verdict=INFO; elif [ "$2" = "$3" ]; then verdict=PASS; else verdict=FAIL; fi
  printf '%-52s expected=%-5s actual=%-5s %s\n' "$1" "$2" "$3" "$verdict"
  # INFO / FAIL 要把原因直接打进日志（只进 step summary 的话，日志里看不出为什么）
  if [ "$verdict" != PASS ] && [ -n "${4:-}" ]; then printf '    -> %s\n' "${4:0:400}"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$verdict" "${4:-}" >>"$RES"
}
group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }

group "Container"
. /etc/os-release && echo "$PRETTY_NAME"
node --version
ldd --version | head -1
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq libgomp1 patchelf >/dev/null
patchelf --version
# 真实机器上 libcuda.so.1 由显卡驱动放在系统标准目录
install -m755 "$OUT/stubs/libcuda.so.1" /usr/local/lib/libcuda.so.1
ldconfig
endgroup

group "The system really is clean (no CUDA runtime / cuBLAS / NCCL outside the pack)"
leftovers=$(find / -xdev \( -name 'libcudart*' -o -name 'libcublas*' -o -name 'libnccl*' \) -not -path '/work/*' 2>/dev/null || true)
echo "${leftovers:-none}"
endgroup
rec "system has no cudart/cublas/nccl" none "$(echo "${leftovers:-none}" | tr '\n' ' ' | sed 's/ $//')"

group "Unpack the full pack the way SmartSub does (extract, rename *.node → addon.node)"
mkdir -p /pack
tar -xzf "$OUT/full.tar.gz" -C /pack
mv /pack/addon-linux-cuda-*.node /pack/addon.node
ls -l /pack
endgroup

J=/pf/dlopen-check.js
run() { # name expected cmd...
  local name=$1 want=$2 out got=FAIL
  shift 2
  out=$("$@" 2>&1)
  out=${out//$'\n'/ }
  case "$out" in DLOPEN_OK*) got=OK ;; esac
  rec "$name" "$want" "$got" "$out"
}

group "ldd on the unpacked addon, without / with LD_LIBRARY_PATH set before the process starts"
echo "--- no LD_LIBRARY_PATH:"
env -u LD_LIBRARY_PATH ldd /pack/addon.node | grep -E 'not found|libcudart|libcublas' || true
echo "--- LD_LIBRARY_PATH=/pack:"
LD_LIBRARY_PATH=/pack ldd /pack/addon.node | grep -E 'not found|libcudart|libcublas' || true
endgroup

echo
echo "=== dlopen cases (one fresh node process per case; LD_LIBRARY_PATH unset unless stated) ==="
# D 对照：只有 addon、没有库，即使指了 LD_LIBRARY_PATH 也必须失败——证明测试本身有分辨力
mkdir -p /pack-d && cp /pack/addon.node /pack-d/addon.node
run "D control: addon only, no libs" FAIL env LD_LIBRARY_PATH=/pack-d node "$J" /pack-d/addon.node
# B 进程启动前就设好 LD_LIBRARY_PATH：证明包里的库本身是完整的
run "B LD_LIBRARY_PATH set before the process starts" OK env LD_LIBRARY_PATH=/pack node "$J" /pack/addon.node
# A SmartSub 现在的做法：加载前才在运行中的进程里改 LD_LIBRARY_PATH（结论只看实测）
# EXPECT_A：OK / FAIL / info（默认 info 只记录）。被测 addon 自带 $ORIGIN RUNPATH 时应为 OK。
echo "--- RUNPATH of the unpacked addon: $(patchelf --print-rpath /pack/addon.node)"
run "A SmartSub today: env mutated in-process, then dlopen" "${EXPECT_A:-info}" env -u LD_LIBRARY_PATH node "$J" /pack/addon.node --smartsub-env
# A0 什么环境变量都不设：只靠 addon 自己的 RUNPATH 能不能找到包里的库
run "A0 no env at all, plain dlopen of the unpacked addon" "${EXPECT_A:-info}" env -u LD_LIBRARY_PATH node "$J" /pack/addon.node

# C 构建期给 addon 加 $ORIGIN RUNPATH 之后，同样的包不设任何环境变量
cp -a /pack /pack-c
echo "--- RUNPATH before: $(patchelf --print-rpath /pack-c/addon.node)"
patchelf --add-rpath '$ORIGIN' /pack-c/addon.node
echo "--- RUNPATH after : $(patchelf --print-rpath /pack-c/addon.node)"
run "C addon has \$ORIGIN in RUNPATH, no env at all" info env -u LD_LIBRARY_PATH node "$J" /pack-c/addon.node
run "C' same, through SmartSub's in-process env mutation" info env -u LD_LIBRARY_PATH node "$J" /pack-c/addon.node --smartsub-env

# E 不改 addon：应用先用绝对路径把包里的库 dlopen 进来（glibc 会按 SONAME 复用已加载的库）
maj=$(ls /pack | sed -n 's/^libcudart\.so\.\([0-9]*\)$/\1/p' | head -1)
run "E app preloads the bundled libs by absolute path" info env -u LD_LIBRARY_PATH \
  node "$J" /pack/addon.node --preload "/pack/libcudart.so.$maj" "/pack/libcublasLt.so.$maj" "/pack/libcublas.so.$maj"

echo
if awk -F'\t' '$4=="FAIL"{f=1} END{exit f?0:1}' "$RES"; then
  echo "::error::clean-stage: at least one expectation failed"
  exit 1
fi
echo "clean-stage: all expectations met"
