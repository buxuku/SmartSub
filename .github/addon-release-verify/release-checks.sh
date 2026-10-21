#!/usr/bin/env bash
# TEMPORARY (issue #547) — 对 whisper.cpp【已发布的 release】里的 Linux CUDA 资产做主机侧检查（真实的 GNU readelf / tar / gzip）。
#
#   1. 发布本身：publish run 成功、在 builder 上手动触发，Create Timestamped Release / Update Latest Release 都执行、Skip publishing 被跳过；
#      release-<时间戳> 已发布且 tag 指向构建用的提交；latest 里这几个文件是这次换上去的，且与时间戳 release 里的逐个一致
#   2. 按应用的方式下载（releases/download/latest/<文件>）：sha256 与 GitHub 记录的 digest、
#      addon-versions.json 里的 linux-tar / linux-node 一致；日期版本号比上一版新（应用据此提示更新）；没动的条目原样保留
#   3. build-info.json：上游 tag、构建提交、运行链接正确，补丁后源码树与上一版相同（只是构建配方变了，源码没变）
#   4. 逐个 CUDA 包（1240 / 1302）：NEEDED 里没有 libnccl（含符号）、守卫放行新包而仍然拒绝已知坏包、
#      Full tar.gz 里恰好是 addon + 3 个真实 CUDA 库（0.4~0.7 GB）且与 .node.gz 里的 addon 同一个文件、
#      RUNPATH 含 $ORIGIN、包提供 addon 需要的全部 CUDA 库且依赖闭包里没有别的东西
#
# 环境变量：WCPP_REPO EXPECT_ORIGIN(yes|no) RELEASE_TAG TS_TAG(auto=取 PUBLISHED_AFTER 之后最新的 release-*) PREV_TAG
#           EXPECT_COMMIT GUARD_COMMIT EXPECT_RUN EXPECT_UPSTREAM_TAG PUBLISHED_AFTER [WAIT_MIN] [W=工作目录，默认 work]
# 不用 set -e：要把所有检查跑完再统一判定。
set -uo pipefail

: "${WCPP_REPO:?}" "${EXPECT_ORIGIN:?}" "${RELEASE_TAG:?}" "${TS_TAG:?}" "${PREV_TAG:?}"
: "${EXPECT_COMMIT:?}" "${GUARD_COMMIT:?}" "${EXPECT_RUN:?}" "${EXPECT_UPSTREAM_TAG:?}" "${PUBLISHED_AFTER:?}"
W=${W:-work}
mkdir -p "$W/dl" "$W/out" "$W/in"
RES="$W/out/static-results.tsv"
: >"$RES"
BASE="https://github.com/$WCPP_REPO/releases/download"

