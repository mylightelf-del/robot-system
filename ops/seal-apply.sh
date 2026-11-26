# 봉인된 설정값 반영: 러너가 SEALED_PAYLOAD(서버 공개키로 RSA-OAEP-SHA256 암호화, base64)를 앞에 붙여 보낸다.
# 서버 키로 풀어 .env 에 합치고 web·worker 재시작. 값은 출력하지 않는다(키 이름만).
cd /opt/robot-system
[ -n "$SEALED_PAYLOAD" ] || { echo "PUBLIC: 봉인 값 없음"; exit 2; }
echo "$SEALED_PAYLOAD" | base64 -d | openssl pkeyutl -decrypt -inkey .ops-seal.pem -pkeyopt rsa_padding_mode:oaep -pkeyopt rsa_oaep_md:sha256 > /tmp/envfrag 2>/dev/null || { echo "PUBLIC: 풀기 실패"; rm -f /tmp/envfrag; exit 1; }
python3 - <<'PY'
lines = open('.env', encoding='utf-8').read().splitlines()
changed = []
for frag in open('/tmp/envfrag', encoding='utf-8').read().splitlines():
    if '=' not in frag:
        continue
    key = frag.split('=', 1)[0]
    hit = False
    for i, line in enumerate(lines):
        if line.startswith(key + '='):
            lines[i] = frag
            hit = True
    if not hit:
        lines.append(frag)
    changed.append(key + (' (갱신)' if hit else ' (추가)'))
open('.env', 'w', encoding='utf-8').write('\n'.join(lines) + '\n')
print('PUBLIC: 변경: ' + ', '.join(changed))
PY
rm -f /tmp/envfrag
chmod 600 .env
docker compose up -d --force-recreate web worker >/dev/null 2>&1
sleep 15
echo "PUBLIC: health $(curl -s http://127.0.0.1:3000/api/health)"
