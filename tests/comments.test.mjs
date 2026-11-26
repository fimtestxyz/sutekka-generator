// Comments handler tests (mocked Prisma + session).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import commentsHandler from "../api/stickers/[id]/comments.js";
import commentHandler from "../api/comments/[id].js";
import { resetRateLimits } from "../api/_lib/rate-limit.js";
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

beforeEach(() => {
  setAuthEnv();
  resetRateLimits();
});
afterEach(() => restoreEnv());

function author(id = "u1", name = "Test") {
  return { id, name, image: null, profile: null };
}

function commentRow(overrides = {}) {
  return {
    id: "c1",
    content: "hello",
    userId: "u1",
    stickerId: "ck123",
    parentId: null,
    createdAt: "2026-11-26T00:00:00.000Z",
    updatedAt: "2026-11-26T00:00:00.000Z",
    user: author(),
    replies: [],
    ...overrides,
  };
}

function mockPrismaComments({ sticker = STICKER, topComments = [], parent = null, comment = null } = {}) {
  const calls = { create: [], update: [], delete: [] };
  return {
    calls,
    sticker: { findFirst: async () => sticker },
    comment: {
      findMany: async () => topComments,
      findUnique: async ({ where }) => {
        if (parent && where.id === parent.id) return parent;
        if (comment && where.id === comment.id) return comment;
        return null;
      },
      create: async ({ data }) => {
        calls.create.push(data);
        return commentRow({ id: "c-new", ...data, user: author(data.userId), replies: [] });
      },
      update: async ({ where, data }) => {
        calls.update.push({ where, data });
        return commentRow({ ...comment, ...data });
      },
      delete: async ({ where }) => {
        calls.delete.push(where);
        return comment;
      },
    },
  };
}

