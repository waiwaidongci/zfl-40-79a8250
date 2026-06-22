import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const auditDbPath = join(__dirname, "audit-logs.json");

const AUDIT_ACTION_TYPES = {
  CREATE: "create",
  UPDATE_STATUS: "update_status",
  ADD_NOTE: "add_note",
  RECORD_STEP: "record_step",
  SKIP_STEP: "skip_step",
  IMPORT: "import",
  UPDATE_FIELD: "update_field"
};

const AUDIT_ACTION_LABELS = {
  [AUDIT_ACTION_TYPES.CREATE]: "新增底片",
  [AUDIT_ACTION_TYPES.UPDATE_STATUS]: "修改状态",
  [AUDIT_ACTION_TYPES.ADD_NOTE]: "追加备注",
  [AUDIT_ACTION_TYPES.RECORD_STEP]: "记录工艺步骤",
  [AUDIT_ACTION_TYPES.SKIP_STEP]: "跳过工艺步骤",
  [AUDIT_ACTION_TYPES.IMPORT]: "批量导入",
  [AUDIT_ACTION_TYPES.UPDATE_FIELD]: "更新字段"
};

async function loadAuditDb() {
  if (!existsSync(auditDbPath)) {
    await writeFile(auditDbPath, JSON.stringify({ logs: [] }, null, 2));
  }
  return JSON.parse(await readFile(auditDbPath, "utf8"));
}

async function saveAuditDb(db) {
  await writeFile(auditDbPath, JSON.stringify(db, null, 2));
}

async function addAuditLog(logEntry) {
  const db = await loadAuditDb();
  const entry = {
    id: "AUD-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6),
    timestamp: new Date().toISOString(),
    ...logEntry
  };
  db.logs.unshift(entry);
  await saveAuditDb(db);
  return entry;
}

async function getAuditLogs(filters = {}) {
  const db = await loadAuditDb();
  let logs = db.logs || [];

  if (filters.itemCode) {
    const code = filters.itemCode.trim().toLowerCase();
    logs = logs.filter(log => 
      log.itemCode && log.itemCode.toLowerCase().includes(code)
    );
  }

  if (filters.actionType) {
    logs = logs.filter(log => log.actionType === filters.actionType);
  }

  if (filters.dateKeyword) {
    const keyword = filters.dateKeyword.trim().toLowerCase();
    logs = logs.filter(log => 
      log.timestamp.toLowerCase().includes(keyword)
    );
  }

  return logs;
}

export {
  loadAuditDb,
  saveAuditDb,
  addAuditLog,
  getAuditLogs,
  AUDIT_ACTION_TYPES,
  AUDIT_ACTION_LABELS
};
