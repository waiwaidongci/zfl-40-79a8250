const DeliveryListUI = (function() {
  let batches = [];
  let ungroupedItems = [];
  let allItems = [];
  let selectedUngrouped = new Set();
  let editingBatchId = null;

  function api(path, options) {
    return fetch(path, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options)
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      });
  }

  function formatDate(dateStr) {
    if (!dateStr) return '-';
    if (dateStr.length === 10) return dateStr;
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toISOString().slice(0, 10);
    } catch { return dateStr; }
  }

  function formatDateTime(dateStr) {
    if (!dateStr) return '-';
    try {
      const d = new Date(dateStr);
      if (isNaN(d.getTime())) return dateStr;
      return d.toLocaleString('zh-CN', { hour12: false });
    } catch { return dateStr; }
  }

  function getDefectSummary(item) {
    if (!item) return '-';
    if (item.defect) return item.defect;
    const stepDefects = ((item.steps || []).filter(s => s.defect).map(s => s.defect));
    const logDefects = ((item.logs || []).filter(l => l.defect).map(l => l.defect));
    return [...new Set([...stepDefects, ...logDefects])].filter(Boolean).join('; ') || '-';
  }

  function getRepairRecords(item) {
    if (!item) return '-';
    const stepRepairs = ((item.steps || []).filter(s => s.repair).map(s => s.repair));
    const logRepairs = ((item.logs || []).filter(l => l.repair).map(l => l.repair));
    const itemRepair = item.repair ? [item.repair] : [];
    return [...new Set([...stepRepairs, ...logRepairs, ...itemRepair])].filter(Boolean).join('; ') || '-';
  }

  function getDeliveryTime(item, batch) {
    if (!item) return '-';
    const logs = item.logs || [];
    const steps = item.steps || [];
    const deliveryLog = [...logs, ...steps].reverse().find(e =>
      (e.step === '交付') ||
      (e.note && (e.note.includes('交付') || e.note.includes('已交付')))
    );
    if (deliveryLog && deliveryLog.at) return formatDateTime(deliveryLog.at);
    if (batch && batch.deliveryDate) return batch.deliveryDate;
    const statusLog = logs.reverse().find(l => l.step === '状态' && l.note && l.note.includes('已交付'));
    return statusLog && statusLog.at ? formatDateTime(statusLog.at) : '-';
  }

  async function loadAll() {
    const [b, u, items] = await Promise.all([
      api('/api/delivery-batches'),
      api('/api/delivery-batches/ungrouped/delivered'),
      api('/api/items')
    ]);
    batches = b;
    ungroupedItems = u;
    allItems = items;
    render();
  }

  function render() {
    renderBatchStats();
    renderCustomerFilter();
    renderBatches();
    renderUngrouped();
    document.getElementById('ungroupedCount').textContent = ungroupedItems.length;
  }

  function renderBatchStats() {
    const total = batches.length;
    const confirmedItems = batches.reduce((n, b) => n + (b.items || []).filter(i => i.confirmed).length, 0);
    const unconfirmedItems = batches.reduce((n, b) => n + (b.items || []).filter(i => !i.confirmed).length, 0);
    const customers = new Set(batches.map(b => b.customer).filter(Boolean));
    const el = document.getElementById('batchStats');
    el.innerHTML =
      '<div class="stat"><span>批次数</span><strong>' + total + '</strong></div>' +
      '<div class="stat success"><span>已确认底片</span><strong>' + confirmedItems + '</strong></div>' +
      '<div class="stat warn"><span>待确认</span><strong>' + unconfirmedItems + '</strong></div>' +
      '<div class="stat"><span>客户数</span><strong>' + customers.size + '</strong></div>';
  }

  function renderCustomerFilter() {
    const sel = document.getElementById('customerFilter');
    const current = sel.value;
    const customers = [...new Set(batches.map(b => b.customer).filter(Boolean))].sort();
    sel.innerHTML = '<option value="">全部客户</option>' +
      customers.map(c => '<option value="' + c + '" ' + (c === current ? 'selected' : '') + '>' + c + '</option>').join('');
  }

  function renderBatches() {
    const q = document.getElementById('batchSearch').value.trim().toLowerCase();
    const cust = document.getElementById('customerFilter').value;
    let list = batches;
    if (q) list = list.filter(b =>
      b.batchNo.toLowerCase().includes(q) ||
      (b.customer || '').toLowerCase().includes(q) ||
      (b.note || '').toLowerCase().includes(q)
    );
    if (cust) list = list.filter(b => b.customer === cust);
    const el = document.getElementById('batchList');
    if (list.length === 0) {
      el.innerHTML = '<div class="panel" style="grid-column:1/-1"><div class="empty-state">暂无交付批次。点击右上角「新建批次」创建第一个交付批次。</div></div>';
      return;
    }
    el.innerHTML = list.map(b => {
      const confirmed = (b.items || []).filter(i => i.confirmed).length;
      const total = (b.items || []).length;
      const unconfirmed = total - confirmed;
      return '<article class="card batch-card">' +
        '<div class="batch-header">' +
          '<div><h3>' + b.batchNo + '</h3>' +
          '<div class="batch-meta">' +
            (b.customer ? '<span class="pill info">客户：' + b.customer + '</span>' : '') +
            '<span class="pill">交付日期：' + formatDate(b.deliveryDate) + '</span>' +
          '</div></div>' +
          '<div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">' +
            '<span class="pill success">已确认 ' + confirmed + '</span>' +
            (unconfirmed > 0 ? '<span class="pill warn">待确认 ' + unconfirmed + '</span>' : '') +
            '<span class="pill muted">共 ' + total + '</span>' +
          '</div>' +
        '</div>' +
        (b.note ? '<div class="meta">' + b.note + '</div>' : '') +
        '<div style="display:flex;gap:6px;flex-wrap:wrap">' +
          '<button class="small" data-view="' + b.id + '">查看清单</button>' +
          '<button class="secondary small" data-edit="' + b.id + '">编辑</button>' +
          '<button class="secondary small" data-export="' + b.id + '">导出JSON</button>' +
          (unconfirmed > 0 ? '<button class="secondary small" data-cleanup="' + b.id + '">移除未确认</button>' : '') +
          '<button class="danger small" data-delete="' + b.id + '">删除</button>' +
        '</div>' +
      '</article>';
    }).join('');
    attachBatchHandlers();
  }

  function attachBatchHandlers() {
    document.querySelectorAll('[data-view]').forEach(btn => btn.onclick = () => openDetail(btn.dataset.view));
    document.querySelectorAll('[data-edit]').forEach(btn => btn.onclick = () => openBatchModal(btn.dataset.edit));
    document.querySelectorAll('[data-export]').forEach(btn => btn.onclick = () => exportBatch(btn.dataset.export));
    document.querySelectorAll('[data-cleanup]').forEach(btn => btn.onclick = () => cleanupBatch(btn.dataset.cleanup));
    document.querySelectorAll('[data-delete]').forEach(btn => btn.onclick = () => deleteBatch(btn.dataset.delete));
  }

  function renderUngrouped() {
    const el = document.getElementById('ungroupedList');
    selectedUngrouped = new Set([...selectedUngrouped].filter(id => ungroupedItems.some(i => (i.id || i.code) === id)));
    if (ungroupedItems.length === 0) {
      el.innerHTML = '<div class="panel"><div class="empty-state">所有已交付底片均已归档到批次中。干得漂亮！</div></div>';
      document.getElementById('assignSelectedBtn').disabled = true;
      document.getElementById('selectAllUngrouped').textContent = '全选';
      return;
    }
    el.innerHTML = '<div class="panel"><table>' +
      '<thead><tr>' +
        '<th style="width:40px"><input type="checkbox" id="checkAllUngroupedHeader"></th>' +
        '<th>底片编号</th><th>尺寸</th><th>盒位</th><th>缺陷摘要</th><th>修补记录</th><th>交付时间</th><th>操作</th>' +
      '</tr></thead>' +
      '<tbody>' + ungroupedItems.map(item => {
        const id = item.id || item.code;
        const checked = selectedUngrouped.has(id);
        return '<tr>' +
          '<td><input type="checkbox" class="ungrouped-check" data-id="' + id + '" ' + (checked ? 'checked' : '') + '></td>' +
          '<td><b>' + (item.code || item.id) + '</b></td>' +
          '<td>' + (item.plateSize || '-') + '</td>' +
          '<td>' + (item.box || '-') + '</td>' +
          '<td>' + getDefectSummary(item) + '</td>' +
          '<td>' + getRepairRecords(item) + '</td>' +
          '<td>' + getDeliveryTime(item, null) + '</td>' +
          '<td class="row-actions">' +
            '<button class="small" data-assign-single="' + id + '">加入批次</button>' +
          '</td>' +
        '</tr>';
      }).join('') + '</tbody></table></div>';
    document.getElementById('assignSelectedBtn').disabled = selectedUngrouped.size === 0;
    document.getElementById('selectAllUngrouped').textContent =
      selectedUngrouped.size === ungroupedItems.length && ungroupedItems.length > 0 ? '取消全选' : '全选';
    const headerCheck = document.getElementById('checkAllUngroupedHeader');
    if (headerCheck) {
      headerCheck.checked = selectedUngrouped.size === ungroupedItems.length && ungroupedItems.length > 0;
      headerCheck.onchange = () => {
        if (headerCheck.checked) {
          ungroupedItems.forEach(i => selectedUngrouped.add(i.id || i.code));
        } else {
          selectedUngrouped.clear();
        }
        renderUngrouped();
      };
    }
    document.querySelectorAll('.ungrouped-check').forEach(cb => {
      cb.onchange = () => {
        const id = cb.dataset.id;
        if (cb.checked) selectedUngrouped.add(id);
        else selectedUngrouped.delete(id);
        document.getElementById('assignSelectedBtn').disabled = selectedUngrouped.size === 0;
        const allChecked = selectedUngrouped.size === ungroupedItems.length;
        document.getElementById('selectAllUngrouped').textContent = allChecked ? '取消全选' : '全选';
        if (headerCheck) headerCheck.checked = allChecked;
      };
    });
    document.querySelectorAll('[data-assign-single]').forEach(btn => {
      btn.onclick = () => {
        selectedUngrouped.clear();
        selectedUngrouped.add(btn.dataset.assignSingle);
        openAssignModal();
      };
    });
  }

  function openBatchModal(batchId) {
    editingBatchId = batchId || null;
    const form = document.getElementById('batchForm');
    form.reset();
    if (batchId) {
      const b = batches.find(x => x.id === batchId);
      if (b) {
        document.getElementById('modalTitle').textContent = '编辑交付批次';
        form.batchNo.value = b.batchNo || '';
        form.customer.value = b.customer || '';
        form.deliveryDate.value = b.deliveryDate || '';
        form.note.value = b.note || '';
      }
    } else {
      document.getElementById('modalTitle').textContent = '新建交付批次';
      form.deliveryDate.value = new Date().toISOString().slice(0, 10);
    }
    document.getElementById('batchModal').classList.remove('hidden');
  }

  function closeBatchModal() {
    document.getElementById('batchModal').classList.add('hidden');
    editingBatchId = null;
  }

  async function submitBatch(e) {
    e.preventDefault();
    const form = document.getElementById('batchForm');
    const data = Object.fromEntries(new FormData(form).entries());
    try {
      if (editingBatchId) {
        await api('/api/delivery-batches/' + editingBatchId, { method: 'PUT', body: JSON.stringify(data) });
      } else {
        await api('/api/delivery-batches', { method: 'POST', body: JSON.stringify(data) });
      }
      closeBatchModal();
      await loadAll();
    } catch (err) {
      alert(err.message);
    }
  }

  async function deleteBatch(id) {
    const b = batches.find(x => x.id === id);
    if (!b) return;
    if (!confirm('确认删除批次「' + b.batchNo + '」？该操作不会删除底片本身，仅移除归档关系。')) return;
    try {
      await api('/api/delivery-batches/' + id, { method: 'DELETE' });
      await loadAll();
    } catch (err) { alert(err.message); }
  }

  async function cleanupBatch(id) {
    const b = batches.find(x => x.id === id);
    if (!b) return;
    const unconfirmed = (b.items || []).filter(i => !i.confirmed).length;
    if (unconfirmed === 0) return;
    if (!confirm('确认移除批次「' + b.batchNo + '」中 ' + unconfirmed + ' 条未确认的条目？')) return;
    try {
      await api('/api/delivery-batches/' + id + '/cleanup', { method: 'POST' });
      await loadAll();
    } catch (err) { alert(err.message); }
  }

  async function exportBatch(id) {
    try {
      const res = await fetch('/api/delivery-batches/' + id + '/export');
      if (!res.ok) throw new Error('导出失败');
      const blob = await res.blob();
      const disp = res.headers.get('Content-Disposition') || '';
      const match = disp.match(/filename="([^"]+)"/);
      const filename = match ? match[1] : ('delivery-batch-' + id + '.json');
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) { alert(err.message); }
  }

  async function openDetail(id) {
    try {
      const b = await api('/api/delivery-batches/' + id);
      document.getElementById('detailTitle').textContent = '批次详情 - ' + b.batchNo;
      const items = b.items || [];
      const confirmed = items.filter(i => i.confirmed).length;
      const headerHtml = '<div class="batch-meta" style="margin-bottom:14px">' +
        (b.customer ? '<span class="pill info">客户：' + b.customer + '</span> ' : '') +
        '<span class="pill">交付日期：' + formatDate(b.deliveryDate) + '</span> ' +
        '<span class="pill success">已确认 ' + confirmed + '</span> ' +
        '<span class="pill muted">共 ' + items.length + '</span>' +
        (b.note ? '<div class="meta" style="margin-top:8px">' + b.note + '</div>' : '') +
      '</div>';
      const toolbarHtml = '<div class="toolbar" style="margin-bottom:10px">' +
        '<button class="small" data-export-detail="' + id + '">导出JSON</button>' +
        ((items.length - confirmed) > 0 ? '<button class="secondary small" data-cleanup-detail="' + id + '">移除未确认(' + (items.length - confirmed) + ')</button>' : '') +
      '</div>';
      let tableHtml = '';
      if (items.length === 0) {
        tableHtml = '<div class="empty-state">该批次暂无底片。可从「未归档」标签页将已交付底片加入批次。</div>';
      } else {
        tableHtml = '<div style="max-height:500px;overflow:auto"><table><thead><tr>' +
          '<th style="width:40px">状态</th>' +
          '<th>底片编号</th><th>尺寸</th><th>盒位</th><th>缺陷摘要</th><th>修补记录</th><th>交付时间</th><th>操作</th>' +
        '</tr></thead><tbody>' + items.map(bi => {
          const d = bi.details || {};
          const notDelivered = bi.currentStatus && bi.currentStatus !== '已交付';
          const rowCls = notDelivered ? 'warn' : (bi.confirmed ? '' : 'confirm-row');
          const statusWarn = notDelivered ? '<span class="pill warn" style="margin-left:4px">当前：' + bi.currentStatus + '</span>' : '';
          return '<tr class="' + rowCls + '">' +
            '<td style="text-align:center">' +
              (bi.confirmed
                ? '<span class="pill success">已确认</span>' + statusWarn
                : '<input type="checkbox" class="confirm-item-check" data-batch="' + id + '" data-item="' + (bi.code || bi.itemId) + '" title="勾选确认">') +
            '</td>' +
            '<td><b>' + (d.code || bi.code) + '</b></td>' +
            '<td>' + (d.plateSize || '-') + '</td>' +
            '<td>' + (d.box || '-') + '</td>' +
            '<td>' + getDefectSummary(d) + '</td>' +
            '<td>' + getRepairRecords(d) + '</td>' +
            '<td>' + getDeliveryTime(d, b) + '</td>' +
            '<td class="row-actions">' +
              '<button class="secondary small" data-remove-item data-batch="' + id + '" data-item="' + (bi.code || bi.itemId) + '">移除</button>' +
            '</td>' +
          '</tr>';
        }).join('') + '</tbody></table></div>';
      }
      document.getElementById('detailContent').innerHTML = headerHtml + toolbarHtml + tableHtml;
      document.getElementById('detailModal').classList.remove('hidden');
      attachDetailHandlers();
    } catch (err) { alert(err.message); }
  }

  function attachDetailHandlers() {
    document.querySelectorAll('[data-export-detail]').forEach(btn => btn.onclick = () => exportBatch(btn.dataset.exportDetail));
    document.querySelectorAll('[data-cleanup-detail]').forEach(btn => btn.onclick = async () => {
      await cleanupBatch(btn.dataset.cleanupDetail);
      closeDetailModal();
      await loadAll();
    });
    document.querySelectorAll('.confirm-item-check').forEach(cb => {
      cb.onchange = async () => {
        const batchId = cb.dataset.batch;
        const itemId = cb.dataset.item;
        try {
          await api('/api/delivery-batches/' + batchId + '/items/' + encodeURIComponent(itemId), {
            method: 'PATCH',
            body: JSON.stringify({ confirmed: cb.checked })
          });
          await loadAll();
          openDetail(batchId);
        } catch (err) { alert(err.message); cb.checked = !cb.checked; }
      };
    });
    document.querySelectorAll('[data-remove-item]').forEach(btn => {
      btn.onclick = async () => {
        const batchId = btn.dataset.batch;
        const itemId = btn.dataset.item;
        if (!confirm('从批次中移除此底片？')) return;
        try {
          await api('/api/delivery-batches/' + batchId + '/items/' + encodeURIComponent(itemId), { method: 'DELETE' });
          await loadAll();
          openDetail(batchId);
        } catch (err) { alert(err.message); }
      };
    });
  }

  function closeDetailModal() {
    document.getElementById('detailModal').classList.add('hidden');
  }

  function openAssignModal() {
    if (selectedUngrouped.size === 0) {
      alert('请先选择底片');
      return;
    }
    document.getElementById('assignInfo').textContent = '已选择 ' + selectedUngrouped.size + ' 张底片。请选择目标批次或新建批次。';
    const sel = document.getElementById('targetBatchSelect');
    sel.innerHTML = '<option value="">-- 选择批次 --</option>' +
      batches.map(b => {
        const count = (b.items || []).length;
        const label = b.batchNo + (b.customer ? ' [' + b.customer + ']' : '') + ' (' + count + '张)';
        return '<option value="' + b.id + '">' + label + '</option>';
      }).join('');
    sel.onchange = () => {
      document.getElementById('confirmAssignBtn').disabled = !sel.value;
    };
    document.getElementById('newCustomer').value = '';
    document.getElementById('newDeliveryDate').value = new Date().toISOString().slice(0, 10);
    document.getElementById('confirmAssignBtn').disabled = true;
    document.getElementById('assignModal').classList.remove('hidden');
  }

  function closeAssignModal() {
    document.getElementById('assignModal').classList.add('hidden');
  }

  async function assignToBatch(batchId) {
    let success = 0, failed = 0;
    for (const itemId of selectedUngrouped) {
      const item = ungroupedItems.find(i => (i.id || i.code) === itemId) || allItems.find(i => (i.id || i.code) === itemId);
      if (!item) { failed++; continue; }
      try {
        await api('/api/delivery-batches/' + batchId + '/items', {
          method: 'POST',
          body: JSON.stringify({ itemId: item.id || item.code, code: item.code })
        });
        success++;
      } catch (e) {
        failed++;
      }
    }
    return { success, failed };
  }

  async function confirmAssign() {
    const sel = document.getElementById('targetBatchSelect');
    if (!sel.value) return;
    if (!confirm('将 ' + selectedUngrouped.size + ' 张底片加入所选批次？')) return;
    const { success, failed } = await assignToBatch(sel.value);
    alert('操作完成：成功 ' + success + ' 张，失败 ' + failed + ' 张');
    selectedUngrouped.clear();
    closeAssignModal();
    await loadAll();
  }

  async function createAndAssign() {
    const customer = document.getElementById('newCustomer').value.trim();
    const deliveryDate = document.getElementById('newDeliveryDate').value;
    if (!customer && !deliveryDate) {
      if (!confirm('客户和日期均未填写，确定要创建批次吗？')) return;
    }
    try {
      const b = await api('/api/delivery-batches', {
        method: 'POST',
        body: JSON.stringify({ customer, deliveryDate })
      });
      const { success, failed } = await assignToBatch(b.id);
      alert('已创建批次「' + b.batchNo + '」并加入 ' + success + ' 张底片（失败 ' + failed + ' 张）');
      selectedUngrouped.clear();
      closeAssignModal();
      await loadAll();
    } catch (err) { alert(err.message); }
  }

  function init() {
    document.querySelectorAll('.tabs button').forEach(btn => {
      btn.onclick = () => {
        document.querySelectorAll('.tabs button').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.tab).classList.add('active');
      };
    });

    document.getElementById('createBatchBtn').onclick = () => openBatchModal(null);
    document.getElementById('reload').onclick = loadAll;
    document.getElementById('batchSearch').oninput = renderBatches;
    document.getElementById('customerFilter').onchange = renderBatches;
    document.getElementById('selectAllUngrouped').onclick = () => {
      if (selectedUngrouped.size === ungroupedItems.length) {
        selectedUngrouped.clear();
      } else {
        ungroupedItems.forEach(i => selectedUngrouped.add(i.id || i.code));
      }
      renderUngrouped();
    };
    document.getElementById('assignSelectedBtn').onclick = openAssignModal;

    document.getElementById('batchForm').onsubmit = submitBatch;
    document.getElementById('closeModal').onclick = closeBatchModal;
    document.getElementById('cancelModal').onclick = closeBatchModal;
    document.getElementById('batchModal').onclick = e => { if (e.target.id === 'batchModal') closeBatchModal(); };

    document.getElementById('closeAssignModal').onclick = closeAssignModal;
    document.getElementById('cancelAssign').onclick = closeAssignModal;
    document.getElementById('assignModal').onclick = e => { if (e.target.id === 'assignModal') closeAssignModal(); };
    document.getElementById('confirmAssignBtn').onclick = confirmAssign;
    document.getElementById('createAndAssignBtn').onclick = createAndAssign;

    document.getElementById('closeDetailModal').onclick = closeDetailModal;
    document.getElementById('detailModal').onclick = e => { if (e.target.id === 'detailModal') closeDetailModal(); };

    loadAll();
  }

  return { init };
})();

document.addEventListener('DOMContentLoaded', () => {
  DeliveryListUI.init();
});
