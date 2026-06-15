-- ============================================================
-- Migration 001: Offline PWA Support + Platform Admin Seed
-- Run in Supabase SQL Editor (Dashboard → SQL Editor → New query)
-- Execute each section independently if needed.
--
-- VERIFY FIRST: Run the schema introspection queries from the
-- build notes to confirm exact table/column names before executing.
-- The fee_payments FK column is assumed to be "fee_id" based on
-- the record_fee_payment RPC parameter name p_fee_id. Adjust if
-- your schema uses a different column name (e.g. fee_record_id).
-- ============================================================


-- ─────────────────────────────────────────────────────────────
-- SECTION 1: fee_payments idempotency column
-- Allows offline sync to re-submit payments without doubling them.
-- Each offline payment gets a client_id UUID; ON CONFLICT skips dupes.
-- ─────────────────────────────────────────────────────────────

ALTER TABLE fee_payments
  ADD COLUMN IF NOT EXISTS client_id UUID;

-- Unique constraint (separate statement so IF EXISTS logic works cleanly)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'fee_payments_client_id_key'
  ) THEN
    ALTER TABLE fee_payments ADD CONSTRAINT fee_payments_client_id_key UNIQUE (client_id);
  END IF;
END;
$$;


-- ─────────────────────────────────────────────────────────────
-- SECTION 2: Derived fee totals trigger
-- Makes fee_records.amount_paid + status always equal to the
-- SUM of fee_payments.amount. This is idempotent-safe: syncing
-- the same fee_payment rows twice (via offline queue) gives the
-- same result because SUM is recomputed from scratch each time.
--
-- Assumes:
--   fee_payments.fee_record_id  → FK to fee_records.id  (verified against live schema)
--   fee_records.amount_due, fee_records.amount_paid, fee_records.status
--   fee_status enum: 'unpaid', 'partial', 'paid'
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION recompute_fee_record_totals()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_fee_record_id UUID;
  v_total         NUMERIC;
  v_amount_due    NUMERIC;
  v_new_status    fee_status;
BEGIN
  v_fee_record_id := COALESCE(NEW.fee_record_id, OLD.fee_record_id);

  SELECT COALESCE(SUM(amount), 0)
  INTO   v_total
  FROM   fee_payments
  WHERE  fee_record_id = v_fee_record_id;

  SELECT amount_due
  INTO   v_amount_due
  FROM   fee_records
  WHERE  id = v_fee_record_id;

  IF v_total <= 0 THEN
    v_new_status := 'unpaid';
  ELSIF v_total >= v_amount_due THEN
    v_new_status := 'paid';
  ELSE
    v_new_status := 'partial';
  END IF;

  UPDATE fee_records
  SET    amount_paid = v_total,
         status      = v_new_status
  WHERE  id = v_fee_record_id;

  RETURN COALESCE(NEW, OLD);
END;
$$;

DROP TRIGGER IF EXISTS trg_fee_totals ON fee_payments;
CREATE TRIGGER trg_fee_totals
  AFTER INSERT OR UPDATE OR DELETE ON fee_payments
  FOR EACH ROW EXECUTE FUNCTION recompute_fee_record_totals();


-- ─────────────────────────────────────────────────────────────
-- SECTION 3: updated_at columns for incremental sync
-- The offline pull uses updated_at > last_synced_at to fetch
-- only changed rows. Add these where missing.
-- Uses the moddatetime extension (already available in Supabase).
-- ─────────────────────────────────────────────────────────────

-- Ensure moddatetime extension is available
CREATE EXTENSION IF NOT EXISTS moddatetime;

DO $$
DECLARE
  tables TEXT[] := ARRAY['students','staff','fee_records','fee_payments',
                          'score_entries','assessments','classes','subjects',
                          'terms','academic_sessions','notification_settings'];
  t TEXT;
BEGIN
  FOREACH t IN ARRAY tables LOOP
    -- Add column if missing
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE  table_schema = 'public'
      AND    table_name   = t
      AND    column_name  = 'updated_at'
    ) THEN
      EXECUTE format('ALTER TABLE %I ADD COLUMN updated_at TIMESTAMPTZ DEFAULT now()', t);
    END IF;

    -- Add trigger if missing
    IF NOT EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE  tgname = 'set_' || t || '_updated_at'
    ) THEN
      EXECUTE format(
        'CREATE TRIGGER set_%1$s_updated_at BEFORE UPDATE ON %1$I '
        'FOR EACH ROW EXECUTE FUNCTION moddatetime(updated_at)',
        t
      );
    END IF;
  END LOOP;
END;
$$;


-- ─────────────────────────────────────────────────────────────
-- SECTION 4: sync_conflicts table
-- Logs when an offline write would overwrite a newer server record.
-- Surfaces in the platform admin audit view for manual review.
-- ─────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sync_conflicts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  school_id   UUID        NOT NULL REFERENCES schools(id) ON DELETE CASCADE,
  table_name  TEXT        NOT NULL,
  record_id   UUID        NOT NULL,
  local_data  JSONB,
  server_data JSONB,
  resolved_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ DEFAULT now()
);

ALTER TABLE sync_conflicts ENABLE ROW LEVEL SECURITY;

-- School operators see only their own conflicts
DROP POLICY IF EXISTS "sync_conflicts_own_school" ON sync_conflicts;
CREATE POLICY "sync_conflicts_own_school" ON sync_conflicts
  FOR ALL USING (school_id = get_my_school_id());

