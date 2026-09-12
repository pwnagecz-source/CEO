import { useMemo, useState } from 'react'
import { api, type CatalogRow, type MapPlot } from '../api'
import { TERRAIN } from '../game/art'

/** Odvětví → popis, ikona. Klíče MUSÍ odpovídat industries.code v DB. */
const INDUSTRY_META: Record<string, { label: string; icon: string; blurb: string }> = {
  agriculture: { label: 'Zemědělství', icon: '🌾', blurb: 'Obilí a bavlna ze zavlažených polí. Surovina, po které je vždy poptávka.' },
  mining: { label: 'Těžba', icon: '⛏️', blurb: 'Železná ruda, kámen nebo ropa. Všechno ostatní se vyrábí z toho, co vykopeš.' },
  timber: { label: 'Dřevařství', icon: '🪵', blurb: 'Klády z lesa, prkna z pily. Stavební materiál číslo jedna.' },
  energy: { label: 'Energie', icon: '⚡', blurb: 'Elektřinu potřebuje každá továrna ve světě. Solární park v průmyslové zóně.' },
  construction: { label: 'Stavebniny', icon: '🧱', blurb: 'Cement a sklo. Nakupuješ vápenec a písek od těžařů a prodáváš stavitelům.' },
  food: { label: 'Potraviny', icon: '🍞', blurb: 'Mouka, chléb, sendviče. Prodejna znamená přímý prodej NPC zákazníkům.' },
  metallurgy: { label: 'Hutnictví', icon: '🔩', blurb: 'Ruda → ingoty → ocelový plech. Těžký průmysl, vysoké investice.' },
  textiles: { label: 'Textil', icon: '🧵', blurb: 'Bavlna → textilie → oblečení. Víc kroků znamená vyšší marži.' },
  manufacturing: { label: 'Výroba', icon: '🏭', blurb: 'Plasty, hřebíky, dráty, nábytek, spotřebiče. Nejvíc cest, jak vydělat.' },
  electronics: { label: 'Elektronika', icon: '💾', blurb: 'Obvody a strojírenství. Nejvyšší liga a nejdražší továrny.' },
}

/** Pořadí karet v průvodci: nejdřív extraktory (nejjednodušší začátek). */
const INDUSTRY_ORDER = [
  'agriculture', 'mining', 'timber', 'energy', 'food', 'construction',
  'textiles', 'metallurgy', 'manufacturing', 'electronics',
]

const SITE_LABEL: Record<string, string> = {
  water: 'voda / pole', forest: 'les', mine: 'důl / lom', utility: 'energetická zóna',
  commercial: 'komerční centrum', civic: 'občanské', industrial: 'průmyslová zóna',
  road: 'státní silnice',
}

type Props = {
  startingCapital: number
  plots: MapPlot[]
  catalog: CatalogRow[]
  onDone: (companyId: number) => void
  onSkip?: () => void
}

