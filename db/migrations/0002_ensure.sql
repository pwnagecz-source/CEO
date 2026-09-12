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