group() { echo "::group::$*"; }
endgroup() { echo "::endgroup::"; }
rec() { # name expected(info=只记录) actual [note]
  local v
  if [ "$2" = info ]; then v=INFO; elif [ "$2" = "$3" ]; then v=PASS; else v=FAIL; fi
  printf '%-78s expected=%-22s actual=%-22s %s\n' "$1" "$2" "$3" "$v"
  if [ "$v" != PASS ] && [ -n "${4:-}" ]; then printf '    -> %s\n' "${4:0:400}"; fi
  printf '%s\t%s\t%s\t%s\t%s\n' "$1" "$2" "$3" "$v" "${4:-}" >>"$RES"
}
finish() {
  echo
  if awk -F'\t' '$4=="FAIL"{f=1} END{exit f?0:1}' "$RES"; then
    echo "::error::release-checks: at least one expectation failed"
    exit 1
  fi
  echo "release-checks: all expectations met"
  exit 0
}
needed() { readelf -d "$1" | sed -n 's/.*(NEEDED)[^[]*\[\(.*\)\]/\1/p' | sort -u; }
runpath() { readelf -d "$1" | grep -E '\((RUNPATH|RPATH)\)' | sed -n 's/.*\[\(.*\)\]/\1/p' | head -1; }
oneline() { tr '\n' ' ' | sed 's/ *$//'; }
sha_of() { sha256sum "$1" | cut -d' ' -f1; }
ver_of_tag() { # release-20261021-053900 -> 2026.10.21
  local d=${1#release-}; d=${d%%-*}
  echo "${d:0:4}.${d:4:2}.${d:6:2}"
}

# ------------------------------------------------------------------ 1. the publish run
if [ "${WAIT_MIN:-0}" -gt 0 ]; then
  deadline=$((SECONDS + WAIT_MIN * 60))
  while :; do
    st=$(gh run view "$EXPECT_RUN" --repo "$WCPP_REPO" --json status --jq .status 2>/dev/null || echo unknown)
    [ "$st" = completed ] && break
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::error::run $EXPECT_RUN is still '$st' after ${WAIT_MIN} minutes"
      break
    fi
    echo "$(date -u +%H:%M:%SZ) publish run $EXPECT_RUN is '$st', waiting..."
    sleep 60
  done
fi

group "Publish run $EXPECT_RUN"
if ! gh run view "$EXPECT_RUN" --repo "$WCPP_REPO" --json status,conclusion,event,headBranch,headSha,url,createdAt,jobs >"$W/run.json"; then
  echo "::error::gh run view $EXPECT_RUN failed"
  rec "read the publish run" ok failed
  finish
fi
jq -r '"url   : \(.url)\nstatus: \(.status)/\(.conclusion)\nevent : \(.event)\nbranch: \(.headBranch)\nsha   : \(.headSha)\ncreated: \(.createdAt)"' "$W/run.json"
jq -r '.jobs[] | "  \(.name): \(.status)/\(.conclusion)"' "$W/run.json"
endgroup

rec "publish run completed" completed "$(jq -r .status "$W/run.json")"
rec "publish run succeeded" success "$(jq -r .conclusion "$W/run.json")"
rec "publish run was started by hand (workflow_dispatch)" workflow_dispatch "$(jq -r .event "$W/run.json")"
rec "publish run was on the builder branch" builder "$(jq -r .headBranch "$W/run.json")"
rec "publish run built the expected commit" "$EXPECT_COMMIT" "$(jq -r .headSha "$W/run.json")"
nonok=$(jq -r '[.jobs[] | select(.conclusion != "success") | "\(.name)=\(.conclusion)"] | join(" ")' "$W/run.json")
rec "every job of the publish run succeeded" none "${nonok:-none}"
jstep() { # job 名 步骤名 -> 结论
  jq -r --arg j "$1" --arg s "$2" '[.jobs[] | select(.name == $j) | .steps[] | select(.name == $s)][0].conclusion // "missing"' "$W/run.json"
}
pstep() { # 发布 job 里某个步骤的结论
  jq -r --arg s "$1" '[.jobs[] | select(.name | test("create-update-release")) | .steps[] | select(.name == $s)][0].conclusion // "missing"' "$W/run.json"
}
for j in linux-cuda-12.4 linux-cuda-13.0; do
  rec "job $j: step 'Verify shared library dependencies' passed" success "$(jstep "$j" 'Verify shared library dependencies')"
  rec "job $j: step 'Copy CUDA libs' passed" success "$(jstep "$j" 'Copy CUDA libs')"
done
rec "publish job: 'Create Timestamped Release' ran" success "$(pstep 'Create Timestamped Release')"
rec "publish job: 'Update Latest Release' ran" success "$(pstep 'Update Latest Release')"
rec "publish job: 'Skip publishing (dry run)' was skipped" skipped "$(pstep 'Skip publishing (dry run)')"

# ------------------------------------------------------------------ 2. the releases
if [ "$TS_TAG" = auto ]; then
  # 注意用 publishedAt：GitHub 的 created_at 是 tag 所指提交的日期，不是发布时间
  TS_TAG=$(gh release list --repo "$WCPP_REPO" --limit 10 --json tagName,publishedAt \
    --jq "[.[] | select(.tagName | startswith(\"release-\")) | select(.publishedAt >= \"$PUBLISHED_AFTER\")] | sort_by(.publishedAt) | last | .tagName // \"\"")
  echo "resolved TS_TAG=${TS_TAG:-<none>}"
fi
rec "a release-<timestamp> release was created by the publish run" yes "$([ -n "$TS_TAG" ] && echo yes || echo no)"
[ -n "$TS_TAG" ] || finish

group "Releases: $RELEASE_TAG (what users download) and $TS_TAG (created by the publish run)"
gh api "repos/$WCPP_REPO/releases/tags/$RELEASE_TAG" >"$W/rel-latest.json" || rec "read release $RELEASE_TAG" ok failed
gh api "repos/$WCPP_REPO/releases/tags/$TS_TAG" >"$W/rel-ts.json" || rec "read release $TS_TAG" ok failed
for f in rel-latest rel-ts; do
  [ -s "$W/$f.json" ] && jq -r '"\(.tag_name)  created=\(.created_at) published=\(.published_at) draft=\(.draft) prerelease=\(.prerelease) assets=\(.assets|length)"' "$W/$f.json"
done
echo "--- Linux CUDA / manifest assets on $RELEASE_TAG:"
jq -r '.assets[] | select(.name | test("linux-cuda|addon-versions|build-info")) | "  \(.name)  size=\(.size)  \(.digest)  updated=\(.updated_at)"' "$W/rel-latest.json"
endgroup
[ -s "$W/rel-latest.json" ] && [ -s "$W/rel-ts.json" ] || finish

published=$(jq -r '.published_at // ""' "$W/rel-ts.json")
if [ "$(jq -r '(.draft | not) and (.prerelease | not)' "$W/rel-ts.json")" = true ]; then x=yes; else x=no; fi
rec "release $TS_TAG is published (not a draft / prerelease)" yes "$x"
if [[ "$published" > "$PUBLISHED_AFTER" ]]; then x=yes; else x=no; fi
rec "release $TS_TAG was published after the publish run started" yes "$x" "published_at=$published PUBLISHED_AFTER=$PUBLISHED_AFTER"
tagsha=$(git ls-remote "https://github.com/$WCPP_REPO.git" "refs/tags/$TS_TAG" "refs/tags/$TS_TAG^{}" | tail -n1 | cut -f1)
rec "tag $TS_TAG points at the built commit" "$EXPECT_COMMIT" "${tagsha:-none}"
rec "git tag 'latest' (informational: the release is edited in place, the tag is not moved)" info \
  "$(git ls-remote "https://github.com/$WCPP_REPO.git" refs/tags/latest | cut -c1-8)"

LINUX_ASSETS="addon-linux-cuda-1240-optimized.node.gz linux-cuda-1240-optimized.tar.gz addon-linux-cuda-1302-optimized.node.gz linux-cuda-1302-optimized.tar.gz"
for n in $LINUX_ASSETS addon-versions.json build-info.json; do
  d_latest=$(jq -r --arg n "$n" '[.assets[] | select(.name == $n)][0].digest // "missing"' "$W/rel-latest.json")
  d_ts=$(jq -r --arg n "$n" '[.assets[] | select(.name == $n)][0].digest // "missing"' "$W/rel-ts.json")
  upd=$(jq -r --arg n "$n" '[.assets[] | select(.name == $n)][0].updated_at // "missing"' "$W/rel-latest.json")
  rec "$n: $RELEASE_TAG has the same digest as $TS_TAG" "$d_ts" "$d_latest"
  if [[ "$upd" > "$PUBLISHED_AFTER" ]]; then x=yes; else x=no; fi
  rec "$n: replaced on $RELEASE_TAG by the publish run" yes "$x" "updated_at=$upd"
done

# --- 下载：与应用同一个 URL 形式（releases/download/<tag>/<文件>）
group "Download the Linux CUDA packs + manifests from $BASE/$RELEASE_TAG/"
rc=0
for n in $LINUX_ASSETS addon-versions.json build-info.json; do
  curl -fL --retry 3 --retry-delay 5 --max-time 1800 -o "$W/dl/$n" "$BASE/$RELEASE_TAG/$n" || rc=1
done
curl -fL --retry 3 --retry-delay 5 -o "$W/prev-build-info.json" "$BASE/$PREV_TAG/build-info.json" || true
curl -fL --retry 3 --retry-delay 5 -o "$W/prev-addon-versions.json" "$BASE/$PREV_TAG/addon-versions.json" || true
ls -l "$W/dl"
endgroup
rec "assets downloaded from the $RELEASE_TAG download URLs" 0 "$rc"
[ "$rc" -eq 0 ] || finish

for n in $LINUX_ASSETS addon-versions.json build-info.json; do
  want=$(jq -r --arg n "$n" '[.assets[] | select(.name == $n)][0].digest // "missing"' "$W/rel-latest.json")
  rec "$n: downloaded file matches GitHub's recorded digest" "$want" "sha256:$(sha_of "$W/dl/$n")"
done

# --- addon-versions.json：应用用它判断要不要更新、校验下载
AV="$W/dl/addon-versions.json"
ts_ver=$(ver_of_tag "$TS_TAG")
prev_ver=$(ver_of_tag "$PREV_TAG")
group "addon-versions.json"
jq -c 'to_entries[] | {key, version: .value.version, notes: .value.updateNotes}' "$AV"
endgroup
for pair in "12.4.0:1240" "13.0.2:1302"; do
  cuda=${pair%%:*}; V=${pair##*:}
  ver=$(jq -r --arg c "$cuda" '.[$c].version // "missing"' "$AV")
  rec "[$V] addon-versions.json[$cuda].version is the publish date" "$ts_ver" "$ver"
  if [[ "$ver" > "$prev_ver" ]]; then x=newer; else x="not-newer"; fi
  rec "[$V] ... and newer than the previous release ($prev_ver), so the app offers the update" newer "$x"
  rec "[$V] addon-versions.json[$cuda].checksum.linux-tar == sha256 of linux-cuda-$V-optimized.tar.gz" \
    "$(sha_of "$W/dl/linux-cuda-$V-optimized.tar.gz")" "$(jq -r --arg c "$cuda" '.[$c].checksum["linux-tar"] // "missing"' "$AV")"
  rec "[$V] addon-versions.json[$cuda].checksum.linux-node == sha256 of addon-linux-cuda-$V-optimized.node.gz" \
    "$(sha_of "$W/dl/addon-linux-cuda-$V-optimized.node.gz")" "$(jq -r --arg c "$cuda" '.[$c].checksum["linux-node"] // "missing"' "$AV")"
  case "$(jq -r --arg c "$cuda" '.[$c].updateNotes // ""' "$AV")" in *"$EXPECT_UPSTREAM_TAG"*) x=yes ;; *) x=no ;; esac
  rec "[$V] updateNotes name the upstream tag $EXPECT_UPSTREAM_TAG" yes "$x"
