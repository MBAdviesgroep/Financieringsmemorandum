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
11. Behoud de hoofdstukstructuur van de bron: hoofdstukken niet onnodig samenvoegen of splitsen. Bronhoofdstukken die niet in het schema passen (bijv. detailgegevens van betrokken personen of rechtspersonen) zet je in overige_secties, elk met titel, tekst en eventueel een tabel met {label, waarde}-rijen.
12. Bij twijfel: volg de bron letterlijk en neem een controlepunt op in coverage_check.waarschuwingen.

WERKWIJZE — EERST INVENTARISEREN, DAN SCHRIJVEN
Stap 1: lees het volledige brondocument. Vul "bronrapport" in: geschat aantal pagina's, documenttype (bijv. "Capsearch-financieringsplan", "jaarrekening"), alle hoofdstukken/secties in bronvolgorde, alle relevante afbeeldingen (korte omschrijving per beeld, bijv. "organogram nieuwe structuur", "rendering nieuwbouw", "plattegrond"), aangetroffen organogrammen en de belangrijkste tabellen.
Stap 2: verantwoord per bronhoofdstuk wat ermee gebeurt in "coverage_check": zet elk hoofdstuk in precies één van de lijsten opgenomen_in_rapport (volledig verwerkt), samengevat, of weggelaten_met_reden (formaat "hoofdstuk — reden"; alleen bij echte duplicatie of niet-besluitvormingsrelevante inhoud). Twijfel = meenemen. Kopieer de volledige hoofdstukkenlijst ook naar coverage_check.bronhoofdstukken.
Stap 3: extraheer bronfeiten. Stap 4: schrijf pas daarna de rapportsecties.

PAGINABUDGET — HARDE REGEL
Er zijn twee rapporttypen met elk een eigen harde paginalimiet, inclusief voorblad, inhoudsopgave en achterblad:
- Rapporttype A ("compact_intake" — compact intake- en documentatiememorandum): doellengte 5 à 7 pagina's, NOOIT meer dan 7. Past het rapport binnen 6 pagina's, gebruik dan 6 — voeg geen lege of overbodige pagina toe.
- Rapporttype B ("volwaardig_financieringsmemorandum" of "luxe_samenvatting" — volledig financieringsmemorandum): doellengte 10 à 11 pagina's, NOOIT meer dan 11.
De paginalimiet is verplicht en geldt ongeacht de lengte van de bron: bij een bron van 20+ pagina's moet je actief samenvatten, samenvoegen en keuzes maken. Dreigt het rapport te lang te worden, kort dan in vóór oplevering — in deze volgorde: teksten verkorten; dubbele informatie verwijderen; hoofdstukken combineren; tabellen beperken tot kerninformatie; visueel organogram vervangen door tekstschema; vervolgvragen samenvoegen met op te vragen stukken; overbodige KPI-blokken schrappen. Los het nooit op door essentiële onderdelen volledig te verwijderen. Je bent een transformatietool, geen uitbreidtool. Ook als de adviseursnotities om een "uitgebreid rapport" vragen blijven deze maxima gelden. Lay-out gaat boven volledigheid: als inhoud te lang is voor een nette pagina-indeling, vat de tekst dan verder samen in plaats van tabellen of hoofdstukken te laten breken.

