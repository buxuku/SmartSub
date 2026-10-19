#!/usr/bin/env bash
# TEMPORARY (issue #547) — 对 whisper.cpp 一次【真实 dry-run 构建】的产物做主机侧检查（真实的 GNU readelf / tar / gzip）。
#
#   1. 构建本身：已完成且成功、是 workflow_dispatch、在 tmp/* 分支而不是 builder、
#      发布步骤全部被跳过（Skip publishing 运行，Create Timestamped Release / Update Latest Release 被跳过）
#   2. 下载 Linux CUDA 两个产物（1240 / 1302），逐个检查：
#        - addon 的 NEEDED 里没有 libnccl，守卫脚本（用构建那个提交里的版本）放行；
#        - 同一个守卫对已知坏包（2026-10-13 的 latest）仍然报错（反向验证）；
#        - 与已知坏包相比，NEEDED 只少了 libnccl.so.2，没有多出别的
#        - Full tar.gz 里恰好是 addon + 3 个 CUDA 库，且 addon 与 .node.gz 里的是同一个文件
#        - Full 包提供 addon 需要的全部 CUDA 库，并且依赖闭包里没有别的东西
#        - RUNPATH 是否含 $ORIGIN（EXPECT_ORIGIN=yes 时必须有）
#
# 环境变量：RUN WCPP_REPO EXPECT_ORIGIN(yes|no) [W=工作目录，默认 work]
#   SKIP_GH=1：只给本地测脚本逻辑用，跳过 gh 调用（要求 $W/dl 和 $W/wcpp 已经准备好）
# 不用 set -e：要把所有检查跑完再统一判定。
set -uo pipefail

: "${RUN:?}" "${WCPP_REPO:?}" "${EXPECT_ORIGIN:?}"
W=${W:-work}
mkdir -p "$W/dl" "$W/out" "$W/in"
RES="$W/out/static-results.tsv"
: >"$RES"

group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
rec() { # name expected(info=只记录) actual [note]
  local v
  if [ "$2" = info ]; then v=INFO; elif [ "$2" = "$3" ]; then v=PASS; else v=FAIL; fi
  printf '%-70s expected=%-22s actual=%-22s %s\n' "$1" "$2" "$3" "$v"
  if [ "$v" != PASS ] && [ -n "${4:-}" ]; then printf '    -> %s\n' "${4:0:400}"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$v" "${4:-}" >>"$RES"
}
finish() {
  echo
  if awk -F'\t' '$4=="FAIL"{f=1} END{exit f?0:1}' "$RES"; then
    echo "::error::static-checks: at least one expectation failed"
    exit 1
  fi
  echo "static-checks: all expectations met"
  exit 0
}
needed() { readelf -d "$1" | sed -n 's/.*(NEEDED)[^[]*\[\(.*\)\]/\1/p' | sort -u; }
runpath() { readelf -d "$1" | grep -E '\((RUNPATH|RPATH)\)' | sed -n 's/.*\[\(.*\)\]/\1/p' | head -1; }
oneline() { tr '\n' ' ' | sed 's/ *$//'; }

