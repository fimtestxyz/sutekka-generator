// Profile + preferences handler tests (mocked Prisma + session).
import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import profileHandler from "../api/me/profile.js";
import preferencesHandler from "../api/me/preferences.js";
import {
  setAuthEnv,
  clearAuthEnv,
  restoreEnv,
  sessionDepsFor,
  noSessionDeps,
  mockReq,
  mockRes,
} from "./helpers.mjs";

const USER = { id: "u1", email: "t@example.com", name: "Test", image: "https://img.test/a.png" };

beforeEach(() => setAuthEnv());
afterEach(() => restoreEnv());

function mockPrismaProfile({ user = USER, profile = null } = {}) {
  const calls = { userUpdate: [], profileUpsert: [], profileFind: 0 };
  return {
    calls,
    user: {
      findUnique: async () => user,
      update: async ({ where, data }) => {
        calls.userUpdate.push({ where, data });
        return { ...user, ...data };
      },
    },
    userProfile: {
      findUnique: async () => {
        calls.profileFind += 1;
        return profile;
      },
      upsert: async (args) => {
        calls.profileUpsert.push(args);
        return {
          userId: "u1",
          customAvatar:
            (args.update && args.update.customAvatar !== undefined
              ? args.update.customAvatar
              : args.create.customAvatar) ?? null,
          bio:
            (args.update && args.update.bio !== undefined ? args.update.bio : args.create.bio) ??
            null,
        };
      },
    },
  };
}

function mockPrismaPrefs({ rows = [] } = {}) {
  const calls = { deleteMany: [], createMany: [], txSizes: [] };
  return {
    calls,
    userPreference: {
      findMany: async () => rows,
      deleteMany: (args) => {
        calls.deleteMany.push(args);
        return Promise.resolve({ count: rows.length });
      },
      createMany: (args) => {
        calls.createMany.push(args);
        return Promise.resolve({ count: args.data.length });
      },
    },
    $transaction: async (ops) => {
      calls.txSizes.push(ops.length);
      return Promise.all(ops);
    },
  };
}

