#!/usr/bin/env python3
"""
Generátor vyvážení ekonomiky CEO — v0.2

Dvě oddělené věci:

(A) ODVOZENÍ CEN ZDOLA NAHORU (cost-plus). Ceny se NEHÁDAJÍ — každá je vypočtena
    z nákladů a cílové marže v pořadí dle závislostí. Ekonomika je tak interně
    konzistentní od prvního dne a retuning = změna `m` / `payback` / `q_out`.

    Pro budovu se vstupy (m = cílová hrubá marže, P = cílová návratnost v h,
    k = 0.015, tj. údržba = 1,5 % capex za hodinu):

        inputs_cost = Σ qty_i · price_i
        net         = inputs_cost / [ (1-m)/m − k·P ]
        capex       = net · P
        upkeep      = k · capex
        revenue     = (inputs_cost + upkeep) / (1-m)
        price_out   = revenue / q_out

    Budovy bez vstupů (solární elektrárna) mají soustavu přeurčenou → zadává se
    capex a marže, návratnost z nich vypadne.

(B) MAKRO MODEL. Odděluje FAUCET (retail prodej NPC = vznik nových peněz) od
    TRANSFERU (burza = přenos mezi hráči, v M2 se vyruší) a počítá ΔM. Bez tohohle
    rozlišení nelze ekonomiku vyvažovat — viz docs/00-vize-a-koncept.md §3.2.

Výstup: docs/generated/balance-v0.2.md  +  seed/balance-v0.2.json
"""
from __future__ import annotations

import json
import os
import pathlib
from dataclasses import dataclass, field


def _env(name: str, default: float) -> float:
    """Ladicí knoflíky jdou přepsat proměnnou prostředí — umožňuje parametrický
    sweep bez editace zdroje: RETAIL_FILL_TARGET=0.5 HQ_BASE_SHARE=0.18 python3 ..."""
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default

K_UPKEEP = 0.015            # údržba = 1,5 % capex za hodinu
EXCHANGE_TO_RETAIL = 0.70   # burzovní mid = 70 % retail základu

# --- škálování úrovní -------------------------------------------------------
LEVEL_THROUGHPUT = 0.30     # propustnost × (1 + 0,30·(L−1))
LEVEL_UPKEEP = 0.22         # údržba     × (1 + 0,22·(L−1))   ← roste POMALEJI
LEVEL_STORAGE = 0.35
UPGRADE_COST_MULT = 0.75    # upgrade L→L+1 = 0,75 · capex_L1 · 1,85^(L−1)
UPGRADE_COST_GROWTH = 1.85
MAX_LEVEL = 5

# --- sinky ------------------------------------------------------------------
# Korporátní režie: SUPERLINEÁRNÍ diseconomie rozsahu. Kalibrováno tak, aby
# poměr režie k hrubému zisku byl ~10 % @ N=5, ~30 % @ N=50, ~50 % @ N=200.
HQ_A, HQ_P = 2.20, 1.45
HQ_B, HQ_Q = 0.35, 1.30

WAGE_BASE = _env('WAGE_BASE', 3.50)            # $/h na pracovníka, L1
WAGE_LEVEL_GROWTH = 1.15    # × 1,15^(L−1); v provozu navíc indexováno na CPI
RETAIL_SALES_TAX = _env('RETAIL_SALES_TAX', 0.05)     # daň z retail tržeb — sink na faucetu
EXCHANGE_FEE_AVG = 0.015    # průměr maker 0,5 % / taker 2,5 %
PROPERTY_TAX_WEEKLY = _env('PROPERTY_TAX_WEEKLY', 0.003) # 0,3 % z odhadní ceny pozemku týdně


def hq_overhead(n_buildings: int, sum_levels: int) -> float:
    """Korporátní režie v $/h. Čistý sink, škáluje superlineárně s velikostí říše."""
    return HQ_A * n_buildings ** HQ_P + HQ_B * sum_levels ** HQ_Q


def workers_for(level: int) -> int:
    return 1 + (level - 1) // 2


def wage_for(level: int) -> float:
    return WAGE_BASE * WAGE_LEVEL_GROWTH ** (level - 1)


PLOT_RENT = {               # $/h — recurring sink
    "forest": 8.0, "mine": 8.0, "water": 8.0,
    "utility": 6.0, "industrial": 5.0, "commercial": 10.0, "civic": 0.0,
}
PLOT_VALUE = {              # odhadní cena pro daň z nemovitosti
    "forest": 9_000, "mine": 11_000, "water": 9_000, "utility": 14_000,
    "industrial": 6_000, "commercial": 12_000, "civic": 0,
}
PLOT_COUNT = {              # 24×12 mřížka = 288 pozemků na svět
    "forest": 40, "mine": 30, "water": 18, "utility": 20,
    "industrial": 100, "commercial": 60, "civic": 20,
}


# --------------------------------------------------------------------------- #
# Budovy / recepty
# --------------------------------------------------------------------------- #

@dataclass
class Building:
    code: str
    name: str
    plot: str
    tier: int
    out_item: str
    q_out: float
    inputs: dict[str, float]
    m: float                      # cílová hrubá marže
    payback: float                # cílová návratnost (h); 0 = dopočítá se
    storage: float
    capex_override: float | None = None
    build_time_s: int = 120
    retail: bool = False          # výstup má retail základ (je to faucet)
    # vypočtené na L1
    price: float = 0.0
    capex: float = 0.0
    upkeep: float = 0.0
    revenue: float = 0.0
    inputs_cost: float = 0.0
    net: float = 0.0
    unit_cost: float = 0.0


BUILDINGS: list[Building] = [
    # TIER 0 — extrakce a energie. Tukové marže, ale gated vzácnými pozemky s deposit.
    Building("solar_plant", "Solární elektrárna", "utility", 0, "power",
             4000, {}, 0.55, 0, 6000, capex_override=6000, build_time_s=300),
    Building("oil_rig", "Ropná věž", "mine", 0, "crude_oil",
             400, {"power": 80}, 0.68, 22, 600),
    Building("logging_camp", "Dřevařský tábor", "forest", 0, "log",
             400, {"power": 80}, 0.70, 20, 600, build_time_s=90),
    Building("iron_mine", "Železný důl", "mine", 0, "iron_ore",
             300, {"power": 100}, 0.70, 22, 450),
    Building("quarry", "Kamenolom", "mine", 0, "stone",
             350, {"power": 80}, 0.68, 20, 520),
    Building("grain_farm", "Obilná farma", "water", 0, "grain",
             550, {"power": 60}, 0.70, 18, 800),
    Building("cotton_farm", "Bavlněná farma", "water", 0, "cotton",
             400, {"power": 60}, 0.70, 20, 600),

    # TIER 1 — zpracování
    Building("sawmill", "Pila", "industrial", 1, "planks",
             240, {"log": 200, "power": 120}, 0.42, 30, 380),
    Building("flour_mill", "Mlýn", "industrial", 1, "flour",
             300, {"grain": 400, "power": 60}, 0.42, 30, 480),
    Building("cement_kiln", "Cementárna", "industrial", 1, "cement",
             200, {"stone": 300, "power": 150}, 0.38, 34, 320),
    Building("glass_works", "Sklárna", "industrial", 1, "glass",
             100, {"stone": 300, "power": 200}, 0.38, 36, 160),
    Building("smelter", "Huť", "industrial", 1, "iron_ingot",
             120, {"iron_ore": 250, "power": 200}, 0.38, 38, 200),
    Building("refinery", "Rafinerie", "industrial", 1, "plastic",
             150, {"crude_oil": 300, "power": 200}, 0.38, 38, 240),
    Building("textile_mill", "Textilka", "industrial", 1, "fabric",
             120, {"cotton": 500, "power": 120}, 0.40, 36, 190),

    # TIER 2 — komponenty
    Building("nail_press", "Lis na hřebíky", "industrial", 2, "nails",
             900, {"iron_ingot": 30, "power": 80}, 0.34, 48, 1400),
    Building("wire_draw", "Tažírna drátů", "industrial", 2, "wire",
             750, {"iron_ingot": 30, "power": 100}, 0.34, 48, 1100),
    Building("steel_mill", "Ocelárna", "industrial", 2, "steel_sheet",
             60, {"iron_ingot": 180, "power": 300}, 0.32, 60, 100),
    Building("electronics_lab", "Elektronická linka", "industrial", 2, "circuit",
             80, {"wire": 120, "glass": 25, "power": 250}, 0.30, 66, 130),

    # TIER 3 — stroje + spotřební zboží (retail = faucet)
    Building("machine_shop", "Strojírna", "industrial", 3, "machine_part",
             50, {"steel_sheet": 40, "circuit": 20, "power": 300}, 0.28, 84, 80),
    Building("bakery", "Pekárna", "industrial", 3, "bread",
             800, {"flour": 200, "power": 50}, 0.28, 44, 1300, retail=True),
    Building("deli", "Lahůdky", "commercial", 3, "sandwich",
             240, {"bread": 200, "grain": 30, "power": 40}, 0.28, 48, 400, retail=True),
    Building("furniture_factory", "Továrna na nábytek", "industrial", 3, "furniture",
             30, {"planks": 80, "nails": 300, "power": 120}, 0.26, 72, 50, retail=True),
    Building("tool_works", "Nástrojárna", "industrial", 3, "tools",
             60, {"steel_sheet": 30, "nails": 200, "power": 200}, 0.26, 78, 100, retail=True),
    Building("garment_factory", "Oděvní továrna", "industrial", 3, "clothing",
             80, {"fabric": 80, "wire": 100, "power": 100}, 0.26, 72, 130, retail=True),
    Building("appliance_plant", "Továrna na spotřebiče", "industrial", 3, "appliance",
             20, {"steel_sheet": 30, "circuit": 40, "machine_part": 20,
                  "plastic": 60, "power": 300}, 0.24, 108, 35, retail=True),
]

