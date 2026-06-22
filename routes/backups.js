import { listBackups, getBackupSummary, createBackup, deleteBackup } from "../services/backup-service.js";
import { validateRestore, performRestore, getCurrentDataCounts } from "../services/restore-service.js";
import { addAuditLog, AUDIT_ACTION_TYPES } from "../data/audit-logs.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleBackupRoutes(req, res, url, studioId) {
  if (req.method === "GET" && url.pathname === "/api/backups") {
    try {
      const backups = await listBackups(studioId);
      return send(res, 200, backups);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === "POST" && url.pathname === "/api/backups") {
    try {
      const input = await body(req);
      const note = input.note || "";
      const backup = await createBackup(note, studioId);

      await addAuditLog({
        actionType: AUDIT_ACTION_TYPES.BACKUP,
        itemCode: null,
        itemId: null,
        before: null,
        after: { filename: backup.filename, timestamp: backup.timestamp, note },
        summary: `创建备份「${backup.filename}」${note ? `（备注：${note}）` : ""}`
      });

      return send(res, 201, backup);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  if (req.method === "GET" && url.pathname === "/api/backups/current-counts") {
    try {
      const counts = await getCurrentDataCounts(studioId);
      return send(res, 200, counts);
    } catch (e) {
      return send(res, 500, { error: e.message });
    }
  }

  const singleMatch = url.pathname.match(/^\/api\/backups\/([^/]+)$/);

  if (singleMatch && req.method === "GET") {
    try {
      const filename = decodeURIComponent(singleMatch[1]);
      const summary = await getBackupSummary(filename, studioId);
      return send(res, 200, summary);
    } catch (e) {
      return send(res, 404, { error: e.message });
    }
  }

  if (singleMatch && req.method === "DELETE") {
    try {
      const filename = decodeURIComponent(singleMatch[1]);
      const result = await deleteBackup(filename, studioId);

      await addAuditLog({
        actionType: AUDIT_ACTION_TYPES.DELETE_BACKUP,
        itemCode: null,
        itemId: null,
        before: { filename },
        after: null,
        summary: `删除备份「${filename}」`
      });

      return send(res, 200, result);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  const restoreValidateMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore-validate$/);

  if (restoreValidateMatch && req.method === "GET") {
    try {
      const filename = decodeURIComponent(restoreValidateMatch[1]);
      const validation = await validateRestore(filename, studioId);
      return send(res, 200, validation);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  const restoreMatch = url.pathname.match(/^\/api\/backups\/([^/]+)\/restore$/);

  if (restoreMatch && req.method === "POST") {
    try {
      const filename = decodeURIComponent(restoreMatch[1]);
      const input = await body(req);
      const confirmed = input.confirmed === true;

      if (!confirmed) {
        return send(res, 400, { error: "恢复操作需要确认（confirmed: true）" });
      }

      const result = await performRestore(filename, true, studioId);
      return send(res, result.success ? 200 : 500, result);
    } catch (e) {
      return send(res, 400, { error: e.message });
    }
  }

  return null;
}
