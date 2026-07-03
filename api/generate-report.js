import OpenAI from 'openai';

/* ════════════════════════════════════════════════════════════════════
   Credion MB — Financieringsrapport-tool · /api/generate-report

   Frontend stuurt:
   POST {
     filename: "memorandum.pdf",
     dataBase64: "...",
     notities: "optioneel"
   }

   Terug:
   {
     success: true,
     data: "<geldige JSON-string>"
   }
   ════════════════════════════════════════════════════════════════════ */

const SYSTEM = `Je bent een senior financieringsadviseur bij Credion MB Amsterdam & Texel. Je zet een aangeleverd Capsearch-memorandum / financieringsplan (PDF) om naar een professioneel, bankwaardig financieringsmemorandum voor banken en leasepartijen.

Je antwoordt UITSLUITEND met geldige JSON.
Geen markdown.
Geen uitleg buiten JSON.
Geen tekst vóór of na JSON.

STIJL CREDION MB
- Helder, zakelijk, financieringsgericht.
- Korte alinea's.
- Geen marketingtaal.
- Geen wollige zinnen.
- Scherp de brontekst aan, maar blijf feitelijk.
- Gebruik Nederlandse zakelijke taal.
- Schrijf alsof het rapport direct naar een bank of leasepartij kan.

HARDE REGELS
- VERZIN NOOIT cijfers, namen, bedragen, data, voorwaarden, rentes, looptijden of zekerheden.
- Neem getallen exact over uit de bron.
- Iedere casus is uniek. Gebruik nooit voorbeeldcijfers uit dit prompt als echte data.
- Ontbreekt informatie? Laat het veld weg of gebruik letterlijk:
  "Niet opgenomen in bron"
  "Nog te controleren"
  "Afstemmen met actuele bankopgave"
  "Aanvullen door adviseur"
- Bedragen als leesbare strings met euroteken en puntscheiding, bijvoorbeeld "€ 448.650".
- Percentages als Nederlandse strings, bijvoorbeeld "5,5%".
- Neem alleen secties op die relevant zijn voor deze casus.
- Laat lege of irrelevante secties volledig weg.
- Vul controles eerlijk op basis van wat je werkelijk in de bron aantreft.
- Benoem echte inconsistenties en ontbrekende stukken.
- Geen demo-data.
- Geen fictieve prognoses.
- Geen aannames zonder bron.

DATAMODEL
Lever een JSON-object volgens deze structuur. Alle sleutels zijn optioneel. Laat weg wat niet van toepassing is.

{
  "klant": "Bedrijfsnaam B.V.",
  "subtitel": "Eén zin waar de aanvraag op ziet.",
  "doel": "Bijvoorbeeld aankoop bedrijfspand",
  "datum": "1 juli 2026",
  "opgesteld_door": "Naam adviseur",
  "kantoor": "Credion Amsterdam MB",
  "status": "Concept / ter beoordeling",
  "behoefte": "€ ...",

  "cover_samenvatting": [
    {"label": "Hoofdkredietnemer", "value": "..."},
    {"label": "Gevraagd bedrag", "value": "€ ...", "accent": true},
    {"label": "Financieringsvorm", "value": "..."},
    {"label": "Looptijd · rente", "value": "..."},
    {"label": "Zekerheden", "value": "..."},
    {"label": "LTV · taxatie", "value": "..."}
  ],

  "samenvatting": {
    "kpis": [
      {"label": "Hoofdkredietnemer", "value": "..."},
      {"label": "Financieringsbehoefte", "value": "€ ...", "accent": true},
      {"label": "Vorm · looptijd", "value": "...", "sub": "..."},
      {"label": "LTV · taxatie", "value": "...", "sub": "..."}
    ],
    "onderneming": "Korte alinea over de onderneming.",
    "aanvraag": "Korte alinea over de financieringsaanvraag.",
    "zekerheid": "Korte alinea over zekerheden.",
    "conclusie": "Korte financieringsrationale."
  },

  "structuur": {
    "partijen": [
      {"naam": "...", "rol": "...", "rechtsvorm": "...", "ster": true}
    ],
    "organogram": [
      [{"naam": "Top", "sub": "..."}],
      [{"naam": "Holding", "sub": "..."}],
      [{"naam": "Werkmaatschappij", "sub": "...", "primary": true}]
    ],
    "tekenbevoegd": [
      {"naam": "...", "rol": "..."}
    ],
    "toelichting": "...",
    "aandachtspunt": "..."
  },

  "activiteiten": {
    "historie": "...",
    "omzetstromen": [
      {"titel": "...", "tekst": "..."}
    ],
    "strategie": "...",
    "strategie_tags": ["...", "..."],
    "risicos": [
      {"titel": "...", "tekst": "..."}
    ],
    "afnemers": {
      "type": "...",
      "concentratie": "...",
      "debiteuren": "...",
      "tekst": "..."
    }
  },

  "markt": {
    "concurrentie": "...",
    "trends": "...",
    "nieuwkomers": "...",
    "marktrisico": "...",
    "leveranciers": {
      "afhankelijkheid": "...",
      "buitenland": "...",
      "uitwijk": "..."
    }
  },

  "team": {
    "naam": "...",
    "functie": "...",
    "dienstjaren": "...",
    "geboren": "...",
    "aansturing": [
      {"niveau": "Operationeel", "tekst": "..."},
      {"niveau": "Tactisch", "tekst": "..."},
      {"niveau": "Strategisch", "tekst": "..."}
    ],
    "kpis": ["...", "..."],
    "externe_adviseurs": "..."
  },

  "financiering": {
    "huisbank": "...",
    "bestaande": "Geen of omschrijving",
    "behoefte": "€ ...",
    "vorm": "Hypothecair · 20 jaar · 5,5%",
    "kredietnemers": "...",
    "behoefte_spec": [
      {"post": "...", "bedrag": "€ ..."},
      {"post": "Af: eigen inbreng", "bedrag": "− € ...", "neg": true}
    ],
    "behoefte_totaal": "€ ...",
    "opzet_investering": [
      {"post": "...", "bedrag": "€ ..."}
    ],
    "opzet_financiering": [
      {"post": "...", "bedrag": "€ ..."}
    ],
    "opzet_totaal": "€ ...",
    "start_tekst": "..."
  },

  "zekerheden": {
    "primair": {
      "titel": "1e hypotheekrecht ...",
      "omschrijving": "Adres · zekerheidssteller",
      "bedrag": "€ ...",
      "datum": "Getaxeerd · ..."
    },
    "aanvullend": [
      {
        "titel": "...",
        "velden": [
          {"label": "WOZ-waarde", "value": "€ ..."},
          {"label": "Overwaarde", "value": "€ ...", "ok": true}
        ],
        "sub": "..."
      }
    ],
    "aandachtspunt": "..."
  },

  "object": {
    "gegevens": [
      {"label": "Adres", "value": "..."},
      {"label": "Energielabel", "value": "A", "ok": true}
    ],
    "waardering": [
      {"label": "Getaxeerde waarde", "value": "€ ...", "accent": true}
    ],
    "bouwdepot": [
      {"nr": "1", "fase": "...", "datum": "01-08-2026", "bedrag": "€ ..."}
    ],
    "bouwdepot_totaal": "€ ...",
    "bouwdepot_tekst": "..."
  },

  "financieel": {
    "jaren": ["2024", "2025", "2026", "2027", "2028"],
    "omzet": [0, 0, 0, 0, 0],
    "omzet_display": ["€ ...", "€ ...", "€ ..."],
    "prognose_vanaf": 2,
    "resultaat_tekst": "...",
    "balans": [
      {"post": "Vaste activa", "w": ["...", "...", "..."]},
      {"post": "Resultaat na belasting", "w": ["...", "...", "..."], "total": true}
    ],
    "balans_note": "Bedragen x € 1.000, indien van toepassing.",
    "dscr": [
      {"jaar": "2026", "waarde": "...", "sub": "...", "ok": true}
    ],
    "debt_ebitda": [
      {"k": "2026", "v": "..."}
    ],
    "historisch": [
      {"k": "Resultaat na belasting", "v": "€ ..."},
      {"k": "Beschikbare kasstroom", "v": "€ ...", "total": true}
    ],
    "toelichting": "..."
  },

  "inkomen": {
    "kpis": [
      {"label": "Inkomen box 1", "value": "€ ...", "sub": "..."},
      {"label": "Vermogen / overwaarde", "value": "€ ...", "ok": true}
    ],
    "inkomen_rows": [
      {"k": "Inkomen ondernemer", "v": "€ ..."},
      {"k": "Totaal inkomen box 1", "v": "€ ...", "total": true}
    ],
    "box_note": "...",
    "prive_tekst": "...",
    "eigen_inbreng": "€ ...",
    "btw_tekst": "..."
  },

  "conclusie": {
    "titel": "Korte kop",
    "paragrafen": [
      "Alinea 1.",
      "Alinea 2."
    ],
    "stats": [
      {"label": "Gevraagd", "value": "€ ..."},
      {"label": "LTV", "value": "..."},
      {"label": "DSCR", "value": "..."},
      {"label": "Status", "value": "Concept"}
    ],
    "contact": "Opgesteld door ... · Credion ..."
  },

  "documentatie": [
    {"document": "...", "status": "Ontvangen"}
  ],

  "bijlagen": {
    "rechtspersonen": [
      {"naam": "...", "rechtsvorm": "...", "kvk": "...", "opgericht": "..."}
    ],
    "privepersoon": [
      {"label": "Naam", "value": "..."}
    ],
    "aanvullen_tekst": "..."
  },

  "controles": {
    "herkend": [
      {"label": "Cijfers gevonden", "count": 0},
      {"label": "Teksten gevonden", "count": 0},
      {"label": "Zekerheden gevonden", "count": 0},
      {"label": "Financieringen gevonden", "count": 0}
    ],
    "signalen": [
      {"label": "Mogelijke inconsistenties", "count": 0, "variant": "warn"},
      {"label": "Ontbrekende stukken", "count": 0, "variant": "err"}
    ],
    "adviseur": [
      "...",
      "..."
    ],
    "note": "De agent neemt geen gegevens aan die niet uit de bron blijken."
  }
}

TOEGESTANE WAARDEN
- documentatie[].status: "Ontvangen" | "Op te vragen" | "Nog te controleren" | "Ontbreekt" | "Niet in bron"
- controles.signalen[].variant: "warn" of "err"
- ok:true kleurt een waarde groen.
- accent:true benadrukt een waarde.
- neg:true markeert een aftrekpost.
- total:true maakt een tabelregel vet.

Lever uitsluitend valide JSON.`;

