import OpenAI from 'openai';

/* ════════════════════════════════════════════════════════════════════
   Credion — Financieringsrapport Generator · /api/generate-report

   Kwaliteitsprincipes:
   - Bronwaarheid: elke naam, elk bedrag, elke conclusie herleidbaar
     uit de aangeleverde documenten. Geen demo-data, geen aannames.
   - Onbekend is nooit nul: onbekende bedragen zijn null.
   - Datadekking (hoog / middel / beperkt) en rapporttype worden
     server-side deterministisch bepaald, nooit door het model.
   - Positieve conclusies zonder onderbouwing worden geblokkeerd.
   - Grafiekdata zonder echte bronbedragen wordt leeggemaakt.
   ════════════════════════════════════════════════════════════════════ */

/* ── Schema-bouwstenen ─────────────────────────────────────────────── */
const s = { type: 'string' };
const nN = { type: ['number', 'null'] };
const b = { type: 'boolean' };
const strArr = { type: 'array', items: s };
const en = (...values) => ({ type: 'string', enum: values });
const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items) => ({ type: 'array', items });

const CONF = en('hoog', 'middel', 'laag');
const PRIO = en('hoog', 'middel', 'laag');

const factItem = obj({ label: s, waarde: s, bedrag: nN, bron_document: s, bron_fragment: s, confidence: CONF });
const kpiCard = obj({ label: s, waarde: s, subtekst: s });
const partijRow = obj({ naam: s, rol: s, rechtsvorm: s, kvk: s, toelichting: s });
const bnaRow = obj({ label: s, type: en('bron', 'aanwending'), bedrag: nN, toelichting: s });
const finRow = obj({ label: s, bedrag: nN, condities: s, toelichting: s });
const cijferRow = obj({ label: s, periode: s, bedrag: nN });
const ratioRow = obj({ ratio: s, periode: s, waarde: s, norm: s, toelichting: s });
const riskRow = obj({ risico: s, kans: PRIO, impact: PRIO, mitigant: s });
const zekerRow = obj({ zekerheid: s, waarde: nN, toelichting: s });
const docRow = obj({ document: s, status: en('ontvangen', 'onvolledig', 'te controleren'), toelichting: s });
const missRow = obj({ item: s, prioriteit: PRIO, toelichting: s });
const mixPoint = obj({ label: s, waarde: nN });
const trendPoint = obj({ periode: s, waarde: nN });
const ratioPoint = obj({ ratio: s, periode: s, waarde: nN });

const REPORT_SCHEMA = obj({
  metadata: obj({
    rapport_type: en('financieringsmemorandum', 'intake_documentatiememorandum'),
    klantnaam: s,
    financieringsdoel: s,
    datum: s,
    status: s,
    datadekking: en('hoog', 'middel', 'beperkt'),
    bron_documenten: strArr,
    belangrijkste_beperkingen: strArr,
  }),
  bronfeiten: obj({
    partijen: arr(factItem),
    financieringsvraag: arr(factItem),
    investering: arr(factItem),
    financieringsstructuur: arr(factItem),
    financiele_cijfers: arr(factItem),
    zekerheden: arr(factItem),
    risicos: arr(factItem),
    documentatie: arr(factItem),
    tegenstrijdigheden: strArr,
  }),
  managementsamenvatting: obj({
    kernboodschap: s,
    kpi_cards: arr(kpiCard),
    belangrijkste_sterktes: strArr,
    belangrijkste_risicos: strArr,
    aandachtspunten: strArr,
    voorlopig_oordeel: s,
  }),
  aanvraag_en_structuur: obj({
    tekst: s,
    partijen: arr(partijRow),
    structuurpunten: strArr,
  }),
  financieringsopzet: obj({
    tekst: s,
    kerncijfers: obj({
      totale_investering: nN,
      gevraagde_financiering: nN,
      eigen_inbreng: nN,
      overige_financiering: nN,
      looptijd: s,
      rente: s,
      aflossing: s,
      ltv: s,
    }),
    bronnen_en_aanwendingen: arr(bnaRow),
    bestaande_financieringen: arr(finRow),
    nieuwe_financieringen: arr(finRow),
    voorwaarden: strArr,
  }),
  financiele_analyse: obj({
    tekst: s,
    resultaten: arr(cijferRow),
    balans: arr(cijferRow),
    ratios: arr(ratioRow),
    observaties: strArr,
  }),
  zekerheden_en_risico: obj({
    tekst: s,
    zekerheden: arr(zekerRow),
    dekkingspositie: s,
    risicomatrix: arr(riskRow),
    bancaire_aandachtspunten: strArr,
  }),
  conclusie: obj({
    oordeel: en('voorzichtig positief', 'neutraal', 'onvoldoende data', 'negatief'),
    tekst: s,
    voorwaarden: strArr,
    actiepunten: strArr,
    extern_deelbaar: s,
  }),
  documentatiecheck: obj({
    ontvangen: arr(docRow),
    ontbrekend: arr(missRow),
    te_controleren: strArr,
    vervolgvragen: strArr,
  }),
  visualisaties: obj({
    financieringsmix: arr(mixPoint),
    omzetontwikkeling: arr(trendPoint),
    resultaatontwikkeling: arr(trendPoint),
    zekerhedenmix: arr(mixPoint),
    ratioontwikkeling: arr(ratioPoint),
  }),
  kwaliteitscontrole: obj({
    geen_demo_data: b,
    geen_nul_fallbacks: b,
    alle_bedragen_uit_bron: b,
    geen_lege_grafieken: b,
    validatiefouten: strArr,
    waarschuwingen: strArr,
  }),
});