describe("GET /api/stickers/[id]/comments", () => {
  it("returns top-level comments with nested replies and author info", async () => {
    const reply = commentRow({
      id: "c2",
      parentId: "c1",
      content: "a reply",
      user: author("u2", "Other"),
    });
    const res = mockRes();
    await commentsHandler(mockReq({ url: "/api/stickers/set-a/comments" }), res, {
      prisma: mockPrismaComments({
        topComments: [commentRow({ replies: [reply] })],
      }),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(res.statusCode, 200);
    const body = await res.json();
    assert.equal(body.comments.length, 1);
    assert.equal(body.comments[0].content, "hello");
    assert.deepEqual(body.comments[0].user, {
      id: "u1",
      name: "Test",
      image: null,
      customAvatar: null,
    });
    assert.equal(body.comments[0].replies.length, 1);
    assert.equal(body.comments[0].replies[0].content, "a reply");
    assert.equal(body.comments[0].replies[0].user.name, "Other");
  });

  it("answers 404 for an unknown sticker and 503 without a DB", async () => {
    const notFound = mockRes();
    await commentsHandler(mockReq({ url: "/api/stickers/nope/comments" }), notFound, {
      prisma: mockPrismaComments({ sticker: null }),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(notFound.statusCode, 404);

    clearAuthEnv();
    const noDb = mockRes();
    await commentsHandler(mockReq({ url: "/api/stickers/set-a/comments" }), noDb, {
      prisma: mockPrismaComments(),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(noDb.statusCode, 503);
  });
});

describe("POST /api/stickers/[id]/comments", () => {
  it("answers 401 when signed out", async () => {
    const res = mockRes();
    await commentsHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/comments",
        body: JSON.stringify({ content: "hi" }),
      }),
      res,
      { prisma: mockPrismaComments(), sessionDeps: noSessionDeps() },
    );
    assert.equal(res.statusCode, 401);
  });

  it("rejects empty and over-long content", async () => {
    for (const content of ["   ", "x".repeat(1001)]) {
      const res = mockRes();
      await commentsHandler(
        mockReq({
          method: "POST",
          url: "/api/stickers/set-a/comments",
          body: JSON.stringify({ content }),
        }),
        res,
        { prisma: mockPrismaComments(), sessionDeps: sessionDepsFor("u1") },
      );
      assert.equal(res.statusCode, 400);
      assert.equal((await res.json()).error, "invalid_body");
    }
  });

  it("creates a top-level comment, stripping < >", async () => {
    const prisma = mockPrismaComments();
    const res = mockRes();
    await commentsHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/comments",
        body: JSON.stringify({ content: "a < b > c" }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 201);
    assert.deepEqual(prisma.calls.create, [
      { userId: "u1", stickerId: "ck123", parentId: null, content: "a  b  c" },
    ]);
    const body = await res.json();
    assert.equal(body.comment.content, "a  b  c");
    assert.equal(body.comment.user.id, "u1");
  });

  it("creates a reply when parentId is a top-level comment on this sticker", async () => {
    const prisma = mockPrismaComments({ parent: commentRow({ id: "p1" }) });
    const res = mockRes();
    await commentsHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/comments",
        body: JSON.stringify({ content: "reply", parentId: "p1" }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 201);
    assert.equal(prisma.calls.create[0].parentId, "p1");
  });

  it("rejects a reply to a reply, a missing parent and a parent on another sticker", async () => {
    const cases = [
      { parent: commentRow({ id: "p1", parentId: "c0" }), body: { content: "x", parentId: "p1" } },
      { parent: null, body: { content: "x", parentId: "p1" } },
      {
        parent: commentRow({ id: "p1", stickerId: "other-sticker" }),
        body: { content: "x", parentId: "p1" },
      },
    ];
    for (const c of cases) {
      const res = mockRes();
      await commentsHandler(
        mockReq({
          method: "POST",
          url: "/api/stickers/set-a/comments",
          body: JSON.stringify(c.body),
        }),
        res,
        { prisma: mockPrismaComments({ parent: c.parent }), sessionDeps: sessionDepsFor("u1") },
      );
      assert.equal(res.statusCode, 400);
    }
  });

  it("rate-limits to 10 comments per minute per user", async () => {
    const prisma = mockPrismaComments();
    const statuses = [];
    for (let i = 0; i < 11; i++) {
      const res = mockRes();
      await commentsHandler(
        mockReq({
          method: "POST",
          url: "/api/stickers/set-a/comments",
          body: JSON.stringify({ content: `comment ${i}` }),
        }),
        res,
        { prisma, sessionDeps: sessionDepsFor("u1") },
      );
      statuses.push(res.statusCode);
    }
    assert.deepEqual(statuses, [201, 201, 201, 201, 201, 201, 201, 201, 201, 201, 429]);
    const last = mockRes();
    await commentsHandler(
      mockReq({
        method: "POST",
        url: "/api/stickers/set-a/comments",
        body: JSON.stringify({ content: "one more" }),
      }),
      last,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.deepEqual(await last.json(), { error: "rate_limited" });
  });
});

describe("PATCH /api/comments/[id]", () => {
  it("answers 401 signed out, 404 unknown, 403 not the author", async () => {
    const mine = commentRow({ id: "c1", userId: "u1" });
    const theirs = commentRow({ id: "c1", userId: "u2" });

    const signedOut = mockRes();
    await commentHandler(
      mockReq({ method: "PATCH", url: "/api/comments/c1", body: JSON.stringify({ content: "x" }) }),
      signedOut,
      { prisma: mockPrismaComments({ comment: mine }), sessionDeps: noSessionDeps() },
    );
    assert.equal(signedOut.statusCode, 401);

    const missing = mockRes();
    await commentHandler(
      mockReq({ method: "PATCH", url: "/api/comments/nope", body: JSON.stringify({ content: "x" }) }),
      missing,
      { prisma: mockPrismaComments({ comment: null }), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(missing.statusCode, 404);

    const forbidden = mockRes();
    await commentHandler(
      mockReq({ method: "PATCH", url: "/api/comments/c1", body: JSON.stringify({ content: "x" }) }),
      forbidden,
      { prisma: mockPrismaComments({ comment: theirs }), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(forbidden.statusCode, 403);
  });

  it("updates the author's own comment and returns it", async () => {
    const prisma = mockPrismaComments({ comment: commentRow({ id: "c1", userId: "u1" }) });
    const res = mockRes();
    await commentHandler(
      mockReq({
        method: "PATCH",
        url: "/api/comments/c1",
        body: JSON.stringify({ content: "edited <b>text</b>" }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.update, [{ where: { id: "c1" }, data: { content: "edited btext/b" } }]);
    assert.equal((await res.json()).comment.content, "edited btext/b");
  });
});

describe("DELETE /api/comments/[id]", () => {
  it("deletes the author's own comment", async () => {
    const prisma = mockPrismaComments({ comment: commentRow({ id: "c1", userId: "u1" }) });
    const res = mockRes();
    await commentHandler(mockReq({ method: "DELETE", url: "/api/comments/c1" }), res, {
      prisma,
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), { ok: true });
    assert.deepEqual(prisma.calls.delete, [{ id: "c1" }]);
  });

  it("answers 403 when the comment belongs to someone else", async () => {
    const res = mockRes();
    await commentHandler(mockReq({ method: "DELETE", url: "/api/comments/c1" }), res, {
      prisma: mockPrismaComments({ comment: commentRow({ id: "c1", userId: "u2" }) }),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 403);
  });
});
