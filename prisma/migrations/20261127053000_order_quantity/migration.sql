-- Cart lines can now carry a quantity (DCHToons-style steppers,
-- CART.md v1.2): one Order row per cart line, amountTotal = unit
-- price x quantity. Existing rows are all quantity 1.
ALTER TABLE "Order" ADD COLUMN "quantity" INTEGER NOT NULL DEFAULT 1;
