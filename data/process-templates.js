import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getDataPath, ensureStudioDir } from "./studios.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const seed = {
  templates: [
    {
      id: "PT-STANDARD",
      name: "标准蓝晒工艺",
      description: "蓝晒底片标准工艺流程：涂布 → 晾干 → 曝光 → 冲洗 → 复晒 → 入盒",
      isDefault: true,
      createdAt: "2026-06-21T00:00:00.000Z",
      steps: [
        { key: "coating", name: "涂布", order: 1, description: "在洁净的玻璃板上均匀涂布感光液", requiredFields: ["note"], optionalFields: ["chemicalBatch", "developStatus"], allowSkip: true, estimatedDuration: "15分钟" },
        { key: "drying", name: "晾干", order: 2, description: "在避光通风处自然晾干至完全干燥", requiredFields: ["note"], optionalFields: ["developStatus"], allowSkip: true, estimatedDuration: "30-60分钟" },
        { key: "exposure", name: "曝光", order: 3, description: "使用紫外光源进行接触印相曝光", requiredFields: ["exposure", "note"], optionalFields: ["developStatus"], allowSkip: false, estimatedDuration: "5-15分钟" },
        { key: "developing", name: "冲洗", order: 4, description: "流水冲洗去除未反应的感光液，直至水流清澈", requiredFields: ["waterSource", "note"], optionalFields: ["developStatus", "defect", "repair"], allowSkip: false, targetStatus: "冲洗中", estimatedDuration: "10-20分钟" },
        { key: "re-exposure", name: "复晒", order: 5, description: "冲洗后再次曝光加深色调", requiredFields: ["note"], optionalFields: ["exposure", "developStatus", "defect", "repair"], allowSkip: true, estimatedDuration: "5-10分钟" },
        { key: "boxing", name: "入盒", order: 6, description: "完全干燥后放入指定存放盒位", requiredFields: ["box", "note"], optionalFields: ["developStatus", "defect", "repair"], allowSkip: false, targetStatus: "待入盒", estimatedDuration: "5分钟" }
      ],
      statusTransitions: { "涂布": "待曝光", "晾干": "待曝光", "曝光": "待曝光", "冲洗": "冲洗中", "复晒": "冲洗中", "入盒": "待入盒", "交付": "已交付" }
    },
    {
      id: "PT-EXPRESS",
      name: "快速工艺流程",
      description: "简化版工艺流程，适合小批量加急底片",
      isDefault: false,
      createdAt: "2026-06-21T00:00:00.000Z",
      steps: [
        { key: "coating", name: "涂布", order: 1, description: "涂布感光液", requiredFields: ["note"], optionalFields: ["chemicalBatch"], allowSkip: false, estimatedDuration: "15分钟" },
        { key: "exposure", name: "曝光", order: 2, description: "使用热风加速干燥后曝光", requiredFields: ["exposure", "note"], optionalFields: [], allowSkip: false, estimatedDuration: "10分钟" },
        { key: "developing", name: "冲洗", order: 3, description: "冲洗底片", requiredFields: ["waterSource", "note"], optionalFields: ["defect"], allowSkip: false, targetStatus: "冲洗中", estimatedDuration: "15分钟" },
        { key: "boxing", name: "入盒", order: 4, description: "入盒交付", requiredFields: ["box", "note"], optionalFields: [], allowSkip: false, targetStatus: "待入盒", estimatedDuration: "5分钟" }
      ],
      statusTransitions: { "涂布": "待曝光", "曝光": "待曝光", "冲洗": "冲洗中", "入盒": "待入盒", "交付": "已交付" }
    }
  ]
};

function getDbPath(studioId) {
  if (studioId) return getDataPath(studioId, "process-templates.json");
  return join(__dirname, "process-templates.json");
}

async function loadTemplates(studioId) {
  const dbPath = getDbPath(studioId);
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}

async function saveTemplates(db, studioId) {
  const dbPath = getDbPath(studioId);
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}

function newTemplateId() {
  return "PT-" + Date.now();
}

function getDefaultTemplate(templates) {
  return templates.find(t => t.isDefault) || templates[0] || null;
}

function getStepByKey(template, stepKey) {
  return template.steps.find(s => s.key === stepKey) || null;
}

function getStepByName(template, stepName) {
  return template.steps.find(s => s.name === stepName) || null;
}

function getNextSteps(template, completedStepKeys = []) {
  const completed = new Set(completedStepKeys);
  return template.steps.filter(s => !completed.has(s.key)).sort((a, b) => a.order - b.order);
}

function getCurrentStep(template, completedStepKeys = []) {
  const next = getNextSteps(template, completedStepKeys);
  return next.length > 0 ? next[0] : null;
}

export {
  loadTemplates,
  saveTemplates,
  newTemplateId,
  getDefaultTemplate,
  getStepByKey,
  getStepByName,
  getNextSteps,
  getCurrentStep
};
