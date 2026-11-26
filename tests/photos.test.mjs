// Photos handler tests (mocked Prisma + session + Blob).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import photosHandler from "../api/_lib/me-photos.js";
import {
  setAuthEnv,
  clearAuthEnv,
  restoreEnv,
  sessionDepsFor,
  noSessionDeps,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const PNG = Buffer.alloc(100, 1);

function photoRow(overrides = {}) {
  return {
    id: "ph1",
    userId: "u1",
    url: "https://blob.vercel-storage.com/photos/u1/1-cat.png",
    pathname: "photos/u1/1-cat.png",
    filename: "cat.png",
    sizeBytes: 100,
    createdAt: "2026-11-27T00:00:00.000Z",
    ...overrides,
  };
}

function mockPrismaPhotos({ photos = [], count = 0, setting = null } = {}) {
  const calls = { findMany: [], count: [], create: [], delete: [], deleteMany: [], findFirst: [], findUnique: [] };
  return {
    calls,
    siteSetting: {
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return setting;
      },
    },
    photo: {
      findMany: async (args) => {
        calls.findMany.push(args);
        return photos;
      },
      findFirst: async (args) => {
        calls.findFirst.push(args);
        return photos.find((p) => p.id === args.where.id && p.userId === args.where.userId) || null;
      },
      count: async (args) => {
        calls.count.push(args);
        return count;
      },
      create: async ({ data }) => {
        calls.create.push(data);
        return { id: "ph-new", createdAt: "2026-11-27T00:00:00.000Z", ...data };
      },
      delete: async (args) => {
        calls.delete.push(args);
        return {};
      },
      deleteMany: async (args) => {
        calls.deleteMany.push(args);
        return { count: photos.length };
      },
    },
  };
}

function mockBlob() {
  const calls = { put: [], del: [] };
  return {
    calls,
    put: async (pathname, body, opts) => {
      calls.put.push({ pathname, size: body.length, contentType: opts.contentType });
      return { url: "https://blob.vercel-storage.com/" + pathname, pathname };
    },
    del: async (url) => {
      calls.del.push(url);
    },
  };
}

const ENABLED = { key: "uploads_enabled", value: "true" };
let prevToken;

beforeEach(() => {
  setAuthEnv();
  prevToken = process.env.BLOB_READ_WRITE_TOKEN;
  process.env.BLOB_READ_WRITE_TOKEN = "test-token";
});
afterEach(() => {
  restoreEnv();
  if (prevToken === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
  else process.env.BLOB_READ_WRITE_TOKEN = prevToken;
});

function run(req, prisma, blob) {
  const res = mockRes();
  return photosHandler(req, res, { prisma, sessionDeps: sessionDepsFor("u1"), blob }).then(() => res);
}

describe("GET /api/me/photos", () => {
  it("lists the user's own photos and answers 401 when signed out", async () => {
    const rows = [photoRow(), photoRow({ id: "ph2", filename: "dog.png" })];
    const res = await run(
      mockReq({ url: "/api/me/photos" }),
      mockPrismaPhotos({ photos: rows }),
      mockBlob(),
    );
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.photos.length, 2);
    assert.equal(body.photos[0].url, rows[0].url);
    assert.equal(body.photos[0].pathname, undefined); // metadata only — no Blob internals leak

    const signedOut = mockRes();
    await photosHandler(mockReq({ url: "/api/me/photos" }), signedOut, {
      prisma: mockPrismaPhotos(),
      sessionDeps: noSessionDeps(),
      blob: mockBlob(),
    });
    assert.equal(signedOut.statusCode, 401);
  });
});

