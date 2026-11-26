// Shared comment helpers: server-side sanitising and the public
// shape returned by the comment endpoints.
//
// Sanitising follows the existing /api/engage precedent: strip
// < and > on write. That is NOT the XSS defence — the client
// escapes comment content again at render (app.js esc()), and
// stored text is never pre-escaped (which would double-escape).
"use strict";

/** Strip < and > (engage.js parity — see above). */
function cleanContent(content) {
  return content.replace(/[<>]/g, "");
}

/** The author block, preferring the custom avatar over Google's. */
function publicAuthor(user) {
  return {
    id: user.id,
    name: user.name,
    image: user.image,
    customAvatar: user.profile ? user.profile.customAvatar : null,
  };
}

/**
 * Public shape of a comment row (with nested 1-level replies).
 * `createdAt`/`updatedAt` serialise to ISO strings via JSON.
 */
function publicComment(c) {
  return {
    id: c.id,
    content: c.content,
    user: publicAuthor(c.user),
    parentId: c.parentId,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
    replies: (c.replies || []).map(publicComment),
  };
}

/** Prisma include for a comment row's author (with profile). */
const authorInclude = {
  user: {
    select: {
      id: true,
      name: true,
      image: true,
      profile: { select: { customAvatar: true } },
    },
  },
};

module.exports = { cleanContent, publicAuthor, publicComment, authorInclude };