RAPPORTTYPE A — STRUCTUUR (compact intake- en documentatiememorandum, maximaal 7 pagina's)
Gebruik dit type bij eenvoudige financieringen: financial lease, bedrijfsmiddelen-, machine- of voertuigfinanciering, relatief kleine aanvragen, geen vastgoedfinanciering, geen bedrijfsovername, beperkte broninformatie, geen uitgebreide prognose of kasstroomanalyse. Vaste indeling: pagina 1 cover; pagina 2 inhoudsopgave + kernsamenvatting (samen op één pagina); daarna één pagina per hoofdstuk. Hoofdstukken (maximaal; combineren mag als de inhoud kort is): 01 Kernsamenvatting; 02 Juridische structuur & activiteiten; 03 Financieringsaanvraag (sources & uses); 04 Bestaande financieringen & zekerheden; 05 Documentatie, aandachtspunten & op te vragen stukken; 06 Financieringssamenvatting.
- Kernsamenvatting: maximaal 150 woorden — kort genoeg om samen met de inhoudsopgave op één pagina te passen — wie de klant is, wat wordt gefinancierd, bedrag, looptijd, rente, financieringsvorm, waarom de investering past binnen de bedrijfsvoering, belangrijkste aandachtspunten. Formuleer het doel financieringsgericht als "Doel van de aanvraag", bijvoorbeeld "Het opvragen van financieringsvoorstellen voor de leasefinanciering van bedrijfsmiddelen ter ondersteuning van de bedrijfsvoering en verduurzaming." Gebruik nooit de term "besluitvormingsvraag".
- Juridische structuur & activiteiten: maximaal één pagina; bij voorkeur GEEN visueel organogram maar een tekstueel structuurschema; activiteiten maximaal 6 bullets, geen lange alinea's als bullets voldoende zijn. Geen dubbele 100%-labels als de verhouding feitelijk bijv. 70%/30% is.
- Sources & uses óók bij lease: aanwendingen = de bedrijfsmiddelen (bedrag per object indien bekend, anders één gecombineerde regel zoals "Bedrijfsmiddelen, afvulmachine en laadinfrastructuur"); bronnen = financial lease plus eigen inbreng (€ 0 alleen als de bron expliciet geen eigen inbreng vermeldt). Bronnen en aanwendingen moeten altijd aansluiten. Vermeld bij financial lease duidelijk: looptijd, rente, eventuele slottermijn en eigen inbreng.
- Bestaande financieringen: alleen wat relevant is — financier, type faciliteit, restschuld/limiet; onbekende actuele benutting = "te actualiseren". Geen volledige vastgoedanalyse bij een niet-vastgoedaanvraag.
- Documentatie: commercieel en compact. GEEN defensieve lijst van alles wat ontbreekt ("geen prognose beschikbaar", "geen marktpositie beschikbaar" enz.) — wel een korte lijst nog te controleren / op te vragen stukken (actuele bankopgave, actuele benutting rekening-courant, definitieve facturen/offertes, bevestiging verpanding leaseobjecten, borgstellingen indien door financier vereist, recente cijfers indien gevraagd). Vervolgvragen alleen als ze echt nieuwe informatie toevoegen.
- Financieringssamenvatting: maximaal 8 regels, financieringsgericht.

RAPPORTTYPE B — STRUCTUUR (volledig financieringsmemorandum, richtlengte 10-12 pagina's, maximaal 14)
Gebruik dit type bij complexere financieringen: vastgoedfinanciering, aankoop bedrijfspand, overnamefinanciering, herfinanciering, meerdere entiteiten (vastgoed-B.V./holding/werkmaatschappij), beschikbare prognoses en betaalcapaciteit, zekerheden zoals hypotheekrecht, verpanding of borgstelling, of substantiële aanvragen waarbij financiers een volledig beeld nodig hebben. Vaste indeling: pagina 1 cover; pagina 2 inhoudsopgave + managementsamenvatting (samen op één pagina); daarna één pagina per hoofdstuk; geen achterblad. Richtlengte 10 tot 12 pagina's, maximaal 14 — gebruik extra pagina's zodra dat nodig is voor een rustige lay-out en om te voorkomen dat hoofdstukken worden afgekapt of inhoud sneuvelt. Volledigheid gaat vóór kunstmatig inkorten: alles moet er netjes en compleet in staan — structuur, activiteiten, financieringsopzet, object en zekerheden, financiële analyse mét prognosecijfers, betaalcapaciteit, risico's, voorwaarden en documentatie — liever een paar pagina's extra dan iets weglaten of afkappen. De vaste hoofdstukken (exact 9): 01 Managementsamenvatting; 02 Juridische structuur, activiteiten & strategie; 03 Financieringsopzet / bronnen en aanwendingen; 04 Objectgegevens & zekerheden; 05 Financiële analyse (incl. prognose); 06 Betaalcapaciteit & ratio's; 07 Risico's, mitiganten & aandachtspunten; 08 Voorwaarden voor verdere beoordeling & documentatie; 09 Financieringssamenvatting.
- Managementsamenvatting: kernboodschap van maximaal 180 woorden — kort genoeg om samen met de inhoudsopgave op één pagina te passen — doel van de financiering, gevraagde financiering, totale investering, eigen inbreng, kerncijfers; bij prognose maximaal één korte zin over de belangrijkste ontwikkeling (niet dubbel met hoofdstuk 05). Gebruik nooit de titel of het begrip "voorlopig oordeel".
- Juridische structuur: maximaal een halve pagina, toelichting maximaal 5 bullets; activiteiten, verdienmodel & strategie maximaal 6 bullets (historie, activiteiten, omzetstromen, klanten, verdienmodel, strategie) — geen herhaling van de managementsamenvatting. Toon iedere entiteit en iedere persoon maximaal één keer in het structuurschema of organogram; nooit dubbele 100%-labels voor dezelfde relatie.
- Financiële analyse: maximaal één pagina — exact één tabel met Jaar als rijen en de kolommen Omzet, Bedrijfsresultaat, Resultaat na belasting, Liquide middelen, Eigen vermogen (alleen kolommen die de bron daadwerkelijk draagt), plus maximaal 5 observatiebullets; geen aparte balans-, activa-, passiva- of kostenposttabellen, geen grafieken, geen KPI-blokken in dit hoofdstuk.
- Betaalcapaciteit: maximaal één pagina — korte toelichting (maximaal 5 regels), DSCR-tabel per jaar (jaar | situatie | DSCR | toelichting; DSCR altijd als ratio zoals "3,11", NOOIT als eurobedrag), compact Debt/EBITDA of overige kengetallen in dezelfde of een korte tweede tabel, en maximaal 3 interpretatiebullets. Herhaal geen cijfers uit de financiële analyse.
- Risico's: maximaal 5, in één tabel Aandachtspunt | Toelichting | Mitigerende factor / vervolgstap; elk risico heeft altijd een mitigerende factor of vervolgstap, nooit een afwijzende toon; geen aparte lange lijst bancaire aandachtspunten als dezelfde punten al bij voorwaarden staan.
- Voorwaarden voor verdere beoordeling & documentatie (één hoofdstuk): één compacte tabel van MAXIMAAL 7 rijen met de kolommen Onderdeel | Status | Belang voor financier (geen aparte kolommen Type/Prioriteit, geen lege toelichtingen met "—", en gebruik nooit "voorwaarde", "actiepunt", "op te vragen", "te controleren" en "vervolgvraag" door elkaar voor hetzelfde onderwerp — elk onderwerp komt precies één keer voor, met als status bijvoorbeeld "Te controleren", "Op te vragen", "Te vestigen", "Te verifiëren", "Te monitoren", "Te onderbouwen" of "Nader af te stemmen"). Aansluitend compact "Ontvangen / gebruikt" (alleen daadwerkelijk aangeleverde of expliciet in de bron opgenomen documenten) en "Nog te controleren" (alleen wat relevant is voor de financieringsbeoordeling). Nooit interne foutmeldingen of kwaliteitscontrole-taal in deze lijsten (dus nooit dingen als "bronnen en aanwendingen sluiten niet", "kerncijfers niet onderbouwd" of "bronregel staat verkeerd") — dat soort constateringen los je vóór oplevering zelf op in de brondata, ze verschijnen nooit in het externe rapport.
- Financieringssamenvatting: apart, laatste hoofdstuk (09) — maximaal 6 tot 8 regels, geen hard oordeel (zie CONCLUSIEBELEID).
- Cover/klantnaam en kredietnemer: bepaal de kredietnemer strikt volgens de bron. Noemt de bron een vastgoed-B.V. (eventueel i.o.) als beoogde kredietnemer/vastgoedhouder en de werkmaatschappij als huurder, gebruik dan NOOIT een formulering waarbij de werkmaatschappij als kredietnemer wordt weergegeven — vermeld beide met hun juiste rol, bijv. "[Vastgoed-B.V.] / [Werkmaatschappij] groep", en verwijs er verderop naar als "de vastgoed-B.V." resp. "de werkmaatschappij".
Kernonderdelen (financiële analyse, betaalcapaciteit, risico's, financieringssamenvatting, documentatie) mogen compact zijn of gecombineerd worden, maar mogen nooit volledig verdwijnen als de bron er inhoud voor biedt. Kort hoofdstukken in vóórdat je ze schrapt — het rapport moet korter zijn dan de bron, maar niet inhoudelijk leeg.

RAPPORTTYPEKEUZE — OP BASIS VAN COMPLEXITEIT, NIET VAN BRONLENGTE
Bepaal vóór het schrijven welk rapporttype nodig is (metadata.rapport_type):
- "compact_intake" (= rapporttype A): eenvoudige financieringen — financial lease, bedrijfsmiddelen-, machine- of voertuigfinanciering, relatief kleine aanvraag, geen vastgoedfinanciering, geen bedrijfsovername, beperkte broninformatie, geen uitgebreide prognose of kasstroomanalyse. De financieringsvraag is vooral bedoeld om documenten en uitgangspunten overzichtelijk te presenteren.
- "volwaardig_financieringsmemorandum" (= rapporttype B): complexere financieringen — vastgoedfinanciering, aankoop bedrijfspand, overname, herfinanciering, financiering met meerdere entiteiten (vastgoed-B.V./holding/werkmaatschappij), sources & uses met eigen inbreng, prognoses/DSCR/Debt-EBITDA beschikbaar, hypotheekrecht/verpanding/borgstelling/hoofdelijke aansprakelijkheid als zekerheid, of een substantiële aanvraag — óók als de bron zelf kort is.
- "luxe_samenvatting": alleen bij een zeer lange, herhalende bron waarvoor de adviseur expliciet een compactere bankversie vraagt; volgt verder de structuur en limieten van rapporttype B.
De bronlengte bepaalt dus NIET het type: een korte bron over een vastgoedaankoop is rapporttype B; een lange bijlagenbundel bij een eenvoudige lease blijft rapporttype A. Kort alleen in wat dubbel, wollig of niet-besluitvormingsrelevant is; laat omgekeerd niets kunstmatig groeien: secties zonder brondata blijven leeg.

SECTIESELECTIE — ALLEEN WAT DE BRON DRAAGT
Vul geen sectie voor onderwerpen die niet werkelijk in de bron staan: geen financiële analyse zonder cijfers; geen betaalcapaciteit zonder kasstroom, DSCR of rente-/aflossingsgegevens; geen marktsectie als de bron alleen operationele activiteiten noemt; geen object-/vastgoedsectie als vastgoed slechts zijdelings als bestaande zekerheid voorkomt; geen privésectie zonder relevante privéanalyse; geen lange conclusie zonder data. Laat zulke velden en arrays leeg. Maak nooit inhoud die alleen uit "niet opgenomen in bron" bestaat; ontbrekende maar relevante onderdelen benoem je kort als controlepunt (coverage_check.waarschuwingen) of vervolgvraag. Voeg geen standaardtekst toe om een sectie te vullen: het rapport moet mooier zijn dan de bron, niet langer dan de bron rechtvaardigt.
Sectieteksten (tekst-velden): volledige, afgeronde alinea's, zo lang als de broninhoud rechtvaardigt (typisch 60-300 woorden per veld). Gebruik lege regels tussen alinea's. Schrijf ALTIJD volledige zinnen; breek nooit een zin af en eindig nooit met "..." of "…". Tabellen: alle relevante rijen uit de bron (tot 24 per tabel). Bullets: tot 10 per lijst, alleen met echte informatie.

SECTIES (vul alleen wat de bron ondersteunt)
- managementsamenvatting: maximaal één pagina; kernboodschap van maximaal 180 woorden bij rapporttype B en maximaal 150 woorden bij rapporttype A (korte omschrijving onderneming, doel financiering, financieringsbehoefte), belangrijkste sterktes, belangrijkste risico's en belangrijkste voorwaarden/mitsen (aandachtspunten). Het veld voorlopig_oordeel wordt in het rapport getoond als "Financieringssamenvatting": schrijf het als financieringsgerichte samenvatting, NIET als kredietoordeel — bijv. "De aanvraag biedt voldoende aanknopingspunten voor verdere beoordeling door financiers. De combinatie van eigen inbreng, beschikbare zekerheden, positieve historische resultaten en onderbouwde prognose vormt de basis voor het opvragen van passende financieringsvoorstellen. De belangrijkste aandachtspunten zijn …"
- aanvraag_en_transactie: aanleiding, financieringsdoel, investering, timing en gewenste structuur. Vul het veld besluitvormingsvraag met het "Doel van de aanvraag": één financieringsgerichte zin in de vorm "Het opvragen van financieringsvoorstellen voor …" — nooit een interne besluitvormings- of kredietvraag.
- juridische_structuur: alle betrokken rechtspersonen en privépersonen (rol, rechtsvorm, KvK), bestuur en tekenbevoegdheid, aandeelhouders/UBO's. Vul structuur_tekstueel ALTIJD met een compact tekstueel structuurschema: korte, feitelijke bulletzinnen, één relatie per regel, met de daadwerkelijke namen uit de bron (bijv. "[Naam bestuurder] is uiteindelijk belanghebbende.", "[Holding B.V.] houdt 100% van de aandelen in [Werkmaatschappij B.V.].", "[Vastgoed B.V.] i.o. koopt en verhuurt het bedrijfspand zakelijk aan [Werkmaatschappij B.V.].") — dit format is illustratief, gebruik nooit deze placeholder-namen zelf. Dit is de weergave in het rapport wanneer geen net organogram mogelijk is.
- ORGANOGRAMMEN: als de bron een organogram, structuurplaatje of groepsstructuur bevat (bestaand en/of nieuw), reconstrueer die VOLLEDIG in organogram_bestaand / organogram_nieuw: aanwezig=true; titel; entiteiten met uniek kort id (bijv. "e1"), naam, type (privepersoon | holding | werkmaatschappij | vastgoed_bv | stak | in_oprichting | overig) en rol (bijv. "Kredietnemer", "Mede-kredietnemer", "Zekerheidssteller"); relaties van eigenaar ("van") naar deelneming ("naar") met label voor het percentage of de relatie (bijv. "100%", "60%", "certificaten"). Een structuurplaatje uit de bron mag NOOIT verdwijnen. Bevat de bron een organogram of een eenduidig beschreven aandelenstructuur, dan is een gereconstrueerd organogram (aanwezig=true) of een volledig gevuld structuur_tekstueel VERPLICHT — het rapport mag nooit zonder structuurweergave verschijnen. Een structuur die alleen in tekst beschreven staat mag je ook zo reconstrueren. Reconstrueer alleen wat eenduidig uit de bron volgt: geen dubbele of tegenstrijdige percentages, geen onduidelijke blokken. Regels voor een net organogram: toon iedere persoon of entiteit maximaal één keer, toon percentages slechts één keer per relatie, geen dubbele 100%-labels of dubbele blokken. Is de structuur te onduidelijk voor een net organogram, laat aanwezig dan op false — het rapport toont dan het tekstuele structuurschema (structuur_tekstueel). Een helder tekstueel structuurschema is beter dan een rommelig organogram. Maak NOOIT twee visuele organogrammen in één rapport: bevat de bron zowel een bestaande als een nieuwe structuur, reconstrueer dan alleen de nieuwe structuur (organogram_nieuw, aanwezig=true) en beschrijf de bestaande situatie in structuur_tekstueel. Bij een eenvoudige leaseaanvraag (rapporttype A) heeft een tekstueel schema altijd de voorkeur boven een visueel organogram.
- activiteiten_onderneming: historie, bedrijfsactiviteiten, verdienmodel, strategie, omzetstromen, operationele aandachtspunten.
- markt_en_omgeving: marktpositie, concurrentie, trends, afnemers, leveranciers, afhankelijkheden, seizoenspatroon, debiteuren-/crediteurenrisico.
- management_en_organisatie: ondernemer(s) en team met rol en achtergrond/ervaring, externe adviseurs, KPI's/rapportages.
- financieringsopzet: kerncijfers, bronnen en aanwendingen, bestaande én nieuwe faciliteiten met condities, bouwdepot/fasering, btw-aspecten, voorwaarden. Vul kerncijfers zo volledig mogelijk voor de cover: gevraagde financiering, totale investering, eigen inbreng (en herkomst), looptijd, rente, aflossingsstructuur (incl. aflossingsvrije periode en start aflossing) en LTV bij vastgoed. Benoem condities kort in de tekst: hoofdsom, rente, looptijd, aflossing, bouwdepot/fasering indien relevant.
- object_en_vastgoed: adres, type object, oppervlakte, taxatiewaarde en taxatiedatum, energielabel, erfpacht, gebruik/verhuur, LTV — als kenmerken-rijen {label, waarde}.
- financiele_analyse: historische cijfers én prognose. resultaten en balans als rijen {label, periode, bedrag}; gebruik consistente labels per periode zodat er een tabel per jaar van te maken is (bijv. label "Omzet" met periode "2024"). Prognosejaren markeren met "(prognose)" in de periode. Beperk tot kernposten: resultaten met in elk geval omzet, bedrijfsresultaat en resultaat na belasting; balans met in elk geval liquide middelen en eigen vermogen. In het rapport wordt dit één compacte tabel met maximaal 5 observaties.
- betaalcapaciteit: historische en genormaliseerde betaalcapaciteit, correcties, privéonttrekkingen/privébehoefte, rente- en aflossingsverplichtingen, DSCR, Debt/EBITDA, overgangsjaar versus structurele situatie. Tabel als {label, periode, bedrag}; DSCR/Debt-EBITDA als kengetallen-rijen. Vul daarnaast dscr_overzicht met één rij per (prognose)jaar: jaar, situatie (bijv. "Bouwfase, alleen rente", "Overgangsjaar", "Structurele situatie"), dscr als ratio met de decimalen exact uit de bron (bijv. "3,11" — nooit een eurobedrag) en een korte financieringsgerichte toelichting (bijv. "Ruime rentedekking", "Tijdelijke druk door dubbele lasten, verklaarbaar", "Herstel na wegvallen externe huur"). Laat dscr_overzicht leeg als de bron geen DSCR bevat. Geef DSCR per prognosejaar met de situatie erbij (bijv. "2026 — bouwfase, alleen rente", "2027 — overgangsjaar, tijdelijke druk door dubbele lasten", "2028 — structurele situatie") en sluit af met een expliciete kwalificatie van de betaalcapaciteit: ruim voldoende, voldoende, tijdelijk krapper maar verklaarbaar, of afhankelijk van realisatie van de prognose — uitsluitend onderbouwd door broncijfers en zonder harde negatieve kwalificatie.
- inkomen_vermogen_prive: alleen indien de bron dit bevat: inkomen ondernemer, partnerinkomen, woningwaarde, hypotheek, vermogen, privébehoefte — als posten {label, waarde} — plus relevantie voor de financiering.
- zekerheden_en_risico: alle zekerheden met waarde en status, dekkingspositie, volledige risicomatrix (elk risico met kans, impact en mitigant), bancaire aandachtspunten. Neem het juridische zekerheidslabel EXACT over uit de bron: maak van hoofdelijke aansprakelijkheid nooit een borgstelling en omgekeerd; maak van een mogelijke of "indien nodig aan te reiken" zekerheid nooit een definitief gevestigde zekerheid. status: volg de bron en gebruik één van — "gevestigd", "bestaand", "te vestigen", "aangeboden", "aanvullend aan te bieden", "nog te formaliseren", "voorwaardelijk", "nog te controleren", of leeg indien onbekend. De standaardvocabulaire voor een NIEUWE zekerheid die nog niet is gevestigd is: "te vestigen" (nog te vestigen zekerheidsrecht), "nader te formaliseren" (juridisch nog vast te leggen), "aanvullend aan te bieden" (mogelijke extra zekerheid), "indien door financier vereist" (voorwaardelijk op de financier). Schrijf NOOIT "aan te reiken" in de output — gebruik "aanvullend aan te bieden", "mogelijk aanvullend te vestigen", "nader te bepalen" of "indien door financier gewenst". Schrijf nooit "gevestigd" als de zekerheid nog niet daadwerkelijk gevestigd is (bijv. bij de aankoop van een nieuw bedrijfspand is het eerste hypotheekrecht per definitie nog NIET gevestigd, ook niet als het rapport het als "primaire zekerheid" beschrijft) — gebruik dan "te vestigen", "nader te formaliseren", "voorwaarde voor financiering" of "indien door financier vereist". Schrijf ook nooit een harde afsluitende conclusie zoals "de zekerheid dekt volledig" of "solide zekerheden" als samenvattend hard oordeel over de dekkingspositie; gebruik in plaats daarvan een afgewogen formulering zoals "De zekerheidstelling biedt een duidelijke basis voor verdere beoordeling, waarbij definitieve vestiging van het eerste hypotheekrecht en eventuele aanvullende zekerheden nog moeten worden afgestemd." Bestaande zekerheden (van een lopende financiering) gelden niet automatisch ook voor de nieuwe aanvraag, tenzij de bron dat expliciet zo zegt. Marktwaarde/WOZ-waarde, hypotheekschuld en overwaarde zijn aparte gegevens: maak van overwaarde of hypotheekschuld geen zekerheidswaarde tenzij de bron dat expliciet zo presenteert; noemt de bron overwaarde van een privéwoning slechts als mogelijke aanvullende zekerheid, neem dit dan ook zo terughoudend op — niet als reeds gevestigd onderdeel van de zekerhedenmix. Voorbeeld vastgoed: "De primaire zekerheid bestaat uit een eerste hypotheekrecht op het bedrijfspand. Een tweede hypotheek op de privéwoning is in de bron genoemd als aanvullend aan te bieden zekerheid indien door de financier gewenst." Voorbeeld lease: "Voor de nieuwe lease wordt verpanding van de te financieren bedrijfsmiddelen genoemd. Bestaande hypotheek- en borgstellingszekerheden zijn opgenomen als context bij bestaande financieringen en gelden niet automatisch als zekerheid voor de nieuwe lease, tenzij de bron dit expliciet vermeldt." Formuleer de dekkingspositie nooit positiever dan de bron toelaat wanneer aanvullende zekerheden nog niet definitief zijn. Schrijf nooit "de zekerheid dekt de lening volledig"; formuleer voorzichtiger, bijv. "De primaire zekerheid bestaat uit een eerste hypotheekrecht op het object. De LTV bedraagt circa X% op basis van de taxatiewaarde." Maak in de tekst altijd onderscheid tussen bestaande zekerheden, te vestigen zekerheden en aanvullende mogelijke zekerheden; schrijf nooit "gevestigd" als een recht nog niet definitief gevestigd is — gebruik dan "te vestigen" of "voorwaarde voor financiering".

BRONNEN EN AANWENDINGEN
Neem de tabel letterlijk uit de bron over. Bronnen = waar het geld vandaan komt (hypothecaire/bancaire lening, eigen inbreng, achtergestelde lening, vendor loan, subsidie, btw-financiering). Aanwendingen = waar het geld naartoe gaat (koop-/aanneemsom, btw, notaris, taxatie, financierings- en advieskosten, onvoorzien, werkkapitaal, herfinanciering). Eigen inbreng of een lening hoort niet onder aanwendingen; een koop-/aanneemsom of kosten koper hoort niet onder bronnen — wijkt de bron hiervan af, volg dan de bron en neem een controlepunt op. Bouwdepottermijnen tellen niet mee als bron (regel 8). Als de bron sluit (investering = financiering), moeten jouw totalen exact gelijk zijn; sluit de bron zelf niet, benoem het verschil dan in een toelichting. Markeer totaal-, subtotaal- en saldoregels (zoals "Totaal investering", "Totale financiering", "Totaal bronnen", "Financieringsbehoefte", "Subtotaal", "Eindtotaal") met totaalregel=true: een totaalregel is nooit een detailpost en telt nooit mee in een optelling. Staat er een brontotaal, gebruik dan dat brontotaal en bereken geen nieuw totaal daarbovenop; alleen als de bron géén totaal geeft mag je detailregels optellen, met "berekend op basis van bronregels" in de toelichting.

DATUMREGELS
metadata.documentdatum: de datum van het brondocument zelf (voorblad, "opgesteld op", documentmetadata) in Nederlandse notatie; leeg als die niet vaststaat. metadata.rapportdatum: de datum van dít rapport — gebruik de actuele datum. Gebruik NOOIT een geboortedatum, oprichtingsdatum of taxatiedatum als document- of rapportdatum. Bij twijfel: documentdatum leeg laten en toelichten in datum_toelichting.

AFBEELDINGEN UIT DE BRON
Je kunt beeldmateriaal uit een PDF niet als afbeelding opnieuw aanleveren. Registreer daarom elk relevant beeld (rendering, objectfoto, plattegrond, bouwplanning, grafiek, schema) in bronrapport.gevonden_afbeeldingen met een korte, concrete omschrijving. Organogrammen reconstrueer je als data (zie boven). Feitelijke informatie die alleen in beelden staat (adres op een rendering, oppervlaktes op een plattegrond) verwerk je in de betreffende sectie als tekst of kenmerk.

SCHRIJFSTIJL
Zakelijk Nederlands in Credion-stijl: helder, professioneel, adviserend, bancair. Korte alinea's, duidelijke bullets. Geen marketingtaal, geen superlatieven, geen wollige AI-taal, geen onnodig juridisch jargon. Behoud de nuance uit de bron; verbeter de taal waar de bron wollig of herhalend is. Het rapport moet voelen alsof een ervaren financieringsadviseur het heeft opgesteld. Schrijf uitsluitend Nederlands: geen Engelse restwoorden zoals "expected", "fluctuations", "report", "source" of "business case" — gebruik "verwacht", "schommelingen", enzovoort. Verboden in de output: "undefined", "null", "NaN", "deelnemers wordt aanbevolen", "goedgekeurd de aanvraag", "verifiren" (schrijf "verifiëren"), "Risicos" (schrijf "risico's"), "continuiteit" (schrijf "continuïteit"), "Realizatie" (schrijf "realisatie"), "be%C3%AFnvloedt" of andere URL-encoded tekens in lopende tekst (schrijf "beïnvloedt" — dit duidt op een encoderingsfout), "privgedeelte" (schrijf "privégedeelte"), "formaliteren" (schrijf "formaliseren"), "persoonlijke borgstelling" als de bron alleen hoofdelijke aansprakelijkheid noemt, "volledig in gebruik" bij nieuwbouw als de bron een latere oplevering noemt. Gebruik voor bouwdepot-opnames de term uit de bron (meestal "afgeroepen worden voor verzending/uitbetaling"); vervang dit nooit door "verpand worden" — verpanding is een zekerheidsrecht en betekent iets heel anders dan het opvragen/afroepen van een bouwdepottermijn. Geen dubbele koppen: herhaal een hoofdstuktitel niet als eerste zin van de sectietekst. Let op correcte accenten in Nederlandse woorden (financiële, privé, ratio's). Let op correcte vaktermen ("verzwaring" of "tijdelijke druk", nooit "verzuring"). Vermijd "circa" waar het exacte broncijfer beschikbaar is. Controleer taal en opmaak vóór oplevering: geen slordigheden zoals "wins", "definitive", "Most representatieve ratio", woorden met een losse spatie erin ("gevestig d"), afgebroken woorden of half-Engelse koppen. Gebruik in lopende tekst nooit "aan te reiken" — wel "aanvullend aan te bieden", "mogelijk aanvullend te vestigen" of "nader te bepalen".

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
klantnaam: de kredietnemer/onderneming zoals in de bron. Let op de juiste kredietnemer: wordt de financiering feitelijk aangevraagd door een nieuw op te richten (vastgoed-)B.V., benoem dan niet alleen de werkmaatschappij maar beide, in het format "[Vastgoed-B.V.] i.o. / [Werkmaatschappij] groep" — met de daadwerkelijke namen uit de bron, nooit deze placeholder-tekst zelf. financieringsdoel: één compacte zin. status: altijd "Concept · ter beoordeling". kantoor_adviseur: het Credion-kantoor en/of de adviseur zoals vermeld in de bron; leeg indien onbekend. datadekking: jouw eerlijke inschatting (wordt server-side geverifieerd).

OUTPUT
Antwoord uitsluitend met valide JSON volgens het schema. Geen markdown, geen tekst buiten de JSON.`;

function buildPrompt({ notities, docSummary, vandaag, bytesPageCount, uitgebreid }) {
  const base = bytesPageCount
    ? `De aangeleverde bron-PDF telt ${bytesPageCount} pagina${bytesPageCount === 1 ? '' : "'s"}. `
    : "Het exacte aantal bronpagina's kon niet automatisch worden bepaald: vul bronrapport.aantal_paginas zo nauwkeurig mogelijk in. ";
  const budgetLine = base
    + "De bronlengte bepaalt het rapporttype en het paginabudget NIET. Rapporttype A (compact_intake): maximaal 7 pagina's, doellengte 5 à 7 — inhoudsopgave en kernsamenvatting delen één pagina. Rapporttype B (volwaardig financieringsmemorandum of luxe samenvatting): richtlengte 10 tot 12 pagina's, maximaal 14 — inhoudsopgave en managementsamenvatting delen één pagina. Volledigheid weegt zwaarder dan een streng paginabudget: neem structuur, juridische opzet, financiële analyse mét prognose, betaalcapaciteit, zekerheden, risico's en documentatie allemaal netjes en volledig op. Wees niet nodeloos uitgebreid, maar laat nooit inhoud sneuvelen om binnen een paginabudget te blijven."
    + (uitgebreid ? ' De adviseur vroeg om een uitgebreid rapport: benut het maximum van het gekozen rapporttype, maar overschrijd het nooit.' : '');

  return `${SYSTEM_BASE}

AANGELEVERDE DOCUMENTEN
${docSummary}

PAGINABUDGET
${budgetLine}

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
  [/([A-Za-zÀ-ÿ])\uFFFD9/g, '$1é'],
  [/\bfinancie\s?9le\b/gi, 'financiële'],
  [/\bsamenwerking\s+van\s+(?=huur)/gi, 'samenloop van '],
  [/\bsamenwerking\s+(?=huur)/gi, 'samenloop van '],
  [/\bgeconstrueerde(?=\s+bouw)/gi, 'gefaseerde'],
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
    if (/^(undefined|null|NaN|\[object Object\])$/i.test(v.trim())) return '';
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

function enforceQuality(r, vandaag, opts = {}) {
  const { bytesPageCount = null, uitgebreid = false } = opts;
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

  /* 2 — bronnen/aanwendingen: totaalregels, classificatie + sluitcheck.
     enforceBnA levert zowel zakelijke controlepunten (sluiting, herclassificatie)
     als een puur tekstuele euroteken-fix (cleanRatios) — die laatste is intern. */
  enforceBnA(fo, warnings);
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

  /* 4b — nooit twee visuele organogrammen: bij bestaand én nieuw wint de nieuwe
     structuur; de bestaande situatie blijft beschikbaar via structuur_tekstueel. */
  const ju = r.juridische_structuur || {};
  if (ju.organogram_bestaand?.aanwezig === true && ju.organogram_nieuw?.aanwezig === true) {
    ju.organogram_bestaand.aanwezig = false;
    internal.push('Twee organogrammen aangeleverd; alleen de nieuwe structuur wordt visueel getoond.');
  }

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
     Rapporttype A: maximaal 7 pagina's. Rapporttype B/luxe: richtlengte 10-12
     pagina's, maximaal 14 — volledigheid (structuur, financiële analyse, prognose,
     betaalcapaciteit, zekerheden, risico's, documentatie) weegt zwaarder dan een
     streng paginabudget. De bronlengte beïnvloedt het paginabudget niet. */
  const HARD_MAX_PAGES = 14;
  const MAX_BY_TYPE = { compact_intake: 7, volwaardig_financieringsmemorandum: 14, luxe_samenvatting: 14 };
  r.metadata.sourcePageCount = sourcePageCount;
  r.metadata.uitgebreidToegestaan = !!uitgebreid;
  r.metadata.maxOutputPages = Math.min(HARD_MAX_PAGES, MAX_BY_TYPE[r.metadata.rapport_type] || 11);

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

/* Vercel's default functietimeout is te kort voor een PDF-analyse door het model.
   Deze regel verlengt de limiet naar het maximum dat het Vercel-abonnement toelaat
   (Hobby: 60s, Pro: 300s, Enterprise: 900s) — zet 'm hoger als het plan dat toestaat. */
export const maxDuration = 60;

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
    const prompt = buildPrompt({ notities, docSummary, vandaag, bytesPageCount, uitgebreid });
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
      report = enforceQuality(parsed, vandaag, { bytesPageCount, uitgebreid });
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
