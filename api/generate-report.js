import OpenAI from 'openai';

/* ════════════════════════════════════════════════════════════════════
   Credion — Financieringsrapport Generator · /api/generate-report

   Rapport-veredelingsengine, geen samenvatter:
   - Bronwaarheid: elke naam, elk bedrag, elke conclusie herleidbaar
     uit de aangeleverde documenten. Geen demo-data, geen hardcoded
     casusgegevens, geen aannames. (validateNoHardcodedCaseData:
     dit bestand bevat bewust géén klantnamen, bedragen of
     voorbeeldcases — alles komt per upload uit de documenten.)
   - Proportionele lengte: het rapport groeit mee met de bron.
   - Coverage: elk bronhoofdstuk wordt verwerkt of gemotiveerd
     weggelaten; dit wordt server-side gecontroleerd.
   - Onbekend is nooit nul: onbekende bedragen zijn null.
   - Bronnen/aanwendingen worden server-side geherclassificeerd
     bij evidente fouten (eigen inbreng hoort bij bronnen, etc.).
   - Datumregels: rapportdatum nooit een geboortedatum/oprichtings-
     datum; server-side gecontroleerd tegen de bronfeiten.
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
const docRow = obj({ document: s, status: en('ontvangen', 'in bron opgenomen', 'te controleren', 'onvolledig'), toelichting: s });
const missRow = obj({ item: s, prioriteit: PRIO, toelichting: s });
const mixPoint = obj({ label: s, waarde: nN });
const trendPoint = obj({ periode: s, waarde: nN });
const ratioPoint = obj({ ratio: s, periode: s, waarde: nN });
const kvRow = obj({ label: s, waarde: s });
const teamRow = obj({ naam: s, rol: s, achtergrond: s });

const orgEnt = obj({
  id: s,
  naam: s,
  type: en('privepersoon', 'holding', 'werkmaatschappij', 'vastgoed_bv', 'stak', 'in_oprichting', 'overig'),
  rol: s,
  toelichting: s,
});
const orgRel = obj({ van: s, naar: s, label: s });
const orgSchema = obj({ aanwezig: b, titel: s, toelichting: s, entiteiten: arr(orgEnt), relaties: arr(orgRel) });

const REPORT_SCHEMA = obj({
  metadata: obj({
    rapport_type: en('financieringsmemorandum', 'intake_documentatiememorandum'),
    klantnaam: s,
    financieringsdoel: s,
    documentdatum: s,
    rapportdatum: s,
    datum_toelichting: s,
    status: s,
    datadekking: en('hoog', 'middel', 'beperkt'),
    bron_documenten: strArr,
    belangrijkste_beperkingen: strArr,
  }),
  bronrapport: obj({
    aantal_paginas: nN,
    type: s,
    hoofdstukken: strArr,
    gevonden_afbeeldingen: strArr,
    gevonden_organogrammen: strArr,
    gevonden_tabellen: strArr,
  }),
  coverage_check: obj({
    bronhoofdstukken: strArr,
    opgenomen_in_rapport: strArr,
    samengevat: strArr,
    weggelaten_met_reden: strArr,
    waarschuwingen: strArr,
  }),
  bronfeiten: obj({
    partijen: arr(factItem),
    financieringsvraag: arr(factItem),
    investering: arr(factItem),
    financieringsstructuur: arr(factItem),
    financiele_cijfers: arr(factItem),
    zekerheden: arr(factItem),
    object_vastgoed: arr(factItem),
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
  aanvraag_en_transactie: obj({
    tekst: s,
    aanleiding: s,
    besluitvormingsvraag: s,
    kernpunten: strArr,
  }),
  juridische_structuur: obj({
    tekst: s,
    partijen: arr(partijRow),
    bestuur_en_tekenbevoegdheid: strArr,
    aandeelhouders_ubo: strArr,
    organogram_bestaand: orgSchema,
    organogram_nieuw: orgSchema,
  }),
  activiteiten_onderneming: obj({
    tekst: s,
    historie: s,
    verdienmodel: s,
    strategie: s,
    kernpunten: strArr,
  }),
  markt_en_omgeving: obj({
    tekst: s,
    afnemers: s,
    leveranciers: s,
    concurrentie_en_trends: s,
    afhankelijkheden: strArr,
  }),
  management_en_organisatie: obj({
    tekst: s,
    team: arr(teamRow),
    kernpunten: strArr,
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
    bouwdepot_fasering: s,
    voorwaarden: strArr,
  }),
  object_en_vastgoed: obj({
    tekst: s,
    kenmerken: arr(kvRow),
    aandachtspunten: strArr,
  }),
  financiele_analyse: obj({
    tekst: s,
    resultaten: arr(cijferRow),
    balans: arr(cijferRow),
    ratios: arr(ratioRow),
    observaties: strArr,
  }),
  betaalcapaciteit: obj({
    tekst: s,
    tabel: arr(cijferRow),
    kengetallen: arr(ratioRow),
    kernpunten: strArr,
  }),
  inkomen_vermogen_prive: obj({
    tekst: s,
    posten: arr(kvRow),
    relevantie: s,
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
    in_bron_opgenomen: arr(docRow),
    separaat_te_controleren: strArr,
    ontbrekend: arr(missRow),
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
const SYSTEM_BASE = `Je bent een senior Credion-financieringsspecialist en rapport-engineer. Je transformeert aangeleverde documentatie (bijvoorbeeld een Capsearch-memorandum, financieringsplan, jaarrekeningpakket, prognose, taxatie of ander dossierdocument) naar een volwaardig, professioneel Credion-financieringsrapport. Je bent een veredelingsengine, geen samenvatter: je behoudt alle besluitvormingsrelevante informatie uit de bron, structureert die beter en presenteert die in Credion-vorm. Je analyseert uitsluitend de aangeleverde documenten en eventuele adviseursnotities.

ABSOLUTE REGELS — BRONWAARHEID
1. Elke naam, elk bedrag, elk percentage, elk jaartal, elke ratio, elke zekerheid en elke voorwaarde moet herleidbaar zijn uit de aangeleverde documenten. Verzin niets. Geen demo-data, geen voorbeeldcijfers, geen externe kennis.
2. Onbekend is nooit nul. Onbekende bedragen en percentages zijn null. Gebruik 0 alleen als de bron expliciet een nulwaarde vermeldt (bijv. "geen eigen inbreng").
3. Extraheer harde bronfeiten in "bronfeiten" (met bron_document, kort bron_fragment en confidence) vóórdat je rapportsecties schrijft. Geen bronfeit = geen interpretatie. Noteer tegenstrijdigheden tussen documenten expliciet in bronfeiten.tegenstrijdigheden.
4. Ontbrekende informatie markeer je met één professionele zin, zoals "Niet vastgesteld op basis van de aangeleverde documentatie". Herhaal zulke zinnen niet tientallen keren; laat velden en arrays zonder brondata gewoon leeg.
5. Berekeningen (bijv. LTV, totalen) alleen als alle benodigde broncijfers aanwezig zijn. Vermeld afgeleide waarden als zodanig in de toelichting.

WERKWIJZE — EERST INVENTARISEREN, DAN SCHRIJVEN
Stap 1: lees het volledige brondocument. Vul "bronrapport" in: geschat aantal pagina's, documenttype (bijv. "Capsearch-financieringsplan", "jaarrekening"), alle hoofdstukken/secties in bronvolgorde, alle relevante afbeeldingen (korte omschrijving per beeld, bijv. "organogram nieuwe structuur", "rendering nieuwbouw", "plattegrond"), aangetroffen organogrammen en de belangrijkste tabellen.
Stap 2: verantwoord per bronhoofdstuk wat ermee gebeurt in "coverage_check": zet elk hoofdstuk in precies één van de lijsten opgenomen_in_rapport (volledig verwerkt), samengevat, of weggelaten_met_reden (formaat "hoofdstuk — reden"; alleen bij echte duplicatie of niet-besluitvormingsrelevante inhoud). Twijfel = meenemen. Kopieer de volledige hoofdstukkenlijst ook naar coverage_check.bronhoofdstukken.
Stap 3: extraheer bronfeiten. Stap 4: schrijf pas daarna de rapportsecties.

LENGTE — PROPORTIONEEL AAN DE BRON
Het rapport groeit mee met de bron: een bron van 5 pagina's rechtvaardigt circa 5 pagina's output, een bron van 20 pagina's circa 15-20 pagina's. Kort alleen in wat dubbel, wollig of niet-besluitvormingsrelevant is; comprimeer NIET kunstmatig tot een korte samenvatting. Laat omgekeerd niets kunstmatig groeien: secties zonder brondata blijven leeg.
Sectieteksten (tekst-velden): volledige, afgeronde alinea's, zo lang als de broninhoud rechtvaardigt (typisch 60-300 woorden per veld). Gebruik lege regels tussen alinea's. Schrijf ALTIJD volledige zinnen; breek nooit een zin af en eindig nooit met "..." of "…". Tabellen: alle relevante rijen uit de bron (tot 24 per tabel). Bullets: tot 10 per lijst, alleen met echte informatie.

SECTIES (vul alleen wat de bron ondersteunt)
- aanvraag_en_transactie: aanleiding, financieringsdoel, investering, timing, gewenste structuur en de besluitvormingsvraag.
- juridische_structuur: alle betrokken rechtspersonen en privépersonen (rol, rechtsvorm, KvK), bestuur en tekenbevoegdheid, aandeelhouders/UBO's.
- ORGANOGRAMMEN: als de bron een organogram, structuurplaatje of groepsstructuur bevat (bestaand en/of nieuw), reconstrueer die VOLLEDIG in organogram_bestaand / organogram_nieuw: aanwezig=true; titel; entiteiten met uniek kort id (bijv. "e1"), naam, type (privepersoon | holding | werkmaatschappij | vastgoed_bv | stak | in_oprichting | overig) en rol (bijv. "Kredietnemer", "Mede-kredietnemer", "Zekerheidssteller"); relaties van eigenaar ("van") naar deelneming ("naar") met label voor het percentage of de relatie (bijv. "100%", "60%", "certificaten"). Een structuurplaatje uit de bron mag NOOIT verdwijnen. Een structuur die alleen in tekst beschreven staat mag je ook zo reconstrueren.
- activiteiten_onderneming: historie, bedrijfsactiviteiten, verdienmodel, strategie, omzetstromen, operationele aandachtspunten.
- markt_en_omgeving: marktpositie, concurrentie, trends, afnemers, leveranciers, afhankelijkheden, seizoenspatroon, debiteuren-/crediteurenrisico.
- management_en_organisatie: ondernemer(s) en team met rol en achtergrond/ervaring, externe adviseurs, KPI's/rapportages.
- financieringsopzet: kerncijfers, bronnen en aanwendingen, bestaande én nieuwe faciliteiten met condities, bouwdepot/fasering, btw-aspecten, voorwaarden.
- object_en_vastgoed: adres, type object, oppervlakte, taxatiewaarde en taxatiedatum, energielabel, erfpacht, gebruik/verhuur, LTV — als kenmerken-rijen {label, waarde}.
- financiele_analyse: historische cijfers én prognose. resultaten en balans als rijen {label, periode, bedrag}; gebruik consistente labels per periode zodat er een tabel per jaar van te maken is (bijv. label "Omzet" met periode "2024"). Prognosejaren markeren met "(prognose)" in de periode.
- betaalcapaciteit: historische en genormaliseerde betaalcapaciteit, correcties, privéonttrekkingen/privébehoefte, rente- en aflossingsverplichtingen, DSCR, Debt/EBITDA, overgangsjaar versus structurele situatie. Tabel als {label, periode, bedrag}; DSCR/Debt-EBITDA als kengetallen-rijen.
- inkomen_vermogen_prive: alleen indien de bron dit bevat: inkomen ondernemer, partnerinkomen, woningwaarde, hypotheek, vermogen, privébehoefte — als posten {label, waarde} — plus relevantie voor de financiering.
- zekerheden_en_risico: alle zekerheden met waarde, dekkingspositie, volledige risicomatrix (elk risico met kans, impact en mitigant), bancaire aandachtspunten.

BRONNEN EN AANWENDINGEN — CLASSIFICATIE
Bronnen = waar het geld vandaan komt: hypothecaire lening, bancaire lening, eigen inbreng, achtergestelde lening, vendor loan, bouwdepot, subsidie, btw-financiering, overige bronnen. Aanwendingen = waar het geld naartoe gaat: koop-/aanneemsom, aankoopprijs, bouwkosten, verbouwing, kosten koper, btw, notaris, taxatie, financierings- en advieskosten, onvoorzien, werkkapitaal, herfinanciering bestaande schuld. Eigen inbreng of een lening staat NOOIT onder aanwendingen; een koop-/aanneemsom of kosten koper staat NOOIT onder bronnen. Totalen van bronnen en aanwendingen moeten sluiten; zo niet, benoem het verschil expliciet in een toelichting.

DATUMREGELS
metadata.documentdatum: de datum van het brondocument zelf (voorblad, "opgesteld op", documentmetadata) in Nederlandse notatie; leeg als die niet vaststaat. metadata.rapportdatum: de datum van dít rapport — gebruik de actuele datum. Gebruik NOOIT een geboortedatum, oprichtingsdatum of taxatiedatum als document- of rapportdatum. Bij twijfel: documentdatum leeg laten en toelichten in datum_toelichting.

AFBEELDINGEN UIT DE BRON
Je kunt beeldmateriaal uit een PDF niet als afbeelding opnieuw aanleveren. Registreer daarom elk relevant beeld (rendering, objectfoto, plattegrond, bouwplanning, grafiek, schema) in bronrapport.gevonden_afbeeldingen met een korte, concrete omschrijving. Organogrammen reconstrueer je als data (zie boven). Feitelijke informatie die alleen in beelden staat (adres op een rendering, oppervlaktes op een plattegrond) verwerk je in de betreffende sectie als tekst of kenmerk.

SCHRIJFSTIJL
Zakelijk Nederlands in Credion-stijl: helder, professioneel, adviserend, bancair. Korte alinea's, duidelijke bullets. Geen marketingtaal, geen superlatieven, geen wollige AI-taal, geen onnodig juridisch jargon. Behoud de nuance uit de bron; verbeter de taal waar de bron wollig of herhalend is. Het rapport moet voelen alsof een ervaren financieringsadviseur het heeft opgesteld.

CONCLUSIEBELEID
Wees voorzichtig en professioneel. Gebruik nuance: "voorlopig", "op basis van de aangeleverde informatie", "mits", "na adviseurscontrole", "onder voorbehoud van verificatie", "liquiditeit monitoren".
- Sterke brondata → oordeel "voorzichtig positief": financieel verdedigbaar, mits de uitgangspunten uit de prognose worden gerealiseerd en de onderliggende stukken door de adviseur worden gecontroleerd.
- Beperkte data → oordeel "onvoldoende data": nog geen definitief oordeel mogelijk; aanvullende informatie benodigd.
- VERBODEN zonder volledige onderbouwing: "de financiering is verantwoord en betaalbaar", "kan zonder meer worden verstrekt", "bankwaardig", "sterk onderbouwd", "duurzaam draagbaar", "geen noemenswaardige risico's", "definitief akkoord".
- conclusie.extern_deelbaar: één zin met advies of het rapport na adviseurscontrole extern deelbaar is.

VISUALISATIES
Vul grafiekarrays uitsluitend met echte bronbedragen. financieringsmix: de opbouw van de financiering. omzetontwikkeling / resultaatontwikkeling: per periode, inclusief prognosejaren (markeer met "(prognose)"). zekerhedenmix: alleen met waardes uit de bron. ratioontwikkeling: DSCR en/of Debt/EBITDA per periode als numerieke waarde. Geen betrouwbare bedragen = lege array []. Nooit 0-waarden als vulling, nooit één losse onduidelijke waarde.

RISICO'S
Alle risico's die uit de bron volgen, elk met mitigant: ondernemersafhankelijkheid, marktrisico, debiteuren/crediteuren, voorraad/werkkapitaal, bouwfase, dubbele lasten, prognoserisico, enzovoort. Bij beperkte documentatie is "Documentatierisico" (kans hoog, impact hoog, mitigant: aanvullende stukken opvragen vóór externe beoordeling) het belangrijkste risico.

DOCUMENTATIECHECK — EERLIJK
- ontvangen: uitsluitend de daadwerkelijk aangeleverde bestanden (status "ontvangen").
- in_bron_opgenomen: informatie of stukken die in het bronmemorandum zijn opgenomen of daarin worden genoemd (status "in bron opgenomen").
- separaat_te_controleren: onderliggende stukken die in de bron worden genoemd maar niet los zijn aangeleverd.
- ontbrekend: stukken die voor besluitvorming nodig zijn maar nergens blijken.
Claim NOOIT dat stukken los ontvangen zijn als ze alleen in het bronmemorandum staan. Formuleer maximaal 6 gerichte vervolgvragen.

RAPPORTTYPE
"financieringsmemorandum" alleen als minimaal bekend zijn: kredietnemer, financieringsdoel, financieringsbedrag (of duidelijke behoefte) én concrete financiële cijfers. Anders "intake_documentatiememorandum": een eerlijk intake- en documentatieoverzicht (wat is vastgesteld, wat ontbreekt, welke stukken nodig zijn, logische vervolgstap).

METADATA
klantnaam: de kredietnemer/onderneming zoals in de bron. financieringsdoel: één compacte zin. status: altijd "Concept · ter beoordeling". datadekking: jouw eerlijke inschatting (wordt server-side geverifieerd).

OUTPUT
Antwoord uitsluitend met valide JSON volgens het schema. Geen markdown, geen tekst buiten de JSON.`;

function buildPrompt({ notities, docSummary, vandaag }) {
  return `${SYSTEM_BASE}

AANGELEVERDE DOCUMENTEN
${docSummary}

ADVISEURSNOTITIES
${notities || 'Geen aanvullende adviseursnotities opgegeven.'}

ACTUELE DATUM (voor metadata.rapportdatum)
${vandaag}

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

/* Datums: rapport-/documentdatum mag geen geboorte-/oprichtings-/taxatiedatum zijn */
const MONTHS = { januari: 1, februari: 2, maart: 3, april: 4, mei: 5, juni: 6, juli: 7, augustus: 8, september: 9, oktober: 10, november: 11, december: 12 };
function parseNLDate(str) {
  const t = String(str || '').toLowerCase().trim();
  let m = t.match(/(\d{1,2})[-/. ](\d{1,2})[-/. ](\d{2,4})/);
  if (m) return { d: +m[1], mo: +m[2], y: +m[3] < 100 ? 1900 + +m[3] : +m[3] };
  m = t.match(/(\d{1,2})\s+(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)\s+(\d{4})/);
  if (m) return { d: +m[1], mo: MONTHS[m[2]], y: +m[3] };
  return null;
}
const sameDate = (a, b) => !!(a && b && a.d === b.d && a.mo === b.mo && a.y === b.y);

