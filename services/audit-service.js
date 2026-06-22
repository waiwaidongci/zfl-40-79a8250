import { addAuditLog, AUDIT_ACTION_TYPES, AUDIT_ACTION_LABELS } from "../data/audit-logs.js";

function summarizeItem(item) {
  const fields = ["code", "plateSize", "chemicalBatch", "exposure", "waterSource", "box", "status", "defect"];
  const summary = {};
  for (const f of fields) {
    if (item[f] !== undefined && item[f] !== null && item[f] !== "") {
      summary[f] = item[f];
    }
  }
  return summary;
}

async function auditCreateItem(item) {
  return addAuditLog({
    actionType: AUDIT_ACTION_TYPES.CREATE,
    itemCode: item.code || item.id,
    itemId: item.id,
    before: null,
    after: summarizeItem(item),
    summary: `新增底片 ${item.code || item.id}`
  });
}

async function auditUpdateStatus(item, oldStatus, newStatus, extraChanges = {}) {
  const before = { status: oldStatus, ...extraChanges.before || {} };
  const after = { status: newStatus, ...extraChanges.after || {} };
  return addAuditLog({
    actionType: AUDIT_ACTION_TYPES.UPDATE_STATUS,
    itemCode: item.code || item.id,
    itemId: item.id,
    before,
    after,
    summary: `状态从「${oldStatus}」变更为「${newStatus}」`
  });
}

async function auditAddNote(item, step, note) {
  return addAuditLog({
    actionType: AUDIT_ACTION_TYPES.ADD_NOTE,
    itemCode: item.code || item.id,
    itemId: item.id,
    before: null,
    after: { step, note },
    summary: `追加备注：${step} - ${note}`
  });
}

async function auditRecordStep(item, stepInput, beforeItem, afterItem) {
  const before = summarizeItem(beforeItem);
  const after = summarizeItem(afterItem);
  const stepName = stepInput.step || "工艺";
  const details = Object.entries(stepInput)
    .filter(([k, v]) => k !== "step" && v && v !== "")
    .map(([k, v]) => `${k}: ${v}`)
    .join(" · ");
  return addAuditLog({
    actionType: AUDIT_ACTION_TYPES.RECORD_STEP,
    itemCode: item.code || item.id,
    itemId: item.id,
    before,
    after,
    summary: `记录工艺步骤「${stepName}」${details ? `（${details}）` : ""}`
  });
}

async function auditSkipStep(item, stepName, skipReason) {
  return addAuditLog({
    actionType: AUDIT_ACTION_TYPES.SKIP_STEP,
    itemCode: item.code || item.id,
    itemId: item.id,
    before: null,
    after: { stepName, skipReason },
    summary: `跳过工艺步骤「${stepName}」，原因：${skipReason}`
  });
}

async function auditImport(importedCount, importedCodes, importLog, importedItems = []) {
  await addAuditLog({
    actionType: AUDIT_ACTION_TYPES.IMPORT,
    itemCode: null,
    itemId: null,
    before: null,
    after: { importedCount, importedCodes, importLog },
    summary: `批量导入 ${importedCount} 条底片：${importedCodes.join(", ")}`
  });

  for (const item of importedItems) {
    await addAuditLog({
      actionType: AUDIT_ACTION_TYPES.CREATE,
      itemCode: item.code || item.id,
      itemId: item.id,
      before: null,
      after: summarizeItem(item),
      summary: `新增底片 ${item.code || item.id}（批量导入）`
    });
  }
}

async function auditUpdateField(item, fieldName, oldValue, newValue) {
  return addAuditLog({
    actionType: AUDIT_ACTION_TYPES.UPDATE_FIELD,
    itemCode: item.code || item.id,
    itemId: item.id,
    before: { [fieldName]: oldValue },
    after: { [fieldName]: newValue },
    summary: `更新字段「${fieldName}」：从「${oldValue || "(空)"}」变更为「${newValue || "(空)"}」`
  });
}

export {
  auditCreateItem,
  auditUpdateStatus,
  auditAddNote,
  auditRecordStep,
  auditSkipStep,
  auditImport,
  auditUpdateField,
  AUDIT_ACTION_TYPES,
  AUDIT_ACTION_LABELS
};
