import { mkdirSync, writeFileSync } from 'node:fs'
import { buildCss } from './css.js'

// Schreibt, was `buildCss()` erzeugt — die Erzeugung selbst steht in css.ts,
// damit sie ohne Dateisystem prüfbar ist (und der spätere Theme-Auflöser
// denselben Weg nimmt, statt einen zweiten aufzumachen).
mkdirSync('dist', { recursive: true })
writeFileSync('dist/tokens.css', buildCss())
console.log('dist/tokens.css geschrieben')
