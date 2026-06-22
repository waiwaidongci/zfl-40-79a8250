import { loadTemplates, getStepByName, getStepByKey, getNextSteps, getCurrentStep } from "../data/process-templates.js";

const DEFAULT_STATUS_MAP = {
  "涂布": "待曝光",
  "晾干": "待曝光",
  "曝光": "待曝光",
  "冲洗": "冲洗中",
  "复晒": "冲洗中",
  "入盒": "待入盒",
  "交付": "已交付"
};

const LEGACY_STEP_NAMES = ["涂布", "晾干", "曝光", "冲洗", "复晒", "入盒", "交付"];

function hasTemplate(item) {
  return !!(item && item.templateId && item.processSteps);
}

function ensureProcessStructure(item, template) {
  if (!item) return item;
  if (!item.processSteps && template) {
    item.processSteps = template.steps.map(step => ({
      key: step.key,
      name: step.name,
      order: step.order,
      status: "pending",
      completedAt: null,
      skipped: false,
      skipReason: null,
      records: []
    }));
  }
  item.logs = item.logs || [];
  item.steps = item.steps || [];
  return item;
}

function getCompletedStepKeys(item) {
  if (!item.processSteps) return [];
  return item.processSteps
    .filter(s => s.status === "completed" || s.status === "skipped")
    .map(s => s.key);
}

function resolveTargetStatus(stepName, template, item) {
  if (template && template.statusTransitions && template.statusTransitions[stepName]) {
    return template.statusTransitions[stepName];
  }
  if (hasTemplate(item) && item.processSteps) {
    const step = item.processSteps.find(s => s.name === stepName);
    if (step && step.targetStatus) return step.targetStatus;
  }
  return DEFAULT_STATUS_MAP[stepName] || "待曝光";
}

function validateRequiredFields(step, input) {
  const errors = [];
  const required = step.requiredFields || [];
  for (const field of required) {
    const key = field === "note" ? "note" : field;
    if (!input[key] || (typeof input[key] === "string" && !input[key].trim())) {
      errors.push(`必填项缺失：${field}`);
    }
  }
  return errors;
}

async function createItemWithTemplate(item, templateId, templateDb, studioId) {
  const db = templateDb || await loadTemplates(studioId);
  const templates = db.templates || [];
  const template = templateId
    ? templates.find(t => t.id === templateId)
    : templates.find(t => t.isDefault) || templates[0];

  if (!template) {
    return { item, templateUsed: false };
  }

  item.templateId = template.id;
  item.templateName = template.name;
  ensureProcessStructure(item, template);

  item.logs = item.logs || [];
  item.logs.push({
    at: new Date().toISOString(),
    step: "建档",
    note: `使用模板「${template.name}」创建，共${template.steps.length}个工艺步骤`
  });

  return { item, templateUsed: true, template };
}