RETAIL_ITEMS = {b.out_item for b in BUILDINGS if b.retail}


def _price_one(b: Building, prices: dict[str, float]) -> None:
    """Spočítá cenu výstupu jedné budovy (předpokládá známé ceny vstupů)."""
    b.inputs_cost = sum(q * prices[i] for i, q in b.inputs.items())

    if b.capex_override is not None:
        # budova bez vstupů: soustava je přeurčená -> zadáno capex + marže
        b.capex = b.capex_override
        b.upkeep = round(K_UPKEEP * b.capex, 2)
        b.revenue = b.upkeep / (1 - b.m)
        b.price = b.revenue / b.q_out
        b.net = b.revenue - b.upkeep
        b.payback = b.capex / b.net if b.net else float("inf")
    else:
        denom = (1 - b.m) / b.m - K_UPKEEP * b.payback
        if denom <= 0:
            raise SystemExit(
                f"❌ {b.code}: marže {b.m} a návratnost {b.payback} h jsou neslučitelné "
                f"(jmenovatel {denom:.4f} ≤ 0). Sniž marži nebo návratnost.")
        b.net = b.inputs_cost / denom
        b.capex = round(b.net * b.payback)
        b.upkeep = round(K_UPKEEP * b.capex, 2)
        b.revenue = (b.inputs_cost + b.upkeep) / (1 - b.m)
        b.price = b.revenue / b.q_out

    b.unit_cost = (b.inputs_cost + b.upkeep) / b.q_out
    prices[b.out_item] = round(b.price, 4)


def solve() -> dict[str, float]:
    """Vyřeší ceny FIXPOINTOVOU ITERACÍ — robustní vůči libovolnému pořadí
    definic i vůči cyklickým závislostem (které by odhalila až jako chybu)."""
    prices: dict[str, float] = {}
    pending = list(BUILDINGS)

    for _round in range(len(BUILDINGS) + 2):
        if not pending:
            break
        blocked = []
        for b in pending:
            if all(i in prices for i in b.inputs):
                _price_one(b, prices)
            else:
                blocked.append(b)
        if len(blocked) == len(pending):
            stuck = ", ".join(b.code for b in blocked[:6])
            raise SystemExit(
                f"❌ Cyklická nebo chybějící závislost — nelze vyřešit: {stuck}")
        pending = blocked

    return prices


PRICES = solve()
RETAIL = {i: round(PRICES[i] / EXCHANGE_TO_RETAIL, 2) for i in RETAIL_ITEMS}


# --------------------------------------------------------------------------- #
# Škálování úrovní
# --------------------------------------------------------------------------- #

@dataclass
class Leveled:
    q_out: float
    inputs_cost: float
    upkeep: float
    revenue: float
    net: float
    storage: float
    workers: int
    wage: float


def at_level(b: Building, level: int) -> Leveled:
    t = 1 + LEVEL_THROUGHPUT * (level - 1)
    u = 1 + LEVEL_UPKEEP * (level - 1)
    inputs_cost = b.inputs_cost * t
    upkeep = b.upkeep * u
    revenue = b.revenue * t
    return Leveled(
        q_out=b.q_out * t,
        inputs_cost=inputs_cost,
        upkeep=upkeep,
        revenue=revenue,
        net=revenue - inputs_cost - upkeep,
        storage=b.storage * (1 + LEVEL_STORAGE * (level - 1)),
        workers=workers_for(level),
        wage=wage_for(level),
    )


def upgrade_cost(b: Building, level: int) -> float:
    """Cena upgradu z `level` na `level+1`."""
    return round(b.capex * UPGRADE_COST_MULT * UPGRADE_COST_GROWTH ** (level - 1))


# --------------------------------------------------------------------------- #
# Makro model — faucet je DEMAND-CONSTRAINED
# --------------------------------------------------------------------------- #
#
# Klíčová oprava oproti naivnímu modelu: faucet NENÍ „co firma vyrobí, to prodá".
# Faucet je omezený NPC poptávkou. Když světová retail kapacita převýší poptávku
# zákazníků, zboží zůstává neprodané (a propadá = goods sink) a faucet se smrskne.
#
#   retail_pool(den) = NPC_populace(den) × útrata_na_obyvatele      [$/den, svět]
#   fill_rate_retail = min(1, retail_pool / Σ světová retail kapacita)
#
# Tohle je ta chybějící negativní zpětná vazba. Bez ní model ukazuje hyperinflaci
# (M2 300k → 5,7 mld za 120 dní). S ní je raná hra supply-constrained (tukové
# marže, rychlý růst) a pozdní demand-constrained (marže komprimované konkurencí).
# Přesně tak funguje retail simulace v Sim Companies.
#
# DVA faucety:
#   1. RETAIL          — NPC zákazníci, tier 3, zapíná se pozdě
#   2. STÁTNÍ ZAKÁZKY  — stát kupuje za 85 % mid, funguje od dne 1, podíl klesá
#                        s vyspělostí ekonomiky (narativně „privatizace")
# BURZA je TRANSFER — v M2 se vyruší, není faucet ani sink.
#
GOV_PRICE_DISCOUNT = _env('GOV_PRICE_DISCOUNT', 0.85)
DISPOSAL_MULT = _env('DISPOSAL_MULT', 1.00)      # kolik zisku hráči reálně utratí
STARTING_CAPITAL = 25_000
SEASON_DAYS = 120

