#!/usr/bin/env python3
"""
Validuje SQL migrace skutečným PostgreSQL parserem (pglast = binding na libpq parser).

Proč tohle, a ne „vypadá to jako SQL": parser odhalí syntaxi, ale i věci, které
review přehlédne — COMMENT ON CONSTRAINT TRIGGER (neexistuje), CHECK s poddotazem
(není dovolen), trailing comma po odstraněném constraintu.

Sémantiku (typy, FK na neexistující sloupce, duplicitní názvy) odhalí až skutečný
Postgres. Tohle je první linie, ne náhrada za `psql -f`.

    pip install pglast
    python3 tools/db/validate_sql.py db/migrations/*.sql
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

try:
    import pglast
except ImportError:
    sys.exit("❌ chybí pglast — nainstaluj: pip install pglast")


def validate(path: Path) -> bool:
    sql = path.read_text(encoding="utf-8")
    try:
        n = len(pglast.parse_sql(sql))
    except pglast.parser.ParseError as exc:
        print(f"❌ {path}")
        print(f"   {exc}")
        m = re.search(r"at index (\d+)", str(exc))
        if m:
            i = int(m.group(1))
            line = sql[:i].count("\n") + 1
            print(f"   → řádek {line}:")
            for ln, text in enumerate(
                    sql[max(0, i - 200):i + 120].split("\n"), start=max(1, line - 5)):
                mark = " >>>" if ln == line else "    "
                print(f"  {mark} {ln:4d} | {text}")
        return False

    # varování na známé pasti, které parser propustí, ale Postgres odmítne za běhu.
    # Kontroluje se kód BEZ komentářů — jinak dokumentace typu „NIKDY float" spustí
    # vlastní varování.
    code = re.sub(r"/\*.*?\*/", " ", sql, flags=re.S)   # blokové komentáře
    code = re.sub(r"--[^\n]*", " ", code)                      # řádkové

    warns = []
    if re.search(r"CHECK\s*\([^)]*\bSELECT\b", code, re.I):
        warns.append("CHECK constraint s poddotazem — Postgres to odmítne, použij trigger")
    if re.search(r"COMMENT\s+ON\s+CONSTRAINT\s+TRIGGER", code, re.I):
        warns.append("COMMENT ON CONSTRAINT TRIGGER neexistuje — použij COMMENT ON TRIGGER … ON <table>")
    if re.search(r"\b(float|double precision|real)\b", code, re.I):
        warns.append("float/real/double v ekonomickém schématu — peníze musí být numeric")
    if re.search(r",\s*\)\s*;", code):
        warns.append("trailing comma před uzavírací závorkou")

    status = "⚠️ " if warns else "✅"
    print(f"{status} {path}: {n} statementů")
    for w in warns:
        print(f"     ! {w}")
    return not warns


def main() -> int:
    args = sys.argv[1:]
    paths = [Path(a) for a in args] if args else sorted(Path("db/migrations").glob("*.sql"))
    if not paths:
        sys.exit("❌ žádné SQL soubory k validaci")
    ok = all(validate(p) for p in paths)
    print(f"\n{'✅ vše v pořádku' if ok else '❌ jsou chyby/varování'} — {len(paths)} soubor(ů)")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
