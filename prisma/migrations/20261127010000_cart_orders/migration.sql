-- A cart checkout pays for several items in one Stripe session, so
-- one session id now owns one Order row per item. Drop the
-- single-column unique on stripeSessionId and replace it with the
-- (session, item) pair. Existing orders have distinct session ids,
-- so the new constraint cannot conflict.
ALTER TABLE "Order" DROP CONSTRAINT "Order_stripeSessionId_key";

-- CreateIndex
CREATE UNIQUE INDEX "Order_stripeSessionId_itemId_key" ON "Order"("stripeSessionId", "itemId");

-- CreateIndex
CREATE INDEX "Order_stripeSessionId_idx" ON "Order"("stripeSessionId");
