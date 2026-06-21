import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "chemical-batches.json");

const seed = {
  batches: [
    {
      id: "CB-001",
      batchNo: "B-0620",
      mixDate: "2026-06-20",
      formula: "标准蓝晒感光液配方",
      status: "可用",
      negativeCodes: ["CN-001"]
    }
  ]
};

async function loadBatches() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveBatches(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function newBatchId() {
  return "CB-" + Date.now();
}

export { loadBatches, saveBatches, newBatchId };
