-- A cart checkout pays for several items in one Stripe session, so
-- one session id now owns one Order row per item. Drop the
-- single-column unique index and replace it with the (session, item)
-- pair. (Prisma created the old one as a UNIQUE INDEX, not a
-- constraint — DROP CONSTRAINT fails on it, which is what the first
-- deploy of this migration hit.)
DROP INDEX IF EXISTS "Order_stripeSessionId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripeSessionId_itemId_key" ON "Order"("stripeSessionId", "itemId");

-- CreateIndex
CREATE INDEX "Order_stripeSessionId_idx" ON "Order"("stripeSessionId");
