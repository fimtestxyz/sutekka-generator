// Security tests (Phase 7): a client-sent userId must never
// decide who a mutation acts as — the session user always wins —
// and comment content is stored raw (escaped only at render).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import profileHandler from "../api/me/profile.js";
import preferencesHandler from "../api/me/preferences.js";
import commentsHandler from "../api/stickers/[id]/comments.js";
import likeHandler from "../api/stickers/[id]/like.js";
import bookmarksHandler from "../api/me/bookmarks.js";
import { resetRateLimits } from "../api/_lib/rate-limit.js";
import {
  setAuthEnv,
  restoreEnv,
  sessionDepsFor,
  mockReq,
  mockRes,
} from "./helpers.mjs";

beforeEach(() => {
  setAuthEnv();
  resetRateLimits();
});
afterEach(() => restoreEnv());

const SESSION = sessionDepsFor("u1");

describe("never trust a client-sent userId", () => {
  it("a comment posted with userId=victim is stored as the session user", async () => {
    const calls = [];
    const prisma = {
      sticker: { findFirst: async () => ({ id: "ck123", slug: "set-a" }) },
      comment: {
        create: async ({ data }) => {
          calls.push(data);
          return {
            id: "c-new",
            ...data,
            createdAt: "2026-11-26T00:00:00.000Z",
            updatedAt: "2026-11-26T00:00:00.000Z",
            user: { id: "u1", name: "Test", image: null, profile: null },
            replies: [],
          };
        },
      },
    };
    const res = mockRes();
    await commentsHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/comments",
        body: JSON.stringify({ content: "hi", userId: "victim" }),
      }),
      res,
      { prisma, sessionDeps: SESSION },
    );
    assert.equal(res.statusCode, 201);
    assert.equal(calls[0].userId, "u1");
  });

  it("a profile PATCH with userId=victim updates only the session user", async () => {
    const calls = [];
    const prisma = {
      user: {
        findUnique: async () => ({ id: "u1", email: "t@example.com", name: "Test", image: null }),
        update: async ({ where, data }) => {
          calls.push({ where, data });
          return { id: "u1", email: "t@example.com", name: data.name, image: null };
        },
      },
      userProfile: { findUnique: async () => null },
    };
    const res = mockRes();
    await profileHandler(
      mockReq({
        method: "PATCH",
        url: "/api/me/profile",
        body: JSON.stringify({ name: "New", userId: "victim" }),
      }),
      res,
      { prisma, sessionDeps: SESSION },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [{ where: { id: "u1" }, data: { name: "New" } }]);
  });

  it("a bookmark POST with userId=victim is stored as the session user", async () => {
    const calls = [];
    const prisma = {
      sticker: { findFirst: async () => ({ id: "ck123", slug: "set-a" }) },
      bookmark: {
        create: async ({ data }) => {
          calls.push(data);
          return {
            id: "bm-new",
            ...data,
            createdAt: "2026-11-26T00:00:00.000Z",
            sticker: { id: "ck123", slug: "set-a", title: "Set A", imageUrl: "/x.png" },
          };
        },
      },
    };
    const res = mockRes();
    await bookmarksHandler(
      mockReq({
        method: "POST",
        url: "/api/me/bookmarks",
        body: JSON.stringify({ stickerId: "set-a", userId: "victim" }),
      }),
      res,
      { prisma, sessionDeps: SESSION },
    );
    assert.equal(res.statusCode, 201);
    assert.deepEqual(calls, [{ userId: "u1", stickerId: "ck123" }]);
  });

  it("a like POST ignores any body userId", async () => {
    const calls = [];
    const prisma = {
      sticker: { findFirst: async () => ({ id: "ck123", slug: "set-a" }) },
      like: {
        findUnique: async () => null,
        create: async ({ data }) => {
          calls.push(data);
          return { id: "lk1" };
        },
        delete: async () => ({}),
        count: async () => 1,
      },
    };
    const res = mockRes();
    await likeHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/like",
        body: JSON.stringify({ userId: "victim" }),
      }),
      res,
      { prisma, sessionDeps: SESSION },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls, [{ userId: "u1", stickerId: "ck123" }]);
  });

  it("preferences PUT with userId=victim stores under the session user", async () => {
    const calls = [];
    const prisma = {
      userPreference: {
        deleteMany: () => Promise.resolve({ count: 0 }),
        createMany: (args) => {
          calls.push(args);
          return Promise.resolve({ count: args.data.length });
        },
      },
      $transaction: async (ops) => Promise.all(ops),
    };
    const res = mockRes();
    await preferencesHandler(
      mockReq({
        method: "PUT",
        url: "/api/me/preferences",
        body: JSON.stringify({ keywords: [{ keyword: "AI" }], userId: "victim" }),
      }),
      res,
      { prisma, sessionDeps: SESSION },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(calls[0].data, [{ userId: "u1", keyword: "AI", weight: 1 }]);
  });
});

describe("comment content is stored raw, escaped at render", () => {
  it("the API returns the raw & (the client esc() escapes it on render)", async () => {
    const prisma = {
      sticker: { findFirst: async () => ({ id: "ck123", slug: "set-a" }) },
      comment: {
        create: async ({ data }) => ({
          id: "c-new",
          ...data,
          createdAt: "2026-11-26T00:00:00.000Z",
          updatedAt: "2026-11-26T00:00:00.000Z",
          user: { id: "u1", name: "Test", image: null, profile: null },
          replies: [],
        }),
      },
    };
    const res = mockRes();
    await commentsHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/comments",
        body: JSON.stringify({ content: "fish & chips" }),
      }),
      res,
      { prisma, sessionDeps: SESSION },
    );
    assert.equal(res.statusCode, 201);
    // Raw & in the API response — NOT &amp;. Escaping happens at
    // render (web_app/app.js commentHtml uses esc()).
    assert.equal((await res.json()).comment.content, "fish & chips");
  });
});
