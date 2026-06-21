window.ChemicalBatchUI = (function () {
  let batches = [];
  const batchStatuses = ["可用", "即将过期", "已过期", "已废弃"];

  async function api(path, options) {
    const res = await fetch(
      path,
      options && options.body
        ? { ...options, headers: { "Content-Type": "application/json" } }
        : options
    );
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "请求失败");
    return data;
  }

  async function load() {
    batches = await api("/api/chemical-batches");
    return batches;
  }

  function getBatches() {
    return batches;
  }

  function findById(id) {
    return batches.find(b => b.id === id);
  }

  function findByBatchNo(batchNo) {
    return batches.find(b => b.batchNo === batchNo);
  }

  function statusClass(status) {
    if (status === "可用") return "sev-minor";
    if (status === "即将过期") return "sev-moderate";
    if (status === "已过期" || status === "已废弃") return "sev-critical";
    return "sev-minor";
  }

  function renderPanel() {
    return `
      <form id="batchForm" class="panel" style="margin-top:14px">
        <h2>药液批次台账</h2>
        <input id="batchSearch" placeholder="搜索批次号、配方或底片编号" style="margin-bottom:10px">
        <div id="batchList" style="max-height:280px;overflow:auto"></div>
        <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
          <h3 style="font-size:15px;margin:0 0 8px">新增 / 编辑药液批次</h3>
          <input type="hidden" id="batchEditId">
          <label>批次号</label><input id="batchNo" required>
          <label>配制日期</label><input id="batchMixDate" type="date">
          <label>配方备注</label><textarea id="batchFormula" rows="2"></textarea>
          <label>可用状态</label><select id="batchStatus">
            ${batchStatuses.map(s => '<option>' + s + '</option>').join('')}
          </select>
          <label>关联底片编号（逗号分隔）</label><textarea id="batchNegativeCodes" rows="2" placeholder="CN-001, CN-002"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="submit" id="batchSaveBtn">保存批次</button>
            <button type="button" class="secondary" id="batchCancelBtn" style="display:none">取消编辑</button>
          </div>
        </div>
      </form>
    `;
  }

  function renderBatchList(list) {
    const container = document.getElementById("batchList");
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="meta">暂无药液批次</div>';
      return;
    }
    container.innerHTML = list.map(b => `
      <div class="defect-row ${statusClass(b.status)}" data-batch-id="${b.id}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${b.batchNo}</strong>
          <span class="pill ${statusClass(b.status)}">${b.status}</span>
        </div>
        <div class="meta" style="margin:4px 0">${b.mixDate ? '配制：' + b.mixDate : ''}${b.formula ? ' · ' + b.formula : ''}</div>
        <div class="meta">关联底片：${(b.negativeCodes || []).length ? b.negativeCodes.join(', ') : '暂无'}</div>
        <div style="display:flex;gap:6px;margin-top:4px">
          <button class="secondary batch-edit-btn" data-id="${b.id}" style="font-size:12px;padding:4px 8px">编辑</button>
          <button class="secondary batch-del-btn" data-id="${b.id}" style="font-size:12px;padding:4px 8px;background:var(--warn)">删除</button>
          <button class="secondary batch-detail-btn" data-id="${b.id}" style="font-size:12px;padding:4px 8px">查看底片</button>
        </div>
      </div>
    `).join('');

    container.querySelectorAll(".batch-edit-btn").forEach(btn => {
      btn.onclick = () => startEdit(btn.dataset.id);
    });
    container.querySelectorAll(".batch-del-btn").forEach(btn => {
      btn.onclick = () => deleteBatch(btn.dataset.id);
    });
    container.querySelectorAll(".batch-detail-btn").forEach(btn => {
      btn.onclick = () => showDetail(btn.dataset.id);
    });
  }

  function renderBatchSelect(selectEl) {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML =
      '<option value="">-- 选择已有批次 --</option>' +
      batches.filter(b => b.status === "可用").map(b =>
        `<option value="${b.batchNo}">${b.batchNo}（${b.mixDate || '无日期'}）</option>`
      ).join('');
    if (current) selectEl.value = current;
  }

  function startEdit(id) {
    const b = findById(id);
    if (!b) return;
    document.getElementById("batchEditId").value = b.id;
    document.getElementById("batchNo").value = b.batchNo;
    document.getElementById("batchMixDate").value = b.mixDate;
    document.getElementById("batchFormula").value = b.formula;
    document.getElementById("batchStatus").value = b.status;
    document.getElementById("batchNegativeCodes").value = (b.negativeCodes || []).join(", ");
    document.getElementById("batchSaveBtn").textContent = "更新批次";
    document.getElementById("batchCancelBtn").style.display = "";
  }

  function resetForm() {
    document.getElementById("batchEditId").value = "";
    document.getElementById("batchNo").value = "";
    document.getElementById("batchMixDate").value = "";
    document.getElementById("batchFormula").value = "";
    document.getElementById("batchStatus").value = "可用";
    document.getElementById("batchNegativeCodes").value = "";
    document.getElementById("batchSaveBtn").textContent = "保存批次";
    document.getElementById("batchCancelBtn").style.display = "none";
  }

  async function saveBatchFn() {
    const id = document.getElementById("batchEditId").value;
    const negativeCodes = document.getElementById("batchNegativeCodes").value
      .split(/[,，\s]+/)
      .map(c => c.trim())
      .filter(Boolean);
    const payload = {
      batchNo: document.getElementById("batchNo").value.trim(),
      mixDate: document.getElementById("batchMixDate").value,
      formula: document.getElementById("batchFormula").value.trim(),
      status: document.getElementById("batchStatus").value,
      negativeCodes
    };
    if (!payload.batchNo) return;
    if (id) {
      await api("/api/chemical-batches/" + id, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/chemical-batches", { method: "POST", body: JSON.stringify(payload) });
    }
    resetForm();
    await load();
    renderBatchList(batches);
  }

  async function deleteBatch(id) {
    if (!confirm("确认删除此药液批次？")) return;
    await api("/api/chemical-batches/" + id, { method: "DELETE" });
    await load();
    renderBatchList(batches);
  }

  function showDetail(id) {
    const b = findById(id);
    if (!b) return;
    let existing = document.getElementById("batchDetailModal");
    if (existing) existing.remove();

    const modal = document.createElement("div");
    modal.id = "batchDetailModal";
    modal.dataset.batchId = id;
    modal.style.cssText = "position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;z-index:1000";
    modal.innerHTML = `
      <div class="panel" style="width:480px;max-height:80vh;overflow:auto;position:relative">
        <button id="closeBatchDetail" class="secondary" style="position:absolute;top:10px;right:10px;padding:4px 8px">关闭</button>
        <h2 style="margin-top:0">批次详情：${b.batchNo}</h2>
        <div style="margin:8px 0"><b>配制日期：</b>${b.mixDate || '未填写'}</div>
        <div style="margin:8px 0"><b>配方备注：</b>${b.formula || '未填写'}</div>
        <div style="margin:8px 0"><b>可用状态：</b><span class="pill ${statusClass(b.status)}">${b.status}</span></div>
        <h3 style="margin-top:14px">使用该批次的底片</h3>
        <div id="batchNegativesList"></div>
        <div style="margin-top:10px;display:flex;gap:6px">
          <input id="newNegativeCode" placeholder="输入底片编号，如 CN-002" style="flex:1">
          <button id="addNegativeBtn" class="secondary">添加</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    renderNegativesInModal(id);
    document.getElementById("closeBatchDetail").onclick = () => modal.remove();
    modal.onclick = (e) => { if (e.target === modal) modal.remove(); };
    document.getElementById("addNegativeBtn").onclick = () => addNegativeToBatch(id);
    document.getElementById("newNegativeCode").onkeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); addNegativeToBatch(id); } };
  }

  function renderNegativesInModal(id) {
    const b = findById(id);
    const listEl = document.getElementById("batchNegativesList");
    if (!b || !listEl) return;
    const codes = b.negativeCodes || [];
    if (!codes.length) {
      listEl.innerHTML = '<div class="meta">暂无关联底片</div>';
      return;
    }
    listEl.innerHTML = codes.map(code => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid var(--line)">
        <span>${code}</span>
        <button class="secondary remove-neg-btn" data-code="${code}" style="font-size:12px;padding:2px 8px;background:var(--warn)">移除</button>
      </div>
    `).join('');
    listEl.querySelectorAll(".remove-neg-btn").forEach(btn => {
      btn.onclick = () => removeNegativeFromBatch(id, btn.dataset.code);
    });
  }

  async function addNegativeToBatch(id, code) {
    const input = document.getElementById("newNegativeCode");
    const newCode = (code || (input ? input.value : "")).trim();
    if (!newCode) return;
    const b = findById(id);
    if (!b) return;
    b.negativeCodes = b.negativeCodes || [];
    if (!b.negativeCodes.includes(newCode)) {
      b.negativeCodes.push(newCode);
      await api("/api/chemical-batches/" + id, { method: "PUT", body: JSON.stringify({ negativeCodes: b.negativeCodes }) });
      await load();
      renderBatchList(batches);
    }
    if (input) input.value = "";
    renderNegativesInModal(id);
  }

  async function removeNegativeFromBatch(id, code) {
    const b = findById(id);
    if (!b) return;
    b.negativeCodes = (b.negativeCodes || []).filter(c => c !== code);
    await api("/api/chemical-batches/" + id, { method: "PUT", body: JSON.stringify({ negativeCodes: b.negativeCodes }) });
    await load();
    renderBatchList(batches);
    renderNegativesInModal(id);
  }

  function searchBatches(query) {
    if (!query) return batches;
    const q = query.toLowerCase();
    return batches.filter(b =>
      b.batchNo.toLowerCase().includes(q) ||
      (b.formula || "").toLowerCase().includes(q) ||
      (b.negativeCodes || []).some(c => c.toLowerCase().includes(q))
    );
  }

  function initEvents() {
    const form = document.getElementById("batchForm");
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        await saveBatchFn();
      };
    }
    const cancelBtn = document.getElementById("batchCancelBtn");
    if (cancelBtn) cancelBtn.onclick = resetForm;
    const searchInput = document.getElementById("batchSearch");
    if (searchInput) {
      searchInput.oninput = () => {
        renderBatchList(searchBatches(searchInput.value.trim()));
      };
    }
  }

  async function init() {
    await load();
    renderBatchList(batches);
    initEvents();
  }

  return {
    load,
    getBatches,
    findById,
    findByBatchNo,
    statusClass,
    renderPanel,
    renderBatchList,
    renderBatchSelect,
    searchBatches,
    init
  };
})();
