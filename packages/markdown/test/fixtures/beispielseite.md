---
id: 8f3ka2
title: Deployment-Prozess
tags: [betrieb, ci-cd]
lang: de
archived: false
relations:
  depends_on: [monitoring, secrets-management]
  supersedes: [deployment-legacy]
---

# Deployment-Prozess

Dieser Leitfaden beschreibt den Deployment-Prozess für Produktionsdienste. Er richtet
sich an alle, die Änderungen an [[betrieb/monitoring]] oder an der
[[Secrets-Management|Verwaltung von Secrets]] vornehmen.

Weitere Details stehen im [Runbook](../runbooks/index.md) sowie in der offiziellen
[Kubernetes-Dokumentation](https://kubernetes.io/docs/) (externer Link). Der Link zur
[veralteten Anleitung](./anleitung-fehlt.md) führt ins Leere, da die Seite entfernt wurde.

## Voraussetzungen

Vor dem Deployment müssen folgende Schritte erledigt sein:

- [x] Zugriff auf den Deployment-Cluster eingerichtet
- [x] Secrets in Vault hinterlegt
- [ ] Monitoring-Dashboard für den Dienst angelegt
- [ ] Rollback-Plan dokumentiert

### Checkliste im Detail

| Schritt | Verantwortlich | Status |
|---------|-----------------|--------|
| Zugriff prüfen | Betrieb | erledigt |
| Secrets rotieren | Sicherheit | erledigt |
| Dashboard anlegen | Betrieb | offen |

> [!WARNING]
> Ein Deployment außerhalb des Wartungsfensters kann zu Ausfällen führen. Vorher immer
> Rücksprache mit dem Betrieb halten.

Der eigentliche Rollout erfolgt über folgendes Skript:

```ts
async function deploy(service: string, version: string): Promise<void> {
  await kubectl.apply(`deploy/${service}`, { version })
  await waitForRollout(service)
}
```

## Architektur

Die folgende Grafik zeigt den Aufbau des Systems:

![Architekturdiagramm](_media/arch.drawio.svg)

> Dies ist ein normales Zitat ohne Alert-Marker, zum Beispiel eine Anmerkung aus einem
> vergangenen Incident-Review.

## Weiterführende Hinweise

Bei Fragen wende dich an das Betriebsteam oder konsultiere die interne Wissensdatenbank.
