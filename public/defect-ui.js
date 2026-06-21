window.DefectUI = (function () {
  let defects = [];

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
    defects = await api("/api/defects");
    return defects;
  }

  function getDefects() {
    return defects;
  }

  function findById(id) {
    return defects.find((d) => d.id === id);
  }

  function findByName(name) {
    return defects.find((d) => d.name === name);
  }

  function searchDefects(query) {
    if (!query) return defects;
    const q = query.toLowerCase();
    return defects.filter(
      (d) =>
        d.name.includes(q) ||
        d.description.includes(q) ||
        (d.keywords || []).some((k) => k.toLowerCase().includes(q))
    );
  }

  function severityClass(severity) {
    if (severity === "严重") return "sev-critical";
    if (severity === "中等") return "sev-moderate";
    return "sev-minor";
  }

  function renderManagerPanel() {
    return `
      <form id="defectForm" class="panel" style="margin-top:14px">
        <h2>缺陷类型管理</h2>
        <input id="defectSearch" placeholder="搜索缺陷名称或关键词" style="margin-bottom:10px">
        <div id="defectList" style="max-height:260px;overflow:auto"></div>
        <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
          <h3 style="font-size:15px;margin:0 0 8px">新增 / 编辑缺陷</h3>
          <input type="hidden" id="defectEditId">
          <label>缺陷名称</label><input id="defectName" required>
          <label>严重程度</label><select id="defectSeverity">
            <option>轻微</option><option>中等</option><option>严重</option>
          </select>
          <label>缺陷说明</label><textarea id="defectDescription" rows="2"></textarea>
          <label>建议修补方式</label><textarea id="defectRepair" rows="2"></textarea>
          <label>可搜索关键词（逗号分隔）</label><input id="defectKeywords" placeholder="水渍,斑痕,冲洗">
          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="submit" id="defectSaveBtn">保存缺陷</button>
            <button type="button" class="secondary" id="defectCancelBtn" style="display:none">取消编辑</button>
          </div>
        </div>
      </form>
    `;
  }

  function renderDefectList(list) {
    const container = document.getElementById("defectList");
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="meta">暂无缺陷类型</div>';
      return;
    }
    container.innerHTML = list
      .map(
        (d) => `
      <div class="defect-row ${severityClass(d.severity)}" data-defect-id="${d.id}">
        <div style="display:flex;justify-content:space-between;align-items:center">
          <strong>${d.name}</strong>
          <span class="pill ${severityClass(d.severity)}">${d.severity}</span>
        </div>
        <div class="meta" style="margin:4px 0">${d.description || ""}</div>
        ${d.repair ? '<div style="color:var(--accent);font-size:13px">修补：' + d.repair + "</div>" : ""}
        <div style="display:flex;gap:6px;margin-top:4px">
          <button class="secondary defect-edit-btn" data-id="${d.id}" style="font-size:12px;padding:4px 8px">编辑</button>
          <button class="secondary defect-del-btn" data-id="${d.id}" style="font-size:12px;padding:4px 8px;background:var(--warn)">删除</button>
        </div>
      </div>
    `
      )
      .join("");

    container.querySelectorAll(".defect-edit-btn").forEach((btn) => {
      btn.onclick = () => startEdit(btn.dataset.id);
    });
    container.querySelectorAll(".defect-del-btn").forEach((btn) => {
      btn.onclick = () => deleteDefect(btn.dataset.id);
    });
  }

  function renderDefectSelect(selectEl) {
    if (!selectEl) return;
    const current = selectEl.value;
    selectEl.innerHTML =
      '<option value="">-- 从缺陷库选择 --</option>' +
      defects
        .map((d) => `<option value="${d.name}">${d.name}（${d.severity}）</option>`)
        .join("");
    if (current) selectEl.value = current;
  }

  function startEdit(id) {
    const d = findById(id);
    if (!d) return;
    document.getElementById("defectEditId").value = d.id;
    document.getElementById("defectName").value = d.name;
    document.getElementById("defectSeverity").value = d.severity;
    document.getElementById("defectDescription").value = d.description;
    document.getElementById("defectRepair").value = d.repair;
    document.getElementById("defectKeywords").value = (d.keywords || []).join(",");
    document.getElementById("defectSaveBtn").textContent = "更新缺陷";
    document.getElementById("defectCancelBtn").style.display = "";
  }

  function resetForm() {
    document.getElementById("defectEditId").value = "";
    document.getElementById("defectName").value = "";
    document.getElementById("defectSeverity").value = "轻微";
    document.getElementById("defectDescription").value = "";
    document.getElementById("defectRepair").value = "";
    document.getElementById("defectKeywords").value = "";
    document.getElementById("defectSaveBtn").textContent = "保存缺陷";
    document.getElementById("defectCancelBtn").style.display = "none";
  }

  async function saveDefect() {
    const id = document.getElementById("defectEditId").value;
    const payload = {
      name: document.getElementById("defectName").value.trim(),
      severity: document.getElementById("defectSeverity").value,
      description: document.getElementById("defectDescription").value.trim(),
      repair: document.getElementById("defectRepair").value.trim(),
      keywords: document
        .getElementById("defectKeywords")
        .value.split(",")
        .map((k) => k.trim())
        .filter(Boolean),
    };
    if (!payload.name) return;
    if (id) {
      await api("/api/defects/" + id, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/defects", { method: "POST", body: JSON.stringify(payload) });
    }
    resetForm();
    await load();
    renderDefectList(defects);
  }

  async function deleteDefect(id) {
    if (!confirm("确认删除此缺陷类型？")) return;
    await api("/api/defects/" + id, { method: "DELETE" });
    await load();
    renderDefectList(defects);
  }

  function initEvents() {
    const form = document.getElementById("defectForm");
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        await saveDefect();
      };
    }
    const cancelBtn = document.getElementById("defectCancelBtn");
    if (cancelBtn) cancelBtn.onclick = resetForm;
    const searchInput = document.getElementById("defectSearch");
    if (searchInput) {
      searchInput.oninput = () => {
        renderDefectList(searchDefects(searchInput.value.trim()));
      };
    }
  }

  async function init() {
    await load();
    renderDefectList(defects);
    initEvents();
  }

  return {
    load,
    getDefects,
    findById,
    findByName,
    searchDefects,
    severityClass,
    renderManagerPanel,
    renderDefectList,
    renderDefectSelect,
    init,
  };
})();