NPC_SPEND_PER_DAY = _env('NPC_SPEND_PER_DAY', 0.20)       # $ na obyvatele/den — škáluje retail pool
RETAIL_FILL_TARGET = _env('RETAIL_FILL_TARGET', 0.85)      # cíl: svět je na konci sezóny o 25 % předimenzovaný
GOV_FILL_TARGET = _env('GOV_FILL_TARGET', 0.70)
POOL_RAMP_START = _env('POOL_RAMP_START', 0.20)         # NPC populace na začátku = 20 % konečné

WEALTH_TAX_WEEKLY = _env('WEALTH_TAX_WEEKLY', 0.003)
EXIT_RATE_MAX = _env('EXIT_RATE_MAX', 0.03)     # max podíl ztrátové kohorty, co denně odejde
EXIT_SENS = _env('EXIT_SENS', 0.10)             # citlivost exitu na hloubku ztráty      # 0,3 %/týden z hotovosti nad prahem — backstop
WEALTH_TAX_THRESHOLD = _env('WEALTH_TAX_THRESHOLD', 500_000)

# Korporátní režie: SUPERLINEÁRNÍ, kalibrovaná AUTOMATICKY z vypočtených marží,
# aby poměr k hrubému byl ~10 % @ N=5 a rostl jako N^0,45.
HQ_BASE_SHARE = _env('HQ_BASE_SHARE', 0.06)
HQ_REF_N = 5.0
HQ_P = _env('HQ_P', 1.35)
HQ_FLOOR_A = _env('HQ_FLOOR_A', 0.80)
HQ_FLOOR_P = 1.20      # $/h — platí i při nulové marži


@dataclass
class Stage:
    label: str
    fleet: list[tuple[str, int, int]]
    retail_share: float          # podíl spotřebního zboží do retailu (zbytek na burzu)
    external_input_share: float
    gov_share: float             # podíl tržní produkce odkoupený státem
    reinvest_rate: float         # podíl zisku do capexu
    aspirational_rate: float     # podíl zisku do výzkumu/prestige/aukcí (sink)


STAGES = [
    Stage("Den 1-2 - STARTER",
          [("solar_plant", 1, 1), ("logging_camp", 1, 1), ("sawmill", 1, 1)],
          retail_share=0.00, external_input_share=0.35, gov_share=0.45,
          reinvest_rate=0.55, aspirational_rate=0.00),
    Stage("Den 5-9 - RANA EXPANZE",
          [("solar_plant", 1, 1), ("logging_camp", 2, 1), ("sawmill", 2, 1),
           ("grain_farm", 1, 1), ("flour_mill", 1, 1), ("bakery", 1, 1)],
          retail_share=0.60, external_input_share=0.50, gov_share=0.35,
          reinvest_rate=0.50, aspirational_rate=0.00),
    Stage("Den 10-45 - STREDNI FAZE",
          [("solar_plant", 2, 2), ("iron_mine", 2, 2), ("smelter", 2, 2),
           ("steel_mill", 1, 1), ("nail_press", 1, 2), ("furniture_factory", 2, 2),
           ("tool_works", 1, 1), ("logging_camp", 2, 2), ("sawmill", 2, 2),
           ("grain_farm", 2, 2), ("flour_mill", 1, 2), ("bakery", 2, 2)],
          retail_share=0.70, external_input_share=0.65, gov_share=0.22,
          reinvest_rate=0.50, aspirational_rate=0.10),
    Stage("Den 46+ - POZDNI FAZE",
          [("solar_plant", 4, 4), ("iron_mine", 6, 4), ("smelter", 5, 4),
           ("steel_mill", 4, 3), ("nail_press", 4, 4), ("wire_draw", 3, 4),
           ("electronics_lab", 3, 3), ("machine_shop", 2, 2),
           ("appliance_plant", 2, 2), ("tool_works", 3, 3),
           ("furniture_factory", 4, 4), ("garment_factory", 3, 3),
           ("logging_camp", 4, 4), ("sawmill", 3, 4), ("grain_farm", 4, 4),
           ("flour_mill", 2, 3), ("bakery", 3, 3), ("deli", 2, 2),
           ("textile_mill", 3, 3), ("cement_kiln", 2, 3), ("glass_works", 2, 3),
           ("refinery", 2, 3), ("quarry", 3, 4), ("oil_rig", 2, 3),
           ("cotton_farm", 3, 4)],
          retail_share=0.75, external_input_share=0.80, gov_share=0.12,
          reinvest_rate=0.45, aspirational_rate=0.25),
]

STAGE_BY_AGE = [(2, 0), (9, 1), (45, 2), (10 ** 9, 3)]


def stage_for_age(age_days: int) -> int:
    for limit, idx in STAGE_BY_AGE:
        if age_days <= limit:
            return idx
    return len(STAGES) - 1


BY_CODE = {b.code: b for b in BUILDINGS}


def capacity(s: Stage) -> dict[str, float]:
    """Kapacita firmy PŘED kompresí poptávkou — co by utržila, kdyby prodala vše."""
    n = sum(c for _, c, _ in s.fleet)
    sl = sum(c * lv for _, c, lv in s.fleet)

    out = dict(retail_mid=0.0, marketable_mid=0.0, inputs=0.0, upkeep=0.0,
               rent=0.0, wages=0.0, prop_tax=0.0, bought_in=0.0, n=n, sum_levels=sl,
               real_output=0.0)

    for code, count, level in s.fleet:
        b = BY_CODE[code]
        L = at_level(b, level)
        d = count * 24
        out["upkeep"] += L.upkeep * d
        out["rent"] += PLOT_RENT[b.plot] * d
        out["wages"] += L.wage * L.workers * d
        out["prop_tax"] += PLOT_VALUE[b.plot] * count * PROPERTY_TAX_WEEKLY / 7
        out["inputs"] += L.inputs_cost * d
        out["bought_in"] += L.inputs_cost * d * s.external_input_share

        share_retail = s.retail_share if b.retail else 0.0
        out["retail_mid"] += L.revenue * d * share_retail
        out["marketable_mid"] += L.revenue * d * (1 - share_retail)
        # realny vystup pri KONSTANTNICH zakladnich cenach -> Laspeyres index Y
        out["real_output"] += L.q_out * d * PRICES[b.out_item]
    return out


CAPACITY = [capacity(s) for s in STAGES]

# --- automatická kalibrace korporátní režie ---------------------------------
# capacity() uz vraci retail_mid / marketable_mid PODILOVANE podle retail_share,
# takze se tady uz zadnym podilem nenasobi (drivejsi double-count daval zaporne HQ_K,
# cimz byla rezije trvale prilepena na floor a knoflik HQ_BASE_SHARE byl mrtvy).
_margin_per_building = sum(
    c["retail_mid"] / EXCHANGE_TO_RETAIL + c["marketable_mid"]
    - c["inputs"] - c["upkeep"]
    for c in CAPACITY
) / sum(c["n"] for c in CAPACITY)
assert _margin_per_building > 0, (
    f"prumerna marze na budovu je {_margin_per_building:.2f} $/den -> kalibrace HQ by byla "
    f"zaporna. Zkontroluj capacity() a cenovou reseni.")

HQ_K = (HQ_BASE_SHARE * _margin_per_building * HQ_REF_N) / (HQ_REF_N ** HQ_P * 24)


def hq_overhead(n_buildings: int, sum_levels: int) -> float:
    """Korporátní režie $/h. Fixní náklad → při kompresi marží skutečně bolí."""
    variable = HQ_K * n_buildings ** HQ_P
    floor = HQ_FLOOR_A * n_buildings ** HQ_FLOOR_P
    return max(variable, floor)


def hq_share_of_margin(n: int) -> float:
    return hq_overhead(n, n) * 24 / max(1e-9, _margin_per_building * n)


# --------------------------------------------------------------------------- #
# Projekce světa — kohortový model s endogenní kompresí marží
# --------------------------------------------------------------------------- #

