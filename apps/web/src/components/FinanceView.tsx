import { useCallback, useEffect, useState } from 'react'
import { api, type ExecRow, type LoansInfo, type Pnl } from '../api'
import { money } from '../fmt'

type Props = {
  companyId: string
  onClose: () => void
  onChanged: () => void
  onToast?: (title: string, text?: string) => void
}

const LOAN_AMOUNTS = [500, 1000, 2500, 5000]

/**
 * Modal „Finance“: tři věci, které v simulátoru dělají „dospělou“ firmu —
 * denní výsledovka (z podvojného journalu, tedy do koruny přesná), půjčky
 * se stropem podle úrovně a manažeři s efekty na výrobu/logistiku/poplatky.
 */
export default function FinanceView({ companyId, onClose, onChanged, onToast }: Props) {
  const [pnl, setPnl] = useState<Pnl | null>(null)
  const [loans, setLoans] = useState<LoansInfo | null>(null)
  const [execs, setExecs] = useState<ExecRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, l, e] = await Promise.all([
        api.pnl(companyId), api.loans(companyId), api.executives(companyId),
      ])
      setPnl(p); setLoans(l); setExecs(e.executives)
    } catch { /* další pokus za chvíli */ }
  }, [companyId])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 4000)
    return () => clearInterval(t)
  }, [load])

  async function act(label: string, fn: () => Promise<string>) {
    setBusy(label); setErr(null); setOk(null)
    try {
      setOk(await fn())
      await load()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--finance" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>💰 Finance</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        {err && <div className="insp-err">{err}</div>}
        {ok && <div className="insp-ok">{ok}</div>}

        <section className="fin-sec">
          <h3>Výsledovka dnes</h3>
          {pnl && pnl.items.length > 0 ? (
            <table className="pnl-table">
              <tbody>
                {pnl.items.map((i) => (
                  <tr key={i.kind}>
                    <td>{i.label}</td>
                    <td className="dim">×{i.count}</td>
                    <td className={i.total >= 0 ? 'pos' : 'neg'}>
                      {i.total >= 0 ? '+' : ''}{money(i.total)}
                    </td>
                  </tr>
                ))}
                <tr className="pnl-net">
                  <td><strong>Čistě dnes</strong></td>
                  <td />
                  <td className={pnl.net >= 0 ? 'pos' : 'neg'}>
                    <strong>{pnl.net >= 0 ? '+' : ''}{money(pnl.net)}</strong>
                  </td>
                </tr>
              </tbody>
            </table>
          ) : <p className="dim">Dnes se zatím nic nestalo.</p>}
        </section>

        <section className="fin-sec">
          <h3>
            Půjčky
            {loans && (
              <span className="dim fin-h">
                dlužíš {money(loans.outstanding)} · zbývající strop {money(loans.capacity)}
                (úroveň {loans.level} × 5 000)
              </span>
            )}
          </h3>
          <div className="loan-btns">
            {LOAN_AMOUNTS.map((a) => (
              <button key={a} className="btn btn--sm"
                disabled={busy !== null || (loans?.capacity ?? 0) < a}
                onClick={() => void act(`loan-${a}`, async () => {
                  await api.takeLoan(companyId, a)
                  onToast?.(`🏦 Půjčka ${money(a)} připsána`, 'Úrok 0,02 % z jistiny za herní hodinu.')
                  return `Půjčka ${money(a)} připsána. Úrok 0,02 % z jistiny za herní hodinu.`
                })}>
                {busy === `loan-${a}` ? '…' : `+ ${money(a)}`}
              </button>
            ))}
          </div>
          {loans && loans.loans.filter((l) => !l.closed).map((l) => (
            <div key={l.id} className="crowd">
              <div className="crowd__main">
                <span className="crowd__name">Půjčka #{l.id}</span>
                <span className="crowd__meta dim">
                  zbývá {money(l.outstanding)} z {money(l.principal)} · úrok {(l.rateHour * 100).toFixed(2)} %/h
                </span>
              </div>
              <button className="btn btn--sm"
                disabled={busy !== null}
                onClick={() => void act(`repay-${l.id}`, async () => {
                  const r = await api.repayLoan(l.id, companyId)
                  onToast?.(`🏦 Půjčka splacena`, `−${money(r.repaid)} · úroky dál nenabíhají`)
                  return `Splaceno ${money(r.repaid)}.`
                })}>
                {busy === `repay-${l.id}` ? '…' : 'Splatit'}
              </button>
            </div>
          ))}
        </section>

        <section className="fin-sec">
          <h3>Manažeři</h3>
          <div className="exec-grid">
            {execs.map((e) => (
              <div key={e.role} className={`exec-card${e.hired ? ' is-hired' : ''}`}>
                <div className="exec-card__role">{e.label}</div>
                <div className="exec-card__eff">{e.effect}</div>
                {e.hired ? (
                  <>
                    <div className="exec-card__name">{e.name}</div>
                    <div className="dim exec-card__salary">mzda {money(e.salaryHour)}/h</div>
                    <button className="btn btn--sm exec-card__btn"
                      disabled={busy !== null}
                      onClick={() => void act(`fire-${e.role}`, async () => {
                        await api.fireExecutive(companyId, e.role)
                        onToast?.(`👔 ${e.label} propuštěn(a)`, 'Efekt manažera už neplatí.')
                        return `${e.label} propuštěn(a).`
                      })}>
                      {busy === `fire-${e.role}` ? '…' : 'Propustit'}
                    </button>
                  </>
                ) : (
                  <>
                    <div className="dim exec-card__salary">
                      nájem {money(e.signingFee)} · mzda {money(e.salaryHour)}/h
                    </div>
                    <button className="btn btn--primary btn--sm exec-card__btn"
                      disabled={busy !== null}
                      onClick={() => void act(`hire-${e.role}`, async () => {
                        const r = await api.hireExecutive(companyId, e.role)
                        onToast?.(`👔 ${r.name} nastupuje`, `${e.label} · ${e.effect}`)
                        return `${r.name} nastupuje jako ${e.label}.`
                      })}>
                      {busy === `hire-${e.role}` ? '…' : 'Najmout'}
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>
        </section>
      </div>
    </div>
  )
}
