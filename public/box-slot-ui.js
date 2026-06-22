window.BoxSlotUI = (function () {
  let slots = [];

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
    slots = await api("/api/box-slots");
    return slots;
  }

  async function loadStats() {
    return api("/api/box-slots/stats");
  }

  function getSlots() {
    return slots;
  }

  function findById(id) {
    return slots.find(s => s.id === id);
  }

  function findBySlotNo(slotNo) {
    return slots.find(s => s.slotNo === slotNo);
  }

  function isFull(slot) {
    return slot.currentCount >= slot.capacity;
  }

  function occupancyClass(slot) {
    const ratio = slot.capacity > 0 ? slot.currentCount / slot.capacity : 0;
    if (ratio >= 1) return "sev-critical";
    if (ratio >= 0.8) return "sev-moderate";
    return "sev-minor";
  }

  function occupancyLabel(slot) {
    const ratio = slot.capacity > 0 ? slot.currentCount / slot.capacity : 0;
    if (ratio >= 1) return "已满";
    if (ratio >= 0.8) return "即将满";
    return "可用";
  }

  function renderPanel() {
    return `
      <form id="slotForm" class="panel" style="margin-top:14px">
        <h2>存放盒位管理</h2>
        <input id="slotSearch" placeholder="搜索盒位编号或备注" style="margin-bottom:10px">
        <div id="slotList" style="max-height:280px;overflow:auto"></div>
        <div style="border-top:1px solid var(--line);padding-top:10px;margin-top:10px">
          <h3 style="font-size:15px;margin:0 0 8px">新增 / 编辑盒位</h3>
          <input type="hidden" id="slotEditId">
          <label>盒位编号</label><input id="slotNo" required>
          <label>容量</label><input id="slotCapacity" type="number" min="1" value="10">
          <label>当前占用数</label><input id="slotCurrentCount" type="number" min="0" value="0">
          <label>备注</label><textarea id="slotRemark" rows="2"></textarea>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button type="submit" id="slotSaveBtn">保存盒位</button>
            <button type="button" class="secondary" id="slotCancelBtn" style="display:none">取消编辑</button>
          </div>
        </div>
      </form>
    `;
  }

  function renderSlotList(list) {
    const container = document.getElementById("slotList");
    if (!container) return;
    if (!list.length) {
      container.innerHTML = '<div class="meta">暂无盒位记录</div>';
      return;
    }
    container.innerHTML = list.map(s => {
      const full = isFull(s);
      const occLabel = occupancyLabel(s);
      const occClass = occupancyClass(s);
      return `
        <div class="defect-row ${occClass}" data-slot-id="${s.id}">
          <div style="display:flex;justify-content:space-between;align-items:center">
            <strong>${s.slotNo}</strong>
            <span class="pill ${occClass}">${occLabel}</span>
          </div>
          <div class="meta" style="margin:4px 0">容量：${s.capacity} · 已用：${s.currentCount} · 剩余：${s.capacity - s.currentCount}</div>
          <div class="meta">${s.remark || ''}</div>
          <div style="margin-top:4px;height:6px;background:var(--line);border-radius:3px;overflow:hidden">
            <div style="height:100%;width:${s.capacity > 0 ? Math.min(100, (s.currentCount / s.capacity) * 100) : 0}%;background:${full ? 'var(--warn)' : 'var(--accent)'};border-radius:3px"></div>
          </div>
          <div style="display:flex;gap:6px;margin-top:6px">
            <button class="secondary slot-edit-btn" data-id="${s.id}" style="font-size:12px;padding:4px 8px">编辑</button>
            <button class="secondary slot-del-btn" data-id="${s.id}" style="font-size:12px;padding:4px 8px;background:var(--warn)">删除</button>
          </div>
        </div>
      `;
    }).join('');

    container.querySelectorAll(".slot-edit-btn").forEach(btn => {
      btn.onclick = () => startEdit(btn.dataset.id);
    });
    container.querySelectorAll(".slot-del-btn").forEach(btn => {
      btn.onclick = () => deleteSlot(btn.dataset.id);
    });
  }

  function renderSlotSelect(selectEl, selectedSlotNo) {
    if (!selectEl) return;
    const current = selectedSlotNo || selectEl.value;
    selectEl.innerHTML =
      '<option value="">-- 选择盒位 --</option>' +
      slots.map(s => {
        const full = isFull(s);
        const suffix = full ? ' [已满]' : ` [${s.currentCount}/${s.capacity}]`;
        return `<option value="${s.slotNo}" ${full ? 'style="color:var(--warn)"' : ''}>${s.slotNo}${suffix}</option>`;
      }).join('');
    if (current) selectEl.value = current;
  }

  function renderStatsOverview(statsData) {
    const container = document.getElementById("boxSlotStats");
    if (!container || !statsData) return;
    const barTotalWidth = statsData.totalCapacity > 0 ? Math.min(100, (statsData.totalOccupied / statsData.totalCapacity) * 100) : 0;
    container.innerHTML = `
      <div class="stat" style="grid-column:1/-1">
        <span style="font-size:13px;color:var(--muted)">盒位占用概览</span>
        <div style="display:flex;gap:16px;align-items:center;margin-top:6px">
          <div style="flex:1">
            <div style="height:10px;background:var(--line);border-radius:5px;overflow:hidden">
              <div style="height:100%;width:${barTotalWidth}%;background:${statsData.totalOccupied >= statsData.totalCapacity ? 'var(--warn)' : 'var(--accent)'};border-radius:5px"></div>
            </div>
          </div>
          <strong style="white-space:nowrap;font-size:14px">${statsData.totalOccupied} / ${statsData.totalCapacity}</strong>
        </div>
        <div style="display:flex;gap:12px;margin-top:8px;flex-wrap:wrap">
          <span class="meta">总盒位：${statsData.totalSlots}</span>
          <span class="meta">可用：${statsData.availableSlots}</span>
          <span class="meta" style="${statsData.fullSlots > 0 ? 'color:var(--warn)' : ''}">已满：${statsData.fullSlots}</span>
        </div>
        ${(statsData.slots || []).map(s => `
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;font-size:12px">
            <span style="min-width:80px">${s.slotNo}</span>
            <div style="flex:1;height:6px;background:var(--line);border-radius:3px;overflow:hidden">
              <div style="height:100%;width:${s.capacity > 0 ? Math.min(100, (s.currentCount / s.capacity) * 100) : 0}%;background:${s.isFull ? 'var(--warn)' : 'var(--accent)'};border-radius:3px"></div>
            </div>
            <span style="min-width:40px;text-align:right;color:${s.isFull ? 'var(--warn)' : 'var(--muted)'}">${s.currentCount}/${s.capacity}</span>
          </div>
        `).join('')}
      </div>
    `;
  }

  function startEdit(id) {
    const s = findById(id);
    if (!s) return;
    document.getElementById("slotEditId").value = s.id;
    document.getElementById("slotNo").value = s.slotNo;
    document.getElementById("slotCapacity").value = s.capacity;
    document.getElementById("slotCurrentCount").value = s.currentCount;
    document.getElementById("slotRemark").value = s.remark;
    document.getElementById("slotSaveBtn").textContent = "更新盒位";
    document.getElementById("slotCancelBtn").style.display = "";
  }

  function resetForm() {
    document.getElementById("slotEditId").value = "";
    document.getElementById("slotNo").value = "";
    document.getElementById("slotCapacity").value = "10";
    document.getElementById("slotCurrentCount").value = "0";
    document.getElementById("slotRemark").value = "";
    document.getElementById("slotSaveBtn").textContent = "保存盒位";
    document.getElementById("slotCancelBtn").style.display = "none";
  }

  async function saveSlotFn() {
    const id = document.getElementById("slotEditId").value;
    const payload = {
      slotNo: document.getElementById("slotNo").value.trim(),
      capacity: parseInt(document.getElementById("slotCapacity").value, 10) || 10,
      currentCount: parseInt(document.getElementById("slotCurrentCount").value, 10) || 0,
      remark: document.getElementById("slotRemark").value.trim()
    };
    if (!payload.slotNo) return;
    if (id) {
      await api("/api/box-slots/" + id, { method: "PUT", body: JSON.stringify(payload) });
    } else {
      await api("/api/box-slots", { method: "POST", body: JSON.stringify(payload) });
    }
    resetForm();
    await load();
    renderSlotList(slots);
  }

  async function deleteSlot(id) {
    if (!confirm("确认删除此盒位？")) return;
    await api("/api/box-slots/" + id, { method: "DELETE" });
    await load();
    renderSlotList(slots);
  }

  function searchSlots(query) {
    if (!query) return slots;
    const q = query.toLowerCase();
    return slots.filter(s =>
      s.slotNo.toLowerCase().includes(q) ||
      (s.remark || "").toLowerCase().includes(q)
    );
  }

  function checkSlotAvailability(slotNo) {
    const slot = findBySlotNo(slotNo);
    if (!slot) return { found: false, full: false, slot: null };
    return { found: true, full: isFull(slot), slot };
  }

  function initEvents() {
    const form = document.getElementById("slotForm");
    if (form) {
      form.onsubmit = async (e) => {
        e.preventDefault();
        await saveSlotFn();
      };
    }
    const cancelBtn = document.getElementById("slotCancelBtn");
    if (cancelBtn) cancelBtn.onclick = resetForm;
    const searchInput = document.getElementById("slotSearch");
    if (searchInput) {
      searchInput.oninput = () => {
        renderSlotList(searchSlots(searchInput.value.trim()));
      };
    }
  }

  function reset() {
    slots = [];
  }

  async function init() {
    await load();
    renderSlotList(slots);
    initEvents();
  }

  return {
    load,
    reset,
    loadStats,
    getSlots,
    findById,
    findBySlotNo,
    isFull,
    occupancyClass,
    occupancyLabel,
    renderPanel,
    renderSlotList,
    renderSlotSelect,
    renderStatsOverview,
    checkSlotAvailability,
    searchSlots,
    init
  };
})();
