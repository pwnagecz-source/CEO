/**
 * Terminálový tutoriál — průvodce pro začátečníky.
 *
 * Terminál je expertní nástroj (order book, escrow, poplatky) a bez návodu
 * odrazuje. Tutoriál proto není text zeď, ale 5 kroků nad skutečným UI:
 * každý krok zvýrazní jednu sekci (přes `data-tut` atributy v TerminalView)
 * a řekne k ní jednu větu lidsky.
 *
 * Stav se drží v localStorage (`ceo.tut.term.v1`), takže se ukáže jen jednou;
 * tlačítkem „✦ Tutoriál“ v terminálu jde spustit znovu.
 */

export type TutStep = {
  target: 'market' | 'book' | 'side' | null
  title: string
  text: string
}

export const TUT_STEPS: TutStep[] = [
  {
    target: 'market',
    title: '1/5 · Trh',
    text: 'Vlevo je seznam všeho, co se ve světě obchoduje. Klikni na položku — '
        + 'čísla u ní jsou nejlepší nabídka na nákup (bid) a prodej (ask).',
  },
  {
    target: 'book',
    title: '2/5 · Kniha příkazů',
    text: 'Tady vidíš celou hloubku trhu: kdo chce kolik koupit a prodat, a nahoře '
        + 'graf, jak se cena vyvíjela po herních hodinách. Rozdíl bid/ask = spread.',
  },
  {
    target: 'book',
    title: '3/5 · Zadání příkazu',
    text: 'Limit čeká na tvoji cenu v knize a platíš jen 0,5 % (maker). Market vezme '
        + 'okamžitě nejlepší dostupnou cenu za 2,5 % (taker). Nákup zablokuje peníze '
        + 'v escrow, prodej zablokuje zboží — obojí se při zrušení vrátí.',
  },
  {
    target: 'side',
    title: '4/5 · Tvoje strana',
    text: 'Vpravo máš přehled firmy: hotovost, escrow, sklad. Otevřené příkazy můžeš '
        + 'zrušit (✕). Páska dole ukazuje obchody všech firem ve světě v reálném čase.',
  },
  {
    target: null,
    title: '5/5 · Zkus to',
    text: 'Malý úkol: vyber v trhu „Kláda“ a kup 10 ks příkazem Market. Sleduj pásku — '
        + 'tvůj obchod se na ní objeví. Tutoriál najdeš znovu přes ✦ vlevo nahoře.',
  },
]

type Props = {
  step: number
  onStep: (n: number) => void
  onFinish: () => void
}

export default function TerminalTutorial({ step, onStep, onFinish }: Props) {
  const s = TUT_STEPS[step]
  if (!s) return null
  const last = step >= TUT_STEPS.length - 1
  return (
    <div className="tut-overlay">
      <div className="tut-card">
        <div className="tut-card__head">
          <strong>{s.title}</strong>
          <button className="ghost tut-card__skip" onClick={onFinish}>Přeskočit ✕</button>
        </div>
        <p>{s.text}</p>
        <div className="tut-card__btns">
          {step > 0 && <button className="ghost" onClick={() => onStep(step - 1)}>← Zpět</button>}
          <span className="tut-dots">
            {TUT_STEPS.map((_, i) => <i key={i} className={i === step ? 'is-on' : ''} />)}
          </span>
          {last
            ? <button className="btn btn--primary btn--sm" onClick={onFinish}>Hotovo ✦</button>
            : <button className="btn btn--primary btn--sm" onClick={() => onStep(step + 1)}>Další →</button>}
        </div>
      </div>
    </div>
  )
}
