#!/usr/bin/env python3
"""
Parametrický sweep ladicích knoflíků ekonomiky.

Hledá nastavení splňující cílové makro vlastnosti sezóny. Bez tohohle se vyvažuje
hádáním — s tímhle je to ~15 sekund výpočtu.

CÍLOVÁ METRIKA JE CPI DRIFT, NE ΔM/M2.
Z kvantitativní rovnice M·V = P·Y plyne %ΔP = %ΔM + %ΔV − %ΔY, a při zhruba
konstantní rychlosti oběhu:

        CPI drift (%/měsíc)  =  růst M2 (%/měsíc)  −  růst reálného výstupu Y (%/měsíc)

Rostoucí herní ekonomika vyrábí víc zboží (Y roste), takže M2 může růst výrazně
rychleji než 3 %/měsíc, ANIŽ by to byla inflace. Cílit přímo ΔM/M2 by bylo chybné —
trestalo by to zdravý růst.

Kritéria (vážená penalta):
  1. CPI drift na konci sezóny v [1, 4] %/měsíc       ← hlavní cíl
  2. CPI drift od 21. dne nikdy nad 12 %/měsíc        ← žádná inflační špička
  3. fill_rate_retail na konci v [0.40, 0.85]         ← komprese marží bolí, ale nezabíjí
  4. hotovost na firmu 5–60× startovního kapitálu     ← bohatství dává smysl
  5. ΔM > 0 od 21. dne                                ← žádná deflační spirála

Použití:
    python3 tools/balance/tune.py            # sweep
    python3 tools/balance/tune.py --apply    # zapíše vítěze do generate_v0.py
"""
from __future__ import annotations

import argparse
import importlib
import itertools
import os
import re
import sys
from dataclasses import dataclass

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Mřížka je omezená na VALIDNÍ režim: fill rate pod ~0,5 znamená, že svět je tak
# předimenzovaný, že většina firem prodělává a model degeneruje na bankrotovou kaskádu.
GRID = {
    "RETAIL_FILL_TARGET": [0.55, 0.70, 0.85, 1.00],
    "GOV_FILL_TARGET":    [0.40, 0.60, 0.80],
    "HQ_BASE_SHARE":      [0.06, 0.10, 0.14],
    "HQ_P":               [1.35, 1.45, 1.55],
    "WEALTH_TAX_WEEKLY":  [0.003, 0.015, 0.040],
    "DISPOSAL_MULT":      [1.00, 1.20, 1.40],
}

WARMUP_DAYS = 21     # nový svět má z malého základu vždy explozivní % růst — nehodnotíme


@dataclass
class Score:
    params: dict
    penalty: float
    cpi_end: float
    m2_end: float
    y_end: float
    cpi_worst: float
    fill_end: float
    wealth_mult: float
    min_dm: float