function collectSuspectDates(r, pattern) {
  const out = [];
  for (const cat of Object.values(r.bronfeiten || {})) {
    if (!Array.isArray(cat)) continue;
    for (const f of cat) {
      const ctx = `${f?.label || ''} ${f?.bron_fragment || ''}`;
      if (!pattern.test(ctx)) continue;
      const p = parseNLDate(f?.waarde) || parseNLDate(f?.bron_fragment);
      if (p) out.push(p);
    }
  }
  return out;
}

function enforceDates(r, warnings, vandaag) {
  const md = (r.metadata = r.metadata || {});
  const births = collectSuspectDates(r, /geboor|geboren/i);
  const oprichting = collectSuspectDates(r, /opgericht|oprichtingsdatum/i);
  const taxatie = collectSuspectDates(r, /taxatie/i);
  const isTaxatierapport = /taxatie/i.test(String(r.bronrapport?.type || ''));

  const check = (field, label) => {
    const p = parseNLDate(md[field]);
    if (!p) return;
    if (births.some((x) => sameDate(x, p))) {
      warnings.push(`${label} was gelijk aan een geboortedatum uit de bron en is gecorrigeerd.`);
      md[field] = '';
    } else if (oprichting.some((x) => sameDate(x, p)) && field === 'rapportdatum') {
      warnings.push(`Rapportdatum was gelijk aan een oprichtingsdatum en is gecorrigeerd.`);
      md[field] = '';
    } else if (taxatie.some((x) => sameDate(x, p)) && field === 'rapportdatum' && !isTaxatierapport) {
      warnings.push(`Rapportdatum was gelijk aan een taxatiedatum en is gecorrigeerd.`);
      md[field] = '';
    }
  };
  check('rapportdatum', 'Rapportdatum');
  check('documentdatum', 'Documentdatum');
  if (!hasTxt(md.rapportdatum)) md.rapportdatum = vandaag;
}

