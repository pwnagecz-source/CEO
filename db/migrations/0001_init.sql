-- ============================================================================
--  CEO — MMO ekonomický simulátor
--  Migrace 0001: iniciální schéma
--
--  Zdroj pravdy: PostgreSQL. Redis je výhradně cache/queue, nikdy store of record.
--  Design: docs/20-datovy-model.md
--
--  TŘI NEZRUŠITELNÁ PRAVIDLA:
--   1. Peníze jsou numeric(24,6). NIKDY float/double/real.
--   2. Podvojný ledger: každý pohyb peněz = 2+ legs, jejichž součet je 0.
--      Vynuceno CONSTRAINT TRIGGEREM na úrovni databáze (ne jen v aplikaci).
--   3. world_id na všem, co je per-svět. Zpětná migrace na multi-world je peklo.
-- ============================================================================

BEGIN;

-- ŽÁDNÁ rozšíření. gen_random_uuid() je od PG13 v jádře; case-insensitive
-- unikátnost řeší funkční indexy nad lower() místo citext. Migrace tak běží na
-- ostrém Postgresu i na PGlite (embedded WASM Postgres pro vývoj/testy).

-- ============================================================================
--  1. ENUMY
-- ============================================================================

CREATE TYPE world_status AS ENUM (
    'preparing',   -- svět vzniká, dražba pozemků běží
    'active',      -- hraje se
    'ending',      -- poslední dny, uzávěrka žebříčků
    'archived'     -- sezóna skončila, řádky se nemažou (historie = obsah)
);

CREATE TYPE company_status AS ENUM ('active', 'bankrupt', 'dissolved');

CREATE TYPE plot_type AS ENUM (
    'forest',      -- deposit: Logging Camp (40 pozemků/svět)
    'mine',        -- deposit: Iron Mine, Quarry, Oil Rig (30)
    'water',       -- deposit: Grain Farm, Cotton Farm (18)
    'utility',     -- Power Plant (20)
    'industrial',  -- všechny továrny (100)
    'commercial',  -- obchody, lahůdky — bonus foot traffic (60)
    'civic',       -- rezervováno: HQ, landmarky, aukce (20)
    'road'         -- státní silniční síť: neprodejné, produkce musí být napojená
);

CREATE TYPE plot_status AS ENUM ('unowned', 'auction', 'owned', 'leased');

CREATE TYPE building_status AS ENUM (
    'construction',  -- staví se, completed_at v budoucnu
    'idle',          -- stojí, nevyrábí (žádný aktivní production order)
    'producing',     -- vyrábí
    'starved',       -- chybí vstupy
    'full',          -- výstupní sklad plný ← offline ventil, viz doc 10 §2.1
    'paused',        -- hráč pozastavil (neplatí upkeep za produkci, platí nájem)
    'disconnected',  -- Fáze D: bez silničního napojení na státní síť
    'demolishing'
);

CREATE TYPE order_side AS ENUM ('buy', 'sell');
CREATE TYPE order_type AS ENUM ('limit', 'market');

CREATE TYPE order_status AS ENUM (
    'open',       -- čeká v booku (část qty stále k dispozici)
    'partial',    -- částečně vyplněný, stále open
    'filled',     -- kompletně vyplněný
    'cancelled',  -- zrušený hráčem
    'expired',    -- vypršel (GTD)
    'rejected'    -- odmítnutý engine (nedostatek zásob/hotovosti, manipulace)
);

CREATE TYPE production_status AS ENUM (
    'queued', 'running', 'starved', 'storage_full', 'completed', 'cancelled'
);

CREATE TYPE account_owner AS ENUM ('company', 'system');

-- Účty firmy jsou AKTIVA (cash, escrow). Účty systému jsou akumulátory:
-- sink_* zachycují zničené peníze, faucet_* nově vytvořené. Díky tomu je
-- makro dashboard triviální GROUP BY a noční audit jeden dotaz.
CREATE TYPE account_kind AS ENUM (
    'cash',                  -- volná hotovost firmy
    'escrow_market',         -- zablokováno pod otevřeným buy orderem
    -- FAUCETS (vznik peněz)
    'faucet_retail',         -- od NPC zákazníků
    'faucet_state',          -- státní zakázky
    'faucet_starting_grant', -- startovní kapitál nové firmy
    -- SINKS (zánik peněz)
    'sink_exchange_fee',
    'sink_contract_tax',
    'sink_transport',
    'sink_storage_rent',
    'sink_plot_rent',
    'sink_property_tax',
    'sink_wages',
    'sink_upkeep',
    'sink_hq_overhead',
    'sink_capex',            -- stavba/upgrade budov
    'sink_demolition',
    'sink_research',
    'sink_wealth_tax',
    'sink_auction_burn',     -- 100 % spáleno ve státním tendru / sběratelské aukci
    'sink_loan_interest',
    'sink_land_purchase',    -- nákup pozemku od světa (peníze mizí z ekonomiky)
    'sink_utilities'         -- regulovaný nákup elektřiny ze státní sítě
);

CREATE TYPE money_flow AS ENUM ('faucet', 'sink', 'transfer', 'internal');

CREATE TYPE event_type AS ENUM (
    'production_complete', 'storage_full', 'inputs_starved',
    'order_filled', 'order_partial', 'order_cancelled', 'order_expired',
    'trade_executed', 'retail_sale', 'building_complete',
    'plot_acquired', 'plot_lost', 'auction_won', 'auction_outbid',
    'bankruptcy_warning', 'price_alert', 'system', 'season'
);

CREATE TYPE npc_quote_status AS ENUM ('active', 'suspended', 'retired');


-- ============================================================================
--  2. SVĚTY (sezóny) — ADR-003
-- ============================================================================

CREATE TABLE worlds (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code            text        NOT NULL UNIQUE,          -- 'cz-s01', 'eu-s02'
    name            text        NOT NULL,
    season_no       integer     NOT NULL,
    status          world_status NOT NULL DEFAULT 'preparing',
    starts_at       timestamptz,
    ends_at         timestamptz,
    plot_grid_w     smallint    NOT NULL DEFAULT 24,
    plot_grid_h     smallint    NOT NULL DEFAULT 12,
    starting_capital numeric(24,6) NOT NULL DEFAULT 25000,
    -- Fáze D: viditelný herní čas. sim_speed 0 = pauza, 1/2/4 = zrychlení.
    sim_speed       smallint    NOT NULL DEFAULT 1,
    sim_hours       numeric(20,4) NOT NULL DEFAULT 0,
    config          jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT worlds_season_positive CHECK (season_no > 0),
    CONSTRAINT worlds_grid_bounds     CHECK (plot_grid_w BETWEEN 4 AND 256
                                             AND plot_grid_h BETWEEN 4 AND 256),
    CONSTRAINT worlds_window_valid    CHECK (ends_at IS NULL OR starts_at IS NULL
                                             OR ends_at > starts_at),
    CONSTRAINT worlds_capital_positive CHECK (starting_capital >= 0),
    CONSTRAINT worlds_sim_speed_known  CHECK (sim_speed IN (0, 1, 2, 4))
);
-- `code` je globálně unikátní slug ('eu-s01'), takže (code, season_no) by bylo
-- redundantní. Místo toho index pro dotaz „nejnovější sezóna dané řady".
CREATE INDEX worlds_line_season_idx ON worlds (split_part(code, '-s', 1), season_no DESC);

COMMENT ON TABLE worlds IS
    'Řádky se NIKDY nemažou — archivovaný svět je obsah (historie cen, žebříčky, lore).';