-- Platform admins see all conflicts
DROP POLICY IF EXISTS "sync_conflicts_platform_admin" ON sync_conflicts;
CREATE POLICY "sync_conflicts_platform_admin" ON sync_conflicts
  FOR ALL USING (is_platform_admin());


-- ─────────────────────────────────────────────────────────────
-- SECTION 5: get_audit_logs extension for platform admin
-- Adds an optional p_school_id parameter so platform admins can
-- search audit logs across schools. Non-admins cannot use it.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION get_audit_logs(
  p_entity    TEXT    DEFAULT NULL,
  p_action    TEXT    DEFAULT NULL,
  p_school_id UUID    DEFAULT NULL,
  p_limit     INTEGER DEFAULT 50,
  p_offset    INTEGER DEFAULT 0
)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_school_id UUID;
  v_result    JSONB;
BEGIN
  -- Platform admins can view any school; others are scoped to their own
  IF p_school_id IS NOT NULL AND is_platform_admin() THEN
    v_school_id := p_school_id;
  ELSE
    v_school_id := get_my_school_id();
  END IF;

  SELECT jsonb_build_object(
    'logs',  COALESCE(jsonb_agg(row_to_json(a.*) ORDER BY a.created_at DESC), '[]'::jsonb),
    'total', COUNT(*) OVER ()
  )
  INTO v_result
  FROM (
    SELECT al.*,
           COALESCE(u.raw_user_meta_data->>'full_name', u.email) AS user_name
    FROM   audit_logs al
    LEFT JOIN auth.users u ON u.id = al.user_id
    WHERE  al.school_id = v_school_id
    AND    (p_entity IS NULL OR al.entity_type = p_entity)
    AND    (p_action IS NULL OR al.action = p_action)
    ORDER  BY al.created_at DESC
    LIMIT  p_limit
    OFFSET p_offset
  ) a;

  RETURN COALESCE(v_result, '{"logs":[],"total":0}'::jsonb);
END;
$$;


-- ─────────────────────────────────────────────────────────────
-- SECTION 6: Platform admin seed
-- Insert studox.edu@gmail.com as the first platform admin.
-- User ID verified from auth.users.
-- ─────────────────────────────────────────────────────────────

INSERT INTO platform_admins (id)
VALUES ('6620c96d-2e14-4f64-a99b-08626f4781b9')
ON CONFLICT (id) DO NOTHING;

-- Verify: run this query to confirm (will return true for that user)
-- SELECT is_platform_admin() FROM auth.users WHERE id = '6620c96d-2e14-4f64-a99b-08626f4781b9';
--
-- Or run as that user after login:
-- SELECT is_platform_admin();


-- ─────────────────────────────────────────────────────────────
-- SECTION 7: Admin view snapshot RPC (for Support Access tab)
-- Returns a full read-only snapshot of a school for platform admin
-- "view as school" mode. Checks is_platform_admin() before allowing.
-- ─────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION admin_view_school(p_school_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_result JSONB;
BEGIN
  IF NOT is_platform_admin() THEN
    RAISE EXCEPTION 'Unauthorized: platform admin access required';
  END IF;

  SELECT jsonb_build_object(
    'school',       row_to_json(s.*),
    'stats',        (SELECT get_dashboard_stats(p_school_id)),
    'student_count',(SELECT COUNT(*) FROM students WHERE school_id = p_school_id AND status = 'active'),
    'staff_count',  (SELECT COUNT(*) FROM staff WHERE school_id = p_school_id AND status = 'active'),
    'recent_audit', (
      SELECT COALESCE(jsonb_agg(row_to_json(al.*) ORDER BY al.created_at DESC), '[]')
      FROM (
        SELECT * FROM audit_logs WHERE school_id = p_school_id
        ORDER BY created_at DESC LIMIT 20
      ) al
    )
  )
  INTO v_result
  FROM schools s
  WHERE s.id = p_school_id;

  RETURN v_result;
END;
$$;


-- ─────────────────────────────────────────────────────────────
-- POST-MIGRATION VERIFICATION QUERIES
-- Run these after applying the migration to confirm everything
-- is in place:
-- ─────────────────────────────────────────────────────────────
--
-- 1. Check fee_payments has client_id:
--    SELECT column_name FROM information_schema.columns
--    WHERE table_name='fee_payments' AND column_name='client_id';
--
-- 2. Check trigger exists:
--    SELECT tgname FROM pg_trigger WHERE tgname='trg_fee_totals';
--
-- 3. Check sync_conflicts table:
--    SELECT table_name FROM information_schema.tables
--    WHERE table_name='sync_conflicts';
--
-- 4. Check platform admin:
--    SELECT * FROM platform_admins
--    WHERE id='6620c96d-2e14-4f64-a99b-08626f4781b9';
--
-- 5. Test fee idempotency (offline sync simulation):
--    INSERT INTO fee_payments (id, fee_id, amount, client_id)
--    VALUES (gen_random_uuid(), '<fee_record_id>', 1000, '<some-uuid>');
--    -- Insert same client_id again — should be a no-op:
--    INSERT INTO fee_payments (id, fee_id, amount, client_id)
--    VALUES (gen_random_uuid(), '<fee_record_id>', 1000, '<some-uuid>')
--    ON CONFLICT (client_id) DO NOTHING;
--    -- Check fee_records.amount_paid = 1000 (not 2000):
--    SELECT amount_paid FROM fee_records WHERE id='<fee_record_id>';
--
-- ─────────────────────────────────────────────────────────────
