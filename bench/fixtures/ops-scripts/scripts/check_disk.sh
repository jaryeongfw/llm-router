#!/usr/bin/env bash
# PATH가 속한 파일시스템의 사용률(%)이 THRESHOLD 이상이면 경고하고 종료 코드 1.
set -euo pipefail

path="${1:?사용법: check_disk.sh <path> <threshold%>}"
threshold="${2:?사용법: check_disk.sh <path> <threshold%>}"

usage=$(df -P "$path" | awk 'NR==2 { gsub("%", "", $5); print $5 }')
echo "사용률: ${usage}% (임계값 ${threshold}%)"
if [ "$usage" -ge "$threshold" ]; then
  echo "경고: 디스크 사용률이 임계값 이상입니다" >&2
  exit 1
fi
