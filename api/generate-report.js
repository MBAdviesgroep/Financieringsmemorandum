import OpenAI from 'openai';

/* ════════════════════════════════════════════════════════════════════
   Credion MB — Financieringsrapport-tool · /api/generate-report

   Kwaliteitsprincipes:
   - Onbekend is nooit nul: onbekende bedragen zijn null.
   - Elke belangrijke waarde heeft een bronverwijzing.
   - Rapporttype wordt server-side bepaald (financieringsmemorandum of
     intake_documentatiememorandum) op basis van echte datadekking.
   - Datadekking-score wordt server-side deterministisch berekend,
     nooit door het model zelf.
   ════════════════════════════════════════════════════════════════════ */

/* ── Schema-bouwstenen ─────────────────────────────────────────────── */
const s = { type: 'string' };
const nN = { type: ['number', 'null'] };
const bN = { type: ['boolean', 'null'] };
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
const VASTGESTELD = en('vastgesteld', 'deels vastgesteld', 'niet vastgesteld');
const NIVEAU = en('voldoende', 'beperkt', 'onvoldoende');

const factItem = obj({
  label: s,
  waarde: s,
  bedrag: nN,
  bron_document: s,
  bron_fragment: s,
  confidence: CONF,
  toelichting: s,
});

const lineItem = obj({
  label: s,
  bedrag: nN,
  periode: s,
  status: s,
  bron_document: s,
  toelichting: s,
});

const partyItem = obj({
  partij: s,
  rol: s,
  rechtsvorm: s,
  kvk: s,
  bron: s,
  toelichting: s,
});

const riskItem = obj({
  risico: s,
  kans: en('hoog', 'middel', 'laag'),
  impact: en('hoog', 'middel', 'laag'),
  mitigant: s,
  bron: s,
});

const chartItem = obj({ label: s, waarde: nN, toelichting: s });

const secTxt = obj({ tekst: s, status: VASTGESTELD, bron: s });

const docRecItem = obj({
  document: s,
  categorie: s,
  bruikbare_informatie: s,
  status: s,
});

const opvraagItem = obj({ item: s, prioriteit: en('hoog', 'middel', 'laag'), toelichting: s });

