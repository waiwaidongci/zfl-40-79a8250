import { loadDefects, saveDefects, newDefectId } from "../data/defects.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleDefectsRoutes(req, res, url) {
  const db = await loadDefects();

  if (req.method === "GET" && url.pathname === "/api/defects") {
    const q = url.searchParams.get("q");
    let list = db.defects;
    if (q) {
      const lower = q.toLowerCase();
      list = list.filter(d =>
        d.name.includes(q) ||
        d.description.includes(q) ||
        (d.keywords || []).some(k => k.includes(lower) || k.includes(q))
      );
    }
    return send(res, 200, list);
  }

  if (req.method === "POST" && url.pathname === "/api/defects") {
    const input = await body(req);
    if (!input.name) return send(res, 400, { error: "缺陷名称必填" });
    const defect = {
      id: newDefectId(),
      name: input.name,
      severity: input.severity || "轻微",
      repair: input.repair || "",
      keywords: input.keywords || [],
      description: input.description || ""
    };
    db.defects.push(defect);
    await saveDefects(db);
    return send(res, 201, defect);
  }

  const singleMatch = url.pathname.match(/^\/api\/defects\/([^/]+)$/);

  if (singleMatch && req.method === "PUT") {
    const defect = db.defects.find(d => d.id === singleMatch[1]);
    if (!defect) return send(res, 404, { error: "defect_not_found" });
    const input = await body(req);
    if (input.name !== undefined) defect.name = input.name;
    if (input.severity !== undefined) defect.severity = input.severity;
    if (input.repair !== undefined) defect.repair = input.repair;
    if (input.keywords !== undefined) defect.keywords = input.keywords;
    if (input.description !== undefined) defect.description = input.description;
    await saveDefects(db);
    return send(res, 200, defect);
  }

  if (singleMatch && req.method === "DELETE") {
    const idx = db.defects.findIndex(d => d.id === singleMatch[1]);
    if (idx === -1) return send(res, 404, { error: "defect_not_found" });
    const removed = db.defects.splice(idx, 1)[0];
    await saveDefects(db);
    return send(res, 200, removed);
  }

  return null;
}
