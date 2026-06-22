import { loadBatches, saveBatches, newBatchId } from "../data/chemical-batches.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleBatchRoutes(req, res, url, studioId) {
  const db = await loadBatches(studioId);

  if (req.method === "GET" && url.pathname === "/api/chemical-batches") {
    const q = url.searchParams.get("q");
    let list = db.batches;
    if (q) {
      list = list.filter(b =>
        b.batchNo.includes(q) ||
        (b.formula || "").includes(q) ||
        (b.negativeCodes || []).some(c => c.includes(q))
      );
    }
    return send(res, 200, list);
  }

  if (req.method === "POST" && url.pathname === "/api/chemical-batches") {
    const input = await body(req);
    if (!input.batchNo) return send(res, 400, { error: "批次号必填" });
    const batch = {
      id: newBatchId(),
      batchNo: input.batchNo,
      mixDate: input.mixDate || "",
      formula: input.formula || "",
      status: input.status || "可用",
      negativeCodes: input.negativeCodes || []
    };
    db.batches.push(batch);
    await saveBatches(db, studioId);
    return send(res, 201, batch);
  }

  const singleMatch = url.pathname.match(/^\/api\/chemical-batches\/([^/]+)$/);

  if (singleMatch && req.method === "PUT") {
    const batch = db.batches.find(b => b.id === singleMatch[1]);
    if (!batch) return send(res, 404, { error: "batch_not_found" });
    const input = await body(req);
    if (input.batchNo !== undefined) batch.batchNo = input.batchNo;
    if (input.mixDate !== undefined) batch.mixDate = input.mixDate;
    if (input.formula !== undefined) batch.formula = input.formula;
    if (input.status !== undefined) batch.status = input.status;
    if (input.negativeCodes !== undefined) batch.negativeCodes = input.negativeCodes;
    await saveBatches(db, studioId);
    return send(res, 200, batch);
  }

  if (singleMatch && req.method === "DELETE") {
    const idx = db.batches.findIndex(b => b.id === singleMatch[1]);
    if (idx === -1) return send(res, 404, { error: "batch_not_found" });
    const removed = db.batches.splice(idx, 1)[0];
    await saveBatches(db, studioId);
    return send(res, 200, removed);
  }

  const negMatch = url.pathname.match(/^\/api\/chemical-batches\/([^/]+)\/negatives$/);
  if (negMatch && req.method === "GET") {
    const batch = db.batches.find(b => b.id === negMatch[1]);
    if (!batch) return send(res, 404, { error: "batch_not_found" });
    return send(res, 200, batch.negativeCodes || []);
  }

  return null;
}