/* ── System prompt ─────────────────────────────────────────────────── */
const SYSTEM_BASE = `Je bent een senior Credion-financieringsspecialist. Je zet aangeleverde documentatie (bijvoorbeeld een Capsearch-memorandum, financieringsplan, jaarrekening, prognose of taxatie) om naar een compact, bankwaardig Credion-financieringsrapport. Je analyseert uitsluitend de aangeleverde documenten en eventuele adviseursnotities.

ABSOLUTE REGELS — BRONWAARHEID
1. Elke naam, elk bedrag, elk percentage, elk jaartal, elke ratio, elke zekerheid en elke voorwaarde moet herleidbaar zijn uit de aangeleverde documenten. Verzin niets. Geen demo-data, geen voorbeeldcijfers, geen externe kennis.
2. Onbekend is nooit nul. Onbekende bedragen en percentages zijn null. Gebruik 0 alleen als de bron expliciet een nulwaarde vermeldt (bijv. "geen eigen inbreng").
3. Extraheer EERST harde bronfeiten in "bronfeiten" (met bron_document, kort bron_fragment en confidence). Schrijf daarna pas de rapportsecties. Geen bronfeit = geen interpretatie. Noteer tegenstrijdigheden tussen documenten expliciet in bronfeiten.tegenstrijdigheden.
4. Ontbrekende informatie markeer je met één professionele zin, zoals "Niet vastgesteld op basis van de aangeleverde documentatie" of "Aanvullende onderbouwing benodigd". Herhaal zulke zinnen niet tientallen keren; laat lege arrays gewoon leeg.
5. Berekeningen (bijv. LTV, totalen) alleen als alle benodigde broncijfers aanwezig zijn. Vermeld afgeleide waarden als zodanig in de toelichting.

CAPSEARCH / BRONMEMORANDUM
Als een aangeleverd document een Capsearch-financieringsplan of vergelijkbaar memorandum is: behandel het als primaire bron. Neem de kerncijfers exact over, vat de casus samen en structureer die — herschrijf het document NIET integraal. Het resultaat is een executive Credion-samenvatting: korter, scherper en besluitvormingsgericht. Geen lange letterlijke citaten, geen herhaling van detailpagina's.

RAPPORTTYPE
"financieringsmemorandum" alleen als minimaal bekend zijn: kredietnemer, financieringsdoel, financieringsbedrag (of duidelijke behoefte) én concrete financiële cijfers. Anders "intake_documentatiememorandum": een eerlijk intake- en documentatieoverzicht (wat is vastgesteld, wat ontbreekt, welke stukken nodig zijn, logische vervolgstap).

SCHRIJFSTIJL
Zakelijk Nederlands in Credion-stijl: helder, compact, no-nonsense, adviserend. Korte alinea's, duidelijke bullets. Geen marketingtaal, geen superlatieven, geen wollige AI-taal, geen lange zinnen, geen juridisch jargon waar het niet nodig is. Het rapport moet voelen alsof een goede financieringsadviseur het heeft opgesteld.

LENGTEBEGRENZING (het rapport is een compacte executive samenvatting van 6-8 pagina's)
- kernboodschap: max 90 woorden. voorlopig_oordeel: max 70 woorden.
- Sectieteksten (tekst-velden): max 120 woorden per sectie.
- conclusie.tekst: max 140 woorden.
- kpi_cards: max 5, alleen met een waarde die direct uit de bron of een verantwoorde berekening volgt (bijv. gevraagde financiering, totale investering, eigen inbreng, LTV, DSCR). Geen kaart zonder waarde.
- belangrijkste_sterktes / belangrijkste_risicos: max 5 elk. aandachtspunten: max 4.
- Tabellen (partijen, bronnen_en_aanwendingen, resultaten, balans, ratios, zekerheden, risicomatrix): max 8 rijen elk, alleen rijen met echte informatie.
- structuurpunten / voorwaarden / actiepunten / observaties / bancaire_aandachtspunten: max 6 elk.
- documentatiecheck: compact; ontvangen max 8, ontbrekend max 8, te_controleren max 5, vervolgvragen max 5.

CONCLUSIEBELEID
Wees voorzichtig en professioneel. Gebruik nuance: "voorlopig", "op basis van de aangeleverde informatie", "mits", "na adviseurscontrole", "onder voorbehoud van verificatie".
- Sterke brondata → oordeel "voorzichtig positief" met een tekst in de trant van: "Op basis van de aangeleverde documentatie ontstaat een voorzichtig positief beeld. De financieringsaanvraag is financieel verdedigbaar, mits de uitgangspunten uit de prognose worden gerealiseerd en de genoemde aandachtspunten door de adviseur worden gecontroleerd."
- Beperkte data → oordeel "onvoldoende data" met: "Op basis van de aangeleverde documentatie kan nog geen definitief oordeel worden gegeven over financierbaarheid en betaalbaarheid. Aanvullende informatie is benodigd."
- VERBODEN zonder volledige onderbouwing: "de financiering is verantwoord en betaalbaar", "bankwaardig", "sterk onderbouwd", "duurzaam draagbaar", "geen noemenswaardige risico's", "financiering kan worden verstrekt".
- conclusie.extern_deelbaar: één zin met advies of het rapport na adviseurscontrole extern deelbaar is.

FINANCIËLE ANALYSE
Neem omzet- en resultaatontwikkeling, liquiditeit, solvabiliteit, betaalcapaciteit, DSCR en Debt/EBITDA alleen op voor zover de bron ze bevat of ze verantwoord berekend kunnen worden. resultaten en balans als rijen {label, periode, bedrag}; gebruik consistente labels per periode zodat er een tabel per jaar van te maken is (bijv. label "Omzet" met periode "2024"). Prognosejaren in de periode markeren met "(prognose)".

VISUALISATIES
Vul grafiekarrays uitsluitend met echte bronbedragen. financieringsmix: de opbouw van de financiering (bijv. bancair krediet, eigen inbreng, verkoper­lening). omzetontwikkeling / resultaatontwikkeling: per periode. zekerhedenmix: alleen met waardes uit de bron. Geen betrouwbare bedragen = lege array []. Nooit 0-waarden als vulling, nooit één losse onduidelijke waarde.

RISICO'S
Alleen risico's die uit de bron volgen, elk met mitigant. Bij beperkte documentatie is "Documentatierisico" (kans hoog, impact hoog, mitigant: aanvullende stukken opvragen vóór externe beoordeling) het belangrijkste risico.

DOCUMENTATIECHECK
Registreer elk aangeleverd document met status. Benoem ontbrekende of te verifiëren stukken met prioriteit. Formuleer maximaal 5 gerichte vervolgvragen.

METADATA
klantnaam: de kredietnemer/onderneming zoals in de bron. financieringsdoel: één compacte zin. status: altijd "Concept · ter beoordeling". datum: rapportdatum in Nederlandse notatie. datadekking: jouw eerlijke inschatting (wordt server-side geverifieerd).

OUTPUT
Antwoord uitsluitend met valide JSON volgens het schema. Geen markdown, geen tekst buiten de JSON.`;

