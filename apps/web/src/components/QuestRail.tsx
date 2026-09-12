import { useState } from 'react'
import type { QuestState } from '../api'

/**
 * Questový rail — jediný „učitel“ ve hře.
 *
 * Ukazuje AKTIVNÍ quest s progressem a konkrétním hintem („klikni na…“),
 * zbytek řetězu je sbalený, aby hráč neviděl deset úkolů naráz (progresivní
 * disclosure). Terminál se odemyká až questem „prodej“ — do té doby stačí
 * jedno kliknutí „Prodat vše“ v inspektoru.
 */
export default function QuestRail({ quests }: { quests: QuestState | null }) {
  const [open, setOpen] = useState(false)
  if (!quests) return null
  const a = quests.active

  return (
    <div className="quest">
      {a ? (
        <>
          <div className="quest__head">
            <span className="quest__tag">úkol {quests.quests.filter((x) => x.done).length + 1}
              /{quests.quests.length}</span>
            <span className="quest__title">{a.title}</span>
          </div>
          <div className="quest__bar">
            <i style={{ width: `${Math.min(100, (a.have / a.need) * 100)}%` }} />
          </div>
          <p className="quest__desc">{a.desc}</p>
          <p className="quest__hint">💡 {a.hint}</p>
          {a.reward && <p className="quest__reward">🎁 {a.reward}</p>}
        </>
      ) : (
        <div className="quest__head">
          <span className="quest__tag">hotovo</span>
          <span className="quest__title">Všechny úkoly splněny — svět je tvůj.</span>
        </div>
      )}

      <button className="quest__toggle" onClick={() => setOpen(!open)}>
        {open ? 'sbalit řetěz ↑' : 'celý řetěz úkolů ↓'}
      </button>
      {open && (
        <ol className="quest__list">
          {quests.quests.map((x) => (
            <li key={x.code} className={x.done ? 'is-done' : x.code === a?.code ? 'is-active' : ''}>
              <span className="quest__mark">{x.done ? '✓' : '·'}</span>
              <span className="quest__name">{x.title}</span>
              <span className="quest__prog">{x.have}/{x.need}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  )
}
