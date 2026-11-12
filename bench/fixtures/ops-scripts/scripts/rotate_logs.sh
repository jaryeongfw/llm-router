#!/usr/bin/env bash
# 최신 KEEP개의 app-YYYYMMDD.log만 남기고 나머지를 삭제한다.
set -euo pipefail

dir="${1:?사용법: rotate_logs.sh <dir> <keep>}"
keep="${2:?사용법: rotate_logs.sh <dir> <keep>}"

if ! [[ "$keep" =~ ^[0-9]+$ ]] || [ "$keep" -lt 1 ]; then
  echo "keep은 1 이상의 정수여야 합니다: $keep" >&2
  exit 2
fi

cd "$dir"
# 파일명에 날짜가 있으므로 이름 역순 = 최신순
ls -1 app-*.log 2>/dev/null | sort -r | tail -n +"$((keep + 1))" | while read -r f; do
  rm -f -- "$f"
  echo "삭제: $f"
done
