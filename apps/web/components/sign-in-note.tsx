/**
 * Operator note under the sign-in buttons (F451_SIGNIN_NOTE), plain text with
 * line breaks. Lines of the form `Label: user / password` become a row with
 * the credentials in code style; a first line without a colon is the title.
 */
const ROW = /^(.+?):\s*(\S+)\s*\/\s*(\S+)$/

export function SignInNote({ text }: { text: string }) {
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean)
  if (lines.length === 0) return null
  const [first, ...rest] = lines
  const title = first && !first.includes(':') ? first : null
  const body = title ? rest : lines
  return (
    <div className="login-note">
      {title ? <p className="login-note-title">{title}</p> : null}
      {body.map((line, i) => {
        const m = ROW.exec(line)
        return m ? (
          <p key={i} className="login-note-row">
            <span>{m[1]}</span>
            <code>{m[2]}</code>
            <code>{m[3]}</code>
          </p>
        ) : (
          <p key={i} className="login-note-line">{line}</p>
        )
      })}
    </div>
  )
}
