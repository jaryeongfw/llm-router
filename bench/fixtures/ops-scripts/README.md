# ops-scripts

운영 서버에서 쓰는 합성 예제 셸 스크립트. bash와 POSIX 도구만 사용한다(macOS·Linux 공통).

| 스크립트 | 용도 |
|---|---|
| `scripts/rotate_logs.sh <dir> <keep>` | `app-YYYYMMDD.log` 중 최신 `<keep>`개만 남기고 삭제 |
| `scripts/cleanup_tmp.sh <dir> <days>` | `<dir>` 아래에서 수정 후 `<days>`일 넘은 파일 삭제 |
| `scripts/check_disk.sh <path> <threshold%>` | 사용률이 임계값 이상이면 종료 코드 1 |

테스트: `npm test` (임시 디렉터리에서만 동작)