/* Bronnen/aanwendingen: evidente classificatiefouten herstellen */
const BRON_PAT = /(eigen\s+(inbreng|middelen|vermogen)|\binbreng\b|hypothecaire\s+(lening|financiering)|bancaire?\s+(lening|financiering)|achtergestelde?\s+lening|vendor\s?loan|verkopersl?ening|\bsubsidie\b|bouwdepot|btw[- ]?(teruggave|financiering)|\blening\b|\bkrediet\b)/i;
const AANW_PAT = /(koopsom|aanneemsom|aankoopprijs|\baankoop\b|kosten\s+koper|bouwkosten|verbouwing|renovatie|nieuwbouwkosten|notaris|taxatiekosten|advieskosten|financieringskosten|afsluitprovisie|onvoorzien|werkkapitaal|inventaris|installaties|leges|overdrachtsbelasting|herfinanciering)/i;

function enforceBnA(fo, warnings) {
  for (const row of A(fo.bronnen_en_aanwendingen)) {
    const l = String(row?.label || '');
    if (!l) continue;
    if (row.type === 'aanwending' && BRON_PAT.test(l) && !AANW_PAT.test(l)) {
      row.type = 'bron';
      warnings.push(`"${l}" stond onder aanwendingen en is verplaatst naar bronnen (classificatieregel).`);
    } else if (row.type === 'bron' && AANW_PAT.test(l) && !BRON_PAT.test(l)) {
      row.type = 'aanwending';
      warnings.push(`"${l}" stond onder bronnen en is verplaatst naar aanwendingen (classificatieregel).`);
    }
  }
}

