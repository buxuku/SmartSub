#!/usr/bin/env bash
# TEMPORARY (issue #547) — 在 nvidia/cuda:<ver>-devel-ubuntu22.04（whisper.cpp 的 build-linux 用的同一个镜像）里：
#   1. 用【真实的 readelf】跑 check-addon-needed.sh：已知坏包必须被拒，已知好包必须通过
#   2. 把 builder.yml 里 "Copy CUDA libs" 这一步的 run 脚本原样抽出来跑（只替换 ${{ matrix.* }}），
#      检查三个库真的被拷进 artifacts/，再按 Package 步骤的方式打成 tar.gz（Full 包）
#   3. 算出这个 Full 包的依赖闭包（用户机器上还得有什么），并准备下一阶段要用的 libcuda 驱动桩
# 不用 set -e：要把所有用例跑完再统一判定。
set -uo pipefail

: "${CUDA_VERSION:?}" "${ASSET_VER:?}"
OUT=/work/out
mkdir -p "$OUT/stubs" "$OUT/artifacts"
RES="$OUT/devel-results.tsv"
: >"$RES"
group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
rec() { # name expected(info=只记录) actual [note]
  local verdict
  if [ "$2" = info ]; then verdict=INFO; elif [ "$2" = "$3" ]; then verdict=PASS; else verdict=FAIL; fi
  printf '%-44s expected=%-5s actual=%-5s %s\n' "$1" "$2" "$3" "$verdict"
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$verdict" "${4:-}" >>"$RES"
}

group "Tools (the build job installs build-essential, which provides readelf)"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq build-essential python3-yaml >/dev/null
echo "image : $(. /etc/os-release && echo "$PRETTY_NAME")"
echo "readelf: $(readelf --version | head -1)"
echo "nvcc  : $(nvcc --version | tail -1)"
echo "CUDA_VERSION=$CUDA_VERSION ASSET_VER=$ASSET_VER"
endgroup

# ---------------------------------------------------------------- 1. guard
GUARD=/wcpp/.github/scripts/check-addon-needed.sh
group "Guard vs the known-bad addon (should be rejected because of libnccl.so.2)"
bash "$GUARD" /work/in/bad.node >"$OUT/guard-bad.log" 2>&1
rc=$?
cat "$OUT/guard-bad.log"
endgroup
rec "guard rejects the known-bad addon (rc)" 1 "$rc"
grep -q 'libnccl\.so\.2' "$OUT/guard-bad.log" && x=yes || x=no
rec "guard output names libnccl.so.2" yes "$x"

group "Guard vs the known-good addon"
bash "$GUARD" /work/in/good.node >"$OUT/guard-good.log" 2>&1
rc=$?
cat "$OUT/guard-good.log"
endgroup
rec "guard accepts the known-good addon (rc)" 0 "$rc"

# ------------------------------------------------- 2. the real "Copy CUDA libs"
group "Extract the real 'Copy CUDA libs' step and its matrix entry from builder.yml"
CUDA_VERSION="$CUDA_VERSION" python3 - <<'PY'
import os, re, sys, yaml

want = os.environ["CUDA_VERSION"]
d = yaml.safe_load(open("/wcpp/.github/workflows/builder.yml"))
job = d["jobs"]["build-linux"]
image = f"nvidia/cuda:{want}-devel-ubuntu22.04"
entry = next((e for e in job["strategy"]["matrix"]["include"] if e.get("container") == image), None)
if entry is None:
    sys.exit(f"no Linux matrix entry uses container {image}")
print("matrix entry:", entry)
if entry.get("cuda_version") != want:
    sys.exit(f"matrix entry cuda_version={entry.get('cuda_version')!r}, expected {want!r}")
step = next(s for s in job["steps"] if s.get("name") == "Copy CUDA libs")
script = re.sub(r"\$\{\{\s*matrix\.(\w+)\s*\}\}", lambda m: str(entry.get(m.group(1), "")), step["run"])
open("/tmp/copy-cuda-libs.sh", "w").write(script)
print("--- step script after substituting matrix values ---")
print(script)
PY
rc=$?
endgroup
rec "extract step; matrix entry has cuda_version" 0 "$rc"

cp /work/in/good.node "$OUT/artifacts/addon-linux-cuda-${ASSET_VER}-optimized.node"
group "Run the step (cwd contains artifacts/, as in the workflow)"
(cd "$OUT" && bash --noprofile --norc -e -o pipefail /tmp/copy-cuda-libs.sh) >"$OUT/copy.log" 2>&1
rc=$?
cat "$OUT/copy.log"
endgroup
rec "Copy CUDA libs exits 0" 0 "$rc"
grep -q '::warning::\|::error::' "$OUT/copy.log" && x=yes || x=no
rec "Copy CUDA libs prints no warning/error" no "$x"

maj=${CUDA_VERSION%%.*}
for lib in libcudart libcublas libcublasLt; do
  f="$OUT/artifacts/$lib.so.$maj"
  size=$(stat -c%s "$f" 2>/dev/null || echo 0)
  if [ -f "$f" ] && [ ! -L "$f" ] && [ "$size" -gt 100000 ]; then x=yes; else x=no; fi
  rec "bundled $lib.so.$maj is a real file" yes "$x" "${size} bytes"
done

group "Package like the workflow does (tar of artifacts/ → gzip -6)"
(cd "$OUT/artifacts" && tar -cf - *) | gzip -6 >"$OUT/full.tar.gz"
ls -lh "$OUT/full.tar.gz"
tar -tzvf "$OUT/full.tar.gz"
endgroup
n=$(tar -tzf "$OUT/full.tar.gz" | wc -l)
rec "tar.gz has addon + 3 libs (entries)" 4 "$n"

# ------------------------------------------------- 3. dependency closure + stub
group "DT_NEEDED / SONAME / RUNPATH of the bundled CUDA libs"
for f in "$OUT"/artifacts/lib*.so.*; do
  echo "== $(basename "$f")"
  readelf -d "$f" | grep -E '\((SONAME|NEEDED|RUNPATH|RPATH)\)' || true
done
endgroup

bundle_sonames=$(for f in "$OUT"/artifacts/lib*.so.*; do readelf -d "$f" | sed -n 's/.*(SONAME)[^[]*\[\(.*\)\]/\1/p'; done | sort -u)
needed_all=$({
  readelf -d "$OUT"/artifacts/*.node
  for f in "$OUT"/artifacts/lib*.so.*; do readelf -d "$f"; done
} | sed -n 's/.*(NEEDED)[^[]*\[\(.*\)\]/\1/p' | sort -u)
residual=$(comm -23 <(echo "$needed_all") <(echo "$bundle_sonames") |
  grep -Ev '^(libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|ld-linux-x86-64\.so\.2|libgcc_s\.so\.1|libstdc\+\+\.so\.6|libgomp\.so\.1|libcuda\.so\.1)$' || true)
echo "--- what a clean machine must still provide beyond the bundle (excluding glibc / GCC runtime / libgomp / driver libcuda):"
echo "${residual:-none}"
rec "bundle closure: nothing else needed" none "$(echo "${residual:-none}" | tr '\n' ' ' | sed 's/ $//')"

cp -L /usr/local/cuda/lib64/stubs/libcuda.so "$OUT/stubs/libcuda.so.1"
echo "libcuda stub: $(readelf -d "$OUT/stubs/libcuda.so.1" | grep SONAME)"

echo
if awk -F'\t' '$4=="FAIL"{f=1} END{exit f?0:1}' "$RES"; then
  echo "::error::devel-stage: at least one expectation failed"
  exit 1
fi
echo "devel-stage: all expectations met"
