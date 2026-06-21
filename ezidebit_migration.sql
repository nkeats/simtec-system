-- Run this in Supabase SQL Editor before deploying the import function

-- 1. Unique Ezidebit reference per order (entered manually for now)
ALTER TABLE orders ADD COLUMN IF NOT EXISTS ezidebit_id text;
CREATE INDEX IF NOT EXISTS idx_orders_ezidebit_id ON orders(ezidebit_id);

-- 2. Extra columns on payments to hold full settlement detail
ALTER TABLE payments ADD COLUMN IF NOT EXISTS fee numeric;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS amount_cleared numeric;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS failed_reason text;
ALTER TABLE payments ADD COLUMN IF NOT EXISTS source text DEFAULT 'manual_import';
-- source will be 'manual_import' (PDF upload) for now, 'webhook' once Ezidebit API is live

-- 3. Prevent the same settlement row being imported twice
-- (same order + same transaction date + same amount = treat as duplicate)
CREATE UNIQUE INDEX IF NOT EXISTS idx_payments_dedupe
  ON payments(order_id, due_date, amount)
  WHERE order_id IS NOT NULL;