-- ============================================================================
--  3. IDENTITA
-- ============================================================================

CREATE TABLE users (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    email           text        NOT NULL,
    password_hash   text        NOT NULL,                  -- argon2id
    display_name    text        NOT NULL,
    is_banned       boolean     NOT NULL DEFAULT false,
    is_admin        boolean     NOT NULL DEFAULT false,
    email_verified_at timestamptz,
    referral_user_id bigint     REFERENCES users(id) ON DELETE SET NULL,
    locale          text        NOT NULL DEFAULT 'en',     -- ADR-006
    settings        jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT users_no_self_referral CHECK (referral_user_id IS NULL
                                             OR referral_user_id <> id)
);
-- case-insensitive unikátnost bez citext
CREATE UNIQUE INDEX users_email_uniq        ON users (lower(email));
CREATE UNIQUE INDEX users_display_name_uniq ON users (lower(display_name));
CREATE INDEX users_last_seen_idx ON users (last_seen_at DESC);

CREATE TABLE sessions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id     bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at  timestamptz NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    ip          inet,
    user_agent  text,
    CONSTRAINT sessions_future_expiry CHECK (expires_at > created_at)
);
-- Lookup je `WHERE user_id = $1 AND expires_at > now()`. Partial index s `now()`
-- v predikátu NELZE: now() je STABLE, ne IMMUTABLE, a obsah indexu by se v čase
-- měnil (PG to odmítne chybou 42P17). Kompozitní klíč obslouží stejný dotaz
-- jako index range scan a zůstává vždy korektní.
CREATE INDEX sessions_user_idx ON sessions (user_id, expires_at DESC);
-- Prošlé sessiony maže periodický úklid, ne indexový predikát:
--   DELETE FROM sessions WHERE expires_at < now() - interval '1 day';

CREATE TABLE companies (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    user_id         bigint      NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    world_id        bigint      NOT NULL REFERENCES worlds(id) ON DELETE RESTRICT,
    name            text        NOT NULL,
    industry_id     bigint,                                -- FK přidána níže (cyklus)
    status          company_status NOT NULL DEFAULT 'active',
    prestige_level  integer     NOT NULL DEFAULT 0,        -- přenáší se mezi sezónami
    legacy_points   integer     NOT NULL DEFAULT 0,        -- přenáší se mezi sezónami
    founded_at      timestamptz NOT NULL DEFAULT now(),
    last_settled_at timestamptz NOT NULL DEFAULT now(),    -- tick engine
    logo_url        text,
    description     text,

    -- 1:N záměrně (ne 1:1), aby šel později přidat holding / více firem na účet
    CONSTRAINT companies_legacy_points_nonneg CHECK (legacy_points >= 0),
    CONSTRAINT companies_prestige_nonneg      CHECK (prestige_level >= 0)
);
-- jméno firmy je unikátní per svět, ne globálně (case-insensitive)
CREATE UNIQUE INDEX companies_world_name_uniq ON companies (world_id, lower(name));
CREATE INDEX companies_user_idx   ON companies (user_id);
CREATE INDEX companies_world_idx  ON companies (world_id) WHERE status = 'active';
CREATE INDEX companies_settle_idx ON companies (last_settled_at);


-- ============================================================================
--  4. STATICKÁ / SEED DATA
--     Načítá se ze seed/balance-v0.2.json. Za běhu světa NEMĚNNÁ — změna
--     uprostřed sezóny by rozbila order book i rozdělanou výrobu.
-- ============================================================================

CREATE TABLE industries (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code        text NOT NULL UNIQUE,        -- 'timber', 'metallurgy', 'food'
    name        text NOT NULL,
    -- bonus na budovy tohoto odvětví; drží specializaci proti vertikální integraci
    bonus_pct   numeric(5,2) NOT NULL DEFAULT 0,
    description text,
    CONSTRAINT industries_bonus_bounds CHECK (bonus_pct BETWEEN -50 AND 100)
);

ALTER TABLE companies
    ADD CONSTRAINT companies_industry_fk
    FOREIGN KEY (industry_id) REFERENCES industries(id) ON DELETE SET NULL;

CREATE TABLE items (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code         text NOT NULL UNIQUE,        -- 'log', 'planks', 'furniture'
    name         text NOT NULL,
    category     text NOT NULL,               -- 'raw','processed','component','consumer','utility'
    tier         smallint NOT NULL,           -- 0..3
    -- burzovní parametry
    base_price   numeric(24,6) NOT NULL,      -- seed z cost-plus modelu
    retail_base  numeric(24,6),               -- NULL = není retail produkt
    tick_size    numeric(24,6) NOT NULL,      -- krok ceny v order booku
    min_lot      numeric(20,4) NOT NULL DEFAULT 1,
    max_order_qty numeric(20,4) NOT NULL DEFAULT 1000000,  -- anti-cornering
    quality_tiers smallint NOT NULL DEFAULT 5,
    -- vlastnosti
    is_tradeable boolean NOT NULL DEFAULT true,
    is_spoilable boolean NOT NULL DEFAULT false,
    spoil_rate_per_day numeric(8,6) NOT NULL DEFAULT 0,
    stack_size   numeric(20,4) NOT NULL DEFAULT 1,
    volume       numeric(10,4) NOT NULL DEFAULT 1,  -- pro sklad/dopravu
    icon         text,
    CONSTRAINT items_tier_range      CHECK (tier BETWEEN 0 AND 9),
    CONSTRAINT items_price_positive  CHECK (base_price > 0),
    CONSTRAINT items_tick_positive   CHECK (tick_size > 0),
    CONSTRAINT items_lot_positive    CHECK (min_lot > 0),
    CONSTRAINT items_quality_range   CHECK (quality_tiers BETWEEN 1 AND 10),
    CONSTRAINT items_retail_consistency CHECK (
        (retail_base IS NULL) OR (retail_base > base_price)   -- retail > burza, vždy
    ),
    CONSTRAINT items_spoil_consistency CHECK (
        (NOT is_spoilable) OR (spoil_rate_per_day > 0)
    )
);
CREATE INDEX items_tier_idx ON items (tier, category);

CREATE TABLE building_types (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code              text NOT NULL UNIQUE,          -- 'sawmill'
    name              text NOT NULL,
    industry_id       bigint REFERENCES industries(id) ON DELETE SET NULL,
    required_plot_type plot_type,                    -- NULL = libovolný průmyslový
    -- hodnoty na úrovni 1 (seed z balance modelu)
    base_capex        numeric(24,6) NOT NULL,
    base_upkeep_hour  numeric(24,6) NOT NULL,
    base_throughput   numeric(20,4) NOT NULL,        -- výstupních jednotek/h
    base_storage      numeric(20,4) NOT NULL,
    base_build_seconds integer    NOT NULL,
    max_level         smallint    NOT NULL DEFAULT 5,
    -- škálování úrovní (doc 10 §3.2)
    level_throughput_mult numeric(5,3) NOT NULL DEFAULT 0.30,
    level_upkeep_mult     numeric(5,3) NOT NULL DEFAULT 0.22,
    level_storage_mult    numeric(5,3) NOT NULL DEFAULT 0.35,
    upgrade_cost_mult     numeric(5,3) NOT NULL DEFAULT 0.75,
    upgrade_cost_growth   numeric(5,3) NOT NULL DEFAULT 1.85,
    -- provoz
    base_workers      smallint    NOT NULL DEFAULT 1,
    is_retail         boolean     NOT NULL DEFAULT false,
    description       text,

    CONSTRAINT bt_capex_positive     CHECK (base_capex > 0),
    CONSTRAINT bt_upkeep_nonneg      CHECK (base_upkeep_hour >= 0),
    CONSTRAINT bt_throughput_pos     CHECK (base_throughput > 0),
    CONSTRAINT bt_storage_pos        CHECK (base_storage > 0),
    CONSTRAINT bt_build_positive     CHECK (base_build_seconds > 0),
    CONSTRAINT bt_level_range        CHECK (max_level BETWEEN 1 AND 50),
    -- údržba MUSÍ růst pomaleji než propustnost, jinak jsou upgrady trest
    CONSTRAINT bt_upkeep_slower_than_throughput CHECK (
        level_upkeep_mult < level_throughput_mult
    ),
    CONSTRAINT bt_upgrade_growth_sane CHECK (upgrade_cost_growth BETWEEN 1.0 AND 5.0)
);

