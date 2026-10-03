/**
 * Darwin Core Archive with Event core + Occurrence extension + Humboldt
 * (eco:Event) extension — the GBIF-recommended packaging for survey data
 * (GBIF "Guide for publishing biological survey and monitoring data",
 * DOI 10.35035/doc-ynvs-eh84: Event core, nested eventID/parentEventID,
 * TAB-delimited text + meta.xml + eml.xml in a zip).
 *
 * Extension row type / term namespace verified against the live GBIF registry
 * extension (humboldt_2025-07-10.xml): rowType http://rs.tdwg.org/eco/terms/Event,
 * namespace http://rs.tdwg.org/eco/terms/. Every eco term used below appears
 * in that file's property list.
 *
 * meta.xml field indices and the txt column order are generated from the SAME
 * column spec arrays, so they cannot drift apart.
 *
 * Pure module (fflate only) — Node-runnable for scripts/check-vegmatrix.mjs.
 */
import { strToU8, zipSync } from 'fflate';

const DWC = 'http://rs.tdwg.org/dwc/terms/';
const ECO = 'http://rs.tdwg.org/eco/terms/';
const DCT = 'http://purl.org/dc/terms/';
const EMOF = 'http://rs.iobis.org/obis/terms/';
const GBIF = 'http://rs.gbif.org/terms/1.0/';
const IUCN = 'http://iucn.org/terms/';

type ColSpec = { key: string; term: string };

/** Event core columns. Index 0 doubles as the core <id>. */
export const EVENT_COLS: ColSpec[] = [
  { key: 'eventID', term: `${DWC}eventID` },
  { key: 'parentEventID', term: `${DWC}parentEventID` },
  { key: 'eventDate', term: `${DWC}eventDate` },
  { key: 'samplingProtocol', term: `${DWC}samplingProtocol` },
  { key: 'sampleSizeValue', term: `${DWC}sampleSizeValue` },
  { key: 'sampleSizeUnit', term: `${DWC}sampleSizeUnit` },
  // A permanent plot's uuid: every census and survey on it share it (Modular_survey.md §7.4).
  { key: 'locationID', term: `${DWC}locationID` },
  { key: 'locality', term: `${DWC}locality` },
  { key: 'decimalLatitude', term: `${DWC}decimalLatitude` },
  { key: 'decimalLongitude', term: `${DWC}decimalLongitude` },
  { key: 'coordinateUncertaintyInMeters', term: `${DWC}coordinateUncertaintyInMeters` },
  // Datum and elevation terms come from dwcLocation.ts — see there for the
  // TDWG definitions they follow.
  { key: 'geodeticDatum', term: `${DWC}geodeticDatum` },
  { key: 'minimumElevationInMeters', term: `${DWC}minimumElevationInMeters` },
  { key: 'maximumElevationInMeters', term: `${DWC}maximumElevationInMeters` },
  { key: 'verticalDatum', term: `${DWC}verticalDatum` },
  { key: 'recordedBy', term: `${DWC}recordedBy` },
  { key: 'eventRemarks', term: `${DWC}eventRemarks` },
];

