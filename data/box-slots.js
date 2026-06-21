import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "box-slots.json");

const seed = {
  slots: [
    {
      id: "BS-001",
      slotNo: "蓝盒A-03",
      capacity: 20,
      currentCount: 1,
      remark: "蓝色编号盒，18x24cm底片专用"
    },
    {
      id: "BS-002",
      slotNo: "蓝盒A-05",
      capacity: 20,
      currentCount: 0,
      remark: "蓝色编号盒，24x30cm底片专用"
    },
    {
      id: "BS-003",
      slotNo: "木盒B-01",
      capacity: 10,
      currentCount: 0,
      remark: "木质存放盒，大尺寸底片"
    }
  ]
};

async function loadBoxSlots() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveBoxSlots(db) {
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function newSlotId() {
  return "BS-" + Date.now();
}

export { loadBoxSlots, saveBoxSlots, newSlotId };