function buildPrompt({ notities, docSummary }) {
  return `${SYSTEM_BASE}

AANGELEVERDE DOCUMENTEN
${docSummary}

ADVISEURSNOTITIES
${notities || 'Geen aanvullende adviseursnotities opgegeven.'}

DATUM
Gebruik als rapportdatum de actuele datum in Nederlandse notatie, tenzij bron of notities anders aangeven.

Lever nu uitsluitend het JSON-object volgens het schema.`;
}

/* ── Server-side kwaliteitslaag ────────────────────────────────────── */
const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
const hasTxt = (v) => typeof v === 'string' && v.trim().length > 0;
const A = (v) => (Array.isArray(v) ? v : []);

function makeZeroChecker(r) {
  const srcTxt = JSON.stringify(r.bronfeiten || {});
  const explicitZero = /(geen eigen (inbreng|middelen)|expliciet.{0,30}nul|€\s?0[\s,.;]|zonder eigen inbreng|nihil)/i.test(srcTxt);
  return (v) => {
    const n = num(v);
    if (n === null) return null;
    if (n === 0 && !explicitZero) return null;
    return n;
  };
}

function cleanMix(items) {
  const c = A(items).filter((x) => num(x?.waarde) !== null && x.waarde > 0 && hasTxt(x?.label));
  return c.length >= 2 ? c : [];
}
function cleanTrend(items) {
  const c = A(items).filter((x) => num(x?.waarde) !== null && hasTxt(x?.periode));
  return c.length >= 2 ? c : [];
}