COMMENT ON CONSTRAINT bt_upkeep_slower_than_throughput ON building_types IS
    'Design invariant z doc 10 §3.2: výroba má ekonomiku z rozsahu, diseconomie
     rozsahu je záměrně vytažená do korporátní režie (hq_overhead), ne do výroby.';

CREATE TABLE recipes (
    id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    code              text NOT NULL UNIQUE,
    building_type_id  bigint NOT NULL REFERENCES building_types(id) ON DELETE CASCADE,
    output_item_id    bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    output_qty        numeric(20,4) NOT NULL,      -- na jeden cyklus při L1
    quality_base      smallint NOT NULL DEFAULT 35,
    min_building_level smallint NOT NULL DEFAULT 1,
    is_active         boolean NOT NULL DEFAULT true,
    CONSTRAINT recipes_output_positive CHECK (output_qty > 0),
    CONSTRAINT recipes_quality_range   CHECK (quality_base BETWEEN 0 AND 100)
);

CREATE TABLE recipe_inputs (
    recipe_id  bigint NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    item_id    bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    qty        numeric(20,4) NOT NULL,
    PRIMARY KEY (recipe_id, item_id),
    CONSTRAINT recipe_inputs_qty_positive CHECK (qty > 0)
);

-- Recept nesmí být sám sobě vstupem (perpetuum mobile na zboží).
-- CHECK constraint v Postgresu NESMÍ obsahovat poddotaz, proto trigger.
CREATE OR REPLACE FUNCTION fn_recipe_inputs_no_self_reference() RETURNS trigger AS $$
DECLARE
    out_item bigint;
BEGIN
    SELECT r.output_item_id INTO out_item
      FROM recipes r WHERE r.id = NEW.recipe_id;
    IF out_item = NEW.item_id THEN
        RAISE EXCEPTION 'recept % nesmí mít vlastní výstup (item %) jako vstup',
            NEW.recipe_id, NEW.item_id
            USING HINT = 'Cyklus v produkčním grafu umožňuje tisknout zboží z ničeho.';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER recipe_inputs_no_self_reference
    BEFORE INSERT OR UPDATE OF item_id, recipe_id ON recipe_inputs
    FOR EACH ROW EXECUTE FUNCTION fn_recipe_inputs_no_self_reference();

COMMENT ON TRIGGER recipe_inputs_no_self_reference ON recipe_inputs IS
    'Zabraňuje cyklu v produkčním grafu — bez toho lze tisknout zboží z ničeho.';


-- ============================================================================
--  5. POZEMKY — ADR-001
-- ============================================================================

CREATE TABLE plots (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id     bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    x            smallint NOT NULL,
    y            smallint NOT NULL,
    plot_type    plot_type NOT NULL,
    status       plot_status NOT NULL DEFAULT 'unowned',
    owner_company_id bigint REFERENCES companies(id) ON DELETE SET NULL,
    -- ekonomika pozemku
    rent_per_hour numeric(24,6) NOT NULL DEFAULT 0,
    assessed_value numeric(24,6) NOT NULL DEFAULT 0,   -- základ daně z nemovitosti
    deposit_richness numeric(5,2) NOT NULL DEFAULT 1.00,  -- 0.80–1.30, násobí výnos těžby
    acquired_at  timestamptz,
    acquired_for numeric(24,6),                        -- kolik se za něj zaplatilo (audit)

    CONSTRAINT plots_coords_nonneg CHECK (x >= 0 AND y >= 0),
    CONSTRAINT plots_rent_nonneg   CHECK (rent_per_hour >= 0),
    CONSTRAINT plots_value_nonneg  CHECK (assessed_value >= 0),
    CONSTRAINT plots_richness_range CHECK (deposit_richness BETWEEN 0.50 AND 2.00),
    CONSTRAINT plots_owned_consistency CHECK (
        (status IN ('owned','leased')) = (owner_company_id IS NOT NULL)
    )
);
-- mřížka je unikátní per svět
CREATE UNIQUE INDEX plots_world_grid_uniq ON plots (world_id, x, y);
CREATE INDEX plots_owner_idx  ON plots (owner_company_id) WHERE owner_company_id IS NOT NULL;
CREATE INDEX plots_type_idx   ON plots (world_id, plot_type, status);
CREATE INDEX plots_status_idx ON plots (world_id, status) WHERE status = 'auction';

COMMENT ON TABLE plots IS
    '288 pozemků na svět (24×12). Depositní typy (forest/mine/water) jsou vzácné
     a gates těžbu — to je mechanismus, který drží specializaci (doc 10 §4.1).';

CREATE TABLE plot_auctions (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id     bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    plot_id      bigint NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
    reserve_price numeric(24,6) NOT NULL,
    starts_at    timestamptz NOT NULL,
    ends_at      timestamptz NOT NULL,
    winning_bid_id bigint,
    status       text NOT NULL DEFAULT 'open',
    CONSTRAINT pa_reserve_positive CHECK (reserve_price > 0),
    CONSTRAINT pa_window_valid     CHECK (ends_at > starts_at),
    CONSTRAINT pa_status_valid     CHECK (status IN ('open','settled','cancelled','no_bids'))
);
CREATE INDEX plot_auctions_open_idx ON plot_auctions (world_id, ends_at)
    WHERE status = 'open';

CREATE TABLE plot_bids (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    auction_id   bigint NOT NULL REFERENCES plot_auctions(id) ON DELETE CASCADE,
    company_id   bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    amount       numeric(24,6) NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT plot_bids_amount_positive CHECK (amount > 0)
);
CREATE INDEX plot_bids_auction_idx ON plot_bids (auction_id, amount DESC);

ALTER TABLE plot_auctions
    ADD CONSTRAINT pa_winning_bid_fk
    FOREIGN KEY (winning_bid_id) REFERENCES plot_bids(id) ON DELETE SET NULL;


-- ============================================================================
--  6. BUDOVY, SKLADY, INVENTÁŘ
-- ============================================================================

CREATE TABLE buildings (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id      bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id    bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plot_id       bigint NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
    type_id       bigint NOT NULL REFERENCES building_types(id) ON DELETE RESTRICT,
    level         smallint NOT NULL DEFAULT 1,
    status        building_status NOT NULL DEFAULT 'construction',
    completed_at  timestamptz,                 -- kdy dostavěno / dokončen upgrade
    last_settled_at timestamptz NOT NULL DEFAULT now(),
    created_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT buildings_level_positive CHECK (level >= 1),
    CONSTRAINT buildings_construction_has_deadline CHECK (
        status <> 'construction' OR completed_at IS NOT NULL
    )
);
CREATE INDEX buildings_company_idx  ON buildings (company_id, status);
CREATE INDEX buildings_plot_idx     ON buildings (plot_id);
CREATE INDEX buildings_settle_idx   ON buildings (world_id, last_settled_at);
CREATE INDEX buildings_constructing ON buildings (completed_at)
    WHERE status = 'construction';

