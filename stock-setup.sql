-- ============================================================================
--  Simtec — Stock / Inventory
--  Adds a running stock count: opening figures (as of today) + stock received
--  and manual adjustments, minus items on delivered orders.
--
--    on hand = opening_qty + Σ(movements) − Σ(delivered items since as_of)
--
--  Run this in the Supabase SQL editor. It is idempotent — safe to run again
--  (re-running will NOT overwrite opening figures you've since corrected).
-- ============================================================================

-- 0) A precise "delivered at" timestamp on the order --------------------------
-- delivery_date holds the *booked* date, which is set at booking time and may be
-- earlier than when the goods actually left. Stock must decrement on the real
-- delivery moment, so we stamp delivered_at when an order is marked delivered.
-- (delivery.html sets this going forward; historical deliveries stay NULL and are
--  treated as already reflected in the opening figures below.)
alter table public.sim_orders add column if not exists delivered_at timestamptz;
comment on column public.sim_orders.delivered_at is 'When the order was marked delivered (stock decrements against this).';

-- 1) Tracked stock items + opening balances ----------------------------------
create table if not exists public.sim_stock_items (
  product_name text primary key,
  category     text not null,                 -- 'mattress' | 'base' | 'protector'
  opening_qty  integer not null default 0,
  as_of        date    not null,              -- the date the opening count was taken
  sort         integer not null default 0,
  active       boolean not null default true
);
comment on table public.sim_stock_items is 'Tracked stock SKUs with the opening physical count taken on as_of.';

-- Seed opening figures (as of 2026-07-21). on conflict do nothing => a re-run
-- never clobbers an opening_qty you have since adjusted.
insert into public.sim_stock_items (product_name, category, opening_qty, as_of, sort) values
  ('Mk I King Single',        'mattress',  20, '2026-07-21',  1),
  ('Mk I Queen',              'mattress',  78, '2026-07-21',  2),
  ('Mk I Super King',         'mattress',  31, '2026-07-21',  3),
  ('Mk II King Single',       'mattress',   0, '2026-07-21',  4),
  ('Mk II Queen',             'mattress',  91, '2026-07-21',  5),
  ('Mk II Super King',        'mattress',  47, '2026-07-21',  6),
  ('Mk III King Single',      'mattress',  19, '2026-07-21',  7),
  ('Mk III Queen',            'mattress', 287, '2026-07-21',  8),
  ('Mk III Super King',       'mattress', 206, '2026-07-21',  9),
  ('Mk III California King',  'mattress',  27, '2026-07-21', 10),
  ('King Single Bed Base',    'base',      43, '2026-07-21', 11),
  ('Queen Bed Base',          'base',      37, '2026-07-21', 12),
  ('Super King Bed Base',     'base',      27, '2026-07-21', 13),
  ('California King Bed Base', 'base',      22, '2026-07-21', 14),
  ('King Single Protector',   'protector', 57, '2026-07-21', 15),
  ('Queen Protector',         'protector', 384,'2026-07-21', 16),
  ('Super King Protector',    'protector', 254,'2026-07-21', 17),
  ('California King Protector','protector', 186,'2026-07-21', 18),
  ('Pillow',                   'pillow',      0, '2026-07-21', 19)   -- opening count TBC; set via the Adjust button or update opening_qty
on conflict (product_name) do nothing;

-- 2) Stock movements ledger (received / adjustments) --------------------------
-- Positive qty = stock in (a batch received, a return). Negative qty = stock out
-- that is NOT a delivery (damage, write-off, stocktake correction down).
-- Deliveries are NOT recorded here — they are derived live from delivered orders.
create table if not exists public.sim_stock_movements (
  id           uuid primary key default gen_random_uuid(),
  product_name text not null references public.sim_stock_items(product_name),
  qty          integer not null,              -- + in, − out
  reason       text not null default 'received',  -- 'received' | 'adjustment'
  note         text,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_sim_stock_movements_product on public.sim_stock_movements (product_name);
create index if not exists idx_sim_stock_movements_created on public.sim_stock_movements (created_at desc);
comment on table public.sim_stock_movements is 'Stock in / manual adjustments. Deliveries are derived from sim_orders, not stored here.';

-- 3) RLS (matches the current system posture: authenticated users have access;
--    the stock page itself is gated to admin/manager/office via auth.js) -------
alter table public.sim_stock_items     enable row level security;
alter table public.sim_stock_movements enable row level security;

drop policy if exists sim_stock_items_rw on public.sim_stock_items;
create policy sim_stock_items_rw on public.sim_stock_items
  for all to authenticated using (true) with check (true);

drop policy if exists sim_stock_movements_rw on public.sim_stock_movements;
create policy sim_stock_movements_rw on public.sim_stock_movements
  for all to authenticated using (true) with check (true);

-- ============================================================================
--  Done. Open stock.html. On hand = opening + received/adjustments − delivered
--  (delivered counted from as_of via sim_orders.delivered_at).
-- ============================================================================