done
if [ -s "$W/prev-addon-versions.json" ]; then
  for k in 11.8.0 12.2.0; do
    a=$(jq -S -c --arg k "$k" '.[$k] // null' "$AV"); b=$(jq -S -c --arg k "$k" '.[$k] // null' "$W/prev-addon-versions.json")
    if [ "$a" = "$b" ]; then x=same; else x=changed; fi
    rec "addon-versions.json[$k] (not rebuilt) is preserved from $PREV_TAG" same "$x"
  done
fi

# --- build-info.json：来源
BI="$W/dl/build-info.json"
group "build-info.json"
jq -c . "$BI"
endgroup
rec "build-info: upstream tag" "$EXPECT_UPSTREAM_TAG" "$(jq -r '.upstream.tag // "missing"' "$BI")"
rec "build-info: built from builder@$EXPECT_COMMIT" "builder@$EXPECT_COMMIT" "$(jq -r '"\(.builder.ref)@\(.builder.commit)"' "$BI")"
case "$(jq -r '.builder.run // ""' "$BI")" in */actions/runs/"$EXPECT_RUN") x=yes ;; *) x=no ;; esac
rec "build-info: run link is the publish run $EXPECT_RUN" yes "$x" "$(jq -r '.builder.run // ""' "$BI")"
if [ -s "$W/prev-build-info.json" ]; then
  for k in '.upstream.commit' '.patched_tree' '[.patches[].sha256]'; do
    rec "build-info$k is identical to $PREV_TAG (same source, only the recipe changed)" \
      "$(jq -c "$k" "$W/prev-build-info.json")" "$(jq -c "$k" "$BI")"
  done
