/** Basisfehler aller Provider-Operationen; trägt HTTP-Status und Antwort-Body. */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly status: number = 0,
    public readonly body: string = '',
  ) {
    super(message)
    this.name = new.target.name
  }
}

/** Ressource (Datei, Branch, PR, Repo) existiert nicht. */
export class NotFoundError extends ProviderError {
  constructor(message: string, body = '') {
    super(message, 404, body)
  }
}

/** Konflikt — z. B. Schreibzugriff mit veraltetem SHA oder nicht mergebarer PR. */
export class ConflictError extends ProviderError {
  constructor(message: string, body = '') {
    super(message, 409, body)
  }
}

/** Mappt einen HTTP-Fehlerstatus auf den passenden Fehlertyp. 422 gilt als Konflikt
 *  (GitHub meldet SHA-Mismatches als 422). */
export function toProviderError(status: number, body: string): ProviderError {
  if (status === 404) return new NotFoundError(`nicht gefunden (404)`, body)
  if (status === 409 || status === 422) return new ConflictError(`Konflikt (${status})`, body)
  return new ProviderError(`Provider-Fehler (${status})`, status, body)
}