def evaluate_params(params: dict) -> Score | None:
    for k, v in params.items():
        os.environ[k] = str(v)
    import generate_v0
    importlib.reload(generate_v0)

    try:
        rows = generate_v0.WorldSim().run()
    except Exception as exc:                                    # noqa: BLE001
        print(f"   ! {params} -> {exc}")
        return None
    if not rows or rows[-1]["m2"] <= 0:
        return None

    last = rows[-1]
    mature = [r for r in rows if r["day"] > WARMUP_DAYS]
    if not mature:
        return None

    cpi_end = last["cpi_monthly"]
    cpi_worst = max(r["cpi_monthly"] for r in mature)
    fill_end = last["fr_retail"]
    wealth_mult = last["per_firm"] / generate_v0.STARTING_CAPITAL
    min_dm = min(r["delta_m"] for r in mature)

    pen = 0.0
    if cpi_end < 1:
        pen += 45 * (1 - cpi_end)
    elif cpi_end > 4:
        pen += 25 * (cpi_end - 4) ** 0.75
    if cpi_worst > 12:
        pen += 8 * (cpi_worst - 12) ** 0.6
    if not (0.40 <= fill_end <= 0.85):
        pen += 40 * min(abs(fill_end - 0.40), abs(fill_end - 0.85))
    if not (5 <= wealth_mult <= 60):
        pen += 25 * (abs(wealth_mult - 30) / 30)
    if min_dm < 0:
        pen += 20

    return Score(params, pen, cpi_end, last["m2_monthly"], last["y_monthly"],
                 cpi_worst, fill_end, wealth_mult, min_dm)


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true",
                    help="zapíše vítězné hodnoty jako nové defaulty do generate_v0.py")
    ap.add_argument("--top", type=int, default=12)
    args = ap.parse_args()

    keys = list(GRID)
    combos = list(itertools.product(*(GRID[k] for k in keys)))
    print(f"Sweep: {len(combos)} kombinací přes {len(keys)} knoflíků\n")

    results: list[Score] = []
    for i, vals in enumerate(combos, 1):
        sc = evaluate_params(dict(zip(keys, vals)))
        if sc:
            results.append(sc)
        if i % 120 == 0:
            print(f"  ...{i}/{len(combos)}")

    results.sort(key=lambda s: s.penalty)
    hdr = ("pen", "CPI", "ΔM2", "ΔY", "CPImax", "fill", "bohat.", "minΔM")
    print(f"\n{'='*118}")
    print(f"TOP {args.top}   (penalta ↓ lépe · cíl CPI 1–4 %/měsíc)")
    print(f"{'='*118}")
    print(f"{'pen':>7} | {'CPI':>7} | {'ΔM2':>7} | {'ΔY':>7} | {'CPI max':>8} | "
          f"{'fill':>5} | {'bohat.':>7} | {'min ΔM':>11} | parametry")
    print(f"{'-'*118}")
    for s in results[:args.top]:
        short = {"RETAIL_FILL_TARGET": "RF", "GOV_FILL_TARGET": "GF",
                 "HQ_BASE_SHARE": "HQ", "HQ_P": "HQp",
                 "WEALTH_TAX_WEEKLY": "WT", "DISPOSAL_MULT": "DM"}
        ps = " ".join(f"{short[k]}={v:g}" for k, v in s.params.items())
        print(f"{s.penalty:7.2f} | {s.cpi_end:6.2f}% | {s.m2_end:6.2f}% | {s.y_end:6.2f}% | "
              f"{s.cpi_worst:7.2f}% | {s.fill_end:5.2f} | {s.wealth_mult:6.1f}x | "
              f"{s.min_dm:11,.0f} | {ps}")

    if not results:
        print("\n❌ Žádná kombinace nevrátila platný výsledek.")
        return

    best = results[0]
    print(f"\n🏆 VÍTĚZ (penalta {best.penalty:.2f}):")
    for k, v in best.params.items():
        print(f"     {k:<22} = {v}")
    print(f"\n   CPI drift na konci sezóny : {best.cpi_end:+.2f} %/měsíc   (cíl 1–4)")
    print(f"     = růst M2 {best.m2_end:+.2f} %/měs  −  růst reálného výstupu Y {best.y_end:+.2f} %/měs")
    print(f"   nejhorší CPI po {WARMUP_DAYS}. dni : {best.cpi_worst:+.2f} %/měsíc   (cíl < 12)")
    print(f"   fill_rate retail          : {best.fill_end:.2f}   (cíl 0,40–0,85)")
    print(f"   bohatství na firmu        : {best.wealth_mult:.1f}× startovního kapitálu")
    print(f"   minimální ΔM/den          : {best.min_dm:,.0f} $")

    if args.apply:
        import pathlib
        p = pathlib.Path(__file__).resolve().parent / "generate_v0.py"
        src = p.read_text(encoding="utf-8")
        n = 0
        for k, v in best.params.items():
            pat = re.compile(rf"(_env\('{k}',\s*)([-0-9._e]+)(\))")
            src, cnt = pat.subn(rf"\g<1>{v:g}\g<3>", src)
            n += cnt
        p.write_text(src, encoding="utf-8")
        print(f"\n✍️  Zapsáno {n} nových defaultů do generate_v0.py")
    else:
        print("\n   (spusť s --apply pro zapsání jako nové defaulty)")


if __name__ == "__main__":
    main()