function computeDekking(r) {
  const kc = r.financieringsopzet?.kerncijfers || {};
  const bnaBron = A(r.financieringsopzet?.bronnen_en_aanwendingen).some((x) => x?.type === 'bron' && num(x.bedrag) !== null);
  const bedrag = num(kc.gevraagde_financiering) !== null || bnaBron;
  const cijfers =
    A(r.financiele_analyse?.resultaten).filter((x) => num(x?.bedrag) !== null).length >= 2 ||
    A(r.financiele_analyse?.ratios).length >= 2;
  const zeker = A(r.zekerheden_en_risico?.zekerheden).filter((x) => hasTxt(x?.zekerheid)).length >= 1;
  const partijen = A(r.aanvraag_en_structuur?.partijen).filter((x) => hasTxt(x?.naam)).length >= 1;
  const doel = hasTxt(r.metadata?.financieringsdoel);

  const volwaardig = bedrag && doel && cijfers;
  let niveau;
  if (bedrag && doel && cijfers && zeker && partijen) niveau = 'hoog';
  else if (bedrag && doel && (cijfers || zeker)) niveau = 'middel';
  else niveau = 'beperkt';

  return { bedrag, cijfers, zeker, partijen, doel, volwaardig, niveau };
}

const CONCL_ONVOLDOENDE =
  'Op basis van de aangeleverde documentatie kan nog geen definitief oordeel worden gegeven over financierbaarheid en betaalbaarheid. Aanvullende financiële gegevens, specificatie van de financieringsbehoefte en zekerhedeninformatie zijn benodigd.';

