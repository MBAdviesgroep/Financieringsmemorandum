import OpenAI from 'openai';

/* ── Bronomvang: pagina's tellen zonder extra dependency ─────────────
   Werkt op de ruwe PDF-bytes. Twee heuristieken, generiek voor elke PDF:
   1. /Count N op een /Pages-knoop (werkt ook bij deels gecomprimeerde PDF's
      zolang de paginaboom zelf niet in een objectstream zit).
   2. Losse /Type /Page objecten tellen (niet /Pages).
   Geeft null terug als geen van beide betrouwbaar iets oplevert; dan valt
   de rest van de tool terug op rapporttype-gebaseerde standaardlengtes. */
function estimatePdfPageCount(buf) {
  try {
    const text = buf.toString('latin1');
    const countMatches = [...text.matchAll(/\/Type\s*\/Pages\b(?:(?!endobj)[\s\S]){0,400}?\/Count\s+(\d+)/g)]
      .map((m) => parseInt(m[1], 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n < 5000);
    if (countMatches.length) return Math.max(...countMatches);
    const pageMatches = text.match(/\/Type\s*\/Page(?!s)\b/g);
    if (pageMatches && pageMatches.length) return pageMatches.length;
  } catch {
    // Onleesbare/versleutelde PDF: geen betrouwbare telling mogelijk.
  }
  return null;
}

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
const bnaRow = obj({ label: s, type: en('bron', 'aanwending'), bedrag: nN, totaalregel: b, toelichting: s });
const finRow = obj({ label: s, bedrag: nN, condities: s, toelichting: s });
const cijferRow = obj({ label: s, periode: s, bedrag: nN });
const ratioRow = obj({ ratio: s, periode: s, waarde: s, norm: s, toelichting: s });
const riskRow = obj({ risico: s, toelichting: s, kans: PRIO, impact: PRIO, mitigant: s });
const dscrRow = obj({ jaar: s, situatie: s, dscr: s, toelichting: s });
const zekerRow = obj({ zekerheid: s, waarde: nN, status: s, toelichting: s });
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
    rapport_type: en('volwaardig_financieringsmemorandum', 'compact_intake', 'luxe_samenvatting'),
    klantnaam: s,
    financieringsdoel: s,
    documentdatum: s,
    rapportdatum: s,
    datum_toelichting: s,
    status: s,
    kantoor_adviseur: s,
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
    financieringsduiding: s,
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
    structuur_tekstueel: strArr,
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
    dscr_overzicht: arr(dscrRow),
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
  overige_secties: arr(obj({ titel: s, tekst: s, tabel: arr(kvRow) })),
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
const SYSTEM_BASE = `Je bent een document-transformator voor Credion: geen nieuwe kredietanalist, maar een document designer, zakelijke redacteur, structuurverbeteraar en kwaliteitscontroleur. Je neemt het aangeleverde financieringsplan of memorandum (bijvoorbeeld Capsearch) inhoudelijk zo volledig en letterlijk mogelijk over en zet het om naar een professioneel Credion-rapport. Je mag teksten redigeren, compacter maken en beter structureren, maar cijfers, tabellen, labels en financiële verbanden blijven exact zoals in de bron. Je herclassificeert geen posten, voegt geen eigen berekeningen of conclusies toe en signaleert onduidelijkheden als controlepunt. Je analyseert uitsluitend de aangeleverde documenten en eventuele adviseursnotities.

ABSOLUTE REGELS — BRONWAARHEID
1. Elke naam, elk bedrag, elk percentage, elk jaartal, elke ratio, elke zekerheid en elke voorwaarde moet herleidbaar zijn uit de aangeleverde documenten. Verzin niets. Geen demo-data, geen voorbeeldcijfers, geen externe kennis.
2. Onbekend is nooit nul. Onbekende bedragen en percentages zijn null. Gebruik 0 alleen als de bron expliciet een nulwaarde vermeldt (bijv. "geen eigen inbreng").
3. Extraheer harde bronfeiten in "bronfeiten" (met bron_document, kort bron_fragment en confidence) vóórdat je rapportsecties schrijft. Geen bronfeit = geen interpretatie. Noteer tegenstrijdigheden tussen documenten expliciet in bronfeiten.tegenstrijdigheden. Spreekt de brontabel een andere brontoelichting tegen (bijv. een tabel die "geen bestaande financieringen" vermeldt terwijl de toelichting elders bestaande leningen noemt), verzin dan geen eigen interpretatie van welke bron gelijk heeft: benoem het verschil neutraal, bijvoorbeeld "In de brontabel staat vermeld dat geen bestaande financieringen zijn opgenomen, terwijl de toelichting bestaande financieringen noemt. De actuele positie dient daarom te worden geverifieerd."
4. Ontbrekende informatie markeer je met één professionele zin, zoals "Niet vastgesteld op basis van de aangeleverde documentatie". Herhaal zulke zinnen niet tientallen keren; laat velden en arrays zonder brondata gewoon leeg.
5. Berekeningen (bijv. LTV, totalen) alleen als alle benodigde broncijfers aanwezig zijn. Vermeld afgeleide waarden als zodanig in de toelichting.

TRANSFORMATIE-MODUS — VOLG DE BRON
6. Neem bedragen exact over. Tel niets zelf op, tenzij het totaal letterlijk in de bron staat. Als een brontabel sluit, sluit jouw tabel ook — exact hetzelfde totaal.
7. Herclassificeer geen posten en verplaats geen bedragen tussen bronnen en aanwendingen. Neem bronnen-en-aanwendingentabellen letterlijk over zoals de bron ze presenteert, met de labels uit de bron.
8. Een bouwdepot of opnametermijnen (termijn 1 t/m n) zijn een opnameplanning/uitsplitsing van de lening — NOOIT een extra financieringsbron naast die lening, tenzij de bron dit expliciet zo presenteert. Zet de fasering in bouwdepot_fasering.
9. Ratio's zijn geen geldbedragen. DSCR als "3,11" of "3,11x" (nooit "€ 3"), LTV als percentage ("84,7%"), Debt/EBITDA als ratio ("5,90x"). Neem het aantal decimalen exact over uit de bron: staat er "3,11", schrijf dan "3,11" en rond dit nooit af naar "3". Gebruik de "x"-notatie consistent: als de bron "17,40x" geeft, schrijf geen "17,4" zonder x.
10. Gebruik voor resultaatposten de exacte labels uit de bron: onderscheid bedrijfsresultaat, resultaat voor belastingen en resultaat na belastingen; verwissel deze nooit.
11. Behoud de hoofdstukstructuur van de bron: hoofdstukken niet onnodig samenvoegen of splitsen. Bronhoofdstukken die niet in het schema passen zet je in overige_secties, elk met titel, tekst en eventueel een tabel met {label, waarde}-rijen — maar ZET NOOIT detailgegevens van betrokken personen of rechtspersonen (naam, KvK-nummer, rechtsvorm, oprichtingsdatum, adres) in overige_secties: die staan al volledig in de partijentabel van juridische_structuur (hoofdstuk 2), en een los blok "Detail gegevens betrokken partij(en)" of vergelijkbaar verderop in het rapport is een ongewenste, herhalende datadump. Zet ook NOOIT een structuurschema, organogram of iets met "structuur" in de titel in overige_secties: dat hoort uitsluitend thuis in juridische_structuur (organogram_bestaand/organogram_nieuw/structuur_tekstueel), dat al zijn eigen plek in hoofdstuk 2 heeft — een tweede versie ervan in overige_secties zou verderop in het rapport (bijv. bij Voorwaarden & documentatie) als ongewenst duplicaat verschijnen.
12. Bij twijfel: volg de bron letterlijk en neem een controlepunt op in coverage_check.waarschuwingen.

WERKWIJZE — EERST INVENTARISEREN, DAN SCHRIJVEN
Stap 1: lees het volledige brondocument. Vul "bronrapport" in: geschat aantal pagina's, documenttype (bijv. "Capsearch-financieringsplan", "jaarrekening"), alle hoofdstukken/secties in bronvolgorde, alle relevante afbeeldingen (korte omschrijving per beeld, bijv. "organogram nieuwe structuur", "rendering nieuwbouw", "plattegrond"), aangetroffen organogrammen en de belangrijkste tabellen.
Stap 2: verantwoord per bronhoofdstuk wat ermee gebeurt in "coverage_check": zet elk hoofdstuk in precies één van de lijsten opgenomen_in_rapport (volledig verwerkt), samengevat, of weggelaten_met_reden (formaat "hoofdstuk — reden"; alleen bij echte duplicatie of niet-besluitvormingsrelevante inhoud). Twijfel = meenemen. Kopieer de volledige hoofdstukkenlijst ook naar coverage_check.bronhoofdstukken.
Stap 3: extraheer bronfeiten. Stap 4: schrijf pas daarna de rapportsecties.

PAGINABUDGET — HARDE REGEL
Er zijn twee rapporttypen met elk een eigen harde paginalimiet, inclusief voorblad, inhoudsopgave en achterblad. De inhoudsopgave krijgt in de renderer altijd een eigen pagina (nooit samengevoegd met hoofdstuk 1):
- Rapporttype A ("compact_intake" — compact intake- en documentatiememorandum): doellengte 6 à 8 pagina's, NOOIT meer dan 8. Past het rapport binnen 7 pagina's, gebruik dan 7 — voeg geen lege of overbodige pagina toe.
- Rapporttype B ("volwaardig_financieringsmemorandum" of "luxe_samenvatting" — volledig financieringsmemorandum): doellengte 11 à 13 pagina's, NOOIT meer dan 15.
De paginalimiet is verplicht en geldt ongeacht de lengte van de bron: bij een bron van 20+ pagina's moet je actief samenvatten, samenvoegen en keuzes maken. Dreigt het rapport te lang te worden, kort dan in vóór oplevering — in deze volgorde: teksten verkorten; dubbele informatie verwijderen; hoofdstukken combineren; tabellen beperken tot kerninformatie; visueel organogram vervangen door tekstschema; vervolgvragen samenvoegen met op te vragen stukken; overbodige KPI-blokken schrappen. Los het nooit op door essentiële onderdelen volledig te verwijderen. Je bent een transformatietool, geen uitbreidtool. Ook als de adviseursnotities om een "uitgebreid rapport" vragen blijven deze maxima gelden. Lay-out gaat boven volledigheid: als inhoud te lang is voor een nette pagina-indeling, vat de tekst dan verder samen in plaats van tabellen of hoofdstukken te laten breken.

RAPPORTTYPE A — STRUCTUUR (compact intake- en documentatiememorandum, maximaal 8 pagina's)
Gebruik dit type bij eenvoudige financieringen: financial lease, bedrijfsmiddelen-, machine- of voertuigfinanciering, relatief kleine aanvragen, geen vastgoedfinanciering, geen bedrijfsovername, beperkte broninformatie, geen uitgebreide prognose of kasstroomanalyse. Vaste indeling: pagina 1 cover; pagina 2 inhoudsopgave (eigen pagina); pagina 3 kernsamenvatting; daarna één pagina per hoofdstuk. Hoofdstukken (maximaal; combineren mag als de inhoud kort is): 01 Kernsamenvatting; 02 Juridische structuur & activiteiten; 03 Financieringsaanvraag (sources & uses); 04 Bestaande financieringen & zekerheden; 05 Documentatie, aandachtspunten & op te vragen stukken — met de financieringssamenvatting als afsluiting van ditzelfde hoofdstuk (GEEN apart zesde slothoofdstuk of losse laatste pagina).
- Kernsamenvatting: maximaal 150 woorden — wie de klant is, wat wordt gefinancierd, bedrag, looptijd, rente, financieringsvorm, waarom de investering past binnen de bedrijfsvoering, belangrijkste aandachtspunten. Formuleer het doel financieringsgericht als "Doel van de aanvraag", bijvoorbeeld "Het opvragen van financieringsvoorstellen voor de leasefinanciering van bedrijfsmiddelen ter ondersteuning van de bedrijfsvoering en verduurzaming." Gebruik nooit de term "besluitvormingsvraag".
- Juridische structuur & activiteiten: maximaal één pagina; bij voorkeur GEEN visueel organogram maar een tekstueel structuurschema; activiteiten maximaal 6 bullets, geen lange alinea's als bullets voldoende zijn. Geen dubbele 100%-labels als de verhouding feitelijk bijv. 70%/30% is.
- Sources & uses óók bij lease: aanwendingen = de bedrijfsmiddelen (bedrag per object indien bekend, anders één gecombineerde regel zoals "Bedrijfsmiddelen, afvulmachine en laadinfrastructuur"); bronnen = financial lease plus eigen inbreng (€ 0 alleen als de bron expliciet geen eigen inbreng vermeldt). Bronnen en aanwendingen moeten altijd aansluiten. Vermeld bij financial lease duidelijk: looptijd, rente, eventuele slottermijn en eigen inbreng.
- Bestaande financieringen: alleen wat relevant is — financier, type faciliteit, restschuld/limiet; onbekende actuele benutting = "te actualiseren". Geen volledige vastgoedanalyse bij een niet-vastgoedaanvraag.
- Documentatie: commercieel en compact. GEEN defensieve lijst van alles wat ontbreekt ("geen prognose beschikbaar", "geen marktpositie beschikbaar" enz.) — wel een korte lijst nog te controleren / op te vragen stukken (actuele bankopgave, actuele benutting rekening-courant, definitieve facturen/offertes, bevestiging verpanding leaseobjecten, borgstellingen indien door financier vereist, recente cijfers indien gevraagd). Vervolgvragen alleen als ze echt nieuwe informatie toevoegen.
- Financieringssamenvatting: GEEN apart hoofdstuk en GEEN losse laatste pagina — plaats deze als afsluiting onderaan hoofdstuk 05 (Documentatie, aandachtspunten & op te vragen stukken), maximaal 8 regels, financieringsgericht. Voeg daar geen aparte kop "Bijlage", "Bijlage(n)" of "Contactgegevens" aan toe: kantoor/adviseur en rapportdatum staan al op de cover en in de paginafooter.

RAPPORTTYPE B — STRUCTUUR (volledig financieringsmemorandum, richtlengte 11-13 pagina's, maximaal 15)
Gebruik dit type bij complexere financieringen: vastgoedfinanciering, aankoop bedrijfspand, overnamefinanciering, herfinanciering, meerdere entiteiten (vastgoed-B.V./holding/werkmaatschappij), beschikbare prognoses en betaalcapaciteit, zekerheden zoals hypotheekrecht, verpanding of borgstelling, of substantiële aanvragen waarbij financiers een volledig beeld nodig hebben. Vaste indeling: pagina 1 cover; pagina 2 inhoudsopgave (eigen pagina); pagina 3 managementsamenvatting; daarna één pagina per hoofdstuk; geen achterblad. Richtlengte 11 tot 13 pagina's, maximaal 15 — gebruik extra pagina's zodra dat nodig is voor een rustige lay-out en om te voorkomen dat hoofdstukken worden afgekapt of inhoud sneuvelt. Volledigheid gaat vóór kunstmatig inkorten: alles moet er netjes en compleet in staan — structuur, activiteiten, financieringsopzet, object en zekerheden, financiële analyse mét prognosecijfers, betaalcapaciteit, risico's, voorwaarden en documentatie — liever een paar pagina's extra dan iets weglaten of afkappen. De vaste hoofdstukken (exact 8): 01 Managementsamenvatting; 02 Juridische structuur, activiteiten & strategie; 03 Financieringsopzet / bronnen en aanwendingen; 04 Objectgegevens & zekerheden; 05 Financiële analyse (incl. prognose); 06 Betaalcapaciteit & ratio's; 07 Risico's, mitiganten & aandachtspunten; 08 Voorwaarden voor verdere beoordeling & documentatie — met de financieringssamenvatting als afsluiting van dit hoofdstuk (GEEN apart negende hoofdstuk en GEEN losse laatste pagina).
- Managementsamenvatting: dit hoofdstuk is de commerciële kern van het rapport — een financier moet er direct uit begrijpen waarom het dossier interessant is, wat de financieringsvraag is en welke punten aandacht vragen. Kernboodschap van 180 tot 220 woorden (mag oplopen tot 250 als de casus dat rechtvaardigt, nooit korter dan 180), krachtig en financieringsgericht geschreven als aaneengesloten LOPENDE TEKST in volledige zinnen — geen droge opsomming, geen rij losse telegramzinnen en geen kernboodschap die uit fragmenten zonder duidelijk onderwerp bestaat. Elke zin heeft een duidelijk, expliciet onderwerp; begin een zin nooit met een verwijzend voornaamwoord zonder helder referent (bijv. "Deze worden beperkt door…") — herhaal het onderwerp (de onderneming, de ondernemer, de aanvraag) zo nodig expliciet in plaats van vaag te verwijzen. Benoem in doorlopende tekst: de onderneming en haar activiteiten, de ondernemer, het doel van de financiering, de structuur (incl. eventuele vastgoed-B.V.), de totale investering, de gevraagde financiering, de eigen inbreng, de historische resultaten, de prognose, de betaalcapaciteit, de voorgestelde zekerheden, de belangrijkste aandachtspunten, en kort waarom de aanvraag financierbaar of interessant is voor een financier. Gebruik nooit de titel of het begrip "voorlopig oordeel". Controleer dat de volgende onderdelen allemaal compact terugkomen in hoofdstuk 01 (in de kernboodschap, de kpi_cards of de sterktes/aandachtspunten): onderneming en ondernemer, activiteiten, doel van de financiering, structuur, totale investering, gevraagde financiering, eigen inbreng, belangrijkste historische resultaten, prognose/structureel jaar, betaalcapaciteit, zekerheden en de belangrijkste aandachtspunten — hoofdstuk 01 mag hiervoor een volle pagina beslaan. kpi_cards bevat minimaal deze kerncijfers (label - waarde): Gevraagde financiering, Totale investering, Eigen inbreng, Loan-to-value (LTV), Looptijd, Rente, DSCR (van het structurele/eerste volle jaar, met dat jaar in het label, bijv. "DSCR 2028"), en Omzet (van het structurele/prognosejaar, met dat jaar in het label, bijv. "Omzet 2028") — alleen vullen met daadwerkelijke brondata, nooit gokken of 0 invullen als het onbekend is. belangrijkste_sterktes: maximaal 5, concreet en specifiek voor dit dossier (nooit generiek zoals "goede onderneming"). aandachtspunten: maximaal 5, concreet en specifiek (bijv. definitieve oprichting/inschrijving van een vastgoed-B.V., vastlegging van een huurovereenkomst, liquiditeitsbewaking tijdens een bouw-/overgangsfase, realisatie van de prognose, ondernemersafhankelijkheid). financieringsduiding: een zelfstandige afsluiting van minimaal 4 en maximaal 6 regels die dit hoofdstuk afrondt (nooit korter dan 4 regels en nooit maar één algemene zin) — dit blijft ONDERDEEL van hoofdstuk 1 (managementsamenvatting), nooit een aparte titel of eigen slotpagina — een andere formulering dan voorlopig_oordeel (dat als afsluiting onderaan hoofdstuk 08 — Voorwaarden & documentatie — verschijnt, niet als apart hoofdstuk): benoem kort waarom de aanvraag voldoende aanknopingspunten biedt voor verdere beoordeling én wat de belangrijkste aandachtspunten zijn, zonder de tekst van voorlopig_oordeel te herhalen.
- Juridische structuur: maximaal een halve pagina, toelichting maximaal 5 bullets; activiteiten, verdienmodel & strategie maximaal 6 bullets (historie, activiteiten, omzetstromen, klanten, verdienmodel, strategie) — geen herhaling van de managementsamenvatting. Toon iedere entiteit en iedere persoon maximaal één keer in het structuurschema of organogram; nooit dubbele 100%-labels voor dezelfde relatie.
- Financiële analyse: geen vast paginamaximum van één pagina meer — de financiële analyse moet volledig zijn als de bron dit draagt, compact en overzichtelijk, en mag daarvoor desnoods meer ruimte innemen dan de andere hoofdstukken. Bevat de bron een volledige financiële analyse (balans, resultatenrekening, ratio's), verwerk deze dan volledig en gestructureerd — beperk je nooit tot alleen omzet, resultaat na belasting, liquide middelen en eigen vermogen. Bouw het hoofdstuk op uit twee aparte, overzichtelijke tabellen in plaats van één te brede tabel, elk als een echte, herkenbare financiële staat (activa/passiva resp. kosten/opbrengsten netjes gegroepeerd, subtotalen ONDER hun onderliggende posten, nooit erboven): (1) Balansontwikkeling, Activa eerst dan Passiva — materiële vaste activa (bij voorkeur dit specifieke label, niet de generieke "vaste activa", tenzij de bron alleen die generieke term gebruikt), vlottende activa, liquide middelen, totaal activa; eigen vermogen, langlopende schulden, kortlopende schulden, totaal passiva; (2) Resultatenontwikkeling — omzet/bedrijfsopbrengsten, kosten van grond- en hulpstoffen, personeelskosten/personeelsbeloningen, afschrijvingen, overige bedrijfskosten, (eventueel totaal bedrijfskosten als subtotaal), bedrijfsresultaat, financiële baten en lasten, resultaat voor belasting, belasting, resultaat na belasting. Rijen zijn de posten, kolommen zijn de jaren/periodes die de bron daadwerkelijk vermeldt (historische jaren, prognosejaren en eventueel een structureel jaar na een overgangsfase) — gebruik nooit vaste of verzonnen jaartallen en laat nooit een jaar weg dat de bron voor deze posten geeft. Neem alleen de posten en tabellen op die de bron daadwerkelijk draagt; blijft de bron beperkt tot enkele kerncijfers, toon dan ook alleen die kerncijfers (geen lege rijen verzinnen). Sluit af met 4 tot 6 sterke, feitelijke observatiebullets die minimaal ingaan op: omzetontwikkeling, resultaatontwikkeling, liquiditeitspositie, eigen vermogen, schuldpositie, en (indien van toepassing) de overgangsfase/prognosejaren en wat dit betekent voor de financier. Ratio's (DSCR, Debt/EBITDA, solvabiliteit, rentabiliteit, kasstroom, rente- en aflossingsruimte) en de toelichting op de terugbetaalcapaciteit horen thuis in het hoofdstuk Betaalcapaciteit & ratio's — herhaal ze niet in dit hoofdstuk, om dubbeling te voorkomen; volstaat in de tekst hier met een korte verwijzing als de bron ratio's bevat. Geen grafieken en geen KPI-blokken in dit hoofdstuk. Balansposten (activa/passiva) en winst-en-verliesposten mogen NOOIT door elkaar in dezelfde tabel staan: de balanspost "Eigen vermogen" hoort uitsluitend in Balansontwikkeling, de resultaatpost "Bedrijfsresultaat" uitsluitend in Resultatenontwikkeling — plaats elke post exact één keer, in de tabel waar hij hoort. Meerjarenoverzichten mogen best breed zijn en de tabellen mogen best veel posten bevatten: de renderer kiest voor dit hoofdstuk automatisch een liggende (landscape) pagina zodra dat de leesbaarheid ten goede komt (o.a. bij meer dan 4 jaarkolommen, veel posten, zowel een balans- als een resultatentabel, of een mix van historische en prognose-/structurele jaren) — landscape is hier de voorkeursweergave, geen fallback, dus je hoeft historische of prognosejaren, of posten, nooit weg te laten om een tabel smal te houden.
- Betaalcapaciteit: maximaal één pagina — korte toelichting (maximaal 5 regels), DSCR-tabel per jaar (jaar | situatie | DSCR | toelichting; DSCR altijd als ratio zoals "3,11", NOOIT als eurobedrag), compact Debt/EBITDA of overige kengetallen in dezelfde of een korte tweede tabel, en maximaal 3 interpretatiebullets. Herhaal geen cijfers uit de financiële analyse.
- Risico's: maximaal 5, in één tabel Aandachtspunt | Toelichting | Mitigerende factor / vervolgstap; elk risico heeft altijd een mitigerende factor of vervolgstap, nooit een afwijzende toon; geen aparte lange lijst bancaire aandachtspunten als dezelfde punten al bij voorwaarden staan.
- Voorwaarden voor verdere beoordeling & documentatie (één hoofdstuk, tevens het laatste hoofdstuk van het rapport): één compacte tabel van bij voorkeur 7 tot 8 rijen (MAXIMAAL 8) met de kolommen Onderdeel | Status | Belang voor financier — compact is geen excuus om te mager te blijven: vul, voor zover de bron dit draagt, altijd de relevante standaardonderwerpen in, zoals oprichting/inschrijving van de kredietnemer of vastgoed-B.V., de zakelijke huurovereenkomst tussen vastgoed-B.V. en werkmaatschappij, de vestiging van het (eerste) hypotheekrecht, bewijs van eigen inbreng, onderbouwing van afnemers/omzetverdeling of prognose/omzetgroei, liquiditeitsontwikkeling/-monitoring tijdens een bouw-/overgangsfase, bouwdepot/opnameplanning indien van toepassing, aanvullende zekerheden indien relevant, en gescheiden administratie tussen de entiteiten (geen aparte kolommen Type/Prioriteit, geen lege toelichtingen met "—", en gebruik nooit "voorwaarde", "actiepunt", "op te vragen", "te controleren" en "vervolgvraag" door elkaar voor hetzelfde onderwerp — elk onderwerp komt precies één keer voor. Gebruik per onderwerp de bijbehorende, vaste status ÉN een concrete, onderwerp-specifieke toelichting (nooit bij elke regel dezelfde kale zin "Relevant voor de financieringsbeoordeling"): hypotheekrecht/pandrecht/borgstelling → "Te vestigen" ("Borgt de primaire zekerheid."); huurovereenkomst → "Op te vragen / te ondertekenen" ("Onderbouwt de huurkasstroom."); eigen inbreng → "Te verifiëren" ("Bevestigt beschikbaarheid van de middelen."); liquiditeitsontwikkeling → "Te monitoren" ("Bewaakt tijdelijke druk tijdens de bouwfase."); prognose/omzetontwikkeling → "Te onderbouwen" ("Onderbouwt de structurele betaalcapaciteit."); bouwdepot/opnameplanning/fasering → "Op te vragen" ("Verduidelijkt de opnameplanning."); oprichting/inschrijving van een entiteit → "Te controleren"; gebruik "Nader af te stemmen" alleen als geen van deze onderwerpen van toepassing is. Koppel een status NOOIT aan een onderwerp waar hij niet bij past — bijvoorbeeld "aflossingsvrije periode, te vestigen" of "prognose, te vestigen" zijn altijd fout: een aflossingsvrije periode is geen zekerheid en hoort dus niet bij "Te vestigen", en een prognose hoort bij "Te onderbouwen", nooit bij "Te vestigen". Gebruik voor de documentatie uitsluitend twee compacte blokken — géén andere koppen: "Ontvangen / gebruikt" (bronmemorandum, jaarrekening/aangifte, taxatiegegevens, erfpachtinformatie, prognose-/kasstroominformatie, objectinformatie, bouwdepot-/faseringsoverzicht en overige daadwerkelijk aangeleverde of expliciet in de bron opgenomen stukken — neem hier ALLE stukken op die in de bron als aangeleverd/gebruikt worden genoemd, niet slechts een selectie) en "Nog te controleren / op te vragen" (ontbrekende documenten, definitieve overeenkomsten, bewijs eigen inbreng, zekerheidsstukken, actuele cijfers — alleen wat relevant is voor de financieringsbeoordeling). Nooit interne foutmeldingen of kwaliteitscontrole-taal in deze lijsten (dus nooit dingen als "bronnen en aanwendingen sluiten niet", "kerncijfers niet onderbouwd" of "bronregel staat verkeerd") — dat soort constateringen los je vóór oplevering zelf op in de brondata, ze verschijnen nooit in het externe rapport. Gebruik nooit een aparte kop "Bijlage", "Bijlage(n)" of "Contactgegevens" in dit hoofdstuk.
- Financieringssamenvatting: GEEN apart hoofdstuk en GEEN losse laatste pagina — plaats deze als afsluiting onderaan ditzelfde hoofdstuk (08, na de documentatieblokken), 5 tot 7 regels, geen hard oordeel (zie CONCLUSIEBELEID). Dit is de inhoudelijke afsluiting van het hele rapport: eindig niet abrupt en niet leeg. Kantoor/adviseur en rapportdatum staan al op de cover en in de paginafooter — herhaal deze niet als apart contactblok.
- Cover/klantnaam en kredietnemer: bepaal de kredietnemer strikt volgens de bron (zie ook de klantnaam-instructie hieronder bij RAPPORTTYPE B — de cover toont de gekozen dossierpartij, niet automatisch een gecombineerde naam). Noemt de bron een vastgoed-B.V. (eventueel i.o.) als beoogde kredietnemer/vastgoedhouder en de werkmaatschappij als huurder, gebruik dan NOOIT een formulering waarbij de werkmaatschappij als kredietnemer wordt weergegeven — verwijs ernaar met hun juiste, specifieke rol: "de vastgoed-B.V." (koopt/houdt het object, verhuurt het zakelijk) resp. "de werkmaatschappij" (exploiteert de operationele activiteiten, huurt het object van de vastgoed-B.V.) — schrijf dit nooit omgekeerd (de vastgoed-B.V. exploiteert of drijft nooit de onderneming, de werkmaatschappij koopt of verhuurt nooit het object). Noem een partij ALLEEN "kredietnemer", "mede-kredietnemer", "hoofdkredietnemer", "hoofdelijk schuldenaar" of "borgsteller" als dat exact zo (of ondubbelzinnig gelijkwaardig) uit de bron blijkt — gebruik deze termen nooit automatisch of als aanname, ook niet voor de kredietnemer zelf als de bron een andere aanduiding gebruikt. Gebruik voor overige/secundaire partijen in plaats daarvan de neutrale, feitelijke rol: "betrokken partij", "vastgoedvennootschap", "werkmaatschappij", "holding", "huurder", "aandeelhouder", of "aanvullende zekerheid indien gewenst door financier". Is een kredietnemersrol niet expliciet in de bron onderbouwd, gebruik dan een neutrale formulering in de trant van: "De hypothecaire financiering wordt aangevraagd voor aankoop van het bedrijfspand via de vastgoed-B.V. Betrokken groepsmaatschappijen worden meegenomen voor huurkasstroom, structuur en eventuele aanvullende zekerheden." of, bij een vastgoedstructuur met holding/werkmaatschappij: "Financiering voor aankoop bedrijfspand via de vastgoed-B.V., met de werkmaatschappij als gebruiker/huurder en de holding als aandeelhouder." Schrijf NOOIT een opsomming als "via [Naam1], [Naam2] en [Naam3]" die de indruk wekt dat alle genoemde entiteiten gezamenlijk kredietnemer zijn — noem in plaats daarvan elke entiteit met haar eigen, specifieke rol (vastgoedvennootschap/werkmaatschappij/holding/huurder/aandeelhouder) zoals hierboven.
Kernonderdelen (financiële analyse, betaalcapaciteit, risico's, financieringssamenvatting, documentatie) mogen compact zijn of gecombineerd worden, maar mogen nooit volledig verdwijnen als de bron er inhoud voor biedt. Kort hoofdstukken in vóórdat je ze schrapt — het rapport moet korter zijn dan de bron, maar niet inhoudelijk leeg. Geen enkel klein inhoudelijk punt mag twee keer in het rapport voorkomen: is de financieringsduiding feitelijk al in de kernboodschap benoemd, herhaal hem dan niet nogmaals elders; is een aandachtspunt over management al bij de betrokken partijen genoemd, herhaal het niet als losse managementregel; is een aflossingsvoorwaarde al in de financieringstabel of bouwdepottekst verwerkt, zet hem niet ook nog los bij de voorwaarden; is een zekerheidsvoorwaarde al bij zekerheden benoemd, herhaal hem niet nogmaals bij documentatie; en is een risico al in de risicomatrix opgenomen, noem het niet nogmaals als apart aandachtspunt elders. Schrijf elk klein feit één keer, op de plek waar het inhoudelijk het beste past.

RAPPORTTYPEKEUZE — OP BASIS VAN COMPLEXITEIT, NIET VAN BRONLENGTE
Bepaal vóór het schrijven welk rapporttype nodig is (metadata.rapport_type):
- "compact_intake" (= rapporttype A): eenvoudige financieringen — financial lease, bedrijfsmiddelen-, machine- of voertuigfinanciering, relatief kleine aanvraag, geen vastgoedfinanciering, geen bedrijfsovername, beperkte broninformatie, geen uitgebreide prognose of kasstroomanalyse. De financieringsvraag is vooral bedoeld om documenten en uitgangspunten overzichtelijk te presenteren.
- "volwaardig_financieringsmemorandum" (= rapporttype B): complexere financieringen — vastgoedfinanciering, aankoop bedrijfspand, overname, herfinanciering, financiering met meerdere entiteiten (vastgoed-B.V./holding/werkmaatschappij), sources & uses met eigen inbreng, prognoses/DSCR/Debt-EBITDA beschikbaar, hypotheekrecht/verpanding/borgstelling/hoofdelijke aansprakelijkheid als zekerheid, of een substantiële aanvraag — óók als de bron zelf kort is.
- "luxe_samenvatting": alleen bij een zeer lange, herhalende bron waarvoor de adviseur expliciet een compactere bankversie vraagt; volgt verder de structuur en limieten van rapporttype B.
De bronlengte bepaalt dus NIET het type: een korte bron over een vastgoedaankoop is rapporttype B; een lange bijlagenbundel bij een eenvoudige lease blijft rapporttype A. Kort alleen in wat dubbel, wollig of niet-besluitvormingsrelevant is; laat omgekeerd niets kunstmatig groeien: secties zonder brondata blijven leeg.

SECTIESELECTIE — ALLEEN WAT DE BRON DRAAGT
Vul geen sectie voor onderwerpen die niet werkelijk in de bron staan: geen financiële analyse zonder cijfers; geen betaalcapaciteit zonder kasstroom, DSCR of rente-/aflossingsgegevens; geen marktsectie als de bron alleen operationele activiteiten noemt; geen object-/vastgoedsectie als vastgoed slechts zijdelings als bestaande zekerheid voorkomt; geen privésectie zonder relevante privéanalyse; geen lange conclusie zonder data. Laat zulke velden en arrays leeg. Maak nooit inhoud die alleen uit "niet opgenomen in bron" bestaat; ontbrekende maar relevante onderdelen benoem je kort als controlepunt (coverage_check.waarschuwingen) of vervolgvraag. Voeg geen standaardtekst toe om een sectie te vullen: het rapport moet mooier zijn dan de bron, niet langer dan de bron rechtvaardigt.
Sectieteksten (tekst-velden): volledige, afgeronde alinea's, zo lang als de broninhoud rechtvaardigt (typisch 60-300 woorden per veld). Gebruik lege regels tussen alinea's. Schrijf ALTIJD volledige zinnen; breek nooit een zin af en eindig nooit met "..." of "…". Tabellen: alle relevante rijen uit de bron (tot 24 per tabel). Bullets: tot 10 per lijst, alleen met echte informatie. Dit geldt EXTRA streng voor managementsamenvatting.kernboodschap en elk ander doorlopend tekstveld: is de brontekst zelf een afgebroken zin, een OCR-fragment of een onvolledig afgekapte passage (bijv. "...groeit naar € 590.000 in 2028" zonder duidelijk begin, of een zin die halverwege een getal of woord ophoudt), neem die dan NOOIT letterlijk zo over. Herschrijf het feitelijk correct en volledig in een eigen, grammaticaal kloppende zin op basis van de onderliggende feiten (het bedrag, het jaar, de strekking) — de cijfers en feiten blijven leidend en waarheidsgetrouw, alleen de zinsconstructie wordt hersteld tot een complete zin met onderwerp, werkwoord en punt. Een kernboodschap met een afgebroken of grammaticaal onvolledige zin is niet acceptabel, ook niet als de bron zelf zo'n fragment bevat.

SECTIES (vul alleen wat de bron ondersteunt)
- managementsamenvatting: bij rapporttype B mag dit hoofdstuk een volle pagina beslaan (zie de uitgebreide eisen hierboven bij RAPPORTTYPE B — STRUCTUUR: 180-250 woorden, kpi_cards met minimaal 8 kerncijfers, belangrijkste_sterktes, aandachtspunten en financieringsduiding); bij rapporttype A blijft de kernboodschap maximaal 150 woorden (korte omschrijving onderneming, doel financiering, financieringsbehoefte). Het veld voorlopig_oordeel wordt in het rapport getoond als "Financieringssamenvatting" (als afsluiting onderaan het laatste hoofdstuk — Voorwaarden & documentatie — nooit als apart hoofdstuk of losse laatste pagina): schrijf het als financieringsgerichte samenvatting, NIET als kredietoordeel — bijv. "De aanvraag biedt voldoende aanknopingspunten voor verdere beoordeling door financiers. De combinatie van eigen inbreng, beschikbare zekerheden, positieve historische resultaten en onderbouwde prognose vormt de basis voor het opvragen van passende financieringsvoorstellen. De belangrijkste aandachtspunten zijn …" — financieringsduiding is een kortere, andersluidende afsluiting van hoofdstuk 01 zelf en mag hier nooit een kopie van zijn.
- aanvraag_en_transactie: aanleiding, financieringsdoel, investering, timing en gewenste structuur. Vul het veld besluitvormingsvraag met het "Doel van de aanvraag": één financieringsgerichte zin in de vorm "Het opvragen van financieringsvoorstellen voor …" — nooit een interne besluitvormings- of kredietvraag.
- juridische_structuur: alle betrokken rechtspersonen en privépersonen (rol, rechtsvorm, KvK) — neem ELKE partij op die in de bron een rol heeft (kredietnemer, vastgoedhouder, holding, werkmaatschappij/huurder, privépersoon/UBO, mede-kredietnemer, borg), nooit alleen de formele kredietnemer terwijl bijvoorbeeld de operationele werkmaatschappij (huurder) wordt weggelaten. Vul het veld kvk UITSLUITEND met een daadwerkelijk KvK-nummer uit de bron; is dat er niet, laat kvk dan leeg — zet er NOOIT een oprichtingsdatum, geboortedatum of andere datum in die kolom. De partijentabel moet ALTIJD volledig zijn: neem, voor zover in de bron aanwezig, minimaal op — de kredietnemer/vastgoedhouder, de holding/aandeelhouder, de werkmaatschappij/huurder én de UBO/bestuurder — elk met de juiste, specifieke rol (nooit een generieke of dubbelzinnige rolomschrijving). Is voor een entiteit (bijv. een B.V. i.o.) nog geen KvK-nummer bekend, of gaat het om een privépersoon zonder KvK, laat het veld kvk dan gewoon leeg (het rapport toont dit vanzelf als "-") — dit is normaal en geen fout. Vul kvk NOOIT met een verzonnen tekst als "onbekend", "n.v.t.", "niet van toepassing" of "nog niet bekend": laat het veld in die gevallen altijd leeg. Noem een partij alleen "opgericht op [datum]" als die exacte datum letterlijk in de bron staat — een entiteit i.o. (in oprichting) heeft per definitie nog GEEN oprichtingsdatum, dus claim er nooit een bij. Gebruik de termen "kredietnemer", "hoofdkredietnemer" en "mede-kredietnemer" uitsluitend als de bron een partij letterlijk zo aanduidt; noem een partij anders bij haar functionele rol (bijv. "vastgoedhouder", "werkmaatschappij/huurder"). Voor een entiteit die nog moet worden opgericht, gebruik een neutrale, feitelijke formulering zonder gefingeerde datum of rol, bijvoorbeeld: "Matvastgoed B.V. is de nieuw op te richten vastgoedvennootschap die het pand zal houden en verhuren aan de werkmaatschappij." — dit format is illustratief, gebruik nooit deze placeholder-naam zelf. bestuur en tekenbevoegdheid, aandeelhouders/UBO's. Vul structuur_tekstueel ALTIJD met een compact tekstueel structuurschema: korte, feitelijke bulletzinnen, één relatie per regel, met de daadwerkelijke namen uit de bron (bijv. "[Naam bestuurder] is uiteindelijk belanghebbende.", "[Holding B.V.] houdt 100% van de aandelen in [Werkmaatschappij B.V.].", "[Vastgoed B.V.] i.o. koopt en verhuurt het bedrijfspand zakelijk aan [Werkmaatschappij B.V.].") — dit format is illustratief, gebruik nooit deze placeholder-namen zelf. Dit is de weergave in het rapport wanneer geen net organogram mogelijk is.
- ORGANOGRAMMEN: als de bron een organogram, structuurplaatje of groepsstructuur bevat (bestaand en/of nieuw), reconstrueer die VOLLEDIG in organogram_bestaand / organogram_nieuw: aanwezig=true; titel; entiteiten met uniek kort id (bijv. "e1"), naam, type (privepersoon | holding | werkmaatschappij | vastgoed_bv | stak | in_oprichting | overig) en rol (bijv. "Kredietnemer", "Vastgoedhouder", "Zekerheidssteller" — gebruik "Mede-kredietnemer", "Hoofdelijk schuldenaar" of "Borgsteller" uitsluitend als dat exact zo uit de bron blijkt, nooit als aanname); relaties van eigenaar ("van") naar deelneming ("naar") met label voor het percentage of de relatie (bijv. "100%", "60%", "certificaten"). Een structuurplaatje uit de bron mag NOOIT verdwijnen. Bevat de bron een organogram of een eenduidig beschreven aandelenstructuur, dan is een gereconstrueerd organogram (aanwezig=true) of een volledig gevuld structuur_tekstueel VERPLICHT — het rapport mag nooit zonder structuurweergave verschijnen. Een structuur die alleen in tekst beschreven staat mag je ook zo reconstrueren. Reconstrueer alleen wat eenduidig uit de bron volgt: geen dubbele of tegenstrijdige percentages, geen onduidelijke blokken. Regels voor een net organogram: toon iedere persoon of entiteit maximaal één keer, toon percentages slechts één keer per relatie, geen dubbele 100%-labels of dubbele blokken. Is de structuur te onduidelijk voor een net organogram, laat aanwezig dan op false — het rapport toont dan het tekstuele structuurschema (structuur_tekstueel). Een helder tekstueel structuurschema is beter dan een rommelig organogram. Bevat de bron zowel een bestaande als een nieuwe structuur (bijv. vóór en ná toevoeging van een vastgoed-B.V.), reconstrueer dan waar mogelijk BEIDE afzonderlijk in organogram_bestaand en organogram_nieuw — deze twee schema's worden in het rapport automatisch naast elkaar getoond, mits beide schema's elk voor zich net en eenduidig zijn. Geef elk schema de vaste, herkenbare titel "Structuur huidig" en "Structuur na wijziging" (gebruik geen andere of variabele titels, ook niet als de wijziging een specifieke toevoeging betreft) en een toelichting van maximaal één zin die als onderschrift dient (bijv. "Bestaande structuur met [Holding] als houdstermaatschappij van [Werkmaatschappij]." / "Nieuwe structuur waarbij [Vastgoed-B.V.] als vastgoedvennootschap wordt toegevoegd en optreedt als beoogd kredietnemer."). Is slechts één van beide structuren betrouwbaar en net te reconstrueren (de andere zou dubbele/tegenstrijdige percentages, dubbele entiteiten of onduidelijke blokken opleveren), reconstrueer dan ALLEEN die ene (aanwezig=true) en zet de andere op aanwezig=false — het rapport toont dan automatisch nog maar één schema, gecentreerd. Is geen van beide betrouwbaar genoeg, zet dan beide op aanwezig=false en gebruik uitsluitend structuur_tekstueel. Bij een eenvoudige leaseaanvraag (rapporttype A) heeft een tekstueel schema altijd de voorkeur boven een visueel organogram.
- activiteiten_onderneming: historie, bedrijfsactiviteiten, verdienmodel, strategie, omzetstromen, operationele aandachtspunten.
- markt_en_omgeving: marktpositie, concurrentie, trends, afnemers, leveranciers, afhankelijkheden, seizoenspatroon, debiteuren-/crediteurenrisico.
- management_en_organisatie: ondernemer(s) en team met rol en achtergrond/ervaring, externe adviseurs, KPI's/rapportages.
- financieringsopzet: kerncijfers, bronnen en aanwendingen, bestaande én nieuwe faciliteiten met condities, bouwdepot/fasering, btw-aspecten, voorwaarden. Vul kerncijfers zo volledig mogelijk voor de cover: gevraagde financiering, totale investering, eigen inbreng (en herkomst), looptijd, rente, aflossingsstructuur (incl. aflossingsvrije periode en start aflossing) en LTV bij vastgoed. Benoem condities kort in de tekst: hoofdsom, rente, looptijd, aflossing, bouwdepot/fasering indien relevant. Bronnen en aanwendingen moeten EXACT op elkaar aansluiten: de som van alle aanwendingsposten (of de totaalregel) moet precies gelijk zijn aan de som van alle bronposten én aan kerncijfers.totale_investering — nooit een verschil laten staan en nooit een btw-post laten wegvallen om op een ronder totaal uit te komen. Gebruik bij voorkeur deze volgorde en posten aan de aanwendingenkant, zonder dat losse componenten en een samenvattende regel dezelfde kosten dubbel tellen: "Koop- en aanneemsom", "Btw over koop- en aanneemsom" (indien van toepassing), "Bijkomende kosten" (of de losse componenten zoals notaris-, taxatie-, advies- en financieringskosten), "Btw over bijkomende kosten", "Totale investering" als totaalregel. Toon nooit een subtotaal dat posten dubbel of onvolledig telt: kies óf de samenvattende regel óf de losse componenten, nooit beide naast elkaar voor hetzelfde bedrag.
- object_en_vastgoed: adres, type object, oppervlakte, taxatiewaarde en taxatiedatum, energielabel, erfpacht, gebruik/verhuur, LTV — als kenmerken-rijen {label, waarde}.
- financiele_analyse: historische cijfers én prognose — neem ELK jaar op dat de bron voor financiële posten vermeldt, historisch én prognose; laat nooit een jaar volledig weg alleen om het rapport korter te maken — dat is kernwaarheid, geen opvulling die onder een paginabudget mag sneuvelen. resultaten en balans als rijen {label, periode, bedrag}; gebruik consistente labels per periode zodat er een tabel per jaar van te maken is (bijv. label "Omzet" met periode "2024"). Prognosejaren markeren met "(prognose)" in de periode, en een structureel jaar na een eventuele bouw-/overgangsfase duidelijk herkenbaar laten (bijv. "2028 (structureel)"). Bevat de bron een volledige financiële analyse, neem dan VOLLEDIG en gestructureerd op — niet alleen de kerncijfers omzet, resultaat na belasting, liquide middelen en eigen vermogen: balans met (voor zover aanwezig) vaste activa, vlottende activa, liquide middelen, totaal activa, eigen vermogen, langlopende schulden, kortlopende schulden en totaal passiva; resultaten met (voor zover aanwezig) omzet, bedrijfsopbrengsten, kosten van grond- en hulpstoffen, personeelsbeloningen, afschrijvingen, overige bedrijfskosten, bedrijfsresultaat, financiële baten en lasten, resultaat voor belasting, belasting en resultaat na belasting — geef deze kostensoorten apart weer zoals de bron ze presenteert en vat ze nooit samen tot één generieke post "Kosten" als de bron ze uitsplitst. Gebruik voor de kernposten bij voorkeur EXACT deze labels, zodat het rapport ze herkent en netjes groepeert: balans — "Materiële vaste activa" (of "Vaste activa" als de bron geen onderscheid maakt), "Vlottende activa", "Liquide middelen", "Totaal activa", "Eigen vermogen", "Langlopende schulden", "Kortlopende schulden", "Totaal passiva"; resultaten — "Omzet", "Bedrijfsopbrengsten", "Kosten van grond- en hulpstoffen", "Personeelsbeloningen", "Afschrijvingen", "Overige bedrijfskosten", "Totaal bedrijfskosten" (optionele subtotaalregel, alleen als de bron dit als apart totaal geeft — nooit naast de losse kostenposten tellen als de bron geen expliciet subtotaal geeft), "Bedrijfsresultaat", "Financiële baten en lasten", "Resultaat voor belasting", "Belasting", "Resultaat na belasting" — gebruik "Kosten" alleen nog als de bron de kosten niet verder uitsplitst. Markeer totaal-, subtotaal- en saldoregels (zoals "Totaal activa", "Totaal passiva") herkenbaar met exact dat label, zodat deze in het rapport als totaalregel getoond kunnen worden. Bevat de bron een verdere onderverdeling van een kernpost (bijv. materiële/immateriële/financiële vaste activa, of een specifieke kostensoort), neem die dan op als extra, apart gelabelde rij mét het eigen brondetail-label, naast (niet in plaats van) de samengevatte hoofdpost als de bron beide niveaus vermeldt — zo'n detailregel wordt in het rapport automatisch als aanvullende rij getoond en gaat nooit verloren. Bevat de bron alleen enkele kerncijfers (geen volledige balans/resultatenrekening), neem dan ook alleen die kerncijfers op — verzin nooit ontbrekende posten of lege rijen om de tabel voller te laten lijken. Vul observaties met 4 tot 6 sterke, feitelijke observaties die minimaal ingaan op: omzetontwikkeling, marge/resultaatontwikkeling, ontwikkeling eigen vermogen, liquiditeitspositie, schuldpositie, en (indien van toepassing) de tijdelijke impact van een bouw-/overgangsfase, het structurele jaar en de betekenis daarvan voor de financier. Elke observatie noemt een concreet cijfer, bedrag of percentage uit de tabellen (bijv. "de omzet groeit van € 78.510 in 2024 naar € 210.000 in het structurele jaar 2028") — een observatie zonder cijfermatige onderbouwing is niet toegestaan. Controleer bij elke observatie dat de gebruikte trendrichting (stijgt/groeit/neemt toe versus daalt/neemt af) daadwerkelijk klopt met de genoemde cijfers: schrijf NOOIT "stijgt van € X naar € Y" als € Y lager is dan € X (of omgekeerd "daalt" als Y hoger is dan X) — dat is een rekenfout die de geloofwaardigheid van het hele rapport ondermijnt. Is er een dip in een tussenliggend jaar (bijv. door een bouw-/overgangsfase) gevolgd door herstel, beschrijf dat dan expliciet zo, bijvoorbeeld: "het resultaat na belasting ligt in de prognosejaren lager dan de sterke historische jaren, maar herstelt van € 12.870 in 2026 naar € 28.948 in 2028" — in plaats van één enkele stijgt/daalt-claim over de hele periode die de tussenliggende cijfers tegenspreekt. Vul ratios (DSCR, Debt/EBITDA, solvabiliteit, rentabiliteit, kasstroom, rente- en aflossingsruimte) als de bron dit draagt; deze kengetallen worden in het rapport getoond in het hoofdstuk Betaalcapaciteit & ratio's (samen met betaalcapaciteit.kengetallen, zonder dubbeling) — herhaal ze daarom niet nogmaals als aparte tabel in de financiële-analysetekst zelf. BELANGRIJK — nooit hetzelfde bedrag verzinnen voor verschillende posten: omzet, bedrijfsopbrengsten, kosten, bedrijfsresultaat, financiële baten en lasten, resultaat voor belasting, belasting, resultaat na belasting, vaste activa, vlottende activa, liquide middelen, totaal activa, eigen vermogen, langlopende schulden, kortlopende schulden en totaal passiva zijn voor elk jaar in beginsel afzonderlijke, wezenlijk andere bedragen. Bevat de bron voor een bepaald jaar geen gegevens voor een bepaalde post, laat die rij dan voor dat jaar gewoon WEG in plaats van een ander cijfer te herhalen of te kopiëren naar die post — een lege/ontbrekende post is altijd beter dan een gefabriceerd of gedupliceerd bedrag. Komen twee posten met exact hetzelfde bedrag in hetzelfde jaar voor in de bron (bijv. resultaat na belasting dat toevallig gelijk is aan de liquide middelen, of bedrijfsresultaat dat gelijk is aan resultaat voor belasting bij nihil financiële baten/lasten), dan is dat een legitieme samenloop — neem BEIDE cijfers gewoon over zoals de bron ze vermeldt; laat nooit een cijfer weg of vervang het door een streepje alleen omdat het toevallig gelijk is aan een ander cijfer. Dit geldt ook voor bedragen van € 0 (bijv. geen financiële baten/lasten of geen belasting in een jaar): een echte nul uit de bron blijft gewoon staan als 0, ook als andere posten toevallig ook 0 zijn. Alleen bij drie of meer wezenlijk verschillende posten met exact hetzelfde (niet-nul) bedrag in hetzelfde jaar is voorzichtigheid op zijn plaats: controleer dan of dat werkelijk zo in de bron staat, en neem anders alleen de post over die de bron daadwerkelijk vermeldt. Toon nooit een streepje in de financiële tabel voor een post waarvan het bedrag wél in de bron staat. Controleer specifiek nogmaals afschrijvingen, overige bedrijfskosten, totaal bedrijfskosten, bedrijfsresultaat, resultaat voor belasting en resultaat na belasting per jaar tegen de bron: verschuif nooit een bedrag naar een ander jaar, trek een bedrag nooit zelf door naar een jaar waarvoor de bron geen cijfer geeft, en dupliceer nooit een bedrag van het ene jaar naar het andere als de bron voor dat andere jaar een ander bedrag vermeldt.
- betaalcapaciteit: historische en genormaliseerde betaalcapaciteit, correcties, privéonttrekkingen/privébehoefte, rente- en aflossingsverplichtingen, DSCR, Debt/EBITDA, overgangsjaar versus structurele situatie. Tabel als {label, periode, bedrag}; DSCR/Debt-EBITDA als kengetallen-rijen. Vul daarnaast dscr_overzicht met één rij per (prognose)jaar: jaar, situatie (bijv. "Bouwfase, alleen rente", "Overgangsjaar", "Structurele situatie"), dscr als ratio met de decimalen exact uit de bron (bijv. "3,11" — nooit een eurobedrag) en een korte financieringsgerichte toelichting (bijv. "Ruime rentedekking", "Tijdelijke druk door dubbele lasten, verklaarbaar", "Herstel na wegvallen externe huur"). Laat dscr_overzicht leeg als de bron geen DSCR bevat. Geef DSCR per prognosejaar met de situatie erbij (bijv. "2026 — bouwfase, alleen rente", "2027 — overgangsjaar, tijdelijke druk door dubbele lasten", "2028 — structurele situatie") en sluit af met een expliciete kwalificatie van de betaalcapaciteit: ruim voldoende, voldoende, tijdelijk krapper maar verklaarbaar, of afhankelijk van realisatie van de prognose — uitsluitend onderbouwd door broncijfers en zonder harde negatieve kwalificatie.
- inkomen_vermogen_prive: alleen indien de bron dit bevat: inkomen ondernemer, partnerinkomen, woningwaarde, hypotheek, vermogen, privébehoefte — als posten {label, waarde} — plus relevantie voor de financiering.
- zekerheden_en_risico: alle zekerheden met waarde en status, dekkingspositie, volledige risicomatrix (elk risico met kans, impact en mitigant), bancaire aandachtspunten. Neem het juridische zekerheidslabel EXACT over uit de bron: maak van hoofdelijke aansprakelijkheid nooit een borgstelling en omgekeerd; maak van een mogelijke of "indien nodig aan te reiken" zekerheid nooit een definitief gevestigde zekerheid. status: volg de bron en gebruik één van — "gevestigd", "bestaand", "te vestigen", "aangeboden", "aanvullend aan te bieden", "nog te formaliseren", "voorwaardelijk", "nog te controleren", of leeg indien onbekend. De standaardvocabulaire voor een NIEUWE zekerheid die nog niet is gevestigd is: "te vestigen" (nog te vestigen zekerheidsrecht), "nader te formaliseren" (juridisch nog vast te leggen), "aanvullend aan te bieden" (mogelijke extra zekerheid), "indien door financier vereist" (voorwaardelijk op de financier). Schrijf NOOIT "aan te reiken" in de output — gebruik "aanvullend aan te bieden", "mogelijk aanvullend te vestigen", "nader te bepalen" of "indien door financier gewenst". Schrijf nooit "gevestigd" als de zekerheid nog niet daadwerkelijk gevestigd is (bijv. bij de aankoop van een nieuw bedrijfspand is het eerste hypotheekrecht per definitie nog NIET gevestigd, ook niet als het rapport het als "primaire zekerheid" beschrijft) — gebruik dan "te vestigen", "nader te formaliseren", "voorwaarde voor financiering" of "indien door financier vereist". Voor een NIEUW eerste hypotheekrecht gebruik je in de tekst ALTIJD de formulering "te vestigen eerste hypotheekrecht" met status "te vestigen" — gebruik NOOIT "nog aan te vestigen" en NOOIT "op te richten eerste hypotheekrecht" (een hypotheekrecht wordt gevestigd, nooit "opgericht"). Schrijf ook nooit een harde afsluitende conclusie zoals "de zekerheid dekt volledig" of "solide zekerheden" als samenvattend hard oordeel over de dekkingspositie; gebruik in plaats daarvan een afgewogen formulering zoals "De zekerheidstelling biedt een duidelijke basis voor verdere beoordeling, waarbij definitieve vestiging van het eerste hypotheekrecht en eventuele aanvullende zekerheden nog moeten worden afgestemd." Bestaande zekerheden (van een lopende financiering) gelden niet automatisch ook voor de nieuwe aanvraag, tenzij de bron dat expliciet zo zegt. Hoofdelijke aansprakelijkheid is GEEN te vestigen zekerheidsrecht (zoals een hypotheekrecht) — schrijf daarom nooit "hoofdelijke aansprakelijkheid te vestigen" of status "Te vestigen" ervoor; gebruik in plaats daarvan "eventuele hoofdelijke aansprakelijkheid / borgstelling nader af te stemmen" met status "Nader af te stemmen", en neem dit alleen op als de bron dit noemt of als het als mogelijke aanvullende zekerheid wordt benoemd. Marktwaarde/WOZ-waarde, hypotheekschuld en overwaarde zijn aparte gegevens. Bij een tweede hypotheek op de privéwoning als aanvullende zekerheid geldt: gebruik als zekerheidswaarde ALTIJD de beschikbare overwaarde (marktwaarde of WOZ-waarde minus de bestaande hypotheekschuld) — gebruik NOOIT de bestaande hypotheekschuld zelf als zekerheidswaarde. Vermeldt de bron marktwaarde/WOZ-waarde én hypotheekschuld maar geen expliciete overwaarde, bereken de overwaarde dan als marktwaarde/WOZ-waarde minus hypotheekschuld en markeer dit in de toelichting als "berekend op basis van bronregels". Deze tweede hypotheek krijgt status "aanvullend aan te bieden" (nooit "gevestigd"). Voorbeeld vastgoed: "De primaire zekerheid bestaat uit een eerste hypotheekrecht op het bedrijfspand. Een tweede hypotheek op de privéwoning is in de bron genoemd als aanvullend aan te bieden zekerheid indien door de financier gewenst." Voorbeeld lease: "Voor de nieuwe lease wordt verpanding van de te financieren bedrijfsmiddelen genoemd. Bestaande hypotheek- en borgstellingszekerheden zijn opgenomen als context bij bestaande financieringen en gelden niet automatisch als zekerheid voor de nieuwe lease, tenzij de bron dit expliciet vermeldt." Formuleer de dekkingspositie nooit positiever dan de bron toelaat wanneer aanvullende zekerheden nog niet definitief zijn. Schrijf nooit "de zekerheid dekt de lening volledig", "wordt gedekt door" of "zekerheid is aanwezig" als kale, harde claim; formuleer voorzichtiger, bijv. "De primaire zekerheid bestaat uit een eerste hypotheekrecht op het object. De LTV bedraagt circa X% op basis van de taxatiewaarde." Gebruik voor de zekerheidstelling bij voorkeur formuleringen als "ondersteund door een te vestigen eerste hypotheekrecht", "onder voorbehoud van definitieve vestiging en acceptatie door financier" en "aanvullend aan te bieden indien gewenst door financier". Sluit de dekkingspositie waar passend af met een nuancerende zin die de strekking "onder voorbehoud van definitieve vestiging en acceptatie door financier" bevat. Maak in de tekst altijd onderscheid tussen bestaande zekerheden, te vestigen zekerheden en aanvullende mogelijke zekerheden; schrijf nooit "gevestigd" als een recht nog niet definitief gevestigd is — gebruik dan "te vestigen" of "voorwaarde voor financiering".

BRONNEN EN AANWENDINGEN
Neem de tabel letterlijk uit de bron over. Bronnen = waar het geld vandaan komt (hypothecaire/bancaire lening, eigen inbreng, achtergestelde lening, vendor loan, subsidie, btw-financiering). Aanwendingen = waar het geld naartoe gaat (koop-/aanneemsom, btw, notaris, taxatie, financierings- en advieskosten, onvoorzien, werkkapitaal, herfinanciering). Eigen inbreng of een lening hoort niet onder aanwendingen; een koop-/aanneemsom of kosten koper hoort niet onder bronnen — wijkt de bron hiervan af, volg dan de bron en neem een controlepunt op. Bouwdepottermijnen tellen niet mee als bron (regel 8). Als de bron sluit (investering = financiering), moeten jouw totalen exact gelijk zijn; sluit de bron zelf niet, benoem het verschil dan in een toelichting. Markeer totaal-, subtotaal- en saldoregels (zoals "Totaal investering", "Totale financiering", "Totaal bronnen", "Financieringsbehoefte", "Subtotaal", "Eindtotaal") met totaalregel=true: een totaalregel is nooit een detailpost en telt nooit mee in een optelling. Staat er een brontotaal, gebruik dan dat brontotaal en bereken geen nieuw totaal daarbovenop; alleen als de bron géén totaal geeft mag je detailregels optellen, met "berekend op basis van bronregels" in de toelichting.

DATUMREGELS
metadata.documentdatum: de datum van het brondocument zelf (voorblad, "opgesteld op", documentmetadata) in Nederlandse notatie; leeg als die niet vaststaat. metadata.rapportdatum: de datum van dít rapport — gebruik de actuele datum. Gebruik NOOIT een geboortedatum, oprichtingsdatum of taxatiedatum als document- of rapportdatum. Bij twijfel: documentdatum leeg laten en toelichten in datum_toelichting.

AFBEELDINGEN UIT DE BRON
Je kunt beeldmateriaal uit een PDF niet als afbeelding opnieuw aanleveren. Registreer daarom elk relevant beeld (rendering, objectfoto, plattegrond, bouwplanning, grafiek, schema) in bronrapport.gevonden_afbeeldingen met een korte, concrete omschrijving. Organogrammen reconstrueer je als data (zie boven). Feitelijke informatie die alleen in beelden staat (adres op een rendering, oppervlaktes op een plattegrond) verwerk je in de betreffende sectie als tekst of kenmerk.

SCHRIJFSTIJL
Zakelijk Nederlands in Credion-stijl: helder, professioneel, adviserend, bancair. Korte alinea's, duidelijke bullets. Geen marketingtaal, geen superlatieven, geen wollige AI-taal, geen onnodig juridisch jargon. Behoud de nuance uit de bron; verbeter de taal waar de bron wollig of herhalend is. Het rapport moet voelen alsof een ervaren financieringsadviseur het heeft opgesteld. Schrijf uitsluitend Nederlands: geen Engelse restwoorden zoals "expected", "fluctuations", "report", "source" of "business case" — gebruik "verwacht", "schommelingen", enzovoort. Verboden in de output: "undefined", "null", "NaN", "deelnemers wordt aanbevolen", "goedgekeurd de aanvraag", "verifiren" (schrijf "verifiëren"), "Risicos" (schrijf "risico's"), "continuiteit" (schrijf "continuïteit"), "Realizatie" (schrijf "realisatie"), "be%C3%AFnvloedt" of andere URL-encoded tekens in lopende tekst (schrijf "beïnvloedt" — dit duidt op een encoderingsfout), "privgedeelte" (schrijf "privégedeelte"), "formaliteren" (schrijf "formaliseren"), "persoonlijke borgstelling" als de bron alleen hoofdelijke aansprakelijkheid noemt, "volledig in gebruik" bij nieuwbouw als de bron een latere oplevering noemt. Verboden restteksten en taalfouten: "Risicomatrix met mitigatie: 1" of vergelijkbare kop-plus-cijfer-restanten (schrijf de kop zonder los cijfer), "betrouwdheid" (schrijf "betrouwbaarheid"), "geprognotciseerd" (schrijf "geprognosticeerd"), "privéswoning" (schrijf "privéwoning"), "mitigaties zijn aanwezig" als inhoudsloze restzin (benoem de mitigant concreet in plaats van deze lege zin). Verboden bij zekerheden: "nog aan te vestigen" (schrijf "te vestigen"), "op te richten eerste hypotheekrecht" (schrijf "te vestigen eerste hypotheekrecht"), "zekerheid dekt volledig" (schrijf een afgewogen formulering met "onder voorbehoud van definitieve vestiging en acceptatie door financier"). Meer taalcorrecties: "Privepersoon" (schrijf "Privépersoon"), "wordt beïnvloedt" (schrijf "wordt beïnvloed"), "rente betalingen" (schrijf het samengesteld: "rentebetalingen"), "overgangsjaar gesloten financiering" (onduidelijke restzin — schrijf in plaats daarvan iets in de trant van "tijdelijk verhoogd door de bouw- en overgangsfase"), "juridische formele aspecten" (schrijf "juridische formaliteiten"). Beschrijf de aflossingsvorm altijd exact zoals de bron die presenteert (bijv. "aflossingsvrij [periode uit de bron], daarna reguliere aflossing"); neem NOOIT aan dat de aflossing annuïtair is tenzij de bron dit woord expliciet gebruikt. GEEN PRIVACYWAARSCHUWINGEN: neem nooit een zin op als "Privacygevoelige gegevens van privépersonen en achterliggende vennootschappen zijn opgenomen" of vergelijkbare privacydisclaimers — dat hoort niet in een financieringsrapport en wordt alleen toegevoegd als de adviseursnotities dit expliciet vragen. Gebruik voor bouwdepot-opnames de term uit de bron (meestal "afgeroepen worden voor verzending/uitbetaling"); vervang dit nooit door "verpand worden" — verpanding is een zekerheidsrecht en betekent iets heel anders dan het opvragen/afroepen van een bouwdepottermijn. Geen dubbele koppen: herhaal een hoofdstuktitel niet als eerste zin van de sectietekst. Let op correcte accenten in Nederlandse woorden (financiële, privé, ratio's). Let op correcte vaktermen ("verzwaring" of "tijdelijke druk", nooit "verzuring"). Vermijd "circa" waar het exacte broncijfer beschikbaar is. Controleer taal en opmaak vóór oplevering: geen slordigheden zoals "wins", "definitive", "Most representatieve ratio", woorden met een losse spatie erin ("gevestig d"), afgebroken woorden of half-Engelse koppen. Gebruik in lopende tekst nooit "aan te reiken" — wel "aanvullend aan te bieden", "mogelijk aanvullend te vestigen" of "nader te bepalen".

GEEN DUBBELE UITLEG — ANTI-HERHALING
Leg de juridische structuur één keer volledig uit in juridische_structuur; verwijs daarna alleen kort ("via de vastgoed-B.V.", "binnen de beschreven groepsstructuur", "tussen de vastgoed-B.V. en de werkmaatschappij"). Herhaal niet telkens opnieuw wie de UBO is, dat de holding 100% houdt, dat de vastgoed-B.V. het pand koopt of dat de werkmaatschappij het pand huurt. Herhaal financieringsdoel, eigen inbreng, LTV, zekerheden, bouwdepot, DSCR, risico's en documentatie niet in meerdere secties met vrijwel dezelfde formulering: de eerste keer volledig, daarna alleen een korte verwijzing als dat voor de onderbouwing nodig is. Wat al in de managementsamenvatting staat, komt later alleen terug in kortere vorm. Controleer vóór oplevering dat dezelfde boodschap niet twee keer vrijwel letterlijk voorkomt.

TOON RICHTING FINANCIER — FINANCIERINGSGERICHT, NIET AFWIJZEND
Het rapport is bedoeld voor financiers, met als doel de aanvraag helder, professioneel en aantrekkelijk te presenteren zodat financiers een passend en scherp financieringsvoorstel kunnen doen. Het is géén intern afwijzings- of kredietcommissieadvies. De toon is professioneel, feitelijk, commercieel sterk, financieringsgericht, neutraal positief en onderbouwend — niet defensief, niet afwijzend, niet overdreven voorzichtig.
Vermijd harde negatieve oordelen die de aanvraag onnodig verzwakken, zoals "twijfelachtig", "onvoldoende", "negatief", "zwak", "problematisch", "niet haalbaar", "hoog risico zonder onderbouwing", "afwijzend", "voorlopig oordeel", "kredietoordeel", "de betaalcapaciteit is onvoldoende" — tenzij de bron dit letterlijk en feitelijk afdwingt. Gebruik in plaats daarvan: "biedt aanknopingspunten voor verdere beoordeling", "aandachtspunt voor financier", "nader te onderbouwen", "te verifiëren", "voorwaarde voor definitieve beoordeling", "vraagt om aanvullende toelichting", "dient te worden gemonitord", "kan worden gemitigeerd door", "onder voorbehoud van definitieve stukken", "op basis van de aangeleverde informatie verdedigbaar", "financierbaar onder de juiste voorwaarden", "uitgangspunt voor verdere financieringsbespreking", "vormt basis voor het opvragen van financieringsvoorstellen".
Benoem risico's altijd professioneel en direct met mitigatie of vervolgstap. Niet "De aanvraag is risicovol door afhankelijkheid van de ondernemer" maar "De onderneming is in belangrijke mate afhankelijk van de ondernemer. Dit is een aandachtspunt voor de continuïteit, maar wordt deels gemitigeerd door …". Niet "De DSCR in 2027 is laag" maar "De DSCR daalt in 2027 tijdelijk door de bouw- en overgangsfase; deze daling is verklaarbaar door tijdelijke dubbele lasten. Vanaf 2028 ontstaat volgens de prognose een structureel genormaliseerde situatie."
Het rapport moet financiers snel laten zien: wie de klant is, wat gefinancierd moet worden, waarom de financiering logisch is, hoe wordt terugbetaald, welke zekerheden beschikbaar zijn, welke aandachtspunten er zijn en hoe die worden ondervangen.

CONCLUSIEBELEID
Volg de conclusie en toonzetting van de bron; voeg geen eigen oordeel toe dat niet uit de bron volgt. Een aanvullende observatie markeer je expliciet als adviseursoordeel. Wees voorzichtig en professioneel. Gebruik nuance: "voorlopig", "op basis van de aangeleverde informatie", "mits", "na adviseurscontrole", "onder voorbehoud van verificatie", "liquiditeit monitoren". Sluit niet af met een hard oordeel ("positief"/"negatief"/"twijfelachtig") maar met een financieringsgerichte slotparagraaf, in de trant van: "Op basis van de aangeleverde informatie is sprake van een goed onderbouwde financieringsaanvraag. De aanvraag wordt gedragen door … De belangrijkste aandachtspunten zijn … Deze punten kunnen in het verdere financieringsproces nader worden onderbouwd en afgestemd met de financier." Gebruik het oordeel "negatief" uitsluitend als de bron dit feitelijk afdwingt.
- Sterke brondata → oordeel "voorzichtig positief": bijvoorbeeld in de trant van "Op basis van de aangeleverde informatie lijkt de aanvraag verdedigbaar, mits de prognoses worden gerealiseerd, de liquiditeit gedurende de bouw- en overgangsfase wordt bewaakt en de zekerheden definitief worden vastgelegd." Schrijf nooit "zekerheidstelling is adequaat" als een aanvullende zekerheid nog mogelijk/aan te reiken is, en nooit "solide", "gezond" of "geborgd" als dit niet duidelijk uit de bron volgt.
- Beperkte data (geen financiële analyse, prognose of betaalcapaciteitsberekening in de bron) → oordeel "onvoldoende data": gebruik dan letterlijk "Op basis van de beschikbare informatie kan nog geen definitief oordeel worden gevormd. Aanvullende bankopgaven en financiële onderbouwing zijn noodzakelijk voor verdere beoordeling." Schrijf in dat geval nooit "voorlopig positief", "passend geacht", "financiering verantwoord" of "gezonde structuur".
- VERBODEN zonder volledige onderbouwing: "de financiering is verantwoord en betaalbaar", "kan zonder meer worden verstrekt", "bankwaardig", "sterk onderbouwd", "duurzaam draagbaar", "geen noemenswaardige risico's", "definitief akkoord".
- conclusie.extern_deelbaar: één zin met advies of het rapport na adviseurscontrole extern deelbaar is.

VISUALISATIES
Vul grafiekarrays uitsluitend met echte bronbedragen. financieringsmix: de opbouw van de financiering. omzetontwikkeling / resultaatontwikkeling: per periode, inclusief prognosejaren (markeer met "(prognose)"). zekerhedenmix: alleen met waardes uit de bron. ratioontwikkeling: DSCR en/of Debt/EBITDA per periode als numerieke waarde. Geen betrouwbare bedragen = lege array []. Nooit 0-waarden als vulling, nooit één losse onduidelijke waarde.

RISICO'S
Risico's zijn aandachtspunten die financiers inzicht geven in de casus — geen redenen om af te wijzen. Maximaal 5 risico's: kies de belangrijkste die uit de bron volgen, ELK met een concrete mitigant of vervolgstap in het mitigant-veld (nooit leeg): ondernemersafhankelijkheid, marktrisico, debiteuren/crediteuren, voorraad/werkkapitaal, bouwfase, dubbele lasten, prognoserisico, hoge LTV, beperkte schaalgrootte, nog af te ronden juridische formaliteiten, enzovoort. Formuleer het risico feitelijk en de mitigant concreet (bijv. "Tijdelijke dubbele lasten — in 2027 lopen huur, rente en start aflossing deels samen — aflossingsvrije bouwfase, liquiditeitsbuffer en verwachte normalisatie vanaf 2028"). Vul per risico ook het veld toelichting met één feitelijke zin die uitlegt waarom dit aandachtspunt speelt; in het rapport wordt de tabel getoond als Aandachtspunt | Toelichting | Mitigerende factor / vervolgstap. Een risico mag nooit kaal negatief blijven staan. Sluit het risicohoofdstuk af met concrete voorwaarden/actiepunten in conclusie.voorwaarden (bijv. definitieve huurovereenkomst opvragen, bewijs eigen inbreng controleren, hypotheekrecht eerste rang vestigen, oprichting vastgoed-B.V. afronden, liquiditeitsontwikkeling monitoren). Bij beperkte documentatie is "Documentatierisico" (kans hoog, impact hoog, mitigant: aanvullende stukken opvragen vóór externe beoordeling) het belangrijkste risico.

DOCUMENTATIECHECK — EERLIJK
- ontvangen: uitsluitend de daadwerkelijk aangeleverde bestanden (status "ontvangen").
- in_bron_opgenomen: informatie of stukken die in het bronmemorandum zijn opgenomen of daarin worden genoemd (status "in bron opgenomen").
- separaat_te_controleren: onderliggende stukken die in de bron worden genoemd maar niet los zijn aangeleverd.
- ontbrekend: stukken die voor besluitvorming nodig zijn maar nergens blijken.
Claim NOOIT dat stukken los ontvangen zijn als ze alleen in het bronmemorandum staan. Formuleer maximaal 6 gerichte vervolgvragen. Elke kwestie komt in het hele rapport precies één keer voor als vervolgpunt: neem hetzelfde onderwerp (bijv. definitieve huurovereenkomst, bewijs eigen inbreng, taxatierapport, oprichting vastgoed-B.V., liquiditeitsmonitoring) nooit dubbel op als voorwaarde én actiepunt én ontbrekend stuk én vervolgvraag — kies per kwestie de meest passende categorie. Vervolgvragen zijn alleen nodig als ze echt nieuwe informatie toevoegen.

RAPPORTTYPE — MINIMUMEISEN
"volwaardig_financieringsmemorandum" vereist minimaal: kredietnemer, financieringsdoel en financieringsbedrag (of duidelijke behoefte); financiële cijfers of een prognose horen er vrijwel altijd bij. Ontbreekt vrijwel alle inhoudelijke onderbouwing, kies dan "compact_intake": een eerlijk, compact intake- en documentatieoverzicht (wat is vastgesteld, wat ontbreekt, welke stukken nodig zijn, logische vervolgstap) — dwing geen volwaardig kredietrapport af als de bron daar onvoldoende inhoud voor bevat.

METADATA
klantnaam: volgt de door de adviseur gekozen dossierpartij/kredietnemer. Geven de adviseursnotities een specifieke covernaam of kredietnemer aan (bijv. "Kredietnemer: [Naam]" of "Toon op de cover: [Naam]"), gebruik dan EXACT en UITSLUITEND die naam — vul deze nooit automatisch aan met andere entiteiten (werkmaatschappij/holding/vastgoed-B.V.); de overige betrokken entiteiten worden sowieso volledig uitgewerkt in het hoofdstuk Juridische structuur, dus hoeven niet ook nog op de cover te staan. Is er geen expliciete instructie, gebruik dan de kredietnemer/vastgoedhouder zoals de bron die primair presenteert (doorgaans de entiteit die de financiering aanvraagt of het object koopt/houdt) als enkele naam; combineer alleen tot een samengestelde naam (bijv. "[Vastgoed-B.V.] / [Werkmaatschappij]") als de bron zelf de aanvraag expliciet als gezamenlijk/gecombineerd dossier van meerdere entiteiten presenteert. financieringsdoel: één compacte zin. status: altijd "Concept · ter beoordeling". kantoor_adviseur: het Credion-kantoor en/of de adviseur zoals vermeld in de bron; leeg indien onbekend. datadekking: jouw eerlijke inschatting (wordt server-side geverifieerd).

AANVULLENDE KWALITEITSREGELS (verplicht, server-side ook gecontroleerd)
- Geen restzinnen of afgebroken tekst waar dan ook in het rapport: geen losse getallen als zin ("000 in 2028"), geen zin die met een komma of een los haakje begint (", waarmee vastgoed en activiteiten worden gescheiden"), geen tekstfragment zonder onderwerp, geen onlogische combinatie als "inclusief btw exclusief ...". Wordt tekst ingekort, dan blijft de zin grammaticaal volledig — nooit halverwege afbreken.
- Objectgegevens: gebruik altijd de correcte veldnamen. Schrijf "Energielabel" (nooit "Energie label"). Schrijf "Erfpachtcanon per jaar" voor het jaarlijkse erfpachtbedrag (nooit "Aantal erfpachters per jaar"). Schrijf LTV altijd als percentage ("84,7%" of "85%"), nooit als kale verhouding ("0,85"). Schrijf "Privé" met accent (nooit "Prive" of "Prive9"). Neem in het objecthoofdstuk (object_en_vastgoed) nooit risicomatrix-achtige tekst op (kans/impact/mitigant-formuleringen) — risico's horen uitsluitend thuis in het hoofdstuk Risico's, mitiganten & aandachtspunten. Wordt hoofdelijke aansprakelijkheid of een aanvullende zekerheid genoemd in de tekst van hoofdstuk Zekerheden & risico, neem deze dan ook op als rij in de zekerhedentabel — noem een zekerheid nooit alleen in lopende tekst zonder bijbehorende tabelregel.
- Bronnen en aanwendingen moeten zuiver optellen en zakelijk eenduidig geformuleerd zijn. Schrijf "Totale investering" (nooit "Totaal investering"). Is een totaalregel als "Kosten koper" of "Bijkomende kosten" opgenomen, toon dan NIET ook nog alle onderliggende posten (notaris, taxateur, financierings-/advieskosten, onvoorzien, btw over bijkomende kosten) los als aparte aanwending naast die totaalregel — kies één van beide weergaven (samengevat vs. volledig uitgesplitst) en gebruik nooit beide tegelijk. Controleer dat totaal aanwendingen = totaal bronnen, dat subtotalen niet dubbel meetellen, dat de totale investering aansluit bij de bron, en dat btw-regels logisch zijn verwerkt.
- Financiële cijfers exact uit de bron: bedragen, jaren en postlabels nooit verschuiven tussen jaren of regels, nooit herverdelen of afleiden als de bron al een duidelijk bedrag geeft. Afschrijvingen (op immateriële en materiële vaste activa) zijn een resultatenpost en horen NOOIT in de balansontwikkeling, ook al bevat het postlabel de woorden "vaste activa" — plaats afschrijvingen, overige bedrijfskosten, kosten en resultaten exact zoals de bron ze geeft, in de resultatentabel.
- Geen lege of te dunne vervolgpagina's: een hoofdstuk met slechts één kort tekstblok (bijv. financieringsduiding, markt en afnemers, management, of voorwaarden en condities) wordt inhoudelijk gecombineerd met het voorgaande hoofdstuk of blok in plaats van een nieuwe, nauwelijks gevulde pagina te starten. De financieringsduiding (hoofdstuk 1) vormt nooit een eigen (vervolg)pagina.
- Voorwaarden & documentatie: elk onderwerp (hypotheekrecht, huurovereenkomst, eigen inbreng, oprichting entiteit, liquiditeitsmonitoring, oplevering/ingebruikname, bouwdepot/fasering, prognose) komt in het hele rapport precies één keer voor, met de vaste status en concrete toelichting uit de tabel hierboven — nooit hetzelfde onderwerp nogmaals als apart actiepunt, ontbrekend stuk of vervolgvraag.
- Geen privégegevens of datadump als losse slotinformatie: neem aan het einde van het rapport nooit een aparte opsomming op van geboortedatum, privéadres, nationaliteit, volledige persoonsgegevens, technische KvK-dumps, oprichtingsdata die al elders staan, of detailtabellen die al in de partijentabel (hoofdstuk Juridische structuur) staan — die partijentabel is voldoende en wordt niet elders herhaald.
- Cover: bevat de casus meerdere relevante entiteiten (werkmaatschappij, vastgoed-B.V., holding), toon dan op de cover altijd de logische combinatie — bijvoorbeeld "[Werkmaatschappij] / [Vastgoed-B.V.]" of "[Werkmaatschappij] / [Holding] / [Vastgoed-B.V.]" — of de groepsnaam als de bron die vermeldt; noem nooit alleen de werkmaatschappij als er ook een vastgoed-B.V. of holding feitelijk bij de financiering betrokken is.
- De financieringssamenvatting (afsluiting van het laatste hoofdstuk) is 5 tot 7 regels (nooit korter, nooit één algemene zin) en benoemt kort: dat de aanvraag goed onderbouwd is, eigen inbreng, historische resultaten, de (vastgoed)structuur, de primaire zekerheid, betaalcapaciteit, belangrijkste aandachtspunten en het vervolg richting de financier.

- Structuurschema: percentages in het organogram liggen altijd tussen 0 en 100 (nooit een fout als "1100%") en komen nooit dubbel voor dezelfde relatie voor. Geef beide schema's, indien aanwezig, de vaste titels "Structuur huidig" en "Structuur na wijziging". Is een schema niet foutloos te reconstrueren, teken het dan niet opnieuw met fouten — gebruik in dat geval het tekstuele structuurschema.

OUTPUT
Antwoord uitsluitend met valide JSON volgens het schema. Geen markdown, geen tekst buiten de JSON.`;

/* Structuurschema dat de adviseur zelf heeft aangeleverd (tekst/handmatig/afbeelding)
   krijgt in de prompt een eigen, dwingende sectie: de AI mag dit nooit overschrijven
   of opnieuw verzinnen. Dit is de eerste (prompt-)laag; enforceStructOverride()
   hieronder is de tweede, server-side laag die dit ook afdwingt ongeacht wat de
   AI teruggeeft. */
function buildStructOverrideBlock(structuurOverride) {
  const mode = structuurOverride && structuurOverride.mode;
  if (!mode || mode === 'auto') return '';
  if (mode === 'tekst' || mode === 'handmatig') {
    const tekst = String(structuurOverride.tekst || '').trim();
    if (!tekst) return '';
    return `\n\nSTRUCTUURSCHEMA — DOOR DE ADVISEUR ZELF AANGELEVERD (VERPLICHT, VOORRANG BOVEN AI-GENERATIE)
De adviseur heeft onderstaand structuurschema zelf aangeleverd. Neem dit LETTERLIJK en ONGEWIJZIGD over in juridische_structuur.structuur_tekstueel (één regel per bullet, exact zoals hieronder — verzin niets bij, laat niets weg, herformuleer niets). Verzin zelf GEEN organogram: zet organogram_bestaand.aanwezig en organogram_nieuw.aanwezig op false. Je mag in de lopende sectietekst kort en zakelijk naar dit schema verwijzen, maar het schema zelf blijft ongewijzigd zoals hieronder aangeleverd.
---
${tekst}
---`;
  }
  if (mode === 'afbeelding') {
    return `\n\nSTRUCTUURSCHEMA — AFBEELDING DOOR DE ADVISEUR AANGELEVERD (VOORRANG BOVEN AI-GENERATIE)
De adviseur heeft zelf een afbeelding van het structuurschema aangeleverd; deze wordt apart en ongewijzigd in het hoofdstuk "Juridische structuur & activiteiten" geplaatst. Genereer daarom zelf GEEN organogram (organogram_bestaand.aanwezig en organogram_nieuw.aanwezig moeten op false staan) en schrijf geen volledig tekstueel structuurschema meer — een korte, zakelijke verwijzing in de lopende tekst (bijv. "De groepsstructuur is weergegeven in het bijgevoegde schema.") volstaat.`;
  }
  return '';
}

function buildPrompt({ notities, docSummary, vandaag, bytesPageCount, uitgebreid, structuurOverride }) {
  const base = bytesPageCount
    ? `De aangeleverde bron-PDF telt ${bytesPageCount} pagina${bytesPageCount === 1 ? '' : "'s"}. `
    : "Het exacte aantal bronpagina's kon niet automatisch worden bepaald: vul bronrapport.aantal_paginas zo nauwkeurig mogelijk in. ";
  const budgetLine = base
    + "De bronlengte bepaalt het rapporttype en het paginabudget NIET. De inhoudsopgave krijgt altijd een eigen pagina (pagina 2, nooit samengevoegd met hoofdstuk 1). Rapporttype A (compact_intake): maximaal 8 pagina's, doellengte 6 à 8. Rapporttype B (volwaardig financieringsmemorandum of luxe samenvatting): richtlengte 11 tot 13 pagina's, maximaal 15. Volledigheid weegt zwaarder dan een streng paginabudget: neem structuur, juridische opzet, financiële analyse mét prognose, betaalcapaciteit, zekerheden, risico's en documentatie allemaal netjes en volledig op. Wees niet nodeloos uitgebreid, maar laat nooit inhoud sneuvelen om binnen een paginabudget te blijven."
    + (uitgebreid ? ' De adviseur vroeg om een uitgebreid rapport: benut het maximum van het gekozen rapporttype, maar overschrijd het nooit.' : '');
  const structBlock = buildStructOverrideBlock(structuurOverride);

  return `${SYSTEM_BASE}

AANGELEVERDE DOCUMENTEN
${docSummary}

PAGINABUDGET
${budgetLine}

ADVISEURSNOTITIES
${notities || 'Geen aanvullende adviseursnotities opgegeven.'}${structBlock}

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

/* Zekerhedenmix mag uitsluitend definitieve/gevestigde zekerheden tonen: een
   mogelijke, aan te reiken of nog te formaliseren zekerheid mag niet meetellen
   in een grafiek die de dekking visueel als vaststaand voorstelt. */
const CONDITIONAL_STATUS_PAT = /mogelijk|aan te reiken|aan te bieden|te vestigen|aangeboden|voorwaardelijk|nog te formaliseren|nog te controleren/i;
const normLabel = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();
function dropConditionalZekerheden(mix, zekerheden) {
  const conditioneel = A(zekerheden)
    .filter((z) => CONDITIONAL_STATUS_PAT.test(String(z?.status || '')))
    .map((z) => normLabel(z?.zekerheid))
    .filter(Boolean);
  if (!conditioneel.length) return A(mix);
  return A(mix).filter((pt) => {
    const n = normLabel(pt?.label);
    return !conditioneel.some((c) => n.includes(c.slice(0, 14)) || c.includes(n.slice(0, 14)));
  });
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

function enforceDates(r, internal, vandaag) {
  const md = (r.metadata = r.metadata || {});
  const births = collectSuspectDates(r, /geboor|geboren/i);
  const oprichting = collectSuspectDates(r, /opgericht|oprichtingsdatum/i);
  const taxatie = collectSuspectDates(r, /taxatie/i);
  const isTaxatierapport = /taxatie/i.test(String(r.bronrapport?.type || ''));

  /* Dit zijn technische tool-correcties (verkeerd overgenomen datumveld), geen
     zakelijke controlepunten voor de adviseur — dus altijd naar `internal`,
     nooit naar de extern zichtbare waarschuwingen/controlepunten. */
  const check = (field, label) => {
    const p = parseNLDate(md[field]);
    if (!p) return;
    if (births.some((x) => sameDate(x, p))) {
      internal.push(`${label} was gelijk aan een geboortedatum uit de bron en is gecorrigeerd.`);
      md[field] = '';
    } else if (oprichting.some((x) => sameDate(x, p)) && field === 'rapportdatum') {
      internal.push(`Rapportdatum was gelijk aan een oprichtingsdatum en is gecorrigeerd.`);
      md[field] = '';
    } else if (taxatie.some((x) => sameDate(x, p)) && field === 'rapportdatum' && !isTaxatierapport) {
      internal.push(`Rapportdatum was gelijk aan een taxatiedatum en is gecorrigeerd.`);
      md[field] = '';
    }
  };
  check('rapportdatum', 'Rapportdatum');
  check('documentdatum', 'Documentdatum');
  if (!hasTxt(md.rapportdatum)) md.rapportdatum = vandaag;
}

/* Bronnen/aanwendingen: totaalregels herkennen; classificatie alleen corrigeren als dat de opzet aantoonbaar sluitend maakt */
const BRON_PAT = /(eigen\s+(inbreng|middelen|vermogen)|\binbreng\b|hypothecaire\s+(lening|financiering)|bancaire?\s+(lening|financiering)|achtergestelde?\s+lening|vendor\s?loan|verkopersl?ening|\bsubsidie\b|btw[- ]?(teruggave|financiering)|\blening\b|\bkrediet\b)/i;
const AANW_PAT = /(koopsom|aanneemsom|aankoopprijs|\baankoop\b|kosten\s+koper|bouwkosten|verbouwing|renovatie|nieuwbouwkosten|notaris|taxatiekosten|advieskosten|financieringskosten|afsluitprovisie|onvoorzien|werkkapitaal|inventaris|installaties|leges|overdrachtsbelasting|herfinanciering)/i;
const TOTAL_PAT = /^\s*((sub|eind)?totaal\b|totale\s|financieringsbehoefte\b|saldo\b|netto[ -]?investering\b|bruto[ -]?investering\b)/i;

function enforceBnA(fo, warnings) {
  const rows = A(fo.bronnen_en_aanwendingen);

  /* 1 — totaalregels markeren: nooit als detailpost meetellen */
  for (const row of rows) {
    if (row && !row.totaalregel && TOTAL_PAT.test(String(row.label || ''))) row.totaalregel = true;
  }
  const detailSum = (type) =>
    rows.filter((x) => x?.type === type && !x?.totaalregel && num(x?.bedrag) !== null).reduce((t, x) => t + x.bedrag, 0);

  /* 2 — classificatie: bron is leidend; alleen verplaatsen als de verplaatsing de opzet aantoonbaar sluitend maakt */
  for (const row of rows) {
    const l = String(row?.label || '');
    if (!l || row?.totaalregel || num(row?.bedrag) === null) continue;
    const misAlsAanw = row.type === 'aanwending' && BRON_PAT.test(l) && !AANW_PAT.test(l);
    const misAlsBron = row.type === 'bron' && AANW_PAT.test(l) && !BRON_PAT.test(l);
    if (!misAlsAanw && !misAlsBron) continue;
    const voor = Math.abs(detailSum('bron') - detailSum('aanwending'));
    row.type = misAlsAanw ? 'bron' : 'aanwending';
    const na = Math.abs(detailSum('bron') - detailSum('aanwending'));
    if (na < voor - 0.5 && na <= Math.max(detailSum('aanwending'), 1) * 0.02) {
      warnings.push(`"${l}" is geherclassificeerd (${misAlsAanw ? 'aanwending → bron' : 'bron → aanwending'}); hiermee sluit de opzet weer op de bron.`);
    } else {
      row.type = misAlsAanw ? 'aanwending' : 'bron';
      warnings.push(`Controlepunt: "${l}" staat in de bron onder ${misAlsAanw ? 'aanwendingen' : 'bronnen'}, terwijl het label het omgekeerde suggereert; de bron is gevolgd.`);
    }
  }

  /* 3 — Bouwdepot/opnametermijnen zijn een opnameplanning van de lening, geen extra bron */
  const DEPOT_PAT = /(bouwdepot|opnametermijn|\btermijn\s*\d)/i;
  const depotRows = rows.filter((x) => x?.type === 'bron' && !x?.totaalregel && DEPOT_PAT.test(String(x?.label || '')));
  if (depotRows.length) {
    const tb = detailSum('bron');
    const ta = detailSum('aanwending');
    const depotSum = depotRows.reduce((t, x) => t + (num(x?.bedrag) || 0), 0);
    if (ta > 0 && Math.abs(tb - ta) > ta * 0.02 && Math.abs(tb - depotSum - ta) <= ta * 0.02) {
      fo.bronnen_en_aanwendingen = rows.filter((x) => !depotRows.includes(x));
      const note = `Bouwdepot/opnametermijnen (${depotRows.map((x) => x.label).join(', ')}) zijn verwerkt als opnameplanning van de lening en niet als extra financieringsbron geteld.`;
      fo.bouwdepot_fasering = [fo.bouwdepot_fasering, note].filter(hasTxt).join('\n');
      warnings.push(note);
    } else if (ta > 0 && Math.abs(tb - ta) > ta * 0.02) {
      warnings.push('Bouwdepot/opnametermijnen staan als financieringsbron vermeld; controleer op dubbeltelling met de lening.');
    }
  }
}

/* Coverage: elk bronhoofdstuk verwerkt of gemotiveerd weggelaten.
   De "niet expliciet verwerkt"-melding is een interne kwaliteitscheck voor de
   ontwikkelaar (staat letterlijk op de verbodslijst voor externe controlepunten)
   en gaat daarom naar `internal`, nooit naar `warnings`/coverage_check.waarschuwingen.
   Een ontbrekend organogram is wél een zakelijk relevant controlepunt en blijft extern. */
/* Voorkomt dubbeltelling: is een samenvattende totaalregel ("Bijkomende
   kosten" of "Kosten koper") opgenomen terwijl de onderliggende componenten
   (notaris, taxateur, financierings-/advieskosten, onvoorzien, btw over
   bijkomende kosten) daarnaast ook al los als aparte aanwending zijn
   opgenomen, dan telt dat bedrag dubbel. Alleen verwijderen als het bedrag
   van de generieke regel binnen een kleine marge overeenkomt met de som van
   de losse componenten — anders betreft het aantoonbaar een ander, apart
   bedrag en blijven beide regels staan. */
const BIJKOMENDE_COMPONENT_PAT = /notaris|taxat|financieringskosten|afsluitprovisie|advieskosten|onvoorzien|\bbtw\b/i;
const BIJKOMENDE_GENERIEK_PAT = /^(bijkomende\s+kosten|kosten\s+koper)$/i;
function dedupeBijkomendeKosten(fo, warnings) {
  const rows = A(fo.bronnen_en_aanwendingen);
  const generiek = rows.filter((x) => x?.type === 'aanwending' && !x.totaalregel && BIJKOMENDE_GENERIEK_PAT.test(String(x?.label || '').trim()));
  if (!generiek.length) return;
  const componenten = rows.filter((x) => x?.type === 'aanwending' && !x.totaalregel && BIJKOMENDE_COMPONENT_PAT.test(String(x?.label || '')) && !BIJKOMENDE_GENERIEK_PAT.test(String(x?.label || '').trim()));
  if (!componenten.length) return;
  const compSom = componenten.reduce((t, x) => t + (num(x.bedrag) || 0), 0);
  if (compSom <= 0) return;
  const teVerwijderen = generiek.filter((g) => num(g.bedrag) !== null && Math.abs(num(g.bedrag) - compSom) <= Math.max(compSom, 1) * 0.03);
  if (!teVerwijderen.length) return;
  /* Veiligheidscheck: verwijderen mag de aansluiting met de bronnen-kant
     nooit verslechteren. Is dat wel het geval, dan is het kennelijk geen
     echte dubbeltelling (bijv. de generieke regel bevat ook een btw-component
     die niet los is uitgesplitst) en blijven beide regels staan. */
  const overigeAanwRows = rows.filter((x) => !teVerwijderen.includes(x));
  const bronRows = rows.filter((x) => x?.type === 'bron' && num(x.bedrag) !== null);
  const bronTotaalregel = bronRows.find((x) => x.totaalregel);
  const bronTotaal = bronTotaalregel ? num(bronTotaalregel.bedrag) : bronRows.filter((x) => !x.totaalregel).reduce((t, x) => t + x.bedrag, 0);
  if (bronTotaal !== null && bronTotaal > 0) {
    const aanwVoor = rows.filter((x) => x?.type === 'aanwending' && !x.totaalregel && num(x.bedrag) !== null).reduce((t, x) => t + x.bedrag, 0);
    const aanwNa = overigeAanwRows.filter((x) => x?.type === 'aanwending' && !x.totaalregel && num(x.bedrag) !== null).reduce((t, x) => t + x.bedrag, 0);
    const voorDiff = Math.abs(aanwVoor - bronTotaal);
    const naDiff = Math.abs(aanwNa - bronTotaal);
    if (naDiff > voorDiff + Math.max(bronTotaal, 1) * 0.02) {
      warnings.push(`Controlepunt: "${teVerwijderen[0].label}" lijkt op te tellen met de losse componenten, maar verwijderen zou de aansluiting met de bronnen verslechteren (mogelijk ontbreekt een btw-component); de regel is daarom gehandhaafd.`);
      return;
    }
  }
  fo.bronnen_en_aanwendingen = overigeAanwRows;
  warnings.push(`Dubbele totaalregel "${teVerwijderen[0].label}" verwijderd: dit bedrag was al uitgesplitst in ${componenten.map((c) => c.label).join(', ')}.`);
}

/* Aanwendingen moeten exact aansluiten op kerncijfers.totale_investering,
   niet alleen onderling op de bronnen-kant — zo wordt een btw-regel die in de
   bron wél stond maar in de output is weggevallen alsnog zichtbaar. */
function enforceInvesteringConsistentie(fo, warnings) {
  const kc = fo.kerncijfers || {};
  const ti = num(kc.totale_investering);
  if (ti === null || ti <= 0) return;
  const rows = A(fo.bronnen_en_aanwendingen).filter((x) => x?.type === 'aanwending' && num(x?.bedrag) !== null);
  if (!rows.length) return;
  const totRow = rows.find((x) => x.totaalregel);
  const detail = rows.filter((x) => !x.totaalregel).reduce((t, x) => t + x.bedrag, 0);
  const aanwTotaal = totRow ? totRow.bedrag : detail;
  if (Math.abs(aanwTotaal - ti) <= Math.max(ti, 1) * 0.02) return;
  const heeftBtwRegel = rows.some((x) => /\bbtw\b/i.test(String(x.label || '')));
  const hint = heeftBtwRegel
    ? ''
    : ' Mogelijk ontbreekt een btw-regel (bijv. "Btw over bijkomende kosten" of "Btw over koop- en aanneemsom") die de bron wel vermeldt.';
  warnings.push(`Aanwendingen (€ ${Math.round(aanwTotaal).toLocaleString('nl-NL')}) sluiten niet op de totale investering (€ ${Math.round(ti).toLocaleString('nl-NL')}) uit kerncijfers; verifieer met de bron.${hint}`);
}

function enforceCoverage(r, warnings, internal) {
  const cv = (r.coverage_check = r.coverage_check || {});
  cv.waarschuwingen = A(cv.waarschuwingen).filter(hasTxt);
  const norm = (x) => String(x || '').toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();
  const hoofdstukken = A(r.bronrapport?.hoofdstukken).filter(hasTxt);
  if (!A(cv.bronhoofdstukken).length) cv.bronhoofdstukken = [...hoofdstukken];
  const covered = [...A(cv.opgenomen_in_rapport), ...A(cv.samengevat), ...A(cv.weggelaten_met_reden)].map(norm);
  for (const h of hoofdstukken) {
    const n = norm(h);
    if (!n) continue;
    const hit = covered.some((c) => c.includes(n.slice(0, Math.min(n.length, 18))) || n.includes(c.slice(0, Math.min(c.length, 18))));
    if (!hit) internal.push(`Bronhoofdstuk "${h}" is niet expliciet verwerkt of gemotiveerd weggelaten; door ontwikkelaar te controleren.`);
  }
  const orgFound = A(r.bronrapport?.gevonden_organogrammen).filter(hasTxt).length;
  const orgIncluded =
    r.juridische_structuur?.organogram_bestaand?.aanwezig === true ||
    r.juridische_structuur?.organogram_nieuw?.aanwezig === true;
  if (orgFound && !orgIncluded) {
    warnings.push('De bron bevat een organogram/structuurplaatje dat niet in het rapport is gereconstrueerd; door adviseur aan te vullen.');
  }
  /* AI-eigen coverage-opmerkingen (cv.waarschuwingen) blijven staan als zakelijke
     toelichting op samenvoeging/weglating; de client-side filter vangt eventuele
     interne formuleringen die de AI daar zelf toch in zou schrijven. */
  warnings.push(...cv.waarschuwingen.filter((w) => !warnings.includes(w)));
}

/* Eindcontrole (klantcorrectie punt 9): compacte, uitsluitend controlerende
   check vlak vóór export. Corrigeert zelf niets meer — dat gebeurt al eerder
   (deepCleanStrings/PHRASE_FIXES, enforceOrgDiagramQuality, enforceStructOverride,
   kvk-sanitatie) — maar signaleert als adviseurscontrolepunt wanneer een van de
   redactionele minimumvereisten toch niet gehaald lijkt. */
/* kpi_cards.waarde is vrije tekst die de AI zelf met "€ " moet formatteren;
   soms valt dat teken weg (bijv. "623.530" i.p.v. "€ 623.530"). Voor de
   geldbedrag-kpi's wordt dit hier afgedwongen; percentages/looptijd/ratio's
   (LTV, Looptijd, Rente, DSCR) blijven ongemoeid. */
const MONEY_KPI_LABEL_RE = /gevraagde financiering|totale investering|eigen inbreng|overige financiering|omzet/i;
function enforceKpiEuroFormat(r, warnings) {
  const ms = r.managementsamenvatting || {};
  if (!Array.isArray(ms.kpi_cards)) return;
  ms.kpi_cards = ms.kpi_cards.map((k) => {
    if (!k || typeof k.waarde !== 'string' || !hasTxt(k.label)) return k;
    if (!MONEY_KPI_LABEL_RE.test(k.label)) return k;
    const w = k.waarde.trim();
    if (/^\d[\d.,]*$/.test(w)) {
      warnings.push(`kpi_cards "${k.label}" miste het eurosymbool ("${w}") en is genormaliseerd naar "€ ${w}".`);
      return { ...k, waarde: `€ ${w}` };
    }
    return k;
  });
}

function enforceFinalChecklist(r, warnings) {
  const ju = r.juridische_structuur || {};
  const hasOrg = ju.organogram_bestaand?.aanwezig === true || ju.organogram_nieuw?.aanwezig === true;
  const hasStructTekst = A(ju.structuur_tekstueel).filter(hasTxt).length > 0;
  const hasPartijen = A(ju.partijen).filter((p) => hasTxt(p?.naam)).length > 0;
  const bronHeeftOrg = A(r.bronrapport?.gevonden_organogrammen).filter(hasTxt).length > 0;
  if (!hasOrg && !hasStructTekst && bronHeeftOrg) {
    warnings.push('Eindcontrole: geen structuurschema (organogram of tekstueel) gevonden terwijl de bron wel een structuur beschrijft; door adviseur aan te vullen vóór export.');
  }
  if (!hasPartijen && (hasOrg || hasStructTekst)) {
    warnings.push('Eindcontrole: partijentabel is leeg terwijl er wel een structuurschema is; controleer of alle betrokken partijen zijn opgenomen.');
  }

  /* Hoofdstuk 8 (Voorwaarden & documentatie) mag niet te mager blijven: bij
     een volwaardige aanvraag (voldoende bronhoofdstukken) is een tabel van
     minder dan 5 rijen een indicator dat relevante standaardonderwerpen
     (oprichting, huurovereenkomst, hypotheekrecht, eigen inbreng, liquiditeit,
     prognose, bouwdepot, aanvullende zekerheden) ontbreken. */
  const ccVoorwaarden = A(r.conclusie?.voorwaarden).filter(hasTxt).length;
  const bronchapCount = A(r.bronrapport?.hoofdstukken).filter(hasTxt).length;
  if (r.metadata?.rapport_type !== 'compact_intake' && bronchapCount >= 4 && ccVoorwaarden < 5) {
    warnings.push('Eindcontrole: hoofdstuk 8 (Voorwaarden & documentatie) telt minder dan 5 rijen terwijl de bron voldoende hoofdstukken bevat; vul aan met relevante standaardonderwerpen (oprichting/inschrijving, huurovereenkomst, hypotheekrecht, eigen inbreng, liquiditeitsmonitoring, prognose/omzetgroei, bouwdepot/opnameplanning, aanvullende zekerheden) voor zover de bron dit draagt.');
  }

  const ms = r.managementsamenvatting || {};
  const woorden = String(ms.kernboodschap || '').trim().split(/\s+/).filter(Boolean).length;
  if (r.metadata?.rapport_type !== 'compact_intake' && hasTxt(ms.kernboodschap) && woorden < 150) {
    warnings.push('Eindcontrole: managementsamenvatting (hoofdstuk 1) is korter dan de gevraagde 180-220 woorden lopende tekst; controleer of alle kernonderdelen (onderneming, doel, structuur, investering, financiering, resultaten, prognose, betaalcapaciteit, zekerheden, aandachtspunten) in doorlopende zinnen zijn benoemd.');
  }
  /* Hoofdstuk 1 moet lopende tekst zijn, geen rij losse telegramzinnen: een zeer
     laag gemiddeld aantal woorden per zin (met voldoende zinnen) is een goede,
     lichte indicator dat de kernboodschap uit fragmenten bestaat. */
  if (hasTxt(ms.kernboodschap)) {
    const zinnen = String(ms.kernboodschap).split(/(?<=[.!?])\s+/).filter((z) => z.trim().length > 0);
    if (zinnen.length >= 4 && woorden / zinnen.length < 7) {
      warnings.push('Eindcontrole: managementsamenvatting bestaat mogelijk uit losse, korte zinnen in plaats van lopende tekst; controleer de schrijfstijl van hoofdstuk 1.');
    }
  }
  /* Layoutregel 1/16: geen afgebroken zinnen in hoofdstuk 1. Een losse "..."
     of "…" ergens IN de kernboodschap (niet alleen aan het eind — dat wordt al
     elders cosmetisch opgeschoond) is vrijwel altijd een teken van een
     afgebroken of letterlijk overgenomen OCR-fragment. Daarnaast wordt een
     "zin" die begint met een kaal cijferfragment van 1-3 cijfers (zoals
     "000 in 2028…", het restant van een afgekapt bedrag) apart herkend: een
     echt jaartal is altijd 4 cijfers, dus dit patroon is zelf al een sterke
     indicator voor een kapotte zin. Deze controle repareert niets automatisch
     (vrije tekst mag niet blind worden aangepast) maar zorgt dat dit vóór
     export altijd wordt opgemerkt. */
  if (hasTxt(ms.kernboodschap)) {
    const kb = String(ms.kernboodschap);
    if (/(\.\.\.|…)/.test(kb)) {
      warnings.push('Eindcontrole: de kernboodschap (hoofdstuk 1) bevat "..." of "…" — mogelijk een afgebroken zin; herschrijf dit gedeelte tot een volledige, grammaticaal correcte zin vóór export.');
    }
    const kbZinnen = kb.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9])/);
    const afgebroken = kbZinnen.find((z) => /^\d{1,3}(\s|$)/.test(z.trim()) && !/^\d{4}\b/.test(z.trim()));
    if (afgebroken) {
      warnings.push(`Eindcontrole: de kernboodschap (hoofdstuk 1) bevat mogelijk een afgebroken zin die begint met een los cijferfragment ("${afgebroken.trim().slice(0, 40)}"); controleer en herschrijf tot een volledige zin.`);
    }
  }

  const finRows = [...A(r.financiele_analyse?.resultaten), ...A(r.financiele_analyse?.balans)]
    .filter((x) => hasTxt(x?.label) && hasTxt(x?.periode) && num(x?.bedrag) !== null);
  if (r.metadata?.rapport_type !== 'compact_intake' && finRows.length && new Set(finRows.map((x) => x.periode)).size < 2) {
    warnings.push('Eindcontrole: financiële analyse bevat maar één periode; controleer of alle relevante historische en prognosejaren uit de bron zijn meegenomen.');
  }
  /* Onterechte streepjes: als een kernpost voor sommige jaren wél en voor andere
     jaren niet gevuld is, terwijl er voor die andere jaren wel andere kernposten
     staan, kan dat duiden op een cijfer dat ten onrechte is weggelaten (bijv. uit
     overdreven voorzichtigheid bij toevallig gelijke bedragen — zie de regel bij
     financiele_analyse). Dit is een signaal, geen harde fout. */
  {
    const METRIEK = [
      { key: 'omzet', re: /omzet/i },
      { key: 'bedrijfsopbrengsten', re: /bedrijfsopbrengsten/i },
      { key: 'kosten', re: /^(bedrijfs)?kosten$|bedrijfslasten/i },
      { key: 'bedrijfsresultaat', re: /bedrijfsresultaat/i },
      { key: 'finbatenlasten', re: /financi[eë]le\s+baten/i },
      { key: 'resultaatvoorbelasting', re: /resultaat[^]*voor[^]*belasting/i },
      { key: 'belasting', re: /^belasting/i },
      { key: 'resultaatnabelasting', re: /resultaat[^]*na[^]*belasting/i },
      { key: 'vasteactiva', re: /vaste\s+activa/i },
      { key: 'vlottendeactiva', re: /vlottende\s+activa/i },
      { key: 'liquide', re: /liquide/i },
      { key: 'totaalactiva', re: /totaal\s+activa/i },
      { key: 'eigenvermogen', re: /eigen\s*vermogen/i },
      { key: 'langlopend', re: /langlopende?\s+schuld/i },
      { key: 'kortlopend', re: /kortlopende?\s+schuld/i },
      { key: 'totaalpassiva', re: /totaal\s+passiva/i },
    ];
    const perPeriode = {};
    for (const row of finRows) {
      const m = METRIEK.find((mm) => mm.re.test(String(row.label)));
      if (!m) continue;
      (perPeriode[row.periode] = perPeriode[row.periode] || new Set()).add(m.key);
    }
    const periodes = Object.keys(perPeriode);
    if (periodes.length >= 2) {
      const maxAantal = Math.max(...periodes.map((p) => perPeriode[p].size));
      const onvolledig = periodes.filter((p) => perPeriode[p].size > 0 && perPeriode[p].size < maxAantal - 1);
      if (onvolledig.length) {
        warnings.push(`Eindcontrole: financiële tabel mist mogelijk cijfers voor ${onvolledig.join(', ')} terwijl andere jaren meer posten tonen; controleer of deze cijfers wél in de bron staan vóórdat een streepje getoond wordt.`);
      }
    }
  }

  /* Layoutregel 2/16: balansposten en winst-en-verliesposten mogen nooit door
     elkaar in dezelfde tabel staan. Dit is een signaalcontrole, geen harde
     correctie (het rapport zelf scheidt de tabellen altijd correct via de vaste
     postenlijsten in de renderer), maar een mismatch hier wijst op een bronpost
     die de AI verkeerd heeft geclassificeerd. */
  {
    const RESULTAAT_KEYS = /omzet|bedrijfsopbrengsten|bedrijfsresultaat|^ebitda?$|financi[eë]le\s+baten|resultaat[^]*voor[^]*belasting|^belasting(en)?$|resultaat[^]*na[^]*belasting|^(bedrijfs)?kosten$|bedrijfslasten/i;
    const BALANS_KEYS = /vaste\s+activa|vlottende\s+activa|liquide\s+middelen|totaal\s+activa|eigen\s*vermogen|langlopende?\s+schuld|kortlopende?\s+schuld|totaal\s+passiva/i;
    const balansMismatch = A(r.financiele_analyse?.balans).filter((x) => hasTxt(x?.label) && RESULTAAT_KEYS.test(String(x.label)) && !BALANS_KEYS.test(String(x.label)));
    const resultatenMismatch = A(r.financiele_analyse?.resultaten).filter((x) => hasTxt(x?.label) && BALANS_KEYS.test(String(x.label)) && !RESULTAAT_KEYS.test(String(x.label)));
    if (balansMismatch.length) {
      warnings.push(`Eindcontrole: balans bevat mogelijk winst-en-verliespost(en) (${[...new Set(balansMismatch.map((x) => x.label))].join(', ')}) die in resultaten thuishoren; controleer of deze niet per ongeluk in de verkeerde tabel staan.`);
    }
    if (resultatenMismatch.length) {
      warnings.push(`Eindcontrole: resultaten bevat mogelijk balanspost(en) (${[...new Set(resultatenMismatch.map((x) => x.label))].join(', ')}) die in de balans thuishoren; controleer of deze niet per ongeluk in de verkeerde tabel staan.`);
    }
  }

  /* Layoutregel 5/16: bij financiële cijfers horen altijd 4-6 observaties. */
  {
    const obsCount = A(r.financiele_analyse?.observaties).filter(hasTxt).length;
    if (r.metadata?.rapport_type !== 'compact_intake' && finRows.length && obsCount < 4) {
      warnings.push('Eindcontrole: financiële analyse bevat minder dan 4 observaties terwijl er wel cijfers beschikbaar zijn; vul aan tot 4-6 observaties (omzetontwikkeling, resultaatontwikkeling, liquiditeit, eigen vermogen, schuldpositie, overgangsfase/prognose en betekenis voor de financier).');
    }
  }

  const zekerTxt = JSON.stringify(r.zekerheden_en_risico || {});
  if (/zekerheid dekt volledig|nog aan te vestigen|op te richten eerste hypotheekrecht|wordt gedekt door|zekerheid is aanwezig|dekt (de )?(lening|financiering) volledig/i.test(zekerTxt)) {
    warnings.push('Eindcontrole: zekerhedentekst bevat mogelijk een niet-toegestane, te stellige formulering; controleer vóór export.');
  }

  /* Kredietnemer-rollen (kredietnemer, mede-kredietnemer, hoofdelijk
     schuldenaar, hoofdkredietnemer, borgsteller) mogen nooit automatisch
     aangenomen zijn — alleen ter waarschuwing (niet automatisch verwijderd,
     dat zou echte bronbevestigde informatie kunnen wissen). */
  const kredietnemerRolTxt = JSON.stringify([r.juridische_structuur?.partijen, r.juridische_structuur?.organogram_bestaand, r.juridische_structuur?.organogram_nieuw]);
  if (/\bkredietnemer\b|mede-?kredietnemer|hoofdelijk schuldenaar|hoofdkredietnemer|borgsteller/i.test(kredietnemerRolTxt)) {
    warnings.push('Eindcontrole: een partij is aangeduid als kredietnemer/mede-kredietnemer/hoofdelijk schuldenaar/hoofdkredietnemer/borgsteller; verifieer dat dit expliciet uit de bron blijkt en geen aanname is.');
  }

  /* Klantcorrectie: een entiteit die zelf als "i.o."/"in oprichting" is
     aangemerkt (rechtsvorm of naam), kan per definitie nog geen vaste
     oprichtingsdatum hebben — een tekst die toch "opgericht op [datum]"
     claimt voor zo'n entiteit is een innerlijke tegenspraak en vrijwel zeker
     een verzonnen/aangenomen detail. */
  const ioPartijen = A(r.juridische_structuur?.partijen).filter(
    (p) => p && ((hasTxt(p.rechtsvorm) && /in\s+oprichting|\bi\.?o\.?\b/i.test(p.rechtsvorm)) || (hasTxt(p.naam) && /\bi\.?o\.?\b/i.test(p.naam)))
  );
  if (ioPartijen.length) {
    const structTxt = JSON.stringify([r.juridische_structuur?.structuur_tekstueel, r.juridische_structuur?.tekst]);
    if (/opgericht\s+op\s+\d/i.test(structTxt)) {
      warnings.push('Eindcontrole: het rapport bevat een entiteit "in oprichting" (i.o.) én een tekst die "opgericht op [datum]" claimt; een entiteit i.o. heeft nog geen oprichtingsdatum — controleer en verwijder de datumclaim tenzij dit expliciet uit de bron blijkt.');
    }
  }

  const dc = r.documentatiecheck || {};
  const vwRows = [...A(r.conclusie?.voorwaarden), ...A(dc.ontbrekend).map((x) => x?.item), ...A(dc.separaat_te_controleren)].filter(hasTxt);
  const normV = (t) => String(t).toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').trim().slice(0, 26);
  const seenV = new Set();
  let dubbel = false;
  for (const v of vwRows) {
    const k = normV(v);
    if (!k) continue;
    if (seenV.has(k)) { dubbel = true; break; }
    seenV.add(k);
  }
  if (dubbel) {
    warnings.push('Eindcontrole: mogelijk dubbele punten in voorwaarden/documentatie; controleer dat elk onderwerp maar één keer voorkomt.');
  }
  /* Hoofdstuk 8 (Voorwaarden & documentatie) mag compact zijn, maar niet te mager:
     te weinig onderwerpen in de tabel is een signaal dat relevante standaard-
     categorieën (oprichting kredietnemer/vastgoed-B.V., huurovereenkomst,
     hypotheekrecht, eigen inbreng, afnemers/omzet, liquiditeit, gescheiden
     administratie) zijn overgeslagen terwijl de bron dit wel draagt. */
  if (r.metadata?.rapport_type !== 'compact_intake' && vwRows.length && vwRows.length < 4) {
    warnings.push('Eindcontrole: hoofdstuk 8 (Voorwaarden & documentatie) bevat weinig onderwerpen; controleer of alle relevante standaardpunten uit de bron zijn meegenomen.');
  }
  const ontvangenTotaal = A(dc.ontvangen).filter((x) => hasTxt(x?.document)).length + A(dc.in_bron_opgenomen).filter((x) => hasTxt(x?.document)).length;
  if (r.metadata?.rapport_type !== 'compact_intake' && A(r.metadata?.bron_documenten).filter(hasTxt).length && ontvangenTotaal === 0) {
    warnings.push('Eindcontrole: "Ontvangen / gebruikt" is leeg terwijl er wel brondocumenten bekend zijn; vul deze lijst aan met alle daadwerkelijk gebruikte stukken.');
  }

  if (!hasTxt(r.metadata?.klantnaam) || !hasTxt(r.metadata?.financieringsdoel)) {
    warnings.push('Eindcontrole: klantnaam en/of financieringsdoel ontbreekt; rapport is zo nog niet extern toonbaar.');
  }
  /* Privacywaarschuwingen horen niet in een financieringsrapport; extra vangnet
     naast de automatische strip in deepCleanStrings/PHRASE_FIXES. */
  if (/privacygevoelige gegevens van priv[ée]personen/i.test(JSON.stringify(r))) {
    warnings.push('Eindcontrole: mogelijk nog een privacywaarschuwingszin aanwezig; verwijder deze vóór export.');
  }

  /* Afsluiting van het rapport (klantcorrectie): de financieringssamenvatting
     hoort als sterke, inhoudelijke afsluiting onderaan het laatste hoofdstuk
     (Voorwaarden & documentatie) te staan — nooit als aparte, dunne slotpagina
     en nooit leeg, zodat het rapport niet abrupt eindigt. */
  const cc = r.conclusie || {};
  const afsluitTekst = hasTxt(ms.voorlopig_oordeel) ? ms.voorlopig_oordeel : cc.tekst;
  if (!hasTxt(afsluitTekst) || String(afsluitTekst).trim().length < 40) {
    warnings.push('Eindcontrole: de financieringssamenvatting (de afsluiting van het laatste hoofdstuk) ontbreekt of is te kort; het rapport mag niet abrupt of leeg eindigen.');
  } else {
    /* Vereiste 6-8 regels: bij benadering een paar volledige zinnen, geen
       enkele algemene afsluitzin. */
    const afsluitZinnen = String(afsluitTekst).split(/(?<=[.!?])\s+/).filter((z) => z.trim().length > 0);
    if (afsluitZinnen.length < 4) {
      warnings.push('Eindcontrole: de financieringssamenvatting telt minder dan de gevraagde 5 tot 7 regels/zinnen en lijkt op één algemene afsluitzin; vul aan met het doel van de aanvraag, eigen inbreng, historische resultaten, de (vastgoed)structuur, de primaire zekerheid, betaalcapaciteit, belangrijkste aandachtspunten en het vervolg richting financiers.');
    }
    /* Klantcorrectie: de slottekst moet expliciet zekerheid én betaalcapaciteit
       benoemen — een afsluiting die deze twee kernonderwerpen mist, is niet
       compleet, ook al haalt hij wel de vereiste 5-7 regels. */
    if (!/zekerhe(id|den)|hypotheek|pandrecht|borgstelling/i.test(afsluitTekst)) {
      warnings.push('Eindcontrole: de financieringssamenvatting benoemt geen zekerheid (bijv. hypotheekrecht); vul de primaire zekerheid alsnog kort toe.');
    }
    if (!/betaalcapaciteit|dscr|aflossingscapaciteit|rentedekking/i.test(afsluitTekst)) {
      warnings.push('Eindcontrole: de financieringssamenvatting benoemt geen betaalcapaciteit; vul dit alsnog kort toe.');
    }
  }
  /* Generieke bijlage-/contactkoppen zijn nooit toegestaan als zelfstandige
     sectie: dat zijn precies de dunne "losse slotpagina's" die niet meer
     mogen voorkomen. Zulke overige_secties worden hier verwijderd; echte
     bronspecifieke inhoud (met een eigen, inhoudelijke titel) blijft staan.
     Layoutregel 7/16: een structuurschema/organogram hoort UITSLUITEND thuis
     in juridische_structuur (hoofdstuk 2) — belandt zoiets toch in
     overige_secties (bijv. hoofdstuk 8), dan is dat altijd een ongewenst
     duplicaat en wordt het hier verwijderd. */
  if (Array.isArray(r.overige_secties)) {
    const GENERIEKE_TITEL = /^(bijlage(n)?|bijlage\s*[:\-]|contactgegevens|bronvermelding|persoonsgegevens|personalia|kvk[- ]?gegevens|geboortegegevens|detail\s*gegevens\s+betrokken\s+partij(en)?|detailgegevens\s+partij(en)?)\b/i;
    const STRUCTUUR_TITEL = /structuur|organogram/i;
    /* Content-check (title-onafhankelijk): een overige_sectie waarvan de
       tabelrijen overwegend uit partij-identificatievelden bestaan (naam,
       KvK-nummer, rechtsvorm, oprichtingsdatum, adres) is altijd een
       herhaling van de partijentabel uit hoofdstuk 2, ongeacht de titel die
       de AI eraan gaf. */
    const PARTIJ_VELD_RE = /^naam$|kvk|rechtsvorm|opricht|vestigingsadres|^adres$|statutaire\s+naam|handelsnaam|geboortedatum/i;
    const isPartijDump = (os) => {
      const tabel = A(os?.tabel).filter((rw) => hasTxt(rw?.label));
      if (tabel.length < 2) return false;
      const treffers = tabel.filter((rw) => PARTIJ_VELD_RE.test(String(rw.label).trim())).length;
      return treffers / tabel.length >= 0.6;
    };
    const voor = r.overige_secties.length;
    r.overige_secties = r.overige_secties.filter((os) => !GENERIEKE_TITEL.test(String(os?.titel || '').trim()) && !STRUCTUUR_TITEL.test(String(os?.titel || '').trim()) && !isPartijDump(os));
    if (r.overige_secties.length < voor) {
      warnings.push('Eindcontrole: een generieke bijlage-/contactgegevens-sectie, een dubbel structuurschema/organogram, of een herhaling van de partijentabel (detailgegevens betrokken partij(en)) is verwijderd uit overige_secties; die vormde geen volwaardige, zelfstandige of unieke inhoud.');
    }
  }
  return warnings;
}

/* Ratio's zijn geen geldbedragen: eurotekens bij DSCR/LTV/Debt-EBITDA verwijderen */
function cleanRatios(r, warnings) {
  const fix = (row, key) => {
    if (typeof row?.[key] !== 'string' || !/€/.test(row[key])) return;
    if (/dscr|debt|ltv|icr|solvab|current|ratio|ebitda|loan/i.test(String(row?.ratio || ''))) {
      row[key] = row[key].replace(/€\s*/g, '').trim();
      const w = 'Euroteken bij een ratio verwijderd; ratio\u2019s zijn geen geldbedragen.';
      if (!warnings.includes(w)) warnings.push(w);
    }
  };
  for (const row of A(r.financiele_analyse?.ratios)) { fix(row, 'waarde'); fix(row, 'norm'); }
  for (const row of A(r.betaalcapaciteit?.kengetallen)) { fix(row, 'waarde'); fix(row, 'norm'); }
  for (const row of A(r.betaalcapaciteit?.dscr_overzicht)) {
    if (typeof row?.dscr === 'string' && /€/.test(row.dscr)) {
      row.dscr = row.dscr.replace(/€\s*/g, '').trim();
      const w = 'Euroteken bij een ratio verwijderd; ratio\u2019s zijn geen geldbedragen.';
      if (!warnings.includes(w)) warnings.push(w);
    }
  }
}

const EN_FIXES = [
  ['expected', 'verwacht'],
  ['fluctuations', 'schommelingen'],
  ['fluctuation', 'schommeling'],
  ['business case', 'financieringscasus'],
  ['verzuring', 'verzwaring'],
  ['verifiren', 'verifiëren'],
  ['goedgekeurd de aanvraag', 'de aanvraag goedgekeurd'],
  ['betaaldcapaciteit', 'betaalcapaciteit'],
];

/* Foutieve vaktermen die de AI soms voor de juiste bronterm invult. Let op:
   "verpand(ing)" is elders een correcte, gangbare zekerheidsterm (bijv. verpanding
   van voorraden/vorderingen) — daarom NOOIT een kale \b-woordvervanging op "verpand",
   alleen deze specifieke, foutgevoelige woordcombinaties vervangen. */
const PHRASE_FIXES = [
  [/\btreten\s+en\s+tekenen\b/gi, 'vertegenwoordigen en tekenen'],
  [/\bbevoegd\s+tot\s+het\s+namens\b/gi, 'bevoegd om namens'],
  [/\bratios\b/g, "ratio's"],
  [/\bbouwdepot\s+termijnen\b/gi, 'bouwdepottermijnen'],
  [/\btekenbevoegdheidhouder(s)?\b/gi, 'tekenbevoegd bestuurder$1'],
  [/\bHypotheekrecht\s+eerste\s+rang\s+wordt\s+te\s+vestigen\b/gi, 'Eerste hypotheekrecht op het bedrijfspand te vestigen'],
  [/\bTweede\s+hypotheek\s*privéwoning\b/gi, 'Tweede hypotheek op privéwoning'],
  [/\btijdelijke\s+krapperde\b/gi, 'tijdelijk krapper'],
  [/\bsimultane\s+lasten\b/gi, 'samenloop van lasten'],
  [/\bdistributie\s+van\s+bouwdepottermijnen\b/gi, 'gefaseerde opname uit bouwdepot'],
  [/\bIs\s+er\s+sprake\s+van\s+erfpacht\??\s*:?/gi, 'Erfpacht:'],
  [/\bverpand(?:en|t)?\s+(?:worden|word(?:t)?|zijn)\s+voor\s+verzending\b/gi, 'afgeroepen worden voor verzending'],
  [/\bverpakking\s+verpanding\b/gi, 'Vestiging van verpanding'],
  [/\beffecte\b/gi, 'effecten'],
  [/\bnieuw\s+financial\s+lease\b/gi, 'nieuwe financial lease'],
  [/\bStructurele\s+dubbel(?:e)?\s+woonlasten\b/gi, 'Tijdelijke dubbele huisvestingslasten'],
  [/\bverschil\s+btw-teruggave\s+en\s+financieringsbedrag\s+woning\b/gi, 'verwerking van btw-teruggave binnen de financieringsopzet'],
  [/\bRisicos\b/g, "Risico's"],
  [/\brisicos\b/g, "risico's"],
  [/\bContinuiteit\b/g, 'Continuïteit'],
  [/\bcontinuiteit\b/g, 'continuïteit'],
  [/\bRealizatie\b/g, 'Realisatie'],
  [/\brealizatie\b/g, 'realisatie'],
  [/Priv[eé]\s?9/g, 'Privé'],
  [/priv[eé]\s?9/g, 'privé'],
  [/\bPrive\b/g, 'Privé'],
  [/\bprive\b/g, 'privé'],
  [/\bEnergie\s*label\b/gi, 'Energielabel'],
  [/\bAantal\s+erfpachters?\s+per\s+jaar\b/gi, 'Erfpachtcanon per jaar'],
  [/\bTotaal\s+investering\b/g, 'Totale investering'],
  [/\btotaal\s+investering\b/g, 'totale investering'],
  [/\bKoosprijs\b/g, 'Koopsom'],
  [/\bkoosprijs\b/g, 'koopsom'],
  [/\b100%\s+meerderheidsaandeelhouder\b/gi, '100% aandeelhouder'],
  [/\bfinanciering wordt gedragen door\b/gi, 'financiering wordt ondersteund door'],
  [/\binkomen\s+priv[eé]\s+persoon\b/gi, 'privé-inkomen ondernemer'],
  [/\bWoz\s+waarde\b/gi, 'WOZ-waarde'],
  [/([A-Za-zÀ-ÿ])\uFFFD9/g, '$1é'],
  [/\bfinancie\s?9le\b/gi, 'financiële'],
  [/\bsamenwerking\s+van\s+(?=huur)/gi, 'samenloop van '],
  [/\bsamenwerking\s+(?=huur)/gi, 'samenloop van '],
  [/\bgeconstrueerde(?=\s+bouw)/gi, 'gefaseerde'],
  [/\bRisicomatrix met mitigatie\s*:?\s*\d+\b/gi, 'Risicomatrix'],
  [/\bbetrouwdheid\b/gi, 'betrouwbaarheid'],
  [/\bgeprognotciseerd(e)?\b/gi, 'geprognosticeerd$1'],
  [/\bpriv[eé]swoning\b/gi, 'privéwoning'],
  [/\s*Mitigaties zijn aanwezig\.?\s*/g, ' '],
  [/\bnog aan te vestigen\b/gi, 'te vestigen'],
  [/\bop te richten eerste hypotheekrecht\b/gi, 'te vestigen eerste hypotheekrecht'],
  [/\bzekerheid dekt volledig\b/gi, 'zekerheidstelling biedt een duidelijke basis voor verdere beoordeling, onder voorbehoud van definitieve vestiging en acceptatie door financier'],
  [/\bPrivepersoon\b/g, 'Privépersoon'],
  [/\bprivepersoon\b/g, 'privépersoon'],
  [/\bwordt beïnvloedt\b/gi, 'wordt beïnvloed'],
  [/\brente betalingen\b/gi, 'rentebetalingen'],
  [/\bovergangsjaar gesloten financiering\b/gi, 'tijdelijk verhoogd door de bouw- en overgangsfase'],
  [/\bjuridische formele aspecten\b/gi, 'juridische formaliteiten'],
  [/\s*Privacygevoelige gegevens van privépersonen en achterliggende vennootschappen zijn opgenomen\.?\s*/gi, ' '],
  [/\bsubstantifte\b/gi, 'substantiële'],
  [/\bprivé\s+persoon\b/gi, 'privépersoon'],
  [/\bWoz\b/g, 'WOZ'],
  [/\baflossingsvrij\s+periode\b/gi, 'aflossingsvrije periode'],
  [/\bwordt\s+gedekt\s+door\b/gi, 'wordt ondersteund door'],
  [/\bzekerheid\s+is\s+aanwezig\b/gi, 'is voorzien als aanvullende zekerheid'],
  [/\bdekt\s+(de\s+)?(lening|financiering)\s+volledig\b/gi, 'biedt een duidelijke basis voor verdere beoordeling, onder voorbehoud van definitieve vestiging en acceptatie door financier'],
  [/\bhoofdelijke\s+aansprakelijkheid\s+te\s+vestigen\b/gi, 'eventuele hoofdelijke aansprakelijkheid / borgstelling nader af te stemmen'],
  [/\bMaterie(l|le)\s+vaste\s+activa\b/gi, 'Materiële vaste activa'],
  [/\bImmaterie(l|le)\s+vaste\s+activa\b/gi, 'Immateriële vaste activa'],
  [/\bFinancie(l|le)\s+vaste\s+activa\b/gi, 'Financiële vaste activa'],
];

/* Eurotekens die door PDF-tekstextractie zijn verminkt (bijv. bij Type3/custom-font
   PDF's) komen soms als replacement character (�) of als "EUR 123"/"123 euro" terug.
   Normaliseer dit altijd naar "€ 123", vóórdat de tekst het rapport bereikt. */
function fixEuroSigns(v) {
  let out = v
    /* Bij sommige PDF-lettertypen wordt het eurosymbool geëxtraheerd als
       replacement-character + een losse "9" (niet kaal). Deze variant moet
       vóór de kale vervanging worden gefixt, anders blijft de "9" als stray
       cijfer vóór het bedrag staan (bijv. "€ 9 75.400" i.p.v. "€ 75.400"). */
    .replace(/�9\s?(?=\d)/g, '€ ')
    .replace(/\uFFFD\s?(?=\d)/g, '€ ')
    .replace(/\bEUR\s?(?=\d)/gi, '€ ')
    .replace(/(\d[\d.,]*)\s?euro\b/gi, '€ $1');
  return out;
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
    /* Klantcorrectie: een tekstblok dat afbreekt op een openstaande
       opsommingsaankondiging ("... (o.a." zonder vervolg, of "e.d."/"enz."/
       "etc." als allerlaatste woord) is net zo'n afgekapt fragment als "..."
       — de aankondiging wordt dan simpelweg verwijderd en de zin netjes met
       een punt afgesloten (bijv. "de toelichting op de terugbetaalcapaciteit
       (o.a." wordt "de toelichting op de terugbetaalcapaciteit."). */
    if (/\(?\s*(o\.a\.|e\.d\.|enz\.|etc\.)\s*$/i.test(v.trim()) && v.trim().length > 20) {
      v = v.trim().replace(/\s*\(?\s*(o\.a\.|e\.d\.|enz\.|etc\.)\s*$/i, '.');
      const w = 'Afgebroken opsommingsaankondiging (bijv. "(o.a." zonder vervolg) aan het einde van een tekstblok verwijderd; controleer of de zin nog logisch afsluit.';
      if (!warnings.includes(w)) warnings.push(w);
    }
    if (/^(undefined|null|NaN|\[object Object\])$/i.test(v.trim())) return '';
    if (v.trim().length >= 20) {
      const BROKEN_LEAD_RE = /^(,|\()|^[o0]{2,4}(\s+in\s+\d{4}\b|\s*[,.]|\s)/i;
      let fragmentVerwijderd = false;
      /* 1 — alineaniveau: de renderer (paraBlocks) splitst zelf al op een
         dubbele regelafbreking, ONGEACHT of daarvóór een punt staat — een
         afgebroken alinea zoals "…administratie\n\n000 in 2028, met…" heeft
         vaak GEEN punt vóór de eigen regelafbreking (een kale, uit de bron
         overgenomen paragraafbreuk). De eerdere, uitsluitend zin-gebaseerde
         detectie (hieronder) miste dit geval juist daardoor: zonder een punt
         ervoor werd het fragment nooit als aparte "zin" gezien en dus nooit
         getoetst. Alinea's worden daarom eerst apart gecontroleerd. */
      const paragrafen = v.split(/\n{2,}/);
      if (paragrafen.length >= 2) {
        const paraGefilterd = paragrafen.filter((p) => !BROKEN_LEAD_RE.test(p.trim()));
        if (paraGefilterd.length < paragrafen.length) {
          v = paraGefilterd.join('\n\n');
          fragmentVerwijderd = true;
        }
      }
      /* 2 — zinsniveau binnen wat overblijft (bestaande detectie, voor een
         afgebroken fragment ná een punt maar vóór de volgende hoofdletter). */
      const zinnen = v.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9(])/);
      if (zinnen.length >= 2) {
        const gefilterd = zinnen.filter((zin) => !BROKEN_LEAD_RE.test(zin.trim()));
        if (gefilterd.length < zinnen.length) {
          v = gefilterd.join(' ').replace(/\s{2,}/g, ' ').trim();
          fragmentVerwijderd = true;
        }
      }
      if (fragmentVerwijderd) {
        const w = 'Een afgebroken zinfragment (bijv. een restant van een afgekapt bedrag of jaartal) is uit de rapporttekst verwijderd; controleer dit hoofdstuk op volledigheid.';
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    const beforeEuro = v;
    v = fixEuroSigns(v);
    if (v !== beforeEuro) {
      const w = 'Verminkt eurosymbool in de brontekst genormaliseerd naar "€".';
      if (!warnings.includes(w)) warnings.push(w);
    }
    for (const [en, nl] of EN_FIXES) {
      const re = new RegExp('\\b' + en + '\\b', 'gi');
      if (re.test(v)) {
        v = v.replace(re, nl);
        const w = 'Engelse of foutieve restterm gecorrigeerd in de rapporttekst; door adviseur te controleren.';
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
    for (const [re, nl] of PHRASE_FIXES) {
      /* .replace() met een /g-regex begint altijd bij index 0 (self-resettend),
         in tegenstelling tot .test() op een gedeeld /g-regex-object — dat zou
         lastIndex laten "doorlekken" naar de volgende string in deze recursie. */
      const before = v;
      v = v.replace(re, nl);
      if (v !== before) {
        const w = 'Foutieve vakterm gecorrigeerd in de rapporttekst; door adviseur te controleren.';
        if (!warnings.includes(w)) warnings.push(w);
      }
    }
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
  'Op basis van de beschikbare informatie kan nog geen definitief oordeel worden gevormd. Aanvullende bankopgaven en financiële onderbouwing zijn noodzakelijk voor verdere beoordeling.';

const FORBIDDEN_CLAIMS =
  /(verantwoord en betaalbaar|zonder meer worden verstrekt|bankwaardig rapport|sterk onderbouwd|duurzaam draagbaar|geen noemenswaardige risico'?s|financiering kan worden verstrekt|definitief akkoord)/i;

/* Herkent een rommelig/onbetrouwbaar organogram, ook als het model de
   promptinstructies niet volgt: dubbele entiteiten, dubbele relaties tussen
   dezelfde twee partijen, dubbele 100%-relaties vanuit dezelfde entiteit, of
   relaties die naar een niet-bestaande entiteit verwijzen. Dit is de server-
   side vangnet-laag naast de promptinstructies — een organogram dat hierop
   struikelt wordt nooit getoond, ook al zei de AI zelf aanwezig=true. */
function isMessyOrganogram(org) {
  if (!org || org.aanwezig !== true) return false;
  const entiteiten = A(org.entiteiten);
  const relaties = A(org.relaties);
  if (!entiteiten.length || !relaties.length) return true;

  const norm = (x) => String(x || '').toLowerCase().replace(/\s+/g, ' ').trim();
  const namen = entiteiten.map((e) => norm(e?.naam)).filter(Boolean);
  if (new Set(namen).size < namen.length) return true; // dubbele entiteitsnaam

  const ids = entiteiten.map((e) => norm(e?.id)).filter(Boolean);
  if (new Set(ids).size < ids.length) return true; // dubbel entiteits-id

  const geldigeRef = new Set([...ids, ...namen]);
  const brokenRef = relaties.some((r) => !geldigeRef.has(norm(r?.van)) || !geldigeRef.has(norm(r?.naar)));
  if (brokenRef) return true; // relatie verwijst naar onbekende entiteit

  const relKey = (r) => `${norm(r?.van)}→${norm(r?.naar)}`;
  const relKeys = relaties.map(relKey);
  if (new Set(relKeys).size < relKeys.length) return true; // dubbele relatie tussen dezelfde twee partijen

  const per100Van = {};
  for (const r of relaties) {
    if (!/^100\s*%$/.test(String(r?.label || '').trim())) continue;
    const key = norm(r?.van);
    per100Van[key] = (per100Van[key] || 0) + 1;
  }
  if (Object.values(per100Van).some((n) => n > 1)) return true; // dubbel 100%-label vanuit dezelfde entiteit

  /* Ongeldige percentagelabels (bijv. "1100%" — een evidente fabricage- of
     samenvoegingsfout, geen realistisch aandelenpercentage) maken het
     organogram ook onbetrouwbaar: een percentage hoort altijd tussen 0 en 100
     te liggen. Zo'n organogram valt terug op het tekstuele structuurschema. */
  const ongeldigPercentage = relaties.some((r) => {
    const m = String(r?.label || '').trim().match(/^(\d{1,4}(?:[.,]\d+)?)\s*%$/);
    if (!m) return false;
    const n = parseFloat(m[1].replace(',', '.'));
    return !(n >= 0 && n <= 100);
  });
  if (ongeldigPercentage) return true;

  return false;
}

/* Balansposten en winst-en-verliesposten mogen nooit in elkaars tabel staan
   (layoutregel 3). Dit is een server-side correctie (geen losse waarschuwing):
   staat een post die overduidelijk een balanspost is (vaste/vlottende activa,
   liquide middelen, totaal activa, eigen vermogen, langlopende/kortlopende
   schulden, totaal passiva) toch in fa.resultaten, dan wordt hij verplaatst
   naar fa.balans — en omgekeerd voor een overduidelijke winst-en-verliespost
   die in fa.balans staat. Een post die aan geen van beide of aan BEIDE
   patronen voldoet (dubbelzinnig) wordt niet verplaatst, om geen data te
   verliezen op basis van een onzekere classificatie. */
const RESULTAAT_ONLY_RE = /omzet|bedrijfsopbrengsten|bedrijfsresultaat|^ebitda?$|financi[eë]le\s+baten|resultaat[^]*voor[^]*belasting|^belasting(en)?$|resultaat[^]*na[^]*belasting|^(bedrijfs)?kosten$|bedrijfslasten/i;
const BALANS_ONLY_RE = /vaste\s+activa|vlottende\s+activa|liquide\s+middelen|totaal\s+activa|eigen\s*vermogen|langlopende?\s+schuld|kortlopende?\s+schuld|totaal\s+passiva/i;
/* Afschrijvingen zijn altijd een resultatenpost (winst-en-verliesrekening),
   ook al noemt het label "(im)materiële vaste activa" — daardoor zou de
   generieke BALANS_ONLY_RE-toets ("vaste activa") deze post anders ten
   onrechte als balanspost classificeren. Deze klantcorrectie krijgt daarom
   expliciet voorrang boven de generieke classificatie hieronder. */
const AFSCHRIJVING_RE = /afschrijving|amortisatie|waardevermindering/i;
function enforceFinancialStatementSeparation(r, internal) {
  const fa = r.financiele_analyse;
  if (!fa) return;
  const balansIn = Array.isArray(fa.balans) ? fa.balans : [];
  const resultatenIn = Array.isArray(fa.resultaten) ? fa.resultaten : [];

  const resultatenStay = [];
  const fromResultatenToBalans = [];
  for (const row of resultatenIn) {
    const label = String(row?.label || '');
    if (AFSCHRIJVING_RE.test(label)) { resultatenStay.push(row); continue; }
    if (BALANS_ONLY_RE.test(label) && !RESULTAAT_ONLY_RE.test(label)) fromResultatenToBalans.push(row);
    else resultatenStay.push(row);
  }

  const balansStay = [];
  const fromBalansToResultaten = [];
  for (const row of balansIn) {
    const label = String(row?.label || '');
    if (AFSCHRIJVING_RE.test(label)) { fromBalansToResultaten.push(row); continue; }
    if (RESULTAAT_ONLY_RE.test(label) && !BALANS_ONLY_RE.test(label)) fromBalansToResultaten.push(row);
    else balansStay.push(row);
  }

  if (fromResultatenToBalans.length || fromBalansToResultaten.length) {
    fa.resultaten = [...resultatenStay, ...fromBalansToResultaten];
    fa.balans = [...balansStay, ...fromResultatenToBalans];
    const parts = [];
    if (fromResultatenToBalans.length) {
      parts.push(`${fromResultatenToBalans.length} balanspost(en) (${fromResultatenToBalans.map((x) => x.label).join(', ')}) stonden in resultaten en zijn verplaatst naar balans`);
    }
    if (fromBalansToResultaten.length) {
      parts.push(`${fromBalansToResultaten.length} resultaatpost(en) (${fromBalansToResultaten.map((x) => x.label).join(', ')}) stonden in balans en zijn verplaatst naar resultaten`);
    }
    internal.push(`Financiële analyse: ${parts.join('; ')}.`);
  }
}

/* Financiële posten horen voor eenzelfde jaar wezenlijk andere bedragen te
   zijn. Als de AI 3 of meer WEZENLIJK VERSCHILLENDE posten voor hetzelfde jaar
   met exact hetzelfde, niet-nul bedrag teruggeeft, is dat een signaal van een
   mogelijk gefabriceerd/gedupliceerd cijfer (bijv. het resultaat hergebruikt
   als liquide middelen bij ontbrekende balansdata) — dit wordt gelogd als
   controlepunt voor de adviseur. Bedragen worden hier NIET meer automatisch
   verwijderd (zie hieronder): een eerdere, strengere versie van deze controle
   verwijderde bij twijfel ook echte cijfers, wat in de praktijk tot onterecht
   ontbrekende liquide middelen/eigen vermogen/resultaatcijfers leidde — en
   "geen bekende cijfers vervangen door een streepje" weegt zwaarder dan het
   onderscheppen van een zeldzame, hypothetische fabricage. Bedragen van € 0
   worden bij deze signalering sowieso genegeerd: een nul is voor veel posten
   (financiële baten en lasten, belasting, kortlopende schulden, enz.) een
   volstrekt legitieme, veelvoorkomende waarde en geen fabricagesignaal. */
/* Exact dubbele regels (zelfde post + zelfde periode) in balans of resultaten
   verwijderen — bijv. "Materiële vaste activa" die twee keer voor hetzelfde
   jaar is opgenomen. Bij een dubbele match met één keer een bekend bedrag en
   één keer null wordt de rij met het bekende bedrag behouden. */
function dedupeFinancieleAnalyseRegels(r, internal) {
  const fa = r.financiele_analyse;
  if (!fa) return;
  const dedupe = (arr, naam) => {
    const rows = A(arr);
    const seen = new Map();
    const out = [];
    let verwijderd = 0;
    for (const row of rows) {
      if (!row || !hasTxt(row.label) || !hasTxt(row.periode)) { out.push(row); continue; }
      const key = `${String(row.label).trim().toLowerCase()}|${String(row.periode).trim().toLowerCase()}`;
      if (seen.has(key)) {
        const idx = seen.get(key);
        if (out[idx] && num(out[idx].bedrag) === null && num(row.bedrag) !== null) out[idx] = row;
        verwijderd++;
        continue;
      }
      seen.set(key, out.length);
      out.push(row);
    }
    if (verwijderd) internal.push(`Financiële analyse (${naam}): ${verwijderd} exact dubbele regel(s) (zelfde post + periode) verwijderd.`);
    return out;
  };
  fa.balans = dedupe(fa.balans, 'balans');
  fa.resultaten = dedupe(fa.resultaten, 'resultaten');
}

/* Een balans zonder "Totaal passiva" oogt onaf en maakt de balans niet
   controleerbaar (Totaal activa moet immers altijd gelijk zijn aan Totaal
   passiva — de grondbeginsel van een balans). Ontbreekt deze regel voor een
   periode terwijl "Totaal activa" wel bekend is, dan wordt Totaal passiva
   voor die periode gelijkgesteld aan Totaal activa: dit is geen verzonnen
   cijfer maar een boekhoudkundige identiteit (activa = passiva per
   definitie), dus veilig om automatisch aan te vullen. */
function ensureTotaalPassiva(r, internal) {
  const fa = r.financiele_analyse;
  const rows = A(fa?.balans);
  if (!rows.length) return;
  const isLabel = (row, re) => row && hasTxt(row.label) && re.test(String(row.label).trim());
  const totaalActivaRe = /^totaal\s+activa$/i;
  const totaalPassivaRe = /^totaal\s+passiva$/i;
  const periodesActiva = new Map();
  for (const row of rows) {
    if (isLabel(row, totaalActivaRe) && hasTxt(row.periode) && num(row.bedrag) !== null) {
      periodesActiva.set(String(row.periode).trim(), num(row.bedrag));
    }
  }
  if (!periodesActiva.size) return;
  const periodesPassiva = new Set(
    rows.filter((row) => isLabel(row, totaalPassivaRe) && hasTxt(row.periode) && num(row.bedrag) !== null).map((row) => String(row.periode).trim())
  );
  const toegevoegd = [];
  for (const [periode, bedrag] of periodesActiva) {
    if (!periodesPassiva.has(periode)) {
      rows.push({ label: 'Totaal passiva', periode, bedrag });
      toegevoegd.push(periode);
    }
  }
  if (toegevoegd.length) {
    fa.balans = rows;
    internal.push(`Financiële analyse (balans): "Totaal passiva" ontbrak voor periode(s) ${toegevoegd.join(', ')} en is aangevuld gelijk aan "Totaal activa" (boekhoudkundige identiteit activa = passiva).`);
  }
}

/* Kostensom-controle: als de bron zowel de individuele kostenposten als een
   expliciete "Totaal bedrijfskosten"-regel geeft, wordt gecontroleerd of de
   som van de onderliggende posten aansluit op dat totaal. Bij een afwijking
   wordt dit alleen gesignaleerd (waarschuwing) — het bronbedrag van "Totaal
   bedrijfskosten" wordt NOOIT overschreven door een eigen berekening. */
function checkTotaalBedrijfskostenSom(r, warnings) {
  const rows = A(r.financiele_analyse?.resultaten);
  if (rows.length < 2) return;
  const KOSTEN_ONDERDEEL_RE = /kosten\s+van\s+grond-?\s*(en)?\s*hulpstoffen|personeelsbeloningen|personeelskosten|^afschrijvingen\b|overige\s+bedrijfskosten/i;
  const TOTAAL_RE = /^totaa?l\s+(bedrijfs)?kosten$|^totale\s+kosten$/i;
  const perPeriode = new Map();
  for (const row of rows) {
    if (!row || !hasTxt(row.label) || !hasTxt(row.periode)) continue;
    const p = String(row.periode).trim();
    const bedrag = num(row.bedrag);
    if (bedrag === null) continue;
    if (!perPeriode.has(p)) perPeriode.set(p, { onderdelen: 0, totaal: null });
    const entry = perPeriode.get(p);
    if (KOSTEN_ONDERDEEL_RE.test(row.label)) entry.onderdelen += bedrag;
    else if (TOTAAL_RE.test(row.label)) entry.totaal = bedrag;
  }
  for (const [periode, entry] of perPeriode) {
    if (entry.totaal === null || entry.onderdelen === 0) continue;
    const verschil = Math.abs(entry.totaal - entry.onderdelen);
    if (verschil > Math.max(1, Math.abs(entry.totaal) * 0.01)) {
      warnings.push(`Eindcontrole: de som van de onderliggende kostenposten in periode ${periode} (€ ${Math.round(entry.onderdelen).toLocaleString('nl-NL')}) wijkt af van "Totaal bedrijfskosten" uit de bron (€ ${Math.round(entry.totaal).toLocaleString('nl-NL')}); neem het brontotaal exact over en verifieer de onderliggende posten, in plaats van een eigen berekening toe te voegen.`);
    }
  }
}

/* Klantcorrectie: een observatie als "stijgt van € 54.913 naar € 28.948" is
   feitelijk onjuist (28.948 is lager dan 54.913) en ondermijnt de
   geloofwaardigheid van het rapport. Dit wordt gedetecteerd door het eerste
   en laatste bedrag in een "van X ... naar Y"-constructie te vergelijken met
   het gebruikte trendwoord (stijgt/groeit/neemt toe vs. daalt/neemt af); bij
   een tegenstrijdigheid wordt het trendwoord automatisch omgezet naar het
   juiste tegenovergestelde (tool-correctie) — de onderliggende cijfers zelf
   worden nooit aangepast, alleen de bewering erover. */
const STIJG_NAAR_DAAL = {
  stijgt: 'daalt', stijgen: 'dalen', steeg: 'daalde', stegen: 'daalden',
  groeit: 'daalt', groeien: 'dalen', groeide: 'daalde', groeiden: 'daalden',
  'neemt toe': 'neemt af', 'nemen toe': 'nemen af', 'nam toe': 'nam af', 'namen toe': 'namen af',
};
const DAAL_NAAR_STIJG = {
  daalt: 'stijgt', dalen: 'stijgen', daalde: 'steeg', daalden: 'stegen',
  'neemt af': 'neemt toe', 'nemen af': 'nemen toe', 'nam af': 'nam toe', 'namen af': 'namen toe',
};
const STIJG_WOORD_RE = /\b(stijgt|stijgen|steeg|stegen|groeit|groeien|groeide|groeiden|neemt\s+toe|nemen\s+toe|nam\s+toe|namen\s+toe)\b/i;
const DAAL_WOORD_RE = /\b(daalt|dalen|daalde|daalden|neemt\s+af|nemen\s+af|nam\s+af|namen\s+af)\b/i;
const VAN_NAAR_BEDRAG_RE = /van\s*€?\s*([\d.,]+)[\s\S]{0,60}?naar\s*€?\s*([\d.,]+)/i;
function fixObservatieTrendRichting(r, warnings) {
  const fa = r.financiele_analyse;
  const obs = A(fa?.observaties);
  if (!obs.length) return;
  const parseNum = (s) => parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  const herstel = (woord, map) => {
    const key = woord.toLowerCase().replace(/\s+/g, ' ').trim();
    const vervanging = map[key];
    if (!vervanging) return woord;
    if (woord[0] === woord[0].toUpperCase()) return vervanging.charAt(0).toUpperCase() + vervanging.slice(1);
    return vervanging;
  };
  let gewijzigd = 0;
  fa.observaties = obs.map((tekst) => {
    if (typeof tekst !== 'string') return tekst;
    const m = tekst.match(VAN_NAAR_BEDRAG_RE);
    if (!m) return tekst;
    const a = parseNum(m[1]);
    const b = parseNum(m[2]);
    if (!isFinite(a) || !isFinite(b) || a === b) return tekst;
    if (b < a && STIJG_WOORD_RE.test(tekst)) {
      gewijzigd++;
      return tekst.replace(STIJG_WOORD_RE, (w) => herstel(w, STIJG_NAAR_DAAL));
    }
    if (b > a && DAAL_WOORD_RE.test(tekst)) {
      gewijzigd++;
      return tekst.replace(DAAL_WOORD_RE, (w) => herstel(w, DAAL_NAAR_STIJG));
    }
    return tekst;
  });
  if (gewijzigd) {
    warnings.push(`Eindcontrole: ${gewijzigd} observatie(s) in de financiële analyse spraken van een stijging/daling die niet overeenkwam met de genoemde bedragen; het trendwoord is gecorrigeerd naar het tegenovergestelde. Controleer of de zin ook de juiste nuance beschrijft (bijv. een dip in een tussenjaar gevolgd door herstel, in plaats van alleen "daalt" over de hele periode).`);
  }
}

/* De resultatenrekening moet een echte winst-en-verliesrekening zijn (Omzet →
   kostenuitsplitsing → Bedrijfsresultaat → Resultaat na belasting), geen kale
   sprong van omzet naar resultaat. Staat er wel een bedrijfsresultaat/resultaat
   na belasting maar ONTBREEKT elke granulaire kostenpost, dan is de tabel
   inhoudelijk onvolledig — dit wordt gesignaleerd zodat de adviseur de bron
   (of een hergeneratie) op de ontbrekende kostenuitsplitsing controleert. */
function enforceResultatenVolledigheid(r, warnings) {
  const rows = A(r.financiele_analyse?.resultaten);
  if (!rows.length) return;
  const heeftLabel = (re) => rows.some((row) => row && hasTxt(row.label) && re.test(String(row.label).trim()));
  const heeftEindresultaat = heeftLabel(/^bedrijfsresultaat$|^ebitda?$/i) || heeftLabel(/resultaat[^]*na[^]*belasting/i);
  if (!heeftEindresultaat) return;
  const KOSTEN_ONDERDEEL_RE = /kosten\s+van\s+grond-?\s*(en)?\s*hulpstoffen|personeelsbeloningen|personeelskosten|^afschrijvingen\b|overige\s+bedrijfskosten|^(bedrijfs)?kosten$|^bedrijfslasten$/i;
  if (!heeftLabel(KOSTEN_ONDERDEEL_RE)) {
    warnings.push('Eindcontrole: de resultatenrekening toont een bedrijfsresultaat/resultaat na belasting maar geen enkele onderliggende kostenpost (kosten van grond-/hulpstoffen, personeelsbeloningen, afschrijvingen, overige bedrijfskosten); vul de kostenuitsplitsing aan vanuit de bron zodat het KOSTEN-blok niet leeg blijft.');
  }
}

/* "Bedrijfsopbrengsten" die voor elk jaar exact hetzelfde bedrag toont als
   "Omzet" voegt niets toe (vrijwel altijd is dit dezelfde post twee keer
   gelabeld) — verwijder dan de Bedrijfsopbrengsten-regel en behoud Omzet. */
function dedupeOmzetBedrijfsopbrengsten(r, internal) {
  const fa = r.financiele_analyse;
  const rows = A(fa?.resultaten);
  if (rows.length < 2) return;
  const omzet = rows.filter((x) => x && /^(netto[- ]?)?omzet$/i.test(String(x.label || '').trim()));
  const opbrengsten = rows.filter((x) => x && /^bedrijfsopbrengsten$/i.test(String(x.label || '').trim()));
  if (!omzet.length || !opbrengsten.length) return;
  const omzetPerPeriode = new Map(omzet.map((x) => [String(x.periode || '').trim().toLowerCase(), num(x.bedrag)]));
  const identiek = opbrengsten.filter((o) => {
    const p = String(o.periode || '').trim().toLowerCase();
    const ov = num(o.bedrag);
    return omzetPerPeriode.has(p) && ov !== null && omzetPerPeriode.get(p) === ov;
  });
  /* Alleen verwijderen als ALLE Bedrijfsopbrengsten-regels overeenkomen met
     Omzet (anders is het kennelijk een wezenlijk andere, bredere post en
     blijft hij staan). */
  if (identiek.length && identiek.length === opbrengsten.length) {
    fa.resultaten = rows.filter((x) => !opbrengsten.includes(x));
    internal.push(`Financiële analyse: "Bedrijfsopbrengsten" was voor elk jaar identiek aan "Omzet" en is als dubbele regel verwijderd (${identiek.length} periode(s)).`);
  }
}

function enforceFinancialFigureQuality(r, internal) {
  const fa = r.financiele_analyse;
  if (!fa || (!Array.isArray(fa.resultaten) && !Array.isArray(fa.balans))) return;
  const norm = (x) => String(x || '').trim();
  const groups = {};
  const collect = (arrName) => {
    const arr = fa[arrName];
    if (!Array.isArray(arr)) return;
    arr.forEach((row, idx) => {
      const periode = norm(row?.periode);
      /* Nul-bedragen bewust uitsluiten van deze fabricagecontrole (zie
         toelichting hierboven) — alleen niet-nul bedragen kunnen hier een
         verdachte, gedupliceerde samenloop opleveren. */
      if (!periode || typeof row?.bedrag !== 'number' || row.bedrag === 0) return;
      (groups[periode] = groups[periode] || []).push({ arrName, idx, label: norm(row.label), bedrag: row.bedrag });
    });
  };
  collect('resultaten');
  collect('balans');
  /* Signaleren, niet verwijderen: "geen bekende cijfers vervangen door een
     streepje" weegt zwaarder dan het onderscheppen van een zeldzame,
     hypothetische fabricage. Elk gesignaleerd geval wordt als controlepunt
     gelogd zodat de adviseur het kan verifiëren, maar de cijfers zelf blijven
     altijd gewoon in het rapport staan. */
  for (const periode of Object.keys(groups)) {
    const byBedrag = {};
    for (const row of groups[periode]) {
      (byBedrag[row.bedrag] = byBedrag[row.bedrag] || []).push(row);
    }
    for (const bedrag of Object.keys(byBedrag)) {
      const dupRows = byBedrag[bedrag];
      if (dupRows.length < 3) continue; // alleen 3+ gelijke posten is een signaal
      internal.push(
        `Controlepunt (geen wijziging): financiële analyse ${periode} — posten (${dupRows.map((d) => d.label).join(', ')}) hebben allemaal exact hetzelfde bedrag (${bedrag}); verifieer of dit werkelijk zo in de bron staat. De cijfers zijn NIET verwijderd.`
      );
    }
  }
}

/* Signaleert (verwijdert niets automatisch) een verdacht cijfergat: een post
   die voor een tussenliggend jaar ontbreekt terwijl eerdere én latere jaren
   wél een bedrag hebben, of die voor het meest recente jaar ontbreekt
   ("—") terwijl het jaar ervoor wel een bedrag heeft — vaak een teken dat een
   bekend bedrag uit de bron is weggevallen (bijv. afschrijvingen die voor het
   laatste jaar niet zijn meegenomen) in plaats van een echte lege waarde. */
function enforceGeenVerdachteCijferGaten(r, warnings) {
  const fa = r.financiele_analyse;
  if (!fa) return;
  const sortPeriods = (ps) =>
    [...ps].sort((a, b) => {
      const ay = parseInt((String(a).match(/\d{4}/) || [])[0] || '0', 10);
      const by = parseInt((String(b).match(/\d{4}/) || [])[0] || '0', 10);
      if (ay !== by) return ay - by;
      return String(a).localeCompare(String(b));
    });
  const check = (arr, naam) => {
    const rows = A(arr).filter((x) => x && hasTxt(x?.label) && hasTxt(x?.periode));
    const periods = sortPeriods([...new Set(rows.map((x) => String(x.periode).trim()))]);
    if (periods.length < 3) return;
    const byLabel = new Map();
    for (const row of rows) {
      const key = String(row.label).trim();
      if (!byLabel.has(key)) byLabel.set(key, new Map());
      byLabel.get(key).set(String(row.periode).trim(), num(row.bedrag));
    }
    const gemeld = new Set();
    for (const [label, vals] of byLabel) {
      const present = periods.map((p) => vals.has(p) && vals.get(p) !== null);
      const firstIdx = present.indexOf(true);
      const lastIdx = present.lastIndexOf(true);
      if (firstIdx === -1) continue;
      /* interne hiaat: bekend … ontbrekend … bekend */
      if (lastIdx > firstIdx && present.slice(firstIdx, lastIdx + 1).some((v) => !v) && !gemeld.has(label)) {
        gemeld.add(label);
        warnings.push(`Eindcontrole: post "${label}" in ${naam} ontbreekt voor een tussenliggend jaar terwijl eerdere en latere jaren wel een bedrag hebben; controleer of dit een echt ontbrekend cijfer is en niet een abusievelijk weggevallen bedrag uit de bron.`);
        continue;
      }
      /* eindhiaat: laatste (meest recente) jaar ontbreekt, jaar ervoor wel bekend */
      const laatsteIdx = periods.length - 1;
      if (laatsteIdx > 0 && !present[laatsteIdx] && present[laatsteIdx - 1] && !gemeld.has(label)) {
        gemeld.add(label);
        warnings.push(`Eindcontrole: post "${label}" in ${naam} ontbreekt voor het meest recente jaar (${periods[laatsteIdx]}) terwijl ${periods[laatsteIdx - 1]} wel een bedrag heeft; controleer of de bron voor dit jaar echt geen cijfer geeft.`);
      }
    }
  };
  check(fa.resultaten, 'de resultatenontwikkeling');
  check(fa.balans, 'de balansontwikkeling');
}

function enforceOrgDiagramQuality(r, warnings, internal) {
  const ju = (r.juridische_structuur = r.juridische_structuur || {});
  for (const key of ['organogram_bestaand', 'organogram_nieuw']) {
    const org = ju[key];
    if (org?.aanwezig === true && isMessyOrganogram(org)) {
      org.aanwezig = false;
      internal.push(`${key}: organogram leek rommelig of inconsistent (dubbele entiteiten/relaties, dubbele 100%-labels of een gebroken verwijzing) en is daarom vervangen door het tekstuele structuurschema.`);
      if (!A(ju.structuur_tekstueel).filter(hasTxt).length) {
        warnings.push('Het aangeleverde organogram kon niet betrouwbaar worden weergegeven; controleer of de groepsstructuur volledig en correct in de tekst is beschreven.');
      }
    }
  }
}

/* Handmatig door de adviseur aangeleverd structuurschema (tekst, zelf ingevoerd,
   of een afbeelding) krijgt hier altijd voorrang boven wat de AI zelf verzon —
   ongeacht of het model de promptinstructie (buildStructOverrideBlock) volgde.
   Bij tekst/handmatig wordt structuur_tekstueel volledig overschreven met de
   letterlijke, ongewijzigde regels van de adviseur; bij een afbeelding wordt
   alleen het AI-organogram uitgeschakeld (de afbeelding zelf wordt client-side
   geplaatst, met de bytes die de browser al lokaal heeft). */
/* Objecthoofdstuk (object_en_vastgoed): LTV altijd als percentage tonen, en
   risicomatrix-achtige formuleringen (kans/impact/mitigant) horen hier nooit
   thuis — dat is uitsluitend het hoofdstuk Risico's, mitiganten & aandachtspunten. */
function normalizeLtvValue(v) {
  if (typeof v !== 'string') return v;
  const t = v.trim();
  if (!t || /%/.test(t)) return v;
  const f = parseFloat(t.replace(',', '.'));
  if (!(f > 0 && f < 1)) return v;
  const pct = Math.round(f * 1000) / 10;
  const pctStr = (Number.isInteger(pct) ? String(pct) : String(pct).replace('.', ',')) + '%';
  return pctStr;
}
const RISICOMATRIX_WOORDEN_RE = /\b(kans|impact|mitigant|risicomatrix|gemitigeerd|mitigeren|mitigerende?)\b/i;
/* Algemene bedrijfs-/risico-onderwerpen die uitsluitend in het hoofdstuk
   Risico's, mitiganten & aandachtspunten (of Juridische structuur,
   activiteiten & strategie voor de kale bedrijfsomschrijving) thuishoren —
   nooit in het objecthoofdstuk, dat zich beperkt tot object, taxatiewaarde,
   LTV, erfpacht, gebruik, zekerheden en dekkingspositie. */
const OBJECT_OFF_TOPIC_RE = /ondernemersafhankelijkheid|dubbele\s+lasten|omzetgroei|omzetontwikkeling|omzetverdeling|marktrisico|debiteuren|crediteuren|werkkapitaal|voorraadrisico|prognoserisico|schaalgrootte|klantconcentratie|afnemersafhankelijkheid|handel\s+in\s+gebruikte|actief\s+sinds\s+\d{4}\s+in\b|gemitigeerd|mitigerend|worden\s+gemitigeerd|\bmitigant(en)?\b|\brisicomatrix\b/i;
function stripObjectOffTopicText(v) {
  if (typeof v !== 'string' || v.trim().length < 20) return v;
  const zinnen = v.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9(])/);
  /* Bestaat het veld uit één enkele "zin" die zelf volledig risico-/mitigant-
     taal is (bijv. een kort dekkingspositie-veld dat niets anders bevat),
     dan is er niets om "omheen" te behouden — het veld wordt dan leeggemaakt
     in plaats van ongewijzigd te blijven. */
  if (zinnen.length < 2) return OBJECT_OFF_TOPIC_RE.test(v) ? '' : v;
  const gefilterd = zinnen.filter((zin) => !OBJECT_OFF_TOPIC_RE.test(zin));
  if (gefilterd.length === zinnen.length) return v;
  return gefilterd.join(' ').replace(/\s{2,}/g, ' ').trim();
}
function enforceObjectChapterQuality(r, internal) {
  const fo = r.financieringsopzet || {};
  const kc = fo.kerncijfers;
  if (kc && typeof kc.ltv === 'string') {
    const before = kc.ltv;
    kc.ltv = normalizeLtvValue(kc.ltv);
    if (kc.ltv !== before) internal.push(`kerncijfers.ltv "${before}" genormaliseerd naar "${kc.ltv}".`);
  }
  const ov = (r.object_en_vastgoed = r.object_en_vastgoed || {});
  if (hasTxt(ov.tekst) && OBJECT_OFF_TOPIC_RE.test(ov.tekst)) {
    const before = ov.tekst;
    ov.tekst = stripObjectOffTopicText(ov.tekst);
    if (ov.tekst !== before) {
      internal.push('Algemene bedrijfs-/risicotekst (bijv. ondernemersafhankelijkheid, dubbele lasten, omzetgroei, bedrijfsactiviteiten) verwijderd uit object_en_vastgoed.tekst; dit hoort uitsluitend in het hoofdstuk Risico\'s of Juridische structuur & activiteiten.');
    }
  }
  ov.kenmerken = A(ov.kenmerken).map((k) => {
    if (!k || !hasTxt(k.label)) return k;
    if (!/\bltv\b/i.test(String(k.label))) return k;
    const before = k.waarde;
    const na = normalizeLtvValue(k.waarde);
    if (na !== before) internal.push(`object_en_vastgoed.kenmerken LTV-waarde "${before}" genormaliseerd naar "${na}".`);
    return { ...k, waarde: na };
  });
  const voorAP = A(ov.aandachtspunten).length;
  ov.aandachtspunten = A(ov.aandachtspunten).filter((t) => !(hasTxt(t) && (RISICOMATRIX_WOORDEN_RE.test(t) || OBJECT_OFF_TOPIC_RE.test(t))));
  if (ov.aandachtspunten.length < voorAP) {
    internal.push('Risicomatrix-achtige tekst of algemene bedrijfsrisico\'s (kans/impact/mitigant, ondernemersafhankelijkheid, dubbele lasten, omzetgroei e.d.) verwijderd uit object_en_vastgoed.aandachtspunten; dat hoort uitsluitend in het hoofdstuk Risico\'s, mitiganten & aandachtspunten.');
  }

  /* zekerheden_en_risico.tekst en .dekkingspositie worden in de RENDERER in
     hetzelfde fysieke hoofdstuk (04 · Object & zekerheden) getoond als
     object_en_vastgoed — risicomatrix-/mitigant-taal ("Deze risico's zijn met
     mitiganten benoemd...") moet daarom ook uit DEZE twee velden verwijderd
     worden, niet alleen uit object_en_vastgoed zelf. */
  const zr = (r.zekerheden_en_risico = r.zekerheden_en_risico || {});
  if (hasTxt(zr.tekst) && OBJECT_OFF_TOPIC_RE.test(zr.tekst)) {
    const before = zr.tekst;
    zr.tekst = stripObjectOffTopicText(zr.tekst);
    if (zr.tekst !== before) {
      internal.push('Risicomatrix-/mitigant-taal verwijderd uit zekerheden_en_risico.tekst (wordt getoond in hoofdstuk Object & zekerheden); dat hoort uitsluitend in het hoofdstuk Risico\'s, mitiganten & aandachtspunten.');
    }
  }
  if (hasTxt(zr.dekkingspositie) && OBJECT_OFF_TOPIC_RE.test(zr.dekkingspositie)) {
    const before = zr.dekkingspositie;
    zr.dekkingspositie = stripObjectOffTopicText(zr.dekkingspositie);
    if (zr.dekkingspositie !== before) {
      internal.push('Risicomatrix-/mitigant-taal verwijderd uit zekerheden_en_risico.dekkingspositie; dat hoort uitsluitend in het hoofdstuk Risico\'s, mitiganten & aandachtspunten.');
    }
  }

  /* Objectgegevens consistent maken (klantcorrectie):
     - "Huurwaarde" als kale "0" (of numerieke string) tonen oogt als een fout;
       normaliseer naar een echt eurobedrag ("€ 0") zodat het duidelijk een
       bewuste, bronechte waarde is en geen afgekapt of vergeten veld.
     - Het label "Is er sprake van erfpacht" wordt ingekort tot het gebruikelijke
       kenmerken-label "Erfpacht" (de waarde, bijv. "Ja"/"Nee", blijft gelijk).
     - LTV moet overal in het rapport dezelfde waarde tonen; het meest precieze
       (bijv. met decimaal) exemplaar wordt als canonieke waarde aangehouden en
       elders overgenomen, in plaats van dat afgeronde/afwijkende varianten naast
       elkaar blijven staan. */
  if (Array.isArray(ov.kenmerken) && ov.kenmerken.length) {
    const euro = (n) => `€ ${Math.round(n).toLocaleString('nl-NL')}`;
    ov.kenmerken = ov.kenmerken.map((k) => {
      if (!k || !hasTxt(k.label)) return k;
      if (/huurwaarde/i.test(String(k.label)) && (typeof k.waarde === 'number' || (typeof k.waarde === 'string' && /^-?\d+([.,]\d+)?$/.test(k.waarde.trim())))) {
        const n = typeof k.waarde === 'number' ? k.waarde : parseFloat(String(k.waarde).replace(',', '.'));
        if (isFinite(n)) {
          const na = euro(n);
          if (String(k.waarde) !== na) internal.push(`object_en_vastgoed.kenmerken "${k.label}"-waarde "${k.waarde}" genormaliseerd naar "${na}".`);
          return { ...k, waarde: na };
        }
      }
      if (/^is\s+er\s+sprake\s+van\s+erfpacht\??$/i.test(String(k.label).trim())) {
        internal.push(`object_en_vastgoed.kenmerken label "${k.label}" ingekort naar "Erfpacht".`);
        return { ...k, label: 'Erfpacht' };
      }
      return k;
    });
    const ltvRows = ov.kenmerken.filter((k) => k && hasTxt(k.label) && /\bltv\b/i.test(String(k.label)) && hasTxt(k.waarde));
    const ltvCandidates = [...ltvRows.map((k) => k.waarde), ...(kc && hasTxt(kc.ltv) ? [kc.ltv] : [])];
    if (ltvCandidates.length > 1) {
      const precisie = (s) => (String(s).match(/[.,]\d+/) || [''])[0].length;
      const canoniek = [...ltvCandidates].sort((a, b) => precisie(b) - precisie(a))[0];
      if (ltvCandidates.some((v) => v !== canoniek)) {
        ov.kenmerken = ov.kenmerken.map((k) => (k && /\bltv\b/i.test(String(k.label || '')) && k.waarde !== canoniek ? { ...k, waarde: canoniek } : k));
        if (kc && kc.ltv !== canoniek) kc.ltv = canoniek;
        internal.push(`LTV kwam met verschillende waarden voor in het rapport (${[...new Set(ltvCandidates)].join(', ')}); overal genormaliseerd naar de meest precieze bronwaarde "${canoniek}".`);
      }
    }
  }
}

function enforceStructOverride(r, structuurOverride, internal) {
  const mode = structuurOverride && structuurOverride.mode;
  if (!mode || mode === 'auto') return;
  const ju = (r.juridische_structuur = r.juridische_structuur || {});
  const leegOrgSchema = () => ({ aanwezig: false, titel: '', toelichting: '', entiteiten: [], relaties: [] });
  if (mode === 'tekst' || mode === 'handmatig') {
    const tekst = String(structuurOverride.tekst || '').trim();
    const regels = tekst ? tekst.split(/\r?\n/).map((s) => s.trim()).filter(Boolean) : [];
    if (regels.length) {
      ju.structuur_tekstueel = regels;
      internal.push('Structuurschema: handmatig aangeleverde tekst van de adviseur overschrijft het AI-gegenereerde tekstuele schema (voorrang op AI-generatie).');
    }
    ju.organogram_bestaand = leegOrgSchema();
    ju.organogram_nieuw = leegOrgSchema();
  } else if (mode === 'afbeelding') {
    ju.organogram_bestaand = leegOrgSchema();
    ju.organogram_nieuw = leegOrgSchema();
    ju.structuur_afbeelding_aangeleverd = true;
    internal.push('Structuurschema: adviseur leverde een afbeelding aan; AI-organogram uitgeschakeld, afbeelding wordt apart geplaatst.');
  }
}

/* Cover moet de juiste kredietnemer(s) tonen: bevat de casus meerdere relevante
   entiteiten, dan hoort klantnaam die combinatie te tonen (zie promptinstructie
   voor het exacte format) — niet alleen de werkmaatschappij. Dit wordt hier
   alleen gesignaleerd (nooit automatisch samengesteld). */
function enforceCoverEntities(r, warnings) {
  const partijen = A(r.juridische_structuur?.partijen).filter((p) => hasTxt(p?.naam));
  if (partijen.length < 2) return;
  const klantnaam = String(r.metadata?.klantnaam || '');
  if (!klantnaam) return;
  const normNaam = (n) => String(n).toLowerCase().replace(/[^a-z0-9à-ÿ]+/g, ' ').trim();
  const relevanteRollen = /werkmaatschappij|vastgoed|holding|hoofdaanvrager|kredietnemer/i;
  const relevantePartijen = partijen.filter((p) => relevanteRollen.test(String(p?.rol || '')) || relevanteRollen.test(String(p?.rechtsvorm || '')));
  const teToetsen = relevantePartijen.length >= 2 ? relevantePartijen : partijen;
  const namenNietInCover = teToetsen.filter((p) => {
    const kern = normNaam(p.naam).split(' ').filter((w) => w.length > 2).slice(0, 2).join(' ');
    return kern && !normNaam(klantnaam).includes(kern);
  });
  if (teToetsen.length >= 2 && namenNietInCover.length >= 1 && namenNietInCover.length < teToetsen.length) {
    warnings.push(`Info: de casus bevat meerdere relevante entiteiten (${teToetsen.map((p) => p.naam).join(', ')}) terwijl de covertitel ("${klantnaam}") er niet alle toont — dit is correct als dit bewust de gekozen dossierpartij is (de overige entiteiten staan al in het hoofdstuk Juridische structuur); controleer alleen of dit inderdaad de juiste, gekozen kredietnemer is en geen onbedoelde omissie.`);
  }
}

/* Zekerheden-consistentie: wordt hoofdelijke aansprakelijkheid of een
   aanvullende zekerheid genoemd in de lopende tekst, dan moet dat ook als rij
   in de zekerhedentabel staan — anders is het niet verifieerbaar. Signaleert
   alleen (verwijdert geen vrije tekst). */
function enforceZekerhedenConsistentie(r, warnings) {
  const zr = r.zekerheden_en_risico || {};
  const tekstVelden = [zr.tekst, zr.dekkingspositie].filter(hasTxt).join(' ');
  if (!tekstVelden) return;
  const zekerhedenTxt = A(zr.zekerheden).map((z) => String(z?.zekerheid || '')).join(' | ').toLowerCase();
  const check = (naam, re) => {
    if (re.test(tekstVelden) && !re.test(zekerhedenTxt)) {
      warnings.push(`Eindcontrole: "${naam}" wordt genoemd in de tekst van hoofdstuk Zekerheden & risico, maar staat niet als rij in de zekerhedentabel; voeg een rij toe of verwijder de vermelding uit de tekst.`);
    }
  };
  check('Hoofdelijke aansprakelijkheid', /hoofdelijke\s+aansprakelijkheid/i);
  check('Aanvullende zekerheid', /aanvullende\s+zekerhe(id|den)/i);
}

/* Geen privégegevens of brondata-dump als losse slotinformatie. */
const PERSOONSGEGEVENS_LABEL_RE = /geboortedatum|geboren\s+op|privé[- ]?adres|woonadres|nationaliteit|paspoortnummer|\bbsn\b/i;
function enforceNoPersonalDataDump(r, internal) {
  if (!Array.isArray(r.overige_secties)) return;
  const voor = r.overige_secties.length;
  r.overige_secties = r.overige_secties
    .map((os) => {
      if (!os || !Array.isArray(os.tabel)) return os;
      const tabelVoor = os.tabel.length;
      const tabel = os.tabel.filter((row) => !(row && hasTxt(row.label) && PERSOONSGEGEVENS_LABEL_RE.test(row.label)));
      if (tabel.length < tabelVoor) internal.push(`Persoonsgegevens verwijderd uit overige_secties-tabel "${os.titel || ''}".`);
      return { ...os, tabel };
    })
    .filter((os) => hasTxt(os?.titel) || hasTxt(os?.tekst) || A(os?.tabel).length);
  if (r.overige_secties.length < voor) {
    internal.push('Lege overige_secties (na verwijderen van persoonsgegevens niets inhoudelijks meer over) verwijderd.');
  }
}

/* Elk onderwerp (hypotheekrecht, huurovereenkomst, eigen inbreng, oprichting
   entiteit, liquiditeit, oplevering/ingebruikname, bouwdepot/fasering,
   prognose) mag maar één keer voorkomen in het hele rapport. */
const VOORWAARDE_ONDERWERPEN = [
  { key: 'hypotheekrecht', re: /hypotheekrecht|pandrecht|borgstelling|zekerheidsstelling/i },
  { key: 'hoofdelijke_aansprakelijkheid', re: /hoofdelijke\s+aansprakelijkheid/i },
  { key: 'huurovereenkomst', re: /huurovereenkomst/i },
  { key: 'eigen_inbreng', re: /eigen\s+inbreng/i },
  { key: 'btw_teruggave', re: /btw[- ]?(teruggave|verrekening)/i },
  { key: 'oprichting_entiteit', re: /oprichting|inschrijving/i },
  { key: 'liquiditeit', re: /liquiditeit/i },
  { key: 'oplevering', re: /oplevering|ingebruikname/i },
  { key: 'bouwdepot', re: /bouwdepot|opnameplanning|opnametermijn/i },
  { key: 'prognose', re: /prognose|omzetontwikkeling/i },
];

/* Wordt een hypotheekrecht (eerste hypotheek e.d.) als zekerheid genoemd in de
   zekerhedentabel, dan moet dit altijd ook als voorwaarde in hoofdstuk 8
   (Voorwaarden & documentatie) terugkomen — een zekerheid die niet ook als
   te vestigen/te formaliseren voorwaarde is opgenomen, is niet compleet.
   Ontbreekt dit, dan wordt automatisch een voorwaarde-regel toegevoegd. */
function ensureHypotheekrechtVoorwaarde(r, internal) {
  const zr = r.zekerheden_en_risico || {};
  const zekerheden = A(zr.zekerheden);
  const HYPOTHEEK_RE = /hypotheek/i;
  const heeftHypotheekZekerheid = zekerheden.some((z) => z && hasTxt(z.zekerheid) && HYPOTHEEK_RE.test(z.zekerheid));
  /* Klantcorrectie: ook zonder een expliciete hypotheek-rij in de zekerheden-
     tabel geldt bij een vastgoedfinanciering (object_en_vastgoed met een
     adres/taxatiewaarde/type object, dus een echt te financieren pand) dat
     het eerste hypotheekrecht een standaard, onmisbare voorwaarde is — deze
     regel mag bij een vastgoedfinanciering nooit ontbreken. */
  const ov = r.object_en_vastgoed || {};
  const isVastgoedfinanciering = A(ov.kenmerken).some((k) => k && hasTxt(k.waarde) && hasTxt(k.label) && /adres|taxatiewaarde|type\s*object/i.test(k.label));
  if (!heeftHypotheekZekerheid && !isVastgoedfinanciering) return;
  const VOORWAARDE_HYPOTHEEK_RE = VOORWAARDE_ONDERWERPEN.find((o) => o.key === 'hypotheekrecht').re;
  const cc = (r.conclusie = r.conclusie || {});
  cc.voorwaarden = A(cc.voorwaarden);
  cc.actiepunten = A(cc.actiepunten);
  const alTxt = (arr) => arr.map((x) => (typeof x === 'string' ? x : x?.item) || '').join(' | ');
  const alAanwezig = VOORWAARDE_HYPOTHEEK_RE.test(alTxt(cc.voorwaarden)) || VOORWAARDE_HYPOTHEEK_RE.test(alTxt(cc.actiepunten));
  if (!alAanwezig) {
    cc.voorwaarden.push('Te vestigen eerste hypotheekrecht op het bedrijfspand.');
    internal.push('Hoofdstuk 8 (Voorwaarden & documentatie): het eerste hypotheekrecht ontbrak als voorwaarde bij een vastgoedfinanciering — automatisch aangevuld met "Te vestigen eerste hypotheekrecht op het bedrijfspand." (status/belang worden hierna automatisch afgeleid als "Te vestigen" / "Borgt de primaire zekerheid voor de financier").');
  }
}

function dedupeVoorwaardenOnderwerpen(r, internal) {
  /* seen: onderwerp.key -> { veldnaam, idx (positie in de out-array van dat veld) }.
     Bij een tweede vermelding van hetzelfde onderwerp BINNEN hetzelfde veld
     worden de twee formuleringen samengevoegd tot één regel (bijv. "Hypotheekakte
     eerste rang" + "Te vestigen eerste hypotheekrecht" -> "Te vestigen eerste
     hypotheekrecht / hypotheekakte eerste rang") in plaats van de tweede simpelweg
     te laten vervallen — zo gaat geen van beide formuleringen verloren. Duikt
     hetzelfde onderwerp op in een ANDER veld (bijv. al genoemd bij voorwaarden,
     en nogmaals als vervolgvraag), dan is samenvoegen niet zinvol (andere kolom/
     context) en vervalt de latere vermelding zoals voorheen. */
  const seen = new Map();
  const dedupe = (arr, veldnaam) => {
    const out = [];
    for (const item of A(arr)) {
      const txt = typeof item === 'string' ? item : item?.item;
      if (!hasTxt(txt)) { out.push(item); continue; }
      const onderwerp = VOORWAARDE_ONDERWERPEN.find((o) => o.re.test(txt));
      if (onderwerp) {
        const eerder = seen.get(onderwerp.key);
        if (eerder) {
          if (eerder.veldnaam === veldnaam) {
            const prevItem = out[eerder.idx];
            const prevTxt = typeof prevItem === 'string' ? prevItem : prevItem?.item;
            const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '');
            const prevNorm = norm(prevTxt);
            const txtNorm = norm(txt);
            if (prevNorm.includes(txtNorm) || txtNorm.includes(prevNorm)) {
              internal.push(`Dubbele vermelding van onderwerp "${onderwerp.key}" verwijderd uit ${veldnaam}: "${txt}".`);
            } else {
              const mergedTxt = `${prevTxt.replace(/[.\s]+$/, '')} / ${txt.charAt(0).toLowerCase()}${txt.slice(1).replace(/[.\s]+$/, '')}`;
              out[eerder.idx] = typeof prevItem === 'string' ? mergedTxt : { ...prevItem, item: mergedTxt };
              internal.push(`Twee vermeldingen van hetzelfde onderwerp "${onderwerp.key}" samengevoegd tot één regel in ${veldnaam}: "${mergedTxt}".`);
            }
          } else {
            internal.push(`Dubbele vermelding van onderwerp "${onderwerp.key}" verwijderd uit ${veldnaam} (stond al in ${eerder.veldnaam}): "${txt}".`);
          }
          continue;
        }
        seen.set(onderwerp.key, { veldnaam, idx: out.length });
      }
      out.push(item);
    }
    return out;
  };
  const cc = (r.conclusie = r.conclusie || {});
  cc.voorwaarden = dedupe(cc.voorwaarden, 'conclusie.voorwaarden');
  cc.actiepunten = dedupe(cc.actiepunten, 'conclusie.actiepunten');
  const dc = (r.documentatiecheck = r.documentatiecheck || {});
  dc.ontbrekend = dedupe(dc.ontbrekend, 'documentatiecheck.ontbrekend');
  dc.vervolgvragen = dedupe(dc.vervolgvragen, 'documentatiecheck.vervolgvragen');
}

/* Brede eindscan op afgebroken zinnen/restteksten over het hele rapport. */
function scanBrokenSentencesReport(r, warnings) {
  const commaStarts = [];
  const bracketStarts = [];
  const digitFrags = [];
  const onlogischeKosten = [];
  let hasEllipsis = false;
  const walk = (node) => {
    if (typeof node === 'string') {
      if (/(\.\.\.|…)/.test(node)) hasEllipsis = true;
      if (/inclusief\s+btw\s+exclusief/i.test(node) && onlogischeKosten.length < 3) onlogischeKosten.push(node.trim().slice(0, 60));
      if (node.trim().length >= 20) {
        const zinnen = node.split(/(?<=[.!?])\s+(?=[A-ZÀ-Ý0-9(])/);
        for (const zin of zinnen) {
          const z = zin.trim();
          if (!z) continue;
          if (/^,/.test(z) && commaStarts.length < 3) commaStarts.push(z.slice(0, 50));
          if (/^\(/.test(z) && bracketStarts.length < 3) bracketStarts.push(z.slice(0, 50));
          if (/^\d{1,3}(\s|$)/.test(z) && !/^\d{4}\b/.test(z) && digitFrags.length < 3) digitFrags.push(z.slice(0, 50));
          if (/^[o0]{2,4}\s+in\s+\d{4}\b/i.test(z) && digitFrags.length < 3) digitFrags.push(z.slice(0, 50));
        }
      }
      return;
    }
    if (Array.isArray(node)) { node.forEach(walk); return; }
    if (node && typeof node === 'object') { for (const k of Object.keys(node)) walk(node[k]); }
  };
  walk(r);
  if (commaStarts.length) warnings.push(`Eindcontrole: rapport bevat zin(nen) die met een komma beginnen (bijv. "${commaStarts.join('" / "')}"); dit zijn vrijwel zeker afgebroken zinnen — herschrijf tot volledige zinnen vóór export.`);
  if (bracketStarts.length) warnings.push(`Eindcontrole: rapport bevat zin(nen) die met een los haakje beginnen (bijv. "${bracketStarts.join('" / "')}"); dit zijn vrijwel zeker afgebroken zinnen — herschrijf tot volledige zinnen vóór export.`);
  if (digitFrags.length) warnings.push(`Eindcontrole: rapport bevat mogelijk afgebroken zin(nen) die beginnen met een los cijferfragment (bijv. "${digitFrags.join('" / "')}"); controleer en herschrijf tot volledige zinnen.`);
  if (onlogischeKosten.length) warnings.push(`Eindcontrole: rapport bevat een onlogische kostenformulering ("inclusief btw exclusief...", bijv. "${onlogischeKosten.join('" / "')}"); herschrijf dit label/deze zin eenduidig vóór export.`);
  if (hasEllipsis) warnings.push('Eindcontrole: rapport bevat "..." of "…" ergens in de tekst — mogelijk een afgebroken zin; herschrijf dit gedeelte tot een volledige zin vóór export.');
}

function enforceQuality(r, vandaag, opts = {}) {
  const { bytesPageCount = null, uitgebreid = false, structuurOverride = null } = opts;
  /* Twee gescheiden categorieën, zoals vereist:
     - internal: technische/tool-correcties. Nooit naar de client of het rapport.
       Alleen console-logging voor de ontwikkelaar.
     - warnings (= advisorWarnings): zakelijke, extern leesbare controlepunten. */
  const warnings = [];
  const internal = [];
  const zero = makeZeroChecker(r);

  /* 0 — afgekapte tekst / render-vervuiling (tool-correcties → intern) */
  deepCleanStrings(r, internal);
  scanDemoMarkers(r, internal);

  /* 1 — bedragen: 0-fallbacks naar null (tool-correctie → intern) */
  const fo = (r.financieringsopzet = r.financieringsopzet || {});
  const kc = (fo.kerncijfers = fo.kerncijfers || {});
  let zeroFallbackHit = false;
  for (const k of ['totale_investering', 'gevraagde_financiering', 'eigen_inbreng', 'overige_financiering']) {
    const before = kc[k];
    kc[k] = zero(kc[k]);
    if (before === 0 && kc[k] === null) {
      zeroFallbackHit = true;
      internal.push(`kerncijfers.${k} was 0 zonder expliciete nul-bron en is op onbekend gezet.`);
    }
  }
  if (zeroFallbackHit) {
    const w = 'Een of meer kerncijfers zijn niet eenduidig met een nulwaarde onderbouwd in de bron; controleer dit met de aanvrager.';
    if (!warnings.includes(w)) warnings.push(w);
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

  /* 1b — kvk-kolom mag nooit een datum bevatten (oprichtings-/geboortedatum
     die per ongeluk in het kvk-veld terechtkomt in plaats van een echt
     KvK-nummer), en ook nooit een verzonnen vultekst ("nog niet bekend",
     "onbekend", "n.v.t.", "niet van toepassing", "ongeveer nog niet gekend"
     e.d.) — die worden hier leeggemaakt zodat de client altijd netjes "-"
     toont; tool-correctie, dus alleen intern gelogd. */
  {
    const ju0 = (r.juridische_structuur = r.juridische_structuur || {});
    const DATUM_ACHTIG = /^\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}$/;
    const KVK_VULTEKST = /^(ongeveer\s+)?(nog\s+niet\s+(bekend|gekend)|onbekend|n\.?v\.?t\.?|niet\s+van\s+toepassing|geen|n\/a)$/i;
    ju0.partijen = A(ju0.partijen).map((p) => {
      if (p && typeof p.kvk === 'string') {
        const kvkTrim = p.kvk.trim();
        if (DATUM_ACHTIG.test(kvkTrim)) {
          internal.push(`partijen.kvk bevatte een datum ("${p.kvk}") in plaats van een KvK-nummer en is leeggemaakt.`);
          return { ...p, kvk: '' };
        }
        if (kvkTrim && KVK_VULTEKST.test(kvkTrim)) {
          internal.push(`partijen.kvk bevatte vultekst ("${p.kvk}") in plaats van een echt KvK-nummer of leeg veld en is leeggemaakt.`);
          return { ...p, kvk: '' };
        }
      }
      return p;
    });
  }

  /* 2 — bronnen/aanwendingen: totaalregels, classificatie + sluitcheck.
     enforceBnA levert zowel zakelijke controlepunten (sluiting, herclassificatie)
     als een puur tekstuele euroteken-fix (cleanRatios) — die laatste is intern. */
  enforceBnA(fo, warnings);
  dedupeBijkomendeKosten(fo, warnings);
  cleanRatios(r, internal);
  const bnaSide = (type) => A(fo.bronnen_en_aanwendingen).filter((x) => x?.type === type && num(x.bedrag) !== null);
  const sideTotals = (type) => {
    const all = bnaSide(type);
    const detail = all.filter((x) => !x.totaalregel);
    const totRow = all.find((x) => x.totaalregel);
    return { detail: detail.reduce((t, x) => t + x.bedrag, 0), n: detail.length, bronTotaal: totRow ? totRow.bedrag : null };
  };
  const sB = sideTotals('bron');
  const sA = sideTotals('aanwending');
  for (const [kant, t] of [['bronnen', sB], ['aanwendingen', sA]]) {
    if (t.bronTotaal !== null && t.n >= 2 && Math.abs(t.detail - t.bronTotaal) > Math.max(Math.abs(t.bronTotaal), 1) * 0.02) {
      warnings.push(`Detailregels ${kant} (€ ${Math.round(t.detail).toLocaleString('nl-NL')}) wijken af van het brontotaal (€ ${Math.round(t.bronTotaal).toLocaleString('nl-NL')}); verifieer met de bron.`);
    }
  }
  const tb = sB.bronTotaal !== null ? sB.bronTotaal : sB.detail;
  const ta = sA.bronTotaal !== null ? sA.bronTotaal : sA.detail;
  if ((sB.n || sB.bronTotaal !== null) && (sA.n || sA.bronTotaal !== null)) {
    if (tb > 0 && ta > 0 && Math.abs(tb - ta) > Math.max(tb, ta) * 0.02) {
      warnings.push(`Bronnen (€ ${Math.round(tb).toLocaleString('nl-NL')}) en aanwendingen (€ ${Math.round(ta).toLocaleString('nl-NL')}) sluiten niet; verifieer met de bron.`);
    }
  }
  enforceInvesteringConsistentie(fo, warnings);

  /* 3 — grafieken: alleen echte data */
  const vis = (r.visualisaties = r.visualisaties || {});
  vis.financieringsmix = cleanMix(vis.financieringsmix);
  vis.zekerhedenmix = cleanMix(dropConditionalZekerheden(vis.zekerhedenmix, r.zekerheden_en_risico?.zekerheden));
  vis.omzetontwikkeling = cleanTrend(vis.omzetontwikkeling);
  vis.resultaatontwikkeling = cleanTrend(vis.resultaatontwikkeling);
  vis.ratioontwikkeling = A(vis.ratioontwikkeling).filter((x) => num(x?.waarde) !== null && hasTxt(x?.periode));
  if (vis.ratioontwikkeling.length < 2) vis.ratioontwikkeling = [];

  /* 4 — datumregels (technische correctie → intern, geen extern controlepunt) */
  enforceDates(r, internal, vandaag);

  /* 4b — twee organogrammen (bestaand + nieuw) mogen allebei blijven staan: de
     renderer toont ze dan automatisch naast elkaar (structuur huidig / na
     wijziging). Kwaliteitscontrole per schema gebeurt hieronder. */
  const ju = r.juridische_structuur || {};

  /* 4b.i — rommelige/inconsistente organogrammen (dubbele entiteiten of
     100%-labels, gebroken referenties) worden nooit getoond, ook niet als de
     AI zelf aanwezig=true teruggaf. */
  enforceOrgDiagramQuality(r, warnings, internal);
  enforceGeenVerdachteCijferGaten(r, warnings);

  /* 4b.i.a — balansposten en winst-en-verliesposten die in de verkeerde tabel
     terecht zijn gekomen, worden eerst rechtgezet, vóórdat er verder iets met
     de financiële analyse gebeurt. */
  enforceFinancialStatementSeparation(r, internal);
  dedupeFinancieleAnalyseRegels(r, internal);
  dedupeOmzetBedrijfsopbrengsten(r, internal);
  ensureTotaalPassiva(r, internal);
  checkTotaalBedrijfskostenSom(r, warnings);
  enforceResultatenVolledigheid(r, warnings);
  fixObservatieTrendRichting(r, warnings);

  /* 4b.i.a2 — objecthoofdstuk: LTV als percentage, geen risicomatrix-tekst. */
  enforceObjectChapterQuality(r, internal);

  /* 4b.i.b — financiële posten die voor hetzelfde jaar 3x hetzelfde
     (mogelijk gefabriceerde/gedupliceerde) bedrag teruggeven, worden als
     controlepunt gelogd (niet meer verwijderd, zie toelichting bij de functie). */
  enforceFinancialFigureQuality(r, internal);

  /* 4b.ii — handmatig door de adviseur aangeleverd structuurschema heeft altijd
     voorrang boven AI-generatie: overschrijft structuur_tekstueel (tekst/
     handmatig) en schakelt het AI-organogram sowieso uit. */
  enforceStructOverride(r, structuurOverride, internal);

  /* 4c — maximaal 5 risico's in de risicomatrix (conform rapportstructuur) */
  if (A(zr.risicomatrix).length > 5) {
    zr.risicomatrix = A(zr.risicomatrix).slice(0, 5);
    internal.push('Risicomatrix ingekort tot de 5 belangrijkste aandachtspunten.');
  }

  /* 5 — bronomvang alleen registreren (informatief). De typebepaling volgt de
     complexiteit van de financiering, NIET de bronlengte: een korte bron over een
     vastgoedaankoop is rapporttype B, een lange bijlagenbundel bij een eenvoudige
     lease blijft rapporttype A. */
  const aiPages = num(r.bronrapport?.aantal_paginas);
  const sourcePageCount = bytesPageCount || (aiPages && aiPages > 0 ? Math.round(aiPages) : null);

  /* 6 — rapporttype server-side op basis van complexiteit.
     Rapporttype B (volwaardig, max 10 p.): vastgoed, aankoop bedrijfspand, overname,
     herfinanciering, bouwdepot, prognose/DSCR aanwezig of vastgoed-B.V.-structuur.
     Rapporttype A (compact_intake, max 7 p.): eenvoudige lease-/bedrijfsmiddelen-
     financiering zonder die componenten. */
  const dd = computeDekking(r);
  r.metadata = r.metadata || {};
  const TYPE_ALIAS = { financieringsmemorandum: 'volwaardig_financieringsmemorandum', intake_documentatiememorandum: 'compact_intake' };
  const GELDIGE_TYPES = ['volwaardig_financieringsmemorandum', 'compact_intake', 'luxe_samenvatting'];
  const aiType = TYPE_ALIAS[r.metadata.rapport_type] || r.metadata.rapport_type;
  const COMPLEX_PAT = /(vastgoed|bedrijfspand|bedrijfsobject|hypothe|koopsom|aanneemsom|kosten\s+koper|taxatie|erfpacht|\bltv\b|loan[- ]?to[- ]?value|overname|acquisitie|goodwill|verkoperslening|vendor\s?loan|herfinancier|bouwdepot|\bdscr\b|debt\s*\/?\s*ebitda)/i;
  const complexTxt = JSON.stringify([
    r.bronfeiten, r.metadata.financieringsdoel, r.bronrapport?.type,
    r.financieringsopzet?.tekst, r.financieringsopzet?.kerncijfers,
    r.object_en_vastgoed, A(r.zekerheden_en_risico?.zekerheden),
  ]);
  const isComplex =
    COMPLEX_PAT.test(complexTxt) ||
    A(r.object_en_vastgoed?.kenmerken).some((x) => hasTxt(x?.label)) ||
    A(r.betaalcapaciteit?.dscr_overzicht).length > 0;
  if (!isComplex) {
    r.metadata.rapport_type = 'compact_intake';
    if (aiType && aiType !== 'compact_intake') {
      warnings.push('Rapporttype vastgesteld op compact intake- en documentatiememorandum (rapporttype A): eenvoudige financiering zonder vastgoed-, overname- of prognosecomponent.');
    }
  } else if (dd.bedrag && dd.doel) {
    r.metadata.rapport_type =
      GELDIGE_TYPES.includes(aiType) && aiType !== 'compact_intake' ? aiType : 'volwaardig_financieringsmemorandum';
  } else {
    r.metadata.rapport_type = 'compact_intake';
    warnings.push('Rapporttype teruggezet naar compact intake- en documentatiememorandum: onvoldoende datadekking voor een volwaardig rapport.');
  }
  r.metadata.datadekking = dd.niveau;
  r.metadata.status = 'Concept · ter beoordeling';

  /* 6b — paginabudget vastleggen in metadata (na de definitieve typebepaling).
     Rapporttype A: maximaal 8 pagina's. Rapporttype B/luxe: richtlengte 11-13
     pagina's, maximaal 15 — volledigheid (structuur, financiële analyse, prognose,
     betaalcapaciteit, zekerheden, risico's, documentatie) weegt zwaarder dan een
     streng paginabudget. De bronlengte beïnvloedt het paginabudget niet.
     (+1 pagina t.o.v. eerdere versie: de inhoudsopgave krijgt in de renderer nu
     altijd een eigen pagina in plaats van samen te gaan met hoofdstuk 1.) */
  const HARD_MAX_PAGES = 15;
  const MAX_BY_TYPE = { compact_intake: 8, volwaardig_financieringsmemorandum: 15, luxe_samenvatting: 15 };
  r.metadata.sourcePageCount = sourcePageCount;
  r.metadata.uitgebreidToegestaan = !!uitgebreid;
  r.metadata.maxOutputPages = Math.min(HARD_MAX_PAGES, MAX_BY_TYPE[r.metadata.rapport_type] || 12);

  /* 7 — conclusiebeleid.
     Bij compact_intake zonder financiële analyse/prognose mag het oordeel nooit
     "voorzichtig positief" zijn; dan geldt altijd de expliciete "nog geen definitief
     oordeel"-tekst, ongeacht wat de AI zelf schreef. */
  const cc = (r.conclusie = r.conclusie || {});
  const heeftFinancieleData =
    A(r.financiele_analyse?.resultaten).some((x) => num(x?.bedrag) !== null) ||
    A(r.financiele_analyse?.ratios).length > 0;
  if (cc.oordeel === 'voorzichtig positief' && (!dd.volwaardig || (r.metadata.rapport_type === 'compact_intake' && !heeftFinancieleData))) {
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

  /* 8 — documentatiecheck: eerlijkheidscheck */
  const dc = (r.documentatiecheck = r.documentatiecheck || {});
  const bronDocs = A(r.metadata.bron_documenten).map((x) => String(x).toLowerCase());
  dc.ontvangen = A(dc.ontvangen).filter((row) => hasTxt(row?.document));
  for (const row of dc.ontvangen) {
    const naam = String(row.document).toLowerCase();
    const echtOntvangen = bronDocs.some((d) => d.includes(naam.slice(0, 12)) || naam.includes(d.slice(0, 12)));
    if (row.status === 'ontvangen' && !echtOntvangen && bronDocs.length) {
      row.status = 'in bron opgenomen';
      internal.push(`Documentstatus van "${row.document}" aangepast naar "in bron opgenomen" (was niet los aangeleverd).`);
    }
  }

  /* "Datadekking verlaagd naar ..." is een interne toolstatus, geen zakelijk
     controlepunt — staat expliciet op de verbodslijst voor externe teksten. */
  const missingHigh = A(dc.ontbrekend).some((x) => String(x?.prioriteit || '').toLowerCase() === 'hoog');
  if (missingHigh && r.metadata.datadekking === 'hoog') {
    r.metadata.datadekking = 'middel';
    internal.push('Datadekking verlaagd naar "middel": er ontbreken nog stukken met hoge prioriteit.');
  }

  /* Documentatielijsten beperkt houden tot de belangrijkste punten */
  const PRIO_ORDER = { hoog: 0, middel: 1, laag: 2 };
  dc.ontbrekend = A(dc.ontbrekend)
    .filter((x) => hasTxt(x?.item))
    .sort((a, b) => (PRIO_ORDER[String(a?.prioriteit).toLowerCase()] ?? 1) - (PRIO_ORDER[String(b?.prioriteit).toLowerCase()] ?? 1))
    .slice(0, 6);
  dc.vervolgvragen = A(dc.vervolgvragen).filter(hasTxt).slice(0, 6);
  dc.separaat_te_controleren = A(dc.separaat_te_controleren).filter(hasTxt).slice(0, 6);

  /* 9 — coverage */
  enforceCoverage(r, warnings, internal);

  /* 8b — voorwaarden/documentatie: eerst zorgen dat een genoemd hypotheekrecht
     ook als voorwaarde aanwezig is, dan pas ontdubbelen op onderwerp (server-side afdwingen). */
  ensureHypotheekrechtVoorwaarde(r, internal);
  dedupeVoorwaardenOnderwerpen(r, internal);

  /* 8c — cover moet juiste entiteiten tonen; zekerheden tekst/tabel consistent;
     geen persoonsgegevens-dump als losse slotinformatie. */
  enforceCoverEntities(r, warnings);
  enforceZekerhedenConsistentie(r, warnings);
  enforceNoPersonalDataDump(r, internal);

  /* 9b — eindcontrole (punt 9): laatste controlerende check vóór export. */
  enforceKpiEuroFormat(r, warnings);
  enforceFinalChecklist(r, warnings);

  /* 9c — brede scan op afgebroken zinnen/restteksten over het hele rapport. */
  scanBrokenSentencesReport(r, warnings);

  /* 10 — kwaliteitscontrole bijwerken: uitsluitend advisorWarnings naar buiten.
     internalWarnings (tool-/debugcorrecties) gaan nooit mee in het rapport of de
     JSON-respons; ze worden alleen server-side gelogd voor de ontwikkelaar. */
  const kwc = (r.kwaliteitscontrole = r.kwaliteitscontrole || {});
  kwc.geen_nul_fallbacks = true;
  kwc.geen_lege_grafieken = true;
  let advisorWarnings = [...new Set([...A(kwc.waarschuwingen), ...warnings])].filter(hasTxt);
  if (r.metadata.rapport_type === 'compact_intake' && advisorWarnings.length > 5) {
    advisorWarnings = advisorWarnings.slice(0, 5);
  }
  kwc.waarschuwingen = advisorWarnings;
  delete kwc.internalWarnings; // voor het geval een eerdere AI-respons dit veld toch vulde

  if (internal.length) {
    console.warn(`[credion] interne kwaliteitscorrecties (${internal.length}), niet extern getoond:\n- ${internal.join('\n- ')}`);
  }

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
    /* Met Fluid Compute AAN (gratis instelling, ook op Hobby — zie
       maxDuration hieronder) is de functietijdlimiet 300s in plaats van de
       standaard 10s. Generatietijd schaalt ongeveer lineair met het aantal
       output-tokens; 28000 geeft ruimte voor een volledig financierings-
       memorandum inclusief de uitgebreide financiële analyse, met nog altijd
       marge tegen de 300s-limiet. Staat Fluid Compute uit, verlaag dit dan
       weer naar circa 15000-18000 om binnen 60s te blijven. */
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

/* Vercel's default functietimeout (10s) is te kort voor een PDF-analyse door
   het model. Met Fluid Compute AAN — een gratis instelling onder Project
   Settings > Functions, ook beschikbaar op het Hobby-plan, GEEN betaalde
   upgrade — is 300s (5 minuten) het maximum op zowel Hobby als Pro/Enterprise.
   Zonder Fluid Compute blijft Hobby hard op 10s hangen, ongeacht deze waarde.
   Zet dit dus op 300 zodra Fluid Compute aan staat; alleen als Fluid Compute
   uit blijft, verlaag dit dan naar 10. */
export const maxDuration = 300;

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

    /* Structuurschema-override van de adviseur: alleen een bekende modus met
       daadwerkelijke inhoud wordt doorgezet; verder genegeerd (dan blijft de
       AI vrij, zoals voorheen). De afbeelding zelf hoeft niet server-side te
       worden opgeslagen of naar het model gestuurd — die wordt client-side
       geplaatst met de bytes die de browser al lokaal heeft; de server hoeft
       alleen te weten DAT er een afbeelding is, om het AI-organogram uit te
       schakelen. */
    const rawStructOverride = body?.structuur_override;
    const structuurOverride = (() => {
      const mode = rawStructOverride?.mode;
      if (!['tekst', 'handmatig', 'afbeelding'].includes(mode)) return null;
      if (mode === 'afbeelding') return { mode };
      const tekst = String(rawStructOverride?.tekst || '').trim().slice(0, 4000);
      return tekst ? { mode, tekst } : null;
    })();

    /* Bronomvang meten aan de hand van de daadwerkelijke bytes van het hoofddocument
       (het eerste aangeleverde PDF-bestand). Alleen mogelijk als de bytes zijn
       meegestuurd; bij grote bestanden die via Blob lopen ontbreken deze bytes op de
       server, en valt de tool later terug op bronrapport.aantal_paginas of het
       rapporttype. */
    let bytesPageCount = null;
    try {
      let primaryB64 = '';
      if (Array.isArray(body?.documents) && body.documents.length) {
        const firstPdf = body.documents.find((d) => d?.kind === 'pdf' && d?.dataBase64);
        primaryB64 = normalizeBase64(firstPdf?.dataBase64);
      } else {
        primaryB64 = normalizeBase64(body?.dataBase64);
      }
      if (primaryB64) bytesPageCount = estimatePdfPageCount(Buffer.from(primaryB64, 'base64'));
    } catch {
      bytesPageCount = null;
    }
    const uitgebreid = /uitgebreid\s*rapport/i.test(String(notities || ''));

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
    const prompt = buildPrompt({ notities, docSummary, vandaag, bytesPageCount, uitgebreid, structuurOverride });
    const content = [{ type: 'input_text', text: prompt }, ...docContent];

    /* Functietijdlimiet is nu 300s (met Fluid Compute aan, zie maxDuration
       hierboven) in plaats van de vroegere 60s. Generatietijd hangt nog altijd
       sterk samen met bronomvang en gevraagde diepgang (uitgebreid rapport,
       veel pagina's) — voor de zwaarste gevallen kiezen we daarom vooraf al
       het snellere nano-model i.p.v. pas ná een mislukte poging, want een
       verstreken functietijdlimiet kan (in tegenstelling tot een 429) niet
       meer binnen dezelfde aanroep worden opgevangen. Voor de meeste (normale)
       aanvragen blijft mini de standaard, voor de beste nauwkeurigheid. Een
       expliciete OPENAI_MODEL env-var overschrijft deze keuze altijd. */
    const isZwareAanvraag = uitgebreid || (typeof bytesPageCount === 'number' && isFinite(bytesPageCount) && bytesPageCount > 15);
    const model = process.env.OPENAI_MODEL || (isZwareAanvraag ? 'gpt-4.1-nano' : 'gpt-4.1-mini');
    let response;
    try {
      response = await createResponse(client, model, content);
    } catch (firstErr) {
      if (firstErr?.status === 429 || String(firstErr?.message || '').includes('429')) {
        response = await createResponse(client, model === 'gpt-4.1-nano' ? 'gpt-4.1-mini' : 'gpt-4.1-nano', content);
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
      report = enforceQuality(parsed, vandaag, { bytesPageCount, uitgebreid, structuurOverride });
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
