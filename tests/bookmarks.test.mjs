// Bookmarks handler tests (mocked Prisma + session).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import bookmarksHandler from "../api/_lib/me-bookmarks.js";
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
const STICKER_ROW = { id: "ck123", slug: "set-a", title: "Set A", imageUrl: "/stickers/set-a/sheet.png" };

beforeEach(() => setAuthEnv());
afterEach(() => restoreEnv());

function bookmarkRow(overrides = {}) {
  return {
    id: "bm1",
    userId: "u1",
    stickerId: "ck123",
    createdAt: "2026-11-26T00:00:00.000Z",
    sticker: STICKER_ROW,
    ...overrides,
  };
}

function mockPrismaBookmarks({ sticker = STICKER, bookmarks = [], existing = null, createError = null } = {}) {
  const calls = { findMany: [], create: [], deleteMany: [], findUnique: [] };
  return {
    calls,
    sticker: { findFirst: async () => sticker },
    bookmark: {
      findMany: async (args) => {
        calls.findMany.push(args);
        return bookmarks;
      },
      findUnique: async (args) => {
        calls.findUnique.push(args);
        return existing;
      },
      create: async ({ data }) => {
        calls.create.push(data);
        if (createError) {
          const err = /** @type {any} */ (new Error("Unique constraint failed"));
          err.code = createError;
          throw err;
        }
        return bookmarkRow({ id: "bm-new", ...data });
      },
      deleteMany: async (args) => {
        calls.deleteMany.push(args);
        return { count: 1 };
      },
    },
  };
}

