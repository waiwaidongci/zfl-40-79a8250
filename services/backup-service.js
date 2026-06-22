import { readFile, writeFile, mkdir, readdir, stat, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const backupDir = join(__dirname, "..", "backups");
const dataDir = join(__dirname, "..", "data");
const mainDbFile = "cyanotype-negative-room.json";

const DATA_FILES = [
  "cyanotype-negative-room.json",
  "audit-logs.json",
  "box-slots.json",
  "chemical-batches.json",
  "defects.json",
  "delivery-batches.json",
  "process-templates.json"
];

function formatTimestamp(date) {
  const d = date || new Date();
  const pad = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function parseBackupFilename(filename) {
  const match = filename.match(/^backup-(\d{8}-\d{6})\.json$/);
  if (!match) return null;
  const ts = match[1];
  const year = parseInt(ts.slice(0, 4), 10);
  const month = parseInt(ts.slice(4, 6), 10) - 1;
  const day = parseInt(ts.slice(6, 8), 10);
  const hour = parseInt(ts.slice(9, 11), 10);
  const minute = parseInt(ts.slice(11, 13), 10);
  const second = parseInt(ts.slice(13, 15), 10);
  const date = new Date(year, month, day, hour, minute, second);
  return { filename, timestamp: ts, date: date.toISOString(), timestampMs: date.getTime() };
}

async function ensureBackupDir() {
  if (!existsSync(backupDir)) {
    await mkdir(backupDir, { recursive: true });
  }
}

async function listBackups() {
  if (!existsSync(backupDir)) {
    return [];
  }
  const files = await readdir(backupDir);
  const backups = [];
  for (const file of files) {
    const info = parseBackupFilename(file);
    if (info) {
      try {
        const filePath = join(backupDir, file);
        const stats = await stat(filePath);
        backups.push({
          ...info,
          size: stats.size
        });
      } catch (e) {
        // skip unreadable files
      }
    }
  }
  backups.sort((a, b) => b.timestampMs - a.timestampMs);
  return backups;
}

async function readBackupFile(filename) {
  if (!parseBackupFilename(filename)) {
    throw new Error("无效的备份文件名");
  }
  const filePath = join(backupDir, filename);
  if (!existsSync(filePath)) {
    throw new Error("备份文件不存在");
  }
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function getBackupSummary(filename) {
  const data = await readBackupFile(filename);
  const info = parseBackupFilename(filename);
  const summary = {
    filename,
    timestamp: info ? info.timestamp : null,
    date: info ? info.date : null,
    dataFiles: {}
  };

  for (const [key, content] of Object.entries(data)) {
    if (key === "cyanotype-negative-room.json" && content && content.items) {
      summary.dataFiles[key] = {
        itemCount: content.items.length,
        statuses: content.items.reduce((acc, item) => {
          acc[item.status || "未知"] = (acc[item.status || "未知"] || 0) + 1;
          return acc;
        }, {})
      };
    } else if (key === "audit-logs.json" && content && content.logs) {
      summary.dataFiles[key] = { logCount: content.logs.length };
    } else if (key === "box-slots.json" && content && content.slots) {
      summary.dataFiles[key] = { slotCount: content.slots.length };
    } else if (key === "chemical-batches.json" && content && content.batches) {
      summary.dataFiles[key] = { batchCount: content.batches.length };
    } else if (key === "defects.json" && content && content.defects) {
      summary.dataFiles[key] = { defectCount: content.defects.length };
    } else if (key === "delivery-batches.json" && content && content.batches) {
      summary.dataFiles[key] = { batchCount: content.batches.length };
    } else if (key === "process-templates.json" && content && content.templates) {
      summary.dataFiles[key] = { templateCount: content.templates.length };
    } else {
      summary.dataFiles[key] = { raw: true };
    }
  }

  return summary;
}

async function createBackup(note = "") {
  await ensureBackupDir();

  const backupData = {};
  for (const file of DATA_FILES) {
    const filePath = join(dataDir, file);
    if (existsSync(filePath)) {
      try {
        const content = JSON.parse(await readFile(filePath, "utf8"));
        backupData[file] = content;
      } catch (e) {
        backupData[file] = { error: e.message };
      }
    }
  }

  const ts = formatTimestamp();
  const filename = `backup-${ts}.json`;
  const filePath = join(backupDir, filename);

  const backupMeta = {
    _meta: {
      version: "1.0",
      createdAt: new Date().toISOString(),
      timestamp: ts,
      note: note || "",
      dataFiles: DATA_FILES.filter(f => backupData[f] && !backupData[f].error)
    },
    ...backupData
  };

  await writeFile(filePath, JSON.stringify(backupMeta, null, 2));

  const stats = await stat(filePath);
  return {
    filename,
    timestamp: ts,
    date: backupMeta._meta.createdAt,
    size: stats.size,
    note: note || ""
  };
}

async function deleteBackup(filename) {
  const info = parseBackupFilename(filename);
  if (!info) {
    throw new Error("无效的备份文件名");
  }
  const filePath = join(backupDir, filename);
  if (!existsSync(filePath)) {
    throw new Error("备份文件不存在");
  }
  await unlink(filePath);
  return { success: true, filename };
}

export {
  backupDir,
  dataDir,
  DATA_FILES,
  mainDbFile,
  ensureBackupDir,
  listBackups,
  readBackupFile,
  getBackupSummary,
  createBackup,
  deleteBackup,
  parseBackupFilename,
  formatTimestamp
};
