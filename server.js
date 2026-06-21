import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleDefectsRoutes } from "./routes/defects.js";
import { handleBatchRoutes } from "./routes/chemical-batches.js";
import { handleBoxSlotRoutes } from "./routes/box-slots.js";
import { handleTemplateRoutes } from "./routes/process-templates.js";
import { loadBoxSlots, saveBoxSlots } from "./data/box-slots.js";
import { loadTemplates } from "./data/process-templates.js";
import {
  createItemWithTemplate,
  recordStepAction,
  skipStep,
  getItemProcessInfo,
  hasTemplate
} from "./services/process-service.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = join(__dirname, "data", "cyanotype-negative-room.json");
const publicDir = join(__dirname, "public");
const port = Number(process.env.PORT || 3040);
const seed = {
  "items": [
    {
      "code": "CN-001",
      "plateSize": "18x24cm",
      "chemicalBatch": "B-0620",
      "exposure": "8分钟",
      "waterSource": "井水过滤",
      "box": "蓝盒A-03",
      "status": "冲洗中",
      "defect": "边角显影不均",
      "logs": [
        {
          "at": "2026-06-20",
          "step": "曝光",
          "note": "阴天补时2分钟"
        }
      ]
    }
  ]
};
const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
const stages = ["待曝光","冲洗中","待入盒","已交付"];
const statLabels = ["待曝光","冲洗中","待入盒","已交付"];
const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];

async function loadDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db) { await writeFile(dbPath, JSON.stringify(db, null, 2)); }
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}
function html(res, text) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(text);
}
function newId() { return "CN-" + Date.now(); }
function computeStats(items) {
  const stats = Object.fromEntries(statLabels.map(label => [label, 0]));
  for (const item of items) {
    if (stats[item.status] !== undefined) stats[item.status] += 1;
  }
  return stats;
}
async function syncSlotOccupancy() {
  const db = await loadDb();
  const slotDb = await loadBoxSlots();
  for (const slot of slotDb.slots) {
    slot.currentCount = db.items.filter(i => i.box === slot.slotNo).length;
  }
  await saveBoxSlots(slotDb);
}
async function summarizeItem(item) {
  const logCount = (item.logs || []).length + ((item.processSteps || []).reduce((n, t) => n + (t.records || []).length, 0)) + (item.steps || []).length;
  const templateDb = await loadTemplates();
  const procInfo = await getItemProcessInfo(item, templateDb);
  return { ...item, logCount, processInfo: procInfo };
}
const mimeTypes = { ".js": "application/javascript", ".css": "text/css", ".json": "application/json" };

async function serveStatic(req, res, url) {
  if (!url.pathname.startsWith("/public/")) return false;
  const filePath = join(__dirname, url.pathname);
  if (!filePath.startsWith(publicDir)) return false;
  if (!existsSync(filePath)) return false;
  const ext = extname(filePath);
  const ct = mimeTypes[ext] || "application/octet-stream";
  const content = await readFile(filePath);
  res.writeHead(200, { "Content-Type": ct + "; charset=utf-8" });
  res.end(content);
  return true;
}

