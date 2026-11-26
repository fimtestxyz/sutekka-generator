-- Personal gallery: one metadata row per uploaded photo. The
-- image bytes live in Vercel Blob (see api/_lib/me-photos.js) —
-- Neon stores only the URL + pathname, so deleting a photo can
-- remove the Blob object too. A few hundred bytes per row; the
-- bytes never touch this database.

-- CreateTable
CREATE TABLE "Photo" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "pathname" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Photo_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Photo_userId_createdAt_idx" ON "Photo"("userId", "createdAt");

-- AddForeignKey
ALTER TABLE "Photo" ADD CONSTRAINT "Photo_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
