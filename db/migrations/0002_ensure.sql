-- Idempotentní doplnění tabulí pro persistentní databáze založené starší
-- verzí 0001_init.sql. Čerstvý in-memory svět je celé v 0001.
CREATE TABLE IF NOT EXISTS transport_routes (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id      bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id    bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    from_plot_id  bigint NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
    to_plot_id    bigint NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
    mode          text NOT NULL CHECK (mode IN ('truck','ship')),
    vehicles      integer NOT NULL CHECK (vehicles BETWEEN 1 AND 8),
    distance      integer NOT NULL CHECK (distance >= 2),
    path          jsonb NOT NULL DEFAULT '[]'::jsonb,
    fee_per_hour  numeric(20,6) NOT NULL CHECK (fee_per_hour >= 0),
    capacity_per_hour numeric(20,4) NOT NULL CHECK (capacity_per_hour > 0),
    hauled_total  numeric(20,4) NOT NULL DEFAULT 0,
    last_haul_at  timestamptz,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transport_routes_distinct CHECK (from_plot_id <> to_plot_id)
);
CREATE INDEX IF NOT EXISTS transport_routes_company_idx ON transport_routes (world_id, company_id);
CREATE UNIQUE INDEX IF NOT EXISTS transport_routes_pair_uniq
    ON transport_routes (from_plot_id, to_plot_id, mode);

-- Fáze F
ALTER TABLE companies ADD COLUMN IF NOT EXISTS xp bigint NOT NULL DEFAULT 0;
ALTER TABLE worlds ADD COLUMN IF NOT EXISTS player_company_id bigint REFERENCES companies(id) ON DELETE SET NULL;
CREATE TABLE IF NOT EXISTS company_research (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    company_id    bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    code          text NOT NULL,
    done_hours    bigint NOT NULL,
    completed_at  timestamptz,
    started_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT company_research_uniq UNIQUE (company_id, code)
);
CREATE TABLE IF NOT EXISTS contracts (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id       bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    item_id        bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    qty            numeric(20,4) NOT NULL CHECK (qty > 0),
    unit_price     numeric(24,6) NOT NULL CHECK (unit_price > 0),
    deadline_hours bigint NOT NULL,
    xp_reward      integer NOT NULL DEFAULT 0 CHECK (xp_reward >= 0),
    status         text NOT NULL DEFAULT 'open'
                   CHECK (status IN ('open','taken','done','expired')),
    company_id     bigint REFERENCES companies(id) ON DELETE SET NULL,
    taken_at       timestamptz,
    done_at        timestamptz,
    created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contracts_world_status_idx ON contracts (world_id, status);
CREATE TABLE IF NOT EXISTS loans (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id     bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id   bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    principal    numeric(24,6) NOT NULL CHECK (principal > 0),
    outstanding  numeric(24,6) NOT NULL CHECK (outstanding >= 0),
    rate_hour    numeric(10,6) NOT NULL CHECK (rate_hour >= 0),
    taken_at     timestamptz NOT NULL DEFAULT now(),
    closed_at    timestamptz
);
CREATE TABLE IF NOT EXISTS executives (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id     bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id   bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    name         text NOT NULL,
    role         text NOT NULL CHECK (role IN ('production','logistics','trade')),
    salary_hour  numeric(20,6) NOT NULL CHECK (salary_hour >= 0),
    bonus_pct    numeric(6,2) NOT NULL CHECK (bonus_pct > 0),
    hired_at     timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT executives_role_uniq UNIQUE (company_id, role)
);
CREATE TABLE IF NOT EXISTS price_history (
    id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id  bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    item_id   bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    sim_hour  bigint NOT NULL,
    mid       numeric(24,6),
    last      numeric(24,6),
    CONSTRAINT price_history_uniq UNIQUE (world_id, item_id, sim_hour)
);

CREATE TABLE IF NOT EXISTS world_events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id    bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    sim_hour    bigint NOT NULL DEFAULT 0,
    kind        text NOT NULL,
    text        text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS world_events_world_idx ON world_events (world_id, id DESC);
