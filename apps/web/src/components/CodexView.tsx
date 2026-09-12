import { useMemo, useState } from 'react'
import type { CatalogRow, CodexInput, CodexRecipe } from '../api'

type Props = {
  recipes: CodexRecipe[]
  inputs: CodexInput[]
  catalog: CatalogRow[]
  onBack: () => void
}

const TABS = ['recepty', 'budovy', 'prirucka'] as const
type Tab = typeof TABS[number]

const PLOT_LABEL: Record<string, string> = {
  water: 'voda / pole', forest: 'les', mine: 'důl / lom', utility: 'energetika',
  commercial: 'komerce', industrial: 'průmyslová zóna', civic: 'občanské',
  road: 'silnice',
}

/**
 * Kniha (kodex) — všechno, co hráč může POTŘEBOVAT vědět, na jednom místě:
 * produkční řetězce, katalog budov a příručka ekonomiky.
 *
 * Je to „čtecí“ vrstva nad hlubokou ekonomikou: ve hře samotně hráč žádnou
 * z těchhle tabulek nepotřebuje (všechno jde naklikat), ale kdo chce plánovat
 * řetězce, tady je najde bez čtení balance JSONu.
 */
export default function CodexView({ recipes, inputs, catalog, onBack }: Props) {
  const [tab, setTab] = useState<Tab>('recepty')

  const inputsOf = useMemo(() => {
    const m = new Map<string, CodexInput[]>()
    for (const i of inputs) {
      const arr = m.get(i.recipe) ?? []
      arr.push(i)
      m.set(i.recipe, arr)
    }
    return m
  }, [inputs])

  const tiers = useMemo(
    () => [...new Set(recipes.map((r) => r.tier))].sort((a, b) => a - b),
    [recipes])

  return (
    <div className="codex">
      <header className="codex__head">
        <button className="btn" onClick={onBack}>← Zpět do světa</button>
        <h1>📖 Kniha světa</h1>
        <div className="codex__tabs">
          {TABS.map((t) => (
            <button key={t} className={'codex__tab' + (tab === t ? ' is-sel' : '')}
              onClick={() => setTab(t)}>
              {t === 'recepty' ? 'Recepty' : t === 'budovy' ? 'Budovy' : 'Příručka'}
            </button>
          ))}
        </div>
      </header>

      {tab === 'recepty' && (
        <div className="codex__body">
          {tiers.map((t) => (
            <section key={t} className="codex__section">
              <h2>Tier {t} · {t === 0 ? 'suroviny' : t === 1 ? 'polotovary' : t === 2 ? 'komponenty' : 'finální výroba'}</h2>
              <div className="codex__grid">
                {recipes.filter((r) => r.tier === t).map((r) => {
                  const ins = inputsOf.get(r.code) ?? []
                  return (
                    <article key={r.code} className="recipe">
                      <header>
                        <span className="recipe__out">{r.output_name}</span>
                        <span className="recipe__qty">×{r.qty}/h</span>
                      </header>
                      <div className="recipe__building">
                        {r.building_name}
                        <em>{PLOT_LABEL[r.plot_type ?? ''] ?? 'libovolný terén'}</em>
                      </div>
                      <div className="recipe__ins">
                        {ins.length === 0
                          ? <span className="dim">těží z ložiska — bez vstupů</span>
                          : ins.map((i) => (
                            <span key={i.item} className="recipe__in">
                              {i.item_name} <b>×{i.qty}</b>
                            </span>))}
                      </div>
                    </article>
                  )
                })}
              </div>
            </section>
          ))}
        </div>
      )}

      {tab === 'budovy' && (
        <div className="codex__body">
          <section className="codex__section">
            <h2>Katalog budov</h2>
            <table className="codex__table">
              <thead>
                <tr>
                  <th>Budova</th><th>Obor</th><th>Terén</th><th>Vyrábí</th>
                  <th>Capex</th><th>Údržba/h</th><th>Sklad</th>
                </tr>
              </thead>
              <tbody>
                {catalog.map((b) => (
                  <tr key={b.code}>
                    <td className="name">{b.name}</td>
                    <td className="dim">{b.industry}</td>
                    <td className="dim">{PLOT_LABEL[b.plot_type] ?? 'libovolný'}</td>
                    <td>{b.output_name ?? '—'}</td>
                    <td className="num">{Math.round(b.capex).toLocaleString('cs-CZ')}</td>
                    <td className="num ask">{b.upkeep_hour.toFixed(1)}</td>
                    <td className="num">{b.storage.toLocaleString('cs-CZ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      )}

      {tab === 'prirucka' && (
        <div className="codex__body codex__book">
          <section className="codex__section">
            <h2>Jak vznikají a mizí peníze</h2>
            <p>
              Peníze <strong>vznikají</strong> jen ze dvou míst: prodej NPC zákazníkům
              v prodejnách (retail) a státní zakázky. <strong>Mizí</strong> poplatky,
              údržbami, mzdami, nákupy pozemků a elektřinou ze sítě. Nic jiného
              peníze netiskne — proto svět drží pohromadě a ceny mají strop i dno.
            </p>
            <h2>Trh</h2>
            <p>
              Ceny nediktuje hra. Každá položka má skutečný order book: kdo prodává
              levěji, než jiný hráč žádá, ten prodá. Když nikdo dřevo neprodává,
              dřevo prostě není. „Prodat vše“ v inspektoru je market order —
              vezme nejlepší dostupné ceny v knize; v Terminálu můžeš dát limitku.
            </p>
            <h2>Energie a státní síť</h2>
            <p>
              Skoro každá budova žere elektřinu. Bez vlastní elektrárny ji tick
              dokupuje ze státní sítě za <strong>referenční cenu × 1,15</strong> —
              peníze se přitom spálí. Postavit solár a prodávat proud levněji
              než je tarif je jedna z nejčistších cest k zisku.
            </p>
            <h2>Silnice a logistika</h2>
            <p>
              Produkce běží jen tam, kde je <strong>napojení na státní síť</strong>:
              sousední dlaždice tvého pozemku musí ležet v souvislé síti silnic
              (státní tahy + hráčské silnice). Dvě cesty: koupit pozemky a postavit
              silnice sám, nebo <strong>najmout stavební firmu</strong> — spočítá
              nejkratší trasu, vykoupí pozemky za 30 % odhadní ceny a postaví ji
              za poplatek 250 Kč/dlaždice. Čím dál od tahů stavíš, tím dráž.
            </p>
            <p>
              <strong>Řeka je dálnice zdarma:</strong> pozemek sousedící s vodou
              je napojený sám od sebe. <strong>Přístav</strong> (900 Kč capex,
              +1 000 skladu) postavíš jen u vody — lodě na řece vozí tvé zboží
              a nábřežní parcely jsou proto dražší než vnitrozemí.
            </p>
            <h2>Čas</h2>
            <p>
              Svět má viditelný čas: jeden tick = jedna herní hodina. Tlačítky
              ⏸ 1× 2× 4× hru zastavíš nebo zrychlíš — v pauze se nevyrábí ani
              neplatí údržby, hodiny stojí.
            </p>
            <h2>Questy</h2>
            <p>
              Řetěz sedmi úkolů tě provede smyčkou: založ firmu, kup pozemek,
              postav, rozjeď výrobu, prodej první zboží (tím se odemkne Terminál),
              rozšíř se na tři budovy a naspoř 30 000 Kč. Questy se nikam
              neukládají — odvozují se z faktů ve světě, takže nikdy nelžou.
            </p>
          </section>
        </div>
      )}
    </div>
  )
}
