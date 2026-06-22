const ImportUI = (function() {
  const FIELD_LABELS = {
    "code": "底片编号",
    "plateSize": "玻璃板尺寸",
    "chemicalBatch": "药液批次",
    "exposure": "曝光时间",
    "waterSource": "冲洗水源",
    "box": "存放盒位",
    "status": "状态",
    "defect": "缺陷类型"
  };
  const VALID_FIELDS = ["", "code", "plateSize", "chemicalBatch", "exposure", "waterSource", "box", "status", "defect"];

  let currentCsvText = "";
  let currentPreview = null;
  let selectedRows = new Set();

  function init() {
    const fileInput = document.getElementById('fileInput');
    const dropZone = document.getElementById('dropZone');
    const csvTextarea = document.getElementById('csvTextarea');
    const previewBtn = document.getElementById('previewBtn');
    const clearBtn = document.getElementById('clearBtn');
    const step1 = document.getElementById('step1');
    const step2 = document.getElementById('step2');
    const step3 = document.getElementById('step3');
    const backBtn = document.getElementById('backBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const confirmBtn = document.getElementById('confirmBtn');
    const selectAll = document.getElementById('selectAll');

    document.querySelectorAll('.tabs button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      };
    });

    function updatePreviewBtn() {
      const hasFile = fileInput.files.length > 0;
      const hasText = csvTextarea.value.trim().length > 0;
      previewBtn.disabled = !(hasFile || hasText);
    }

    fileInput.addEventListener('change', updatePreviewBtn);
    csvTextarea.addEventListener('input', updatePreviewBtn);

    dropZone.addEventListener('dragover', e => { e.preventDefault(); dropZone.classList.add('dragover'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('dragover'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      if (e.dataTransfer.files.length > 0) {
        fileInput.files = e.dataTransfer.files;
        updatePreviewBtn();
      }
    });

    clearBtn.onclick = () => {
      fileInput.value = '';
      csvTextarea.value = '';
      updatePreviewBtn();
    };

    let previewing = false;

    previewBtn.onclick = async () => {
      if (previewing) return;
      previewing = true;
      previewBtn.disabled = true;

      try {
        let body, contentType;
        if (fileInput.files.length > 0) {
          const formData = new FormData();
          formData.append('file', fileInput.files[0]);
          body = formData;
          contentType = null;
        } else {
          body = JSON.stringify({ csvText: csvTextarea.value });
          contentType = 'application/json';
        }

        const res = await fetch('/api/import/preview', { method: 'POST', body, headers: contentType ? { 'Content-Type': contentType } : {} });
        currentPreview = await res.json();
        if (!res.ok) throw new Error(currentPreview.error || '预览失败');

        if (fileInput.files.length > 0) {
          currentCsvText = await readFileAsText(fileInput.files[0]);
        } else {
          currentCsvText = csvTextarea.value;
        }

        renderPreview();
        step1.classList.add('hidden');
        step2.classList.remove('hidden');
      } catch (e) {
        alert('预览失败：' + e.message);
      } finally {
        previewing = false;
        updatePreviewBtn();
      }
    };

    backBtn.onclick = () => {
      step2.classList.add('hidden');
      step1.classList.remove('hidden');
    };

    cancelBtn.onclick = () => {
      step2.classList.add('hidden');
      step1.classList.remove('hidden');
    };

    let submitting = false;

    confirmBtn.onclick = async () => {
      if (submitting) return;
      if (selectedRows.size === 0) {
        alert('请至少选择一条记录');
        return;
      }
      if (!confirm('确认导入 ' + selectedRows.size + ' 条底片记录？')) return;

      submitting = true;
      confirmBtn.disabled = true;
      const countSpan = document.getElementById('confirmCount');
      const originalText = countSpan.textContent;
      countSpan.textContent = '(导入中...)';

      try {
        const result = await api('/api/import/confirm', {
          method: 'POST',
          body: JSON.stringify({
            csvText: currentCsvText,
            confirmedRows: Array.from(selectedRows)
          })
        });

        step2.classList.add('hidden');
        step3.classList.remove('hidden');

        document.getElementById('successMessage').innerHTML =
          '成功创建 <b>' + result.created + '</b> 条底片记录。<br>' +
          '所有底片已自动补建档日志，可在整理室中搜索、筛选和记录工艺步骤。';

        document.getElementById('resultBody').innerHTML = result.items.map(item => {
          const archiveLogs = (item.logs || []).filter(l => l.step === '建档').map(l => l.note).join('; ') || '-';
          return '<tr>' +
            '<td>' + item.code + '</td>' +
            '<td>' + (item.plateSize || '-') + '</td>' +
            '<td><span class="pill info">' + item.status + '</span></td>' +
            '<td>' + (item.box || '-') + '</td>' +
            '<td>' + archiveLogs + '</td>' +
          '</tr>';
        }).join('');
      } catch (e) {
        alert('导入失败：' + e.message);
      } finally {
        submitting = false;
        confirmBtn.disabled = selectedRows.size === 0;
        updateConfirmCount();
      }
    };

    selectAll.onchange = () => {
      const p = currentPreview;
      if (selectAll.checked) {
        p.validRows.forEach(r => selectedRows.add(r.row));
      } else {
        selectedRows.clear();
      }
      document.querySelectorAll('.row-check').forEach(cb => {
        cb.checked = selectAll.checked && !cb.disabled;
      });
      updateConfirmCount();
    };
  }

  function api(path, options) {
    return fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options)
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      });
  }

  function readFileAsText(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result);
      reader.onerror = reject;
      reader.readAsText(file, 'UTF-8');
    });
  }

  function renderPreview() {
    const p = currentPreview;
    document.getElementById('totalRows').textContent = p.totalRows;
    document.getElementById('willCreate').textContent = p.willCreate;
    document.getElementById('duplicateCount').textContent = p.duplicateCodes.length;
    document.getElementById('missingCount').textContent = p.missingRequired.length;
    document.getElementById('unmappedCount').textContent = p.unmapped.length;

    const mappingGrid = document.getElementById('fieldMappingGrid');
    mappingGrid.innerHTML = p.headers.map(header => {
      const mapped = p.mapping[header];
      const optionsHtml = VALID_FIELDS.map(f => {
        const label = f ? FIELD_LABELS[f] + ' (' + f + ')' : '-- 不导入 --';
        const selected = f === mapped ? 'selected' : '';
        return '<option value="' + f + '" ' + selected + '>' + label + '</option>';
      }).join('');
      return '<div><span class="' + (mapped ? 'mapped' : 'unmapped') + '">' + header + '</span></div>' +
             '<div><select data-header="' + header + '">' + optionsHtml + '</select></div>';
    }).join('');

    mappingGrid.querySelectorAll('select').forEach(sel => {
      sel.onchange = () => remapField(sel.dataset.header, sel.value);
    });

    const warningsPanel = document.getElementById('warningsPanel');
    if (p.warnings.length > 0) {
      warningsPanel.classList.remove('hidden');
      document.getElementById('warningsList').innerHTML = p.warnings.map(w =>
        '<div class="meta">第' + w.row + '行：' + w.message + '</div>'
      ).join('');
    } else {
      warningsPanel.classList.add('hidden');
    }

    const errorsPanel = document.getElementById('errorsPanel');
    if (p.errors.length > 0) {
      errorsPanel.classList.remove('hidden');
      document.getElementById('errorsList').innerHTML = p.errors.map(e =>
        '<div class="error">' + e + '</div>'
      ).join('');
    } else {
      errorsPanel.classList.add('hidden');
    }

    selectedRows = new Set(p.validRows.map(r => r.row));
    selectAll.checked = selectedRows.size > 0;
    updateConfirmCount();

    const thead = document.getElementById('previewHead');
    thead.innerHTML = '<th>选择</th><th>行号</th>' + p.headers.map(h => '<th>' + h + '</th>').join('') + '<th>状态</th>';

    const tbody = document.getElementById('previewBody');
    const allRows = [...p.validRows, ...p.invalidRows].sort((a,b) => a.row - b.row);
    tbody.innerHTML = allRows.map(r => {
      const isValid = p.validRows.some(v => v.row === r.row);
      const checked = selectedRows.has(r.row);
      const cells = p.headers.map(h => '<td>' + (r.data[p.mapping[h]] ?? '') + '</td>').join('');
      const statusPill = isValid
        ? '<span class="pill success">有效</span>'
        : '<span class="pill warn">' + r.errors.join('; ') + '</span>';
      return '<tr class="' + (isValid ? '' : 'invalid') + '">' +
        '<td><input type="checkbox" class="row-check" data-row="' + r.row + '" ' +
          (isValid && checked ? 'checked' : '') + ' ' + (isValid ? '' : 'disabled') + '></td>' +
        '<td>' + r.row + '</td>' +
        cells +
        '<td>' + statusPill + '</td>' +
      '</tr>';
    }).join('');

    tbody.querySelectorAll('.row-check').forEach(cb => {
      cb.onchange = () => {
        const rowNum = parseInt(cb.dataset.row);
        if (cb.checked) selectedRows.add(rowNum);
        else selectedRows.delete(rowNum);
        updateConfirmCount();
      };
    });

    document.getElementById('confirmBtn').disabled = selectedRows.size === 0;
  }

  function updateConfirmCount() {
    document.getElementById('confirmCount').textContent = '(' + selectedRows.size + ' 条)';
    document.getElementById('confirmBtn').disabled = selectedRows.size === 0;
  }

  function remapField(header, newField) {
    const newMapping = { ...currentPreview.mapping };
    if (newField) {
      newMapping[header] = newField;
    } else {
      delete newMapping[header];
    }

    const { headers, rows } = parseCSVLocal(currentCsvText);
    const validation = validateImportLocal(rows, newMapping);

    currentPreview = {
      ...currentPreview,
      headers,
      mapping: newMapping,
      unmapped: headers.filter(h => !newMapping[h]),
      ...validation
    };

    renderPreview();
  }

  function parseCSVLocal(csvText) {
    const lines = csvText.trim().split(/\r?\n/).filter(line => line.trim());
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, ''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const values = parseCSVLineLocal(lines[i]);
      const row = {};
      headers.forEach((h, idx) => row[h] = values[idx] !== undefined ? values[idx].trim() : '');
      rows.push(row);
    }
    return { headers, rows };
  }

  function parseCSVLineLocal(line) {
    const result = [];
    let current = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
      const char = line[i];
      if (char === '"') {
        if (inQuotes && line[i+1] === '"') { current += '"'; i++; }
        else inQuotes = !inQuotes;
      } else if (char === ',' && !inQuotes) {
        result.push(current);
        current = '';
      } else {
        current += char;
      }
    }
    result.push(current);
    return result;
  }

  function validateImportLocal(rows, headerMapping) {
    const validRows = [];
    const invalidRows = [];
    const seenCodes = new Set();
    const existingCodes = new Set();
    const duplicateCodes = [];
    const missingRequired = [];
    const warnings = [];
    const errors = [];
    const validStatuses = ["待曝光","冲洗中","待入盒","已交付"];

    rows.forEach((row, index) => {
      const normalized = {};
      for (const [h, v] of Object.entries(row)) {
        const f = headerMapping[h];
        if (f) normalized[f] = v;
      }
      const rowErrors = [];
      const rowNum = index + 2;

      if (!normalized.code || !normalized.code.trim()) {
        rowErrors.push('缺少底片编号');
        missingRequired.push({ row: rowNum, field: 'code' });
      } else {
        const code = normalized.code.trim();
        if (seenCodes.has(code)) {
          rowErrors.push('编号重复');
          if (!duplicateCodes.includes(code)) duplicateCodes.push(code);
        }
        seenCodes.add(code);
        if (existingCodes.has(code)) {
          rowErrors.push('编号已存在');
          if (!duplicateCodes.includes(code)) duplicateCodes.push(code);
        }
      }

      if (normalized.status && !validStatuses.includes(normalized.status)) {
        warnings.push({ row: rowNum, message: '状态无效' });
      }

      if (rowErrors.length > 0) {
        invalidRows.push({ row: rowNum, data: normalized, errors: rowErrors });
      } else {
        validRows.push({ row: rowNum, data: normalized });
      }
    });

    if (!Object.values(headerMapping).includes('code')) {
      errors.push('缺少必填字段：底片编号(code)');
    }

    return { validRows, invalidRows, duplicateCodes, missingRequired, warnings, errors, totalRows: rows.length, willCreate: validRows.length };
  }

  return {
    init: init
  };
})();

document.addEventListener('DOMContentLoaded', () => {
  ImportUI.init();
});
