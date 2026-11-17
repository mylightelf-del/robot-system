# (서버에서 실행) /tmp/envfrag 의 KEY=VALUE 를 /opt/robot-system/.env 에 합치고 web·worker 를 다시 띄운다.
# ops.yml 의 sync-secrets 가 앞에 "cd /opt/robot-system" 과 envfrag 생성 줄을 붙여 보낸다. 값은 출력하지 않는다.
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
