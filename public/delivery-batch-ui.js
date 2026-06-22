const DeliveryBatchUI = (function() {
  let batches = [];
  const itemBatchCache = new Map();

  function api(path, options) {
    const studioId = localStorage.getItem('currentStudioId') || 'default';
    const sep = path.includes('?') ? '&' : '?';
    const studioPath = path + sep + 'studioId=' + encodeURIComponent(studioId);
    return fetch(studioPath, options && options.body ? { ...options, headers:{ 'Content-Type':'application/json' } } : options)
      .then(async res => {
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || '请求失败');
        return data;
      });
  }

  async function load() {
    try {
      batches = await api('/api/delivery-batches');
    } catch (e) {
      batches = [];
    }
  }

  function getBatches() {
    return batches;
  }

  function findByBatchNo(batchNo) {
    return batches.find(b => b.batchNo === batchNo);
  }

  function findById(id) {
    return batches.find(b => b.id === id);
  }

  async function lookupItemBatch(itemId) {
    const key = itemId;
    if (itemBatchCache.has(key)) return itemBatchCache.get(key);
    try {
      const result = await api('/api/delivery-batches/item/' + encodeURIComponent(itemId));
      itemBatchCache.set(key, result);
      return result;
    } catch (e) {
      return null;
    }
  }

  async function lookupItemBatches(itemIds) {
    const results = {};
    const missing = [];
    for (const id of itemIds) {
      if (itemBatchCache.has(id)) results[id] = itemBatchCache.get(id);
      else missing.push(id);
    }
    if (missing.length === 0) return results;
    await Promise.all(missing.map(async id => {
      try {
        const r = await api('/api/delivery-batches/item/' + encodeURIComponent(id));
        itemBatchCache.set(id, r);
        results[id] = r;
      } catch (e) { results[id] = null; }
    }));
    return results;
  }

  function clearCache(itemId) {
    if (itemId) itemBatchCache.delete(itemId);
    else itemBatchCache.clear();
  }

  function renderBatchSelect(selectEl, selectedValue) {
    if (!selectEl) return;
    selectEl.innerHTML = '<option value="">-- 未归档（可选） --</option>' +
      '<option value="__new__">+ 新建批次...</option>' +
      batches.map(b => {
        const label = b.batchNo + (b.customer ? ' [' + b.customer + ']' : '');
        return '<option value="' + b.id + '" ' + (b.id === selectedValue ? 'selected' : '') + '>' + label + '</option>';
      }).join('');
  }

  function getBatchTagHtml(batchInfo) {
    if (!batchInfo) return '<span class="pill warn" style="margin-top:4px">未归档交付批次</span>';
    const b = batchInfo.batch;
    const confirmed = batchInfo.item && batchInfo.item.confirmed;
    return '<a href="/delivery-list" style="text-decoration:none"><span class="pill info" style="margin-top:4px;cursor:pointer" title="点击查看交付清单">' +
      (b.batchNo || '交付批次') +
      (b.customer ? ' · ' + b.customer : '') +
      (confirmed ? '' : ' (待确认)') +
      '</span></a>';
  }

  async function assignItemToBatch(itemId, code, batchId) {
    clearCache(itemId);
    clearCache(code);
    return await api('/api/delivery-batches/' + batchId + '/items', {
      method: 'POST',
      body: JSON.stringify({ itemId, code })
    });
  }

  async function removeItemFromBatch(batchId, itemIdentifier) {
    clearCache(itemIdentifier);
    return await api('/api/delivery-batches/' + batchId + '/items/' + encodeURIComponent(itemIdentifier), {
      method: 'DELETE'
    });
  }

  async function createBatch(data) {
    return await api('/api/delivery-batches', {
      method: 'POST',
      body: JSON.stringify(data)
    });
  }

  function reset() {
    batches = [];
    itemBatchCache.clear();
  }

  return {
    load,
    reset,
    getBatches,
    findByBatchNo,
    findById,
    lookupItemBatch,
    lookupItemBatches,
    clearCache,
    renderBatchSelect,
    getBatchTagHtml,
    assignItemToBatch,
    removeItemFromBatch,
    createBatch
  };
})();