export default function SetupScreen({ startingCapital, plots, catalog, onDone, onSkip }: Props) {
  const [step, setStep] = useState<0 | 1 | 2>(0)
  const [name, setName] = useState('')
  const [industry, setIndustry] = useState<string | null>(null)
  const [plotId, setPlotId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const industries = useMemo(() => {
    const present = new Set(catalog.map((c) => c.industry))
    return INDUSTRY_ORDER.filter((i) => present.has(i) && INDUSTRY_META[i])
  }, [catalog])

  /** Startovní budova pro odvětví = extraktor (nejnižší tier výstupu). */
  const starter = useMemo(() => {
    if (!industry) return null
    const rows = catalog.filter((c) => c.industry === industry)
    return rows.find((r) => r.output_tier === 0) ?? rows[0] ?? null
  }, [industry, catalog])

  const candidates = useMemo(() => {
    if (!starter) return []
    return plots.filter((p) => p.type === starter.plot_type && !p.owner_id)
  }, [plots, starter])

  const chosen = plots.find((p) => p.id === plotId) ?? null

  async function finish() {
    if (!industry || !starter || !chosen) return
    setBusy(true); setErr('')
    try {
      const { companyId } = await api.createCompany(name.trim(), industry)
      await api.buyPlot(chosen.id, companyId)
      await api.build(chosen.id, companyId, starter.code)
      onDone(companyId)
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Nepodařilo se založit firmu')
      setBusy(false)
    }
  }

  return (
    <div className="setup">
      <div className="setup__inner">
        <div className="setup__head">
          <span className="setup__brand">🏭 CEO</span>
          <h1>Založ svou první firmu</h1>
          <p className="setup__sub">Tři kroky: jméno a obor, pozemek, stavba. Startovní kapitál
            <strong> {startingCapital.toLocaleString('cs-CZ')} Kč</strong> ti pokryje zbytek.</p>
          {onSkip && (
            <button className="setup__skip" onClick={onSkip}>
              přeskočit a hrát za existující firmu →
            </button>)}
        </div>

        <div className="setup__steps">
          {['Obor', 'Pozemek', 'Hotovo'].map((lbl, i) => (
            <div key={lbl} className={
              'setup__step' + (step === i ? ' is-active' : '') + (step > i ? ' is-done' : '')}>
              <span className="setup__dot">{i + 1}</span>{lbl}
            </div>
          ))}
        </div>

        {step === 0 && (
          <section className="setup__panel">
            <label className="field">
              <span>Jméno firmy</span>
              <input value={name} onChange={(e) => setName(e.target.value)}
                placeholder="např. Žatecké Pivovary" maxLength={48} autoFocus />
            </label>
            <div className="setup__label">Vyber odvětví — co budeš vyrábět?</div>
            <div className="ind-grid">
              {industries.map((code) => {
                const m = INDUSTRY_META[code]
                const rows = catalog.filter((c) => c.industry === code)
                const ex = rows.find((r) => r.output_tier === 0) ?? rows[0]
                return (
                  <button key={code} className={'ind-card' + (industry === code ? ' is-sel' : '')}
                    onClick={() => setIndustry(code)}>
                    <span className="ind-card__icon">{m.icon}</span>
                    <span className="ind-card__name">{m.label}</span>
                    <span className="ind-card__blurb">{m.blurb}</span>
                    {ex?.output_name && (
                      <span className="ind-card__prod">start: {ex.output_name}</span>)}
                  </button>
                )
              })}
            </div>
            <div className="setup__actions">
              <button className="btn btn--primary" disabled={!name.trim() || !industry}
                onClick={() => setStep(1)}>Vybrat pozemek →</button>
            </div>
          </section>
        )}

        {step === 1 && starter && (
          <section className="setup__panel">
            <div className="setup__label">
              Kde postavíš <strong>{starter.name}</strong>? Potřebuje terén
              <em> {SITE_LABEL[starter.plot_type]}</em>. Klikni na zvýrazněné políčko.
            </div>
            <SiteMap plots={plots} candidates={candidates}
              selected={plotId} onPick={setPlotId} />
            <div className="setup__legend">
              {Object.keys(TERRAIN).map((t) => (
                <span key={t}><i style={{ background: TERRAIN[t].fill }} />{SITE_LABEL[t] ?? t}</span>))}
            </div>
            {chosen && (
              <div className="setup__picked">
                Pozemek <strong>[{chosen.x}, {chosen.y}]</strong> ({SITE_LABEL[chosen.type]}) —
                cena <strong>{chosen.assessed_value.toLocaleString('cs-CZ')} Kč</strong>.
                Po stavbě ti zbude {(startingCapital - chosen.assessed_value - starter.capex)
                  .toLocaleString('cs-CZ')} Kč.
              </div>
            )}
            <div className="setup__actions">
              <button className="btn" onClick={() => setStep(0)}>← Zpět</button>
              <button className="btn btn--primary" disabled={!chosen}
                onClick={() => setStep(2)}>Pokračovat →</button>
            </div>
          </section>
        )}

        {step === 2 && starter && chosen && (
          <section className="setup__panel">
            <div className="setup__label">Potvrď a začni</div>
            <div className="summary">
              <div><span>Firma</span><strong>{name.trim() || '(bez jména)'}</strong></div>
              <div><span>Odvětví</span><strong>{INDUSTRY_META[industry!]?.label}</strong></div>
              <div><span>První budova</span><strong>{starter.name}</strong></div>
              <div><span>Pozemek</span><strong>[{chosen.x}, {chosen.y}] · {SITE_LABEL[chosen.type]}</strong></div>
              <div><span>Náklady</span><strong>
                {(chosen.assessed_value + starter.capex).toLocaleString('cs-CZ')} Kč</strong></div>
              <div><span>Zůstatek po startu</span><strong>
                {(startingCapital - chosen.assessed_value - starter.capex).toLocaleString('cs-CZ')} Kč</strong></div>
            </div>
            {err && <div className="setup__err">{err}</div>}
            <div className="setup__actions">
              <button className="btn" onClick={() => setStep(1)}>← Zpět</button>
              <button className="btn btn--primary" onClick={finish} disabled={busy}>
                {busy ? 'Zakládám…' : '🚀 Založit a postavit'}
              </button>
            </div>
          </section>
        )}
      </div>
    </div>
  )
}

/** Jednoduchá mapa shora dolů pro výběr pozemku (klikací). */
function SiteMap({ plots, candidates, selected, onPick }: {
  plots: MapPlot[]; candidates: MapPlot[]
  selected: string | null; onPick: (id: string) => void
}) {
  if (plots.length === 0) return <div className="muted">načítám mapu…</div>
  const w = Math.max(...plots.map((p) => p.x)) + 1
  const h = Math.max(...plots.map((p) => p.y)) + 1
  const grid: (MapPlot | undefined)[][] = Array.from({ length: h }, () =>
    Array.from({ length: w }, () => undefined))
  for (const p of plots) if (p.y < h && p.x < w) grid[p.y][p.x] = p
  const ok = new Set(candidates.map((c) => c.id))
  const cell = Math.min(16, Math.floor(720 / w))
  return (
    <div className="site-map" style={{
      gridTemplateColumns: `repeat(${w}, ${cell}px)`,
      gridTemplateRows: `repeat(${h}, ${cell}px)` }}>
      {grid.flat().map((p, i) => {
        if (!p) return <span key={i} className="site__cell site__cell--none" />
        const isCand = ok.has(p.id)
        const isSel = selected === p.id
        return <span key={p.id}
          className={'site__cell' + (isCand ? ' is-cand' : '') + (isSel ? ' is-sel' : '')}
          style={{ background: TERRAIN[p.type]?.fill ?? '#555', opacity: isCand ? 1 : 0.4 }}
          onClick={isCand ? () => onPick(p.id) : undefined}
          title={isCand ? `Postav zde (${SITE_LABEL[p.type]})` : SITE_LABEL[p.type]} />
      })}
    </div>
  )
}