async function recordStepAction(item, input, templateDb, studioId) {
  const now = new Date().toISOString();
  const stepName = input.step || "工艺";

  if (hasTemplate(item)) {
    const db = templateDb || await loadTemplates(studioId);
    const template = (db.templates || []).find(t => t.id === item.templateId);
    if (!template) {
      return { error: "关联的模板不存在，无法记录步骤" };
    }
    const stepDef = getStepByName(template, stepName);
    if (!stepDef) {
      return { error: `步骤「${stepName}」不在模板「${template.name}」中` };
    }
    const completedKeys = getCompletedStepKeys(item);
    const current = getCurrentStep(template, completedKeys);
    if (current && current.key !== stepDef.key) {
      return { error: `当前应完成「${current.name}」（第${current.order}步），不能跳到「${stepName}」` };
    }
    const procStep = item.processSteps.find(s => s.key === stepDef.key);
    if (procStep && (procStep.status === "completed" || procStep.status === "skipped")) {
      return { error: `步骤「${stepName}」已完成或已跳过，不可重复记录` };
    }
    const validationErrors = validateRequiredFields(stepDef, input);
    if (validationErrors.length) {
      return { error: validationErrors.join("; ") };
    }
  }

  item.logs = item.logs || [];
  item.steps = item.steps || [];
  item.steps.push({ at: now, ...input });

  if (input.defect) item.defect = input.defect;
  if (input.box !== undefined && input.box !== null && input.box !== '') item.box = input.box;

  item.status = resolveTargetStatus(stepName, null, item);

  const logNote = [
    input.box ? `盒位：${input.box}` : null,
    input.exposure ? `曝光：${input.exposure}` : null,
    input.waterSource ? `水源：${input.waterSource}` : null,
    input.note || input.developStatus || "步骤记录"
  ].filter(Boolean).join(" · ");

  item.logs.push({ at: now, step: stepName, note: logNote });

  if (hasTemplate(item)) {
    const db = templateDb || await loadTemplates(studioId);
    const template = (db.templates || []).find(t => t.id === item.templateId);
    const step = template ? getStepByName(template, stepName) : null;
    if (step) {
      const procStep = item.processSteps.find(s => s.key === step.key);
      if (procStep && procStep.status !== "completed" && procStep.status !== "skipped") {
        procStep.status = "completed";
        procStep.completedAt = now;
        procStep.skipped = false;
        procStep.skipReason = null;
        procStep.records.push({ at: now, ...input });
        if (step.targetStatus) {
          item.status = step.targetStatus;
        }
      }
    }
  }

  return { item };
}

async function skipStep(item, stepKey, skipReason, templateDb, studioId) {
  if (!skipReason || !skipReason.trim()) {
    return { success: false, error: "跳过步骤必须填写原因" };
  }
  if (!hasTemplate(item)) {
    return { success: false, error: "该底片未使用流程模板，无法跳过指定步骤" };
  }
  const db = templateDb || await loadTemplates(studioId);
  const template = (db.templates || []).find(t => t.id === item.templateId);
  if (!template) {
    return { success: false, error: "模板不存在" };
  }
  const stepDef = getStepByKey(template, stepKey);
  if (!stepDef) {
    return { success: false, error: "步骤不存在" };
  }
  if (!stepDef.allowSkip) {
    return { success: false, error: `「${stepDef.name}」为必做步骤，不允许跳过` };
  }
  const completedKeys = getCompletedStepKeys(item);
  const current = getCurrentStep(template, completedKeys);
  if (current && current.key !== stepKey) {
    return { success: false, error: `当前应完成「${current.name}」（第${current.order}步），不能跳到「${stepDef.name}」` };
  }
  const procStep = item.processSteps.find(s => s.key === stepKey);
  if (!procStep) {
    return { success: false, error: "底片流程步骤中未找到该步骤" };
  }
  if (procStep.status === "completed") {
    return { success: false, error: "该步骤已完成，不能再跳过" };
  }
  if (procStep.status === "skipped") {
    return { success: false, error: "该步骤已跳过" };
  }
  const now = new Date().toISOString();
  procStep.status = "skipped";
  procStep.completedAt = now;
  procStep.skipped = true;
  procStep.skipReason = skipReason.trim();
  procStep.records.push({ at: now, skip: true, reason: skipReason.trim() });

  item.logs = item.logs || [];
  item.logs.push({
    at: now,
    step: stepDef.name,
    note: `[跳过] 原因：${skipReason.trim()}`
  });

  return { success: true, item };
}