-- Sklad = umístění inventáře. V MVP má každá firma přesně jeden (na svém HQ
-- pozemku); od fáze 2 jich může mít víc a doprava mezi nimi má cenu a čas.
CREATE TABLE inventories (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id    bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id  bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    plot_id     bigint NOT NULL REFERENCES plots(id) ON DELETE RESTRICT,
    name        text NOT NULL DEFAULT 'HQ',
    -- kapacita se počítá z budov; tohle je bonus/navíc (upgrady skladu)
    extra_capacity numeric(20,4) NOT NULL DEFAULT 0,
    is_primary  boolean NOT NULL DEFAULT false,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT inventories_extra_capacity_nonneg CHECK (extra_capacity >= 0)
);
CREATE UNIQUE INDEX inventories_company_primary_uniq
    ON inventories (company_id) WHERE is_primary;
CREATE INDEX inventories_company_idx ON inventories (company_id);

CREATE TABLE inventory_items (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    inventory_id   bigint NOT NULL REFERENCES inventories(id) ON DELETE CASCADE,
    item_id        bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quality_tier   smallint NOT NULL DEFAULT 1,
    quantity       numeric(20,4) NOT NULL DEFAULT 0,
    reserved_qty   numeric(20,4) NOT NULL DEFAULT 0,   -- escrow pod sell orderem
    updated_at     timestamptz NOT NULL DEFAULT now(),

    -- ADR-008: quality_tier je v klíči OD ZAČÁTKU. Zpětné přidání do inventáře,
    -- orderů i trades je migrace přes miliony řádků.
    CONSTRAINT inventory_items_uniq UNIQUE (inventory_id, item_id, quality_tier),
    CONSTRAINT inventory_items_qty_nonneg       CHECK (quantity >= 0),
    CONSTRAINT inventory_items_reserved_nonneg  CHECK (reserved_qty >= 0),
    -- available = quantity - reserved; tohle je invariant celé hry
    CONSTRAINT inventory_items_reserved_le_qty  CHECK (reserved_qty <= quantity),
    CONSTRAINT inventory_items_quality_range    CHECK (quality_tier BETWEEN 1 AND 10)
);
CREATE INDEX inventory_items_item_idx ON inventory_items (item_id, quality_tier);

COMMENT ON CONSTRAINT inventory_items_reserved_le_qty ON inventory_items IS
    'Nikdy nelze přeprodat zásoby, které jsou v escrow pod otevřeným sell orderem.
     Vynuceno na úrovni DB, ne jen v aplikaci.';


-- ============================================================================
--  7. VÝROBA
-- ============================================================================

CREATE TABLE production_orders (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id       bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id     bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    building_id    bigint NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    recipe_id      bigint NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT,
    target_qty     numeric(20,4) NOT NULL,
    produced_qty   numeric(20,4) NOT NULL DEFAULT 0,
    status         production_status NOT NULL DEFAULT 'queued',
    -- kolik vstupů se celkem spotřebovalo (audit + P&L)
    consumed_value numeric(24,6) NOT NULL DEFAULT 0,
    started_at     timestamptz,
    eta_at         timestamptz,
    last_settled_at timestamptz NOT NULL DEFAULT now(),
    created_at     timestamptz NOT NULL DEFAULT now(),
    completed_at   timestamptz,

    CONSTRAINT production_orders_target_positive CHECK (target_qty > 0),
    CONSTRAINT production_orders_produced_bounds CHECK (
        produced_qty >= 0 AND produced_qty <= target_qty
    ),
    CONSTRAINT production_orders_consumed_nonneg CHECK (consumed_value >= 0),
    CONSTRAINT production_orders_completed_consistency CHECK (
        (status = 'completed') = (completed_at IS NOT NULL)
    )
);
-- jedna budova vyrábí nejvýš jednu věc najednou
CREATE UNIQUE INDEX production_orders_active_building_uniq
    ON production_orders (building_id)
    WHERE status IN ('queued', 'running', 'starved', 'storage_full');
CREATE INDEX production_orders_company_idx ON production_orders (company_id, status);
CREATE INDEX production_orders_settle_idx  ON production_orders (world_id, last_settled_at);

-- fronta výroby (naplánované dopředu) — hráč může naskládat víc příkazů za sebe
CREATE TABLE production_queue (
    id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    building_id  bigint NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    recipe_id    bigint NOT NULL REFERENCES recipes(id) ON DELETE CASCADE,
    target_qty   numeric(20,4) NOT NULL,
    position     integer NOT NULL,
    created_at   timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT production_queue_uniq UNIQUE (building_id, position),
    CONSTRAINT production_queue_target_positive CHECK (target_qty > 0),
    CONSTRAINT production_queue_position_nonneg CHECK (position >= 0)
);


-- ============================================================================
--  7b. DOPRAVA — cargo trasy hráče
--      Hráč si trasu MUSÍ založit sám (odkud → kam, kolika vozy). Tick po ní
--      vozí zboží ze skladu odkud do skladu kam a účtuje přepravné.
--      Peníze: setup vozového parku i hodinové přepravné → sink_transport
--      (mizí z ekonomiky, M2 identita drží).
-- ============================================================================

CREATE TABLE transport_routes (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id      bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id    bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    from_plot_id  bigint NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
    to_plot_id    bigint NOT NULL REFERENCES plots(id) ON DELETE CASCADE,
    mode          text NOT NULL CHECK (mode IN ('truck','ship')),
    vehicles      integer NOT NULL CHECK (vehicles BETWEEN 1 AND 8),
    distance      integer NOT NULL CHECK (distance >= 2),
    path          jsonb NOT NULL DEFAULT '[]'::jsonb,   -- dlaždice trasy [{x,y},…]
    fee_per_hour  numeric(20,6) NOT NULL CHECK (fee_per_hour >= 0),
    capacity_per_hour numeric(20,4) NOT NULL CHECK (capacity_per_hour > 0),
    hauled_total  numeric(20,4) NOT NULL DEFAULT 0,     -- celkem odvezeno (UI feedback)
    last_haul_at  timestamptz,
    status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
    created_at    timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT transport_routes_distinct CHECK (from_plot_id <> to_plot_id)
);
CREATE INDEX transport_routes_company_idx ON transport_routes (world_id, company_id);
CREATE UNIQUE INDEX transport_routes_pair_uniq
    ON transport_routes (from_plot_id, to_plot_id, mode);


-- ============================================================================
--  8. BURZA — CLOB
--     Jeden order book na (world_id, item_id, quality_tier). Ne na komoditu.
-- ============================================================================

