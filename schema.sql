-- ================================================================
-- RENTNIX — Neon DB Complete Setup
-- Run this once in Neon SQL Editor
-- ================================================================

-- USERS
CREATE TABLE IF NOT EXISTS users (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid TEXT UNIQUE,
  name         TEXT NOT NULL DEFAULT '',
  phone        TEXT DEFAULT '',
  email        TEXT DEFAULT '',
  upi_id       TEXT,
  avatar_url   TEXT,
  created_at   TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_users_phone        ON users(phone);
CREATE INDEX IF NOT EXISTS idx_users_email        ON users(email);
CREATE INDEX IF NOT EXISTS idx_users_firebase_uid ON users(firebase_uid);

-- GROUPS
CREATE TABLE IF NOT EXISTS groups (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL,
  type        TEXT DEFAULT 'flat',
  invite_code TEXT DEFAULT '',
  created_by  TEXT DEFAULT '',
  created_at  TIMESTAMPTZ DEFAULT now()
);

-- GROUP MEMBERS
CREATE TABLE IF NOT EXISTS group_members (
  id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id  UUID REFERENCES groups(id) ON DELETE CASCADE NOT NULL,
  user_id   TEXT NOT NULL,
  name      TEXT DEFAULT '',
  phone     TEXT DEFAULT '',
  role      TEXT DEFAULT 'member',
  joined_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_gm_user  ON group_members(user_id);
CREATE INDEX IF NOT EXISTS idx_gm_group ON group_members(group_id);

-- EXPENSES
CREATE TABLE IF NOT EXISTS expenses (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id      UUID REFERENCES groups(id) ON DELETE CASCADE NOT NULL,
  title         TEXT NOT NULL,
  amount        NUMERIC NOT NULL,
  paid_by       TEXT DEFAULT '',
  paid_by_name  TEXT DEFAULT '',
  category      TEXT DEFAULT 'other',
  split_type    TEXT DEFAULT 'equal',
  splits        JSONB DEFAULT '[]',
  note          TEXT,
  date          TIMESTAMPTZ DEFAULT now(),
  is_recurring  BOOLEAN DEFAULT false,
  recurring_day TEXT,
  created_by    TEXT DEFAULT '',
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_exp_group ON expenses(group_id);

-- EXPENSE EDITS
CREATE TABLE IF NOT EXISTS expense_edits (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id         UUID REFERENCES expenses(id) ON DELETE CASCADE NOT NULL,
  edited_by_id       TEXT DEFAULT '',
  edited_by_name     TEXT DEFAULT '',
  change_description TEXT,
  previous_values    JSONB DEFAULT '{}',
  edited_at          TIMESTAMPTZ DEFAULT now()
);

-- SETTLEMENTS
CREATE TABLE IF NOT EXISTS settlements (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id       UUID REFERENCES groups(id) ON DELETE CASCADE,
  from_user_id   TEXT NOT NULL,
  to_user_id     TEXT NOT NULL,
  from_user_name TEXT DEFAULT '',
  to_user_name   TEXT DEFAULT '',
  amount         NUMERIC NOT NULL,
  status         TEXT DEFAULT 'pending',
  created_at     TIMESTAMPTZ DEFAULT now(),
  settled_at     TIMESTAMPTZ
);

-- PROPERTIES
CREATE TABLE IF NOT EXISTS properties (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  address       TEXT DEFAULT '',
  city          TEXT,
  total_rooms   INT DEFAULT 1,
  property_type TEXT DEFAULT '1 BHK',
  unit_names    JSONB DEFAULT '[]',
  created_at    TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_prop_owner ON properties(owner_id);

-- TENANTS
CREATE TABLE IF NOT EXISTS tenants (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id               UUID REFERENCES properties(id) ON DELETE CASCADE NOT NULL,
  name                      TEXT NOT NULL,
  phone                     TEXT DEFAULT '',
  email                     TEXT,
  upi_id                    TEXT,
  rent_amount               NUMERIC NOT NULL,
  security_deposit          NUMERIC DEFAULT 0,
  rent_due_day              INT DEFAULT 5,
  move_in_date              DATE NOT NULL,
  move_out_date             DATE,
  status                    TEXT DEFAULT 'active',
  room_number               TEXT,
  allocated_units           JSONB DEFAULT '[]',
  unit_count                INT DEFAULT 0,
  note                      TEXT,
  move_in_meter_reading     NUMERIC,
  electricity_rate_per_unit NUMERIC,
  current_meter_reading     NUMERIC,
  created_at                TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_tenant_prop ON tenants(property_id);

-- RENT ENTRIES
CREATE TABLE IF NOT EXISTS rent_entries (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID REFERENCES tenants(id) ON DELETE CASCADE NOT NULL,
  property_id        UUID REFERENCES properties(id) ON DELETE CASCADE,
  month              INT NOT NULL,
  year               INT NOT NULL,
  rent_amount        NUMERIC NOT NULL,
  water_bill         NUMERIC DEFAULT 0,
  electricity_bill   NUMERIC DEFAULT 0,
  maintenance_charge NUMERIC DEFAULT 0,
  other_charges      NUMERIC DEFAULT 0,
  amount_paid        NUMERIC DEFAULT 0,
  status             TEXT DEFAULT 'unpaid',
  paid_on            TIMESTAMPTZ,
  note               TEXT,
  prev_units         NUMERIC,
  curr_units         NUMERIC,
  rate_per_unit      NUMERIC,
  created_at         TIMESTAMPTZ DEFAULT now()
);

-- FLAT MEMBER DETAILS
CREATE TABLE IF NOT EXISTS flat_member_details (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id         UUID REFERENCES groups(id) ON DELETE CASCADE NOT NULL,
  user_id          TEXT NOT NULL,
  security_deposit NUMERIC DEFAULT 0,
  move_in_date     DATE,
  move_out_date    DATE,
  note             TEXT,
  created_at       TIMESTAMPTZ DEFAULT now(),
  UNIQUE(group_id, user_id)
);

-- APP CONFIG
CREATE TABLE IF NOT EXISTS app_config (
  key   TEXT PRIMARY KEY,
  value TEXT
);
INSERT INTO app_config (key, value) VALUES ('latest_version', '1.0.0')
ON CONFLICT (key) DO NOTHING;

SELECT 'Neon schema setup complete ✅' AS result;