@dataclass
class WorldSim:
    days: int = SEASON_DAYS
    new_per_day_start: float = 12.0
    new_per_day_end: float = 40.0
    churn_daily: float = 0.006
    plateau_share: float = 0.40

    def _stage_of(self, reg: int, day: int) -> int:
        idx = stage_for_age(day - reg)
        if idx == 3 and (reg * 7 + day) % 100 < self.plateau_share * 100:
            return 2
        return idx

    def pools(self, retail_cap_120: float, gov_cap_120: float):
        """Denní pool NPC poptávky a státního rozpočtu."""
        out = []
        for day in range(1, self.days + 1):
            ramp = POOL_RAMP_START + (1 - POOL_RAMP_START) * (day / self.days)
            out.append((RETAIL_FILL_TARGET * retail_cap_120 * ramp,
                        GOV_FILL_TARGET * gov_cap_120 * ramp))
        return out

    def run(self) -> list[dict]:
        # PASS 1 — zjistit světovou kapacitu na konci sezóny (bez komprese)
        cohorts: dict[int, float] = {}
        cap_retail = cap_gov = 0.0
        for day in range(1, self.days + 1):
            f = (day - 1) / max(1, self.days - 1)
            cohorts[day] = self.new_per_day_start + (self.new_per_day_end
                                                     - self.new_per_day_start) * f
            for d in list(cohorts):
                cohorts[d] *= (1 - self.churn_daily)
            cap_retail = cap_gov = 0.0
            for reg, c in cohorts.items():
                if c < 1e-9:
                    continue
                st = STAGES[self._stage_of(reg, day)]
                cp = CAPACITY[STAGES.index(st)]
                cap_retail += c * cp["retail_mid"] / EXCHANGE_TO_RETAIL
                cap_gov += c * cp["marketable_mid"] * st.gov_share * GOV_PRICE_DISCOUNT
        retail_cap_120, gov_cap_120 = cap_retail, cap_gov
        pools = self.pools(retail_cap_120, gov_cap_120)

        # PASS 2 — skutečný běh s kompresí
        cohorts = {}
        cash: dict[int, float] = {}
        rows = []
        m2 = 0.0
        for day in range(1, self.days + 1):
            f = (day - 1) / max(1, self.days - 1)
            joined = self.new_per_day_start + (self.new_per_day_end
                                               - self.new_per_day_start) * f
            cohorts[day] = cohorts.get(day, 0.0) + joined
            cash[day] = cash.get(day, 0.0) + joined * STARTING_CAPITAL
            seeded = joined * STARTING_CAPITAL   # startovní kapitál JE faucet (tisk peněz)
            for d in list(cohorts):
                cohorts[d] *= (1 - self.churn_daily)
                cash[d] *= (1 - self.churn_daily)
            m2 += joined * STARTING_CAPITAL

            # agregátní kapacita světa -> fill rates
            tot_retail = tot_gov = 0.0
            per: dict[int, int] = {}
            for reg, c in cohorts.items():
                if c < 1e-9:
                    continue
                i = self._stage_of(reg, day)
                per[reg] = i
                cp = CAPACITY[i]
                tot_retail += c * cp["retail_mid"] / EXCHANGE_TO_RETAIL
                tot_gov += c * cp["marketable_mid"] * STAGES[i].gov_share * GOV_PRICE_DISCOUNT

            retail_pool, gov_pool = pools[day - 1]
            fr_retail = min(1.0, retail_pool / tot_retail) if tot_retail else 1.0
            fr_gov = min(1.0, gov_pool / tot_gov) if tot_gov else 1.0

            players = faucet = sinks = dM = wealth = Y = 0.0
            faucet += seeded
            dM += seeded
            exits: dict[int, float] = {}
            for reg, cnt in cohorts.items():
                if cnt < 1e-9 or reg not in per:
                    continue
                i = per[reg]
                st, cp = STAGES[i], CAPACITY[i]

                retail_real = cnt * cp["retail_mid"] / EXCHANGE_TO_RETAIL * fr_retail
                gov_real = cnt * cp["marketable_mid"] * st.gov_share * GOV_PRICE_DISCOUNT * fr_gov
                exch_real = cnt * cp["marketable_mid"] * (1 - st.gov_share) * fr_retail

                c_rent = cnt * cp["rent"]
                c_wage = cnt * cp["wages"]
                c_hq = cnt * hq_overhead(cp["n"], cp["sum_levels"]) * 24
                c_prop = cnt * cp["prop_tax"]
                c_inputs = cnt * cp["bought_in"]
                c_upkeep = cnt * cp["upkeep"]
                c_fee = (exch_real + c_inputs * 0.5) * EXCHANGE_FEE_AVG
                c_rtax = retail_real * RETAIL_SALES_TAX

                per_firm_cash = cash[reg] / cnt
                c_wealth = cnt * WEALTH_TAX_WEEKLY / 7 * max(
                    0.0, per_firm_cash - WEALTH_TAX_THRESHOLD)

                revenue = retail_real + gov_real + exch_real
                profit = revenue - c_inputs - c_upkeep - c_rent - c_wage - c_hq - c_fee - c_rtax - c_prop
                disposal = min(0.97, (st.reinvest_rate + st.aspirational_rate) * DISPOSAL_MULT)
                capex = max(0.0, profit) * disposal

                f_faucet = retail_real + gov_real
                f_sinks = (c_rent + c_wage + c_hq + c_fee + c_rtax + c_prop
                           + capex + c_wealth)

                players += cnt
                faucet += f_faucet
                sinks += f_sinks
                wealth += c_wealth
                # realizovaný výstup = kapacita × fill; neprodané propadá = goods sink
                tot_mid = cp["retail_mid"] + cp["marketable_mid"]
                w_ret = cp["retail_mid"] / tot_mid if tot_mid > 0 else 1.0
                Y += cnt * cp["real_output"] * (fr_retail * w_ret + fr_gov * (1 - w_ret))
                d = f_faucet - f_sinks
                dM += d
                cash[reg] += d
                m2 += d
                exits[reg] = profit / max(1.0, cnt)
                if cash[reg] < 0:                 # nemůže utrácet víc, než má
                    m2 += cash[reg]
                    dM += cash[reg]
                    cash[reg] = 0.0

            # ---- REAKCE KAPACITY ----
            # Ztrátové firmy částečně vystoupí (prodají/idlou budovy, odejdou ze hry).
            # Tím klesne světová kapacita -> fill rate příští den stoupne -> marže se
            # zotaví. Tohle je ta negativní zpětná vazba, která v reálné ekonomice tvoří
            # rovnováhu; bez ní model jen krvácí do záporného M2.
            bankrupt = 0.0
            for reg, per_firm_profit in exits.items():
                if cash[reg] <= 0:
                    # bankrot: hotovost je 0, firma končí. M2 se nemění (cash=0 odchází).
                    bankrupt += cohorts[reg]
                    m2 -= cash[reg]
                    cohorts[reg] = 0.0
                    cash[reg] = 0.0
                elif per_firm_profit < 0:
                    fixed = (CAPACITY[per[reg]]["rent"] + CAPACITY[per[reg]]["prop_tax"]
                             + hq_overhead(CAPACITY[per[reg]]["n"],
                                           CAPACITY[per[reg]]["sum_levels"]) * 24)
                    # exit max 3 %/den — při 20 %/den systém osciluje (cobweb):
                    # kapacita zkolabuje, fill vyskočí na 1, všichni zase expandují.
                    frac = min(EXIT_RATE_MAX, (-per_firm_profit) / max(1.0, fixed) * EXIT_SENS)
                    lost_cash = cash[reg] * frac
                    cohorts[reg] *= (1 - frac)
                    cash[reg] -= lost_cash
                    m2 -= lost_cash
                    bankrupt += frac * cohorts[reg] / max(1e-9, 1 - frac)

            rows.append(dict(day=day, players=players, m2=m2, Y=Y,
                             exits=bankrupt,
                             faucet=faucet, sinks=sinks,
                             wealth_tax=wealth, delta_m=dM,
                             fr_retail=fr_retail, fr_gov=fr_gov,
                             retail_pool=retail_pool, gov_pool=gov_pool,
                             monthly_pct=(dM * 30 / m2 * 100) if m2 else 0.0,
                             per_firm=(m2 / players) if players else 0.0))

        # CPI drift z kvantitativni rovnice: %dP = %dM - %dY (mesicni, klouzave)
        for i, r in enumerate(rows):
            j = max(0, i - 30)
            if (rows[j]["m2"] > 1e-6 and rows[j]["Y"] > 1e-6
                    and r["m2"] > 1e-6 and r["Y"] > 1e-6 and i > j):
                gm = (r["m2"] / rows[j]["m2"]) ** (30 / max(1, i - j)) - 1
                gy = (r["Y"] / rows[j]["Y"]) ** (30 / max(1, i - j)) - 1
                r["cpi_monthly"] = (gm - gy) * 100
                r["m2_monthly"] = gm * 100
                r["y_monthly"] = gy * 100
            else:
                r["cpi_monthly"] = r["m2_monthly"] = r["y_monthly"] = 0.0
        return rows