CREATE TABLE market_orders (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id       bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id     bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    item_id        bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quality_tier   smallint NOT NULL DEFAULT 1,
    side           order_side NOT NULL,
    order_type     order_type NOT NULL DEFAULT 'limit',
    price_limit    numeric(24,6),                -- NULL u market orderu
    qty            numeric(20,4) NOT NULL,
    qty_filled     numeric(20,4) NOT NULL DEFAULT 0,
    status         order_status NOT NULL DEFAULT 'open',
    -- Kolik hotovosti je PRÁVĚ TEĎ zablokováno na účtu escrow_market kvůli tomuhle
    -- příkazu. Bez tohohle sloupce by se escrow musel zpětně dopočítávat z
    -- price_limit × zbývající množství, což (a) nezná cenu, za kterou se skutečně
    -- plnilo, a (b) zanechává drobné zbytky navždy zablokované. Tady je to přesné:
    -- invariant „Σ escrow_locked firmy == zůstatek jejího účtu escrow_market“
    -- kontroluje fn_audit_escrow_mismatch().
    escrow_locked  numeric(24,6) NOT NULL DEFAULT 0,
    -- idempotence: klient generuje UUID, server ho drží 24 h
    idempotency_key uuid,
    is_npc         boolean NOT NULL DEFAULT false,   -- NPC market maker
    created_at     timestamptz NOT NULL DEFAULT now(),
    expires_at     timestamptz,                  -- GTD; NULL = GTC
    updated_at     timestamptz NOT NULL DEFAULT now(),
    cancelled_at   timestamptz,

    CONSTRAINT market_orders_qty_positive   CHECK (qty > 0),
    CONSTRAINT market_orders_filled_bounds  CHECK (qty_filled >= 0 AND qty_filled <= qty),
    CONSTRAINT market_orders_escrow_nonneg  CHECK (escrow_locked >= 0),
    -- Terminální příkaz nesmí držet žádný escrow; jinak by peníze zůstaly viset.
    CONSTRAINT market_orders_terminal_no_escrow CHECK (
        status NOT IN ('filled','cancelled','expired','rejected') OR escrow_locked = 0
    ),
    CONSTRAINT market_orders_price_positive CHECK (price_limit IS NULL OR price_limit > 0),
    CONSTRAINT market_orders_limit_needs_price CHECK (
        order_type <> 'limit' OR price_limit IS NOT NULL
    ),
    -- Invariant „market order nikdy nezůstane v booku“ (IOC) TADY BÝVAL JAKO CHECK
    -- a byl špatně: CHECK se vyhodnocuje okamžitě při INSERT, jenže matching engine
    -- musí řádek nejdřív založit jako 'open' (kvůli FK z trades) a teprve po
    -- spárování ho dořešit na 'filled'/'cancelled'. To je invariant na úrovni
    -- COMMITU → patří do DEFERRABLE CONSTRAINT TRIGGERU (viz níže).
    CONSTRAINT market_orders_filled_status_consistency CHECK (
        (qty_filled = qty) = (status = 'filled')
        OR status IN ('cancelled','expired','rejected')
    ),
    CONSTRAINT market_orders_quality_range CHECK (quality_tier BETWEEN 1 AND 10),
    CONSTRAINT market_orders_expiry_future CHECK (
        expires_at IS NULL OR expires_at > created_at
    )
);

-- ★ HOT PATH ★ matching engine čte výhradně tyhle dva indexy.
-- asks: nejnižší cena první, při shodě rozhoduje čas (price-time priority)
CREATE INDEX market_orders_asks_idx
    ON market_orders (world_id, item_id, quality_tier, price_limit ASC, created_at ASC)
    WHERE status IN ('open','partial') AND side = 'sell';
-- bids: nejvyšší cena první
CREATE INDEX market_orders_bids_idx
    ON market_orders (world_id, item_id, quality_tier, price_limit DESC, created_at ASC)
    WHERE status IN ('open','partial') AND side = 'buy';

CREATE INDEX market_orders_company_idx ON market_orders (company_id, status);

-- ============================================================================
--  IOC invariant: market order nesmí po COMMITU zůstat v booku
-- ============================================================================
-- DEFERRABLE, protože řádek během matchování krátkodobě 'open' být musí.
--
-- ★ Zásadní detail: NEČTEME NEW. U deferred triggeru PostgreSQL uchová přechodový
-- řádek z okamžiku INSERT/UPDATE a vyhodnotí ho až při COMMIT — NEW.status by tedy
-- pořád nesl 'open' z INSERTu, i když byl řádek mezitím správně dořešen na
-- 'filled'. Čteme proto AKTUÁLNÍ stav z tabulky; tím trigger kontroluje skutečný
-- invariant („na konci transakce žádný market order nečeká v booku“).
CREATE OR REPLACE FUNCTION fn_market_orders_no_resting_market() RETURNS trigger AS $$
DECLARE
    cur_type   order_type;
    cur_status order_status;
BEGIN
    SELECT o.order_type, o.status INTO cur_type, cur_status
      FROM market_orders o WHERE o.id = NEW.id;

    -- řádek byl mezitím smazán → není co porušit
    IF cur_type IS NULL THEN
        RETURN NULL;
    END IF;

    IF cur_type = 'market' AND cur_status IN ('open','partial') THEN
        RAISE EXCEPTION
            'market order % nesmí zůstat v booku (status=%): IOC musí skončit jako filled, cancelled nebo rejected',
            NEW.id, cur_status
            USING HINT = 'placeOrder() musí po matchování nastavit terminální status a uvolnit escrow/rezervaci na nevyplněný zbytek.';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER market_orders_no_resting_market
    AFTER INSERT OR UPDATE OF status ON market_orders
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_market_orders_no_resting_market();

COMMENT ON CONSTRAINT market_orders_no_resting_market ON market_orders IS
    'IOC: market order nesmí po COMMITU čekat v booku. Deferred, protože během matchování je krátkodobě open.';
CREATE INDEX market_orders_expiry_idx  ON market_orders (expires_at)
    WHERE status IN ('open','partial') AND expires_at IS NOT NULL;
