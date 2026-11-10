const { timingSafeEqual } = require("node:crypto");
const express = require("express");
const rateLimit = require("express-rate-limit");
const helmet = require("helmet");
const { z } = require("zod");

const severities = ["low", "medium", "high", "critical"];
const statuses = ["open", "investigating", "resolved"];

const createIncidentSchema = z.object({
  title: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(5000),
  service: z.string().trim().min(1).max(100),
  severity: z.enum(severities),
  assignee: z.string().trim().max(120).nullable().optional()
}).strict();

const updateIncidentSchema = z.object({
  severity: z.enum(severities).optional(),
  status: z.enum(statuses).optional(),
  assignee: z.string().trim().max(120).nullable().optional()
}).strict().refine((value) => Object.keys(value).length > 0, {
  message: "Provide at least one field to update"
});

const listQuerySchema = z.object({
  status: z.enum(statuses).optional(),
  severity: z.enum(severities).optional(),
  service: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(20)
}).strict();

function isValidApiKey(providedKey, configuredKey) {
  if (typeof providedKey !== "string" || !configuredKey) return false;
  const provided = Buffer.from(providedKey);
  const configured = Buffer.from(configuredKey);
  return provided.length === configured.length && timingSafeEqual(provided, configured);
}

function createApp({ db, apiKey }) {
  if (!db) throw new Error("A database connection is required");
  if (!apiKey) throw new Error("An API key is required");

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet());
  app.use(express.json({ limit: "16kb" }));
  app.use("/api", rateLimit({
    windowMs: 60 * 1000,
    limit: 100,
    standardHeaders: "draft-8",
    legacyHeaders: false
  }));

  app.get("/health", (_req, res) => {
    res.status(200).json({ status: "ok" });
  });

  app.use("/api", (req, res, next) => {
    if (!isValidApiKey(req.get("x-api-key"), apiKey)) {
      return res.status(401).json({ error: "Unauthorized" });
    }
    return next();
  });

  app.post("/api/incidents", (req, res, next) => {
    const parsed = createIncidentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    }

    try {
      const now = new Date().toISOString();
      const incident = {
        id: require("node:crypto").randomUUID(),
        ...parsed.data,
        status: "open",
        assignee: parsed.data.assignee ?? null,
        created_at: now,
        updated_at: now
      };
      db.prepare(`
        INSERT INTO incidents (id, title, description, service, severity, status, assignee, created_at, updated_at)
        VALUES (@id, @title, @description, @service, @severity, @status, @assignee, @created_at, @updated_at)
      `).run(incident);

      return res.status(201).json({ data: incident });
    } catch (error) {
      return next(error);
    }
  });

  app.get("/api/incidents", (req, res) => {
    const parsed = listQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid query", details: parsed.error.issues });
    }

    const { status, severity, service, page, limit } = parsed.data;
    const filters = [];
    const params = {};
    if (status) {
      filters.push("status = @status");
      params.status = status;
    }
    if (severity) {
      filters.push("severity = @severity");
      params.severity = severity;
    }
    if (service) {
      filters.push("service = @service");
      params.service = service;
    }
    const where = filters.length ? `WHERE ${filters.join(" AND ")}` : "";
    const total = db.prepare(`SELECT COUNT(*) AS count FROM incidents ${where}`).get(params).count;
    const data = db.prepare(`
      SELECT * FROM incidents ${where}
      ORDER BY created_at DESC, id DESC
      LIMIT @limit OFFSET @offset
    `).all({ ...params, limit, offset: (page - 1) * limit });

    return res.status(200).json({
      data,
      pagination: { page, limit, total, pages: Math.ceil(total / limit) }
    });
  });

  app.get("/api/incidents/:id", (req, res) => {
    const incident = db.prepare("SELECT * FROM incidents WHERE id = ?").get(req.params.id);
    if (!incident) return res.status(404).json({ error: "Incident not found" });
    return res.status(200).json({ data: incident });
  });

  app.patch("/api/incidents/:id", (req, res, next) => {
    const parsed = updateIncidentSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: "Invalid request", details: parsed.error.issues });
    }

    try {
      const current = db.prepare("SELECT * FROM incidents WHERE id = ?").get(req.params.id);
      if (!current) return res.status(404).json({ error: "Incident not found" });

      if (parsed.data.status && !canTransition(current.status, parsed.data.status)) {
        return res.status(409).json({
          error: `Cannot change incident status from '${current.status}' to '${parsed.data.status}'`
        });
      }

      const updated = {
        ...current,
        ...parsed.data,
        updated_at: new Date().toISOString()
      };
      db.prepare(`
        UPDATE incidents
        SET severity = @severity, status = @status, assignee = @assignee, updated_at = @updated_at
        WHERE id = @id
      `).run(updated);

      return res.status(200).json({ data: updated });
    } catch (error) {
      return next(error);
    }
  });

  app.use((_req, res) => res.status(404).json({ error: "Route not found" }));
  app.use((error, _req, res, _next) => {
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return res.status(400).json({ error: "Malformed JSON" });
    }
    console.error(error);
    return res.status(500).json({ error: "Internal server error" });
  });

  return app;
}

function canTransition(from, to) {
  const transitions = {
    open: ["investigating"],
    investigating: ["open", "resolved"],
    resolved: ["open"]
  };
  return from === to || transitions[from].includes(to);
}

module.exports = { createApp };