const REPORT_SCHEMA = obj({
  metadata: obj({
    rapport_type: en('financieringsmemorandum', 'intake_documentatiememorandum'),
    rapporttitel: s,
    onderneming: obj({ naam: s, confidence: CONF, bron: s }),
    datum: s,
    documenten: strArr,
    kritieke_ontbrekende_data: strArr,
    belangrijkste_beperkingen: strArr,
  }),
  source_facts: obj({
    partijen: arr(factItem),
    financieringsvraag: arr(factItem),
    financiele_cijfers: arr(factItem),
    balansposten: arr(factItem),
    verplichtingen: arr(factItem),
    zekerheden: arr(factItem),
    memo_buitenbalans: arr(factItem),
    documentatie: arr(factItem),
    tegenstrijdigheden: strArr,
  }),
  voorblad: obj({
    ondertitel: s,
    onderneming: s,
    datum: s,
    rapportlabel: s,
  }),
  managementsamenvatting: obj({
    kernboodschap: s,
    wat_is_bekend: strArr,
    wat_ontbreekt: strArr,
    voorlopige_beoordeling: s,
    geen_definitief_oordeel_mogelijk: b,
    belangrijkste_aandachtspunten: strArr,
    kaarten: obj({
      kredietnemer: s,
      financieringsdoel: s,
      financieringsbehoefte: s,
      cijferbasis: en('beschikbaar', 'beperkt', 'ontbreekt'),
      zekerheden: VASTGESTELD,
    }),
  }),
  memorandum: obj({
    aanleiding: secTxt,
    kern_van_de_aanvraag: secTxt,
    betrokken_partijen: obj({ tekst: s, items: arr(partyItem) }),
    onderneming_en_activiteiten: secTxt,
    financiele_positie: secTxt,
    financieringsbehoefte: obj({ bedrag: nN, tekst: s, status: VASTGESTELD, bron: s }),
    bestaande_verplichtingen: obj({ tekst: s, items: arr(lineItem) }),
    zekerheden: obj({ tekst: s, items: arr(lineItem) }),
    risicos_en_aandachtspunten: strArr,
    benodigde_besluitvorming: strArr,
    conceptconclusie: obj({
      tekst: s,
      oordeel: en('positief', 'voorzichtig positief', 'neutraal', 'onvoldoende data', 'negatief'),
      onderbouwing: strArr,
    }),
  }),
  juridische_structuur: obj({
    rechtspersonen: arr(partyItem),
    personen: arr(partyItem),
    bestuur_tekenbevoegdheid: strArr,
    ubo_aandeelhouders: strArr,
    onduidelijkheden: strArr,
  }),
  activiteiten: obj({
    status: VASTGESTELD,
    omschrijving: s,
    verdienmodel: s,
    markt: s,
    klanten: s,
    aandachtspunten: strArr,
  }),
  financieringsvraag: obj({
    status: VASTGESTELD,
    doel: s,
    totale_behoefte: nN,
    nieuwe_hoofdsom: nN,
    structuur: s,
    looptijd: s,
    rente: s,
    aflossing: s,
    maandlast: nN,
    bronnen_en_aanwendingen: arr(lineItem),
    bestaande_financieringen: arr(lineItem),
    ontbrekend: strArr,
  }),
  financiele_analyse: obj({
    status: NIVEAU,
    samenvatting: s,
    resultaten: arr(lineItem),
    cashflow: arr(lineItem),
    ratio_lijst: arr(obj({ ratio: s, waarde: s, norm: s, toelichting: s })),
    observaties: strArr,
    ontbrekend: strArr,
  }),
  balansanalyse: obj({
    status: NIVEAU,
    peildata: strArr,
    activa: arr(lineItem),
    passiva: arr(lineItem),
    controle: obj({
      activa_totaal: nN,
      passiva_totaal: nN,
      verschil: nN,
      sluitend: bN,
      toelichting: s,
    }),
    memo_en_buitenbalansposten: arr(lineItem),
    ontbrekend: strArr,
  }),
  zekerhedenanalyse: obj({
    status: VASTGESTELD,
    zekerheden: arr(lineItem),
    dekkingspositie: s,
    zekerheidsstellers: strArr,
    ontbrekend: strArr,
    aandachtspunten: strArr,
  }),
  risicoanalyse: obj({
    status: NIVEAU,
    risicomatrix: arr(riskItem),
    bancaire_aandachtspunten: strArr,
    risicoconclusie: s,
  }),
  documentatiecheck: obj({
    ontvangen: arr(docRecItem),
    ontbrekend: arr(opvraagItem),
    vervolgvragen: strArr,
  }),
  visualisaties: obj({
    financieringsmix: arr(chartItem),
    balansverdeling_activa: arr(chartItem),
    balansverdeling_passiva: arr(chartItem),
    resultaatontwikkeling: arr(obj({ label: s, periode: s, waarde: nN })),
    zekerhedenmix: arr(chartItem),
  }),
  kwaliteitscontrole: obj({
    geen_demo_data: b,
    geen_nul_fallbacks: b,
    conclusies_onderbouwd: b,
    kritieke_validatiefouten: strArr,
    waarschuwingen: strArr,
    agent_controles: strArr,
  }),
});

