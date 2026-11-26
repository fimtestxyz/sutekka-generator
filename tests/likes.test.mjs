// Like toggle handler tests (mocked Prisma + session).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import likeHandler from "../api/stickers/[id]/like.js";
import {
  setAuthEnv,
  clearAuthEnv,
  restoreEnv,
  sessionDepsFor,
  noSessionDeps,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const STICKER = { id: "ck123", slug: "set-a" };

beforeEach(() => setAuthEnv());
afterEach(() => restoreEnv());

function mockPrismaLikes({ sticker = STICKER, liked = false, baseCount = 3, createError = null } = {}) {
  const calls = { create: [], delete: [], findUnique: 0, findSticker: [] };
  let isLiked = liked;
  return {
    calls,
    sticker: {
      findFirst: async ({ where }) => {
        calls.findSticker.push(where);
        return sticker;
      },
    },
    like: {
      findUnique: async () => {
        calls.findUnique += 1;
        return isLiked ? { id: "lk1" } : null;
      },
      create: async ({ data }) => {
        calls.create.push(data);
        if (createError) {
          if (createError === "P2002") isLiked = true; // the race winner's row exists
          const err = /** @type {any} */ (new Error("Unique constraint failed"));
          err.code = createError;
          throw err;
        }
        isLiked = true;
        return { id: "lk1" };
      },
      delete: async ({ where }) => {
        calls.delete.push(where);
        isLiked = false;
        return { id: "lk1" };
      },
      count: async () => baseCount + (isLiked ? 1 : 0),
    },
  };
}

describe("GET /api/stickers/[id]/like", () => {
  it("returns count + liked:false when signed out", async () => {
    const res = mockRes();
    await likeHandler(
      mockReq({ url: "/api/stickers/set-a/like" }),
      res,
      { prisma: mockPrismaLikes({ liked: false, baseCount: 3 }), sessionDeps: noSessionDeps() },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), {
      liked: false,
      likes: 3,
      sticker: { id: "ck123", slug: "set-a" },
    });
  });

  it("returns liked:true when the signed-in user likes the set", async () => {
    const res = mockRes();
    await likeHandler(
      mockReq({ url: "/api/stickers/set-a/like" }),
      res,
      { prisma: mockPrismaLikes({ liked: true, baseCount: 3 }), sessionDeps: sessionDepsFor("u1") },
    );
    assert.deepEqual(await res.json(), {
      liked: true,
      likes: 4,
      sticker: { id: "ck123", slug: "set-a" },
    });
  });

  it("resolves the sticker by cuid as well as by slug", async () => {
    const prisma = mockPrismaLikes();
    const res = mockRes();
    await likeHandler(mockReq({ url: "/api/stickers/ck123/like" }), res, {
      prisma,
      sessionDeps: noSessionDeps(),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.findSticker, [{ OR: [{ slug: "ck123" }, { id: "ck123" }] }]);
  });

  it("answers 404 for an unknown sticker and 503 without a DB", async () => {
    const notFound = mockRes();
    await likeHandler(mockReq({ url: "/api/stickers/nope/like" }), notFound, {
      prisma: mockPrismaLikes({ sticker: null }),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(notFound.statusCode, 404);
    assert.deepEqual(await notFound.json(), { error: "sticker_not_found" });

    clearAuthEnv();
    const noDb = mockRes();
    await likeHandler(mockReq({ url: "/api/stickers/set-a/like" }), noDb, {
      prisma: mockPrismaLikes(),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(noDb.statusCode, 503);
  });
});

describe("POST /api/stickers/[id]/like", () => {
  it("answers 401 when signed out", async () => {
    const res = mockRes();
    await likeHandler(
      mockReq({ method: "POST", url: "/api/stickers/set-a/like" }),
      res,
      { prisma: mockPrismaLikes(), sessionDeps: noSessionDeps() },
    );
    assert.equal(res.statusCode, 401);
  });

  it("creates the like when not liked", async () => {
    const prisma = mockPrismaLikes({ liked: false, baseCount: 3 });
    const res = mockRes();
    await likeHandler(
      mockReq({ method: "POST", url: "/api/stickers/set-a/like" }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.create, [{ userId: "u1", stickerId: "ck123" }]);
    assert.deepEqual(await res.json(), {
      liked: true,
      likes: 4,
      sticker: { id: "ck123", slug: "set-a" },
    });
  });

  it("deletes the like when already liked", async () => {
    const prisma = mockPrismaLikes({ liked: true, baseCount: 3 });
    const res = mockRes();
    await likeHandler(
      mockReq({ method: "POST", url: "/api/stickers/set-a/like" }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.create.length, 0);
    assert.deepEqual(prisma.calls.delete, [
      { userId_stickerId: { userId: "u1", stickerId: "ck123" } },
    ]);
    assert.deepEqual(await res.json(), {
      liked: false,
      likes: 3,
      sticker: { id: "ck123", slug: "set-a" },
    });
  });

  it("treats a P2002 race on create as liked, not an error", async () => {
    const prisma = mockPrismaLikes({ liked: false, baseCount: 3, createError: "P2002" });
    const res = mockRes();
    await likeHandler(
      mockReq({ method: "POST", url: "/api/stickers/set-a/like" }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), {
      liked: true,
      likes: 4,
      sticker: { id: "ck123", slug: "set-a" },
    });
  });

  it("likes an individual sticker id (<set>-NN) the same way as a set", async () => {
    const prisma = mockPrismaLikes({
      sticker: { id: "ck999", slug: "set-a-03" },
      liked: false,
      baseCount: 0,
    });
    const res = mockRes();
    await likeHandler(
      mockReq({ method: "POST", url: "/api/stickers/set-a-03/like" }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.create, [{ userId: "u1", stickerId: "ck999" }]);
    assert.deepEqual(await res.json(), {
      liked: true,
      likes: 1,
      sticker: { id: "ck999", slug: "set-a-03" },
    });
  });

  it("answers 405 for other methods", async () => {
    const res = mockRes();
    await likeHandler(
      mockReq({ method: "DELETE", url: "/api/stickers/set-a/like" }),
      res,
      { prisma: mockPrismaLikes(), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 405);
  });
});