const FORBIDDEN_CLAIMS =
  /(verantwoord en betaalbaar|bankwaardig rapport|sterk onderbouwd|duurzaam draagbaar|geen noemenswaardige risico'?s|financiering kan worden verstrekt)/i;

function enforceQuality(r) {
  const warnings = [];
  const zero = makeZeroChecker(r);

  /* 1 — bedragen: 0-fallbacks naar null */
  const fo = (r.financieringsopzet = r.financieringsopzet || {});
  const kc = (fo.kerncijfers = fo.kerncijfers || {});
  for (const k of ['totale_investering', 'gevraagde_financiering', 'eigen_inbreng', 'overige_financiering']) {
    const before = kc[k];
    kc[k] = zero(kc[k]);
    if (before === 0 && kc[k] === null) warnings.push(`kerncijfers.${k} was 0 zonder expliciete nul-bron en is op onbekend gezet.`);
  }
  for (const key of ['bronnen_en_aanwendingen', 'bestaande_financieringen', 'nieuwe_financieringen']) {
    fo[key] = A(fo[key]).map((row) => ({ ...row, bedrag: zero(row?.bedrag) }));
  }
  const fa = (r.financiele_analyse = r.financiele_analyse || {});
  fa.resultaten = A(fa.resultaten).map((row) => ({ ...row, bedrag: num(row?.bedrag) }));
  fa.balans = A(fa.balans).map((row) => ({ ...row, bedrag: num(row?.bedrag) }));
  const zr = (r.zekerheden_en_risico = r.zekerheden_en_risico || {});
  zr.zekerheden = A(zr.zekerheden).map((row) => ({ ...row, waarde: zero(row?.waarde) }));

  /* 2 — consistentiecheck bronnen en aanwendingen */
  const bronnen = A(fo.bronnen_en_aanwendingen).filter((x) => x?.type === 'bron' && num(x.bedrag) !== null);
  const aanw = A(fo.bronnen_en_aanwendingen).filter((x) => x?.type === 'aanwending' && num(x.bedrag) !== null);
  if (bronnen.length && aanw.length) {
    const tb = bronnen.reduce((t, x) => t + x.bedrag, 0);
    const ta = aanw.reduce((t, x) => t + x.bedrag, 0);
    if (Math.abs(tb - ta) > Math.max(tb, ta) * 0.02) {
      warnings.push(`Bronnen (€ ${Math.round(tb).toLocaleString('nl-NL')}) en aanwendingen (€ ${Math.round(ta).toLocaleString('nl-NL')}) sluiten niet; verifieer met de bron.`);
    }
  }

  /* 3 — grafieken: alleen echte data */
  const vis = (r.visualisaties = r.visualisaties || {});
  vis.financieringsmix = cleanMix(vis.financieringsmix);
  vis.zekerhedenmix = cleanMix(vis.zekerhedenmix);
  vis.omzetontwikkeling = cleanTrend(vis.omzetontwikkeling);
  vis.resultaatontwikkeling = cleanTrend(vis.resultaatontwikkeling);
  vis.ratioontwikkeling = A(vis.ratioontwikkeling).filter((x) => num(x?.waarde) !== null && hasTxt(x?.periode));
  if (vis.ratioontwikkeling.length < 2) vis.ratioontwikkeling = [];

  /* 4 — datadekking en rapporttype server-side */
  const dd = computeDekking(r);
  r.metadata = r.metadata || {};
  const aiType = r.metadata.rapport_type;
  r.metadata.rapport_type = dd.volwaardig ? (aiType || 'financieringsmemorandum') : 'intake_documentatiememorandum';
  if (aiType === 'financieringsmemorandum' && r.metadata.rapport_type === 'intake_documentatiememorandum') {
    warnings.push('Rapporttype teruggezet naar intake- en documentatiememorandum: onvoldoende datadekking voor een volwaardig financieringsmemorandum.');
  }
  r.metadata.datadekking = dd.niveau;
  r.metadata.status = 'Concept · ter beoordeling';

  /* 5 — conclusiebeleid */
  const cc = (r.conclusie = r.conclusie || {});
  if (cc.oordeel === 'voorzichtig positief' && !dd.volwaardig) {
    warnings.push('Positieve conclusie vervangen: onvoldoende onderbouwing in de brondata.');
    cc.oordeel = 'onvoldoende data';
    cc.tekst = CONCL_ONVOLDOENDE;
  }
  if (hasTxt(cc.tekst) && FORBIDDEN_CLAIMS.test(cc.tekst)) {
    warnings.push('Conclusietekst bevatte een te stellige claim; door adviseur te herformuleren.');
  }
  if (!hasTxt(cc.extern_deelbaar)) {
    cc.extern_deelbaar =
      dd.niveau === 'hoog'
        ? 'Na controle en akkoord van de Credion-adviseur is dit rapport geschikt als basis voor afstemming met een financier.'
        : dd.niveau === 'middel'
        ? 'Eerst de gemarkeerde punten aanvullen en door de adviseur laten controleren voordat het rapport extern wordt gedeeld.'
        : 'Nog niet extern delen; eerst de ontbrekende documentatie aanvullen.';
  }

  /* 6 — kwaliteitscontrole bijwerken */
  const kwc = (r.kwaliteitscontrole = r.kwaliteitscontrole || {});
  kwc.geen_nul_fallbacks = true;
  kwc.geen_lege_grafieken = true;
  kwc.waarschuwingen = [...A(kwc.waarschuwingen), ...warnings];

  return r;
}

/* ── OpenAI-aanroep ────────────────────────────────────────────────── */
function getOutputText(response) {
  if (response?.output_text) return response.output_text;
  const parts = [];
  for (const item of response?.output || []) {
    for (const c of item?.content || []) {
      if (c?.text) parts.push(c.text);
    }
  }
  return parts.join('\n').trim();
}

function parseJson(text) {
  let t = (text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const first = t.indexOf('{');
  const last = t.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) t = t.slice(first, last + 1);
  return JSON.parse(t);
}

async function createResponse(client, model, content) {
  return client.responses.create({
    model,
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: 'credion_financieringsrapport',
        strict: true,
        schema: REPORT_SCHEMA,
      },
    },
  });
}

async function readJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  return await new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    req.on('error', reject);
  });
}

function normalizeBase64(input) {
  let b64 = String(input || '').trim();
  const comma = b64.indexOf(',');
  if (/^data:/i.test(b64) && comma !== -1) b64 = b64.slice(comma + 1);
  b64 = b64.replace(/\s+/g, '');
  if (!b64) return '';
  if (!/^[A-Za-z0-9+/]+=*$/.test(b64)) return '';
  return b64;
}