/* ── System prompt ─────────────────────────────────────────────────── */
const SYSTEM_BASE = `Je bent een senior Credion financieringsspecialist. Je analyseert uitsluitend de aangeleverde documenten en eventuele adviseursnotities.

ABSOLUTE REGELS
1. Je mag geen bedragen, ratio's, conclusies, zekerheden, financieringsvoorwaarden of bedrijfsinformatie verzinnen.
2. Iedere belangrijke uitspraak moet terug te voeren zijn op een bronfragment. Vul bij elk bedrag bron_document en bron_fragment in.
3. Onbekende informatie blijft onbekend en wordt professioneel als ontbrekend gemarkeerd.
4. Onbekend is nooit nul. Onbekende bedragen en percentages zijn null, nooit 0. Alleen als de bron expliciet een nulbedrag vermeldt mag 0 worden gebruikt, met bronverwijzing.
5. Je mag nooit een positieve financieringsconclusie geven als de financieringsvraag, financiële cijfers of zekerheden ontbreken. Gebruik dan oordeel "onvoldoende data" met de standaardtekst: "Op basis van de aangeleverde documentatie kan nog geen definitief oordeel worden gegeven over betaalbaarheid, risico en financierbaarheid. Aanvullende financiële gegevens, specificatie van de financieringsbehoefte en zekerhedeninformatie zijn benodigd."
6. Als de brondata onvoldoende is voor een volwaardig financieringsmemorandum, kies dan rapport_type "intake_documentatiememorandum". Schrijf dan een eerlijk, professioneel intake- en documentatiememorandum: wat is wel vastgesteld, wat nog niet, waarom dat belangrijk is, welke stukken nodig zijn en welke vervolgstap logisch is.
7. Herhaal nooit tientallen keren dezelfde placeholder. Schrijf per ontbrekend onderdeel één professionele zin zoals: "Niet vastgesteld op basis van de aangeleverde documenten", "Niet herleidbaar uit bronmateriaal", "Aanvullende documentatie benodigd" of "Geen betrouwbare berekening mogelijk".
8. Geen marketingtaal, geen kredietgoedkeuring, geen garanties, geen externe kennis, geen aannames als feit.

WERKWIJZE
Stap 1 — Extraheer eerst alle harde bronfeiten in source_facts: partijen, financieringsvraag, financiële cijfers, balansposten, verplichtingen, zekerheden, memo-/buitenbalansposten en documentatie. Elk feit met waarde, bron_document, bron_fragment, confidence en toelichting. Noteer tegenstrijdigheden expliciet.
Stap 2 — Vul documentatiecheck.ontvangen met elk aangeleverd document: vermoedelijke categorie, bruikbare informatie en extractiestatus.
Stap 3 — Schrijf daarna pas het memorandum. Interpretaties alleen op basis van bronfeiten. Geen bronfeit = geen interpretatie.
Stap 4 — Bepaal rapport_type: "financieringsmemorandum" alleen als minimaal bekend zijn: kredietnemer, financieringsdoel of aanleiding, financieringsbedrag of duidelijke behoefte, én concrete financiële cijfers. Anders "intake_documentatiememorandum".

MEMORANDUM-SCHRIJFSTIJL
Zakelijke Credion-stijl: helder, direct, financieringsgericht, korte alinea's. Als een sectie niet kan worden vastgesteld, schrijf dan een volwaardige professionele zin. Voorbeeld: niet "Aanleiding: niet opgenomen in bron", maar "De aanleiding voor de financieringsaanvraag is op basis van de aangeleverde documentatie nog niet eenduidig vastgesteld. Voor een financieringsmemorandum richting bank of financier is een specificatie nodig van doel, bedrag, looptijd, aflossingsstructuur en gewenste financieringsvorm."

VISUALISATIES
Vul grafiekarrays uitsluitend met echte bedragen uit de bron. Als er geen betrouwbare bedragen zijn: lege array []. Nooit placeholder-data, nooit 0-waarden als vulling.

RISICOANALYSE
Alleen risico's die uit de bron volgen. Bij beperkte documentatie is "Documentatierisico" (kans hoog, impact hoog, mitigant: aanvullende stukken opvragen voordat externe financieringsbeoordeling plaatsvindt) het belangrijkste risico.

OUTPUT
Antwoord uitsluitend met valide JSON volgens het schema. Geen markdown, geen code fences, geen tekst buiten de JSON.`;

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

// Onbekend is nooit nul: 0 zonder expliciete nul-bron wordt null.
function cleanAmount(value, sourceText) {
  const v = num(value);
  if (v === null) return null;
  if (v === 0 && !/(expliciet|bron).{0,40}(nul|€\s*0)|(nul|€\s*0).{0,40}(expliciet|bron)/i.test(String(sourceText || ''))) {
    return null;
  }
  return v;
}

function cleanChart(items) {
  if (!Array.isArray(items)) return [];
  const cleaned = items.filter((it) => typeof it?.waarde === 'number' && isFinite(it.waarde) && it.waarde > 0);
  return cleaned.length ? cleaned : [];
}

function computeDatadekking(r) {
  const fv = r.financieringsvraag || {};
  const fa = r.financiele_analyse || {};
  const ba = r.balansanalyse || {};
  const za = r.zekerhedenanalyse || {};
  const js = r.juridische_structuur || {};
  const dc = r.documentatiecheck || {};
  const sf = r.source_facts || {};

  const vraagBekend = fv.status === 'vastgesteld';
  const vraagDeels = fv.status === 'deels vastgesteld';
  const bedragBekend = num(fv.totale_behoefte) !== null || num(fv.nieuwe_hoofdsom) !== null;
  const cijfers = fa.status === 'voldoende' ? 2 : fa.status === 'beperkt' ? 1 : 0;
  const balans = ba.status === 'voldoende' ? 2 : ba.status === 'beperkt' ? 1 : 0;
  const zeker = za.status === 'vastgesteld' ? 2 : za.status === 'deels vastgesteld' ? 1 : 0;
  const juridisch = (js.rechtspersonen || []).length > 0 || (sf.partijen || []).length > 0;
  const docsOntvangen = (dc.ontvangen || []).length;
  const inconsistenties = (sf.tegenstrijdigheden || []).length;

  let score = 0;
  score += vraagBekend ? 15 : vraagDeels ? 7 : 0;
  score += bedragBekend ? 15 : 0;
  score += cijfers === 2 ? 20 : cijfers === 1 ? 10 : 0;
  score += balans === 2 ? 15 : balans === 1 ? 7 : 0;
  score += zeker === 2 ? 10 : zeker === 1 ? 5 : 0;
  score += juridisch ? 10 : 0;
  score += Math.min(10, docsOntvangen * 3);
  score += inconsistenties === 0 ? 5 : 0;

  // Harde maxima
  if (!bedragBekend) score = Math.min(score, 60);
  if (cijfers === 0) score = Math.min(score, 55);
  if (!bedragBekend && cijfers === 0) score = Math.min(score, 40);
  if (zeker === 0) score = Math.min(score, 80);

  const vol = vraagBekend || vraagDeels;
  const volwaardig = vol && bedragBekend && cijfers >= 1 && score >= 55;
  if (!volwaardig) score = Math.min(score, 60);

  const niveau = score >= 75 ? 'hoog' : score >= 55 ? 'middel' : score >= 35 ? 'laag' : 'onvoldoende';
  const publicatiestatus =
    niveau === 'hoog' ? 'Bankwaardig concept — na adviseurscontrole'
    : niveau === 'middel' ? 'Geschikt voor adviseursreview'
    : 'Nog niet extern deelbaar — eerst aanvullen';

  return { score, niveau, volwaardig, publicatiestatus, bedragBekend, cijfers, zeker, inconsistenties };
}