fi

# --- 守卫脚本：取构建那个提交里的版本
group "Fetch the guard script as it is in $GUARD_COMMIT"
git init -q "$W/wcpp"
git -C "$W/wcpp" remote add origin "https://github.com/$WCPP_REPO.git"
git -C "$W/wcpp" fetch -q --depth 1 origin "$GUARD_COMMIT" && git -C "$W/wcpp" checkout -q FETCH_HEAD
git -C "$W/wcpp" log --oneline -1
endgroup
GUARD="$W/wcpp/.github/scripts/check-addon-needed.sh"
rec "the built commit has check-addon-needed.sh" yes "$([ -f "$GUARD" ] && echo yes || echo no)"
[ -f "$GUARD" ] || finish
flag=()
[ "$EXPECT_ORIGIN" = yes ] && flag=(--require-origin)

# ------------------------------------------------------------------ 3. per pack
for V in 1240 1302; do
  MAJ=$([ "$V" = 1240 ] && echo 12 || echo 13)
  o="$W/out/$V"
  gz="$W/dl/addon-linux-cuda-$V-optimized.node.gz"
  tgz="$W/dl/linux-cuda-$V-optimized.tar.gz"
  bad="$W/in/bad-$V.node"
  echo
  echo "################ $V (CUDA $MAJ.x)"
  rm -rf "$o"
  mkdir -p "$o/full"

  gunzip -c "$gz" >"$o/addon.node"
  cp "$tgz" "$o/full.tar.gz"
  tar -xzf "$tgz" -C "$o/full"
  addon="$o/addon.node"
  inpack="$o/full/addon-linux-cuda-$V-optimized.node"
  ls -l "$o/" "$o/full/"

  # --- Full 包内容与大小
  want_entries="addon-linux-cuda-$V-optimized.node libcublas.so.$MAJ libcublasLt.so.$MAJ libcudart.so.$MAJ"
  got_entries=$(tar -tzf "$tgz" | sed 's#^\./##' | sort | oneline)
  rec "[$V] tar.gz contains exactly the addon + 3 CUDA libs" "$want_entries" "$got_entries"
  for lib in libcudart libcublas libcublasLt; do
    f="$o/full/$lib.so.$MAJ"
    size=$(stat -c%s "$f" 2>/dev/null || echo 0)
    if [ -f "$f" ] && [ ! -L "$f" ] && [ "$size" -gt 100000 ]; then x=yes; else x=no; fi
    rec "[$V] $lib.so.$MAJ is a real file" yes "$x" "${size} bytes"
  done
  tsize=$(stat -c%s "$tgz")
  if [ "$tsize" -ge $((400 * 1048576)) ] && [ "$tsize" -le $((700 * 1048576)) ]; then x=yes; else x=no; fi
  rec "[$V] Full pack download size is 0.4-0.7 GB" yes "$x" "$tsize bytes = $((tsize / 1048576)) MB"
  if [ -f "$inpack" ]; then
    rec "[$V] addon inside tar.gz == addon in .node.gz (sha256)" "$(sha256sum <"$addon" | cut -d' ' -f1)" "$(sha256sum <"$inpack" | cut -d' ' -f1)"
  else
    rec "[$V] addon inside tar.gz == addon in .node.gz (sha256)" same missing
  fi

  # --- addon 的动态依赖
  group "[$V] DT_NEEDED / RUNPATH of the published addon"
  readelf -d "$addon" | grep -E '\((NEEDED|SONAME|RPATH|RUNPATH)\)'
  endgroup
  needed "$addon" >"$o/needed-new.txt"
  n_nccl=$(grep -ci 'nccl' "$o/needed-new.txt" || true)
  rec "[$V] published addon: no NCCL in DT_NEEDED" 0 "$n_nccl"
  rec "[$V] published addon needs libcudart.so.$MAJ and libcublas.so.$MAJ" yes \
    "$(grep -qx "libcudart.so.$MAJ" "$o/needed-new.txt" && grep -qx "libcublas.so.$MAJ" "$o/needed-new.txt" && echo yes || echo no)"
  n_sym=$(nm -D --undefined-only "$addon" 2>/dev/null | grep -ci 'nccl' || true)
  rec "[$V] published addon imports no nccl* symbols" 0 "$n_sym"
  rec "[$V] size of the published addon (bytes)" info "$(stat -c%s "$addon")" "known-bad: $(stat -c%s "$bad" 2>/dev/null || echo n/a)"

  # --- 守卫：构建里用的那个脚本，对线上的包放行，对已知坏包仍然报错
  bash "$GUARD" ${flag[@]+"${flag[@]}"} "$addon" >"$o/guard-new.log" 2>&1
  rc=$?
  tail -n 3 "$o/guard-new.log"
  rec "[$V] guard accepts the published addon (rc)" 0 "$rc"
  if [ -f "$bad" ]; then
    bash "$GUARD" "$bad" >"$o/guard-bad.log" 2>&1
    rc=$?
    grep -E '::error::|libnccl' "$o/guard-bad.log" | head -3
    rec "[$V] guard still rejects the known-bad 2026-10-13 addon (rc)" 1 "$rc"
    grep -q 'libnccl\.so\.2' "$o/guard-bad.log" && x=yes || x=no
    rec "[$V] ... and its message names libnccl.so.2" yes "$x"

    needed "$bad" >"$o/needed-bad.txt"
    removed=$(comm -23 "$o/needed-bad.txt" "$o/needed-new.txt")
    added=$(comm -13 "$o/needed-bad.txt" "$o/needed-new.txt" | oneline)
    grep -qx 'libnccl\.so\.2' <<<"$removed" && x=gone || x=still-there
    rec "[$V] DT_NEEDED vs the known-bad build: libnccl.so.2" gone "$x"
    rec "[$V] DT_NEEDED vs the known-bad build: nothing added" none "${added:-none}"
    other=$(grep -vx 'libnccl\.so\.2' <<<"$removed" | oneline || true)
    rec "[$V] DT_NEEDED vs the known-bad build: other entries removed" info "${other:-none}"
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

  bundle_sonames=$(for f in "$o"/full/lib*.so.*; do [ -e "$f" ] && readelf -d "$f" | sed -n 's/.*(SONAME)[^[]*\[\(.*\)\]/\1/p'; done | sort -u)
  needed_all=$({
    readelf -d "$inpack"
    for f in "$o"/full/lib*.so.*; do [ -e "$f" ] && readelf -d "$f"; done
  } | sed -n 's/.*(NEEDED)[^[]*\[\(.*\)\]/\1/p' | sort -u)
  residual=$(comm -23 <(echo "$needed_all") <(echo "$bundle_sonames") |
    grep -Ev '^(libc\.so\.6|libm\.so\.6|libdl\.so\.2|libpthread\.so\.0|librt\.so\.1|ld-linux-x86-64\.so\.2|libgcc_s\.so\.1|libstdc\+\+\.so\.6|libgomp\.so\.1|libcuda\.so\.1)$' || true)
  rec "[$V] dependency closure of the pack: nothing else needed" none "$(echo "${residual:-none}" | oneline)"
done

finish
