# Credion MB — Financieringsrapport-tool

Zet een Capsearch-memorandum / financieringsplan (PDF) om naar een
professioneel, bankwaardig financieringsmemorandum in Credion MB-stijl
(Amsterdam & Texel).

De tool is **volledig data-gedreven**: het rapport wordt opgebouwd uit één
JSON-datamodel dat de AI-agent per casus vult. Er staan geen cijfers of
teksten vast in de opmaak — elke upload geeft een ander rapport. De
ingebouwde Matrading-data dient alleen als voorbeeld/fallback voor de
preview wanneer er (nog) geen backend is gekoppeld.

## Bestanden
- `index.html` — de volledige front-end (upload → loading → rapport + adviseur-controles). Zelfstandig bestand, geen build-stap. Rendert het rapport uit het datamodel; ontbrekende secties worden overgeslagen, ontbrekende velden gelabeld.
- `api/generate-report.js` — OpenAI-aanroep (Responses API, `gpt-4.1`). Ontvangt de PDF als base64, leest hem uit, herschrijft in Credion MB-stijl en levert het JSON-datamodel terug.
- `package.json` — dependency (`openai`).

## Vercel — environment variables
Onder **Project → Settings → Environment Variables**:

| Variabele | Waarde |
|---|---|
| `OPENAI_API_KEY` | je OpenAI API-key |

Na wijzigen altijd opnieuw **Redeploy**. (Er is geen Blob-store meer nodig; de PDF wordt rechtstreeks als base64 naar de functie gestuurd.)

## Deploy
1. Zet deze map (`index.html` + `api/` + `package.json`) in een GitHub-repo.
2. Koppel de repo in Vercel (framework preset: **Other** — geen build nodig).
3. Zet `OPENAI_API_KEY` en deploy.

## Datacontract (front-end ↔ API)
```
POST /api/generate-report
body: { "filename": "memo.pdf", "dataBase64": "<base64 van de PDF>", "notities": "<optioneel>" }
→ { "success": true, "data": "<JSON-string volgens het datamodel>" }
```
De front-end parset `data` met `JSON.parse(...)` en rendert daarmee de pagina's.
Lukt de call niet, dan valt de front-end terug op de ingebouwde voorbeelddata,
zodat de demo altijd iets toont.

## Het datamodel
Het volledige schema (met alle secties en toegestane waarden) staat als
`SYSTEM`-prompt boven in `api/generate-report.js`. Kernpunten:
- Elke sectie is **optioneel** — laat weg wat niet in de bron staat.
- De agent **verzint geen cijfers**. Ontbrekende gegevens komen terug als
  `"Niet opgenomen in bron"`, `"Nog te controleren"`,
  `"Afstemmen met actuele bankopgave"` of `"Aanvullen door adviseur"`.
- Vlaggen: `accent` (blauw benadrukt), `ok` (groen), `neg` (rood/aftrek),
  `total` (vette tabelregel), `primary`/`ster` (organogram/partij-nadruk).

## Belangrijk
De front-end is leidend voor de opmaak; de agent levert alleen inhoud (het
datamodel). Zo blijft het rapport strak en consistent, ongeacht de casus.