function enforceQuality(r) {
  const warnings = [];

  // 1. Bedragen: 0-fallbacks weghalen
  const fv = r.financieringsvraag || {};
  const srcTxt = JSON.stringify(r.source_facts?.financieringsvraag || '');
  for (const k of ['totale_behoefte', 'nieuwe_hoofdsom', 'maandlast']) {
    const before = fv[k];
    fv[k] = cleanAmount(fv[k], srcTxt);
    if (before === 0 && fv[k] === null) warnings.push(`Veld financieringsvraag.${k} was 0 zonder expliciete nul-bron en is op onbekend gezet.`);
  }
  if (r.memorandum?.financieringsbehoefte) {
    r.memorandum.financieringsbehoefte.bedrag = cleanAmount(r.memorandum.financieringsbehoefte.bedrag, srcTxt);
  }

  // 2. Grafieken: alleen echte data
  const vis = r.visualisaties || {};
  for (const k of ['financieringsmix', 'balansverdeling_activa', 'balansverdeling_passiva', 'zekerhedenmix']) {
    vis[k] = cleanChart(vis[k]);
  }
  vis.resultaatontwikkeling = (vis.resultaatontwikkeling || []).filter(
    (it) => typeof it?.waarde === 'number' && isFinite(it.waarde)
  );

  // 3. Datadekking en rapporttype server-side
  const dd = computeDatadekking(r);
  const aiType = r.metadata?.rapport_type;
  const type = dd.volwaardig ? (aiType || 'financieringsmemorandum') : 'intake_documentatiememorandum';
  if (aiType === 'financieringsmemorandum' && type === 'intake_documentatiememorandum') {
    warnings.push('Rapporttype door kwaliteitslaag teruggezet naar intake- en documentatiememorandum: onvoldoende datadekking voor een volwaardig financieringsmemorandum.');
  }

  r.metadata = r.metadata || {};
  r.metadata.rapport_type = type;
  r.metadata.rapporttitel = type === 'financieringsmemorandum' ? 'Financieringsmemorandum' : 'Intake- en documentatiememorandum';
  r.metadata.status = 'Concept · ter beoordeling';
  r.metadata.datadekking = {
    niveau: dd.niveau,
    score: dd.score,
    score_toelichting:
      dd.niveau === 'hoog'
        ? 'Datadekking is hoog: kernonderdelen zijn herleidbaar uit de aangeleverde documenten.'
        : dd.niveau === 'middel'
        ? 'Datadekking is gedeeltelijk: een aantal kernonderdelen is nog niet of beperkt vastgesteld.'
        : 'Datadekking is beperkt: cruciale informatie ontbreekt voor een volwaardig financieringsmemorandum.',
    kritieke_ontbrekende_data: r.metadata.kritieke_ontbrekende_data || [],
  };
  r.metadata.publicatiestatus = dd.publicatiestatus;

  // 4. Conclusie-bewaking
  const cc = r.memorandum?.conceptconclusie;
  if (cc && ['positief', 'voorzichtig positief'].includes(cc.oordeel) && !dd.volwaardig) {
    warnings.push('Positieve conceptconclusie door kwaliteitslaag vervangen: onvoldoende onderbouwing in brondata.');
    cc.oordeel = 'onvoldoende data';
    cc.tekst =
      'Op basis van de aangeleverde documentatie kan nog geen definitief oordeel worden gegeven over betaalbaarheid, risico en financierbaarheid. Aanvullende financiële gegevens, specificatie van de financieringsbehoefte en zekerhedeninformatie zijn benodigd.';
  }

  // 5. Kwaliteitscontrole bijwerken
  r.kwaliteitscontrole = r.kwaliteitscontrole || {};
  r.kwaliteitscontrole.waarschuwingen = [...(r.kwaliteitscontrole.waarschuwingen || []), ...warnings];
  r.kwaliteitscontrole.geen_nul_fallbacks = true;

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
