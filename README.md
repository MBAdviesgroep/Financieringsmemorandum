# Credion — Financieringsrapport Generator

Zet een aangeleverd memorandum (bijv. Capsearch), financieringsplan, jaarrekening, prognose of taxatie om naar een compact, bankwaardig Credion-financieringsrapport van 6–8 A4-pagina's.

## Uitgangspunten

- **Bronwaarheid**: elke naam, elk bedrag, elke conclusie is herleidbaar uit de geüploade documenten. Geen demo-data, geen voorbeeldcijfers, geen € 0-fallbacks (onbekend = `null`).
- **Compact**: het rapport is een executive samenvatting, geen herschreven Capsearch. Normaal 6–8 pagina's; secties zonder brondata worden weggelaten of gecombineerd (documentatiecheck bij conclusie, aanvraag bij financieringsopzet). Geen aparte inhoudsopgave bij korte rapporten.
- **Datadekking** wordt server-side deterministisch bepaald: `hoog` / `middel` / `beperkt` — geen cosmetische rapportscore. Bij onvoldoende dekking wordt automatisch een intake- en documentatiememorandum gemaakt.
- **Conclusiebeleid**: voorzichtig en genuanceerd ("voorlopig", "mits", "na adviseurscontrole"). Positieve conclusies zonder onderbouwing worden server-side geblokkeerd.
- **Grafieken** alleen bij echte brondata (min. 2 datapunten); anders een compacte infomelding.
- **Print/PDF**: iedere pagina is exact 210×297 mm, op scherm én in print (geen transform/zoom in print; responsieve schaal is scoped op `@media screen`). Toolbar en uploadscherm zitten nooit in de PDF.

## Bestanden

- `index.html` — front-end: uploadscherm → analyse → A4-rapport → print/PDF. Credion-logo's inline (base64).
- `api/generate-report.js` — OpenAI Responses API met strict `json_schema` + server-side kwaliteitslaag (nul-fallbacks, datadekking, rapporttype, conclusiebewaking, grafiekvalidatie, bronnen/aanwendingen-consistentiecheck).
- `api/upload.js` — Vercel Blob client-token voor rechtstreekse browser-upload.
- `api/health.js` — `{ ok, hasBlobToken, hasOpenAIKey, runtime }`.
- `package.json` — dependencies (`openai`, `@vercel/blob`).
- `vercel.json` — `maxDuration: 60` voor de rapport-functie.

## Vercel environment variables

| Variabele | Waarde |
|---|---|
| `OPENAI_API_KEY` | je OpenAI API-key |
| `BLOB_READ_WRITE_TOKEN` of `BLOB2_READ_WRITE_TOKEN` | token van een Vercel Blob store |

Na wijzigen van env-vars altijd opnieuw redeployen.

## Datacontract

```json
POST /api/generate-report
{
  "documents": [
    { "filename": "memo.pdf", "kind": "pdf", "dataBase64": "<kale base64>", "url": "<blob-url fallback>" },
    { "filename": "foto.jpg", "kind": "image", "mime": "image/jpeg", "dataBase64": "..." },
    { "filename": "cijfers.xlsx", "kind": "text", "text": "<geëxtraheerde tekst>" }
  ],
  "notities": "<optionele adviseursnotities>",
  "filename": "…", "dataBase64": "…", "memorandum_url": "…"  // oud contract, blijft werken
}
```

Response: `{ "success": true, "data": { "metadata": {…}, "bronfeiten": {…}, "managementsamenvatting": {…}, "aanvraag_en_structuur": {…}, "financieringsopzet": {…}, "financiele_analyse": {…}, "zekerheden_en_risico": {…}, "conclusie": {…}, "documentatiecheck": {…}, "visualisaties": {…}, "kwaliteitscontrole": {…} } }`

## Rapportstructuur (financieringsmemorandum)

1. Voorblad (klantnaam, doel, type, datum, status, datadekking, inhoudsregel)
2. Managementsamenvatting (1 pagina: kernboodschap, KPI's, sterktes/risico's, voorlopig oordeel)
3. Aanvraag & structuur (partijen, juridische structuur)
4. Financieringsopzet (kerncijfers, bronnen & aanwendingen, financieringsmix, faciliteiten, voorwaarden)
5. Financiële analyse (resultaten, max. 2 grafieken, kengetallen, observaties)
6. Zekerheden & risico's (zekerheden, dekkingspositie, risicomatrix)
7. Conclusie & aandachtspunten (+ compacte documentatiecheck indien passend)

Korte secties worden gecombineerd; lege secties worden overgeslagen en expliciet benoemd op de conclusiepagina.

## Frontend-flow

1. Eén uploadkaart voor PDF, DOCX, XLSX, CSV, TXT, JPG en PNG (max 25 MB per bestand, max 8 bestanden). DOCX/XLSX worden client-side naar tekst geëxtraheerd.
2. Genereren: documenten lezen → blob-upload (niet-fataal) → `POST /api/generate-report` → validatie → A4-rapport.
3. Debug: in de browserconsole rendert `window.__credionRender(jsonObject)` een rapport zonder API-call.

## Testplan

1. Open de site: alleen logo, titel, subtitel, uploadkaart, twee knoppen en disclaimer zichtbaar.
2. Upload een Capsearch-memorandum (PDF) en genereer; controleer dat bedragen exact uit de bron komen en dat het rapport 6–8 pagina's is.
3. Print/PDF: elke pagina vult exact één A4, geen verkleinde kaart, geen toolbar.
4. Test een dun dossier (bijv. alleen een notitie): rapporttype wordt intake- en documentatiememorandum, conclusie "onvoldoende data".
5. Download JSON en controleer `bronfeiten` (bron_document + bron_fragment per feit) en `kwaliteitscontrole.waarschuwingen`.

## Deploy

1. Push naar de gekoppelde repo of upload via Vercel CLI.
2. Controleer env-vars voor Production én Preview; na wijziging redeployen.
3. Open de site met Ctrl+F5 en doorloop het testplan.
