import { loadDeliveryBatches, saveDeliveryBatches, newBatchId } from "../data/delivery-batches.js";

function findBatchById(db, id) {
  return db.batches.find(b => b.id === id);
}

function findBatchByBatchNo(db, batchNo) {
  return db.batches.find(b => b.batchNo === batchNo);
}

function findItemInBatch(batch, itemIdentifier) {
  return batch.items.find(i => i.itemId === itemIdentifier || i.code === itemIdentifier);
}

async function createBatch(input) {
  const db = await loadDeliveryBatches();
  const batchNo = input.batchNo || ("D-" + new Date().toISOString().slice(0,10).replace(/-/g,"") + "-" + String(db.batches.length + 1).padStart(2, "0"));

  if (findBatchByBatchNo(db, batchNo)) {
    return { error: "批次号已存在" };
  }

  const batch = {
    id: newBatchId(),
    batchNo: batchNo,
    customer: input.customer || "",
    deliveryDate: input.deliveryDate || new Date().toISOString().slice(0, 10),
    note: input.note || "",
    createdAt: new Date().toISOString(),
    items: []
  };

  db.batches.unshift(batch);
  await saveDeliveryBatches(db);
  return { batch };
}

async function updateBatch(id, input) {
  const db = await loadDeliveryBatches();
  const batch = findBatchById(db, id);
  if (!batch) return { error: "batch_not_found" };

  if (input.batchNo !== undefined && input.batchNo !== batch.batchNo) {
    if (findBatchByBatchNo(db, input.batchNo)) {
      return { error: "批次号已存在" };
    }
    batch.batchNo = input.batchNo;
  }
  if (input.customer !== undefined) batch.customer = input.customer;
  if (input.deliveryDate !== undefined) batch.deliveryDate = input.deliveryDate;
  if (input.note !== undefined) batch.note = input.note;

  await saveDeliveryBatches(db);
  return { batch };
}

async function deleteBatch(id) {
  const db = await loadDeliveryBatches();
  const idx = db.batches.findIndex(b => b.id === id);
  if (idx === -1) return { error: "batch_not_found" };
  const removed = db.batches.splice(idx, 1)[0];
  await saveDeliveryBatches(db);
  return { batch: removed };
}

async function addItemToBatch(batchId, itemData) {
  const db = await loadDeliveryBatches();
  const batch = findBatchById(db, batchId);
  if (!batch) return { error: "batch_not_found" };

  const itemIdentifier = itemData.itemId || itemData.code;
  if (findItemInBatch(batch, itemIdentifier)) {
    return { error: "该底片已在此批次中" };
  }

  const batchItem = {
    itemId: itemData.itemId || itemData.code,
    code: itemData.code || itemData.itemId,
    confirmed: itemData.confirmed !== undefined ? itemData.confirmed : false,
    addedAt: new Date().toISOString()
  };

  batch.items.push(batchItem);
  await saveDeliveryBatches(db);
  return { batch, addedItem: batchItem };
}

async function removeItemFromBatch(batchId, itemIdentifier) {
  const db = await loadDeliveryBatches();
  const batch = findBatchById(db, batchId);
  if (!batch) return { error: "batch_not_found" };

  const idx = batch.items.findIndex(i => i.itemId === itemIdentifier || i.code === itemIdentifier);
  if (idx === -1) return { error: "item_not_in_batch" };

  const removed = batch.items.splice(idx, 1)[0];
  await saveDeliveryBatches(db);
  return { batch, removedItem: removed };
}

async function confirmItemInBatch(batchId, itemIdentifier, confirmed = true) {
  const db = await loadDeliveryBatches();
  const batch = findBatchById(db, batchId);
  if (!batch) return { error: "batch_not_found" };

  const item = findItemInBatch(batch, itemIdentifier);
  if (!item) return { error: "item_not_in_batch" };

  item.confirmed = confirmed;
  await saveDeliveryBatches(db);
  return { batch, item };
}

async function removeUnconfirmedItems(batchId) {
  const db = await loadDeliveryBatches();
  const batch = findBatchById(db, batchId);
  if (!batch) return { error: "batch_not_found" };

  const removed = batch.items.filter(i => !i.confirmed);
  batch.items = batch.items.filter(i => i.confirmed);
  await saveDeliveryBatches(db);
  return { batch, removedCount: removed.length, removed };
}

async function getBatchWithDetails(batchId, allItems) {
  const db = await loadDeliveryBatches();
  const batch = findBatchById(db, batchId);
  if (!batch) return { error: "batch_not_found" };

  const detailedItems = batch.items.map(batchItem => {
    const item = allItems.find(x => x.id === batchItem.itemId || x.code === batchItem.itemId || x.code === batchItem.code);
    return {
      ...batchItem,
      details: item || null
    };
  });

  return {
    batch: {
      ...batch,
      items: detailedItems
    }
  };
}

async function findBatchForItem(itemIdentifier) {
  const db = await loadDeliveryBatches();
  for (const batch of db.batches) {
    const found = findItemInBatch(batch, itemIdentifier);
    if (found) {
      return {
        batch: {
          id: batch.id,
          batchNo: batch.batchNo,
          customer: batch.customer,
          deliveryDate: batch.deliveryDate,
          note: batch.note
        },
        item: found
      };
    }
  }
  return null;
}

function getDeliveredItemsWithoutBatch(allItems, batchesDb) {
  const delivered = allItems.filter(i => i.status === "已交付");
  const assignedCodes = new Set();
  for (const batch of batchesDb.batches) {
    for (const item of batch.items) {
      assignedCodes.add(item.code);
      assignedCodes.add(item.itemId);
    }
  }
  return delivered.filter(i => !assignedCodes.has(i.code) && !assignedCodes.has(i.id));
}

export {
  createBatch,
  updateBatch,
  deleteBatch,
  addItemToBatch,
  removeItemFromBatch,
  confirmItemInBatch,
  removeUnconfirmedItems,
  getBatchWithDetails,
  findBatchForItem,
  getDeliveredItemsWithoutBatch
};
