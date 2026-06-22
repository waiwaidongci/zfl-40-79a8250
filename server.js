import http from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { handleDefectsRoutes } from "./routes/defects.js";
import { handleBatchRoutes } from "./routes/chemical-batches.js";
import { handleBoxSlotRoutes } from "./routes/box-slots.js";
import { handleTemplateRoutes } from "./routes/process-templates.js";
import { handleDeliveryBatchRoutes } from "./routes/delivery-batches.js";
import { handleBackupRoutes } from "./routes/backups.js";
import { handleStudioRoutes } from "./routes/studios.js";
import { loadBoxSlots, saveBoxSlots } from "./data/box-slots.js";
import { loadTemplates } from "./data/process-templates.js";
import { migrateOldFiles, getDataPath, ensureStudioDir } from "./data/studios.js";
import {
  createItemWithTemplate,
  recordStepAction,
  skipStep,
  getItemProcessInfo,
  hasTemplate
} from "./services/process-service.js";
import {
  parseCSV,
  mapHeadersToFields,
  validateImport,
  createImportItem,
  FIELD_MAPPINGS
} from "./services/import-service.js";
import {
  auditCreateItem,
  auditUpdateStatus,
  auditAddNote,
  auditRecordStep,
  auditSkipStep,
  auditImport,
  auditUpdateField
} from "./services/audit-service.js";
import { getAuditLogs, AUDIT_ACTION_TYPES, AUDIT_ACTION_LABELS } from "./data/audit-logs.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
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

