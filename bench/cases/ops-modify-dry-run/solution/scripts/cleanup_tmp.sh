#!/usr/bin/env bash
# DIR 아래에서 수정 후 DAYS일이 넘은 일반 파일을 삭제한다.
# --dry-run: 삭제하지 않고 대상만 "삭제 예정: <경로>"로 출력한다.
set -euo pipefail

dry_run=0
if [ "${1:-}" = "--dry-run" ]; then
  dry_run=1
  shift
fi

dir="${1:?사용법: cleanup_tmp.sh [--dry-run] <dir> <days>}"
days="${2:?사용법: cleanup_tmp.sh [--dry-run] <dir> <days>}"

if ! [[ "$days" =~ ^[0-9]+$ ]]; then
  echo "days는 0 이상의 정수여야 합니다: $days" >&2
  exit 2
fi

find "$dir" -type f -mtime +"$days" -print | while read -r f; do
  if [ "$dry_run" -eq 1 ]; then
    echo "삭제 예정: $f"
  else
    rm -f -- "$f"
    echo "삭제: $f"
  fi
done
