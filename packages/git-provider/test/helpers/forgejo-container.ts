// Der Forgejo-Testcontainer-Helfer lebt jetzt in src/testing.ts und wird als
// Subpfad-Export `@f451/git-provider/testing` bereitgestellt (siehe package.json),
// damit ihn andere Workspace-Pakete (z. B. apps/api) im Integrationstest nutzen
// können. Diese Datei bleibt als Re-Export bestehen, damit die Bestands-Tests
// dieses Pakets unverändert `./helpers/forgejo-container.js` importieren können.
export * from '../../src/testing.js'
