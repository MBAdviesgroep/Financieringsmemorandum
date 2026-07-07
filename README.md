# Credion — Financieringsrapport Generator

Transformeert een geüpload financieringsdocument (Capsearch-memorandum, financieringsplan, jaarrekeningpakket, prognose, taxatie of ander dossierdocument) naar een professioneel Credion-financieringsrapport — volledig dynamisch, zonder enige hardcoded casusdata.

## Werking

1. **Upload** — PDF, DOCX, XLSX, CSV, TXT, JPG of PNG (max. 8 bestanden, 25 MB per stuk). PDF/afbeeldingen gaan via Vercel Blob (voorkomt 504's door zware payloads); DOCX/XLSX worden client-side naar tekst omgezet.
2. **AI-analyse** (`/api/generate-report`) — leest het volledige document, inventariseert hoofdstukken/tabellen/afbeeldingen/organogrammen (`bronrapport`), verantwoordt per bronhoofdstuk wat ermee gebeurt (`coverage_check`), extraheert bronfeiten met bronverwijzing en bouwt daarna pas het rapport op. Strict structured output (JSON-schema).
3. **Server-side kwaliteitslaag** — 0-fallbacks → null; bronnen/aanwendingen-herclassificatie (eigen inbreng/lening = bron, koopsom/kosten koper = aanwending) + sluitcheck; datumregels (rapportdatum ≠ geboorte-/oprichtings-/taxatiedatum); lege/onbetrouwbare grafiekdata verwijderd; te stellige conclusies teruggezet; documentatieclaims gecorrigeerd ("ontvangen" alleen voor echt aangeleverde stukken); coverage-waarschuwingen; scan op demo-markers en afgekapte tekst.
4. **Renderer** (`index.html`) — `validateReportBeforeRender()` blokkeert onbetrouwbare rapporten met een nette foutkaart. Daarna gemeten paginering op echte A4-pagina's (210×297 mm): hoofdstukken vullen pagina's proportioneel aan de broninhoud, koppen nooit onderaan zonder inhoud, tabellen/grafieken breken nooit. Organogrammen worden uit gestructureerde data opnieuw getekend (SVG-connectoren, percentages, Credion-stijl). Grafieken (financieringsmix, omzet/resultaat, DSCR, zekerhedenmix) alleen bij echte brondata.
5. **Print/PDF** — pagina's zijn op scherm al exact A4; print gebruikt dezelfde mm-maten (geen scale/zoom), verbergt toolbar/uploadscherm en levert 1:1 PDF-output.

## Rapporttypes

- **Financieringsmemorandum** — bij voldoende datadekking (kredietnemer + doel + bedrag + cijfers).
- **Intake- en documentatiememorandum** — bij beperkte data: eerlijk overzicht van wat vaststaat, wat ontbreekt en welke stukken nodig zijn. De server dwingt dit af; de AI kan zichzelf niet "promoveren".

## Geen hardcoded casusdata

Frontend, backend, schema, prompt en validatie bevatten geen klantnamen, bedragen, datums, organogrammen of demo-objecten. Alles komt per upload uit de aangeleverde documenten; onbekend = null (nooit 0). Testen kan via de console-hook `window.__credionRender(reportJson)` met eigen mock-JSON (staat niet in de tool).

## Deploy (Vercel)

- Environment variables: `OPENAI_API_KEY` (verplicht), `BLOB_READ_WRITE_TOKEN` (Vercel Blob store koppelen), optioneel `OPENAI_MODEL` (default `gpt-4.1-mini`).
- `vercel.json` zet `maxDuration: 300` voor `api/generate-report.js`.
- Endpoints: `POST /api/generate-report`, `POST /api/upload` (Blob client-upload handshake), `GET /api/health`.

## API-contract

`POST /api/generate-report` met:

```json
{
  "documents": [
    { "filename": "memo.pdf", "kind": "pdf", "url": "https://...blob..." },
    { "filename": "cijfers.xlsx", "kind": "text", "text": "..." },
    { "filename": "foto.png", "kind": "image", "dataBase64": "..." }
  ],
  "notities": "optionele adviseursnotities"
}
```

Het oude contract (`dataBase64` / `memorandum_url` / `extra_urls`) blijft ondersteund. Response: `{ success: true, data: <rapport-JSON> }` of `{ error: "nette NL-foutmelding" }`.