function page() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } main { display:grid; grid-template-columns:400px 1fr; gap:22px; padding:22px 28px; }
    form,.panel,.card,.stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; } input,select,textarea { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; } textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; } button.secondary { background:#69736a; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:10px; margin-bottom:14px; } .stat strong { display:block; font-size:24px; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; } .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); gap:12px; } .card { display:grid; gap:8px; }
    .meta { color:var(--muted); font-size:13px; } .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; }
    .logs { border-top:1px solid var(--line); padding-top:8px; max-height:110px; overflow:auto; } .warn { color:var(--warn); font-weight:700; }
    .defect-row { border:1px solid var(--line); border-radius:6px; padding:8px; margin-bottom:8px; }
    .sev-critical .pill.sev-critical { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .sev-moderate .pill.sev-moderate { background:#fef3d6; color:#8a6d12; border-color:#f0d98a; }
    .sev-minor .pill.sev-minor { background:#e8f5e4; color:var(--accent); border-color:#b8ddb0; }
    .defect-info { background:#fef9f0; border:1px solid #f0d98a; border-radius:6px; padding:8px; margin:4px 0; font-size:13px; }
    .defect-info .repair-hint { color:var(--accent); font-weight:600; }
    .pill.sev-critical { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .pill.sev-moderate { background:#fef3d6; color:#8a6d12; border-color:#f0d98a; }
    .pill.sev-minor { background:#e8f5e4; color:var(--accent); border-color:#b8ddb0; }
    .tabs { display:flex; gap:0; margin-top:14px; flex-wrap:wrap; }
    .tabs button { border-radius:6px 6px 0 0; background:var(--line); color:var(--ink); font-weight:400; padding:8px 14px; }
    .tabs button.active { background:var(--panel); font-weight:700; border:1px solid var(--line); border-bottom:0; }
    .tab-content { display:none; }
    .tab-content.active { display:block; }
    .process-steps-bar { display:flex; gap:3px; margin:6px 0 4px; flex-wrap:wrap; }
    .process-steps-bar .step-dot { width:28px; height:28px; border-radius:50%; display:flex; align-items:center; justify-content:center; font-size:12px; border:1px solid var(--line); background:#eee; color:#888; position:relative; }
    .process-steps-bar .step-dot.done { background:var(--accent); color:#fff; border-color:var(--accent); }
    .process-steps-bar .step-dot.skipped { background:#caa749; color:#fff; border-color:#caa749; }
    .process-steps-bar .step-dot.current { background:#fff; border:2px solid var(--accent); color:var(--accent); font-weight:700; }
    .process-steps-bar .step-line { flex:1; min-width:10px; height:2px; align-self:center; background:var(--line); }
    .skip-btn { background:var(--warn); }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div><h1>古法蓝晒底片整理室</h1><div class="meta">底片任务、工艺步骤、缺陷和入盒交付</div></div><button id="reload">刷新</button></header>
  <main>
    <section>
      <form id="createForm"><h2>新增底片</h2><label>工艺流程模板</label><select name="templateId" id="templateSelect"><option value="">不使用模板（兼容模式）</option></select><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存底片</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>记录工艺步骤</h2><label>选择底片</label><select name="id" id="itemSelect"></select><div id="currentStepHint" class="meta" style="margin-top:4px"></div><div id="extraFields"></div><div id="skipArea" style="margin-top:8px;display:none;border:1px dashed var(--line);border-radius:6px;padding:10px"><label>跳过当前步骤</label><input name="skipReason" placeholder="输入跳过原因"><button type="button" id="skipBtn" class="skip-btn">跳过此步骤</button></div><button>提交记录</button></form>
      <div class="tabs">
        <button class="active" data-tab="defectTab">缺陷类型管理</button>
        <button data-tab="batchTab">药液批次台账</button>
        <button data-tab="boxSlotTab">存放盒位管理</button>
        <button data-tab="processTab">工艺流程模板</button>
      </div>
      <div id="defectTab" class="tab-content active"></div>
      <div id="batchTab" class="tab-content"></div>
      <div id="boxSlotTab" class="tab-content"></div>
      <div id="processTab" class="tab-content"></div>
    </section>
    <section>
      <div class="stats" id="stats"></div>
      <div id="boxSlotStats" class="stats" style="margin-bottom:14px"></div>
      <div class="toolbar"><select id="statusFilter"><option value="">全部状态</option>${stages.map(s => '<option>'+s+'</option>').join('')}</select><select id="templateFilter"><option value="">全部模板</option></select><input id="search" placeholder="搜索编号或关键词"></div>
      <div class="panel"><h2>创建蓝晒任务后，按涂布、晾干、曝光、冲洗、复晒、入盒记录每一步历史。</h2><div class="grid" id="cards"></div></div>
    </section>
  </main>
  <script src="/public/defect-ui.js"></script>
  <script src="/public/chemical-batch-ui.js"></script>
  <script src="/public/box-slot-ui.js"></script>
  <script src="/public/process-ui.js"></script>
  <script>
    const fields = [["code","底片编号","text"],["plateSize","玻璃板尺寸","text"],["chemicalBatch","药液批次","text"],["exposure","曝光时间","text"],["waterSource","冲洗水源","text"],["box","存放盒位","text"]];
    const stages = ["待曝光","冲洗中","待入盒","已交付"];
    const extraFields = [["step","步骤"],["developStatus","显影状态"],["defect","缺陷类型"],["repair","修补记录"],["note","备注"]];
    const allStepFieldOptions = [
      { key: "step", label: "步骤" },
      { key: "developStatus", label: "显影状态" },
      { key: "exposure", label: "曝光时间" },
      { key: "waterSource", label: "冲洗水源" },
      { key: "chemicalBatch", label: "药液批次" },
      { key: "defect", label: "缺陷类型" },
      { key: "repair", label: "修补记录" },
      { key: "box", label: "存放盒位" },
      { key: "note", label: "备注" }
    ];
    const createForm = document.querySelector('#createForm');
    const actionForm = document.querySelector('#actionForm');
    const cards = document.querySelector('#cards');
    const statsEl = document.querySelector('#stats');
    const itemSelect = document.querySelector('#itemSelect');
    let items = [];
    async function api(path, options) {
      const res = await fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    function getSelectedItem() {
      const id = itemSelect.value;
      return items.find(i => (i.id || i.code) === id);
    }
    function getCurrentStepForSelected() {
      const item = getSelectedItem();
      if (!item || !item.processInfo) return null;
      return item.processInfo.currentStep || null;
    }
    function renderActionFormFields() {
      const item = getSelectedItem();
      const container = document.getElementById('extraFields');
      const skipArea = document.getElementById('skipArea');
      const hintEl = document.getElementById('currentStepHint');
      let fieldList = extraFields.slice();
      let required = ["note"];
      let currentStep = null;
      let canSkip = false;
      let stepReadonly = false;
      let defaultValueStep = '';
      if (item && item.processInfo) {
        const info = item.processInfo;
        if (info.currentStep) {
          currentStep = info.currentStep;
          defaultValueStep = currentStep.name;
          stepReadonly = true;
          const req = new Set(currentStep.requiredFields || []);
          const opt = new Set(currentStep.optionalFields || []);
          if (!req.has("note") && !opt.has("note")) req.add("note");
          const orderedKeys = ["step", ...Array.from(req), ...Array.from(opt)];
          fieldList = allStepFieldOptions.filter(f => orderedKeys.includes(f.key)).map(f => [f.key, f.label]);
          required = Array.from(req);
          canSkip = !!currentStep.allowSkip;
          hintEl.innerHTML = '<span class="pill sev-minor">当前步骤：' + currentStep.name + '（第' + currentStep.order + '步）</span>' +
            (currentStep.description ? ' <span class="meta">' + currentStep.description + '</span>' : '') +
            (required.length ? '<div class="meta">必填：' + required.join('、') + '</div>' : '');
        } else if (info.usingTemplate) {
          hintEl.innerHTML = '<span class="pill sev-minor">该模板流程已全部完成</span>';
        } else {
          hintEl.innerHTML = '';
        }
      } else {
        hintEl.innerHTML = '';
      }
      skipArea.style.display = (currentStep && canSkip) ? 'block' : 'none';
      if (skipArea.querySelector('#skipBtn')) {
        skipArea.querySelector('#skipBtn').onclick = async () => {
          const reason = skipArea.querySelector('input[name="skipReason"]').value.trim();
          if (!reason) { alert('跳过原因必填'); return; }
          try {
            await api('/api/items/' + (item.id || item.code) + '/skip-step', { method: 'POST', body: JSON.stringify({ stepKey: currentStep.key, skipReason: reason }) });
            skipArea.querySelector('input[name="skipReason"]').value = '';
            await load();
          } catch (e) { alert(e.message); }
        };
      }
      let html = '';
      for (const [key, label] of fieldList) {
        const isRequired = required.includes(key);
        const reqMark = isRequired ? ' <span style="color:var(--warn)">*</span>' : '';
        if (key === 'step') {
          html += '<label>' + label + reqMark + '</label>' +
            (stepReadonly ? '<input name="step" value="' + defaultValueStep + '" readonly style="background:#f5f6f4">' :
            '<select name="step"><option value="">选择步骤</option>' +
            (item && item.processInfo && !item.processInfo.legacyMode
              ? item.processInfo.nextSteps.map(s => '<option value="' + s.name + '">' + s.name + '</option>').join('')
              : ['涂布','晾干','曝光','冲洗','复晒','入盒','交付'].map(s => '<option>' + s + '</option>').join('')) +
            '</select>');
        } else if (key === 'defect') {
          html += '<label>缺陷类型（从缺陷库选择）' + reqMark + '</label><select id="defectSelect" name="defect"><option value="">-- 从缺陷库选择 --</option></select>';
        } else if (key === 'box') {
          html += '<label>存放盒位（入盒/交付时选择）' + reqMark + '</label><select id="actionBoxSelect" name="box"><option value="">-- 选择盒位（可选） --</option></select><div id="actionBoxWarning" style="display:none;color:var(--warn);font-size:13px;margin-top:4px"></div>';
        } else if (key === 'repair' || key === 'note') {
          html += '<label>' + label + reqMark + '</label><textarea name="' + key + '" rows="2"></textarea>';
        } else {
          html += '<label>' + label + reqMark + '</label><input name="' + key + '">';
        }
      }
      container.innerHTML = html;
      const defectSelect = document.getElementById('defectSelect');
      if (defectSelect) {
        DefectUI.renderDefectSelect(defectSelect);
        defectSelect.onchange = function() {
          const d = DefectUI.findByName(this.value);
          const repairInput = container.querySelector('textarea[name="repair"]');
          if (d && repairInput && !repairInput.value) {
            repairInput.value = d.repair || '';
          }
        };
      }
      const actionBoxSel = document.getElementById('actionBoxSelect');
      if (actionBoxSel) {
        BoxSlotUI.renderSlotSelect(actionBoxSel);
        actionBoxSel.onchange = function() {
          const warning = document.getElementById('actionBoxWarning');
          if (this.value) {
            const check = BoxSlotUI.checkSlotAvailability(this.value);
            if (check.found && check.full) {
              if (warning) { warning.style.display = 'block'; warning.textContent = '⚠ 该盒位已满（'+check.slot.currentCount+'/'+check.slot.capacity+'），请选择其他盒位'; }
              return;
            } else if (warning) warning.style.display = 'none';
          } else if (warning) {
            warning.style.display = 'none';
          }
        };
      }
    }
    function renderForms() {
      document.querySelector('#fields').innerHTML = fields.map(([key,label,type]) => {
        if (key === 'chemicalBatch') {
          return '<label>'+label+'</label><select id="batchSelect" onchange="document.getElementById(\\'batchManual\\').value=this.value===\\'__manual__\\'?\\'\\':this.value" style="margin-bottom:6px"><option value="__manual__">手动输入批次号</option></select><input id="batchManual" name="chemicalBatch" type="text" placeholder="输入药液批次号">';
        }
        if (key === 'box') {
          return '<label>'+label+'</label><select id="boxSlotSelect" name="box" style="margin-bottom:6px"><option value="">手动输入盒位</option></select><input id="boxManual" name="box_manual" type="text" placeholder="或手动输入盒位编号" style="margin-top:4px"><div id="boxSlotWarning" style="display:none;color:var(--warn);font-size:13px;margin-top:4px"></div>';
        }
        return '<label>'+label+'</label><input name="'+key+'" type="'+type+'" '+(key==='code'?'required':'')+'>';
      }).join('');
      ProcessUI.renderTemplateSelect(document.getElementById('templateSelect'));
      ChemicalBatchUI.renderBatchSelect(document.getElementById('batchSelect'));
      BoxSlotUI.renderSlotSelect(document.getElementById('boxSlotSelect'));
      const boxSlotSelect = document.getElementById('boxSlotSelect');
      if (boxSlotSelect) {
        boxSlotSelect.onchange = function() {
          const warning = document.getElementById('boxSlotWarning');
          if (this.value) {
            const check = BoxSlotUI.checkSlotAvailability(this.value);
            if (check.found && check.full) {
              warning.style.display = 'block';
              warning.textContent = '⚠ 该盒位已满（'+check.slot.currentCount+'/'+check.slot.capacity+'），请选择其他盒位';
            } else {
              warning.style.display = 'none';
            }
          } else {
            warning.style.display = 'none';
          }
        };
      }
    }
    function attachCardBoxSlotHandlers() {
      document.querySelectorAll('.box-slot-card-select').forEach(sel => {
        const itemId = sel.dataset.boxItem;
        const item = items.find(i => (i.id || i.code) === itemId);
        if (item && item.box) { BoxSlotUI.renderSlotSelect(sel, item.box); } else { BoxSlotUI.renderSlotSelect(sel, ''); }
        sel.onchange = async function() {
          const cardEl = sel.closest('.card');
          const warning = cardEl ? cardEl.querySelector('.box-slot-card-warning') : null;
          const selectedBox = this.value;
          if (selectedBox) {
            const check = BoxSlotUI.checkSlotAvailability(selectedBox);
            if (check.found && check.full) {
              if (warning) { warning.style.display = 'block'; warning.textContent = '⚠ 该盒位已满（'+check.slot.currentCount+'/'+check.slot.capacity+'），请选择其他盒位'; }
              return;
            } else {
              if (warning) warning.style.display = 'none';
            }
            await api('/api/items/'+itemId, { method:'PATCH', body: JSON.stringify({ box: selectedBox }) });
            await load();
          } else {
            if (warning) warning.style.display = 'none';
            await api('/api/items/'+itemId, { method:'PATCH', body: JSON.stringify({ box: '' }) });
            await load();
          }
        };
      });
      document.querySelectorAll('[data-skip-step]').forEach(btn => {
        btn.onclick = async () => {
          const itemId = btn.dataset.itemId;
          const stepKey = btn.dataset.skipStep;
          const ok = await ProcessUI.skipStep(itemId, stepKey);
          if (ok) await load();
        };
      });
    }
    function render() {
      itemSelect.innerHTML = items.map(item => {
        const procTag = item.processInfo && item.processInfo.template ? ' [' + item.processInfo.template.name + ']' : '';
        return '<option value="'+(item.id || item.code)+'">'+(item.code || item.id)+procTag+' · '+(item.name || item.shipType || item.source || item.plateSize || '')+'</option>';
      }).join('');
      renderActionFormFields();
      const stats = Object.fromEntries(stages.map(s => [s, items.filter(i => i.status === s).length]));
      statsEl.innerHTML = Object.entries(stats).map(([k,v]) => '<div class="stat"><span>'+k+'</span><strong>'+v+'</strong></div>').join('');
      const status = document.querySelector('#statusFilter').value;
      const tmplFilter = document.querySelector('#templateFilter').value;
      const q = document.querySelector('#search').value.trim();
      const visible = items.filter(item => {
        if (status && item.status !== status) return false;
        if (tmplFilter) {
          if (tmplFilter === '__none__') {
            if (item.templateId) return false;
          } else if (item.templateId !== tmplFilter) return false;
        }
        if (q && !JSON.stringify(item).includes(q)) return false;
        return true;
      });
      cards.innerHTML = visible.map(item => cardHtml(item)).join('');
      document.querySelectorAll('[data-status]').forEach(sel => sel.onchange = async () => { const newStatus = sel.value; const itemId = sel.dataset.status; await api('/api/items/'+itemId, { method:'PATCH', body: JSON.stringify({ status: newStatus }) }); await load(); });
      attachCardBoxSlotHandlers();
      document.querySelectorAll('[data-note]').forEach(btn => btn.onclick = async () => { const id = btn.dataset.note; const note = prompt('记录备注'); if (note) { await api('/api/items/'+id+'/logs', { method:'POST', body: JSON.stringify({ step:'备注', note }) }); await load(); } });
      BoxSlotUI.loadStats().then(statsData => { BoxSlotUI.renderStatsOverview(statsData); }).catch(() => {});
    }
    function processStepsBarHtml(item) {
      if (!item.processInfo || !item.processInfo.usingTemplate || !item.processSteps) return '';
      const sorted = [...item.processSteps].sort((a, b) => a.order - b.order);
      if (!sorted.length) return '';
      const current = item.processInfo.currentStep;
      let html = '<div class="process-steps-bar">';
      sorted.forEach((s, idx) => {
        const isDone = s.status === 'completed';
        const isSkipped = s.status === 'skipped';
        const isCurrent = current && current.key === s.key;
        let cls = 'step-dot';
        if (isDone) cls += ' done';
        if (isSkipped) cls += ' skipped';
        if (isCurrent) cls += ' current';
        let sym = s.order;
        let title = s.name;
        if (isDone) { sym = '✓'; }
        if (isSkipped) { sym = '⊘'; title += '（跳过：' + (s.skipReason || '') + '）'; }
        html += '<div class="' + cls + '" title="' + title + '">' + sym + '</div>';
        if (idx < sorted.length - 1) {
          const nextDone = sorted[idx + 1].status === 'completed' || sorted[idx + 1].status === 'skipped';
          html += '<div class="step-line" style="' + (isDone || isSkipped ? 'background:var(--accent)' : '') + '"></div>';
        }
      });
      html += '</div>';
      return html;
    }
    function cardHtml(item) {
      const main = fields.slice(0,4).map(([key,label]) => '<div><b>'+label+'</b> '+(item[key] ?? '')+'</div>').join('');
      const procTag = item.processInfo && item.processInfo.template ? '<span class="pill" style="margin-right:4px;background:#eaf2e6;color:var(--accent)">' + item.processInfo.template.name + '</span>' : (item.templateName ? '<span class="pill" style="margin-right:4px">' + item.templateName + '</span>' : '');
      const procBar = processStepsBarHtml(item);
      const procSteps = ProcessUI.getItemProcessStepsHtml(item);
      const logs = (item.logs || []).slice(-4).map(l => '<div>'+l.step+'：'+l.note+'</div>').join('');
      let defectHtml = '';
      if (item.defect) {
        const d = DefectUI.findByName(item.defect);
        if (d) {
          defectHtml = '<div class="defect-info"><b>缺陷：</b>'+d.name+' <span class="pill sev-'+DefectUI.severityClass(d.severity).replace('sev-','')+'">'+d.severity+'</span><div>'+d.description+'</div>'+(d.repair ? '<div class="repair-hint">修补建议：'+d.repair+'</div>' : '')+'</div>';
        } else {
          defectHtml = '<div class="defect-info"><b>缺陷：</b>'+item.defect+'</div>';
        }
      }
      const lastRepair = (item.steps || []).filter(s => s.repair).slice(-1)[0];
      const repairHint = lastRepair ? '<div style="font-size:13px;color:var(--accent)">修补：'+lastRepair.repair+'</div>' : '';
      let skipBtnHtml = '';
      if (item.processInfo && item.processInfo.currentStep && item.processInfo.currentStep.allowSkip) {
        skipBtnHtml = '<button class="secondary skip-btn" type="button" data-skip-step="' + item.processInfo.currentStep.key + '" data-item-id="' + (item.id || item.code) + '">跳过当前步骤</button>';
      }
      return '<article class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><h3 style="margin:0">'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span></div>' + procTag + procBar + main + defectHtml + repairHint + procSteps + '<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'+(item.status==='待入盒'||item.status==='已交付'?'<label>选择盒位</label><select class="box-slot-card-select" data-box-item="'+(item.id || item.code)+'"></select><div class="box-slot-card-warning" data-box-warning="'+(item.id || item.code)+'" style="display:none;color:var(--warn);font-size:13px;margin-top:4px"></div>':'')+'<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button>' + skipBtnHtml + '</div><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() {
      items = await api('/api/items');
      await DefectUI.load();
      await ChemicalBatchUI.load();
      await BoxSlotUI.load();
      await ProcessUI.load();
      renderTemplateFilter();
      render();
      const batchSelect = document.getElementById('batchSelect');
      if (batchSelect) ChemicalBatchUI.renderBatchSelect(batchSelect);
      const boxSlotSelect = document.getElementById('boxSlotSelect');
      if (boxSlotSelect) BoxSlotUI.renderSlotSelect(boxSlotSelect);
      const tmplSelect = document.getElementById('templateSelect');
      if (tmplSelect) ProcessUI.renderTemplateSelect(tmplSelect, tmplSelect.value);
      const defectSelect = document.getElementById('defectSelect');
      if (defectSelect) DefectUI.renderDefectSelect(defectSelect);
      const actionBoxSel = document.getElementById('actionBoxSelect');
      if (actionBoxSel) BoxSlotUI.renderSlotSelect(actionBoxSel);
    }
    function renderTemplateFilter() {
      const sel = document.getElementById('templateFilter');
      if (!sel) return;
      const cur = sel.value;
      const options = ProcessUI.getTemplates().map(t => '<option value="' + t.id + '" ' + (t.id===cur?'selected':'') + '>' + t.name + (t.isDefault?' (默认)':'') + '</option>');
      const noneOpt = '<option value="__none__" ' + (cur==='__none__'?'selected':'') + '>未使用模板</option>';
      sel.innerHTML = '<option value="">全部模板</option>' + options.join('') + noneOpt;
    }
    createForm.onsubmit = async event => {
      event.preventDefault();
      const formData = Object.fromEntries(new FormData(createForm).entries());
      const boxSlotSelect = document.getElementById('boxSlotSelect');
      const boxManual = document.getElementById('boxManual');
      if (boxSlotSelect && boxSlotSelect.value) {
        formData.box = boxSlotSelect.value;
      } else if (boxManual && boxManual.value.trim()) {
        formData.box = boxManual.value.trim();
      }
      if (formData.box_manual) delete formData.box_manual;
      const result = await api('/api/items', { method:'POST', body: JSON.stringify(formData) });
      if (result.chemicalBatch && result.code) {
        const batch = ChemicalBatchUI.findByBatchNo(result.chemicalBatch);
        if (batch && !batch.negativeCodes.includes(result.code)) {
          batch.negativeCodes.push(result.code);
          await api('/api/chemical-batches/'+batch.id, { method:'PUT', body: JSON.stringify({ negativeCodes: batch.negativeCodes }) });
        }
      }
      createForm.reset();
      await load();
    };
    actionForm.onsubmit = async event => {
      event.preventDefault();
      const formData = Object.fromEntries(new FormData(actionForm).entries());
      const selectedBox = formData.box || '';
      if (selectedBox) {
        const check = BoxSlotUI.checkSlotAvailability(selectedBox);
        if (check.found && check.full) {
          alert('该盒位已满（'+check.slot.currentCount+'/'+check.slot.capacity+'），请选择其他盒位');
          return;
        }
      }
      await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(formData) });
      actionForm.reset();
      const abs = document.getElementById('actionBoxSelect');
      if (abs) BoxSlotUI.renderSlotSelect(abs);
      await load();
    };
    document.querySelector('#statusFilter').onchange = render;
    document.querySelector('#search').oninput = render;
    if (document.querySelector('#templateFilter')) document.querySelector('#templateFilter').onchange = render;
    document.querySelector('#reload').onclick = load;
    itemSelect.onchange = renderActionFormFields;
    document.querySelectorAll('.tabs button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      };
    });
    renderForms();
    document.getElementById('defectTab').innerHTML = DefectUI.renderManagerPanel();
    document.getElementById('batchTab').innerHTML = ChemicalBatchUI.renderPanel();
    document.getElementById('boxSlotTab').innerHTML = BoxSlotUI.renderPanel();
    document.getElementById('processTab').innerHTML = ProcessUI.renderManagerPanel();
    DefectUI.init();
    ChemicalBatchUI.init();
    BoxSlotUI.init();
    ProcessUI.init();
    load();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (await serveStatic(req, res, url)) return;

    const defectResult = await handleDefectsRoutes(req, res, url);
    if (defectResult !== null) return;

    const batchResult = await handleBatchRoutes(req, res, url);
    if (batchResult !== null) return;

    const boxSlotResult = await handleBoxSlotRoutes(req, res, url);
    if (boxSlotResult !== null) return;

    const templateResult = await handleTemplateRoutes(req, res, url);
    if (templateResult !== null) return;

    const db = await loadDb();
    const templateDb = await loadTemplates();

    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") {
      const enriched = await Promise.all(db.items.map(summarizeItem));
      return send(res, 200, enriched);
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      let item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }] };
      if (input.templateId) {
        const { item: templatedItem } = await createItemWithTemplate(item, input.templateId, templateDb);
        item = templatedItem;
      }
      db.items.unshift(item);
      await saveDb(db);
      await syncSlotOccupancy();
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      Object.assign(item, await body(req));
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db);
      await syncSlotOccupancy();
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db);
      return send(res, 201, item);
    }
    const skipMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/skip-step$/);
    if (skipMatch && req.method === "POST") {
      const item = db.items.find(x => x.id === skipMatch[1] || x.code === skipMatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const result = await skipStep(item, input.stepKey, input.skipReason, templateDb);
      if (!result.success) {
        return send(res, 400, { error: result.error });
      }
      await saveDb(db);
      return send(res, 200, result.item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      await recordStepAction(item, input, templateDb);
      await saveDb(db);
      await syncSlotOccupancy();
      return send(res, 201, item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));
    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, () => console.log("古法蓝晒底片整理室 listening on http://localhost:" + port));
