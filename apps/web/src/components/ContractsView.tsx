import { useCallback, useEffect, useState } from 'react'
import { api, type ContractRow } from '../api'
import { money, price, qty } from '../fmt'

type Props = {
  companyId: string
  onClose: () => void
  onChanged: () => void
}

/** Kolik zbývá do termínu, lidsky (herní hodiny → dny/hodiny). */
function deadline(h: number): string {
  if (h <= 0) return 'poslední chvíle'
  if (h < 24) return `${h} h`
  return `${Math.floor(h / 24)} d ${h % 24} h`
}

/**
 * Modal „Zakázky“: státní kontrakty = garantovaný odbyt za prémiovou cenu.
 * Přijmout → vyskladnit ze všech svých skladů → inkasovat + XP.
 * Hodiny do termínu ubíhají s herním časem, proto refresh po 2 s.
 */
export default function ContractsView({ companyId, onClose, onChanged }: Props) {
  const [rows, setRows] = useState<ContractRow[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [ok, setOk] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const r = await api.contracts(companyId)
      setRows(r.contracts)
    } catch { /* další pokus za chvíli */ }
  }, [companyId])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 2000)
    return () => clearInterval(t)
  }, [load])

  async function act(label: string, fn: () => Promise<string | null>) {
    setBusy(label); setErr(null); setOk(null)
    try {
      const msg = await fn()
      if (msg) setOk(msg)
      await load()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const take = (c: ContractRow) => void act(`take-${c.id}`, async () => {
    await api.takeContract(c.id, companyId)
    return `Zakázka „${c.itemName}“ přijata — do termínu zbývá ${deadline(c.hoursLeft)}.`
  })

  const deliver = (c: ContractRow) => void act(`deliver-${c.id}`, async () => {
    const r = await api.deliverContract(c.id, companyId)
    return `Splněno! Stát zaplatil ${money(r.paid)} a dostáváš ${r.xp} XP.`
  })

  const open = rows.filter((r) => r.status === 'open')
  const mine = rows.filter((r) => r.isMine)
  const others = rows.filter((r) => r.status === 'taken' && !r.isMine)

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--contracts" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>📋 Zakázky</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        <p className="dim modal-sub">
          Státní kontrakty platí prémií nad tržní cenou, ale mají termín.
          Zboží na splnění se odepíše ze všech tvých skladů.
        </p>

        {err && <div className="insp-err">{err}</div>}
        {ok && <div className="insp-ok">{ok}</div>}

        {mine.length > 0 && (
          <section className="contract-sec">
            <h3>Tvoje rozdělané</h3>
            {mine.map((c) => (
              <div key={c.id} className="crowd crowd--mine">
                <div className="crowd__main">
                  <span className="crowd__name">{c.itemName}</span>
                  <span className="crowd__meta">
                    {qty(c.qty)} ks × {price(c.unitPrice)} = <strong>{money(c.total)}</strong>
                    {' '}· +{c.xpReward} XP
                  </span>
                  <span className={`crowd__deadline${c.hoursLeft < 12 ? ' is-urgent' : ''}`}>
                    ⏳ {deadline(c.hoursLeft)}
                  </span>
                </div>
                <button className="btn btn--primary btn--sm"
                  disabled={busy !== null}
                  onClick={() => deliver(c)}>
                  {busy === `deliver-${c.id}` ? '…' : '📦 Splnit'}
                </button>
              </div>
            ))}
          </section>
        )}

        <section className="contract-sec">
          <h3>Volné zakázky ({open.length})</h3>
          {open.length === 0 && <p className="dim">Právě nejsou žádné volné — stát vypíše nové každou chvíli.</p>}
          {open.map((c) => (
            <div key={c.id} className="crowd">
              <div className="crowd__main">
                <span className="crowd__name">{c.itemName}</span>
                <span className="crowd__meta">
                  {qty(c.qty)} ks × {price(c.unitPrice)} = <strong>{money(c.total)}</strong>
                  {' '}· +{c.xpReward} XP
                </span>
                <span className="crowd__deadline">⏳ {deadline(c.hoursLeft)}</span>
              </div>
              <button className="btn btn--primary btn--sm"
                disabled={busy !== null}
                onClick={() => take(c)}>
                {busy === `take-${c.id}` ? '…' : 'Přijmout'}
              </button>
            </div>
          ))}
        </section>

        {others.length > 0 && (
          <section className="contract-sec">
            <h3 className="dim">Obsazeno konkurencí</h3>
            {others.map((c) => (
              <div key={c.id} className="crowd crowd--taken">
                <div className="crowd__main">
                  <span className="crowd__name">{c.itemName}</span>
                  <span className="crowd__meta dim">{qty(c.qty)} ks · {money(c.total)}</span>
                </div>
                <span className="dim">⏳ {deadline(c.hoursLeft)}</span>
              </div>
            ))}
          </section>
        )}
      </div>
    </div>
  )
}
