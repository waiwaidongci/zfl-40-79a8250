window.BackupUI = (function () {
  let backups = [];
  let currentCounts = null;
  let selectedBackup = null;

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
    backups = await api("/api/backups");
    return backups;
  }

  async function loadCurrentCounts() {
    currentCounts = await api("/api/backups/current-counts");
    return currentCounts;
  }

  function getBackups() {
    return backups;
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(2) + " MB";
  }

  function formatDate(isoString) {
    if (!isoString) return "";
    const d = new Date(isoString);
    const pad = n => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  function renderPanel() {
    return `
      <div class="panel" style="margin-top:14px" id="backupPanel">
        <h2>数据备份与恢复</h2>
        <div style="margin-bottom:12px">
          <button id="createBackupBtn">+ 创建备份</button>
          <button class="secondary" id="refreshBackupBtn" style="margin-left:8px">刷新</button>
        </div>
        <div id="backupList" style="max-height:340px;overflow:auto"></div>
      </div>

      <div id="backupDetailModal" class="modal-backdrop hidden">
        <div class="modal" style="max-width:600px">
          <div class="modal-header">
            <h2 id="backupDetailTitle">备份详情</h2>
            <button class="secondary small" id="closeBackupDetail">×</button>
          </div>
          <div id="backupDetailContent"></div>
          <div class="toolbar" style="justify-content:flex-end;margin-top:16px">
            <button class="secondary" id="closeBackupDetailBtn">关闭</button>
          </div>
        </div>
      </div>

      <div id="restoreConfirmModal" class="modal-backdrop hidden">
        <div class="modal" style="max-width:520px">
          <div class="modal-header">
            <h2>确认恢复</h2>
            <button class="secondary small" id="closeRestoreConfirm">×</button>
          </div>
          <div id="restoreConfirmContent" style="margin-bottom:16px"></div>
          <div style="background:#fff9e6;border:1px solid #f0d98a;border-radius:6px;padding:12px;margin-bottom:16px">
            <strong style="color:#8a6d12">⚠ 注意</strong>
            <div style="font-size:13px;margin-top:6px">恢复操作将覆盖当前所有数据。系统会在恢复前自动创建一个备份，便于回滚。</div>
          </div>
          <div class="toolbar" style="justify-content:flex-end">
            <button class="secondary" id="cancelRestoreBtn">取消</button>
            <button class="danger" id="confirmRestoreBtn">确认恢复</button>
          </div>
        </div>
      </div>
    `;
  }

  function renderBackupList() {
    const container = document.getElementById("backupList");
    if (!container) return;

    if (!backups.length) {
      container.innerHTML = '<div class="meta" style="padding:20px;text-align:center">暂无备份记录</div>';
      return;
    }

    let html = "";
    for (const backup of backups) {
      html += `
        <div class="backup-item" data-filename="${backup.filename}" style="border:1px solid var(--line);border-radius:6px;padding:10px;margin-bottom:8px">
          <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px">
            <div>
              <div style="font-weight:600">${formatDate(backup.date)}</div>
              <div class="meta" style="font-size:12px;margin-top:2px">${backup.filename} · ${formatSize(backup.size)}</div>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="secondary small" data-action="view" data-filename="${backup.filename}">查看</button>
              <button class="secondary small" data-action="restore" data-filename="${backup.filename}">恢复</button>
              <button class="small" data-action="delete" data-filename="${backup.filename}" style="background:#9b4937">删除</button>
            </div>
          </div>
        </div>
      `;
    }
    container.innerHTML = html;

    container.querySelectorAll('[data-action="view"]').forEach(btn => {
      btn.onclick = () => showBackupDetail(btn.dataset.filename);
    });
    container.querySelectorAll('[data-action="restore"]').forEach(btn => {
      btn.onclick = () => showRestoreConfirm(btn.dataset.filename);
    });
    container.querySelectorAll('[data-action="delete"]').forEach(btn => {
      btn.onclick = () => deleteBackup(btn.dataset.filename);
    });
  }

  async function showBackupDetail(filename) {
    const modal = document.getElementById("backupDetailModal");
    const content = document.getElementById("backupDetailContent");
    const title = document.getElementById("backupDetailTitle");
    if (!modal || !content) return;

    try {
      const summary = await api("/api/backups/" + encodeURIComponent(filename));
      selectedBackup = summary;

      title.textContent = "备份详情 - " + summary.timestamp;

      let filesHtml = "";
      const fileLabels = {
        "cyanotype-negative-room.json": "底片数据",
        "audit-logs.json": "审计日志",
        "box-slots.json": "盒位管理",
        "chemical-batches.json": "药液批次",
        "defects.json": "缺陷类型",
        "delivery-batches.json": "交付批次",
        "process-templates.json": "工艺模板"
      };

      for (const [file, info] of Object.entries(summary.dataFiles)) {
        if (file === "_meta") continue;
        const label = fileLabels[file] || file;
        let countText = "";
        if (info.itemCount !== undefined) {
          countText = `${info.itemCount} 条底片`;
          if (info.statuses) {
            const statusEntries = Object.entries(info.statuses);
            if (statusEntries.length) {
              countText += "（" + statusEntries.map(([k, v]) => `${k}: ${v}`).join(" · ") + "）";
            }
          }
        } else if (info.logCount !== undefined) {
          countText = `${info.logCount} 条日志`;
        } else if (info.slotCount !== undefined) {
          countText = `${info.slotCount} 个盒位`;
        } else if (info.batchCount !== undefined && file === "chemical-batches.json") {
          countText = `${info.batchCount} 个药液批次`;
        } else if (info.batchCount !== undefined && file === "delivery-batches.json") {
          countText = `${info.batchCount} 个交付批次`;
        } else if (info.defectCount !== undefined) {
          countText = `${info.defectCount} 种缺陷`;
        } else if (info.templateCount !== undefined) {
          countText = `${info.templateCount} 个模板`;
        } else {
          countText = "数据文件";
        }
        filesHtml += `<div style="padding:6px 0;border-bottom:1px solid var(--line)"><strong>${label}</strong><span class="meta" style="margin-left:8px">${countText}</span></div>`;
      }

      content.innerHTML = `
        <div style="margin-bottom:12px">
          <label>备份时间</label>
          <div>${formatDate(summary.date)}</div>
        </div>
        <div style="margin-bottom:12px">
          <label>包含数据文件</label>
          ${filesHtml}
        </div>
      `;

      modal.classList.remove("hidden");
    } catch (e) {
      alert("获取备份详情失败：" + e.message);
    }
  }

  async function showRestoreConfirm(filename) {
    const modal = document.getElementById("restoreConfirmModal");
    const content = document.getElementById("restoreConfirmContent");
    if (!modal || !content) return;

    try {
      const validation = await api("/api/backups/" + encodeURIComponent(filename) + "/restore-validate");
      selectedBackup = validation;

      const mainDb = "cyanotype-negative-room.json";
      const currentCount = validation.currentItemCount;
      const backupCount = validation.backupItemCount;
      const diff = backupCount - currentCount;

      let diffText = "";
      if (diff > 0) {
        diffText = `<span class="pill info">备份比当前多 ${diff} 条</span>`;
      } else if (diff < 0) {
        diffText = `<span class="pill warn">备份比当前少 ${Math.abs(diff)} 条</span>`;
      } else {
        diffText = `<span class="pill success">数量相同</span>`;
      }

      content.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:12px">
          <div class="panel" style="background:#fafbf9">
            <div class="meta" style="margin-bottom:4px">当前数据</div>
            <div style="font-size:24px;font-weight:700">${currentCount}</div>
            <div class="meta" style="font-size:12px">条底片记录</div>
          </div>
          <div class="panel" style="background:#f0f7ed">
            <div class="meta" style="margin-bottom:4px">备份数据</div>
            <div style="font-size:24px;font-weight:700;color:var(--accent)">${backupCount}</div>
            <div class="meta" style="font-size:12px">条底片记录</div>
          </div>
        </div>
        <div style="text-align:center;margin-bottom:8px">${diffText}</div>
        <div class="meta" style="font-size:12px">备份时间：${formatDate(validation.backupDate)}</div>
      `;

      const confirmBtn = document.getElementById("confirmRestoreBtn");
      if (confirmBtn) {
        confirmBtn.dataset.filename = filename;
      }

      modal.classList.remove("hidden");
    } catch (e) {
      alert("恢复校验失败：" + e.message);
    }
  }

  async function createBackupAction() {
    const note = prompt("输入备份备注（可选）：") || "";
    try {
      const result = await api("/api/backups", {
        method: "POST",
        body: JSON.stringify({ note })
      });
      alert("备份创建成功：" + result.filename);
      await load();
      renderBackupList();
    } catch (e) {
      alert("创建备份失败：" + e.message);
    }
  }

  async function deleteBackup(filename) {
    if (!confirm(`确定要删除备份「${filename}」吗？此操作不可撤销。`)) {
      return;
    }
    try {
      await api("/api/backups/" + encodeURIComponent(filename), {
        method: "DELETE"
      });
      await load();
      renderBackupList();
    } catch (e) {
      alert("删除备份失败：" + e.message);
    }
  }

  async function performRestoreAction(filename) {
    try {
      const result = await api("/api/backups/" + encodeURIComponent(filename) + "/restore", {
        method: "POST",
        body: JSON.stringify({ confirmed: true })
      });

      document.getElementById("restoreConfirmModal").classList.add("hidden");

      if (result.success) {
        alert(`恢复成功！已恢复 ${result.restoredFiles.length} 个数据文件。\n恢复前备份：${result.preRestoreBackup}`);
        await load();
        renderBackupList();
        if (typeof window.location !== "undefined" && window.location.pathname === "/") {
          setTimeout(() => {
            window.location.reload();
          }, 500);
        }
      } else {
        alert(`恢复部分失败，成功 ${result.restoredFiles.length} 个，失败 ${result.errors.length} 个`);
      }
    } catch (e) {
      alert("恢复失败：" + e.message);
    }
  }

  function init() {
    const createBtn = document.getElementById("createBackupBtn");
    const refreshBtn = document.getElementById("refreshBackupBtn");
    const closeDetailBtn = document.getElementById("closeBackupDetail");
    const closeDetailBtn2 = document.getElementById("closeBackupDetailBtn");
    const closeRestoreBtn = document.getElementById("closeRestoreConfirm");
    const cancelRestoreBtn = document.getElementById("cancelRestoreBtn");
    const confirmRestoreBtn = document.getElementById("confirmRestoreBtn");

    if (createBtn) createBtn.onclick = createBackupAction;
    if (refreshBtn) {
      refreshBtn.onclick = async () => {
        await load();
        renderBackupList();
      };
    }
    if (closeDetailBtn) {
      closeDetailBtn.onclick = () => {
        document.getElementById("backupDetailModal").classList.add("hidden");
      };
    }
    if (closeDetailBtn2) {
      closeDetailBtn2.onclick = () => {
        document.getElementById("backupDetailModal").classList.add("hidden");
      };
    }
    if (closeRestoreBtn) {
      closeRestoreBtn.onclick = () => {
        document.getElementById("restoreConfirmModal").classList.add("hidden");
      };
    }
    if (cancelRestoreBtn) {
      cancelRestoreBtn.onclick = () => {
        document.getElementById("restoreConfirmModal").classList.add("hidden");
      };
    }
    if (confirmRestoreBtn) {
      confirmRestoreBtn.onclick = () => {
        const fn = confirmRestoreBtn.dataset.filename;
        if (fn) performRestoreAction(fn);
      };
    }

    load().then(() => renderBackupList()).catch(() => {});
  }

  return {
    load,
    loadCurrentCounts,
    getBackups,
    renderPanel,
    renderBackupList,
    init
  };
})();
