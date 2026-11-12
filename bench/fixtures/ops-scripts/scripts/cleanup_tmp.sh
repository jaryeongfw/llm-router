#!/usr/bin/env bash
# DIR 아래에서 수정 후 DAYS일이 넘은 일반 파일을 삭제한다.
set -euo pipefail

dir="${1:?사용법: cleanup_tmp.sh <dir> <days>}"
days="${2:?사용법: cleanup_tmp.sh <dir> <days>}"

if ! [[ "$days" =~ ^[0-9]+$ ]]; then
  echo "days는 0 이상의 정수여야 합니다: $days" >&2
  exit 2
fi

find "$dir" -type f -mtime +"$days" -print | while read -r f; do
  rm -f -- "$f"
  echo "삭제: $f"
done