export const OCCURRENCE_COLS: ColSpec[] = [
  { key: 'occurrenceID', term: `${DWC}occurrenceID` },
  // A census tree is one organism seen in every census (§7.4): its uuid.
  { key: 'organismID', term: `${DWC}organismID` },
  { key: 'basisOfRecord', term: `${DWC}basisOfRecord` },
  // GBIF's present / absent (its Occurrence definition still uses them; TDWG's
  // newer detected / notDetected waits for GBIF, Modular_survey.md §10). An
  // absence is a species of the previous survey not found on the recheck.
  { key: 'occurrenceStatus', term: `${DWC}occurrenceStatus` },
  // alive / dead / uncertain of a census tree (§7.4; status.ts vitality).
  { key: 'vitality', term: `${DWC}vitality` },
  { key: 'taxonID', term: `${DWC}taxonID` },
  { key: 'scientificName', term: `${DWC}scientificName` },
  { key: 'scientificNameAuthorship', term: `${DWC}scientificNameAuthorship` },
  { key: 'verbatimIdentification', term: `${DWC}verbatimIdentification` },
  // Herbarium bookkeeping (v43). `preparations` names the METHOD only —
  // TDWG's definition is "a list of preparations and preservation methods",
  // and every published example is a method name. The duplicate COUNT does
  // not belong in it; it goes to eMoF, where a fact with no core term belongs.
  { key: 'institutionCode', term: `${DWC}institutionCode` },
  { key: 'catalogNumber', term: `${DWC}catalogNumber` },
  { key: 'otherCatalogNumbers', term: `${DWC}otherCatalogNumbers` },
  { key: 'preparations', term: `${DWC}preparations` },
  { key: 'vernacularName', term: `${DWC}vernacularName` },
  { key: 'family', term: `${DWC}family` },
  { key: 'kingdom', term: `${DWC}kingdom` },
  { key: 'organismQuantity', term: `${DWC}organismQuantity` },
  { key: 'organismQuantityType', term: `${DWC}organismQuantityType` },
  // Taxonomy. `higherClassification` is the `|`-joined chain and the five
  // rank columns are the addressable form — GBIF indexes the columns, humans
  // read the chain, and neither substitutes for the other.
  { key: 'taxonRank', term: `${DWC}taxonRank` },
  { key: 'higherClassification', term: `${DWC}higherClassification` },
  { key: 'phylum', term: `${DWC}phylum` },
  { key: 'class', term: `${DWC}class` },
  { key: 'order', term: `${DWC}order` },
  { key: 'superfamily', term: `${DWC}superfamily` },
  { key: 'subfamily', term: `${DWC}subfamily` },
  { key: 'tribe', term: `${DWC}tribe` },
  { key: 'subtribe', term: `${DWC}subtribe` },
  { key: 'genus', term: `${DWC}genus` },
  { key: 'subgenus', term: `${DWC}subgenus` },
  // Set only when the user deliberately filed the record under a name the
  // checklist does not accept: `scientificName` then holds that name and these
  // two say what the checklist would have used instead.
  { key: 'taxonomicStatus', term: `${DWC}taxonomicStatus` },
  { key: 'acceptedNameUsage', term: `${DWC}acceptedNameUsage` },
  { key: 'acceptedNameUsageID', term: `${DWC}acceptedNameUsageID` },
  { key: 'sex', term: `${DWC}sex` },
  { key: 'lifeStage', term: `${DWC}lifeStage` },
  { key: 'reproductiveCondition', term: `${DWC}reproductiveCondition` },
  { key: 'degreeOfEstablishment', term: `${DWC}degreeOfEstablishment` },
  // Taxon-level ("native to Taiwan"), unlike degreeOfEstablishment above,
  // which is about this individual. Controlled vocabulary — see
  // `establishmentMeansDwcValue`.
  { key: 'establishmentMeans', term: `${DWC}establishmentMeans` },
  // Only when organismQuantityType really is a count of individuals; cover
  // classes and DBH lists stay in the organismQuantity pair.
  { key: 'individualCount', term: `${DWC}individualCount` },
  { key: 'eventDate', term: `${DWC}eventDate` },
  { key: 'decimalLatitude', term: `${DWC}decimalLatitude` },
  { key: 'decimalLongitude', term: `${DWC}decimalLongitude` },
  { key: 'coordinateUncertaintyInMeters', term: `${DWC}coordinateUncertaintyInMeters` },
  // Datum and altitude (dwcLocation.ts): one measured altitude is written as
  // both limits, with the vertical datum it was measured against.
  { key: 'geodeticDatum', term: `${DWC}geodeticDatum` },
  { key: 'minimumElevationInMeters', term: `${DWC}minimumElevationInMeters` },
  { key: 'maximumElevationInMeters', term: `${DWC}maximumElevationInMeters` },
  { key: 'verticalDatum', term: `${DWC}verticalDatum` },
  // Specimen-only; blank for observations.
  { key: 'recordNumber', term: `${DWC}recordNumber` },
  { key: 'identifiedBy', term: `${DWC}identifiedBy` },
  { key: 'dateIdentified', term: `${DWC}dateIdentified` },
  { key: 'occurrenceRemarks', term: `${DWC}occurrenceRemarks` },
  // Dublin Core, not DwC — `modified` has no dwc: term.
  { key: 'modified', term: `${DCT}modified` },
];

