/**
 * Toast notifikace — zpětná vazba hry.
 *
 * „Zakázka splněna +1 240 Kč", „Výzkum hotový", „⭐ Úroveň 2!" patří do hry,
 * ne do suchého chybového řádku v inspektoru. Vrstva se vznáší vpravo dole,
 * toasty mizí samy po 5 s (success) / 7 s (varování), klik je zavře hned.
 * Vypnutí provádí App (setTimeout při push), tady je jen prezentace.
 */

export type ToastKind = 'success' | 'info' | 'warn'

export type Toast = {
  id: number
  kind: ToastKind
  title: string
  text?: string
}

const ICON: Record<ToastKind, string> = { success: '✅', info: 'ℹ️', warn: '⚠️' }

type Props = {
  toasts: Toast[]
  onDismiss: (id: number) => void
}

export default function ToastHost({ toasts, onDismiss }: Props) {
  if (toasts.length === 0) return null
  return (
    <div className="toast-host" role="status" aria-live="polite">
      {toasts.map((t) => (
        <button key={t.id} className={`toast toast--${t.kind}`} onClick={() => onDismiss(t.id)}>
          <span className="toast__icon">{ICON[t.kind]}</span>
          <span className="toast__body">
            <span className="toast__title">{t.title}</span>
            {t.text && <span className="toast__text">{t.text}</span>}
          </span>
        </button>
      ))}
    </div>
  )
}
