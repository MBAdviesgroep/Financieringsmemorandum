import OpenAI from 'openai';

/* ════════════════════════════════════════════════════════════════════
   Credion MB — Financieringsrapport-tool · /api/generate-report
   Premium versie: volledig memorandum, uitgebreide index, balanssectie,
   visualisatie-data en strict Structured Outputs JSON Schema.
   ════════════════════════════════════════════════════════════════════ */

const s = { type: 'string' };
const n = { type: 'number' };
const b = { type: 'boolean' };
const strArr = { type: 'array', items: s };
const obj = (properties) => ({
  type: 'object',
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
const arr = (items) => ({ type: 'array', items });

const moneyItem = obj({
  label: s,
  post: s,
  rubriek: s,
  bedrag: n,
  peildatum: s,
  status: s,
  toelichting: s,
});

const tocItem = obj({
  hoofdstuk: n,
  titel: s,
  subparagrafen: strArr,
});

const partyItem = obj({
  partij: s,
  rol: s,
  rechtsvorm: s,
  kvk: s,
  toelichting: s,
});

const personItem = obj({
  naam: s,
  rol: s,
  belang: s,
  bevoegdheid: s,
  toelichting: s,
});

const loanItem = obj({
  soort: s,
  verstrekker: s,
  restschuld: n,
  indicatief: b,
  rente: s,
  looptijd: s,
  aflossing: s,
  peildatum: s,
  toelichting: s,
});

const securityItem = obj({
  type: s,
  omschrijving: s,
  categorie: s,
  waarde: n,
  rang: s,
  status: s,
  toelichting: s,
});

const financialItem = obj({
  jaar: s,
  peildatum: s,
  post: s,
  bedrag: n,
  waarde: n,
  percentage: n,
  status: s,
  toelichting: s,
});

const ratioItem = obj({
  ratio: s,
  waarde: n,
  norm: s,
  status: s,
  toelichting: s,
});

const riskItem = obj({
  risico: s,
  kans: s,
  impact: s,
  mitigant: s,
  status: s,
  toelichting: s,
});

const docItem = obj({
  document: s,
  status: s,
  toelichting: s,
});

const radarItem = obj({
  label: s,
  waarde: n,
  toelichting: s,
});

const REPORT_SCHEMA = obj({
  rapport_meta: obj({
    klant: s,
    rapportdatum: s,
    rapporttype: s,
    status: s,
    bronbasis: s,
    disclaimer: s,
  }),
  cover: obj({
    titel: s,
    subtitel: s,
    klantnaam: s,
    plaats: s,
    datum: s,
    adviseur: s,
  }),
  inhoudsopgave: arr(tocItem),
  memorandum: obj({
    aanleiding: s,
    kern_van_de_aanvraag: s,
    betrokken_partijen: s,
    financiele_positie: s,
    financieringsbehoefte: s,
    bestaande_verplichtingen: s,
    zekerheden: s,
    risicos_en_aandachtspunten: s,
    benodigde_besluitvorming: s,
    conceptconclusie: s,
  }),
  managementsamenvatting: obj({
    kredietnemer: s,
    financieringsdoel: s,
    totale_behoefte: n,
    financieringsvorm: s,
    looptijd_mnd: n,
    belangrijkste_zekerheden: s,
    belangrijkste_aandachtspunten: strArr,
    conclusie: s,
    status: s,
  }),
  juridische_structuur: obj({
    betrokken_partijen: arr(partyItem),
    organogram: arr(obj({ niveau: n, naam: s, toelichting: s })),
    bestuur_en_tekenbevoegdheid: arr(personItem),
    ubo_aandeelhouders: arr(personItem),
    aandachtspunten: strArr,
  }),
  activiteiten: obj({
    beschrijving: s,
    verdienmodel: s,
    marktpositie: s,
    klanten_en_contracten: s,
    operationele_toelichting: s,
    toegevoegde_waarde: s,
    omzetgroepen: arr(obj({ naam: s, aandeel_pct: n, indicatief: b, toelichting: s })),
    aandachtspunten: strArr,
  }),
  financieringsvraag: obj({
    doel: s,
    totaal: n,
    specificatie: arr(moneyItem),
    onderbouwing: s,
    effect_op_onderneming: s,
    aandachtspunten: strArr,
  }),
  bestaande_financieringen: obj({
    huisbank: s,
    leningen: arr(loanItem),
    rekening_courant: arr(loanItem),
    leaseverplichtingen: arr(loanItem),
    overige_schulden: arr(moneyItem),
    aandachtspunten: strArr,
  }),
  nieuwe_financiering: obj({
    vorm: s,
    hoofdsom: n,
    looptijd_mnd: n,
    rente_pct: n,
    aflossing: s,
    slottermijn: s,
    maandlast_indicatief: n,
    voorwaarden: strArr,
    aandachtspunten: strArr,
  }),
  financiele_analyse: obj({
    samenvatting: s,
    resultatenanalyse: arr(financialItem),
    balansanalyse: arr(financialItem),
    kasstroomanalyse: s,
    ratio_analyse: arr(ratioItem),
    ontwikkelingen: strArr,
    aandachtspunten: strArr,
  }),
  balans: obj({
    peildata: strArr,
    activa: arr(moneyItem),
    passiva: arr(moneyItem),
    specificaties: arr(moneyItem),
    memo_en_buitenbalansposten: arr(moneyItem),
    controle: obj({
      activa_passiva_sluiten: b,
      verschil: n,
      toelichting: s,
    }),
  }),
  zekerheden: obj({
    bestaand: arr(securityItem),
    nieuw: arr(securityItem),
    zekerheidsstellers: arr(personItem),
    waarde_en_dekking: s,
    aandachtspunten: strArr,
  }),
  risicoanalyse: obj({
    risicos: arr(riskItem),
    mitiganten: strArr,
    bancaire_aandachtspunten: strArr,
    conclusie: s,
  }),
  documentatiecheck: obj({
    ontvangen: strArr,
    op_te_vragen: strArr,
    ontbrekend: strArr,
    niet_in_bron: strArr,
  }),
  adviseur_check: obj({
    inconsistenties: strArr,
    ontbrekende_stukken: strArr,
    te_verifieren_cijfers: strArr,
    actiepunten: strArr,
  }),
  bijlagen: obj({
    rechtspersonen: arr(obj({ naam: s, rechtsvorm: s, kvk: s, vestiging: s, toelichting: s })),
    privepersonen: arr(personItem),
    financiele_documentatie: strArr,
    overige_documentatie: strArr,
  }),
  visualisatie_data: obj({
    rapport_score: obj({ score: n, label: s, toelichting: s }),
    radar: arr(radarItem),
    financieringsmix: arr(moneyItem),
    zekerhedenmix: arr(moneyItem),
    risicomatrix: arr(riskItem),
  }),
  agent_controles: obj({
    voorbeelddata_gebruikt: b,
    cijfers_gevonden: n,
    teksten_gevonden: n,
    zekerheden_gevonden: n,
    financieringen_gevonden: n,
    memo_toegevoegd: b,
    index_volledig: b,
    json_valide: b,
  }),
});

const SYSTEM_BASE = `Je bent een senior financieringsadviseur, herstructureringsanalist en rapportagespecialist voor Credion MB Amsterdam & Texel.

Je maakt uitsluitend op basis van de aangeleverde documenten een hoogwaardig, bankwaardig en extern bruikbaar financieringsmemorandum of saneringsmemorandum. Het rapport moet luxe en professioneel aanvoelen, maar de output is alleen JSON; de frontend verzorgt de opmaak, A4-pagina's en grafieken.

ABSOLUTE BRONREGELS
1. Gebruik alleen de aangeleverde documenten en eventuele adviseursnotities.
2. Neem nooit namen, bedragen, percentages, KvK-nummers, jaartallen, financieringsvormen, zekerheden of conclusies over uit voorbeelddata, schema's, demo-HTML, vorige rapporten of placeholders.
3. Het JSON-schema bepaalt alleen de veldstructuur, nooit de inhoud.
4. Als een bedrag, datum, persoon, zekerheid of voorwaarde niet duidelijk in de bron staat, vul dan geen fictieve waarde in.
5. Ontbrekende tekstvelden krijgen een zakelijke status zoals "Niet opgenomen in bron", "Nog te controleren", "Aanvullen door adviseur" of "Afstemmen met actuele opgave".
6. Ontbrekende numerieke velden blijven 0 en krijgen waar relevant een status/toelichting in het bijbehorende tekstveld.
7. Als cijfers indicatief, voorlopig of periodegebonden zijn, benoem expliciet de peildatum en bronstatus.
8. Maak onderscheid tussen jaarultimo, conceptjaarrekening, periodebalans, kolommenbalans, prognose, taxatie en bankopgave.
9. Controleer of totalen, subtellingen, activa/passiva, financieringsbehoefte, zekerheden en verplichtingen logisch aansluiten.
10. Memo- en buitenbalansposten mogen niet verdwijnen; zet ze in balans.memo_en_buitenbalansposten.

VERPLICHTE RAPPORTKWALITEIT
- Voeg altijd een zelfstandig hoofdstuk memorandum toe.
- Maak een uitgebreide inhoudsopgave met minimaal 12 hoofdstukken/subonderdelen.
- Geef zakelijke Credion MB-stijl: helder, direct, financieringsgericht, compact maar niet oppervlakkig.
- Maak managementsamenvatting, financiële analyse, balansanalyse, risicoanalyse, zekerheden, documentatiecheck en adviseur-check concreet.
- Geen marketingtaal, geen kredietgoedkeuring en geen garanties.
- Geef een genuanceerde conceptconclusie met voorwaarden en openstaande punten.

VISUALISATIE-DATA
Vul visualisatie_data zodat de frontend luxe grafieken kan renderen:
- rapport_score: score 0-100 voor datakwaliteit/rapportvolledigheid, niet als kredietgoedkeuring.
- radar: 5 of 6 dimensies, bijvoorbeeld Datadekking, Cijferbasis, Zekerheden, Risico-inzicht, Documentatie, Betaalcapaciteit.
- financieringsmix: bedragen uit de financieringsspecificatie.
- zekerhedenmix: waarden alleen als bron deze ondersteunt; anders 0 met status.
- risicomatrix: belangrijkste risico's met kans, impact en mitigant.

OUTPUTREGELS
Antwoord uitsluitend met valide JSON volgens het schema. Geen markdown. Geen code fences. Geen uitleg voor of na JSON. Gebruik echte arrays; gebruik nooit arrays met alleen een lege string.`;

function buildPrompt({ notities, extraCount }) {
  return `${SYSTEM_BASE}\n\nAANGELEVERDE DOCUMENTEN\nEr is 1 hoofddocument aangeleverd en ${extraCount} aanvullend(e) PDF-document(en). Lees alle documenten.\n\nBRONPRIORITEIT\n1. Hoofddocument / memorandum\n2. Aanvullende documenten\n3. Adviseursnotities\n4. Schema uitsluitend voor veldstructuur\n\nADVISEURSNOTITIES\n${notities || 'Geen aanvullende adviseursnotities opgegeven.'}\n\nKRITIEKE CONTROLE\nAls een naam, bedrag of passage niet uit deze concrete casus komt, mag deze niet in de output staan. agent_controles.voorbeelddata_gebruikt moet false zijn. Als je toch voorbeelddata nodig denkt te hebben, is de output fout: gebruik dan ontbrekende-informatie-statussen.\n\nDATUM\nGebruik als rapportdatum de actuele datum van vandaag in Nederlandse notatie, tenzij in bron of adviseursnotities anders is gevraagd.\n\nLever nu uitsluitend het JSON-object volgens het schema.`;
}

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

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Only POST allowed' });
  }

  try {
    const { memorandum_url, extra_urls, extra_url, notities } = req.body || {};
    if (!memorandum_url) {
      return res.status(400).json({ error: 'memorandum_url ontbreekt.' });
    }

    const extras = Array.isArray(extra_urls) ? extra_urls.filter(Boolean) : extra_url ? [extra_url] : [];
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const prompt = buildPrompt({ notities, extraCount: extras.length });
    const content = [
      { type: 'input_text', text: prompt },
      { type: 'input_file', file_url: memorandum_url },
      ...extras.map((url) => ({ type: 'input_file', file_url: url })),
    ];

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
      console.error('JSON parse mislukt. Ruwe output:', outputText);
      return res.status(502).json({
        error: 'AI gaf geen geldige JSON terug.',
        raw: outputText.slice(0, 4000),
      });
    }

    return res.status(200).json({ success: true, data: parsed });
  } catch (error) {
    console.error('Generate-report error:', error);
    return res.status(500).json({ error: error.message || 'AI-verwerking mislukt' });
  }
}