/**
 * Extended MeasurementOrFact (OBIS), for observations Darwin Core has no term
 * for — leaf phenology, duplicate sheets, and quadrat cover / frequency /
 * surface cover.
 *
 * **Why eMoF and not `dwc:MeasurementOrFact`**: the plain MoF extension has no
 * `occurrenceID` (checked against measurements_or_facts_2025-07-10.xml, 11
 * properties). An extension row links to the core by `coreid`, and our core is
 * Event, so a plain MoF row says "this fact is about the survey event" — it
 * cannot say which plant was deciduous. eMoF adds `dwc:occurrenceID` for
 * exactly this, which is why OBIS minted it.
 *
 * A star schema also fixes something a flat column could not: leaf phenology is
 * multi-valued in this app, and here each value is its own row instead of a
 * pipe-joined string a consumer has to re-split.
 */
export const MEASUREMENT_COLS: ColSpec[] = [
  { key: 'measurementID', term: `${DWC}measurementID` },
  { key: 'occurrenceID', term: `${DWC}occurrenceID` },
  { key: 'measurementType', term: `${DWC}measurementType` },
  { key: 'measurementValue', term: `${DWC}measurementValue` },
  // Both in extended_measurement_or_fact_2023-08-28.xml (rs.gbif.org, checked
  // 2026-09-29): quadrat cover / frequency are percentages.
  { key: 'measurementUnit', term: `${DWC}measurementUnit` },
  // The census: when and by whom a stem was measured, and its full tag (§7.4).
  // All three in the same extension file (13 properties).
  { key: 'measurementDeterminedDate', term: `${DWC}measurementDeterminedDate` },
  { key: 'measurementDeterminedBy', term: `${DWC}measurementDeterminedBy` },
  { key: 'measurementMethod', term: `${DWC}measurementMethod` },
  { key: 'measurementRemarks', term: `${DWC}measurementRemarks` },
];

/**
 * Give each eMoF row its coreid: the event of the occurrence it is about. A
 * row made on an event (quadrat surface cover) already has one. Before
 * 2026-09-29 the occurrence-level rows (leaf phenology, duplicate count)
 * carried none, so their coreid column was empty and linked to nothing.
 */
export function linkMeasurements(occurrences: readonly DwcRow[], measurements: DwcRow[]): void {
  const eventOf = new Map(occurrences.map((o) => [String(o.occurrenceID), o.coreEventID]));
  for (const m of measurements) {
    if (m.coreEventID == null && m.occurrenceID) m.coreEventID = eventOf.get(String(m.occurrenceID));
  }
}

export const HUMBOLDT_COLS: ColSpec[] = [
  { key: 'siteCount', term: `${ECO}siteCount` },
  { key: 'siteNestingDescription', term: `${ECO}siteNestingDescription` },
  { key: 'totalAreaSampledValue', term: `${ECO}totalAreaSampledValue` },
  { key: 'totalAreaSampledUnit', term: `${ECO}totalAreaSampledUnit` },
  { key: 'eventDurationValue', term: `${ECO}eventDurationValue` },
  { key: 'eventDurationUnit', term: `${ECO}eventDurationUnit` },
  { key: 'protocolNames', term: `${ECO}protocolNames` },
  { key: 'samplingPerformedBy', term: `${ECO}samplingPerformedBy` },
  { key: 'isAbundanceReported', term: `${ECO}isAbundanceReported` },
  { key: 'isVegetationCoverReported', term: `${ECO}isVegetationCoverReported` },
  { key: 'isAbsenceReported', term: `${ECO}isAbsenceReported` },
];

/**
 * Taxon core — the second archive.
 *
 * Conservation status is a property of the TAXON, not of an observation, and
 * the Distribution extension that carries it is `dc:subject = dwc:Taxon` with
 * no `taxonID` or `occurrenceID` field of its own: rows attach by `coreid`
 * alone. Under the Event core of the main archive that coreid is an eventID,
 * which would say "this survey is Endangered". A DwC archive has exactly one
 * core, so the only correct home is a second archive whose core IS the taxon.
 *
 * It also stops the status being repeated on every record of a species —
 * one row per taxon, stated once.
 */