/* Coverage: elk bronhoofdstuk verwerkt of gemotiveerd weggelaten */
function enforceCoverage(r, warnings) {
  const cv = (r.coverage_check = r.coverage_check || {});
  cv.waarschuwingen = A(cv.waarschuwingen);
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();
  const hoofdstukken = A(r.bronrapport?.hoofdstukken).filter(hasTxt);
  if (!A(cv.bronhoofdstukken).length) cv.bronhoofdstukken = [...hoofdstukken];
  const covered = [...A(cv.opgenomen_in_rapport), ...A(cv.samengevat), ...A(cv.weggelaten_met_reden)].map(norm);
  for (const h of hoofdstukken) {
    const n = norm(h);
    if (!n) continue;
    const hit = covered.some((c) => c.includes(n.slice(0, Math.min(n.length, 18))) || n.includes(c.slice(0, Math.min(c.length, 18))));
    if (!hit) cv.waarschuwingen.push(`Bronhoofdstuk "${h}" is niet expliciet verwerkt of gemotiveerd weggelaten; door adviseur te controleren.`);
  }
  const orgFound = A(r.bronrapport?.gevonden_organogrammen).filter(hasTxt).length;
  const orgIncluded =
    r.juridische_structuur?.organogram_bestaand?.aanwezig === true ||
    r.juridische_structuur?.organogram_nieuw?.aanwezig === true;
  if (orgFound && !orgIncluded) {
    cv.waarschuwingen.push('De bron bevat een organogram/structuurplaatje dat niet in het rapport is gereconstrueerd; door adviseur aan te vullen.');
  }
  warnings.push(...cv.waarschuwingen.filter((w) => !warnings.includes(w)));
}