# ------------------------------------------------------------------ 1. the build run
# WAIT_MIN>0：构建还没跑完就每分钟轮询一次（Linux CUDA 构建要一个小时左右），最多等 WAIT_MIN 分钟
if [ -z "${SKIP_GH:-}" ] && [ "${WAIT_MIN:-0}" -gt 0 ]; then
  deadline=$((SECONDS + WAIT_MIN * 60))
  while :; do
    st=$(gh run view "$RUN" --repo "$WCPP_REPO" --json status --jq .status 2>/dev/null || echo unknown)
    [ "$st" = completed ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::error::run $RUN is still '$st' after ${WAIT_MIN} minutes"
      break
    fi
    echo "$(date -u +%H:%M:%SZ) run $RUN is '$st', waiting..."
    sleep 60
  done
fi

if [ -z "${SKIP_GH:-}" ]; then
  group "Build run $RUN"
  if ! gh run view "$RUN" --repo "$WCPP_REPO" --json status,conclusion,event,headBranch,headSha,url,jobs >"$W/run.json"; then
    echo "::error::gh run view $RUN failed"
    rec "read the build run" ok failed
    finish
  fi
  jq -r '"url   : \(.url)\nstatus: \(.status)/\(.conclusion)\nevent : \(.event)\nbranch: \(.headBranch)\nsha   : \(.headSha)"' "$W/run.json"
  jq -r '.jobs[] | "  \(.name): \(.status)/\(.conclusion)"' "$W/run.json"
  endgroup

  rec "run completed" completed "$(jq -r .status "$W/run.json")"
  rec "run succeeded" success "$(jq -r .conclusion "$W/run.json")"
  rec "run was started by hand (workflow_dispatch)" workflow_dispatch "$(jq -r .event "$W/run.json")"
  branch=$(jq -r .headBranch "$W/run.json")
  case "$branch" in tmp/*) x=tmp-branch ;; *) x="$branch" ;; esac
  rec "run is on a tmp/* branch, not on builder" tmp-branch "$x" "branch=$branch"
  for j in linux-cuda-12.4 linux-cuda-13.0; do
    rec "job $j" success "$(jq -r --arg n "$j" '[.jobs[] | select(.name==$n)][0].conclusion // "missing"' "$W/run.json")"
  done
  nonok=$(jq -r '[.jobs[] | select(.conclusion != "success") | "\(.name)=\(.conclusion)"] | join(" ")' "$W/run.json")
  rec "every job of the run succeeded" none "${nonok:-none}"

  step() { # 发布 job 里某个步骤的结论
    jq -r --arg s "$1" '[.jobs[] | select(.name | test("create-update-release")) | .steps[] | select(.name == $s)][0].conclusion // "missing"' "$W/run.json"
  }
  rec "publish job: 'Skip publishing (dry run)' ran" success "$(step 'Skip publishing (dry run)')"
  rec "publish job: 'Create Timestamped Release' was skipped" skipped "$(step 'Create Timestamped Release')"
  rec "publish job: 'Update Latest Release' was skipped" skipped "$(step 'Update Latest Release')"

  HEAD_SHA=$(jq -r .headSha "$W/run.json")
  group "Fetch the build scripts exactly as they were in the built commit ($HEAD_SHA)"
  git init -q "$W/wcpp"
  git -C "$W/wcpp" remote add origin "https://github.com/$WCPP_REPO.git"
  git -C "$W/wcpp" fetch -q --depth 1 origin "$HEAD_SHA" && git -C "$W/wcpp" checkout -q FETCH_HEAD
  git -C "$W/wcpp" log --oneline -1
  endgroup

  group "Download the Linux CUDA artifacts of run $RUN"
  gh run download "$RUN" --repo "$WCPP_REPO" -n linux-cuda-1240-optimized -n linux-cuda-1302-optimized -D "$W/dl"
  rc=$?
  find "$W/dl" -type f -exec ls -l {} \;
  endgroup
  rec "artifacts downloaded" 0 "$rc"
  [ "$rc" -eq 0 ] || finish
fi

GUARD="$W/wcpp/.github/scripts/check-addon-needed.sh"
rec "the built commit has check-addon-needed.sh" yes "$([ -f "$GUARD" ] && echo yes || echo no)"
[ -f "$GUARD" ] || finish
flag=()
[ "$EXPECT_ORIGIN" = yes ] && flag=(--require-origin)

# ------------------------------------------------------------------ 2. per artifact
for V in 1240 1302; do
  MAJ=$([ "$V" = 1240 ] && echo 12 || echo 13)
  o="$W/out/$V"
  d="$W/dl/linux-cuda-$V-optimized"
  gz="$d/addon-linux-cuda-$V-optimized.node.gz"
  tgz="$d/linux-cuda-$V-optimized.tar.gz"
  bad="$W/in/bad-$V.node"
  echo
  echo "################ $V (CUDA $MAJ.x)"
  rm -rf "$o"
  mkdir -p "$o/full"

  rec "[$V] addon .node.gz present" yes "$([ -f "$gz" ] && echo yes || echo no)"
  rec "[$V] full .tar.gz present" yes "$([ -f "$tgz" ] && echo yes || echo no)"
  [ -f "$gz" ] && [ -f "$tgz" ] || continue

  gunzip -c "$gz" >"$o/addon.node"
  cp "$tgz" "$o/full.tar.gz"
  tar -xzf "$tgz" -C "$o/full"
  addon="$o/addon.node"
  inpack="$o/full/addon-linux-cuda-$V-optimized.node"
  ls -l "$o/" "$o/full/"

  # --- Full 包内容
  want_entries="addon-linux-cuda-$V-optimized.node libcublas.so.$MAJ libcublasLt.so.$MAJ libcudart.so.$MAJ"
  got_entries=$(tar -tzf "$tgz" | sed 's#^\./##' | sort | oneline)
  rec "[$V] tar.gz contains exactly the addon + 3 CUDA libs" "$want_entries" "$got_entries"
  for lib in libcudart libcublas libcublasLt; do
    f="$o/full/$lib.so.$MAJ"
    size=$(stat -c%s "$f" 2>/dev/null || echo 0)
    if [ -f "$f" ] && [ ! -L "$f" ] && [ "$size" -gt 100000 ]; then x=yes; else x=no; fi
    rec "[$V] $lib.so.$MAJ is a real file" yes "$x" "${size} bytes"
  done
  if [ -f "$inpack" ]; then
    rec "[$V] addon inside tar.gz == addon in .node.gz (sha256)" "$(sha256sum <"$addon" | cut -d' ' -f1)" "$(sha256sum <"$inpack" | cut -d' ' -f1)"
  else
    rec "[$V] addon inside tar.gz == addon in .node.gz (sha256)" same missing
  fi

  # --- addon 的动态依赖
  group "[$V] DT_NEEDED / RUNPATH of the new addon"
  readelf -d "$addon" | grep -E '\((NEEDED|SONAME|RPATH|RUNPATH)\)'
  endgroup
  needed "$addon" >"$o/needed-new.txt"
  n_nccl=$(grep -ci 'nccl' "$o/needed-new.txt" || true)
  rec "[$V] new addon: no NCCL in DT_NEEDED" 0 "$n_nccl"
  rec "[$V] new addon needs libcudart.so.$MAJ and libcublas.so.$MAJ" yes \
    "$(grep -qx "libcudart.so.$MAJ" "$o/needed-new.txt" && grep -qx "libcublas.so.$MAJ" "$o/needed-new.txt" && echo yes || echo no)"
  # DT_NEEDED 之外再看一眼符号：没有任何 nccl* 未定义符号，说明是真的没链 NCCL，而不是只把依赖项藏起来了
  n_sym=$(nm -D --undefined-only "$addon" 2>/dev/null | grep -ci 'nccl' || true)
  rec "[$V] new addon imports no nccl* symbols" 0 "$n_sym"
  rec "[$V] size of the new addon (bytes)" info "$(stat -c%s "$addon")" "known-bad: $(stat -c%s "$bad" 2>/dev/null || echo n/a)"

  # --- 守卫：构建里用的那个脚本，对新包放行，对已知坏包仍然报错
  bash "$GUARD" ${flag[@]+"${flag[@]}"} "$addon" >"$o/guard-new.log" 2>&1
  rc=$?
  tail -n 3 "$o/guard-new.log"
  rec "[$V] guard accepts the new addon (rc)" 0 "$rc"
  if [ -f "$bad" ]; then
    bash "$GUARD" "$bad" >"$o/guard-bad.log" 2>&1
    rc=$?
    grep -E '::error::|libnccl' "$o/guard-bad.log" | head -3
    rec "[$V] guard still rejects the known-bad 2026-10-13 addon (rc)" 1 "$rc"
    grep -q 'libnccl\.so\.2' "$o/guard-bad.log" && x=yes || x=no
    rec "[$V] ... and its message names libnccl.so.2" yes "$x"

    needed "$bad" >"$o/needed-bad.txt"
    # 与 2026-10-13 的坏包比：libnccl.so.2 必须消失，不能多出任何新依赖；
    # 其它被移除的依赖（例如 ld-linux-x86-64.so.2 取决于链接器怎么处理 TLS）只记录，不当判据
    removed=$(comm -23 "$o/needed-bad.txt" "$o/needed-new.txt")
    added=$(comm -13 "$o/needed-bad.txt" "$o/needed-new.txt" | oneline)
    grep -qx 'libnccl\.so\.2' <<<"$removed" && x=gone || x=still-there
    rec "[$V] DT_NEEDED vs the bad build: libnccl.so.2" gone "$x"
    rec "[$V] DT_NEEDED vs the bad build: nothing added" none "${added:-none}"
    other=$(grep -vx 'libnccl\.so\.2' <<<"$removed" | oneline || true)
    rec "[$V] DT_NEEDED vs the bad build: other entries removed" info "${other:-none}"
  else
    rec "[$V] known-bad addon available for the reverse check" yes no
  fi

  # --- $ORIGIN
  rp=$(runpath "$addon")
  if tr ':' '\n' <<<"$rp" | grep -qx '\$ORIGIN'; then x=yes; else x=no; fi
  rec "[$V] RUNPATH has a literal \$ORIGIN" "$EXPECT_ORIGIN" "$x" "RUNPATH=${rp:-<none>}"

  # --- Full 包自洽：addon 要的 CUDA 库都在包里；整个包的依赖闭包里没有别的东西
  missing=""
  while IFS= read -r n; do
    [ -f "$o/full/$n" ] || missing="$missing$n "
  done < <(grep -E '^lib(cudart|cublas|cublasLt)\.so\.' "$o/needed-new.txt")
  rec "[$V] the pack provides every CUDA lib the addon names" none "${missing:-none}"

  bundle_sonames=$(for f in "$o"/full/lib*.so.*; do readelf -d "$f" | sed -n 's/.*(SONAME)[^[]*\[\(.*\)\]/\1/p'; done | sort -u)
  needed_all=$({
    readelf -d "$inpack"
    for f in "$o"/full/lib*.so.*; do readelf -d "$f"; done
  } | sed -n 's/.*(NEEDED)[^[]*\[\(.*\)\]/\1/p' | sort -u)
  residual=$(comm -23 <(echo "$needed_all") <(echo "$bundle_sonames") |
    grep -Ev '^(libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|ld-linux-x86-64\.so\.2|libgcc_s\.so\.1|libstdc\+\+\.so\.6|libgomp\.so\.1|libcuda\.so\.1)$' || true)
  rec "[$V] dependency closure of the pack: nothing else needed" none "$(echo "${residual:-none}" | oneline)"
done

finish
