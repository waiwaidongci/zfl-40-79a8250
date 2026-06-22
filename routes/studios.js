import { listStudios, createStudio, updateStudio, deleteStudio, getStudio } from "../data/studios.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleStudioRoutes(req, res, url) {
  if (!url.pathname.startsWith("/api/studios")) return null;

  if (req.method === "GET" && url.pathname === "/api/studios") {
    const studios = await listStudios();
    return send(res, 200, studios);
  }

  if (req.method === "POST" && url.pathname === "/api/studios") {
    const input = await body(req);
    if (!input.name || !input.name.trim()) return send(res, 400, { error: "工作室名称必填" });
    const studio = await createStudio(input);
    return send(res, 201, studio);
  }

  const singleMatch = url.pathname.match(/^\/api\/studios\/([^/]+)$/);

  if (singleMatch && req.method === "GET") {
    const studio = await getStudio(singleMatch[1]);
    if (!studio) return send(res, 404, { error: "studio_not_found" });
    return send(res, 200, studio);
  }

  if (singleMatch && req.method === "PUT") {
    const input = await body(req);
    const studio = await updateStudio(singleMatch[1], input);
    if (!studio) return send(res, 404, { error: "studio_not_found" });
    return send(res, 200, studio);
  }

  if (singleMatch && req.method === "DELETE") {
    const result = await deleteStudio(singleMatch[1]);
    if (result.error) return send(res, 400, result);
    return send(res, 200, result.studio);
  }

  return null;
}