def evaluate(s: Stage) -> dict[str, float]:
    """P&L jedné reprezentativní firmy BEZ komprese (plná fill rate = 1)."""
    cp = capacity(s)
    retail_real = cp["retail_mid"] / EXCHANGE_TO_RETAIL
    gov_real = cp["marketable_mid"] * s.gov_share * GOV_PRICE_DISCOUNT
    exch_real = cp["marketable_mid"] * (1 - s.gov_share)
    hq = hq_overhead(cp["n"], cp["sum_levels"]) * 24
    fees = (exch_real + cp["bought_in"] * 0.5) * EXCHANGE_FEE_AVG
    rtax = retail_real * RETAIL_SALES_TAX
    profit = (retail_real + gov_real + exch_real - cp["bought_in"] - cp["upkeep"]
              - cp["rent"] - cp["wages"] - hq - fees - rtax - cp["prop_tax"])
    disposal = min(0.97, (s.reinvest_rate + s.aspirational_rate) * DISPOSAL_MULT)
    capex = max(0.0, profit) * disposal
    faucet = retail_real + gov_real
    sinks = cp["rent"] + cp["wages"] + hq + fees + rtax + cp["prop_tax"] + capex
    return dict(**cp, retail_faucet=retail_real, gov_faucet=gov_real, faucet=faucet,
                exchange_transfer=exch_real, hq=hq, fees=fees, retail_tax=rtax,
                capex=capex, profit=profit, sinks=sinks, delta_m=faucet - sinks,
                hq_share=hq_share_of_margin(cp["n"]))


RESULTS = [evaluate(s) for s in STAGES]



# --------------------------------------------------------------------------- #
# Render
# --------------------------------------------------------------------------- #

def m(x: float) -> str:
    """Formátování peněz."""
    a = abs(x)
    sign = "−" if x < 0 else ""
    if a >= 1_000_000:
        return f"{sign}{a/1_000_000:.2f} M"
    if a >= 1000:
        return f"{sign}{a:,.0f}".replace(",", " ")
    if a >= 10:
        return f"{sign}{a:,.1f}".replace(",", " ")
    if a >= 1:
        return f"{sign}{a:.2f}"
    return f"{sign}{a:.4f}"


