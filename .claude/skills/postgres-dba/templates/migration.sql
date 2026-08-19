-- Migration skeleton. One transaction, reversible by design, function
-- changes are full CREATE OR REPLACE (Rule 7). Name files so order is
-- unambiguous: NNNN_verb_noun.sql  e.g. 0007_add_orders_status_index.sql

-- ============================================================================
-- UP
-- ============================================================================
BEGIN;

-- DDL is transactional in Postgres: a failure here rolls the whole thing
-- back. Keep one migration to one coherent change.

-- Enum value adds are special: they cannot be used in the SAME transaction
-- that adds them (and historically can't run inside a txn block at all).
-- If this migration adds an enum value AND uses it, split into two files.
-- ALTER TYPE order_status ADD VALUE 'returned';   -- own migration if used below

-- Schema change example: additive and safe.
ALTER TABLE orders
  ADD COLUMN cancelled_reason text;

-- Backfill with a set-based statement, never a row loop.
UPDATE orders
SET    cancelled_reason = 'legacy: unknown'
WHERE  status = 'cancelled' AND cancelled_reason IS NULL;

-- Functions are versioned here, not edited in place in production.
CREATE OR REPLACE FUNCTION cancel_order(p_order_id int, p_reason text)
RETURNS void
LANGUAGE plpgsql
VOLATILE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
  IF p_reason IS NULL OR length(trim(p_reason)) = 0 THEN
    RAISE EXCEPTION 'cancel_order: reason is required'
      USING errcode = 'check_violation';
  END IF;

  UPDATE orders
  SET    status = 'cancelled',
         cancelled_reason = p_reason,
         updated_at = now()
  WHERE  id = p_order_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'cancel_order: order % not found', p_order_id
      USING errcode = 'no_data_found';
  END IF;
END;
$$;

COMMIT;

-- ============================================================================
-- DOWN  (keep it; an irreversible migration is a decision, not a default)
-- ============================================================================
-- BEGIN;
--   DROP FUNCTION IF EXISTS cancel_order(int, text);
--   ALTER TABLE orders DROP COLUMN IF EXISTS cancelled_reason;
--   -- Note: a removed enum value cannot be restored by DROP; see enums.md
--   -- for the new-type-and-swap recipe if a value rollback is ever needed.
-- COMMIT;
