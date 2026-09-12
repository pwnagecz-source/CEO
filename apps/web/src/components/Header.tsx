import type { Audit, Macro } from '../api'
import { compact } from '../fmt'

type Props = {
  macro: Macro | null
  audit: Audit | null
  worldId: number | null
  engine: string | null
  version: string | null
  onRefresh: () => void
  onReset: () => void
  onOpenGame: () => void
  busy: boolean
}

/**
 * Horní lišta. Makro čísla jsou tady, protože v téhle hře nejsou „statistiky“ —
 * jsou to řídící veličiny: ADR-009 definuje cíl jako CPI drift = %ΔM2 − %ΔY,
 * takže M2 a jeho změna patří na nejviditelnější místo.
 */
export default function Header({
  macro, audit, worldId, engine, version, onRefresh, onReset, onOpenGame, busy,
}: Props) {
  // Peníze v ekonomice mohou vzniknout jen faucetem a zaniknout jen sinkem.
  // Tahle identita (M2 == vytvořeno − zničeno) je hlídaná i v DB.
  const identityOk = macro ? Math.abs(macro.m2 - macro.deltaM) < 0.01 : false

  return (
    <header className="top">
      <div className="brand">CE<span>O</span></div>

      <div className="kpis">
        <div className="kpi">
          <span className="k">Svět</span>
          <span className="v">#{worldId ?? '—'}</span>
        </div>
        <div className="kpi">
          <span className="k">M2</span>
          <span className="v">{compact(macro?.m2)}</span>
        </div>
        <div className="kpi">
          <span className="k">Vytvořeno</span>
          <span className="v bid">{compact(macro?.moneyCreated)}</span>
        </div>
        <div className="kpi">
          <span className="k">Zničeno</span>
          <span className="v ask">{compact(macro?.moneyDestroyed)}</span>
        </div>
        <div className="kpi">
          <span className="k">Identita M2 ≡ ΔM</span>
          <span className="v">
            {macro ? (identityOk
              ? <span className="badge pass">sedí</span>
              : <span className="badge fail">ROZJETÁ o {compact(macro.m2 - macro.deltaM)}</span>) : '—'}
          </span>
        </div>
        <div className="kpi">
          <span className="k">Objem</span>
          <span className="v">{compact(macro?.counts.volume ?? 0)}</span>
        </div>
        <div className="kpi">
          <span className="k">Příkazy / obchody</span>
          <span className="v">
            {macro?.counts.open_orders ?? '—'} / {macro?.counts.trades ?? '—'}
          </span>
        </div>
        <div className="kpi">
          <span className="k">Engine</span>
          <span className="v dim" style={{ fontSize: 11 }}>
            {engine ?? '—'}{version ? ` ${version.split(' ')[0]}` : ''}
          </span>
        </div>
      </div>

      <button className="ghost" onClick={onOpenGame} title="Izometrická mapa světa">
        ← Hra
      </button>
      <button className="ghost" onClick={onRefresh} disabled={busy}>
        {busy ? '…' : 'Obnovit'}
      </button>
      <button className="ghost" onClick={onReset} disabled={busy} title="Smaže in-memory DB a znovu naseeduje svět">
        Reset světa
      </button>
      {audit && (
        <span className={`badge ${audit.ok ? 'pass' : 'fail'}`}>
          AUDIT {audit.verdict}
        </span>
      )}
    </header>
  )
}
