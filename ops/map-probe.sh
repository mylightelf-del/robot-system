# BIB·CENOBOT 지도 응답 형식 확인(조회만). 공개 기록에는 형식·크기·개수만(URL·좌표값 원문은 찍지 않음).
cd /opt/robot-system
docker compose exec -T worker npx tsx -e '
(async () => {
  const { getDb, schema } = await import("./src/lib/db/client");
  const { inArray } = await import("drizzle-orm");
  const rs = await getDb().select().from(schema.robots).where(inArray(schema.robots.vendor, ["BIB", "CENOBOTS"]));
  for (const r of rs) {
    const fl = await getDb().query.floors.findFirst({ where: (f, { eq }) => eq(f.id, r.floorId) });
    const mv = fl ? await getDb().query.mapVersions.findFirst({ where: (m, { eq }) => eq(m.id, fl.currentMapVersionId) }) : null;
    console.log("PUBLIC: 로봇", r.id, r.vendor, "사용=" + r.active, "층=" + (fl?.name ?? "-"), "층지도=v" + (mv?.version ?? "-"), "제조사=" + (mv?.vendor ?? "없음(샘플)"));
  }
  try {
    const { createBibApi } = await import("./src/lib/vendors/bib/api");
    const api = createBibApi();
    for (const r of rs.filter((x) => x.vendor === "BIB" && x.active)) {
      const l = await api.maps(r.vendorRobotId).catch((e) => ({ err: e.message }));
      console.log("PUBLIC: BIB", r.id, "지도목록", l.err ? "오류 " + l.err : l.localMapList.length + "개 · 현재=" + (l.localMapList.find((m) => m.mapHandle === l.activeMapHandle)?.name ?? "없음"));
      const m = await api.localMap(r.vendorRobotId).catch((e) => ({ err: e.message }));
      if (m.err) console.log("PUBLIC: BIB", r.id, "지도그림 오류", m.err);
      else {
        let size = "-", dim = "-";
        try {
          const buf = m.image.type === "BASE64" ? Buffer.from(m.image.data, "base64") : Buffer.from(await (await fetch(m.image.data)).arrayBuffer());
          size = Math.round(buf.length / 1024) + "KB";
          if (buf[0] === 0x89 && buf[1] === 0x50) dim = buf.readUInt32BE(16) + "x" + buf.readUInt32BE(20) + " PNG";
          else dim = "머리 " + buf.subarray(0, 4).toString("hex");
        } catch (e) { size = "받기 실패 " + e.message; }
        console.log("PUBLIC: BIB", r.id, "지도그림 형식=" + m.image.type, "mime=" + m.image.mimeType, "크기=" + size, dim);
      }
      const p = await api.position(r.vendorRobotId).catch((e) => ({ err: e.message }));
      console.log("PUBLIC: BIB", r.id, "위치", p.err ? "오류 " + p.err : "frame=" + p.localMapPosition.frame + " unit=" + p.localMapPosition.unit + " 지도같음=" + (p.mapHandle === (m.mapHandle ?? "")));
    }
  } catch (e) { console.log("PUBLIC: BIB 오류", e.message); }
  try {
    const { createCenobotsApi } = await import("./src/lib/vendors/cenobots/cenobotsAdapter");
    const api = createCenobotsApi();
    for (const r of rs.filter((x) => x.vendor === "CENOBOTS" && x.active)) {
      const oid = String(r.vendorMeta?.deviceOpenId ?? r.vendorRobotId);
      const st = await api.status(oid).catch((e) => ({ err: e.message }));
      console.log("PUBLIC: CZ", r.id, "상태", st.err ? "오류 " + st.err : "지도=" + (st.currentMapName ?? "-") + " 버전있음=" + !!st.currentMapVersion + " 위치있음=" + !!st.pose);
      const maps = await api.maps(oid).catch((e) => ({ err: e.message }));
      console.log("PUBLIC: CZ", r.id, "지도목록", maps.err ? "오류 " + maps.err : maps.length + "개 사용중=" + maps.filter((m) => m.inUse).map((m) => m.mapName).join(","));
      const ver = st.currentMapVersion || (Array.isArray(maps) ? maps.find((m) => m.inUse)?.mapVersion : null);
      if (!ver) continue;
      const pic = await api.mapPic(ver).catch((e) => ({ err: e.message }));
      if (pic.err) { console.log("PUBLIC: CZ", r.id, "지도그림 오류", pic.err); continue; }
      let info = "-";
      try { const res = await fetch(pic.picUrl); const b = Buffer.from(await res.arrayBuffer()); info = "HTTP " + res.status + " " + Math.round(b.length / 1024) + "KB 머리 " + b.subarray(0, 4).toString("hex"); } catch (e) { info = "받기 실패 " + e.message; }
      console.log("PUBLIC: CZ", r.id, "지도그림", pic.width + "x" + pic.height, "모서리 " + (pic.vertexCoordinates?.length ?? 0) + "개", "그림 " + info);
      if (st.pose && pic.vertexCoordinates?.length === 4) {
        const xs = pic.vertexCoordinates.map((v) => v.x), ys = pic.vertexCoordinates.map((v) => v.y);
        const inside = st.pose.x >= Math.min(...xs) && st.pose.x <= Math.max(...xs) && st.pose.y >= Math.min(...ys) && st.pose.y <= Math.max(...ys);
        console.log("PUBLIC: CZ", r.id, "로봇 위치가 지도 범위 안=" + inside, "축정렬=" + (Math.abs(xs[0] - xs[1]) < 1e-6 && Math.abs(ys[1] - ys[2]) < 1e-6));
      }
      const ar = await api.areas(oid, st.currentMapId ?? 0).catch((e) => ({ err: e.message }));
      console.log("PUBLIC: CZ", r.id, "구역", ar.err ? "오류 " + ar.err : (ar.areaList?.length ?? 0) + "개");
    }
  } catch (e) { console.log("PUBLIC: CZ 오류", e.message); }
  process.exit(0);
})().catch((e) => { console.log("PUBLIC: 오류", e.message); process.exit(1); });' 2>&1 | grep '^PUBLIC:'
echo "결과: 완료"
