import { mkdir, readFile, writeFile, readdir, copyFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const studiosDbPath = join(__dirname, "studios.json");
const studiosDir = join(__dirname, "studios");

const DEFAULT_STUDIO = {
  id: "default",
  name: "默认工作室",
  description: "系统默认工作室",
  createdAt: "2026-06-22T00:00:00.000Z"
};

const OLD_DATA_FILES = [
  "cyanotype-negative-room.json",
  "audit-logs.json",
  "box-slots.json",
  "chemical-batches.json",
  "defects.json",
  "delivery-batches.json",
  "process-templates.json"
];

async function ensureStudiosDir() {
  if (!existsSync(studiosDir)) {
    await mkdir(studiosDir, { recursive: true });
  }
}

async function loadStudiosDb() {
  if (!existsSync(studiosDbPath)) {
    const db = { studios: [{ ...DEFAULT_STUDIO }] };
    await mkdir(dirname(studiosDbPath), { recursive: true });
    await writeFile(studiosDbPath, JSON.stringify(db, null, 2));
    return db;
  }
  return JSON.parse(await readFile(studiosDbPath, "utf8"));
}

async function saveStudiosDb(db) {
  await writeFile(studiosDbPath, JSON.stringify(db, null, 2));
}

function getStudioDir(studioId) {
  return join(studiosDir, studioId);
}

function getDataPath(studioId, filename) {
  return join(studiosDir, studioId, filename);
}

async function ensureStudioDir(studioId) {
  const dir = getStudioDir(studioId);
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

async function migrateOldFiles() {
  const db = await loadStudiosDb();
  if (db.migrated) return false;

  const hasOldFiles = OLD_DATA_FILES.some(f => existsSync(join(__dirname, f)));
  if (!hasOldFiles) {
    db.migrated = true;
    await saveStudiosDb(db);
    return false;
  }

  await ensureStudioDir("default");

  for (const file of OLD_DATA_FILES) {
    const oldPath = join(__dirname, file);
    const newPath = getDataPath("default", file);
    if (existsSync(oldPath) && !existsSync(newPath)) {
      await copyFile(oldPath, newPath);
    }
  }

  db.migrated = true;
  await saveStudiosDb(db);
  return true;
}

async function createStudio(input) {
  const db = await loadStudiosDb();
  const id = "studio-" + Date.now() + "-" + Math.random().toString(36).substr(2, 6);
  const studio = {
    id,
    name: input.name || "新工作室",
    description: input.description || "",
    createdAt: new Date().toISOString()
  };
  db.studios.push(studio);
  await saveStudiosDb(db);
  await ensureStudioDir(id);
  return studio;
}

async function updateStudio(id, input) {
  const db = await loadStudiosDb();
  const studio = db.studios.find(s => s.id === id);
  if (!studio) return null;
  if (input.name !== undefined) studio.name = input.name;
  if (input.description !== undefined) studio.description = input.description;
  await saveStudiosDb(db);
  return studio;
}

async function deleteStudio(id) {
  if (id === "default") return { error: "不能删除默认工作室" };
  const db = await loadStudiosDb();
  const idx = db.studios.findIndex(s => s.id === id);
  if (idx === -1) return { error: "工作室不存在" };
  const removed = db.studios.splice(idx, 1)[0];
  await saveStudiosDb(db);
  return { studio: removed };
}

async function listStudios() {
  const db = await loadStudiosDb();
  return db.studios;
}

async function getStudio(id) {
  const db = await loadStudiosDb();
  return db.studios.find(s => s.id === id) || null;
}

export {
  loadStudiosDb,
  saveStudiosDb,
  getStudioDir,
  getDataPath,
  ensureStudioDir,
  ensureStudiosDir,
  migrateOldFiles,
  createStudio,
  updateStudio,
  deleteStudio,
  listStudios,
  getStudio,
  OLD_DATA_FILES,
  studiosDir
};
