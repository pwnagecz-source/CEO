import type { Audit } from '../api'
import { pct } from '../fmt'

type Props = {
  audit: Audit | null
  fees: { maker: number; taker: number }
  lastSync: Date | null
  error: string | null
}

/**
 * Stavová lišta. Invarianty nejsou dekorace: jsou to přesně ty kontroly, které
 * v databázi běží jako deferred constraint triggery a noční audit funkce.
 * Když některá zčervená, ekonomika má leak a dá se to poznat okamžitě,
 * ne za týden z rozjetých makro čísel.
 */
const INVARIANTS: { key: keyof Audit; label: string; hint: string }[] = [
  { key: 'unbalanced', label: 'Σ legs = 0', hint: 'Každá transakce podvojného ledgeru musí být vyrovnaná. Hlídá DEFERRED CONSTRAINT TRIGGER při COMMIT.' },
  { key: 'drift', label: 'zůstatek = Σ journal', hint: 'Uložený zůstatek účtu se musí rovnat součtu jeho zápisů. fn_audit_balance_drift().' },
  { key: 'oversold', label: 'rezervace ≤ zásoby', hint: 'Nikdo nesmí mít v escrow víc zboží, než vlastní. fn_audit_oversold_inventory().' },
  { key: 'moneyIdentity', label: 'M2 ≡ ΔM', hint: 'Každá koruna musela projít faucetem a dosud neprošla sinkem. Jinak peníze vznikly nebo zmizely mimo ledger.' },
  { key: 'escrowMismatch', label: 'escrow příkazů = účet', hint: 'Zablokovaná hotovost na příkazech musí přesně odpovídat účtu escrow_market. Hlídá únik peněz. fn_audit_escrow_mismatch().' },
]

export default function Footer({ audit, fees, lastSync, error }: Props) {
  return (
    <footer className="bottom">
      <div className="invariants">
        {INVARIANTS.map((inv) => {
          const rows = audit ? (audit[inv.key] as unknown[]) : null
          const ok = rows !== null && rows.length === 0
          return (
            <span
              key={inv.key}
              className={`inv ${rows === null ? '' : ok ? 'ok' : 'bad'}`}
              title={`${inv.hint}${rows && rows.length > 0 ? `\n\nPorušení: ${rows.length}` : ''}`}
            >
              {ok ? '✓' : rows ? '✗' : '…'} {inv.label}
            </span>
          )
        })}
      </div>

      <span className="spacer" />

      <span className="dim">
        poplatky maker <b className="num">{pct(fees.maker, 1)}</b> ·
        taker <b className="num">{pct(fees.taker, 1)}</b>
      </span>
      <span className="faint">
        {error ? `⚠ ${error}` : lastSync ? `sync ${lastSync.toLocaleTimeString('cs-CZ', { hour12: false })}` : '…'}
      </span>
    </footer>
  )
}
