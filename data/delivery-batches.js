import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "delivery-batches.json");

const seed = {
  batches: [
    {
      id: "DB-001",
      batchNo: "D-20260620-01",
      customer: "示例客户A",
      deliveryDate: "2026-06-20",
      note: "首批交付样片",
      createdAt: "2026-06-20T10:00:00.000Z",
      items: [
        {
          itemId: "CN-001",
          code: "CN-001",
          confirmed: true,
          addedAt: "2026-06-20T10:00:00.000Z"
        }
      ]
    }
  ]
};

async function loadDeliveryBatches() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveDeliveryBatches(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function newBatchId() {
  return "DB-" + Date.now();
}

export { loadDeliveryBatches, saveDeliveryBatches, newBatchId };