CREATE UNIQUE INDEX market_orders_idempotency_uniq
    ON market_orders (company_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL;

COMMENT ON INDEX market_orders_asks_idx IS
    'Partial index jen na otevřené příkazy. To je kritické: tabulka market_orders
     má miliardy historických řádků, ale book obsahuje jen zlomek. Bez partial
     indexu by matching skenoval mrtvá data.';

CREATE TABLE idempotency_keys (
    key         uuid        NOT NULL,
    company_id  bigint      NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    scope       text        NOT NULL,          -- 'market_order','build','upgrade'
    response    jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    expires_at  timestamptz NOT NULL,
    PRIMARY KEY (company_id, scope, key),
    CONSTRAINT idempotency_keys_expiry_future CHECK (expires_at > created_at)
);
CREATE INDEX idempotency_keys_expiry_idx ON idempotency_keys (expires_at);

-- Obchody: APPEND-ONLY. Zdroj pravdy pro grafy, TWAP, CPI a referenční cenu
-- NPC market makera. Nikdy se neupdatuje ani nemaže.
CREATE TABLE trades (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id       bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    item_id        bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quality_tier   smallint NOT NULL DEFAULT 1,
    price          numeric(24,6) NOT NULL,
    qty            numeric(20,4) NOT NULL,
    gross_value    numeric(24,6) NOT NULL,      -- price × qty (denormalizováno pro agregace)
    buy_order_id   bigint REFERENCES market_orders(id) ON DELETE RESTRICT,
    sell_order_id  bigint REFERENCES market_orders(id) ON DELETE RESTRICT,
    buyer_company_id  bigint REFERENCES companies(id) ON DELETE RESTRICT,
    seller_company_id bigint REFERENCES companies(id) ON DELETE RESTRICT,
    fee_buyer      numeric(24,6) NOT NULL DEFAULT 0,
    fee_seller     numeric(24,6) NOT NULL DEFAULT 0,
    is_npc_involved boolean NOT NULL DEFAULT false,
    executed_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT trades_price_positive  CHECK (price > 0),
    CONSTRAINT trades_qty_positive    CHECK (qty > 0),
    CONSTRAINT trades_value_consistent CHECK (
        abs(gross_value - price * qty) < 0.000001
    ),
    CONSTRAINT trades_fees_nonneg CHECK (fee_buyer >= 0 AND fee_seller >= 0),
    -- wash trading: stejná firma nesmí být na obou stranách
    CONSTRAINT trades_no_self_match CHECK (
        buyer_company_id IS DISTINCT FROM seller_company_id
    )
);
-- grafy a TWAP: nejčastější dotaz v celé hře
CREATE INDEX trades_chart_idx ON trades (world_id, item_id, quality_tier, executed_at DESC);
CREATE INDEX trades_company_buy_idx  ON trades (buyer_company_id, executed_at DESC);
CREATE INDEX trades_company_sell_idx ON trades (seller_company_id, executed_at DESC);

COMMENT ON CONSTRAINT trades_no_self_match ON trades IS
    'První vrstva anti-manipulace: self-matching (wash trading) je odmítnut na
     úrovni DB, nejen v aplikační logice.';

-- Anti-manipulace: flagy pro ruční review
CREATE TABLE market_flags (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id    bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id  bigint REFERENCES companies(id) ON DELETE CASCADE,
    flag_type   text NOT NULL,      -- 'wash_trading','spoofing','cornering','pump_dump'
    severity    smallint NOT NULL DEFAULT 1,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    resolved_at timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT market_flags_severity_range CHECK (severity BETWEEN 1 AND 5),
    CONSTRAINT market_flags_type_known CHECK (flag_type IN
        ('wash_trading','spoofing','cornering','pump_dump','excessive_cancel','other'))
);
CREATE INDEX market_flags_open_idx ON market_flags (world_id, flag_type, created_at DESC)
    WHERE resolved_at IS NULL;


-- ============================================================================
--  9. NPC MARKET MAKER — cold start (doc 00 §3.5)
-- ============================================================================

CREATE TABLE npc_quotes (
    id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id       bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    item_id        bigint NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    quality_tier   smallint NOT NULL DEFAULT 1,
    status         npc_quote_status NOT NULL DEFAULT 'active',
    ref_price      numeric(24,6) NOT NULL,      -- TWAP 30 dní, jinak base_price
    bid_price      numeric(24,6) NOT NULL,      -- ref × 0.85
    ask_price      numeric(24,6) NOT NULL,      -- ref × 1.15
    inventory_qty  numeric(20,4) NOT NULL DEFAULT 0,
    inventory_cap  numeric(20,4) NOT NULL,
    restock_per_day numeric(20,4) NOT NULL DEFAULT 0,
    -- vypíná se, když hráčská likvidita překročí práh
    player_depth_ok   boolean NOT NULL DEFAULT false,
    player_volume_ok  boolean NOT NULL DEFAULT false,
    updated_at     timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT npc_quotes_uniq UNIQUE (world_id, item_id, quality_tier),
    CONSTRAINT npc_quotes_spread_valid CHECK (bid_price < ask_price),
    CONSTRAINT npc_quotes_prices_positive CHECK (bid_price > 0 AND ask_price > 0
                                                 AND ref_price > 0),
    CONSTRAINT npc_quotes_inventory_bounds CHECK (
        inventory_qty >= 0 AND inventory_qty <= inventory_cap AND inventory_cap > 0
    )
);

COMMENT ON TABLE npc_quotes IS
    'Řeší cold start: bez toho nový hráč nemá kde koupit první vstupy. Chová se jako
     AMM s bounded inventory. Vypíná se per komodita, jakmile hráčská likvidita
     překročí práh — ADR-011: je to argument PRO hluboký CLOB, NPC výkup za fixní
     cenu v pozdní hře nesmí zůstat.';


-- ============================================================================
--  10. RETAIL — jediný faucet pozdní hry
-- ============================================================================

CREATE TABLE retail_stores (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id      bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id    bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    building_id   bigint NOT NULL REFERENCES buildings(id) ON DELETE CASCADE,
    level         smallint NOT NULL DEFAULT 1,
    shelf_slots   smallint NOT NULL DEFAULT 3,     -- max SKU
    max_units_per_hour numeric(20,4) NOT NULL DEFAULT 100,
    open_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT retail_stores_level_positive CHECK (level >= 1),
    CONSTRAINT retail_stores_slots_positive CHECK (shelf_slots > 0),
    CONSTRAINT retail_stores_units_positive CHECK (max_units_per_hour > 0)
);
CREATE UNIQUE INDEX retail_stores_building_uniq ON retail_stores (building_id);

CREATE TABLE retail_listings (
    id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id      bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    company_id    bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    store_id      bigint NOT NULL REFERENCES retail_stores(id) ON DELETE CASCADE,
    item_id       bigint NOT NULL REFERENCES items(id) ON DELETE RESTRICT,
    quality_tier  smallint NOT NULL DEFAULT 1,
    price         numeric(24,6) NOT NULL,
    qty_available numeric(20,4) NOT NULL DEFAULT 0,   -- reservováno ze skladu
    qty_sold_total numeric(20,4) NOT NULL DEFAULT 0,
    revenue_total numeric(24,6) NOT NULL DEFAULT 0,
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT retail_listings_uniq UNIQUE (store_id, item_id, quality_tier),
    CONSTRAINT retail_listings_price_positive CHECK (price > 0),
    CONSTRAINT retail_listings_qty_nonneg CHECK (qty_available >= 0 AND qty_sold_total >= 0),
    CONSTRAINT retail_listings_revenue_nonneg CHECK (revenue_total >= 0)
);
CREATE INDEX retail_listings_item_idx ON retail_listings (world_id, item_id, quality_tier)
    WHERE qty_available > 0;

COMMENT ON COLUMN retail_listings.qty_available IS
    'Neprodané zboží na konci ticku PROPADÁ (fill_rate < 1) — to je goods sink,
     který brání hromadění zásob. Viz doc 10 §5.';


-- ============================================================================
--  11. PODVOJNÉ ÚČETNICTVÍ
--     Nejdůležitější technické rozhodnutí celé hry (doc 00 §4).
-- ============================================================================

CREATE TABLE accounts (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    owner_type  account_owner NOT NULL,
    owner_id    bigint,                    -- companies.id, nebo NULL u systému
    world_id    bigint REFERENCES worlds(id) ON DELETE CASCADE,
    kind        account_kind NOT NULL,
    currency    char(3) NOT NULL DEFAULT 'USD',
    balance     numeric(24,6) NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    -- NULLS NOT DISTINCT (PG15+) je nutné: systémové účty mají owner_id NULL
    -- a s výchozím chováním by UNIQUE dovolil neomezeně mnoho duplicit.
    CONSTRAINT accounts_owner_uniq
        UNIQUE NULLS NOT DISTINCT (owner_type, owner_id, world_id, kind, currency),
    -- firma nikdy nesmí jít do mínusu. Systémové účty jsou akumulátory.
    CONSTRAINT accounts_no_overdraft CHECK (owner_type = 'system' OR balance >= 0),
    CONSTRAINT accounts_owner_id_required CHECK (
        owner_type <> 'company' OR owner_id IS NOT NULL
    )
);
CREATE INDEX accounts_company_idx ON accounts (owner_id, kind)
    WHERE owner_type = 'company';
CREATE INDEX accounts_world_kind_idx ON accounts (world_id, kind);

-- Firma má v MVP přesně dva účty: cash a escrow_market. Vznikají triggerem.
CREATE OR REPLACE FUNCTION fn_ensure_company_accounts() RETURNS trigger AS $$
BEGIN
    INSERT INTO accounts (owner_type, owner_id, world_id, kind, balance)
    VALUES ('company', NEW.id, NEW.world_id, 'cash', 0),
           ('company', NEW.id, NEW.world_id, 'escrow_market', 0)
    ON CONFLICT DO NOTHING;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER companies_create_accounts
    AFTER INSERT ON companies
    FOR EACH ROW EXECUTE FUNCTION fn_ensure_company_accounts();

CREATE TABLE journal_entries (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    txn_id      uuid NOT NULL DEFAULT gen_random_uuid(),   -- seskupuje legs jedné operace
    world_id    bigint REFERENCES worlds(id) ON DELETE CASCADE,
    account_id  bigint NOT NULL REFERENCES accounts(id) ON DELETE RESTRICT,
    amount      numeric(24,6) NOT NULL,                     -- signed
    kind        text NOT NULL,          -- 'market_trade','retail_sale','upkeep',…
    money_flow  money_flow NOT NULL,    -- faucet/sink/transfer/internal
    ref_type    text,                   -- 'market_order','trade','building',…
    ref_id      bigint,
    meta        jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT journal_entries_amount_nonzero CHECK (amount <> 0),
    CONSTRAINT journal_entries_kind_known CHECK (kind IN (
        'starting_grant','market_trade','exchange_fee','retail_sale','retail_tax',
        'state_purchase','building_capex','upgrade_capex','demolition','upkeep',
        'plot_rent','property_tax','wages','hq_overhead','transport','storage_rent',
        'research','wealth_tax','auction_burn','loan_interest','player_transfer','land_purchase',
        'utilities_purchase',
        'escrow_lock','escrow_release','adjustment'
    ))
);
CREATE INDEX journal_txn_idx     ON journal_entries (txn_id);
CREATE INDEX journal_account_idx ON journal_entries (account_id, created_at DESC);
CREATE INDEX journal_world_flow_idx ON journal_entries (world_id, money_flow, created_at DESC);
CREATE INDEX journal_kind_idx    ON journal_entries (kind, created_at DESC);

-- Udržuje accounts.balance inkrementálně, ve stejné transakci.
CREATE OR REPLACE FUNCTION fn_journal_apply_balance() RETURNS trigger AS $$
BEGIN
    UPDATE accounts
       SET balance = balance + NEW.amount,
           updated_at = now()
     WHERE id = NEW.account_id;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER journal_apply_balance
    AFTER INSERT ON journal_entries
    FOR EACH ROW EXECUTE FUNCTION fn_journal_apply_balance();

-- ★★★ INVARIANT PODVOJNÉHO ÚČETNICTVÍ ★★★
-- Součet legs každé transakce MUSÍ být nula. Vynuceno CONSTRAINT TRIGGEREM
-- DEFERRED, tedy až na konci transakce — takže aplikace může legs vkládat
-- v libovolném pořadí. Když to nesedí, transakce se odmítne commitnout.
CREATE OR REPLACE FUNCTION fn_journal_assert_balanced() RETURNS trigger AS $$
DECLARE
    s numeric(24,6);
BEGIN
    SELECT COALESCE(SUM(amount), 0) INTO s
      FROM journal_entries
     WHERE txn_id = NEW.txn_id;

    IF s <> 0 THEN
        RAISE EXCEPTION
            'podvojný ledger není vyrovnaný: txn_id=% součet=% (musí být 0)',
            NEW.txn_id, s
            USING HINT = 'Chybí nebo přebývá leg. Zkontroluj obě strany operace.';
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER journal_assert_balanced
    AFTER INSERT ON journal_entries
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION fn_journal_assert_balanced();

COMMENT ON TRIGGER journal_assert_balanced ON journal_entries IS
    'Tohle je nejlepší debugging nástroj, jaký v ekonomické hře můžeš mít. S jedním
     sloupcem cash nikdy nezjistíš, kde se peníze ztratily; tady to odmítne commit.';

-- Pomocná funkce: makro snapshot světa jedním dotazem.
CREATE OR REPLACE FUNCTION fn_world_money_supply(
    p_world_id bigint,
    OUT m2 numeric,
    OUT faucet_total numeric,
    OUT sink_total numeric
) AS $$
BEGIN
    SELECT COALESCE(SUM(balance), 0) INTO m2
      FROM accounts
     WHERE world_id = p_world_id
       AND owner_type = 'company'
       AND kind IN ('cash', 'escrow_market');

    SELECT COALESCE(SUM(balance), 0) INTO faucet_total
      FROM accounts
     WHERE world_id = p_world_id AND owner_type = 'system'
       AND kind LIKE 'faucet_%';

    SELECT COALESCE(SUM(balance), 0) INTO sink_total
      FROM accounts
     WHERE world_id = p_world_id AND owner_type = 'system'
       AND kind LIKE 'sink_%';
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
--  12. NOTIFIKACE, SNAPSHOTY, AUDIT
-- ============================================================================

CREATE TABLE events (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id    bigint REFERENCES worlds(id) ON DELETE CASCADE,
    company_id  bigint NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    type        event_type NOT NULL,
    payload     jsonb NOT NULL DEFAULT '{}'::jsonb,
    read_at     timestamptz,
    created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX events_inbox_idx ON events (company_id, created_at DESC)
    WHERE read_at IS NULL;
CREATE INDEX events_history_idx ON events (company_id, created_at DESC);

-- Makro dashboard (doc 10 §8). Bez tohohle se vyvažuje naslepo.
CREATE TABLE daily_snapshots (
    id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id         bigint NOT NULL REFERENCES worlds(id) ON DELETE CASCADE,
    snapshot_date    date   NOT NULL,
    -- populace
    active_companies integer NOT NULL DEFAULT 0,
    new_companies    integer NOT NULL DEFAULT 0,
    bankruptcies     integer NOT NULL DEFAULT 0,
    -- peníze
    m2               numeric(24,6) NOT NULL DEFAULT 0,
    faucet_total     numeric(24,6) NOT NULL DEFAULT 0,
    sink_total       numeric(24,6) NOT NULL DEFAULT 0,
    delta_m          numeric(24,6) NOT NULL DEFAULT 0,
    -- cenová hladina a reálný výstup (ADR-009)
    cpi              numeric(12,6) NOT NULL DEFAULT 100,
    real_output_y    numeric(24,6) NOT NULL DEFAULT 0,   -- Laspeyres, fixní základní ceny
    cpi_drift_monthly numeric(8,4),                      -- %ΔM2 − %ΔY, 30d klouzavě
    velocity         numeric(10,6),                      -- objem obchodů / M2
    -- rozložení bohatství
    gini             numeric(6,4),
    top1pct_share    numeric(6,4),
    -- trh
    trade_volume     numeric(24,6) NOT NULL DEFAULT 0,
    trade_count      bigint NOT NULL DEFAULT 0,
    empty_books_pct  numeric(5,2),
    avg_fill_rate_retail numeric(5,4),
    -- rozpad sinků (která vrstva kolik odvedla)
    sinks_breakdown  jsonb NOT NULL DEFAULT '{}'::jsonb,
    faucets_breakdown jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at       timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT daily_snapshots_uniq UNIQUE (world_id, snapshot_date),
    CONSTRAINT daily_snapshots_gini_range CHECK (gini IS NULL OR gini BETWEEN 0 AND 1),
    CONSTRAINT daily_snapshots_top1_range CHECK (
        top1pct_share IS NULL OR top1pct_share BETWEEN 0 AND 1
    ),
    CONSTRAINT daily_snapshots_nonneg CHECK (
        active_companies >= 0 AND new_companies >= 0 AND bankruptcies >= 0
        AND m2 >= 0 AND trade_count >= 0
    )
);

COMMENT ON COLUMN daily_snapshots.cpi_drift_monthly IS
    'CÍLOVÁ METRIKA (ADR-009): CPI drift = %ΔM2 − %ΔY, cíl 1–4 %/měsíc.
     NE růst M2 samotný — rostoucí ekonomika musí M2 zvyšovat, jen aby cenová
     hladina stála.';

CREATE TABLE audit_results (
    id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    world_id    bigint REFERENCES worlds(id) ON DELETE CASCADE,
    check_name  text NOT NULL,
    passed      boolean NOT NULL,
    detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
    run_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_results_failed_idx ON audit_results (check_name, run_at DESC)
    WHERE NOT passed;


-- ============================================================================
--  13. VIEW PRO HRÁČSKÉ P&L A ADMIN
-- ============================================================================

-- Zůstatky firmy na jednom místě (hotovost + escrow)
CREATE VIEW v_company_balances AS
SELECT c.id            AS company_id,
       c.world_id,
       c.name,
       c.status,
       COALESCE(SUM(a.balance) FILTER (WHERE a.kind = 'cash'), 0)          AS cash,
       COALESCE(SUM(a.balance) FILTER (WHERE a.kind = 'escrow_market'), 0) AS escrow,
       COALESCE(SUM(a.balance), 0)                                          AS total_liquid
  FROM companies c
  LEFT JOIN accounts a
         ON a.owner_type = 'company' AND a.owner_id = c.id
 GROUP BY c.id;

-- Aktuální nejlepší bid/ask a hloubka booku (L2 se počítá v aplikaci z tohohle)
CREATE VIEW v_order_book_top AS
SELECT o.world_id,
       o.item_id,
       o.quality_tier,
       MAX(o.price_limit) FILTER (WHERE o.side = 'buy')  AS best_bid,
       MIN(o.price_limit) FILTER (WHERE o.side = 'sell') AS best_ask,
       SUM(o.qty - o.qty_filled) FILTER (WHERE o.side = 'buy')  AS bid_depth,
       SUM(o.qty - o.qty_filled) FILTER (WHERE o.side = 'sell') AS ask_depth,
       COUNT(*) FILTER (WHERE o.side = 'buy')  AS bid_orders,
       COUNT(*) FILTER (WHERE o.side = 'sell') AS ask_orders
  FROM market_orders o
 WHERE o.status IN ('open', 'partial')
   AND o.order_type = 'limit'
   AND o.is_npc = false
 GROUP BY o.world_id, o.item_id, o.quality_tier;

-- TWAP 30 dní — referenční cena pro NPC market makera a pro CPI koš
CREATE VIEW v_twap_30d AS
SELECT world_id,
       item_id,
       quality_tier,
       SUM(gross_value) / NULLIF(SUM(qty), 0) AS twap_30d,
       SUM(qty)         AS volume_30d,
       COUNT(*)         AS trades_30d
  FROM trades
 WHERE executed_at > now() - interval '30 days'
 GROUP BY world_id, item_id, quality_tier;

-- Disponibilní zásoby (quantity − reserved) — tohle čte matching engine
CREATE VIEW v_available_inventory AS
SELECT inv.company_id,
       inv.world_id,
       inv.plot_id,
       ii.item_id,
       ii.quality_tier,
       ii.quantity,
       ii.reserved_qty,
       ii.quantity - ii.reserved_qty AS available
  FROM inventory_items ii
  JOIN inventories inv ON inv.id = ii.inventory_id
 WHERE ii.quantity > 0;


-- ============================================================================
--  14. AUDIT FUNKCE (noční job)
-- ============================================================================

-- Musí vrátit 0 řádků. Když vrátí něco, máš leak a musíš ho najít dřív než hráči.
CREATE OR REPLACE FUNCTION fn_audit_unbalanced_txns(p_since timestamptz DEFAULT now() - interval '1 day')
RETURNS TABLE (txn_id uuid, leg_count bigint, total numeric(24,6)) AS $$
BEGIN
    RETURN QUERY
    SELECT j.txn_id, COUNT(*) AS leg_count, SUM(j.amount) AS total
      FROM journal_entries j
     WHERE j.created_at >= p_since
     GROUP BY j.txn_id
    HAVING SUM(j.amount) <> 0;
END;
$$ LANGUAGE plpgsql;

-- Souhlasí zůstatek účtu se součtem jeho journal entries?
CREATE OR REPLACE FUNCTION fn_audit_balance_drift()
RETURNS TABLE (account_id bigint, stored_balance numeric, computed_balance numeric, drift numeric) AS $$
BEGIN
    RETURN QUERY
    SELECT a.id,
           a.balance,
           COALESCE(SUM(j.amount), 0),
           a.balance - COALESCE(SUM(j.amount), 0)
      FROM accounts a
      LEFT JOIN journal_entries j ON j.account_id = a.id
     GROUP BY a.id, a.balance
    HAVING a.balance <> COALESCE(SUM(j.amount), 0);
END;
$$ LANGUAGE plpgsql;

-- Rezervace nesmí převýšit zásoby (duplicita CHECK constraintu, ale na agregátu)
CREATE OR REPLACE FUNCTION fn_audit_oversold_inventory()
RETURNS TABLE (inventory_item_id bigint, quantity numeric, reserved_qty numeric) AS $$
BEGIN
    RETURN QUERY
    SELECT ii.id, ii.quantity, ii.reserved_qty
      FROM inventory_items ii
     WHERE ii.reserved_qty > ii.quantity OR ii.quantity < 0;
END;
$$ LANGUAGE plpgsql;

-- Sedí escrow zablokovaný na příkazech se zůstatkem účtu escrow_market?
--
-- Tohle je hlídač proti ÚNIKU PENĚZ. Kdyby matching engine zapomněl uvolnit
-- nevyčerpaný zbytek escrow (nebo ho naopak uvolnil dvakrát), rovnost se
-- poruší. Bez tohohle auditu by taková chyba vypadala jako „někomu se občas
-- ztratí pár haléřů“ a odhalila by se až z makro čísel po týdnech.
CREATE OR REPLACE FUNCTION fn_audit_escrow_mismatch()
RETURNS TABLE (
    company_id        bigint,
    locked_on_orders  numeric,
    account_balance   numeric,
    diff              numeric
) AS $$
BEGIN
    RETURN QUERY
    SELECT c.id,
           COALESCE(o.locked, 0),
           COALESCE(a.balance, 0),
           COALESCE(o.locked, 0) - COALESCE(a.balance, 0)
      FROM companies c
      LEFT JOIN (SELECT mo.company_id, SUM(mo.escrow_locked) AS locked
                   FROM market_orders mo GROUP BY mo.company_id) o
             ON o.company_id = c.id
      LEFT JOIN accounts a
             ON a.owner_type = 'company' AND a.owner_id = c.id
            AND a.kind = 'escrow_market'
     WHERE COALESCE(o.locked, 0) <> COALESCE(a.balance, 0);
END;
$$ LANGUAGE plpgsql;

COMMIT;