export const TAXON_COLS: ColSpec[] = [
  { key: 'taxonID', term: `${DWC}taxonID` },
  { key: 'scientificName', term: `${DWC}scientificName` },
  { key: 'scientificNameAuthorship', term: `${DWC}scientificNameAuthorship` },
  { key: 'taxonRank', term: `${DWC}taxonRank` },
  { key: 'kingdom', term: `${DWC}kingdom` },
  { key: 'phylum', term: `${DWC}phylum` },
  { key: 'class', term: `${DWC}class` },
  { key: 'order', term: `${DWC}order` },
  { key: 'superfamily', term: `${DWC}superfamily` },
  { key: 'family', term: `${DWC}family` },
  { key: 'subfamily', term: `${DWC}subfamily` },
  { key: 'tribe', term: `${DWC}tribe` },
  { key: 'subtribe', term: `${DWC}subtribe` },
  { key: 'genus', term: `${DWC}genus` },
  { key: 'subgenus', term: `${DWC}subgenus` },
  { key: 'higherClassification', term: `${DWC}higherClassification` },
  { key: 'vernacularName', term: `${DWC}vernacularName` },
  { key: 'taxonomicStatus', term: `${DWC}taxonomicStatus` },
  { key: 'acceptedNameUsage', term: `${DWC}acceptedNameUsage` },
  { key: 'acceptedNameUsageID', term: `${DWC}acceptedNameUsageID` },
];

/**
 * Distribution extension (GBIF, dwc:Taxon subject).
 *
 * A star schema keyed by distribution area, which is what makes it possible to
 * state the Taiwan red-list category and the global IUCN category on the same
 * taxon — two assessments at two scopes, two rows. A flat column cannot hold
 * two values of `threatStatus`, which is why the CSV keeps the global one
 * under the custom name `iucnRedListCategory`.
 */
export const DISTRIBUTION_COLS: ColSpec[] = [
  { key: 'locality', term: `${DWC}locality` },
  { key: 'countryCode', term: `${DWC}countryCode` },
  { key: 'occurrenceStatus', term: `${DWC}occurrenceStatus` },
  { key: 'establishmentMeans', term: `${DWC}establishmentMeans` },
  { key: 'threatStatus', term: `${IUCN}threatStatus` },
  { key: 'appendixCITES', term: `${GBIF}appendixCITES` },
  { key: 'source', term: `${DCT}source` },
];

/** A data row: values keyed by ColSpec key. Missing keys become empty cells.
 *  Extension rows additionally carry `coreEventID` (the coreid). */
export type DwcRow = Record<string, string | number | boolean | null | undefined>;

function cell(v: string | number | boolean | null | undefined): string {
  if (v === null || v === undefined) return '';
  // TAB-delimited with no field enclosure: strip the delimiters from values.
  return String(v).replace(/[\t\r\n]+/g, ' ');
}

function txtFile(cols: ColSpec[], rows: DwcRow[], withCoreId: boolean): string {
  const header = [...(withCoreId ? ['coreEventID'] : []), ...cols.map((c) => c.key)];
  const lines = [header.join('\t')];
  for (const r of rows) {
    const cells = [
      ...(withCoreId ? [cell(r.coreEventID)] : []),
      ...cols.map((c) => cell(r[c.key])),
    ];
    lines.push(cells.join('\t'));
  }
  return lines.join('\n');
}