describe("GET /api/me/profile", () => {
  it("answers 401 when signed out", async () => {
    const res = mockRes();
    await profileHandler(mockReq({ url: "/api/me/profile" }), res, {
      prisma: mockPrismaProfile(),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(res.statusCode, 401);
    assert.deepEqual(await res.json(), { error: "unauthorized" });
  });

  it("answers 503 db_not_configured without DATABASE_URL", async () => {
    clearAuthEnv();
    const res = mockRes();
    await profileHandler(mockReq({ url: "/api/me/profile" }), res, {
      prisma: mockPrismaProfile(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(await res.json(), { error: "db_not_configured" });
  });

  it("returns the user + profile (null profile when none saved)", async () => {
    const res = mockRes();
    await profileHandler(mockReq({ url: "/api/me/profile" }), res, {
      prisma: mockPrismaProfile(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), {
      user: { id: "u1", email: "t@example.com", name: "Test", image: "https://img.test/a.png" },
      profile: null,
    });
  });

  it("answers 404 when the session user has no User row", async () => {
    const res = mockRes();
    await profileHandler(mockReq({ url: "/api/me/profile" }), res, {
      prisma: mockPrismaProfile({ user: null }),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 404);
  });

  it("answers 405 for other methods", async () => {
    const res = mockRes();
    await profileHandler(mockReq({ method: "DELETE", url: "/api/me/profile" }), res, {
      prisma: mockPrismaProfile(),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 405);
  });
});

describe("PATCH /api/me/profile", () => {
  it("rejects a bio over 280 chars and a non-https avatar", async () => {
    const res = mockRes();
    await profileHandler(
      mockReq({
        method: "PATCH",
        url: "/api/me/profile",
        body: JSON.stringify({ bio: "x".repeat(281), customAvatar: "http://img.test/a.png" }),
      }),
      res,
      { prisma: mockPrismaProfile(), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 400);
    const body = await res.json();
    assert.equal(body.error, "invalid_body");
    assert.equal(body.details.length, 2);
  });

  it("rejects malformed JSON and an empty body", async () => {
    const badJson = mockRes();
    await profileHandler(
      mockReq({ method: "PATCH", url: "/api/me/profile", body: "{nope" }),
      badJson,
      { prisma: mockPrismaProfile(), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(badJson.statusCode, 400);
    assert.deepEqual(await badJson.json(), { error: "invalid_json" });

    const empty = mockRes();
    await profileHandler(
      mockReq({ method: "PATCH", url: "/api/me/profile", body: "{}" }),
      empty,
      { prisma: mockPrismaProfile(), sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(empty.statusCode, 400);
  });

  it("updates only User.name when only a name is sent", async () => {
    const prisma = mockPrismaProfile();
    const res = mockRes();
    await profileHandler(
      mockReq({
        method: "PATCH",
        url: "/api/me/profile",
        body: JSON.stringify({ name: "  New Name " }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.userUpdate, [{ where: { id: "u1" }, data: { name: "New Name" } }]);
    assert.equal(prisma.calls.profileUpsert.length, 0);
    const body = await res.json();
    assert.equal(body.user.name, "New Name");
  });

  it("upserts the profile for bio + avatar, trims, and clears on empty", async () => {
    const prisma = mockPrismaProfile();
    const res = mockRes();
    await profileHandler(
      mockReq({
        method: "PATCH",
        url: "/api/me/profile",
        body: JSON.stringify({ bio: "  hello  ", customAvatar: "" }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.profileUpsert.length, 1);
    const upsert = prisma.calls.profileUpsert[0];
    assert.deepEqual(upsert.update, { bio: "hello", customAvatar: null });
    const body = await res.json();
    assert.deepEqual(body.profile, { customAvatar: null, bio: "hello" });
  });
});

describe("GET /api/me/preferences", () => {
  it("returns the user's weighted keywords", async () => {
    const res = mockRes();
    await preferencesHandler(mockReq({ url: "/api/me/preferences" }), res, {
      prisma: mockPrismaPrefs({
        rows: [
          { keyword: "AI", weight: 1.5 },
          { keyword: "数学", weight: 1 },
        ],
      }),
      sessionDeps: sessionDepsFor("u1"),
    });
    assert.equal(res.statusCode, 200);
    assert.deepEqual(await res.json(), {
      keywords: [
        { keyword: "AI", weight: 1.5 },
        { keyword: "数学", weight: 1 },
      ],
    });
  });

  it("answers 401 when signed out", async () => {
    const res = mockRes();
    await preferencesHandler(mockReq({ url: "/api/me/preferences" }), res, {
      prisma: mockPrismaPrefs(),
      sessionDeps: noSessionDeps(),
    });
    assert.equal(res.statusCode, 401);
  });
});

describe("PUT /api/me/preferences", () => {
  it("rejects a non-array, an over-long keyword and an out-of-range weight", async () => {
    const cases = [
      { keywords: "AI" },
      { keywords: [{ keyword: "x".repeat(41) }] },
      { keywords: [{ keyword: "AI", weight: 3 }] },
    ];
    for (const body of cases) {
      const res = mockRes();
      await preferencesHandler(
        mockReq({ method: "PUT", url: "/api/me/preferences", body: JSON.stringify(body) }),
        res,
        { prisma: mockPrismaPrefs(), sessionDeps: sessionDepsFor("u1") },
      );
      assert.equal(res.statusCode, 400);
      assert.equal((await res.json()).error, "invalid_body");
    }
  });

  it("replaces the set in one transaction, deduping and defaulting weight to 1", async () => {
    const prisma = mockPrismaPrefs();
    const res = mockRes();
    await preferencesHandler(
      mockReq({
        method: "PUT",
        url: "/api/me/preferences",
        body: JSON.stringify({
          keywords: [
            { keyword: " AI " },
            { keyword: "数学", weight: 0.5 },
            { keyword: "AI", weight: 2 },
          ],
        }),
      }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.equal(prisma.calls.txSizes.length, 1);
    assert.deepEqual(prisma.calls.deleteMany, [{ where: { userId: "u1" } }]);
    assert.equal(prisma.calls.createMany.length, 1);
    assert.deepEqual(prisma.calls.createMany[0].data, [
      { userId: "u1", keyword: "AI", weight: 2 },
      { userId: "u1", keyword: "数学", weight: 0.5 },
    ]);
    assert.deepEqual(await res.json(), {
      keywords: [
        { keyword: "AI", weight: 2 },
        { keyword: "数学", weight: 0.5 },
      ],
    });
  });

  it("an empty array clears all preferences (delete only, no create)", async () => {
    const prisma = mockPrismaPrefs();
    const res = mockRes();
    await preferencesHandler(
      mockReq({ method: "PUT", url: "/api/me/preferences", body: JSON.stringify({ keywords: [] }) }),
      res,
      { prisma, sessionDeps: sessionDepsFor("u1") },
    );
    assert.equal(res.statusCode, 200);
    assert.deepEqual(prisma.calls.txSizes, [1]);
    assert.equal(prisma.calls.createMany.length, 0);
    assert.deepEqual(await res.json(), { keywords: [] });
  });
});
