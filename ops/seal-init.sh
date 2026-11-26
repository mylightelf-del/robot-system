# 봉인(암호화) 전달용 서버 키 만들기: 없을 때만 RSA-4096 생성(.ops-seal.pem, 600). 공개키만 출력한다.
cd /opt/robot-system
[ -f .ops-seal.pem ] || { openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:4096 -out .ops-seal.pem 2>/dev/null && chmod 600 .ops-seal.pem; }
echo "PUBLIC: SEALPUB $(openssl pkey -in .ops-seal.pem -pubout 2>/dev/null | base64 -w0)"
