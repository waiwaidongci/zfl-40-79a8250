import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readBackupFile, DATA_FILES, parseBackupFilename, createBackup } from "./backup-service.js";
import { addAuditLog, AUDIT_ACTION_TYPES } from "../data/audit-logs.js";
import { getDataPath } from "../data/studios.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = join(__dirname, "..", "data");

function resolveDataPath(filename, studioId) {
  if (studioId) return getDataPath(studioId, filename);
  return join(dataDir, filename);
}

async function getCurrentDataCounts(studioId) {
  const counts = {};

  for (const file of DATA_FILES) {
    const filePath = resolveDataPath(file, studioId);
    if (!existsSync(filePath)) {
      counts[file] = { exists: false, count: 0 };
      continue;
    }
    try {
      const content = JSON.parse(await readFile(filePath, "utf8"));
      if (file === "cyanotype-negative-room.json") {
        counts[file] = {
          exists: true,
          count: (content.items || []).length,
          statuses: (content.items || []).reduce((acc, item) => {
            acc[item.status || "未知"] = (acc[item.status || "未知"] || 0) + 1;
            return acc;
          }, {})
        };
      } else if (file === "audit-logs.json") {
        counts[file] = { exists: true, count: (content.logs || []).length };
      } else if (file === "box-slots.json") {
        counts[file] = { exists: true, count: (content.slots || []).length };
      } else if (file === "chemical-batches.json") {
        counts[file] = { exists: true, count: (content.batches || []).length };
      } else if (file === "defects.json") {
        counts[file] = { exists: true, count: (content.defects || []).length };
      } else if (file === "delivery-batches.json") {
        counts[file] = { exists: true, count: (content.batches || []).length };
      } else if (file === "process-templates.json") {
        counts[file] = { exists: true, count: (content.templates || []).length };
      } else {
        counts[file] = { exists: true, count: 0 };
      }
    } catch (e) {
      counts[file] = { exists: true, count: 0, error: e.message };
    }
  }

  return counts;
}

function getBackupDataCounts(backupData) {
  const counts = {};

  for (const [file, content] of Object.entries(backupData)) {
    if (file === "_meta") continue;
    if (file === "cyanotype-negative-room.json") {
      counts[file] = {
        count: (content.items || []).length,
        statuses: (content.items || []).reduce((acc, item) => {
          acc[item.status || "未知"] = (acc[item.status || "未知"] || 0) + 1;
          return acc;
        }, {})
      };
    } else if (file === "audit-logs.json") {
      counts[file] = { count: (content.logs || []).length };
    } else if (file === "box-slots.json") {
      counts[file] = { count: (content.slots || []).length };
    } else if (file === "chemical-batches.json") {
      counts[file] = { count: (content.batches || []).length };
    } else if (file === "defects.json") {
      counts[file] = { count: (content.defects || []).length };
    } else if (file === "delivery-batches.json") {
      counts[file] = { count: (content.batches || []).length };
    } else if (file === "process-templates.json") {
      counts[file] = { count: (content.templates || []).length };
    } else {
      counts[file] = { count: 0 };
    }
  }

  return counts;
}

async function validateRestore(filename, studioId) {
  const info = parseBackupFilename(filename);
  if (!info) {
    throw new Error("无效的备份文件名");
  }

  let backupData;
  try {
    backupData = await readBackupFile(filename);
  } catch (e) {
    throw new Error("无法读取备份文件：" + e.message);
  }

  if (!backupData || typeof backupData !== "object") {
    throw new Error("备份文件格式无效");
  }

  const currentCounts = await getCurrentDataCounts(studioId);
  const backupCounts = getBackupDataCounts(backupData);

  const mainDb = "cyanotype-negative-room.json";

  return {
    filename,
    backupDate: info.date,
    backupTimestamp: info.timestamp,
    currentItemCount: currentCounts[mainDb]?.count || 0,
    backupItemCount: backupCounts[mainDb]?.count || 0,
    currentCounts,
    backupCounts,
    dataFiles: Object.keys(backupCounts),
    warnings: []
  };
}

async function performRestore(filename, confirmed, studioId) {
  if (!confirmed) {
    throw new Error("恢复操作需要确认");
  }

  const info = parseBackupFilename(filename);
  if (!info) {
    throw new Error("无效的备份文件名");
  }

  const backupData = await readBackupFile(filename);

  const preRestoreBackup = await createBackup(`恢复前自动备份 - 恢复目标: ${info.timestamp}`, studioId);

  const restoredFiles = [];
  const errors = [];

  for (const [file, content] of Object.entries(backupData)) {
    if (file === "_meta") continue;
    const filePath = resolveDataPath(file, studioId);
    try {
      await writeFile(filePath, JSON.stringify(content, null, 2));
      restoredFiles.push(file);
    } catch (e) {
      errors.push({ file, error: e.message });
    }
  }

  await addAuditLog({
    actionType: AUDIT_ACTION_TYPES.RESTORE,
    itemCode: null,
    itemId: null,
    before: {
      backupFilename: filename,
      backupTimestamp: info.timestamp,
      preRestoreBackup: preRestoreBackup.filename
    },
    after: {
      restoredFiles,
      errors
    },
    summary: `从备份「${filename}」恢复数据，恢复 ${restoredFiles.length} 个文件${errors.length ? `，失败 ${errors.length} 个` : ""}`
  }, studioId);

  return {
    success: errors.length === 0,
    filename,
    restoredFiles,
    errors,
    preRestoreBackup: preRestoreBackup.filename
  };
}

export {
  getCurrentDataCounts,
  getBackupDataCounts,
  validateRestore,
  performRestore
};