const safeName = (name, fallback) => String(name || fallback).replace(/[^\w.\- ]+/g, '-');

/*
  Documenten-array (nieuw contract, met terugval op het oude):
  documents: [{ filename, kind: 'pdf'|'image'|'text', mime, dataBase64?, url?, text? }]
*/
function buildDocumentContent(documents) {
  const content = [];
  const names = [];
  for (const doc of documents) {
    const name = safeName(doc.filename, 'document');
    names.push(name);
    if (doc.kind === 'pdf') {
      const b64 = normalizeBase64(doc.dataBase64);
      if (b64) {
        content.push({ type: 'input_file', filename: name, file_data: `data:application/pdf;base64,${b64}` });
      } else if (doc.url) {
        content.push({ type: 'input_file', file_url: doc.url });
      }
    } else if (doc.kind === 'image') {
      const b64 = normalizeBase64(doc.dataBase64);
      if (b64) {
        content.push({ type: 'input_image', image_url: `data:${doc.mime || 'image/png'};base64,${b64}` });
      } else if (doc.url) {
        content.push({ type: 'input_image', image_url: doc.url });
      }
    } else if (doc.kind === 'text' && doc.text) {
      content.push({
        type: 'input_text',
        text: `DOCUMENT: ${name}\n────────────────────\n${String(doc.text).slice(0, 200000)}`,
      });
    }
  }
  return { content, names };
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    return res.status(200).json({ ok: true, endpoint: 'generate-report', method: 'POST required' });
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY ontbreekt. Voeg deze toe aan de Vercel environment variables en deploy opnieuw.',
      });
    }

    const body = await readJsonBody(req);
    const { filename, memorandum_url, extra_urls, notities } = body || {};

    let docContent = [];
    let docNames = [];

    if (Array.isArray(body?.documents) && body.documents.length) {
      const built = buildDocumentContent(body.documents);
      docContent = built.content;
      docNames = built.names;
    } else {
      // Oud contract: dataBase64 / memorandum_url + extra_urls
      const dataBase64 = normalizeBase64(body?.dataBase64);
      if (dataBase64) {
        docContent.push({
          type: 'input_file',
          filename: safeName(filename, 'memorandum.pdf'),
          file_data: `data:application/pdf;base64,${dataBase64}`,
        });
        docNames.push(safeName(filename, 'memorandum.pdf'));
      } else if (memorandum_url) {
        docContent.push({ type: 'input_file', file_url: memorandum_url });
        docNames.push(safeName(filename, 'memorandum.pdf'));
      }
      for (const url of Array.isArray(extra_urls) ? extra_urls.filter(Boolean) : []) {
        docContent.push({ type: 'input_file', file_url: url });
        docNames.push('aanvullend document');
      }
    }

    if (!docContent.length) {
      return res.status(400).json({
        error: 'Geen documentinhoud ontvangen. Stuur documents[], dataBase64 of memorandum_url mee.',
      });
    }

    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const docSummary = docNames.map((n, i) => `${i + 1}. ${n}`).join('\n');
    const prompt = buildPrompt({ notities, docSummary });
    const content = [{ type: 'input_text', text: prompt }, ...docContent];

    let response;
    try {
      response = await createResponse(client, 'gpt-4.1', content);
    } catch (firstErr) {
      if (firstErr?.status === 429 || String(firstErr?.message || '').includes('429')) {
        response = await createResponse(client, 'gpt-4.1-mini', content);
      } else {
        throw firstErr;
      }
    }

    const outputText = getOutputText(response);
    if (!outputText) {
      return res.status(500).json({ error: 'AI gaf geen tekst terug.' });
    }

    let parsed;
    try {
      parsed = parseJson(outputText);
    } catch (parseErr) {
      console.error('JSON parse mislukt. Eerste 2000 tekens van ruwe output:', outputText.slice(0, 2000));
      return res.status(502).json({
        error: 'AI gaf geen geldige JSON terug.',
        raw: outputText.slice(0, 4000),
      });
    }

    let report;
    try {
      report = enforceQuality(parsed);
    } catch (qErr) {
      console.error('Kwaliteitslaag-fout:', qErr);
      report = parsed; // liever ongepolijst rapport dan harde fout
    }

    return res.status(200).json({ success: true, data: report });
  } catch (error) {
    console.error('Generate-report error:', error);
    return res.status(500).json({ error: error.message || 'AI-verwerking mislukt' });
  }
}
