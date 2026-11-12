# 런북: 디스크 사용률 경고

## 증상
- 모니터링에서 디스크 사용률 경고가 발생했다.
- 애플리케이션 로그에 쓰기 실패(`No space left on device`)가 보인다.

## 확인
1. 사용률 확인: `scripts/check_disk.sh /var/app 85` — 종료 코드 1이면 임계값 이상이다.
2. 큰 디렉터리 찾기: `du -sh /var/app/* | sort -h | tail`
3. 로그 개수 확인: `ls -1 /var/app/logs/app-*.log | wc -l`

## 조치
1. 오래된 로그 정리: `scripts/rotate_logs.sh /var/app/logs 14` — 최신 14개만 남긴다.
2. 임시 파일 정리: 먼저 `scripts/cleanup_tmp.sh --dry-run /var/app/tmp 7`로 대상을 확인하고, 목록에 문제가 없으면 `--dry-run` 없이 실행한다.
3. 위 조치로 부족하면 담당자에게 볼륨 증설을 요청한다. 수동 삭제는 하지 않는다.

## 확인 후 마무리
1. `scripts/check_disk.sh /var/app 85`가 종료 코드 0인지 확인한다.
2. 조치 내용(삭제한 파일 수, 전후 사용률)을 장애 기록에 남긴다.