describe("POST /api/me/photos", () => {
  it("uploads to Blob and stores only the metadata row", async () => {
    const prisma = mockPrismaPhotos({ setting: ENABLED });
    const blob = mockBlob();
    const res = await run(
      mockReq({
        method: "POST",
        url: "/api/me/photos",
        headers: { "content-type": "image/png", "x-filename": "my cat!.png" },
        body: PNG,
      }),
      prisma,
      blob,
    );
    assert.equal(res.statusCode, 201);
    const body = await res.json();
    assert.equal(body.photo.filename, "my-cat.png");
    assert.equal(body.photo.sizeBytes, 100);
    assert.equal(blob.calls.put.length, 1);
    assert.match(blob.calls.put[0].pathname, /^photos\/u1\/\d+-my-cat\.png$/);
    assert.equal(blob.calls.put[0].contentType, "image/png");
    assert.equal(prisma.calls.create[0].userId, "u1");
    assert.equal(prisma.calls.create[0].url, body.photo.url);
  });

  it("answers 503 when uploads are disabled or the Blob token is missing", async () => {
    const disabled = await run(
      mockReq({ method: "POST", url: "/api/me/photos", headers: { "content-type": "image/png" }, body: PNG }),
      mockPrismaPhotos({ setting: null }),
      mockBlob(),
    );
    assert.equal(disabled.statusCode, 503);
    assert.equal((await disabled.json()).error, "uploads_disabled");

    delete process.env.BLOB_READ_WRITE_TOKEN;
    const noToken = await run(
      mockReq({ method: "POST", url: "/api/me/photos", headers: { "content-type": "image/png" }, body: PNG }),
      mockPrismaPhotos({ setting: ENABLED }),
      mockBlob(),
    );
    assert.equal(noToken.statusCode, 503);
    assert.equal((await noToken.json()).error, "uploads_not_configured");
  });

  it("rejects non-images, empty and oversized bodies, and a full gallery", async () => {
    const badType = await run(
      mockReq({ method: "POST", url: "/api/me/photos", headers: { "content-type": "text/plain" }, body: PNG }),
      mockPrismaPhotos({ setting: ENABLED }),
      mockBlob(),
    );
    assert.equal(badType.statusCode, 400);

    const empty = await run(
      mockReq({ method: "POST", url: "/api/me/photos", headers: { "content-type": "image/png" }, body: Buffer.alloc(0) }),
      mockPrismaPhotos({ setting: ENABLED }),
      mockBlob(),
    );
    assert.equal(empty.statusCode, 400);

    const big = await run(
      mockReq({ method: "POST", url: "/api/me/photos", headers: { "content-type": "image/png" }, body: Buffer.alloc(4 * 1024 * 1024 + 1) }),
      mockPrismaPhotos({ setting: ENABLED }),
      mockBlob(),
    );
    assert.equal(big.statusCode, 413);
    assert.equal((await big.json()).error, "photo_too_large");

    const full = await run(
      mockReq({ method: "POST", url: "/api/me/photos", headers: { "content-type": "image/png" }, body: PNG }),
      mockPrismaPhotos({ setting: ENABLED, count: 20 }),
      mockBlob(),
    );
    assert.equal(full.statusCode, 400);
    assert.equal((await full.json()).error, "photo_limit_reached");
  });
});

describe("DELETE /api/me/photos", () => {
  it("removes the Blob object and the row for one photo", async () => {
    const prisma = mockPrismaPhotos({ photos: [photoRow()] });
    const blob = mockBlob();
    const res = await run(mockReq({ method: "DELETE", url: "/api/me/photos?id=ph1" }), prisma, blob);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(blob.calls.del, [photoRow().url]);
    assert.deepEqual(prisma.calls.delete, [{ where: { id: "ph1" } }]);

    const missing = await run(
      mockReq({ method: "DELETE", url: "/api/me/photos?id=nope" }),
      mockPrismaPhotos({ photos: [photoRow()] }),
      mockBlob(),
    );
    assert.equal(missing.statusCode, 404);
  });

  it("clears the whole gallery and answers 400 with neither id nor scope", async () => {
    const rows = [photoRow(), photoRow({ id: "ph2", url: "https://blob.vercel-storage.com/photos/u1/2-dog.png" })];
    const prisma = mockPrismaPhotos({ photos: rows });
    const blob = mockBlob();
    const res = await run(mockReq({ method: "DELETE", url: "/api/me/photos?scope=all" }), prisma, blob);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { ok: true, removed: 2 });
    assert.deepEqual(blob.calls.del, rows.map((r) => r.url));
    assert.deepEqual(prisma.calls.deleteMany, [{ where: { userId: "u1" } }]);

    const noTarget = await run(
      mockReq({ method: "DELETE", url: "/api/me/photos" }),
      mockPrismaPhotos(),
      mockBlob(),
    );
    assert.equal(noTarget.statusCode, 400);
  });
});