async function getItemProcessInfo(item, templateDb, studioId) {
  const db = templateDb || await loadTemplates(studioId);
  const templates = db.templates || [];

  if (!hasTemplate(item)) {
    return {
      usingTemplate: false,
      template: null,
      processSteps: null,
      currentStep: null,
      nextSteps: LEGACY_STEP_NAMES,
      completedCount: 0,
      totalCount: 0,
      progress: 0,
      legacyMode: true,
      legacySteps: (item.steps || []).slice()
    };
  }

  const template = templates.find(t => t.id === item.templateId) || null;
  const completedKeys = getCompletedStepKeys(item);
  const nextStepsArr = getNextSteps(template, completedKeys);
  const current = getCurrentStep(template, completedKeys);
  const total = item.processSteps.length;
  const completed = item.processSteps.filter(s => s.status === "completed" || s.status === "skipped").length;

  return {
    usingTemplate: true,
    template,
    processSteps: item.processSteps,
    currentStep: current,
    nextSteps: nextStepsArr,
    completedCount: completed,
    totalCount: total,
    progress: total > 0 ? Math.round((completed / total) * 100) : 0,
    legacyMode: false
  };
}

function getAvailableStepFields(item, templateDb) {
  const fieldDefs = [
    { key: "step", label: "步骤", type: "select" },
    { key: "developStatus", label: "显影状态", type: "text" },
    { key: "exposure", label: "曝光时间", type: "text" },
    { key: "waterSource", label: "冲洗水源", type: "text" },
    { key: "chemicalBatch", label: "药液批次", type: "text" },
    { key: "defect", label: "缺陷类型", type: "select-defect" },
    { key: "repair", label: "修补记录", type: "textarea" },
    { key: "box", label: "存放盒位", type: "select-box" },
    { key: "note", label: "备注", type: "textarea" }
  ];

  if (!hasTemplate(item)) {
    return {
      allFields: fieldDefs,
      requiredFields: ["note"],
      stepFieldRequired: true
    };
  }

  const info = getProcessInfoSync(item, templateDb);
  if (!info.template || !info.currentStep) {
    return {
      allFields: fieldDefs,
      requiredFields: ["note"],
      stepFieldRequired: true
    };
  }

  const step = info.currentStep;
  const requiredKeys = step.requiredFields || [];
  const optionalKeys = step.optionalFields || [];

  const availableKeys = ["step", ...requiredKeys, ...optionalKeys];
  const available = fieldDefs.filter(f => availableKeys.includes(f.key));

  const stepField = available.find(f => f.key === "step");
  if (stepField) {
    stepField.defaultValue = step.name;
    stepField.readonly = true;
  }

  if (!requiredKeys.includes("note") && !optionalKeys.includes("note")) {
    if (!available.find(f => f.key === "note")) {
      available.push(fieldDefs.find(f => f.key === "note"));
    }
  }

  return {
    allFields: available,
    requiredFields: requiredKeys,
    stepFieldRequired: true,
    currentStep: step
  };
}

function getProcessInfoSync(item, templateDb) {
  const templates = (templateDb && templateDb.templates) || [];
  if (!hasTemplate(item)) {
    return {
      usingTemplate: false,
      template: null,
      currentStep: null,
      nextSteps: LEGACY_STEP_NAMES.map(name => ({ name, key: name.toLowerCase() })),
      completedCount: 0,
      totalCount: 0,
      progress: 0
    };
  }
  const template = templates.find(t => t.id === item.templateId) || null;
  const completedKeys = getCompletedStepKeys(item);
  const next = template ? getNextSteps(template, completedKeys) : [];
  const total = item.processSteps.length;
  const done = item.processSteps.filter(s => s.status === "completed" || s.status === "skipped").length;
  return {
    usingTemplate: true,
    template,
    currentStep: next.length > 0 ? next[0] : null,
    nextSteps: next,
    completedCount: done,
    totalCount: total,
    progress: total > 0 ? Math.round((done / total) * 100) : 0
  };
}

export {
  hasTemplate,
  ensureProcessStructure,
  getCompletedStepKeys,
  resolveTargetStatus,
  validateRequiredFields,
  createItemWithTemplate,
  recordStepAction,
  skipStep,
  getItemProcessInfo,
  getAvailableStepFields,
  getProcessInfoSync,
  LEGACY_STEP_NAMES,
  DEFAULT_STATUS_MAP
};
