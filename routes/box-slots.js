import { loadBoxSlots, saveBoxSlots, newSlotId } from "../data/box-slots.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleBoxSlotRoutes(req, res, url) {
  const db = await loadBoxSlots();

  if (req.method === "GET" && url.pathname === "/api/box-slots") {
    const q = url.searchParams.get("q");
    let list = db.slots;
    if (q) {
      list = list.filter(s =>
        s.slotNo.includes(q) ||
        (s.remark || "").includes(q)
      );
    }
    return send(res, 200, list);
  }

  if (req.method === "GET" && url.pathname === "/api/box-slots/stats") {
    const totalSlots = db.slots.length;
    const totalCapacity = db.slots.reduce((sum, s) => sum + s.capacity, 0);
    const totalOccupied = db.slots.reduce((sum, s) => sum + s.currentCount, 0);
    const fullSlots = db.slots.filter(s => s.currentCount >= s.capacity).length;
    const availableSlots = totalSlots - fullSlots;
    return send(res, 200, { totalSlots, totalCapacity, totalOccupied, fullSlots, availableSlots, slots: db.slots.map(s => ({ id: s.id, slotNo: s.slotNo, capacity: s.capacity, currentCount: s.currentCount, isFull: s.currentCount >= s.capacity })) });
  }

  if (req.method === "POST" && url.pathname === "/api/box-slots") {
    const input = await body(req);
    if (!input.slotNo) return send(res, 400, { error: "盒位编号必填" });
    const slot = {
      id: newSlotId(),
      slotNo: input.slotNo,
      capacity: input.capacity || 10,
      currentCount: input.currentCount || 0,
      remark: input.remark || ""
    };
    db.slots.push(slot);
    await saveBoxSlots(db);
    return send(res, 201, slot);
  }

  const singleMatch = url.pathname.match(/^\/api\/box-slots\/([^/]+)$/);

  if (singleMatch && req.method === "PUT") {
    const slot = db.slots.find(s => s.id === singleMatch[1]);
    if (!slot) return send(res, 404, { error: "slot_not_found" });
    const input = await body(req);
    if (input.slotNo !== undefined) slot.slotNo = input.slotNo;
    if (input.capacity !== undefined) slot.capacity = input.capacity;
    if (input.currentCount !== undefined) slot.currentCount = input.currentCount;
    if (input.remark !== undefined) slot.remark = input.remark;
    await saveBoxSlots(db);
    return send(res, 200, slot);
  }

  if (singleMatch && req.method === "DELETE") {
    const idx = db.slots.findIndex(s => s.id === singleMatch[1]);
    if (idx === -1) return send(res, 404, { error: "slot_not_found" });
    const removed = db.slots.splice(idx, 1)[0];
    await saveBoxSlots(db);
    return send(res, 200, removed);
  }

  return null;
}