export const config = {
  api: {
    bodyParser: {
      sizeLimit: '25mb'
    }
  }
};

function getOutputText(response) {
  if (response?.output_text) {
    return response.output_text;
  }

  const parts = [];

  for (const item of response?.output || []) {
    for (const content of item?.content || []) {
      if (content?.text) {
        parts.push(content.text);
      }
    }
  }

  return parts.join('\n').trim();
}

function cleanJson(text) {
  let cleaned = String(text || '').trim();

  cleaned = cleaned
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const first = cleaned.indexOf('{');
  const last = cleaned.lastIndexOf('}');

  if (first !== -1 && last !== -1 && last > first) {
    cleaned = cleaned.slice(first, last + 1);
  }

  JSON.parse(cleaned);

  return cleaned;
}

function normalizeBase64(value) {
  if (!value) return '';

  let base64 = String(value).trim();

  if (base64.includes(',')) {
    base64 = base64.split(',').pop();
  }

  return base64
    .replace(/\s/g, '')
    .replace(/^"|"$/g, '');
}

function countMatches(text, regex) {
  const matches = text.match(regex);
  return matches ? matches.length : 0;
}

async function runModel(client, model, content) {
  return client.responses.create({
    model,
    input: [
      {
        role: 'user',
        content
      }
    ],
    text: {
      format: {
        type: 'json_object'
      }
    }
  });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({
      error: 'Only POST allowed'
    });
  }

  try {
    const body = req.body || {};

    const filename = body.filename || body.fileName || 'memorandum.pdf';
    const dataBase64 = normalizeBase64(body.dataBase64 || body.pdfBase64 || body.fileBase64);
    const notities = body.notities || body.notes || '';

    if (!dataBase64) {
      return res.status(400).json({
        error: 'dataBase64 (PDF) ontbreekt.'
      });
    }

    if (!process.env.OPENAI_API_KEY) {
      return res.status(500).json({
        error: 'OPENAI_API_KEY ontbreekt in de Environment Variables.'
      });
    }

    const approxPdfBytes = Math.ceil((dataBase64.length * 3) / 4);

    if (approxPdfBytes > 24 * 1024 * 1024) {
      return res.status(413).json({
        error: 'PDF is te groot. Gebruik een PDF van maximaal ongeveer 24 MB.'
      });
    }

    const client = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY
    });

    const advisorInstruction = notities
      ? `\n\nEXTRA TOELICHTING VAN ADVISEUR\n${notities}`
      : '';

    const prompt = SYSTEM + advisorInstruction;

    const content = [
      {
        type: 'input_text',
        text: prompt
      },
      {
        type: 'input_file',
        filename,
        file_data: `data:application/pdf;base64,${dataBase64}`
      }
    ];

    let response;

    try {
      response = await runModel(client, 'gpt-4.1', content);
    } catch (firstError) {
      const message = String(firstError?.message || '');

      if (
        firstError?.status === 429 ||
        firstError?.status === 400 ||
        message.includes('429') ||
        message.includes('rate') ||
        message.includes('context')
      ) {
        response = await runModel(client, 'gpt-4.1-mini', content);
      } else {
        throw firstError;
      }
    }

    const outputText = getOutputText(response);

    if (!outputText) {
      return res.status(500).json({
        error: 'AI gaf geen tekst terug.'
      });
    }

    let cleaned;

    try {
      cleaned = cleanJson(outputText);
    } catch (parseError) {
      console.error('JSON parse mislukt. Ruwe output:', outputText);

      return res.status(502).json({
        error: 'AI gaf geen geldige JSON terug.',
        raw: outputText.slice(0, 4000)
      });
    }

    let parsed = JSON.parse(cleaned);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return res.status(502).json({
        error: 'AI gaf geen geldig rapportobject terug.'
      });
    }

    if (!parsed.controles) {
      parsed.controles = {};
    }

    if (!parsed.controles.herkend) {
      parsed.controles.herkend = [
        {
          label: 'PDF ontvangen',
          count: 1
        },
        {
          label: 'Bestandsnaam',
          count: filename ? 1 : 0
        },
        {
          label: 'Adviseursnotities',
          count: notities ? 1 : 0
        }
      ];
    }

    if (!parsed.controles.signalen) {
      parsed.controles.signalen = [
        {
          label: 'Mogelijke inconsistenties',
          count: 0,
          variant: 'warn'
        },
        {
          label: 'Ontbrekende stukken',
          count: 0,
          variant: 'err'
        }
      ];
    }

    if (!parsed.controles.note) {
      parsed.controles.note = 'De agent neemt geen gegevens aan die niet uit de bron blijken.';
    }

    const finalJson = JSON.stringify(parsed);

    return res.status(200).json({
      success: true,
      data: finalJson,
      meta: {
        filename,
        pdfBytes: approxPdfBytes,
        notitiesAanwezig: Boolean(notities),
        outputCharacters: countMatches(finalJson, /./g)
      }
    });
  } catch (error) {
    console.error('Generate-report error:', error);

    return res.status(500).json({
      error: error?.message || 'AI-verwerking mislukt'
    });
  }
}