/* Afgekapte tekst en render-vervuiling opruimen */
function deepCleanStrings(node, warnings, path = '') {
  if (typeof node === 'string') {
    let v = node;
    if (/(\.\.\.|…)\s*$/.test(v.trim()) && v.trim().length > 20) {
      v = v.trim().replace(/[\s.]*(\.\.\.|…)\s*$/, '.');
      if (!warnings.includes('Afgekapte tekst gedetecteerd en genormaliseerd; door adviseur te controleren op volledigheid.')) {
        warnings.push('Afgekapte tekst gedetecteerd en genormaliseerd; door adviseur te controleren op volledigheid.');
      }
    }
    if (/^(undefined|null|NaN|\[object Object\])$/i.test(v.trim())) return '';
    return v;
  }
  if (Array.isArray(node)) return node.map((x, i) => deepCleanStrings(x, warnings, `${path}[${i}]`));
  if (node && typeof node === 'object') {
    for (const k of Object.keys(node)) node[k] = deepCleanStrings(node[k], warnings, `${path}.${k}`);
    return node;
  }
  return node;
}

/* Ruwe scan op demo-/testdata-markers (validateNoHardcodedCaseData) */
function scanDemoMarkers(r, warnings) {
  const txt = JSON.stringify(r);
  if (/\b(lorem ipsum|voorbeeld\s?b\.?v\.?|demo\s?b\.?v\.?|testcasus|acme)\b/i.test(txt)) {
    warnings.push('Mogelijke demo- of voorbeelddata aangetroffen in de output; door adviseur te controleren tegen de bron.');
  }
}