def render() -> str:
    L: list[str] = []
    A = L.append

    A("# Balance v0.2 — generováno automaticky")
    A("")
    A("> ⚠️ **Generuje `tools/balance/generate_v0.py`. NEUPRAVOVAT RUČNĚ.**")
    A("> Retuning: změň `m` / `payback` / `q_out` ve skriptu a spusť znovu.")
    A("> `python3 tools/balance/generate_v0.py`")
    A("")
    A(f"Konstanty: údržba = {K_UPKEEP:.1%} capex/h · burzovní mid = "
      f"{EXCHANGE_TO_RETAIL:.0%} retail základu · max úroveň {MAX_LEVEL}")
    A("")

    # --- ceník ---
    A("## 1. Ceník položek")
    A("")
    A("| Položka | Tier | Burzovní mid | Retail základ | Zdroj |")
    A("|---|---|---:|---:|---|")
    src = {b.out_item: b.name for b in BUILDINGS}
    tier_of = {b.out_item: b.tier for b in BUILDINGS}
    for item, p in sorted(PRICES.items(), key=lambda kv: (tier_of[kv[0]], kv[0])):
        ret = f"{RETAIL[item]:.2f} $" if item in RETAIL else "—"
        A(f"| `{item}` | {tier_of[item]} | {p:.4f} $ | {ret} | {src[item]} |")
    A("")

    # --- budovy ---
    A("## 2. Budovy a recepty (úroveň 1)")
    A("")
    A("| Budova | Pozemek | Vstupy /h | Výstup /h | Sklad | Plnění | Capex | Údržba | "
      "Návrat. | Jedn. náklad | Cena | Marže |")
    A("|---|---|---|---|---:|---|---:|---:|---:|---:|---:|---:|")
    for b in sorted(BUILDINGS, key=lambda x: (x.tier, x.code)):
        ins = ", ".join(f"{int(q)} `{i}`" for i, q in b.inputs.items()) or "—"
        mreal = 1 - (b.inputs_cost + b.upkeep) / b.revenue
        A(f"| **{b.name}** `{b.code}` | {b.plot} | {ins} | {int(b.q_out)} `{b.out_item}` "
          f"| {int(b.storage)} | {b.storage / b.q_out:.1f} h | {m(b.capex)} $ "
          f"| {m(b.upkeep)}/h | {b.payback:.0f} h | {b.unit_cost:.4f} $ "
          f"| {PRICES[b.out_item]:.4f} $ | {mreal:.0%} |")
    A("")
    A("**Plnění skladu ~1,5–1,8 h u všech budov** — to je záměrné. Sklad je ventil: "
      "výroba běží offline, dokud se nenaplní. Konstantní doba plnění napříč tiery znamená "
      "konstantní rytmus vracení se ke hře.")
    A("")

    # --- úrovně ---
    A("## 3. Škálování úrovní")
    A("")
    A("```")
    A(f"propustnost  × (1 + {LEVEL_THROUGHPUT:.2f}·(L−1))")
    A(f"údržba       × (1 + {LEVEL_UPKEEP:.2f}·(L−1))   ← roste POMALEJI než propustnost")
    A(f"sklad        × (1 + {LEVEL_STORAGE:.2f}·(L−1))")
    A(f"upgrade L→L+1 = {UPGRADE_COST_MULT} · capex_L1 · {UPGRADE_COST_GROWTH}^(L−1)")
    A("```")
    A("")
    A("Protože údržba roste pomaleji než propustnost, **jednotkové náklady s úrovní klesají** "
      "(ekonomika z rozsahu ve výrobě). Diseconomie rozsahu je záměrně vytažená VEN z výroby "
      "a dána do korporátní režie (§4) — aby se trestala velikost *říše*, ne efektivní výroba.")
    A("")
    ex = next(b for b in BUILDINGS if b.code == "furniture_factory")
    A("| Úroveň | Výstup /h | Jedn. náklad | Údržba | Capex upgradu | Pracovníci | Mzda |")
    A("|---:|---:|---:|---:|---:|---:|---:|")
    for lv in range(1, MAX_LEVEL + 1):
        Lx = at_level(ex, lv)
        uc = (Lx.inputs_cost + Lx.upkeep) / Lx.q_out
        up = m(upgrade_cost(ex, lv)) if lv < MAX_LEVEL else "—"
        A(f"| L{lv} | {Lx.q_out:.0f} | {uc:.4f} $ | {m(Lx.upkeep)}/h | {up} $ "
          f"| {Lx.workers} | {Lx.wage:.2f} $/h |")
    A("")
    uc1 = (ex.inputs_cost + ex.upkeep) / ex.q_out
    uc5 = (at_level(ex, MAX_LEVEL).inputs_cost + at_level(ex, MAX_LEVEL).upkeep) / at_level(ex, MAX_LEVEL).q_out
    A(f"*(příklad: {ex.name} — jednotkový náklad klesá z {uc1:.4f} $ na {uc5:.4f} $)*")
    A("")

    # --- režie ---
    A("## 4. Korporátní režie — diseconomie rozsahu")
    A("")
    A("```")
    A(f"hq_overhead($/h) = {HQ_A} · N_budov^{HQ_P} + {HQ_B} · Σ_úrovní^{HQ_Q}")
    A("```")
    A("")
    A("| N budov | Režie $/h | Režie $/den | Podíl na hrubém zisku |")
    A("|---:|---:|---:|---:|")
    for n in [2, 5, 12, 25, 50, 100, 200]:
        o = hq_overhead(n, n)
        A(f"| {n} | {m(o)} | {m(o*24)} | {hq_share_of_margin(n):.1%} |")
    A("")
    A("Hrubý zisk škáluje ~lineárně s N, režie s N^1,45 → **poměr roste jako N^0,45**: "
      "~10 % @ N=5, ~30 % @ N=50, ~50 % @ N=200. Velká říše se dusí vlastní vahou. "
      "Tohle je hlavní strukturální brzda oligarchie — spolu se sezónními resety.")
    A("")

    # --- pozemky ---
    A("## 5. Pozemky")
    A("")
    A("| Typ | Počet | Nájem $/h | Nájem $/den (plno) | Odhadní cena | Daň $/týden |")
    A("|---|---:|---:|---:|---:|---:|")
    tot = 0.0
    for t, n in PLOT_COUNT.items():
        tot += n * PLOT_RENT[t] * 24
        A(f"| `{t}` | {n} | {PLOT_RENT[t]:.2f} | {m(n*PLOT_RENT[t]*24)} "
          f"| {m(PLOT_VALUE[t])} $ | {m(PLOT_VALUE[t]*PROPERTY_TAX_WEEKLY)} |")
    A(f"| **Σ** | **{sum(PLOT_COUNT.values())}** | | **{m(tot)} $/den** | | |")
    A("")
    A(f"Nájem + daň z nemovitosti = **{m(tot)} $/den** recurring sink na svět při plné "
      f"obsazenosti, plus jednorázový sink z dražeb na začátku sezóny.")
    A("")

    # --- makro ---
    A("## 6. Makro model: faucet vs. sink vs. ΔM")
    A("")
    A("**Faucet je demand-constrained, ne capacity-constrained.** Firma neutrhne to, co vyrobí,")
    A("ale to, co jí dovolí prodat NPC poptávka:")
    A("")
    A("```")
    A("retail_pool(den)  = NPC_populace(den) × útrata_na_obyvatele")
    A("fill_rate_retail  = min(1, retail_pool / Σ světová retail kapacita)")
    A("```")
    A("")
    A("Když světová kapacita převýší poptávku, `fill_rate < 1` → zboží zůstává neprodané")
    A("(propadá = goods sink) a faucet se smrskne. **To je ta negativní zpětná vazba,**")
    A("která drží ekonomiku stabilní. Bez ní model ukazuje hyperinflaci (viz §7 poznámka).")
    A("")
    A("Dva faucety: **RETAIL** (NPC zákazníci, tier 3) a **STÁTNÍ ZAKÁZKY** (odkup za")
    A(f"{GOV_PRICE_DISCOUNT:.0%} mid, funguje od dne 1, podíl klesá s vyspělostí ekonomiky).")
    A("**Burza je TRANSFER** — v M2 se vyruší, není faucet ani sink.")
    A("")
    A("Vše v $/den na jednu reprezentativní firmu, **při plné poptávce (fill = 1)**:")
    A("")
    A("| Fáze | Bud. | **RETAIL**<br>faucet | **STÁT**<br>faucet | **Σ FAUCET** | Burza<br>(transfer) |")
    A("|---|---:|---:|---:|---:|---:|")
    for s, r in zip(STAGES, RESULTS):
        A(f"| **{s.label}** | {r['n']} | {m(r['retail_faucet'])} | {m(r['gov_faucet'])} "
          f"| **{m(r['faucet'])}** | {m(r['exchange_transfer'])} |")
    A("")
    A("| Fáze | Nájem | Mzdy | Režie HQ | Poplatky | Daň<br>retail | Daň<br>nemov. | Capex | "
      "**Σ SINK** | Zisk | **ΔM** |")
    A("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for s, r in zip(STAGES, RESULTS):
        A(f"| **{s.label}** | {m(r['rent'])} | {m(r['wages'])} | {m(r['hq'])} | {m(r['fees'])} "
          f"| {m(r['retail_tax'])} | {m(r['prop_tax'])} | {m(r['capex'])} "
          f"| **{m(r['sinks'])}** | {m(r['profit'])} | **{m(r['delta_m'])}** |")
    A("")
    A(f"Režie HQ je kalibrovaná automaticky z vypočtených marží: `HQ_K = {HQ_K:.4f}` $/h, "
      f"což dává ~{HQ_BASE_SHARE:.0%} hrubého zisku při N={HQ_REF_N:.0f} budovách a roste "
      f"jako N^{HQ_P-HQ_REF_N+HQ_REF_N:.2f} (poměr tedy jako N^{HQ_P-1:.2f}).")
    A("")

    # --- projekce světa ---
    A("## 7. Projekce světa (kohortový model s kompresí marží)")
    A("")
    W = WorldSim()
    rows = W.run()
    A(f"Předpoklady: {W.days} dní · {W.new_per_day_start:.0f}–{W.new_per_day_end:.0f} nových "
      f"firem/den · churn {W.churn_daily:.1%}/den · {W.plateau_share:.0%} hráčů plateauje "
      f"ve střední fázi · startovní kapitál {m(STARTING_CAPITAL)} $ · cílová fill rate "
      f"retail {RETAIL_FILL_TARGET:.0%}, stát {GOV_FILL_TARGET:.0%} · daň z bohatství "
      f"{WEALTH_TAX_WEEKLY:.1%}/týden nad {m(WEALTH_TAX_THRESHOLD)} $.")
    A("")
    A("| Den | Firem | **M2** | $/firmu | Fill<br>ret | Fill<br>stát | Faucet/den | "
      "Sinks/den | **ΔM/den** | ΔM2<br>/měs | ΔY<br>/měs | **CPI<br>/měs** |")
    A("|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|")
    for r in rows:
        if r["day"] in (1, 7, 14, 30, 45, 60, 90, 120):
            cpi = r["cpi_monthly"]
            if r["day"] < 45:
                # warm-up: báze je near-zero, růstová procenta jsou degenerovaná
                g_m = g_y = g_p = "—"
            else:
                flag = "" if 1 <= cpi <= 6 else (" 🔥" if cpi > 6 else " ❄️")
                g_m = f"{r['m2_monthly']:+.1f} %"
                g_y = f"{r['y_monthly']:+.1f} %"
                g_p = f"**{cpi:+.1f} %**{flag}"
            A(f"| {r['day']} | {r['players']:,.0f} | **{m(r['m2'])} $** "
              f"| {m(r['per_firm'])} | {r['fr_retail']:.2f} | {r['fr_gov']:.2f} "
              f"| {m(r['faucet'])} | {m(r['sinks'])} | **{m(r['delta_m'])}** "
              f"| {g_m} | {g_y} | {g_p} |")
    A("")
    last = rows[-1]
    A(f"**Výsledek:** M2 na konci sezóny **{m(last['m2'])} $** při {last['players']:,.0f} "
      f"firmách → průměr {m(last['per_firm'])} $/firmu "
      f"({last['per_firm']/STARTING_CAPITAL:.1f}× startovního kapitálu). "
      f"CPI drift **{last['cpi_monthly']:+.1f} %/měsíc** = růst M2 {last['m2_monthly']:+.1f} % "
      f"− růst reálného výstupu {last['y_monthly']:+.1f} %.")
    A("")
    A("### 7.1 Proč CPI, a ne ΔM/M2")
    A("")
    A("Z kvantitativní rovnice `M·V = P·Y` plyne `%ΔP = %ΔM + %ΔV − %ΔY`. Při zhruba konstantní")
    A("rychlosti oběhu tedy:")
    A("")
    A("```")
    A("CPI drift (%/měsíc)  =  růst M2 (%/měsíc)  −  růst reálného výstupu Y (%/měsíc)")
    A("```")
    A("")
    A("**Rostoucí herní ekonomika vyrábí víc zboží.** Když se svět rozroste z 12 na 2 359 firem,")
    A("reálný výstup Y roste desítkami procent měsíčně, a M2 tedy *musí* růst podobně rychle,")
    A("jen aby cenová hladina stála. Cílit přímo `ΔM/M2 = 2–4 %` by trestalo zdravý růst.")
    A("Správný cíl je **CPI drift 1–4 %/měsíc**.")
    A("")
    A("### 7.2 Zjištění: model je bistabilní — a proč to není chyba ladění")
    A("")
    A("Parametrický sweep (`tools/balance/tune.py`, 972 kombinací) nenašel stabilní střed.")
    A("Našel dva režimy a přímou úměru mezi nimi:")
    A("")
    A("| disposal (kolik zisku hráči utratí) | CPI/měs | Přeživších firem | M2 | Bohatství |")
    A("|---|---:|---:|---:|---:|")
    A("| 0,70 | **+141 %** | 2 359 (všechny) | 2 595 M | 44× startu |")
    A("| 0,97 | **+1,5 %** | 679 (72 % mrtvých) | 10 M | 0,6× startu |")
    A("")
    A("**CPI stabilitu lze v tomhle modelu dosáhnout pouze zabitím ekonomiky.** To není špatně")
    A("nastavený knoflík — je to chybějící mechanismus.")
    A("")
    A("#### Diagnóza")
    A("")
    A("Model používá `fill_rate` jako proxy za cenovou adjustaci. Jenže `fill_rate` snižuje")
    A("**tržby, aniž by snižoval náklady**. V reálném order booku to funguje jinak: když je")
    A("přebytek nabídky, klesne *cena* — a s ní klesnou nominální tržby **i nominální náklady")
    A("na vstupy** současně, protože vstupy se kupují na téže burze. Marže v poměrovém vyjádření")
    A("zůstává zachována; mění se jen cenová hladina.")
    A("")
    A("Proto:")
    A("")
    A("1. **Sinky vázané na zisk (capex, výzkum) se samy vyradí**, když komprese srazí zisk")
    A("   k nule — `capex = max(0, profit) × disposal`. Přestávají tlumit přesně ve chvíli,")
    A("   kdy by tlumit měly.")
    A("2. **Sinky nominální a fixní (režie HQ, nájem, daň z nemovitosti) při kompresi drtí**,")
    A("   protože neklesají spolu s tržbami → bankrotová kaskáda.")
    A("3. Reprezentativní-firma model **neumí tvořit ceny**. Rovnováha vzniká až v order booku.")
    A("")
    A("#### Důsledky pro návrh (závazné)")
    A("")
    A("- **Anti-inflační zátěž musí nést NOMINÁLNÍ sinky** (nájem, režie, daně, mzdy indexované")
    A("  na CPI). Capex a výzkum jsou bonus, ne páteř — vypadnou přesně když je potřeba.")
    A("- **Režie HQ nesmí být čistě fixní.** Návrh: 60 % fixní (škáluje s N^1,45) + 40 % z hrubé")
    A("  marže. Fixní složka tworí tlak, plovoucí složka brání bankrotové kaskádě.")
    A("- **Vstupy se musí kupovat na burze, ne za tabulkové ceny.** Jenom tak při poklesu cenové")
    A("  hladiny klesnou náklady spolu s tržbami a marže přežijí. To je argument PRO hluboký")
    A("  order book a PROTI jakémukoli „NPC výkupu za fixní cenu“ v pozdní hře.")
    A("- **Sezónní reset (ADR-003) je nosný mechanismus, ne volitelná kosmetika.** Uvnitř jedné")
    A("  sezóny, kde hráčská báze roste 200×, nelze držet CPI v pásmu laděním sinků. Reset")
    A("  peněžní zásoby je to, co inflaci řeší strukturálně.")
    A("- **Agent-based simulátor s endogenní tvorbou cen (doc 70) je nutnost, ne nice-to-have.**")
    A("  Statický model odvodil konzistentní ceny (§1–§5) a odhalil strukturální problém;")
    A("  rovnováhu ale najít neumí a ani nemůže.")
    A("")
    A("**Praktický závěr pro MVP:** tabulka cen v §1–§2 je použitelná jako *seed* pro order book")
    A("a NPC market makera. Makro stabilitu ale nelze zaručit tabulkově — bude se ladit za běhu")
    A("podle denního makro dashboardu (`daily_snapshots`) a první sezóna se musí brát jako")
    A("kalibrační běh, ne jako hotový produkt.")
    A("")
    A("**Jak číst fill rate:** `1.00` = svět je supply-constrained (vyprodáno, tukové marže, "
      "typicky raná hra). `< 1.00` = demand-constrained (přebytek kapacity, marže komprimované "
      "konkurencí). Přechod z 1.00 na ~0.75 během sezóny je přesně ta žádoucí dynamika: "
      "raní hráči mají šanci vyrůst, pozdní hráči musí soutěžit.")
    A("")
    A("⚠️ *Model počítá reprezentativní firmu per fáze; reálná distribuce je širší a velryby "
      "táhnou průměr. Slouží k řádovému ladění. Přesné číslo dá agent-based simulátor "
      "(`docs/70-ekonomicky-simulator.md`), kde má každý hráč vlastní strategii.*")
    A("")

    # --- knoflíky ---
    A("## 8. Ladící knoflíky — co otočit, když metrika ujede")
    A("")
    A("| Symptom | Knoflík | Směr | Poznámka |")
    A("|---|---|---|---|")
    A("| ΔM/M2 > 6 %/měs (inflace) | `RETAIL_FILL_TARGET` | ↓ | víc přebytečné kapacity → menší faucet |")
    A("| ″ | `GOV_FILL_TARGET`, `gov_share` | ↓ | stát přestane tisknout |")
    A("| ″ | `WEALTH_TAX_WEEKLY` | ↑ | backstop na hromadění hotovosti |")
    A("| ″ | `HQ_BASE_SHARE` / `HQ_P` | ↑ | víc dusí velké říše |")
    A("| ″ | `aspirational_rate` | ↑ | výzkum/prestige/aukce pohltí zisk |")
    A("| ΔM/M2 < 1 % nebo záporné (deflace) | `RETAIL_FILL_TARGET` | ↑ | víc poptávky |")
    A("| ″ | `NPC_SPEND_PER_DAY`, `POOL_RAMP_START` | ↑ | větší/rychlejší pool |")
    A("| ″ | `gov_share` v raných fázích | ↑ | stát podpoří studený start |")
    A("| Nováček nemá šanci proti veteránovi | `HQ_P` | ↑ (1,45→1,60) | ostřejší diseconomie rozsahu |")
    A("| ″ | `WEALTH_TAX_THRESHOLD` | ↓ | zdaní dříve |")
    A("| ″ | `PROPERTY_TAX_WEEKLY` | ↑ | daň z nahromaděné půdy |")
    A("| Trh mrtvý, všichni vyrábí sami | `PLOT_COUNT` depositů | ↓ | vzácnější pozemky → nutí kupovat |")
    A("| ″ | marže `m` tieru 1–2 | ↑ | zpracování se musí vyplatit vs. integrace |")
    A("| Extrakce příliš tučná | `m` tieru 0 | ↓ (0,70→0,60) | nebo ↑ `PLOT_RENT` depositů |")
    A("| Pozdní hra je grind bez odměny | `payback` tieru 3 | ↓ | rychlejší návratnost |")
    A("| Order book závodí ke dnu | `quality_tier` | zapnout | segmentace booku, viz ADR-008 |")
    A("")
    A("**Pořadí páky podle síly:** `RETAIL_FILL_TARGET` > `gov_share` > `HQ_BASE_SHARE` > "
      "`aspirational_rate` > `WEALTH_TAX_WEEKLY` > daně z pozemků. Vždy toč nejdřív fauceten, "
      "pak sinky — daň z bohatství je backstop, ne primární nástroj.")
    A("")

    # --- pravidla ---
    A("## 9. Design pravidla, která model drží pohromadě")
    A("")
    A("1. **Maržový žebříček klesá s tierem** (70 % → 24 %). Extrakce je nejtučnější, ale "
      "gated vzácnými pozemky s deposit (`forest` 40, `mine` 30, `water` 18 z 288). "
      "Zpracování je hubené a závislé na cizích vstupech → **nuttí obchodovat**.")
    A(f"2. **Burzovní mid = {EXCHANGE_TO_RETAIL:.0%} retail základu.** Burza rychlá za nižší cenu, "
      "retail pomalý a nejistý za vyšší. Jádro rozhodování.")
    A("3. **Návratnost roste s tierem** (18 h u farmy → 108 h u spotřebičů).")
    A("4. **Údržba = 1,5 % capex/h**, roste s úrovní pomaleji než propustnost → výroba má "
      "ekonomiku z rozsahu. Diseonomie rozsahu je záměrně vytažená VEN do korporátní režie, "
      "aby trestala velikost *říše*, ne efektivní výrobu.")
    A("5. **Režie HQ je FIXNÍ náklad** (ne % ze zisku), kalibrovaný automaticky z marží. "
      "Když komprese poptávky srazí tržby, režie zůstává → velké říše jsou zranitelné na "
      "pokyv cen. To je záměrná negativní zpětná vazba.")
    A("6. **Doba plnění skladu ~1,5–1,8 h u všech budov.** Sklad je ventil: výroba běží "
      "offline, dokud se nenaplní. Rytmus hry se s progresem nemění, roste jen *počet* "
      "věcí, které sleduješ.")
    A("7. **Dva faucety s opačným průběhem.** Stát dominuje raně (45 %), retail pozdní fázi "
      "(75 %). Součet je stabilní → ΔM nekouše.")
    A("8. **Neprodané retail zboží propadá.** Není to jen ztracená tržba — je to goods sink, "
      "který brání hromadění zásob a drží tlak na přesné plánování výroby.")
    A("")
    return "\n".join(L)




def main() -> None:
    root = pathlib.Path(__file__).resolve().parents[2]
    (root / "docs" / "generated").mkdir(parents=True, exist_ok=True)
    (root / "seed").mkdir(parents=True, exist_ok=True)

    (root / "docs" / "generated" / "balance-v0.2.md").write_text(render(), encoding="utf-8")

    seed = {
        "version": "0.2.0",
        "constants": {
            "upkeep_rate_of_capex_per_hour": K_UPKEEP,
            "exchange_to_retail_ratio": EXCHANGE_TO_RETAIL,
            "level_throughput_mult": LEVEL_THROUGHPUT,
            "level_upkeep_mult": LEVEL_UPKEEP,
            "level_storage_mult": LEVEL_STORAGE,
            "upgrade_cost": f"capex_L1 * {UPGRADE_COST_MULT} * {UPGRADE_COST_GROWTH}^(L-1)",
            "max_level": MAX_LEVEL,
            "hq_overhead": f"{HQ_A}*N^{HQ_P} + {HQ_B}*sum_levels^{HQ_Q}",
            "wage_base": WAGE_BASE,
            "wage_level_growth": WAGE_LEVEL_GROWTH,
            "retail_sales_tax": RETAIL_SALES_TAX,
            "exchange_fee_avg": EXCHANGE_FEE_AVG,
            "property_tax_weekly": PROPERTY_TAX_WEEKLY,
        },
        "prices": PRICES,
        "retail_base": RETAIL,
        "plot_rent": PLOT_RENT,
        "plot_value": PLOT_VALUE,
        "plot_count": PLOT_COUNT,
        "buildings": [
            {
                "code": b.code, "name": b.name, "plot_type": b.plot, "tier": b.tier,
                "output_item": b.out_item, "output_qty_per_hour": b.q_out,
                "inputs": b.inputs, "storage_capacity": b.storage,
                "capex": b.capex, "upkeep_per_hour": b.upkeep,
                "build_time_seconds": b.build_time_s,
                "workers": 1,
                "target_gross_margin": b.m, "payback_hours": round(b.payback, 1),
                "unit_cost": round(b.unit_cost, 4),
                "exchange_mid_price": PRICES[b.out_item],
                "retail_base_price": RETAIL.get(b.out_item),
                "is_retail_product": b.retail,
                "levels": {
                    str(lv): {
                        "output_qty_per_hour": round(at_level(b, lv).q_out, 2),
                        "inputs_cost_per_hour": round(at_level(b, lv).inputs_cost, 4),
                        "upkeep_per_hour": round(at_level(b, lv).upkeep, 2),
                        "revenue_per_hour": round(at_level(b, lv).revenue, 2),
                        "net_per_hour": round(at_level(b, lv).net, 2),
                        "storage_capacity": round(at_level(b, lv).storage, 1),
                        "workers": at_level(b, lv).workers,
                        "wage_per_hour": round(at_level(b, lv).wage, 2),
                        "upgrade_cost_to_next": upgrade_cost(b, lv) if lv < MAX_LEVEL else None,
                    } for lv in range(1, MAX_LEVEL + 1)
                },
            }
            for b in sorted(BUILDINGS, key=lambda x: (x.tier, x.code))
        ],
        "macro_stages": [
            {"label": s.label, **{k: round(v, 2) for k, v in evaluate(s).items()}}
            for s in STAGES
        ],
    }
    (root / "seed" / "balance-v0.2.json").write_text(
        json.dumps(seed, indent=2, ensure_ascii=False), encoding="utf-8")

    print(f"✅ docs/generated/balance-v0.2.md")
    print(f"✅ seed/balance-v0.2.json")
    print(f"\n   {len(BUILDINGS)} budov · {len(PRICES)} položek · "
          f"{sum(PLOT_COUNT.values())} pozemků · {len(STAGES)} makro fází")
    print(f"   anchor: power = {PRICES['power']:.4f} $/kWh")
    print("\n   Makro ($/den na firmu):")
    for s in STAGES:
        r = evaluate(s)
        print(f"     {s.label:<28} faucet={m(r['faucet']):>10}  "
              f"sinks={m(r['sinks']):>10}  ΔM={m(r['delta_m']):>10}")


if __name__ == "__main__":
    main()
