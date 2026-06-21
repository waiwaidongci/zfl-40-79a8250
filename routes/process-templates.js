import {
  loadTemplates,
  saveTemplates,
  newTemplateId,
  getDefaultTemplate
} from "../data/process-templates.js";

function send(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

async function body(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
}

function validateStep(step) {
  const errors = [];
  if (!step.name) errors.push("步骤名称必填");
  if (typeof step.order !== "number" || step.order < 1) errors.push("步骤序号必须为正整数");
  if (!Array.isArray(step.requiredFields)) errors.push("requiredFields 必须为数组");
  if (!Array.isArray(step.optionalFields)) errors.push("optionalFields 必须为数组");
  if (typeof step.allowSkip !== "boolean") errors.push("allowSkip 必须为布尔值");
  return errors;
}

function validateTemplate(input) {
  const errors = [];
  if (!input.name || !input.name.trim()) {
    errors.push("模板名称必填");
  }
  if (!Array.isArray(input.steps) || input.steps.length === 0) {
    errors.push("模板至少需要包含一个步骤");
    return errors;
  }
  const seenOrders = new Set();
  const seenKeys = new Set();
  for (const step of input.steps) {
    const stepErrors = validateStep(step);
    if (stepErrors.length) {
      errors.push(`步骤「${step.name || step.key || '未命名'}」错误：${stepErrors.join("; ")}`);
    }
    if (seenOrders.has(step.order)) {
      errors.push(`步骤序号重复：${step.order}`);
    }
    seenOrders.add(step.order);
    const key = step.key || step.name;
    if (seenKeys.has(key)) {
      errors.push(`步骤标识重复：${key}`);
    }
    seenKeys.add(key);
  }
  return errors;
}

export async function handleTemplateRoutes(req, res, url) {
  if (!url.pathname.startsWith("/api/process-templates")) return null;

  const db = await loadTemplates();

  if (req.method === "GET" && url.pathname === "/api/process-templates") {
    return send(res, 200, db.templates);
  }

  if (req.method === "GET" && url.pathname === "/api/process-templates/default") {
    const def = getDefaultTemplate(db.templates);
    if (!def) return send(res, 404, { error: "no_default_template" });
    return send(res, 200, def);
  }

  if (req.method === "POST" && url.pathname === "/api/process-templates") {
    const input = await body(req);
    const errors = validateTemplate(input);
    if (errors.length) return send(res, 400, { error: errors.join("; ") });

    if (input.isDefault) {
      db.templates.forEach(t => { t.isDefault = false; });
    } else if (db.templates.length === 0) {
      input.isDefault = true;
    }

    const steps = input.steps.map((s, idx) => ({
      key: s.key || s.name.toLowerCase().replace(/\s+/g, "-"),
      name: s.name,
      order: s.order || (idx + 1),
      description: s.description || "",
      requiredFields: s.requiredFields || [],
      optionalFields: s.optionalFields || [],
      allowSkip: s.allowSkip !== undefined ? s.allowSkip : true,
      estimatedDuration: s.estimatedDuration || "",
      ...(s.targetStatus ? { targetStatus: s.targetStatus } : {})
    }));

    const template = {
      id: newTemplateId(),
      name: input.name.trim(),
      description: input.description || "",
      isDefault: !!input.isDefault,
      createdAt: new Date().toISOString(),
      steps,
      statusTransitions: input.statusTransitions || {}
    };

    db.templates.push(template);
    await saveTemplates(db);
    return send(res, 201, template);
  }

  const singleMatch = url.pathname.match(/^\/api\/process-templates\/([^/]+)$/);

  if (singleMatch) {
    const templateId = singleMatch[1];
    const template = db.templates.find(t => t.id === templateId);
    if (!template) return send(res, 404, { error: "template_not_found" });

    if (req.method === "GET") {
      return send(res, 200, template);
    }

    if (req.method === "PUT") {
      const input = await body(req);
      if (input.name !== undefined) {
        if (!input.name.trim()) return send(res, 400, { error: "模板名称不能为空" });
        template.name = input.name.trim();
      }
      if (input.description !== undefined) template.description = input.description;
      if (input.statusTransitions !== undefined) template.statusTransitions = input.statusTransitions;

      if (input.steps !== undefined) {
        const errors = validateTemplate({ ...template, steps: input.steps });
        if (errors.length) return send(res, 400, { error: errors.join("; ") });
        template.steps = input.steps.map((s, idx) => ({
          key: s.key || s.name.toLowerCase().replace(/\s+/g, "-"),
          name: s.name,
          order: s.order || (idx + 1),
          description: s.description || "",
          requiredFields: s.requiredFields || [],
          optionalFields: s.optionalFields || [],
          allowSkip: s.allowSkip !== undefined ? s.allowSkip : true,
          estimatedDuration: s.estimatedDuration || "",
          ...(s.targetStatus ? { targetStatus: s.targetStatus } : {})
        }));
      }

      if (input.isDefault !== undefined) {
        if (input.isDefault) {
          db.templates.forEach(t => { t.isDefault = false; });
          template.isDefault = true;
        } else {
          template.isDefault = false;
        }
      }

      template.updatedAt = new Date().toISOString();
      await saveTemplates(db);
      return send(res, 200, template);
    }

    if (req.method === "DELETE") {
      if (template.isDefault) {
        return send(res, 400, { error: "不能删除默认模板，请先将其他模板设为默认" });
      }
      const idx = db.templates.findIndex(t => t.id === templateId);
      const removed = db.templates.splice(idx, 1)[0];
      await saveTemplates(db);
      return send(res, 200, removed);
    }
  }

  return null;
}