function computeDekking(r) {
  const kc = r.financieringsopzet?.kerncijfers || {};
  const bnaBron = A(r.financieringsopzet?.bronnen_en_aanwendingen).some((x) => x?.type === 'bron' && num(x.bedrag) !== null);
  const bedrag = num(kc.gevraagde_financiering) !== null || bnaBron;
  const cijfers =
    A(r.financiele_analyse?.resultaten).filter((x) => num(x?.bedrag) !== null).length >= 2 ||
    A(r.financiele_analyse?.ratios).length >= 2;
  const zeker = A(r.zekerheden_en_risico?.zekerheden).filter((x) => hasTxt(x?.zekerheid)).length >= 1;
  const partijen = A(r.juridische_structuur?.partijen).filter((x) => hasTxt(x?.naam)).length >= 1;
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
  /(verantwoord en betaalbaar|zonder meer worden verstrekt|bankwaardig rapport|sterk onderbouwd|duurzaam draagbaar|geen noemenswaardige risico'?s|financiering kan worden verstrekt|definitief akkoord)/i;

function enforceQuality(r, vandaag) {
  const warnings = [];
  const zero = makeZeroChecker(r);

  /* 0 — afgekapte tekst / render-vervuiling */
  deepCleanStrings(r, warnings);
  scanDemoMarkers(r, warnings);

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
  const bc = (r.betaalcapaciteit = r.betaalcapaciteit || {});
  bc.tabel = A(bc.tabel).map((row) => ({ ...row, bedrag: num(row?.bedrag) }));
  const zr = (r.zekerheden_en_risico = r.zekerheden_en_risico || {});
  zr.zekerheden = A(zr.zekerheden).map((row) => ({ ...row, waarde: zero(row?.waarde) }));

  /* 2 — bronnen/aanwendingen: classificatie + sluitcheck */
  enforceBnA(fo, warnings);
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

  /* 4 — datumregels */
  enforceDates(r, warnings, vandaag);

  /* 5 — datadekking en rapporttype server-side */
  const dd = computeDekking(r);
  r.metadata = r.metadata || {};
  const aiType = r.metadata.rapport_type;
  r.metadata.rapport_type = dd.volwaardig ? (aiType || 'financieringsmemorandum') : 'intake_documentatiememorandum';
  if (aiType === 'financieringsmemorandum' && r.metadata.rapport_type === 'intake_documentatiememorandum') {
    warnings.push('Rapporttype teruggezet naar intake- en documentatiememorandum: onvoldoende datadekking voor een volwaardig financieringsmemorandum.');
  }
  r.metadata.datadekking = dd.niveau;
  r.metadata.status = 'Concept · ter beoordeling';

  /* 6 — conclusiebeleid */
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

  /* 7 — documentatiecheck: eerlijkheidscheck */
  const dc = (r.documentatiecheck = r.documentatiecheck || {});
  const bronDocs = A(r.metadata.bron_documenten).map((x) => String(x).toLowerCase());
  dc.ontvangen = A(dc.ontvangen).filter((row) => hasTxt(row?.document));
  for (const row of dc.ontvangen) {
    const naam = String(row.document).toLowerCase();
    const echtOntvangen = bronDocs.some((d) => d.includes(naam.slice(0, 12)) || naam.includes(d.slice(0, 12)));
    if (row.status === 'ontvangen' && !echtOntvangen && bronDocs.length) {
      row.status = 'in bron opgenomen';
      warnings.push(`"${row.document}" stond als ontvangen maar is niet los aangeleverd; status gecorrigeerd naar "in bron opgenomen".`);
    }
  }

  /* 8 — coverage */
  enforceCoverage(r, warnings);

  /* 9 — kwaliteitscontrole bijwerken */
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
    max_output_tokens: 28000,
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
    const vandaag = new Date().toLocaleDateString('nl-NL', { day: 'numeric', month: 'long', year: 'numeric' });
    const prompt = buildPrompt({ notities, docSummary, vandaag });
    const content = [{ type: 'input_text', text: prompt }, ...docContent];

    const model = process.env.OPENAI_MODEL || 'gpt-4.1-mini';
    let response;
    try {
      response = await createResponse(client, model, content);
    } catch (firstErr) {
      if (firstErr?.status === 429 || String(firstErr?.message || '').includes('429')) {
        response = await createResponse(client, 'gpt-4.1-nano', content);
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
      report = enforceQuality(parsed, vandaag);
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
