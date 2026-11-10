const { after, before, beforeEach, describe, it } = require("node:test");
const assert = require("node:assert/strict");
const request = require("supertest");
const { createApp } = require("../src/app");
const { createDatabase } = require("../src/database");

const apiKey = "test-key-with-at-least-32-characters";
let db;
let app;

const incidentInput = {
  title: "Login failures",
  description: "Users cannot sign in to the customer portal.",
  service: "customer-portal",
  severity: "high"
};

before(() => {
  db = createDatabase(":memory:");
  app = createApp({ db, apiKey });
});

beforeEach(() => {
  db.prepare("DELETE FROM incidents").run();
});

after(() => db.close());

describe("incident API", () => {
  it("reports health without an API key", async () => {
    const response = await request(app).get("/health");
    assert.equal(response.status, 200);
    assert.deepEqual(response.body, { status: "ok" });
  });

  it("requires an API key for API routes", async () => {
    const response = await request(app).get("/api/incidents");
    assert.equal(response.status, 401);
  });

  it("creates an incident and assigns safe defaults", async () => {
    const response = await request(app)
      .post("/api/incidents")
      .set("x-api-key", apiKey)
      .send(incidentInput);

    assert.equal(response.status, 201);
    assert.equal(response.body.data.title, incidentInput.title);
    assert.equal(response.body.data.status, "open");
    assert.equal(response.body.data.assignee, null);
    assert.ok(response.body.data.id);
  });

  it("rejects invalid input and unknown fields", async () => {
    const response = await request(app)
      .post("/api/incidents")
      .set("x-api-key", apiKey)
      .send({ ...incidentInput, severity: "urgent", isAdmin: true });

    assert.equal(response.status, 400);
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM incidents").get().count, 0);
  });

  it("filters and paginates incident lists", async () => {
    const create = (input) => request(app)
      .post("/api/incidents")
      .set("x-api-key", apiKey)
      .send(input);

    await create(incidentInput);
    await create({ ...incidentInput, title: "Storage latency", severity: "critical", service: "storage" });

    const response = await request(app)
      .get("/api/incidents?severity=critical&page=1&limit=1")
      .set("x-api-key", apiKey);

    assert.equal(response.status, 200);
    assert.equal(response.body.data.length, 1);
    assert.equal(response.body.pagination.total, 1);
    assert.equal(response.body.data[0].service, "storage");
  });

  it("enforces incident status transitions", async () => {
    const created = await request(app)
      .post("/api/incidents")
      .set("x-api-key", apiKey)
      .send(incidentInput);
    const id = created.body.data.id;

    const invalid = await request(app)
      .patch(`/api/incidents/${id}`)
      .set("x-api-key", apiKey)
      .send({ status: "resolved" });
    assert.equal(invalid.status, 409);

    const investigating = await request(app)
      .patch(`/api/incidents/${id}`)
      .set("x-api-key", apiKey)
      .send({ status: "investigating", assignee: "on-call" });
    assert.equal(investigating.status, 200);
    assert.equal(investigating.body.data.status, "investigating");
    assert.equal(investigating.body.data.assignee, "on-call");

    const resolved = await request(app)
      .patch(`/api/incidents/${id}`)
      .set("x-api-key", apiKey)
      .send({ status: "resolved" });
    assert.equal(resolved.status, 200);
    assert.equal(resolved.body.data.status, "resolved");
  });

  it("returns not found for missing incidents", async () => {
    const response = await request(app)
      .get("/api/incidents/missing")
      .set("x-api-key", apiKey);
    assert.equal(response.status, 404);
  });
});
