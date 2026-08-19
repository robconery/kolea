-- House-style plpgsql function. Rule 7: set-based data logic lives here,
-- versioned by migration via CREATE OR REPLACE, plpgsql only.
--
-- Contract is fully explicit: language, volatility, security, search_path.
-- Args are validated first and rejected loudly so EVERY caller, in every
-- language, gets the same enforced rule. Body is set-based, not a row loop.

CREATE OR REPLACE FUNCTION place_order(
  p_customer_id int,
  p_items       jsonb              -- [{ "product_id": 1, "quantity": 2 }, ...]
) RETURNS int
LANGUAGE plpgsql
VOLATILE                            -- it writes; declare it honestly
SECURITY INVOKER                    -- DEFINER only with a written reason
SET search_path = public, pg_temp   -- pin it; never trust the caller's path
AS $$
DECLARE
  v_order_id int;
BEGIN
  ---------------------------------------------------------------------------
  -- 1. validate the contract; fail specific, with a sqlstate
  ---------------------------------------------------------------------------
  IF p_customer_id IS NULL THEN
    RAISE EXCEPTION 'place_order: customer_id is required'
      USING errcode = 'check_violation';
  END IF;

  IF jsonb_array_length(coalesce(p_items, '[]'::jsonb)) = 0 THEN
    RAISE EXCEPTION 'place_order: at least one item is required'
      USING errcode = 'check_violation';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM customers WHERE id = p_customer_id) THEN
    RAISE EXCEPTION 'place_order: customer % not found', p_customer_id
      USING errcode = 'foreign_key_violation';
  END IF;

  ---------------------------------------------------------------------------
  -- 2. do the work as a SET, not a FOR ... LOOP of single-row inserts
  ---------------------------------------------------------------------------
  INSERT INTO orders (customer_id)
  VALUES (p_customer_id)
  RETURNING id INTO v_order_id;

  INSERT INTO order_items (order_id, product_id, quantity, unit_cents)
  SELECT v_order_id,
         (i->>'product_id')::int,
         (i->>'quantity')::int,
         p.price_cents
  FROM   jsonb_array_elements(p_items) AS i
  JOIN   products p ON p.id = (i->>'product_id')::int;

  RETURN v_order_id;
END;
$$;

-- Rule 7 corollary: the function is the front door, constraints are the
-- walls. The CHECKs / FKs / generated column in schema.sql still hold even
-- if a backfill or a psql session bypasses this function entirely.
