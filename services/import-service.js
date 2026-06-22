const FIELD_MAPPINGS = {
  "code": ["code", "编号", "底片编号", "底片code", "编码"],
  "plateSize": ["platesize", "尺寸", "玻璃板尺寸", "规格", "大小"],
  "chemicalBatch": ["chemicalbatch", "batch", "药液批次", "批次", "药液batch"],
  "exposure": ["exposure", "曝光时间", "曝光", "曝光时长"],
  "waterSource": ["watersource", "水源", "冲洗水源", "用水"],
  "box": ["box", "盒位", "存放盒位", "盒子", "存放位置"],
  "status": ["status", "状态", "当前状态"],
  "defect": ["defect", "缺陷", "缺陷类型", "瑕疵"]
};

const REQUIRED_FIELDS = ["code"];
const VALID_STATUSES = ["待曝光", "冲洗中", "待入盒", "已交付"];

function parseCSV(csvText) {
  const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim());
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = parseCSVLine(lines[0]).map(h => h.trim());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length > 0 && values.some(v => v.trim())) {
      const row = {};
      headers.forEach((header, idx) => {
        row[header] = values[idx] !== undefined ? values[idx].trim() : "";
      });
      rows.push(row);
    }
  }

  return { headers, rows };
}

function parseCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
}

function mapHeadersToFields(headers) {
  const mapping = {};
  const unmapped = [];

  for (const header of headers) {
    const lowerHeader = header.toLowerCase().trim();
    let mapped = null;

    for (const [field, aliases] of Object.entries(FIELD_MAPPINGS)) {
      if (aliases.some(alias => alias.toLowerCase() === lowerHeader)) {
        mapped = field;
        break;
      }
    }

    if (mapped) {
      mapping[header] = mapped;
    } else {
      unmapped.push(header);
    }
  }

  return { mapping, unmapped };
}

function normalizeRow(row, headerMapping) {
  const normalized = {};
  for (const [header, value] of Object.entries(row)) {
    const field = headerMapping[header];
    if (field) {
      normalized[field] = value;
    }
  }
  return normalized;
}

function validateImport(rows, existingItems, headerMapping) {
  const errors = [];
  const warnings = [];
  const duplicateCodes = [];
  const missingRequired = [];
  const validRows = [];
  const invalidRows = [];

  const seenCodes = new Set();
  const existingCodes = new Set(existingItems.map(item => item.code).filter(Boolean));

  rows.forEach((row, index) => {
    const normalized = normalizeRow(row, headerMapping);
    const rowErrors = [];
    const rowNum = index + 2;

    if (!normalized.code || !normalized.code.trim()) {
      rowErrors.push("缺少底片编号");
      missingRequired.push({ row: rowNum, field: "code" });
    } else {
      const code = normalized.code.trim();
      if (seenCodes.has(code)) {
        rowErrors.push(`编号「${code}」在导入文件中重复`);
        if (!duplicateCodes.includes(code)) duplicateCodes.push(code);
      }
      seenCodes.add(code);

      if (existingCodes.has(code)) {
        rowErrors.push(`编号「${code}」已存在于系统中`);
        if (!duplicateCodes.includes(code)) duplicateCodes.push(code);
      }
    }

    if (normalized.status && !VALID_STATUSES.includes(normalized.status)) {
      warnings.push({ row: rowNum, message: `状态「${normalized.status}」无效，将使用默认状态「待曝光」` });
      normalized.status = "待曝光";
    }

    if (rowErrors.length > 0) {
      invalidRows.push({ row: rowNum, data: normalized, errors: rowErrors });
    } else {
      validRows.push({ row: rowNum, data: normalized });
    }
  });

  for (const field of REQUIRED_FIELDS) {
    const hasField = Object.values(headerMapping).includes(field);
    if (!hasField) {
      errors.push(`缺少必填字段映射：${field}（底片编号）`);
    }
  }

  return {
    errors,
    warnings,
    duplicateCodes,
    missingRequired,
    validRows,
    invalidRows,
    totalRows: rows.length,
    willCreate: validRows.length
  };
}

function createImportItem(normalizedData) {
  const now = new Date().toISOString();
  const item = {
    id: "CN-" + Date.now() + "-" + Math.random().toString(36).substr(2, 9),
    code: normalizedData.code,
    plateSize: normalizedData.plateSize || "",
    chemicalBatch: normalizedData.chemicalBatch || "",
    exposure: normalizedData.exposure || "",
    waterSource: normalizedData.waterSource || "",
    box: normalizedData.box || "",
    status: normalizedData.status || "待曝光",
    defect: normalizedData.defect || "",
    logs: [{
      at: now,
      step: "建档",
      note: "批量导入创建底片"
    }],
    steps: [],
    importedAt: now,
    importSource: "batch-import"
  };

  return item;
}

export {
  parseCSV,
  mapHeadersToFields,
  validateImport,
  createImportItem,
  FIELD_MAPPINGS,
  REQUIRED_FIELDS,
  VALID_STATUSES
};
