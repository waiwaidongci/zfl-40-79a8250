window.ProcessUI = (function () {
  let templates = [];
  let currentEditingTemplate = null;
  let editingStepIndex = -1;

  const FIELD_OPTIONS = [
    { key: "step", label: "步骤名称" },
    { key: "developStatus", label: "显影状态" },
    { key: "exposure", label: "曝光时间" },
    { key: "waterSource", label: "冲洗水源" },
    { key: "chemicalBatch", label: "药液批次" },
    { key: "defect", label: "缺陷类型" },
    { key: "repair", label: "修补记录" },
    { key: "box", label: "存放盒位" },
    { key: "note", label: "备注记录" }
  ];

  async function api(path, options) {
    const studioId = localStorage.getItem('currentStudioId') || 'default';
    const sep = path.includes('?') ? '&' : '?';
    const studioPath = path + sep + 'studioId=' + encodeURIComponent(studioId);
    const res = await fetch(
      studioPath,
      options && options.body
        ? { ...options, headers: { "Content-Type": "application/json" } }
        : options
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  async function load() {
    templates = await api("/api/process-templates");
    return templates;
  }

  function getTemplates() {
    return templates;
  }

  function findById(id) {
    return templates.find(t => t.id === id);
  }

  function getDefault() {
    return templates.find(t => t.isDefault) || templates[0] || null;
  }

  function renderManagerPanel() {
    return `
      <div class="panel" style="margin-top:14px">
        <h2>工艺流程模板管理</h2>
        <div style="margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap">
          <select id="templateListSelect" style="flex:1;min-width:200px"></select>
          <button id="templateNewBtn" type="button">新建模板</button>
          <button id="templateSetDefaultBtn" type="button" class="secondary">设为默认</button>
          <button id="templateDeleteBtn" type="button" style="background:var(--warn)">删除模板</button>
        </div>
        <div id="templateEditArea" style="border:1px solid var(--line);border-radius:6px;padding:12px;margin-top:10px">
          <div id="templateEmptyHint" class="meta">请选择或新建一个模板</div>
          <div id="templateEditForm" style="display:none">
            <label>模板名称</label><input id="tmplName" placeholder="例如：标准蓝晒工艺">
            <label>模板说明</label><textarea id="tmplDesc" rows="2" placeholder="描述模板用途和特点"></textarea>
            <label style="display:flex;align-items:center;gap:8px;margin-top:12px">
              <input type="checkbox" id="tmplIsDefault"> <span>设为默认模板</span>
            </label>
            <h3 style="font-size:15px;margin:14px 0 8px">工艺步骤</h3>
            <div id="templateStepsList" style="margin-bottom:10px"></div>
            <button type="button" id="templateAddStepBtn" class="secondary">+ 添加步骤</button>
            <div style="border-top:1px solid var(--line);margin-top:14px 0;padding-top:12px">
              <h3 style="font-size:15px;margin:0 0 8px">状态流转规则</h3>
              <div class="meta" style="margin-bottom:8px">步骤 → 完成后自动切换到底片状态</div>
              <div id="statusTransitionList"></div>
            </div>
            <div style="display:flex;gap:8px;margin-top:14px">
              <button id="templateSaveBtn">保存模板</button>
              <button id="templateCancelBtn" class="secondary" type="button">取消</button>
            </div>
          </div>
        </div>
        <div id="templateStepEditDialog" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,0.5);z-index:999;display:none;align-items:center;justify-content:center">
          <div style="background:#fff;border-radius:8px;padding:20px;width:90%;max-width:500px;max-height:85vh;overflow:auto">
            <h3 id="stepEditTitle">编辑步骤</h3>
            <label>步骤标识（英文字母，自动生成可修改）</label>
            <input id="stepKey" placeholder="例如：coating">
            <label>步骤名称</label>
            <input id="stepName" placeholder="例如：涂布">
            <label>排序</label>
            <input id="stepOrder" type="number" min="1" value="1">
            <label>步骤说明</label>
            <textarea id="stepDesc" rows="2"></textarea>
            <label>预计耗时</label>
            <input id="stepDuration" placeholder="例如：15分钟">
            <label>完成后状态（可选，步骤完成时底片切换到此状态）</label>
            <select id="stepTargetStatus">
              <option value="">不切换</option>
              <option>待曝光</option><option>冲洗中</option><option>待入盒</option><option>已交付</option>
            </select>
            <label style="display:flex;align-items:center;gap:8px;margin:8px 0">
              <input type="checkbox" id="stepAllowSkip"> <span>允许跳过此步骤</span>
            </label>
            <h4 style="font-size:14px;margin:10px 0 6px">必填记录项</h4>
            <div id="stepRequiredFields" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px"></div>
            <h4 style="font-size:14px;margin:10px 0 6px">可选记录项</h4>
            <div id="stepOptionalFields" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px"></div>
            <div style="display:flex;gap:8px">
              <button id="stepSaveBtn">保存步骤</button>
              <button id="stepCancelBtn" class="secondary" type="button">取消</button>
            </div>
          </div>
        </div>
      </div>
    `;
  }

  function fieldCheckboxHtml(containerId, selected) {
    const sel = new Set(selected || []);
    return FIELD_OPTIONS.map(f => `
      <label style="display:flex;align-items:center;gap:4px;font-size:13px;margin:2px 0">
        <input type="checkbox" data-field-container="${containerId}" value="${f.key}" ${sel.has(f.key) ? 'checked' : ''}> ${f.label}
      </label>
    `).join('');
  }

  function renderTemplateSelect(selectEl, currentValue) {
    if (!selectEl) return;
    selectEl.innerHTML = templates.map(t =>
      `<option value="${t.id}" ${t.id === currentValue ? 'selected' : ''}>${t.name}${t.isDefault ? ' ★默认' : ''}</option>`
    ).join('');
  }

  function renderTemplateStepsList() {
    const container = document.getElementById('templateStepsList');
    if (!container || !currentEditingTemplate) return;
    const steps = [...(currentEditingTemplate.steps || [])].sort((a, b) => a.order - b.order);
    if (!steps.length) {
      container.innerHTML = '<div class="meta">暂无步骤，点击「添加步骤」</div>';
      return;
    }
    container.innerHTML = steps.map((s, idx) => `
      <div style="border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <div style="flex:1">
          <strong>${s.order}. <b>${s.name}</b> <span class="pill" style="margin-left:6px">${s.key}</span>
          ${s.allowSkip ? '' : '<span class="pill" style="margin-left:6px;background:#fde8e8;color:var(--warn);border-color:#f5c2c2">必做</span>'}
          ${s.targetStatus ? `<span class="pill" style="margin-left:6px">→ ${s.targetStatus}</span>` : ''}
          <div class="meta" style="margin-top:4px">${s.description || ''}</div>
          <div class="meta" style="margin-top:2px">必填: ${(s.requiredFields || []).join(', ') || '(无)'}</div>
          <div class="meta">可选: ${(s.optionalFields || []).join(', ') || '(无)'}</div>
        </div>
        <div style="display:flex;gap:6px;flex-direction:column">
          <button class="secondary" type="button" data-step-edit="${idx}" style="font-size:12px;padding:4px 10px">编辑</button>
          <button class="secondary" type="button" data-step-del="${idx}" style="font-size:12px;padding:4px 10px;background:var(--warn)">删除</button>
          <button class="secondary" type="button" data-step-up="${idx}" style="font-size:12px;padding:4px 10px" ${idx === 0 ? 'disabled' : ''}>上移</button>
          <button class="secondary" type="button" data-step-down="${idx}" style="font-size:12px;padding:4px 10px" ${idx === steps.length - 1 ? 'disabled' : ''}>下移</button>
        </div>
      </div>
    `).join('');
    container.querySelectorAll('[data-step-edit]').forEach(b => b.onclick = () => openStepEdit(+b.dataset.stepEdit));
    container.querySelectorAll('[data-step-del]').forEach(b => b.onclick = () => deleteStep(+b.dataset.stepDel));
    container.querySelectorAll('[data-step-up]').forEach(b => b.onclick = () => moveStep(+b.dataset.stepUp, -1));
    container.querySelectorAll('[data-step-down]').forEach(b => b.onclick = () => moveStep(+b.dataset.stepDown, 1));
  }

  function renderStatusTransitions() {
    const container = document.getElementById('statusTransitionList');
    if (!container || !currentEditingTemplate) return;
    const transitions = currentEditingTemplate.statusTransitions || {};
    const steps = currentEditingTemplate.steps || [];
    if (!steps.length) {
      container.innerHTML = '<div class="meta">暂无步骤</div>';
      return;
    }
    container.innerHTML = steps.map(s => {
      const key = s.name;
      return `
        <div style="display:grid;grid-template-columns:120px 1fr;gap:8px;align-items:center;padding:4px 0">
          <span>${s.name}</span>
          <select data-transition-step="${key}">
            <option value="">不自动切换</option>
            <option ${transitions[key] === '待曝光' ? 'selected' : ''}>待曝光</option>
            <option ${transitions[key] === '冲洗中' ? 'selected' : ''}>冲洗中</option>
            <option ${transitions[key] === '待入盒' ? 'selected' : ''}>待入盒</option>
            <option ${transitions[key] === '已交付' ? 'selected' : ''}>已交付</option>
          </select>
        </div>
      `;
    }).join('');
    container.querySelectorAll('[data-transition-step]').forEach(sel => {
      sel.onchange = () => {
        currentEditingTemplate.statusTransitions = currentEditingTemplate.statusTransitions || {};
        if (sel.value) {
          currentEditingTemplate.statusTransitions[sel.dataset.transitionStep] = sel.value;
        } else {
            delete currentEditingTemplate.statusTransitions[sel.dataset.transitionStep];
          }
      };
    });
  }

  function openStepEdit(index) {
    editingStepIndex = index;
    const steps = currentEditingTemplate.steps || [];
    const step = index >= 0 && index < steps.length ? steps[index] : null;
    const nextOrder = steps.length > 0 ? Math.max(...steps.map(s => s.order)) + 1 : 1;
    document.getElementById('stepEditTitle').textContent = step ? '编辑步骤' : '新增步骤';
    document.getElementById('stepKey').value = step ? step.key : '';
    document.getElementById('stepName').value = step ? step.name : '';
    document.getElementById('stepOrder').value = step ? step.order : nextOrder;
    document.getElementById('stepDesc').value = step ? (step.description || '') : '';
    document.getElementById('stepDuration').value = step ? (step.estimatedDuration || '') : '';
    document.getElementById('stepTargetStatus').value = step ? (step.targetStatus || '') : '';
    document.getElementById('stepAllowSkip').checked = step ? !!step.allowSkip : true;
    document.getElementById('stepRequiredFields').innerHTML = fieldCheckboxHtml('required', step ? step.requiredFields : []);
    document.getElementById('stepOptionalFields').innerHTML = fieldCheckboxHtml('optional', step ? step.optionalFields : []);
    const dialog = document.getElementById('templateStepEditDialog');
    dialog.style.display = 'flex';
  }

  function closeStepEdit() {
    document.getElementById('templateStepEditDialog').style.display = 'none';
    editingStepIndex = -1;
  }

  function saveStepFromDialog() {
    const name = document.getElementById('stepName').value.trim();
    const order = parseInt(document.getElementById('stepOrder').value, 10);
    if (!name) { alert('步骤名称必填'); return; }
    if (!order || order < 1) { alert('排序必须为正整数'); return; }
    const required = Array.from(document.querySelectorAll('[data-field-container="required"]:checked')).map(i => i.value);
    const optional = Array.from(document.querySelectorAll('[data-field-container="optional"]:checked')).map(i => i.value);
    const overlap = required.filter(f => optional.includes(f));
    if (overlap.length) { alert('字段不能同时出现在必填和可选：' + overlap.join(', ')); return; }
    const newStep = {
      key: document.getElementById('stepKey').value.trim() || name.toLowerCase().replace(/\s+/g, '-'),
      name,
      order,
      description: document.getElementById('stepDesc').value.trim(),
      estimatedDuration: document.getElementById('stepDuration').value.trim(),
      allowSkip: document.getElementById('stepAllowSkip').checked,
      requiredFields: required,
      optionalFields: optional
    };
    const target = document.getElementById('stepTargetStatus').value;
    if (target) newStep.targetStatus = target;
    currentEditingTemplate.steps = currentEditingTemplate.steps || [];
    if (editingStepIndex >= 0 && editingStepIndex < currentEditingTemplate.steps.length) {
      currentEditingTemplate.steps[editingStepIndex] = newStep;
    } else {
      currentEditingTemplate.steps.push(newStep);
    }
    closeStepEdit();
    renderTemplateStepsList();
    renderStatusTransitions();
  }

  function deleteStep(index) {
    if (!confirm('确认删除此步骤？')) return;
    currentEditingTemplate.steps.splice(index, 1);
    currentEditingTemplate.steps.forEach((s, i) => { s.order = i + 1; });
    renderTemplateStepsList();
    renderStatusTransitions();
  }

  function moveStep(index, dir) {
    const steps = currentEditingTemplate.steps;
    const target = index + dir;
    if (target < 0 || target >= steps.length) return;
    [steps[index], steps[target]] = [steps[target], steps[index]];
    steps.forEach((s, i) => { s.order = i + 1; });
    renderTemplateStepsList();
  }

  function startNewTemplate() {
    currentEditingTemplate = {
      name: '',
      description: '',
      isDefault: false,
      steps: [],
      statusTransitions: {}
    };
    showEditForm();
  }

  function editSelected() {
    const sel = document.getElementById('templateListSelect').value;
    if (!sel) return;
    const t = findById(sel);
    if (!t) return;
    currentEditingTemplate = JSON.parse(JSON.stringify(t));
    showEditForm();
  }

  function showEditForm() {
    document.getElementById('templateEmptyHint').style.display = 'none';
    document.getElementById('templateEditForm').style.display = 'block';
    document.getElementById('tmplName').value = currentEditingTemplate.name || '';
    document.getElementById('tmplDesc').value = currentEditingTemplate.description || '';
    document.getElementById('tmplIsDefault').checked = !!currentEditingTemplate.isDefault;
    renderTemplateStepsList();
    renderStatusTransitions();
  }

  function hideEditForm() {
    currentEditingTemplate = null;
    editingStepIndex = -1;
    document.getElementById('templateEmptyHint').style.display = 'block';
    document.getElementById('templateEditForm').style.display = 'none';
  }

  async function saveTemplate() {
    const name = document.getElementById('tmplName').value.trim();
    if (!name) { alert('模板名称必填'); return; }
    if (!currentEditingTemplate.steps || currentEditingTemplate.steps.length === 0) { alert('至少需要一个步骤'); return; }
    currentEditingTemplate.name = name;
    currentEditingTemplate.description = document.getElementById('tmplDesc').value.trim();
    currentEditingTemplate.isDefault = document.getElementById('tmplIsDefault').checked;
    const isNew = !currentEditingTemplate.id;
    try {
      let saved;
      if (isNew) {
        saved = await api('/api/process-templates', { method: 'POST', body: JSON.stringify(currentEditingTemplate) });
      } else {
        saved = await api('/api/process-templates/' + currentEditingTemplate.id, { method: 'PUT', body: JSON.stringify(currentEditingTemplate) });
      }
      await load();
      renderTemplateSelect(document.getElementById('templateListSelect'), saved.id);
      currentEditingTemplate = JSON.parse(JSON.stringify(saved));
      alert('保存成功');
    } catch (e) {
        alert('保存失败: ' + e.message);
    }
  }

  async function setDefault() {
    const sel = document.getElementById('templateListSelect').value;
    if (!sel) return;
    const t = findById(sel);
    if (!t || t.isDefault) return;
    try {
      await api('/api/process-templates/' + t.id, { method: 'PUT', body: JSON.stringify({ isDefault: true }) });
      await load();
      renderTemplateSelect(document.getElementById('templateListSelect'), t.id);
      alert('已设为默认');
    } catch (e) { alert(e.message); }
  }

  async function deleteTemplate() {
    const sel = document.getElementById('templateListSelect').value;
    if (!sel) return;
    if (!confirm('确认删除此模板？')) return;
    try {
      await api('/api/process-templates/' + sel, { method: 'DELETE' });
      await load();
      currentEditingTemplate = null;
      hideEditForm();
      renderTemplateSelect(document.getElementById('templateListSelect'));
      alert('删除成功');
    } catch (e) { alert(e.message); }
  }

  function getItemProcessStepsHtml(item) {
    if (!item.templateId || !item.processSteps) return '';
    const steps = [...item.processSteps].sort((a, b) => a.order - b.order);
    if (!steps.length) return '';
    let html = '<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:8px"><div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px"><b>工艺进度</b>';
    const done = steps.filter(s => s.status === 'completed' || s.status === 'skipped').length;
    html += `<span class="meta">${done}/${steps.length}</span></div>`;
    html += '<div style="height:6px;background:var(--line);border-radius:3px;margin-bottom:8px;overflow:hidden"><div style="height:100%;background:var(--accent);width:' + Math.round(done / steps.length * 100) + '%"></div></div>';
    html += '<div style="display:flex;flex-direction:column;gap:4px">';
    for (const s of steps) {
      let cls = 'pill';
      let label = s.name;
      let extra = '';
      if (s.status === 'completed') {
        cls += ' sev-minor';
        label = '✓ ' + s.name;
      } else if (s.status === 'skipped') {
        cls += ' sev-moderate';
        label = '⊘ ' + s.name;
        extra = '<div class="meta" style="margin-left:18px;font-size:12px">跳过原因: ' + (s.skipReason || '') + '</div>';
      }
      html += '<div><span class="' + cls + '">' + label + '</span>' + (s.records && s.records.length ? ' <span class="meta">' + new Date(s.records[s.records.length - 1].at).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) + '</span>' : '') + '</div>' + extra;
    }
    html += '</div></div>';
    return html;
  }

  async function skipStep(itemId, stepKey) {
    const reason = prompt('请输入跳过原因（必填）：');
    if (!reason || !reason.trim()) return false;
    try {
      await api('/api/items/' + itemId + '/skip-step', {
        method: 'POST',
        body: JSON.stringify({ stepKey, skipReason: reason.trim() })
      });
      return true;
    } catch (e) {
      alert(e.message);
      return false;
    }
  }

  function reset() {
    templates = [];
    currentEditingTemplate = null;
    editingStepIndex = -1;
  }

  function init() {
    const listSel = document.getElementById('templateListSelect');
    if (listSel) {
      renderTemplateSelect(listSel);
      listSel.onchange = editSelected;
    }
    const newBtn = document.getElementById('templateNewBtn');
    if (newBtn) newBtn.onclick = startNewTemplate;
    const setDefBtn = document.getElementById('templateSetDefaultBtn');
    if (setDefBtn) setDefBtn.onclick = setDefault;
    const delBtn = document.getElementById('templateDeleteBtn');
    if (delBtn) delBtn.onclick = deleteTemplate;
    const addStepBtn = document.getElementById('templateAddStepBtn');
    if (addStepBtn) addStepBtn.onclick = () => openStepEdit(-1);
    const saveBtn = document.getElementById('templateSaveBtn');
    if (saveBtn) saveBtn.onclick = saveTemplate;
    const cancelBtn = document.getElementById('templateCancelBtn');
    if (cancelBtn) cancelBtn.onclick = hideEditForm;
    const stepSaveBtn = document.getElementById('stepSaveBtn');
    if (stepSaveBtn) stepSaveBtn.onclick = saveStepFromDialog;
    const stepCancelBtn = document.getElementById('stepCancelBtn');
    if (stepCancelBtn) stepCancelBtn.onclick = closeStepEdit;
  }

  return {
    load,
    reset,
    getTemplates,
    findById,
    getDefault,
    renderManagerPanel,
    renderTemplateSelect,
    getItemProcessStepsHtml,
    skipStep,
    init
  };
})();
