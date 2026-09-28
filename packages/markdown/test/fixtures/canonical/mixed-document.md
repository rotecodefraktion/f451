# Betriebshandbuch: Monitoring

Kurze Einleitung mit einem Wikilink zu [[betrieb/eskalation|Eskalationsplan]] und einem
relativen Link zu [den Rohdaten](../daten/export.csv).

## Aufgaben

- [x] Dashboards eingerichtet
- [ ] Alarmierung final abgenommen
  - [ ] Eskalationskette getestet

## Architektur

![Systemübersicht](diagramme/system.drawio.svg)

| Komponente | Owner  | Status        |
| ---------- | ------ | ------------- |
| Ingest     | Team A | *stabil*      |
| Alerting   | Team B | **in Arbeit** |

> [!WARNING]
> Änderungen an der Alarmierung erst nach Rücksprache mit Team B.

Details siehe Video: https://www.youtube.com/watch?v=dQw4w9WgXcQ

```bash
kubectl get pods -n monitoring
```

---

Ende des Dokuments.
