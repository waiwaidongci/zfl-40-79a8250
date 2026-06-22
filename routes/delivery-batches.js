import { loadDeliveryBatches, saveDeliveryBatches } from "../data/delivery-batches.js";
import {
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
} from "../services/delivery-batches.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

export async function handleDeliveryBatchRoutes(req, res, url, dbItems, studioId) {
  const db = await loadDeliveryBatches(studioId);

  if (req.method === "GET" && url.pathname === "/api/delivery-batches") {
    const q = url.searchParams.get("q");
    const customer = url.searchParams.get("customer");
    let list = db.batches;
    if (q) {
      list = list.filter(b =>
        b.batchNo.includes(q) ||
        (b.customer || "").includes(q) ||
        (b.note || "").includes(q)
      );
    }
    if (customer) {
      list = list.filter(b => (b.customer || "") === customer);
    }
    return send(res, 200, list);
  }

  if (req.method === "POST" && url.pathname === "/api/delivery-batches") {
    const input = await body(req);
    const result = await createBatch(input, studioId);
    if (result.error) return send(res, 400, { error: result.error });
    return send(res, 201, result.batch);
  }

  const singleMatch = url.pathname.match(/^\/api\/delivery-batches\/([^/]+)$/);

  if (singleMatch && req.method === "GET") {
    if (dbItems) {
      const result = await getBatchWithDetails(singleMatch[1], dbItems, studioId);
      if (result.error) return send(res, 404, { error: result.error });
      return send(res, 200, result.batch);
    }
    const batch = db.batches.find(b => b.id === singleMatch[1]);
    if (!batch) return send(res, 404, { error: "batch_not_found" });
    return send(res, 200, batch);
  }

  if (singleMatch && req.method === "PUT") {
    const input = await body(req);
    const result = await updateBatch(singleMatch[1], input, studioId);
    if (result.error) return send(res, result.error === "batch_not_found" ? 404 : 400, { error: result.error });
    return send(res, 200, result.batch);
  }

  if (singleMatch && req.method === "DELETE") {
    const result = await deleteBatch(singleMatch[1], studioId);
    if (result.error) return send(res, 404, { error: result.error });
    return send(res, 200, result.batch);
  }

  const itemsMatch = url.pathname.match(/^\/api\/delivery-batches\/([^/]+)\/items$/);
  if (itemsMatch && req.method === "POST") {
    const input = await body(req);
    const result = await addItemToBatch(itemsMatch[1], input, dbItems, studioId);
    if (result.error) {
      const status = result.error === "batch_not_found" ? 404 : 400;
      return send(res, status, { error: result.error });
    }
    return send(res, 201, { batch: result.batch, addedItem: result.addedItem });
  }

  const itemMatch = url.pathname.match(/^\/api\/delivery-batches\/([^/]+)\/items\/([^/]+)$/);
  if (itemMatch && req.method === "DELETE") {
    const result = await removeItemFromBatch(itemMatch[1], decodeURIComponent(itemMatch[2]), studioId);
    if (result.error) {
      const status = result.error === "batch_not_found" ? 404 : 400;
      return send(res, status, { error: result.error });
    }
    return send(res, 200, { batch: result.batch, removedItem: result.removedItem });
  }

  if (itemMatch && req.method === "PATCH") {
    const input = await body(req);
    const result = await confirmItemInBatch(itemMatch[1], decodeURIComponent(itemMatch[2]), input.confirmed, studioId);
    if (result.error) {
      const status = result.error === "batch_not_found" ? 404 : 400;
      return send(res, status, { error: result.error });
    }
    return send(res, 200, { batch: result.batch, item: result.item });
  }

  const cleanupMatch = url.pathname.match(/^\/api\/delivery-batches\/([^/]+)\/cleanup$/);
  if (cleanupMatch && req.method === "POST") {
    const result = await removeUnconfirmedItems(cleanupMatch[1], studioId);
    if (result.error) return send(res, 404, { error: result.error });
    return send(res, 200, result);
  }

  const exportMatch = url.pathname.match(/^\/api\/delivery-batches\/([^/]+)\/export$/);
  if (exportMatch && req.method === "GET") {
    if (!dbItems) return send(res, 500, { error: "items_db_unavailable" });
    const result = await getBatchWithDetails(exportMatch[1], dbItems, studioId);
    if (result.error) return send(res, 404, { error: result.error });
    const allBatchItems = result.batch.items;
    const exportableItems = allBatchItems.filter(bi => bi.confirmed && bi.isDelivered);
    const excludedItems = allBatchItems.filter(bi => bi.confirmed && !bi.isDelivered);
    const exportData = {
      exportAt: new Date().toISOString(),
      batch: {
        id: result.batch.id,
        batchNo: result.batch.batchNo,
        customer: result.batch.customer,
        deliveryDate: result.batch.deliveryDate,
        note: result.batch.note,
        createdAt: result.batch.createdAt
      },
      items: exportableItems.map(bi => {
        const d = bi.details || {};
        const repairLogs = [
          ...((d.logs || []).filter(l => l.repair).map(l => l.repair)),
          ...((d.steps || []).filter(s => s.repair).map(s => s.repair))
        ].filter(Boolean);
        const deliveryTime = (d.logs || []).filter(l => l.step === "交付" || l.note?.includes("交付")).slice(-1)[0]?.at
          || (d.steps || []).filter(s => s.step === "交付").slice(-1)[0]?.at
          || result.batch.deliveryDate
          || "";
        return {
          code: d.code || bi.code,
          plateSize: d.plateSize || "",
          box: d.box || "",
          defectSummary: d.defect || "",
          repairRecords: repairLogs.join("; "),
          deliveryTime: deliveryTime,
          confirmedAt: bi.addedAt
        };
      }),
      excludedItems: excludedItems.map(bi => ({
        code: bi.code,
        currentStatus: bi.currentStatus || "未知",
        reason: "状态已变更为「" + (bi.currentStatus || "未知") + "」，不在导出清单中"
      })),
      exportedCount: exportableItems.length,
      excludedCount: excludedItems.length,
      totalInBatch: allBatchItems.length
    };
    const filename = `delivery-${result.batch.batchNo}-${Date.now()}.json`;
    res.writeHead(200, {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`
    });
    return res.end(JSON.stringify(exportData, null, 2));
  }

  const itemBatchLookup = url.pathname.match(/^\/api\/delivery-batches\/item\/([^/]+)$/);
  if (itemBatchLookup && req.method === "GET") {
    const result = await findBatchForItem(decodeURIComponent(itemBatchLookup[1]), studioId);
    if (!result) return send(res, 200, null);
    return send(res, 200, result);
  }

  if (req.method === "GET" && url.pathname === "/api/delivery-batches/ungrouped/delivered") {
    if (!dbItems) return send(res, 500, { error: "items_db_unavailable" });
    const ungrouped = getDeliveredItemsWithoutBatch(dbItems, db, studioId);
    return send(res, 200, ungrouped);
  }

  return null;
}