function xmlEscape(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fieldTags(cols: ColSpec[], startIndex: number): string {
  return cols
    .map((c, i) => `    <field index="${startIndex + i}" term="${c.term}"/>`)
    .join('\n');
}

function buildMetaXml(): string {
  // Core: id at index 0 = eventID (also declared as a field so consumers see
  // the term). Extensions: coreid at index 0, fields from index 1.
  return `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/" metadata="eml.xml">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="http://rs.tdwg.org/dwc/terms/Event">
    <files><location>event.txt</location></files>
    <id index="0"/>
${fieldTags(EVENT_COLS, 0)}
  </core>
  <extension encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="http://rs.tdwg.org/dwc/terms/Occurrence">
    <files><location>occurrence.txt</location></files>
    <coreid index="0"/>
${fieldTags(OCCURRENCE_COLS, 1)}
  </extension>
  <extension encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="http://rs.tdwg.org/eco/terms/Event">
    <files><location>humboldt.txt</location></files>
    <coreid index="0"/>
${fieldTags(HUMBOLDT_COLS, 1)}
  </extension>
  <extension encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${EMOF}ExtendedMeasurementOrFact">
    <files><location>measurementorfact.txt</location></files>
    <coreid index="0"/>
${fieldTags(MEASUREMENT_COLS, 1)}
  </extension>
</archive>`;
}

export type DwcArchiveMeta = {
  /** Dataset title (project name). */
  title: string;
  abstract: string;
  /** Creator / contact person (project surveyors or empty). */
  creator: string;
  /** ISO date of packaging. */
  pubDate: string;
  packageId: string;
};

function buildEmlXml(meta: DwcArchiveMeta): string {
  const person = meta.creator
    ? `<individualName><surName>${xmlEscape(meta.creator)}</surName></individualName>`
    : `<organizationName>Mitalivana</organizationName>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<eml:eml xmlns:eml="eml://ecoinformatics.org/eml-2.1.1"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         packageId="${xmlEscape(meta.packageId)}" system="mitalivana" scope="system"
         xml:lang="zh-TW">
  <dataset>
    <title>${xmlEscape(meta.title)}</title>
    <creator>${person}</creator>
    <pubDate>${xmlEscape(meta.pubDate)}</pubDate>
    <language>zh-TW</language>
    <abstract><para>${xmlEscape(meta.abstract || meta.title)}</para></abstract>
    <contact>${person}</contact>
  </dataset>
</eml:eml>`;
}

export type DwcArchiveInput = {
  meta: DwcArchiveMeta;
  events: DwcRow[];
  occurrences: DwcRow[];
  humboldt: DwcRow[];
  /** Extended MeasurementOrFact rows; [] when nothing recorded one. */
  measurements: DwcRow[];
};

/** Assemble the archive zip bytes (event.txt + occurrence.txt + humboldt.txt
 *  + measurementorfact.txt + meta.xml + eml.xml). The caller stores these bytes into the outer bundle
 *  with { level: 0 } — no point re-deflating a deflate stream. */
export function buildDwcArchive(input: DwcArchiveInput): Uint8Array {
  return zipSync(
    {
      'meta.xml': strToU8(buildMetaXml()),
      'eml.xml': strToU8(buildEmlXml(input.meta)),
      'event.txt': strToU8(txtFile(EVENT_COLS, input.events, false)),
      'occurrence.txt': strToU8(txtFile(OCCURRENCE_COLS, input.occurrences, true)),
      'humboldt.txt': strToU8(txtFile(HUMBOLDT_COLS, input.humboldt, true)),
      'measurementorfact.txt': strToU8(txtFile(MEASUREMENT_COLS, input.measurements, true)),
    },
    { level: 6 },
  );
}

function buildTaxonMetaXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<archive xmlns="http://rs.tdwg.org/dwc/text/" metadata="eml.xml">
  <core encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="http://rs.tdwg.org/dwc/terms/Taxon">
    <files><location>taxon.txt</location></files>
    <id index="0"/>
${fieldTags(TAXON_COLS, 0)}
  </core>
  <extension encoding="UTF-8" fieldsTerminatedBy="\\t" linesTerminatedBy="\\n" fieldsEnclosedBy="" ignoreHeaderLines="1" rowType="${GBIF}Distribution">
    <files><location>distribution.txt</location></files>
    <coreid index="0"/>
${fieldTags(DISTRIBUTION_COLS, 1)}
  </extension>
</archive>`;
}

export type TaxonArchiveInput = {
  meta: DwcArchiveMeta;
  taxa: DwcRow[];
  distributions: DwcRow[];
};

/**
 * The companion Taxon-core archive: one row per taxon plus its distribution /
 * conservation rows. Returns null when there is nothing to say — an archive
 * whose only content is a header is noise in the bundle.
 *
 * Extension rows use `coreEventID` as the coreid field like every other
 * extension here; for this core the value is a taxonID. The field name is
 * the writer's internal one and never appears in the output.
 */
export function buildTaxonArchive(input: TaxonArchiveInput): Uint8Array | null {
  if (input.distributions.length === 0) return null;
  return zipSync(
    {
      'meta.xml': strToU8(buildTaxonMetaXml()),
      'eml.xml': strToU8(buildEmlXml(input.meta)),
      'taxon.txt': strToU8(txtFile(TAXON_COLS, input.taxa, false)),
      'distribution.txt': strToU8(txtFile(DISTRIBUTION_COLS, input.distributions, true)),
    },
    { level: 6 },
  );
}

/** Exposed for the check script: header of each txt vs meta.xml field order. */
export const DWCA_INTERNALS = { buildMetaXml, buildTaxonMetaXml, txtFile };
