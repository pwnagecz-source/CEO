import { useCallback, useEffect, useState } from 'react'
import { api, type Progress, type ResearchItem } from '../api'
import { money } from '../fmt'

type Props = {
  companyId: string
  onClose: () => void
  onChanged: () => void
  onToast?: (title: string, text?: string) => void
}

const TIER_LABEL: Record<number, string> = {
  1: 'Základy', 2: 'Rozšíření (úroveň 3+)', 3: 'Špička (úroveň 5+)',
}

/**
 * Modal „Výzkum a úrovně“: nahoře progres firmy (XP/úroveň), pod ní strom
 * po tierech. Karta umí čtyři stavy: hotovo / běží (s procenty) / dostupné
 * (tlačítko s cenou) / zamčené (důvod). Data si tahá sama, po akci obnoví
 * sebe i svět v App (onChanged).
 */
export default function ResearchView({ companyId, onClose, onChanged, onToast }: Props) {
  const [data, setData] = useState<(Progress & { research: ResearchItem[] }) | null>(null)
  const [cash, setCash] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [p, co] = await Promise.all([api.progression(companyId), api.company(companyId)])
      setData(p)
      setCash(co.cash)
    } catch { /* další pokus za chvíli */ }
  }, [companyId])

  useEffect(() => {
    void load()
    const t = setInterval(() => void load(), 3000)
    return () => clearInterval(t)
  }, [load])

  async function start(code: string) {
    setBusy(code); setErr(null)
    try {
      const r = await api.startResearch(companyId, code)
      const name = data?.research.find((i) => i.code === code)?.name ?? code
      onToast?.(`🔬 Výzkum zahájen: ${name}`, `−${money(r.cost)} · hotovo za ${data?.research.find((i) => i.code === code)?.hours ?? '?'} herních hodin`)
      await load()
      onChanged()
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const tiers = [1, 2, 3] as const

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal--research" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h2>🔬 Výzkum a úrovně</h2>
          <button className="ghost" onClick={onClose}>✕</button>
        </div>

        {data && (
          <div className="prog-hero">
            <div className="prog-hero__lvl">⭐ Úroveň {data.level}</div>
            <div className="prog-hero__bar">
              <i style={{ width: `${data.progressPct}%` }} />
            </div>
            <div className="prog-hero__xp dim">
              {data.xp} XP
              {data.nextLevelXp !== null
                ? ` · další úroveň v ${data.nextLevelXp} XP`
                : ' · maximální úroveň'}
            </div>
            <p className="dim prog-hero__hint">
              XP sbíráš výrobou (každá dávka), splněnými zakázkami a dokončeným výzkumem.
              Úroveň odemyká vyšší tier výzkumu, upgrade budov a větší půjčky.
            </p>
          </div>
        )}

        {err && <div className="insp-err">{err}</div>}

        <div className="research-tree">
          {tiers.map((tier) => (
            <div key={tier} className="research-tier">
              <h3>{TIER_LABEL[tier]}</h3>
              <div className="research-grid">
                {(data?.research ?? []).filter((r) => r.tier === tier).map((r) => (
                  <div key={r.code} className={`rcard rcard--${r.state}`}>
                    <div className="rcard__name">
                      {r.state === 'done' && '✅ '}{r.name}
                    </div>
                    <div className="rcard__desc dim">{r.desc}</div>
                    {r.state === 'running' && (
                      <div className="rcard__run">
                        <div className="rcard__bar"><i style={{ width: `${r.progressPct}%` }} /></div>
                        <span className="dim">běží · {r.progressPct} %</span>
                      </div>
                    )}
                    {r.state === 'locked' && (
                      <div className="rcard__lock">🔒 {r.lockReason}</div>
                    )}
                    {r.state === 'available' && (
                      <button className="btn btn--primary btn--sm rcard__go"
                        disabled={busy !== null || cash < r.cost}
                        title={cash < r.cost ? 'Nemáš dost peněz' : `Trvá ${r.hours} herních hodin`}
                        onClick={() => void start(r.code)}>
                        {busy === r.code ? '…' : `Zahájit · ${money(r.cost)}`}
                      </button>
                    )}
                    {r.state === 'done' && <div className="rcard__done dim">dokončeno</div>}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
