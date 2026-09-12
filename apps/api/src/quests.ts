/**
 * Questová vrstva Fáze B — onboarding a progresivní odemykání.
 *
 * Questy NEUKLÁDÁME do tabulky: celý stav se ODVOZUJE z faktů v databázi
 * (pozemky, budovy, stav výroby, obchody, peníze). Díky tomu:
 *   - nic nemůže „ztratit krok“ s realitou světa (žádný denormalizovaný stav),
 *   - reset světa, nová firma ani návrat po týdnu fungují stejně,
 *   - auditabilita zůstává: progress je čitelný přímo z ledgeru a skladů.
 *
 * Řetěz učí herní smyčku krok po kroku a nikdy neukáže hráči víc, než právě
 * potřebuje: terminál (expertní pohled na bid/ask) je odemčený až ve chvíli,
 * kdy hráč poprvé prodá — do té doby stačí jedno kliknutí „Prodat vše“.
 */
import type { Db } from './db.ts'
import { one } from './db.ts'

export type Quest = {
  code: string
  title: string
  desc: string
  /** Co konkrétně kliknout / udělat, aby quest postoupil. */
  hint: string
  done: boolean
  have: number
  need: number
  reward: string | null
}

export type QuestState = {
  quests: Quest[]
  active: Quest | null
  terminalUnlocked: boolean
}

type Facts = {
  plots: number
  buildings: number
  producing: number
  stock: number
  tradesSold: number
  cash: number
}

async function facts(d: Db, worldId: number, companyId: number): Promise<Facts> {
  // Pozor: PGlite vrací názvy sloupců LOWERCASE, takže aliasy musí být snake_case
  // (camelCase `tradesSold` by přišel jako `tradessold` a četli bychom undefined).
  const f = await one<{
    plots: string; buildings: string; producing: string; stock: string
    trades_sold: string; cash: string
  }>(
    d,
    `SELECT
       (SELECT count(*) FROM plots p
         WHERE p.world_id=$1 AND p.owner_company_id=$2)::text AS plots,
       (SELECT count(*) FROM buildings b
         WHERE b.world_id=$1 AND b.company_id=$2)::text AS buildings,
       (SELECT count(*) FROM buildings b
         WHERE b.world_id=$1 AND b.company_id=$2 AND b.status='producing')::text AS producing,
       (SELECT COALESCE(SUM(ii.quantity),0) FROM inventory_items ii
         JOIN inventories v ON v.id=ii.inventory_id
        WHERE v.world_id=$1 AND v.company_id=$2)::text AS stock,
       (SELECT count(*) FROM trades t
         WHERE t.world_id=$1 AND t.seller_company_id=$2)::text AS trades_sold,
       (SELECT COALESCE(SUM(a.balance),0) FROM accounts a
        WHERE a.world_id=$1 AND a.owner_type='company'
          AND a.owner_id=$2 AND a.kind='cash')::text AS cash`,
    [worldId, companyId],
  )
  return {
    plots: Number(f?.plots ?? 0),
    buildings: Number(f?.buildings ?? 0),
    producing: Number(f?.producing ?? 0),
    stock: Math.round(Number(f?.stock ?? 0)),
    tradesSold: Number(f?.trades_sold ?? 0),
    cash: Number(f?.cash ?? 0),
  }
}

const q = (
  code: string, title: string, desc: string, hint: string,
  have: number, need: number, reward: string | null = null,
): Quest => ({
  code, title, desc, hint, have: Math.min(have, need), need,
  done: have >= need, reward,
})

/** Questový řetěz pro jednu firmu. Pořadí = pořadí učení herní smyčky. */
export async function questState(d: Db, worldId: number, companyId: number): Promise<QuestState> {
  const f = await facts(d, worldId, companyId)

  const quests: Quest[] = [
    q('zaloz', 'Založ firmu',
      'Vyber jméno a odvětví, svět ti dá startovní kapitál.',
      '—', 1, 1),
    q('pozemek', 'Kup první pozemek',
      'Půda je vzácný zdroj: co není koupené, to může koupit soupeř.',
      'Klikni v mapě na volný pozemek správného terénu a kup ho.',
      f.plots, 1),
    q('stavba', 'Postav první budovu',
      'Budova musí sedět na terén: les pro dřevaře, důl pro těžaře, zóna pro továrny.',
      'Klikni na svůj pozemek a vyber budovu z nabídky v inspektoru.',
      f.buildings, 1),
    q('vyroba', 'Rozběhni výrobu',
      'Budova každých pár vteřin vyrábí a plní svůj sklad (tick světa).',
      'Nic nedělej — sleduj tečku nad budovou. Zelená = vyrábí. Červená = chybí vstupy.',
      f.producing > 0 || f.stock > 0 ? 1 : 0, 1),
    q('prodej', 'Prodej první zboží',
      'Ceny nediktuje hra, ale nabídněte a poptávka hráčů a NPC v order booku.',
      'V inspektoru u své budovy klikni „Prodat vše“, nebo zkus Terminál ručně.',
      f.tradesSold, 1, 'Odemkne Terminál (expertní order book)'),
    q('expanze', 'Rozšíř provoz na 3 budovy',
      'Řetězce vydělávají: surovina → polotovar → finální výrobek s prodejnou.',
      'Kup další pozemek a postav navazující budovu (třeba pilu ke kládám).',
      f.buildings, 3),
    q('magnat', 'Naspoř 30 000 Kč hotovosti',
      'Hotovost je kyslík: platí se z ní údržby a nákupy pozemků.',
      'Drž výrobu v chodu, prodávej a nestav, na co nejsou peníze.',
      f.cash, 30_000, 'Titul „Magnát“ v HUD'),
  ]

  const active = quests.find((x) => !x.done) ?? null
  const sellQuest = quests.find((x) => x.code === 'prodej')
  return { quests, active, terminalUnlocked: sellQuest?.done ?? false }
}