async function loadDb(studioId) {
  const dbPath = getDataPath(studioId, "cyanotype-negative-room.json");
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await writeFile(dbPath, JSON.stringify(seed, null, 2));
  }
  return JSON.parse(await readFile(dbPath, "utf8"));
}
async function saveDb(db, studioId) {
  const dbPath = getDataPath(studioId, "cyanotype-negative-room.json");
  await writeFile(dbPath, JSON.stringify(db, null, 2));
}
async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}
async function rawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}
function parseMultipartFormData(buffer, boundary) {
  const parts = [];
  const boundaryBuffer = Buffer.from('--' + boundary);
  let start = 0;
  while (start < buffer.length) {
    const boundaryPos = buffer.indexOf(boundaryBuffer, start);
    if (boundaryPos === -1) break;
    const nextBoundaryPos = buffer.indexOf(boundaryBuffer, boundaryPos + boundaryBuffer.length);
    if (nextBoundaryPos === -1) break;
    const partBuffer = buffer.slice(boundaryPos + boundaryBuffer.length, nextBoundaryPos);
    const headerEnd = partBuffer.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headers = partBuffer.slice(0, headerEnd).toString('utf8');
      const content = partBuffer.slice(headerEnd + 4);
      const nameMatch = headers.match(/name="([^"]+)"/);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      parts.push({
        name: nameMatch ? nameMatch[1] : null,
        filename: filenameMatch ? filenameMatch[1] : null,
        content: content,
        headers: headers
      });
    }
    start = nextBoundaryPos;
  }
  return parts;
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
async function syncSlotOccupancy(studioId) {
  const db = await loadDb(studioId);
  const slotDb = await loadBoxSlots(studioId);
  for (const slot of slotDb.slots) {
    slot.currentCount = db.items.filter(i => i.box === slot.slotNo).length;
  }
  await saveBoxSlots(slotDb, studioId);
}
async function summarizeItem(item, studioId) {
  const logCount = (item.logs || []).length + ((item.processSteps || []).reduce((n, t) => n + (t.records || []).length, 0)) + (item.steps || []).length;
  const templateDb = await loadTemplates(studioId);
  const procInfo = await getItemProcessInfo(item, templateDb, studioId);
  const copy = { ...item, logCount, processInfo: procInfo };
  return copy;
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
    .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:1000; }
    .modal { background:#fff; border-radius:8px; padding:24px; max-width:600px; width:90%; max-height:80vh; overflow:auto; }
    .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .modal-header h2 { margin:0; }
    .hidden { display:none !important; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{grid-template-columns:1fr;padding:16px;} }
  </style>
</head>
<body>
  <header><div style="display:flex;align-items:center;gap:12px"><div><h1 style="display:inline">古法蓝晒底片整理室</h1></div><div style="display:flex;align-items:center;gap:6px"><label style="margin:0;font-size:13px;color:var(--muted)">当前工作室</label><select id="studioSelect" style="width:auto;min-width:140px;padding:6px 8px;font-size:14px"></select><button class="secondary" type="button" id="studioManageBtn" style="padding:6px 10px;font-size:12px">管理工作室</button></div><div class="meta" id="studioDesc"></div></div><div style="display:flex;gap:8px"><button class="secondary" onclick="location.href='/delivery-list'">交付清单</button><button class="secondary" onclick="location.href='/import'">批量导入</button><button class="secondary" onclick="location.href='/audit-logs'">审计日志</button><button id="reload">刷新</button></div></header>
  <main>
    <section>
      <form id="createForm"><h2>新增底片</h2><label>工艺流程模板</label><select name="templateId" id="templateSelect"><option value="">不使用模板（兼容模式）</option></select><div id="fields"></div><label>初始状态</label><select name="status">${stages.map(s => '<option>'+s+'</option>').join('')}</select><button>保存底片</button></form>
      <form id="actionForm" style="margin-top:14px"><h2>记录工艺步骤</h2><label>选择底片</label><select name="id" id="itemSelect"></select><div id="currentStepHint" class="meta" style="margin-top:4px"></div><div id="extraFields"></div><div id="skipArea" style="margin-top:8px;display:none;border:1px dashed var(--line);border-radius:6px;padding:10px"><label>跳过当前步骤</label><input name="skipReason" placeholder="输入跳过原因"><button type="button" id="skipBtn" class="skip-btn">跳过此步骤</button></div><button>提交记录</button></form>
      <div class="tabs">
        <button class="active" data-tab="defectTab">缺陷类型管理</button>
        <button data-tab="batchTab">药液批次台账</button>
        <button data-tab="boxSlotTab">存放盒位管理</button>
        <button data-tab="processTab">工艺流程模板</button>
        <button data-tab="backupTab">数据备份恢复</button>
      </div>
      <div id="defectTab" class="tab-content active"></div>
      <div id="batchTab" class="tab-content"></div>
      <div id="boxSlotTab" class="tab-content"></div>
      <div id="processTab" class="tab-content"></div>
      <div id="backupTab" class="tab-content"></div>
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
  <script src="/public/delivery-batch-ui.js"></script>
  <script src="/public/backup-ui.js"></script>
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
    let itemBatchMap = {};
    let currentStudioId = localStorage.getItem('currentStudioId') || 'default';
    let studios = [];
    async function api(path, options) {
      const sep = path.includes('?') ? '&' : '?';
      const studioPath = path + sep + 'studioId=' + encodeURIComponent(currentStudioId);
      const res = await fetch(studioPath, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }
    async function loadStudios() {
      studios = await fetch('/api/studios').then(r => r.json());
      const sel = document.getElementById('studioSelect');
      if (!sel) return;
      sel.innerHTML = studios.map(s => '<option value="' + s.id + '"' + (s.id === currentStudioId ? ' selected' : '') + '>' + s.name + '</option>').join('');
      const current = studios.find(s => s.id === currentStudioId);
      const descEl = document.getElementById('studioDesc');
      if (descEl && current) descEl.textContent = current.description || '';
    }
    async function switchStudio(id) {
      if (id === currentStudioId) return;
      currentStudioId = id;
      localStorage.setItem('currentStudioId', id);
      DefectUI.reset();
      ChemicalBatchUI.reset();
      BoxSlotUI.reset();
      ProcessUI.reset();
      DeliveryBatchUI.reset();
      BackupUI.reset();
      cards.innerHTML = '';
      statsEl.innerHTML = '';
      document.getElementById('boxSlotStats').innerHTML = '';
      items = [];
      itemBatchMap = {};
      itemSelect.innerHTML = '';
      const defectListEl = document.getElementById('defectList');
      if (defectListEl) defectListEl.innerHTML = '<div class="meta">加载中...</div>';
      const batchListEl = document.getElementById('batchList');
      if (batchListEl) batchListEl.innerHTML = '<div class="meta">加载中...</div>';
      const slotListEl = document.getElementById('slotList');
      if (slotListEl) slotListEl.innerHTML = '<div class="meta">加载中...</div>';
      const backupListEl = document.getElementById('backupList');
      if (backupListEl) backupListEl.innerHTML = '<div class="meta">加载中...</div>';
      await load();
      const current = studios.find(s => s.id === currentStudioId);
      const descEl = document.getElementById('studioDesc');
      if (descEl && current) descEl.textContent = current.description || '';
      DefectUI.renderDefectList(DefectUI.getDefects());
      ChemicalBatchUI.renderBatchList(ChemicalBatchUI.getBatches());
      BoxSlotUI.renderSlotList(BoxSlotUI.getSlots());
      BackupUI.renderBackupList();
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
    function attachCardDeliveryBatchHandlers() {
      document.querySelectorAll('.delivery-batch-select').forEach(sel => {
        const itemKey = sel.dataset.item;
        const code = sel.dataset.code;
        const batchInfo = itemBatchMap[itemKey];
        const selectedBatchId = batchInfo ? batchInfo.batch.id : '';
        DeliveryBatchUI.renderBatchSelect(sel, selectedBatchId);
        sel.onchange = async function() {
          const val = this.value;
          const currentItem = items.find(i => (i.id || i.code) === itemKey);
          if (currentItem && currentItem.status !== '已交付' && val && val !== '') {
            alert('只能将状态为「已交付」的底片加入交付批次，当前状态为「' + currentItem.status + '」。请先将底片状态更改为「已交付」。');
            this.value = selectedBatchId;
            return;
          }
          try {
            if (val === '__new__') {
              const customer = prompt('请输入客户/项目名称（可留空）：') || '';
              const deliveryDate = prompt('请输入交付日期 YYYY-MM-DD（留空使用今天）：') || new Date().toISOString().slice(0, 10);
              const newBatch = await DeliveryBatchUI.createBatch({ customer, deliveryDate });
              await DeliveryBatchUI.assignItemToBatch(itemKey, code, newBatch.id);
            } else if (val === '') {
              if (batchInfo) {
                if (!confirm('确认将此底片从交付批次「' + batchInfo.batch.batchNo + '」中移除？')) {
                  this.value = selectedBatchId;
                  return;
                }
                await DeliveryBatchUI.removeItemFromBatch(batchInfo.batch.id, itemKey);
              }
            } else {
              if (batchInfo && batchInfo.batch.id !== val) {
                await DeliveryBatchUI.removeItemFromBatch(batchInfo.batch.id, itemKey);
              }
              await DeliveryBatchUI.assignItemToBatch(itemKey, code, val);
            }
            await load();
          } catch (e) {
            alert(e.message);
            this.value = selectedBatchId;
          }
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
      const itemKey = item.id || item.code;
      const batchInfo = itemBatchMap[itemKey];
      let deliveryBatchHtml = '';
      if (item.status === '已交付') {
        const batchSelectId = 'del-batch-' + itemKey.replace(/[^a-zA-Z0-9]/g, '_');
        deliveryBatchHtml = '<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:4px">' +
          '<div id="batch-tag-' + batchSelectId + '" style="margin-bottom:6px">' + DeliveryBatchUI.getBatchTagHtml(batchInfo) + '</div>' +
          '<label>交付批次</label>' +
          '<select class="delivery-batch-select" id="' + batchSelectId + '" data-item="' + itemKey + '" data-code="' + (item.code || item.id) + '">' +
          '</select>' +
          '</div>';
      } else if (batchInfo) {
        deliveryBatchHtml = '<div style="border-top:1px solid var(--line);padding-top:8px;margin-top:4px">' +
          '<span class="pill warn" style="margin-top:4px;display:inline-block">⚠ 已归档至批次「' + batchInfo.batch.batchNo + '」但当前状态为「' + item.status + '」，请移除或恢复为「已交付」</span>' +
          '</div>';
      }
      return '<article class="card"><div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px"><h3 style="margin:0">'+(item.code || item.id)+'</h3><span class="pill">'+item.status+'</span></div>' + procTag + procBar + main + defectHtml + repairHint + procSteps + '<label>状态</label><select data-status="'+(item.id || item.code)+'">'+stages.map(s => '<option '+(s===item.status?'selected':'')+'>'+s+'</option>').join('')+'</select>'+(item.status==='待入盒'||item.status==='已交付'?'<label>选择盒位</label><select class="box-slot-card-select" data-box-item="'+(item.id || item.code)+'"></select><div class="box-slot-card-warning" data-box-warning="'+(item.id || item.code)+'" style="display:none;color:var(--warn);font-size:13px;margin-top:4px"></div>':'')+deliveryBatchHtml+'<div style="display:flex;gap:6px;flex-wrap:wrap"><button class="secondary" data-note="'+(item.id || item.code)+'">追加备注</button>' + skipBtnHtml + '</div><div class="logs meta">'+(logs || '暂无记录')+'</div></article>';
    }
    async function load() {
      items = await api('/api/items');
      await DefectUI.load();
      await ChemicalBatchUI.load();
      await BoxSlotUI.load();
      await ProcessUI.load();
      await DeliveryBatchUI.load();
      const deliveredIds = items.filter(i => i.status === '已交付').map(i => i.id || i.code);
      const itemKeys = new Set(items.map(i => i.id || i.code));
      const archivedIds = DeliveryBatchUI.getBatches().flatMap(batch => (batch.items || []).map(batchItem => {
        if (itemKeys.has(batchItem.itemId)) return batchItem.itemId;
        if (itemKeys.has(batchItem.code)) return batchItem.code;
        return batchItem.itemId || batchItem.code;
      }).filter(Boolean));
      const cachedIds = Object.keys(itemBatchMap).filter(k => itemBatchMap[k]);
      const idsToLookup = [...new Set([...deliveredIds, ...archivedIds, ...cachedIds])];
      if (idsToLookup.length > 0) {
        itemBatchMap = await DeliveryBatchUI.lookupItemBatches(idsToLookup);
      } else {
        itemBatchMap = {};
      }
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
      attachCardDeliveryBatchHandlers();
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
      const selectedItem = getSelectedItem();
      if (selectedItem && selectedItem.processInfo && selectedItem.processInfo.currentStep) {
        const required = selectedItem.processInfo.currentStep.requiredFields || [];
        const missing = required.filter(f => !formData[f] || (typeof formData[f] === 'string' && !formData[f].trim()));
        if (missing.length) {
          alert('必填项未填写：' + missing.join('、'));
          return;
        }
      }
      const selectedBox = formData.box || '';
      if (selectedBox) {
        const check = BoxSlotUI.checkSlotAvailability(selectedBox);
        if (check.found && check.full) {
          alert('该盒位已满（'+check.slot.currentCount+'/'+check.slot.capacity+'），请选择其他盒位');
          return;
        }
      }
      try {
        await api('/api/items/'+itemSelect.value+'/action', { method:'POST', body: JSON.stringify(formData) });
      } catch (e) {
        alert('提交失败：' + e.message);
      }
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
    document.getElementById('backupTab').innerHTML = BackupUI.renderPanel();
    DefectUI.init();
    ChemicalBatchUI.init();
    BoxSlotUI.init();
    ProcessUI.init();
    BackupUI.init();
    document.getElementById('studioSelect').onchange = function() { switchStudio(this.value); };
    document.getElementById('studioManageBtn').onclick = function() { openStudioModal(); };
    function openStudioModal() {
      let existing = document.getElementById('studioModal');
      if (existing) existing.remove();
      const modal = document.createElement('div');
      modal.id = 'studioModal';
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.5);display:flex;align-items:center;justify-content:center;z-index:2000';
      modal.innerHTML = '<div class="panel" style="width:500px;max-height:80vh;overflow:auto;position:relative">' +
        '<button id="closeStudioModal" class="secondary" style="position:absolute;top:10px;right:10px;padding:4px 8px">关闭</button>' +
        '<h2 style="margin-top:0">工作室管理</h2>' +
        '<div id="studioList" style="margin-bottom:14px"></div>' +
        '<div style="border-top:1px solid var(--line);padding-top:12px">' +
          '<h3 style="font-size:15px;margin:0 0 8px">新建工作室</h3>' +
          '<label>名称</label><input id="newStudioName" placeholder="输入工作室名称">' +
          '<label>说明</label><textarea id="newStudioDesc" rows="2" placeholder="工作室描述（可选）"></textarea>' +
          '<button id="createStudioBtn" style="margin-top:8px">创建工作室</button>' +
        '</div>' +
      '</div>';
      document.body.appendChild(modal);
      document.getElementById('closeStudioModal').onclick = () => modal.remove();
      modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
      renderStudioList();
      document.getElementById('createStudioBtn').onclick = async () => {
        const name = document.getElementById('newStudioName').value.trim();
        if (!name) { alert('工作室名称必填'); return; }
        const description = document.getElementById('newStudioDesc').value.trim();
        await fetch('/api/studios', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, description }) });
        document.getElementById('newStudioName').value = '';
        document.getElementById('newStudioDesc').value = '';
        await loadStudios();
        renderStudioList();
      };
    }
    function renderStudioList() {
      const container = document.getElementById('studioList');
      if (!container) return;
      container.innerHTML = studios.map(s =>
        '<div style="border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">' +
          '<div><strong>' + s.name + '</strong>' + (s.id === 'default' ? ' <span class="pill" style="background:#e8f5e4;color:var(--accent);border-color:#b8ddb0">默认</span>' : '') +
          (s.description ? '<div class="meta">' + s.description + '</div>' : '') + '</div>' +
          '<div style="display:flex;gap:6px">' +
            '<button class="secondary" style="font-size:12px;padding:4px 8px" data-switch-studio="' + s.id + '">切换</button>' +
            (s.id !== 'default' ? '<button class="secondary" style="font-size:12px;padding:4px 8px;background:var(--warn)" data-del-studio="' + s.id + '">删除</button>' : '') +
          '</div>' +
        '</div>'
      ).join('');
      container.querySelectorAll('[data-switch-studio]').forEach(btn => {
        btn.onclick = async () => {
          currentStudioId = btn.dataset.switchStudio;
          localStorage.setItem('currentStudioId', currentStudioId);
          document.getElementById('studioSelect').value = currentStudioId;
          await switchStudio(currentStudioId);
          document.getElementById('studioModal').remove();
        };
      });
      container.querySelectorAll('[data-del-studio]').forEach(btn => {
        btn.onclick = async () => {
          if (!confirm('确认删除此工作室？该工作室的所有数据将被永久删除。')) return;
          await fetch('/api/studios/' + btn.dataset.delStudio, { method: 'DELETE' });
          if (currentStudioId === btn.dataset.delStudio) {
            currentStudioId = 'default';
            localStorage.setItem('currentStudioId', 'default');
            document.getElementById('studioSelect').value = 'default';
            await switchStudio('default');
          }
          await loadStudios();
          renderStudioList();
        };
      });
    }
    loadStudios();
    load();
  </script>
</body>
</html>`;
}

function deliveryListPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>交付清单 - 古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --success:#3d7a3d; --info:#3a5a8a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0 0 8px; font-size:16px; }
    main { padding:22px 28px; max-width:1400px; margin:0 auto; }
    .panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input[type="text"],textarea,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    textarea { min-height:68px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:0.5; cursor:not-allowed; } button.small { padding:6px 10px; font-size:12px; font-weight:600; }
    .tabs { display:flex; gap:0; margin-bottom:14px; flex-wrap:wrap; }
    .tabs button { border-radius:6px 6px 0 0; background:var(--line); color:var(--ink); font-weight:400; padding:8px 14px; }
    .tabs button.active { background:var(--panel); font-weight:700; border:1px solid var(--line); border-bottom:0; }
    .tab-content { display:none; } .tab-content.active { display:block; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; }
    .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; }
    .stat strong { display:block; font-size:24px; } .stat span { color:var(--muted); font-size:13px; }
    .stat.warn strong { color:var(--warn); } .stat.success strong { color:var(--success); }
    table { width:100%; border-collapse:collapse; margin-top:10px; }
    th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; font-size:13px; vertical-align:top; }
    th { background:#f5f6f4; font-weight:600; white-space:nowrap; } tr:nth-child(even) { background:#fafbf9; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; margin:2px; }
    .pill.success { background:#e8f5e4; color:var(--success); border-color:#b8ddb0; }
    .pill.warn { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .pill.info { background:#e6eef8; color:var(--info); border-color:#b8cde8; }
    .pill.muted { background:#f0f1ef; color:var(--muted); }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
    .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .meta { color:var(--muted); font-size:13px; } .error { color:var(--warn); font-weight:600; }
    .back-btn { text-decoration:none; color:var(--ink); display:inline-flex; align-items:center; gap:6px; }
    .row-actions { display:flex; gap:6px; flex-wrap:wrap; }
    .hidden { display:none !important; }
    .batch-card { display:grid; gap:8px; }
    .batch-header { display:flex; justify-content:space-between; align-items:flex-start; gap:8px; flex-wrap:wrap; }
    .batch-header h3 { margin:0; }
    .batch-meta { color:var(--muted); font-size:13px; }
    .batch-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(340px,1fr)); gap:12px; }
    .form-grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:10px; }
    .form-grid label { margin:0; }
    .ungrouped-notice { background:#fef3d6; border:1px solid #f0d98a; border-radius:6px; padding:12px; margin-bottom:14px; }
    .empty-state { text-align:center; padding:40px; color:var(--muted); }
    .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:1000; }
    .modal { background:#fff; border-radius:8px; padding:24px; max-width:600px; width:90%; max-height:80vh; overflow:auto; }
    .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .modal-header h2 { margin:0; }
    .item-detail-grid { display:grid; grid-template-columns:120px 1fr; gap:6px 12px; font-size:13px; }
    .item-detail-grid dt { color:var(--muted); }
    .item-detail-grid dd { margin:0; }
    .confirm-row { background:#fff9e6 !important; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{padding:16px;} .batch-grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div>
      <a href="/" class="back-btn">&larr; 返回整理室</a>
      <h1 style="margin-top:8px">交付清单</h1>
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px"><label style="margin:0;font-size:13px;color:var(--muted)">当前工作室</label><select id="studioSelect" style="width:auto;min-width:140px;padding:6px 8px;font-size:14px"></select><div class="meta" id="studioDesc"></div></div>
      <div class="meta">按客户或交付批次归档已交付底片，导出清单</div>
    </div>
    <div style="display:flex;gap:8px"><button id="createBatchBtn">+ 新建批次</button><button class="secondary" id="reload">刷新</button></div>
  </header>
  <main>
    <div class="tabs">
      <button class="active" data-tab="batchesTab">交付批次</button>
      <button data-tab="ungroupedTab">未归档 <span id="ungroupedCount" class="pill warn" style="margin-left:4px">0</span></button>
    </div>

    <div id="batchesTab" class="tab-content active">
      <div class="toolbar">
        <select id="customerFilter"><option value="">全部客户</option></select>
        <input id="batchSearch" placeholder="搜索批次号、备注...">
      </div>
      <div class="stats" id="batchStats"></div>
      <div id="batchList" class="batch-grid"></div>
    </div>

    <div id="ungroupedTab" class="tab-content">
      <div class="ungrouped-notice">以下底片状态为「已交付」但尚未加入任何交付批次。可批量选择加入现有批次或创建新批次。</div>
      <div class="toolbar">
        <button id="assignSelectedBtn" disabled>加入选中到批次...</button>
        <button class="secondary" id="selectAllUngrouped">全选</button>
      </div>
      <div id="ungroupedList"></div>
    </div>
  </main>

  <div id="batchModal" class="modal-backdrop hidden">
    <div class="modal">
      <div class="modal-header">
        <h2 id="modalTitle">新建交付批次</h2>
        <button class="secondary small" id="closeModal">×</button>
      </div>
      <form id="batchForm">
        <div class="form-grid">
          <div><label>批次号</label><input name="batchNo" placeholder="如 D-20260622-01（留空自动生成）"></div>
          <div><label>客户名称</label><input name="customer" placeholder="客户/项目名称"></div>
          <div><label>交付日期</label><input name="deliveryDate" type="date"></div>
        </div>
        <label>备注</label><textarea name="note" rows="2" placeholder="批次说明..."></textarea>
        <div class="toolbar" style="margin-top:14px;justify-content:flex-end">
          <button type="button" class="secondary" id="cancelModal">取消</button>
          <button type="submit" id="submitBatch">保存批次</button>
        </div>
      </form>
    </div>
  </div>

  <div id="assignModal" class="modal-backdrop hidden">
    <div class="modal">
      <div class="modal-header">
        <h2>加入交付批次</h2>
        <button class="secondary small" id="closeAssignModal">×</button>
      </div>
      <div id="assignInfo" class="meta" style="margin-bottom:12px"></div>
      <label>选择目标批次</label>
      <select id="targetBatchSelect" style="margin-bottom:12px"><option value="">-- 选择批次 --</option></select>
      <div style="border:1px dashed var(--line);border-radius:6px;padding:10px;margin-bottom:12px">
        <label style="margin:0 0 6px">或新建批次</label>
        <div class="form-grid">
          <div><label style="margin:0">客户名称</label><input id="newCustomer" placeholder="客户/项目名称"></div>
          <div><label style="margin:0">交付日期</label><input id="newDeliveryDate" type="date"></div>
        </div>
        <button type="button" class="secondary small" id="createAndAssignBtn" style="margin-top:10px">创建并加入</button>
      </div>
      <div class="toolbar" style="justify-content:flex-end">
        <button type="button" class="secondary" id="cancelAssign">取消</button>
        <button id="confirmAssignBtn" disabled>加入所选批次</button>
      </div>
    </div>
  </div>

  <div id="detailModal" class="modal-backdrop hidden">
    <div class="modal" style="max-width:900px">
      <div class="modal-header">
        <h2 id="detailTitle">批次详情</h2>
        <button class="secondary small" id="closeDetailModal">×</button>
      </div>
      <div id="detailContent"></div>
    </div>
  </div>

  <script src="/public/delivery-list-ui.js"></script>
</body>
</html>`;
}

function importPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>批量导入底片 - 古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --success:#3d7a3d; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0 0 8px; font-size:16px; }
    main { padding:22px 28px; max-width:1200px; margin:0 auto; }
    .panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input[type="text"],textarea,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    textarea { min-height:150px; font-family:monospace; font-size:13px; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:0.5; cursor:not-allowed; }
    .tabs { display:flex; gap:0; margin-bottom:14px; flex-wrap:wrap; }
    .tabs button { border-radius:6px 6px 0 0; background:var(--line); color:var(--ink); font-weight:400; padding:8px 14px; }
    .tabs button.active { background:var(--panel); font-weight:700; border:1px solid var(--line); border-bottom:0; }
    .tab-content { display:none; } .tab-content.active { display:block; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; }
    .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; }
    .stat strong { display:block; font-size:24px; } .stat span { color:var(--muted); font-size:13px; }
    .stat.warn strong { color:var(--warn); } .stat.success strong { color:var(--success); }
    table { width:100%; border-collapse:collapse; margin-top:10px; }
    th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; font-size:13px; }
    th { background:#f5f6f4; font-weight:600; } tr.invalid { background:#fde8e8; }
    .mapped { color:var(--success); font-weight:600; } .unmapped { color:var(--warn); }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; margin:2px; }
    .pill.success { background:#e8f5e4; color:var(--success); border-color:#b8ddb0; }
    .pill.warn { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .pill.info { background:#e6eef8; color:#3a5a8a; border-color:#b8cde8; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
    .file-input { border:2px dashed var(--line); border-radius:8px; padding:30px; text-align:center; cursor:pointer; transition:all 0.2s; }
    .file-input:hover { border-color:var(--accent); background:#f5f8f2; }
    .file-input.dragover { border-color:var(--accent); background:#e8f0e2; }
    .file-input input { display:none; }
    .meta { color:var(--muted); font-size:13px; } .error { color:var(--warn); font-weight:600; }
    .back-btn { text-decoration:none; color:var(--ink); display:inline-flex; align-items:center; gap:6px; }
    .row-actions { display:flex; gap:6px; }
    .row-actions input[type="checkbox"] { width:auto; }
    .hidden { display:none !important; }
    .field-map-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px; align-items:center; }
    .field-map-grid select { margin:0; }
    .preview-section { margin-top:16px; }
    .section-title { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; }
    .table-container { max-height:400px; overflow:auto; }
    .success-banner { background:#e8f5e4; border:1px solid #b8ddb0; border-radius:8px; padding:16px; margin-bottom:16px; }
    .success-banner h3 { color:var(--success); margin:0 0 8px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{padding:16px;} .field-map-grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <header>
    <div>
      <a href="/" class="back-btn">&larr; 返回整理室</a>
      <h1 style="margin-top:8px">批量导入底片</h1>
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px"><label style="margin:0;font-size:13px;color:var(--muted)">当前工作室</label><select id="studioSelect" style="width:auto;min-width:140px;padding:6px 8px;font-size:14px"></select><div class="meta" id="studioDesc"></div></div>
      <div class="meta">上传或粘贴CSV格式的底片清单，预览后批量创建</div>
    </div>
  </header>
  <main>
    <div id="step1" class="panel">
      <h2>第一步：上传或粘贴CSV数据</h2>
      <div class="tabs">
        <button class="active" data-tab="uploadTab">上传文件</button>
        <button data-tab="pasteTab">粘贴内容</button>
      </div>
      <div id="uploadTab" class="tab-content active">
        <label class="file-input" id="dropZone">
          <input type="file" id="fileInput" accept=".csv,text/csv">
          <div style="font-size:16px;font-weight:600;">点击选择或拖拽CSV文件到此处</div>
          <div class="meta" style="margin-top:6px">支持 .csv 格式文件</div>
        </label>
      </div>
      <div id="pasteTab" class="tab-content">
        <label>粘贴CSV内容</label>
        <textarea id="csvTextarea" placeholder="底片编号,玻璃板尺寸,药液批次,曝光时间,冲洗水源,存放盒位,状态
CN-002,18x24cm,B-0621,10分钟,自来水,蓝盒A-04,待曝光
CN-003,20x25cm,B-0620,8分钟,井水过滤,蓝盒A-05,冲洗中"></textarea>
      </div>
      <div class="toolbar" style="margin-top:14px">
        <button id="previewBtn" disabled>预览导入结果</button>
        <button class="secondary" id="clearBtn">清空</button>
      </div>
      <div class="meta">
        <b>支持的字段：</b>底片编号(code)、玻璃板尺寸(plateSize)、药液批次(chemicalBatch)、曝光时间(exposure)、冲洗水源(waterSource)、存放盒位(box)、状态(status)、缺陷类型(defect)<br>
        <b>必填字段：</b>底片编号(code)<br>
        <b>状态可选值：</b>待曝光、冲洗中、待入盒、已交付
      </div>
    </div>

    <div id="step2" class="panel hidden">
      <div class="section-title">
        <h2>第二步：预览和确认</h2>
        <button class="secondary" id="backBtn">返回修改</button>
      </div>

      <div class="stats">
        <div class="stat"><span>总行数</span><strong id="totalRows">0</strong></div>
        <div class="stat success"><span>将创建</span><strong id="willCreate">0</strong></div>
        <div class="stat warn"><span>重复编号</span><strong id="duplicateCount">0</strong></div>
        <div class="stat warn"><span>缺失必填</span><strong id="missingCount">0</strong></div>
        <div class="stat"><span>未映射字段</span><strong id="unmappedCount">0</strong></div>
      </div>

      <div id="fieldMappingPanel" class="panel" style="margin-top:0">
        <h3>字段映射</h3>
        <div id="fieldMappingGrid" class="field-map-grid"></div>
      </div>

      <div id="warningsPanel" class="panel hidden" style="margin-top:0">
        <h3><span class="pill warn">警告</span></h3>
        <div id="warningsList"></div>
      </div>

      <div id="errorsPanel" class="panel hidden" style="margin-top:0">
        <h3><span class="pill warn">错误</span></h3>
        <div id="errorsList"></div>
      </div>

      <div class="preview-section">
        <div class="section-title">
          <h3>数据预览</h3>
          <label style="margin:0"><input type="checkbox" id="selectAll" checked> 全部选中</label>
        </div>
        <div class="table-container">
          <table id="previewTable">
            <thead><tr id="previewHead"></tr></thead>
            <tbody id="previewBody"></tbody>
          </table>
        </div>
      </div>

      <div class="toolbar" style="margin-top:16px">
        <button id="confirmBtn" disabled>确认导入 <span id="confirmCount"></span></button>
        <button class="secondary" id="cancelBtn">取消</button>
      </div>
    </div>

    <div id="step3" class="hidden">
      <div class="success-banner">
        <h3>&check; 导入成功！</h3>
        <div id="successMessage"></div>
      </div>
      <div class="panel">
        <h3>已创建的底片</h3>
        <div class="table-container">
          <table id="resultTable">
            <thead><tr><th>编号</th><th>尺寸</th><th>状态</th><th>盒位</th><th>建档日志</th></tr></thead>
            <tbody id="resultBody"></tbody>
          </table>
        </div>
        <div class="toolbar" style="margin-top:16px">
          <button onclick="location.href='/'">返回整理室</button>
          <button class="secondary" onclick="location.reload()">继续导入</button>
        </div>
      </div>
    </div>
  </main>

  <script src="/public/import-ui.js"></script>
</body>
</html>`;
}

function auditLogsPage() {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>操作审计日志 - 古法蓝晒底片整理室</title>
  <style>
    :root { --bg:#f1f3ef; --panel:#fff; --ink:#20241f; --muted:#687066; --line:#d4ddd0; --accent:#526f43; --warn:#9b4937; --success:#3d7a3d; --info:#3a5a8a; }
    * { box-sizing:border-box; } body { margin:0; background:var(--bg); color:var(--ink); font-family:Arial,"PingFang SC",sans-serif; }
    header { padding:22px 28px; background:#fff; border-bottom:1px solid var(--line); display:flex; justify-content:space-between; gap:16px; align-items:center; }
    h1 { margin:0; font-size:26px; } h2 { margin:0 0 12px; font-size:18px; } h3 { margin:0 0 8px; font-size:16px; }
    main { padding:22px 28px; max-width:1400px; margin:0 auto; }
    .panel,.card { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:16px; margin-bottom:16px; }
    label { display:block; margin:10px 0 5px; color:var(--muted); font-size:13px; }
    input[type="text"],textarea,select { width:100%; border:1px solid var(--line); border-radius:6px; padding:9px; font:inherit; background:#fff; }
    button { border:0; border-radius:6px; background:var(--accent); color:#fff; padding:10px 13px; font-weight:700; cursor:pointer; }
    button.secondary { background:#69736a; } button.danger { background:var(--warn); } button:disabled { opacity:0.5; cursor:not-allowed; } button.small { padding:6px 10px; font-size:12px; font-weight:600; }
    .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(140px,1fr)); gap:10px; margin-bottom:14px; }
    .stat { background:var(--panel); border:1px solid var(--line); border-radius:8px; padding:12px; text-align:center; }
    .stat strong { display:block; font-size:24px; } .stat span { color:var(--muted); font-size:13px; }
    .stat.warn strong { color:var(--warn); } .stat.success strong { color:var(--success); }
    table { width:100%; border-collapse:collapse; margin-top:10px; }
    th,td { border:1px solid var(--line); padding:8px 10px; text-align:left; font-size:13px; vertical-align:top; }
    th { background:#f5f6f4; font-weight:600; white-space:nowrap; } tr:nth-child(even) { background:#fafbf9; }
    .pill { display:inline-block; border:1px solid var(--line); border-radius:999px; padding:3px 8px; font-size:12px; margin:2px; }
    .pill.success { background:#e8f5e4; color:var(--success); border-color:#b8ddb0; }
    .pill.warn { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .pill.info { background:#e6eef8; color:var(--info); border-color:#b8cde8; }
    .pill.muted { background:#f0f1ef; color:var(--muted); }
    .pill.create { background:#e8f5e4; color:var(--success); border-color:#b8ddb0; }
    .pill.update_status { background:#e6eef8; color:var(--info); border-color:#b8cde8; }
    .pill.add_note { background:#fef3d6; color:#8a6d12; border-color:#f0d98a; }
    .pill.record_step { background:#eaf2e6; color:var(--accent); border-color:#b8ddb0; }
    .pill.skip_step { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .pill.import { background:#f3e8f5; color:#7a3d7a; border-color:#dbb8dd; }
    .pill.update_field { background:#f5f0e8; color:#8a6d12; border-color:#ddd0b8; }
    .pill.backup { background:#e6eef8; color:#3a5a8a; border-color:#b8cde8; }
    .pill.restore { background:#fef3d6; color:#8a6d12; border-color:#f0d98a; }
    .pill.delete_backup { background:#fde8e8; color:var(--warn); border-color:#f5c2c2; }
    .toolbar { display:flex; gap:10px; flex-wrap:wrap; margin-bottom:14px; align-items:center; }
    .toolbar select,.toolbar input { width:auto; min-width:160px; }
    .meta { color:var(--muted); font-size:13px; } .error { color:var(--warn); font-weight:600; }
    .back-btn { text-decoration:none; color:var(--ink); display:inline-flex; align-items:center; gap:6px; }
    .row-actions { display:flex; gap:6px; flex-wrap:wrap; }
    .hidden { display:none !important; }
    .empty-state { text-align:center; padding:40px; color:var(--muted); }
    .diff-block { background:#fafbf9; border:1px solid var(--line); border-radius:4px; padding:8px; margin:4px 0; font-size:12px; font-family:monospace; max-height:120px; overflow:auto; }
    .diff-label { font-weight:600; color:var(--muted); margin-bottom:4px; }
    .diff-before { color:var(--warn); }
    .diff-after { color:var(--success); }
    .summary-cell { max-width:300px; }
    .code-cell { font-family:monospace; font-size:12px; }
    @media (max-width:900px){ header{display:block;padding:18px 16px;} main{padding:16px;} .toolbar{flex-direction:column;align-items:stretch;} .toolbar select,.toolbar input{width:100%;} }
  </style>
</head>
<body>
  <header>
    <div>
      <a href="/" class="back-btn">&larr; 返回整理室</a>
      <h1 style="margin-top:8px">操作审计日志</h1>
      <div style="display:flex;align-items:center;gap:6px;margin-top:6px"><label style="margin:0;font-size:13px;color:var(--muted)">当前工作室</label><select id="studioSelect" style="width:auto;min-width:140px;padding:6px 8px;font-size:14px"></select><div class="meta" id="studioDesc"></div></div>
      <div class="meta">记录所有关键操作的时间、对象、动作类型和变更摘要</div>
    </div>
    <div style="display:flex;gap:8px"><button class="secondary" id="reload">刷新</button><button id="clearFilters">清除筛选</button></div>
  </header>
  <main>
    <div class="panel">
      <h2>筛选条件</h2>
      <div class="toolbar">
        <div style="flex:1;min-width:200px">
          <label>底片编号</label>
          <input id="codeFilter" placeholder="输入底片编号关键词">
        </div>
        <div style="flex:1;min-width:200px">
          <label>动作类型</label>
          <select id="actionFilter">
            <option value="">全部类型</option>
          </select>
        </div>
        <div style="flex:1;min-width:200px">
          <label>日期关键词</label>
          <input id="dateFilter" placeholder="如 2026-06 或 2026-06-22">
        </div>
        <div style="align-self:flex-end">
          <button id="applyFilter">查询</button>
        </div>
      </div>
    </div>

    <div class="stats" id="stats"></div>

    <div class="panel">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">
        <h2 style="margin:0">审计日志列表</h2>
        <span id="resultCount" class="meta"></span>
      </div>
      <div style="overflow-x:auto">
        <table id="auditTable">
          <thead>
            <tr>
              <th style="width:180px">时间</th>
              <th style="width:120px">底片编号</th>
              <th style="width:120px">动作类型</th>
              <th>操作摘要</th>
              <th style="width:100px">操作</th>
            </tr>
          </thead>
          <tbody id="auditBody">
          </tbody>
        </table>
      </div>
      <div id="emptyState" class="empty-state hidden">
        暂无审计记录
      </div>
    </div>
  </main>

  <div id="detailModal" class="modal-backdrop hidden">
    <div class="modal" style="max-width:700px">
      <div class="modal-header">
        <h2 id="modalTitle">审计详情</h2>
        <button class="secondary small" id="closeModal">×</button>
      </div>
      <div id="modalContent" style="max-height:60vh;overflow:auto"></div>
    </div>
  </div>

  <style>
    .modal-backdrop { position:fixed; inset:0; background:rgba(0,0,0,0.5); display:flex; align-items:center; justify-content:center; z-index:1000; }
    .modal { background:#fff; border-radius:8px; padding:24px; max-width:600px; width:90%; max-height:80vh; overflow:auto; }
    .modal-header { display:flex; justify-content:space-between; align-items:center; margin-bottom:16px; }
    .modal-header h2 { margin:0; }
    .detail-grid { display:grid; grid-template-columns:100px 1fr; gap:8px 16px; font-size:13px; }
    .detail-grid dt { color:var(--muted); font-weight:600; }
    .detail-grid dd { margin:0; word-break:break-all; }
    .json-pre { background:#f5f6f4; border:1px solid var(--line); border-radius:4px; padding:12px; font-family:monospace; font-size:12px; max-height:200px; overflow:auto; }
  </style>

  <script>
    let allLogs = [];
    let actionLabels = {};
    let actionTypes = {};
    let studios = [];
    let currentStudioId = localStorage.getItem('currentStudioId') || 'default';

    async function api(path, options) {
      const sep = path.includes('?') ? '&' : '?';
      const studioPath = path + sep + 'studioId=' + encodeURIComponent(currentStudioId);
      const res = await fetch(studioPath, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');
      return data;
    }

    async function loadStudios() {
      const res = await fetch('/api/studios');
      studios = await res.json();
      const sel = document.getElementById('studioSelect');
      sel.innerHTML = studios.map(s => '<option value="' + s.id + '"' + (s.id === currentStudioId ? ' selected' : '') + '>' + s.name + '</option>').join('');
      const current = studios.find(s => s.id === currentStudioId);
      const descEl = document.getElementById('studioDesc');
      if (descEl && current) descEl.textContent = current.description || '';
      sel.onchange = function() { switchStudio(this.value); };
    }

    async function switchStudio(id) {
      if (id === currentStudioId) return;
      currentStudioId = id;
      localStorage.setItem('currentStudioId', id);
      allLogs = [];
      const tbody = document.getElementById('auditBody');
      const empty = document.getElementById('emptyState');
      const resultCount = document.getElementById('resultCount');
      const statsEl = document.getElementById('stats');
      tbody.innerHTML = '';
      empty.classList.remove('hidden');
      resultCount.textContent = '加载中...';
      statsEl.innerHTML = '';
      const current = studios.find(s => s.id === currentStudioId);
      const descEl = document.getElementById('studioDesc');
      if (descEl && current) descEl.textContent = current.description || '';
      const meta = await api('/api/audit-logs/meta');
      actionLabels = meta.actionLabels || {};
      actionTypes = meta.actionTypes || {};
      renderActionFilter();
      await load();
    }

    function getActionLabel(type) {
      return actionLabels[type] || type;
    }

    function renderActionFilter() {
      const sel = document.getElementById('actionFilter');
      const cur = sel.value;
      sel.innerHTML = '<option value="">全部类型</option>' +
        Object.entries(actionLabels).map(([type, label]) => 
          '<option value="' + type + '" ' + (type===cur?'selected':'') + '>' + label + '</option>'
        ).join('');
    }

    function renderStats() {
      const stats = {};
      allLogs.forEach(log => {
        stats[log.actionType] = (stats[log.actionType] || 0) + 1;
      });
      const statsEl = document.getElementById('stats');
      statsEl.innerHTML = Object.entries(stats).map(([type, count]) => 
        '<div class="stat"><span>' + getActionLabel(type) + '</span><strong>' + count + '</strong></div>'
      ).join('');
    }

    function formatTime(iso) {
      const d = new Date(iso);
      return d.toLocaleString('zh-CN', { 
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      });
    }

    function renderTable(logs) {
      const tbody = document.getElementById('auditBody');
      const empty = document.getElementById('emptyState');
      const resultCount = document.getElementById('resultCount');

      if (logs.length === 0) {
        tbody.innerHTML = '';
        empty.classList.remove('hidden');
        resultCount.textContent = '共 0 条记录';
        return;
      }

      empty.classList.add('hidden');
      resultCount.textContent = '共 ' + logs.length + ' 条记录';

      tbody.innerHTML = logs.map(log => {
        const code = log.itemCode || '-';
        return '<tr>' +
          '<td>' + formatTime(log.timestamp) + '</td>' +
          '<td class="code-cell">' + code + '</td>' +
          '<td><span class="pill ' + log.actionType + '">' + getActionLabel(log.actionType) + '</span></td>' +
          '<td class="summary-cell">' + (log.summary || '') + '</td>' +
          '<td><button class="secondary small" data-detail="' + log.id + '">详情</button></td>' +
        '</tr>';
      }).join('');

      tbody.querySelectorAll('[data-detail]').forEach(btn => {
        btn.onclick = () => showDetail(btn.dataset.detail);
      });
    }

    function showDetail(logId) {
      const log = allLogs.find(l => l.id === logId);
      if (!log) return;

      const modal = document.getElementById('detailModal');
      const content = document.getElementById('modalContent');
      const title = document.getElementById('modalTitle');

      title.textContent = '审计详情 - ' + getActionLabel(log.actionType);

      let html = '<dl class="detail-grid">' +
        '<dt>记录ID</dt><dd>' + log.id + '</dd>' +
        '<dt>操作时间</dt><dd>' + formatTime(log.timestamp) + '</dd>' +
        '<dt>动作类型</dt><dd><span class="pill ' + log.actionType + '">' + getActionLabel(log.actionType) + '</span></dd>' +
        '<dt>底片编号</dt><dd>' + (log.itemCode || '-') + '</dd>' +
        '<dt>对象ID</dt><dd>' + (log.itemId || '-') + '</dd>' +
        '<dt>操作摘要</dt><dd>' + (log.summary || '-') + '</dd>';

      if (log.before) {
        html += '<dt>变更前</dt><dd><pre class="json-pre diff-before">' + JSON.stringify(log.before, null, 2) + '</pre></dd>';
      }
      if (log.after) {
        html += '<dt>变更后</dt><dd><pre class="json-pre diff-after">' + JSON.stringify(log.after, null, 2) + '</pre></dd>';
      }

      html += '</dl>';

      content.innerHTML = html;
      modal.classList.remove('hidden');
    }

    async function load() {
      const codeFilter = document.getElementById('codeFilter').value.trim();
      const actionFilter = document.getElementById('actionFilter').value;
      const dateFilter = document.getElementById('dateFilter').value.trim();

      const params = new URLSearchParams();
      if (codeFilter) params.set('itemCode', codeFilter);
      if (actionFilter) params.set('actionType', actionFilter);
      if (dateFilter) params.set('dateKeyword', dateFilter);

      const url = '/api/audit-logs' + (params.toString() ? '?' + params.toString() : '');
      const data = await api(url);

      allLogs = data.logs || [];
      actionLabels = data.actionLabels || {};
      actionTypes = data.actionTypes || {};

      renderActionFilter();
      renderStats();
      renderTable(allLogs);
    }

    document.getElementById('applyFilter').onclick = load;
    document.getElementById('reload').onclick = load;
    document.getElementById('clearFilters').onclick = () => {
      document.getElementById('codeFilter').value = '';
      document.getElementById('actionFilter').value = '';
      document.getElementById('dateFilter').value = '';
      load();
    };

    document.getElementById('closeModal').onclick = () => {
      document.getElementById('detailModal').classList.add('hidden');
    };

    document.getElementById('detailModal').onclick = (e) => {
      if (e.target.id === 'detailModal') {
        document.getElementById('detailModal').classList.add('hidden');
      }
    };

    ['codeFilter', 'dateFilter'].forEach(id => {
      document.getElementById(id).addEventListener('keypress', (e) => {
        if (e.key === 'Enter') load();
      });
    });

    (async function init() {
      await loadStudios();
      const meta = await api('/api/audit-logs/meta');
      actionLabels = meta.actionLabels || {};
      actionTypes = meta.actionTypes || {};
      renderActionFilter();
      await load();
    })();
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const studioId = url.searchParams.get("studioId") || "default";

    if (await serveStatic(req, res, url)) return;

    const studioResult = await handleStudioRoutes(req, res, url);
    if (studioResult !== null) return;

    const defectResult = await handleDefectsRoutes(req, res, url, studioId);
    if (defectResult !== null) return;

    const batchResult = await handleBatchRoutes(req, res, url, studioId);
    if (batchResult !== null) return;

    const boxSlotResult = await handleBoxSlotRoutes(req, res, url, studioId);
    if (boxSlotResult !== null) return;

    const templateResult = await handleTemplateRoutes(req, res, url, studioId);
    if (templateResult !== null) return;

    const backupResult = await handleBackupRoutes(req, res, url, studioId);
    if (backupResult !== null) return;

    const db = await loadDb(studioId);

    const deliveryBatchResult = await handleDeliveryBatchRoutes(req, res, url, db.items, studioId);
    if (deliveryBatchResult !== null) return;
    const templateDb = await loadTemplates(studioId);

    if (req.method === "GET" && url.pathname === "/") return html(res, page());
    if (req.method === "GET" && url.pathname === "/api/items") {
      const enriched = await Promise.all(db.items.map(i => summarizeItem(i, studioId)));
      return send(res, 200, enriched);
    }
    if (req.method === "POST" && url.pathname === "/api/items") {
      const input = await body(req);
      let item = { id: newId(), ...input, logs: [{ at: new Date().toISOString(), step: "建档", note: "创建底片" }] };
      if (input.templateId) {
        const { item: templatedItem } = await createItemWithTemplate(item, input.templateId, templateDb, studioId);
        item = templatedItem;
      }
      db.items.unshift(item);
      await saveDb(db, studioId);
      await syncSlotOccupancy(studioId);
      await auditCreateItem(item, studioId);
      return send(res, 201, item);
    }
    const patch = url.pathname.match(/^\/api\/items\/([^/]+)$/);
    if (patch && req.method === "PATCH") {
      const item = db.items.find(x => x.id === patch[1] || x.code === patch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const raw = await body(req);
      const protectedFields = ["templateId", "templateName", "processSteps"];
      if (!hasTemplate(item)) {
        for (const key of protectedFields) {
          if (key in raw) delete raw[key];
        }
      }
      const oldStatus = item.status;
      const oldBox = item.box;
      Object.assign(item, raw);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: "状态", note: "更新为" + item.status });
      await saveDb(db, studioId);
      await syncSlotOccupancy(studioId);
      if (raw.status && oldStatus !== raw.status) {
        const extraChanges = { before: {}, after: {} };
        if (raw.box !== undefined && oldBox !== raw.box) {
          extraChanges.before.box = oldBox;
          extraChanges.after.box = raw.box;
        }
        await auditUpdateStatus(item, oldStatus, raw.status, extraChanges, studioId);
      } else if (raw.box !== undefined && oldBox !== raw.box) {
        await auditUpdateField(item, "box", oldBox, raw.box, studioId);
      }
      return send(res, 200, item);
    }
    const log = url.pathname.match(/^\/api\/items\/([^/]+)\/logs$/);
    if (log && req.method === "POST") {
      const item = db.items.find(x => x.id === log[1] || x.code === log[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      item.logs ||= [];
      item.logs.push({ at: new Date().toISOString(), step: input.step || "记录", note: input.note || "" });
      await saveDb(db, studioId);
      await auditAddNote(item, input.step || "记录", input.note || "", studioId);
      return send(res, 201, item);
    }
    const skipMatch = url.pathname.match(/^\/api\/items\/([^/]+)\/skip-step$/);
    if (skipMatch && req.method === "POST") {
      const item = db.items.find(x => x.id === skipMatch[1] || x.code === skipMatch[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const template = (templateDb.templates || []).find(t => t.id === item.templateId);
      const stepDef = template ? template.steps.find(s => s.key === input.stepKey) : null;
      const result = await skipStep(item, input.stepKey, input.skipReason, templateDb, studioId);
      if (!result.success) {
        return send(res, 400, { error: result.error });
      }
      await saveDb(db, studioId);
      if (stepDef) {
        await auditSkipStep(item, stepDef.name, input.skipReason, studioId);
      }
      return send(res, 200, result.item);
    }
    const action = url.pathname.match(/^\/api\/items\/([^/]+)\/action$/);
    if (action && req.method === "POST") {
      const item = db.items.find(x => x.id === action[1] || x.code === action[1]);
      if (!item) return send(res, 404, { error: "item_not_found" });
      const input = await body(req);
      const beforeItem = JSON.parse(JSON.stringify(item));
      const result = await recordStepAction(item, input, templateDb, studioId);
      if (result.error) {
        return send(res, 400, { error: result.error });
      }
      await saveDb(db, studioId);
      await syncSlotOccupancy(studioId);
      await auditRecordStep(item, input, beforeItem, item, studioId);
      return send(res, 201, result.item);
    }
    if (req.method === "GET" && url.pathname === "/api/stats") return send(res, 200, computeStats(db.items));

    if (req.method === "GET" && url.pathname === "/api/import/fields") {
      return send(res, 200, { fields: FIELD_MAPPINGS });
    }

    if (req.method === "POST" && url.pathname === "/api/import/preview") {
      let csvText = "";
      const contentType = req.headers["content-type"] || "";

      if (contentType.includes("multipart/form-data")) {
        const boundaryMatch = contentType.match(/boundary=([^;]+)/);
        if (!boundaryMatch) return send(res, 400, { error: "invalid_multipart_boundary" });
        const boundary = boundaryMatch[1].trim();
        const buffer = await rawBody(req);
        const parts = parseMultipartFormData(buffer, boundary);
        const filePart = parts.find(p => p.name === "file");
        if (!filePart) return send(res, 400, { error: "no_file_uploaded" });
        csvText = filePart.content.toString("utf8");
      } else {
        const input = await body(req);
        csvText = input.csvText || "";
      }

      if (!csvText.trim()) return send(res, 400, { error: "empty_csv" });

      const { headers, rows } = parseCSV(csvText);
      if (headers.length === 0) return send(res, 400, { error: "invalid_csv_headers" });

      const { mapping, unmapped } = mapHeadersToFields(headers);
      const validation = validateImport(rows, db.items, mapping);

      return send(res, 200, {
        headers,
        mapping,
        unmapped,
        ...validation
      });
    }

    if (req.method === "POST" && url.pathname === "/api/import/confirm") {
      const input = await body(req);
      const { csvText, confirmedRows } = input;

      if (!csvText || !confirmedRows || !Array.isArray(confirmedRows) || confirmedRows.length === 0) {
        return send(res, 400, { error: "invalid_input" });
      }

      const { headers, rows } = parseCSV(csvText);
      const { mapping } = mapHeadersToFields(headers);
      const validation = validateImport(rows, db.items, mapping);

      if (validation.errors.length > 0) {
        return send(res, 400, { error: "validation_errors", details: validation.errors });
      }

      const createdItems = [];
      const now = new Date().toISOString();

      for (const confirmedRow of confirmedRows) {
        const rowData = validation.validRows.find(r => r.row === confirmedRow);
        if (!rowData) continue;

        const item = createImportItem(rowData.data);
        db.items.unshift(item);
        createdItems.push(item);

        if (item.chemicalBatch && item.code) {
          try {
            const batchPath = getDataPath(studioId, "chemical-batches.json");
            const batchDb = JSON.parse(await readFile(batchPath, "utf8"));
            const batch = (batchDb.batches || []).find(b => b.batchNo === item.chemicalBatch);
            if (batch && !batch.negativeCodes.includes(item.code)) {
              batch.negativeCodes.push(item.code);
              await writeFile(batchPath, JSON.stringify(batchDb, null, 2));
            }
          } catch (e) {}
        }
      }

      await saveDb(db, studioId);
      await syncSlotOccupancy(studioId);

      const importLog = {
        at: now,
        step: "批量导入",
        note: `成功导入 ${createdItems.length} 条底片记录`,
        importedCount: createdItems.length,
        importedCodes: createdItems.map(i => i.code)
      };

      await auditImport(createdItems.length, createdItems.map(i => i.code), importLog, createdItems, studioId);

      return send(res, 201, {
        success: true,
        created: createdItems.length,
        items: createdItems,
        importLog
      });
    }

    if (req.method === "GET" && url.pathname === "/delivery-list") {
      return html(res, deliveryListPage());
    }

    if (req.method === "GET" && url.pathname === "/import") {
      return html(res, importPage());
    }

    if (req.method === "GET" && url.pathname === "/audit-logs") {
      return html(res, auditLogsPage());
    }

    if (req.method === "GET" && url.pathname === "/api/audit-logs") {
      const filters = {
        itemCode: url.searchParams.get("itemCode") || "",
        actionType: url.searchParams.get("actionType") || "",
        dateKeyword: url.searchParams.get("dateKeyword") || ""
      };
      const logs = await getAuditLogs(filters, studioId);
      return send(res, 200, { logs, actionTypes: AUDIT_ACTION_TYPES, actionLabels: AUDIT_ACTION_LABELS });
    }

    if (req.method === "GET" && url.pathname === "/api/audit-logs/meta") {
      return send(res, 200, { actionTypes: AUDIT_ACTION_TYPES, actionLabels: AUDIT_ACTION_LABELS });
    }

    send(res, 404, { error: "not_found" });
  } catch (error) {
    send(res, 500, { error: error.message });
  }
});
server.listen(port, async () => {
  const migrated = await migrateOldFiles();
  if (migrated) console.log("已将旧数据迁移至默认工作室目录");
  console.log("古法蓝晒底片整理室 listening on http://localhost:" + port);
});