describe("GET /api/me/bookmarks", () => {
  it("answers 401 when signed out and 503 without a DB", async () => {
    const signedOut = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks" }), signedOut, {
      prisma: mockPrismaBookmarks(),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(signedOut.statusCode, 401);

    clearAuthEnv();
    const noDb = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks" }), noDb, {
      prisma: mockPrismaBookmarks(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(noDb.statusCode, 503);
  });

  it("lists bookmarks with the sticker attached, defaulting to recent first", async () => {
    const prisma = mockPrismaBookmarks({ bookmarks: [bookmarkRow()] });
    const res = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks" }), res, {
      prisma,
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.findMany, [
      {
        where: { userId: "u1" },
        orderBy: { createdAt: "desc" },
        include: { sticker: { select: { id: true, slug: true, title: true, imageUrl: true } } },
      },
    ]);
    assert.deepEqual(await res.json(), {
      bookmarks: [
        { id: "bm1", createdAt: "2026-11-26T00:00:00.000Z", sticker: STICKER_ROW },
      ],
    });
  });

  it("passes sort=oldest and sort=title through, and rejects other values", async () => {
    for (const [sort, orderBy] of [
      ["oldest", { createdAt: "asc" }],
      ["title", { sticker: { title: "asc" } }],
    ]) {
      const prisma = mockPrismaBookmarks();
      const res = mockRes();
      await bookmarksHandler(mockReq({ url: `/api/me/bookmarks?sort=${sort}` }), res, {
        prisma,
        sessionDeps: sessionDepsFor("u1"),
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(prisma.calls.findMany[0].orderBy, orderBy);
    }
    const bad = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks?sort=random" }), bad, {
      prisma: mockPrismaBookmarks(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(bad.statusCode, 400);
    assert.deepEqual(await bad.json(), {
      error: "invalid_sort",
      details: ["sort must be recent, oldest or title"],
    });
  });

  it("answers the single-set state with ?stickerId", async () => {
    const yes = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks?stickerId=set-a" }), yes, {
      prisma: mockPrismaBookmarks({ existing: bookmarkRow() }),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(yes.statusCode, 200);
    assert.deepEqual(await yes.json(), {
      bookmarked: true,
      bookmark: { id: "bm1", createdAt: "2026-11-26T00:00:00.000Z", sticker: STICKER_ROW },
    });

    const no = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks?stickerId=set-a" }), no, {
      prisma: mockPrismaBookmarks({ existing: null }),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.deepEqual(await no.json(), { bookmarked: false, bookmark: null });
  });

  it("answers 404 for an unknown sticker in ?stickerId", async () => {
    const res = mockRes();
    await bookmarksHandler(mockReq({ url: "/api/me/bookmarks?stickerId=nope" }), res, {
      prisma: mockPrismaBookmarks({ sticker: null }),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 404);
  });
});

describe("POST /api/me/bookmarks", () => {
  it("creates a bookmark (201) and returns the existing one on P2002 (200)", async () => {
    const prisma = mockPrismaBookmarks();
    const created = mockRes();
    await bookmarksHandler(
      mockReq({
        method: "POST",
        url: "/api/me/bookmarks",
        body: JSON.stringify({ stickerId: "set-a" }),
      }),
      created,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(created.statusCode, 201);
    assert.deepEqual(prisma.calls.create, [{ userId: "u1", stickerId: "ck123" }]);
    assert.equal((await created.json()).bookmark.id, "bm-new");

    const raced = mockPrismaBookmarks({ createError: "P2002", existing: bookmarkRow() });
    const res = mockRes();
    await bookmarksHandler(
      mockReq({
        method: "POST",
        url: "/api/me/bookmarks",
        body: JSON.stringify({ stickerId: "set-a" }),
      }),
      res,
      { prisma: raced, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.equal((await res.json()).bookmark.id, "bm1");
  });

  it("bookmarks an individual sticker id (<set>-NN)", async () => {
    const sticker = {
      id: "ck999",
      slug: "set-a-03",
      title: "Sticker 3",
      imageUrl: "/stickers/set-a/stickers/03.png",
    };
    const prisma = mockPrismaBookmarks({ sticker });
    const res = mockRes();
    await bookmarksHandler(
      mockReq({
        method: "POST",
        url: "/api/me/bookmarks",
        body: JSON.stringify({ stickerId: "set-a-03" }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 201);
    // The endpoint resolved the sticker id to the sticker row's cuid.
    assert.deepEqual(prisma.calls.create, [{ userId: "u1", stickerId: "ck999" }]);
  });

  it("answers 401 signed out, 400 without stickerId, 404 unknown sticker", async () => {
    const signedOut = mockRes();
    await bookmarksHandler(
      mockReq({ method: "POST", url: "/api/me/bookmarks", body: JSON.stringify({ stickerId: "set-a" }) }),
      signedOut,
      { prisma: mockPrismaBookmarks(), sessionDeps: noSessionDeps() },
    );
    assert.equal(signedOut.statusCode, 401);

    const noId = mockRes();
    await bookmarksHandler(
      mockReq({ method: "POST", url: "/api/me/bookmarks", body: JSON.stringify({}) }),
      noId,
      { prisma: mockPrismaBookmarks(), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(noId.statusCode, 400);

    const unknown = mockRes();
    await bookmarksHandler(
      mockReq({ method: "POST", url: "/api/me/bookmarks", body: JSON.stringify({ stickerId: "nope" }) }),
      unknown,
      { prisma: mockPrismaBookmarks({ sticker: null }), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(unknown.statusCode, 404);
  });
});

describe("DELETE /api/me/bookmarks", () => {
  it("removes the bookmark and reports bookmarked:false", async () => {
    const prisma = mockPrismaBookmarks();
    const res = mockRes();
    await bookmarksHandler(mockReq({ method: "DELETE", url: "/api/me/bookmarks?stickerId=set-a" }), res, {
      prisma,
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { ok: true, bookmarked: false });
    assert.deepEqual(prisma.calls.deleteMany, [{ where: { userId: "u1", stickerId: "ck123" } }]);
  });

  it("answers 400 without stickerId and 401 when signed out", async () => {
    const noId = mockRes();
    await bookmarksHandler(mockReq({ method: "DELETE", url: "/api/me/bookmarks" }), noId, {
      prisma: mockPrismaBookmarks(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(noId.statusCode, 400);

    const signedOut = mockRes();
    await bookmarksHandler(
      mockReq({ method: "DELETE", url: "/api/me/bookmarks?stickerId=set-a" }),
      signedOut,
      { prisma: mockPrismaBookmarks(), sessionDeps: noSessionDeps() },
    );
    assert.equal(signedOut.statusCode, 401);
  });
});
