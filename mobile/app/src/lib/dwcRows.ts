/**
 * Darwin Core Archive row assembly: plots / sessions / collection trips →
 * Event core + Occurrence extension + Humboldt extension rows, zipped by
 * `dwcArchive.ts`.
 *
 * Its own module (rather than living in `projectExport.ts`) because both the
 * project export and the per-record exports in `bundleExport.ts` need it, and
 * `projectExport` already imports `bundleExport` — putting it there would make
 * that a cycle.
 */
import {
  listPlotSpecies,
  listSessionRecords,
  listSpecimens,
  listSubplots,
  type CollectionTrip,
  type PlotSurvey,
  type Session,
} from '~/db';
import { localIso, multiToPipe } from './bundleYaml';
import { publishedTaxonId } from './taxonId';
import { establishmentDwcValue } from './dwcAttributes';
import {
  citesAppendixDwcValue,
  establishmentMeansDwcValue,
  higherClassificationOf,
  individualCountOf,
  parseMultiAttribute,
  threatStatusDwcValue,
} from './dwcMultiValue';
import { buildDwcArchive, buildTaxonArchive, type DwcRow } from './dwcArchive';

/**
 * One eMoF row per leaf-phenology value of one occurrence.
 *
 * Star schema, so a record that is both deciduous and evergreen (possible for
 * a genus-level determination) becomes two rows rather than a pipe-joined
 * string. `measurementID` is derived, not random, so re-exporting the same
 * record twice produces the same archive — a random id would make every
 * export differ from the last for no reason, which also matters for the
 * per-file hashes the manifest is about to carry.
 */
/**
 * The number of duplicate sheets, as an extended MeasurementOrFact row.
 *
 * Darwin Core has no term for it. `preparations` is a list of preparation
 * METHODS ("a list of preparations and preservation methods" — every TDWG
 * example is a method name), so folding a count into it would hand the
 * receiving system a preparation literally called `sheet (3)`.
 * `individualCount` is the number of individuals present, which is a different
 * quantity: three sheets of one plant is one individual.
 */
function duplicateCountRows(occurrenceID: string, count: number | null): DwcRow[] {
  if (count == null) return [];
  return [
    {
      measurementID: `${occurrenceID}:duplicateCount`,
      occurrenceID,
      measurementType: 'duplicateCount',
      measurementValue: String(count),
    },
  ];
}

function leafPhenologyRows(occurrenceID: string, leafPhenology: string | null): DwcRow[] {
  return parseMultiAttribute(leafPhenology).map((value) => ({
    measurementID: `${occurrenceID}:leafPhenology:${value}`,
    occurrenceID,
    measurementType: 'leafPhenology',
    measurementValue: value,
  }));
}

/**
 * Taxon-core rows, accumulated across every occurrence so each taxon is stated
 * once however many times it was recorded.
 *
 * Keyed by the PUBLISHED taxonID, because that is what the occurrence rows
 * point at — keying by the local id would produce a taxon core the occurrences
 * cannot join to. A taxon with no publishable id (a manually entered name)
 * therefore has no taxon row either, which is correct: there is nothing to
 * join on and nothing authoritative to say about it.
 */
type TaxonAcc = { taxa: Map<string, DwcRow>; distributions: DwcRow[] };

function collectTaxon(
  acc: TaxonAcc,
  t: {
    taxon_id: string;
    simple_name: string;
    name_author: string;
    common_name_c: string;
    rank: string;
    kingdom: string;
    phylum: string;
    class: string;
    order: string;
    family: string;
    genus: string;
    redlist: string;
    iucn: string;
    cites: string;
    alien_type: string;
    is_endemic: string;
    used_status: string;
    used_accepted_name: string;
  },
): void {
  const taxonID = publishedTaxonId(t.taxon_id);
  if (!taxonID || acc.taxa.has(taxonID)) return;

  acc.taxa.set(taxonID, {
    taxonID,
    // The ACCEPTED name, not the adopted one. An occurrence may be filed under
    // a synonym; the taxon core is the checklist's position on the taxon.
    scientificName: t.simple_name,
    scientificNameAuthorship: t.name_author,
    taxonRank: t.rank,
    kingdom: t.kingdom,
    phylum: t.phylum,
    class: t.class,
    order: t.order,
    family: t.family,
    genus: t.genus,
    higherClassification: higherClassificationOf(t),
    vernacularName: t.common_name_c,
    taxonomicStatus: t.used_status ? 'accepted' : '',
    acceptedNameUsage: t.used_accepted_name,
    acceptedNameUsageID: t.used_status ? taxonID : '',
  });

  // Taiwan: the national red list, plus whether the taxon is native HERE.
  const national = threatStatusDwcValue(t.redlist);
  const means = establishmentMeansDwcValue(t.alien_type, t.is_endemic);
  if (national || means) {
    acc.distributions.push({
      coreEventID: taxonID,
      locality: 'Taiwan',
      countryCode: 'TW',
      occurrenceStatus: 'present',
      establishmentMeans: means,
      threatStatus: national,
      source: 'TaiCOL 臺灣物種名錄',
    });
  }

  // Global: a SECOND row, because it is a different assessment at a different
  // scope. This is the thing a flat CSV cannot express — which is why the CSV
  // has to call the global one `iucnRedListCategory` instead.
  const global = threatStatusDwcValue(t.iucn);
  const cites = citesAppendixDwcValue(t.cites);
  if (global || cites) {
    acc.distributions.push({
      coreEventID: taxonID,
      // No countryCode on purpose: the IUCN global assessment and a CITES
      // appendix apply everywhere, and pinning them to TW would misstate both.
      threatStatus: global,
      appendixCITES: cites,
      source: global && cites ? 'IUCN Red List; CITES' : global ? 'IUCN Red List' : 'CITES',
    });
  }
}

function eventDateOf(start: number | null, end: number | null): string {
  if (start == null) return '';
  const s = localIso(start);
  return end != null ? `${s}/${localIso(end)}` : s;
}

export type DwcaInput = {
  /** Dataset title: the project name, or the record name for a single record. */
  title: string;
  abstract: string;
  /** EML packageId — callers build it from their already-sanitised basename. */
  packageId: string;
  plots: PlotSurvey[];
  sessions: Session[];
  trips: CollectionTrip[];
};

/** Two archives: the Event-core records, and the Taxon core that carries what
 *  is true of the taxa rather than of the observations. `taxa` is null when no
 *  taxon has a conservation status or establishment means. */
export type RecordsDwca = { records: Uint8Array; taxa: Uint8Array | null };

/**
 * Every record kind → Darwin Core Archives.
 *
 * Takes lists rather than a project so a single-record export can pass one
 * session (or one plot / one trip) through the exact same row builders the
 * project export uses — the alternative was a second, drifting copy of the
 * Event/Occurrence/Humboldt mapping.
 */
export function buildRecordsDwca({
  title,
  abstract,
  packageId,
  plots,
  sessions,
  trips,
}: DwcaInput): RecordsDwca {
  const events: DwcRow[] = [];
  const occurrences: DwcRow[] = [];
  const humboldt: DwcRow[] = [];
  const measurements: DwcRow[] = [];
  const taxonAcc: TaxonAcc = { taxa: new Map(), distributions: [] };
  const usedIds = new Set<string>();
  const creators = new Set<string>();

  // DwC eventIDs must be unique; plotid / session names carry no such
  // guarantee in the schema, so collide → suffix _2, _3…
  const uniqueEventId = (base: string): string => {
    let id = base || 'event';
    for (let n = 2; usedIds.has(id); n++) id = `${base}_${n}`;
    usedIds.add(id);
    return id;
  };

  for (const p of plots) {
    const eventID = uniqueEventId(p.plotid);
    if (p.recorded_by) creators.add(p.recorded_by);
    events.push({
      eventID,
      eventDate: eventDateOf(p.start_ts, p.stop_ts),
      samplingProtocol: p.sampling_protocol,
      sampleSizeValue: p.sample_size_value,
      sampleSizeUnit: p.sample_size_unit,
      locality: p.locality,
      decimalLatitude: p.decimal_latitude,
      decimalLongitude: p.decimal_longitude,
      coordinateUncertaintyInMeters: p.coord_uncertainty_m,
      minimumElevationInMeters: p.elevation_m,
      recordedBy: p.recorded_by,
      eventRemarks: p.field_note,
    });
    const subplots = listSubplots(p.id);
    const subplotEventById = new Map<number, string>();
    for (const sp of subplots) {
      const childId = uniqueEventId(`${eventID}-${sp.label}`);
      subplotEventById.set(sp.id, childId);
      events.push({
        eventID: childId,
        parentEventID: eventID,
        eventDate: eventDateOf(p.start_ts, p.stop_ts),
        sampleSizeValue: sp.width_m != null && sp.length_m != null ? sp.width_m * sp.length_m : null,
        sampleSizeUnit: sp.width_m != null && sp.length_m != null ? 'm²' : null,
        recordedBy: p.recorded_by,
      });
    }
    const durationMin =
      p.start_ts != null && p.stop_ts != null
        ? Math.round((p.stop_ts - p.start_ts) / 60000)
        : null;
    humboldt.push({
      coreEventID: eventID,
      siteCount: subplots.length > 0 ? subplots.length : null,
      siteNestingDescription:
        subplots.length > 0 ? `${subplots.length} subplots (${subplots.map((s) => s.label).join(', ')})` : null,
      totalAreaSampledValue: p.sample_size_value,
      totalAreaSampledUnit: p.sample_size_unit,
      eventDurationValue: durationMin,
      eventDurationUnit: durationMin != null ? 'minutes' : null,
      protocolNames: p.sampling_protocol,
      samplingPerformedBy: p.recorded_by,
      isAbundanceReported: true,
      isVegetationCoverReported: p.plot_type === 'fixed',
      isAbsenceReported: false,
    });
    for (const r of listPlotSpecies(p.id)) {
      occurrences.push({
        coreEventID: (r.subplot_id != null ? subplotEventById.get(r.subplot_id) : null) ?? eventID,
        occurrenceID: r.occurrence_id,
        basisOfRecord: 'HumanObservation',
        taxonID: publishedTaxonId(r.taxon_id),
        scientificName: r.used_scientific_name || r.simple_name,
        scientificNameAuthorship: r.name_author,
        vernacularName: r.common_name_c,
        family: r.family,
        kingdom: r.kingdom,
        organismQuantity: r.organism_quantity,
        organismQuantityType: r.organism_quantity_type,
        sex: multiToPipe(r.sex),
        lifeStage: r.life_stage,
        reproductiveCondition: multiToPipe(r.reproductive_condition),
        degreeOfEstablishment: establishmentDwcValue(r.degree_of_establishment),
        taxonRank: r.rank,
        higherClassification: higherClassificationOf(r),
        phylum: r.phylum,
        class: r.class,
        order: r.order,
        genus: r.genus,
        // Only meaningful under a deliberate adoption; `used_status` is '' for
        // a plain accepted name, and then all three stay blank.
        taxonomicStatus: r.used_status,
        acceptedNameUsage: r.used_accepted_name,
        // taxon_id keeps pointing at the ACCEPTED taxon even while
        // scientificName shows the adopted one, so it is the accepted id.
        acceptedNameUsageID: r.used_status ? publishedTaxonId(r.taxon_id) : '',
        establishmentMeans: establishmentMeansDwcValue(r.alien_type, r.is_endemic),
        individualCount: individualCountOf(r.organism_quantity, r.organism_quantity_type),
        eventDate: r.observed_at != null ? localIso(r.observed_at) : '',
        decimalLatitude: r.lat,
        decimalLongitude: r.lng,
        coordinateUncertaintyInMeters: r.accuracy,
        occurrenceRemarks: r.notes,
        modified: r.updated_at != null ? localIso(r.updated_at) : '',
      });
      measurements.push(...leafPhenologyRows(r.occurrence_id, r.leaf_phenology));
      collectTaxon(taxonAcc, r);
    }
  }

  for (const s of sessions) {
    const eventID = uniqueEventId(s.name);
    if (s.recorded_by) creators.add(s.recorded_by);
    events.push({
      eventID,
      eventDate: eventDateOf(s.started_at, s.ended_at),
      decimalLatitude: s.start_lat,
      decimalLongitude: s.start_lng,
      recordedBy: s.recorded_by,
      eventRemarks: s.notes,
    });
    const durationMin =
      s.ended_at != null ? Math.round((s.ended_at - s.started_at) / 60000) : null;
    humboldt.push({
      coreEventID: eventID,
      eventDurationValue: durationMin,
      eventDurationUnit: durationMin != null ? 'minutes' : null,
      samplingPerformedBy: s.recorded_by,
      isAbundanceReported: false,
      isVegetationCoverReported: false,
      isAbsenceReported: false,
    });
    for (const r of listSessionRecords(s.id)) {
      occurrences.push({
        coreEventID: eventID,
        occurrenceID: r.occurrence_id,
        basisOfRecord: 'HumanObservation',
        taxonID: publishedTaxonId(r.taxon_id),
        scientificName: r.used_scientific_name || r.simple_name,
        scientificNameAuthorship: r.name_author,
        vernacularName: r.common_name_c,
        family: r.family,
        kingdom: r.kingdom,
        organismQuantity: r.organism_quantity,
        organismQuantityType: r.organism_quantity_type,
        sex: multiToPipe(r.sex),
        lifeStage: r.life_stage,
        reproductiveCondition: multiToPipe(r.reproductive_condition),
        degreeOfEstablishment: establishmentDwcValue(r.degree_of_establishment),
        taxonRank: r.rank,
        higherClassification: higherClassificationOf(r),
        phylum: r.phylum,
        class: r.class,
        order: r.order,
        genus: r.genus,
        // Only meaningful under a deliberate adoption; `used_status` is '' for
        // a plain accepted name, and then all three stay blank.
        taxonomicStatus: r.used_status,
        acceptedNameUsage: r.used_accepted_name,
        // taxon_id keeps pointing at the ACCEPTED taxon even while
        // scientificName shows the adopted one, so it is the accepted id.
        acceptedNameUsageID: r.used_status ? publishedTaxonId(r.taxon_id) : '',
        establishmentMeans: establishmentMeansDwcValue(r.alien_type, r.is_endemic),
        individualCount: individualCountOf(r.organism_quantity, r.organism_quantity_type),
        eventDate: localIso(r.observed_at),
        decimalLatitude: r.lat,
        decimalLongitude: r.lng,
        coordinateUncertaintyInMeters: r.accuracy,
        occurrenceRemarks: r.notes,
        modified: r.updated_at != null ? localIso(r.updated_at) : '',
      });
      measurements.push(...leafPhenologyRows(r.occurrence_id, r.leaf_phenology));
      collectTaxon(taxonAcc, r);
    }
  }

  for (const c of trips) {
    const eventID = uniqueEventId(c.name);
    if (c.recorded_by) creators.add(c.recorded_by);
    events.push({
      eventID,
      eventDate: eventDateOf(c.started_at, c.ended_at),
      locality: c.locality,
      recordedBy: c.recorded_by,
      eventRemarks: c.notes,
    });
    for (const sp of listSpecimens(c.id)) {
      occurrences.push({
        coreEventID: eventID,
        occurrenceID: sp.occurrence_id,
        basisOfRecord: 'PreservedSpecimen',
        taxonID: publishedTaxonId(sp.taxon_id),
        scientificName: sp.used_scientific_name || sp.simple_name,
        scientificNameAuthorship: sp.name_author,
        vernacularName: sp.common_name_c,
        family: sp.family,
        kingdom: sp.kingdom,
        sex: multiToPipe(sp.sex),
        lifeStage: sp.life_stage,
        reproductiveCondition: multiToPipe(sp.reproductive_condition),
        degreeOfEstablishment: establishmentDwcValue(sp.degree_of_establishment),
        taxonRank: sp.rank,
        higherClassification: higherClassificationOf(sp),
        phylum: sp.phylum,
        class: sp.class,
        order: sp.order,
        genus: sp.genus,
        // Only meaningful under a deliberate adoption; `used_status` is '' for
        // a plain accepted name, and then all three stay blank.
        taxonomicStatus: sp.used_status,
        acceptedNameUsage: sp.used_accepted_name,
        // taxon_id keeps pointing at the ACCEPTED taxon even while
        // scientificName shows the adopted one, so it is the accepted id.
        acceptedNameUsageID: sp.used_status ? publishedTaxonId(sp.taxon_id) : '',
        establishmentMeans: establishmentMeansDwcValue(sp.alien_type, sp.is_endemic),
        recordNumber: sp.record_number,
        institutionCode: sp.institution_code,
        catalogNumber: sp.catalog_number,
        otherCatalogNumbers: sp.other_catalog_numbers,
        // The method, not the count — see duplicateCountRows.
        preparations: sp.duplicate_count != null ? 'sheet' : '',
        identifiedBy: sp.identified_by,
        dateIdentified: sp.date_identified,
        eventDate: sp.collected_at != null ? localIso(sp.collected_at) : '',
        decimalLatitude: sp.lat,
        decimalLongitude: sp.lng,
        coordinateUncertaintyInMeters: sp.accuracy,
        minimumElevationInMeters: sp.elevation_m,
        occurrenceRemarks: sp.notes,
        modified: sp.updated_at != null ? localIso(sp.updated_at) : '',
      });
      measurements.push(...leafPhenologyRows(sp.occurrence_id, sp.leaf_phenology));
      measurements.push(...duplicateCountRows(sp.occurrence_id, sp.duplicate_count));
      collectTaxon(taxonAcc, sp);
    }
  }

  const now = new Date();
  const meta = {
    title,
    abstract,
    creator: [...creators].join(', '),
    pubDate: now.toISOString().slice(0, 10),
    packageId,
  };
  return {
    records: buildDwcArchive({ meta, events, occurrences, humboldt, measurements }),
    // Null when nothing has a conservation status or an establishment means —
    // a taxon archive carrying only headers is noise in the bundle.
    taxa: buildTaxonArchive({
      meta: { ...meta, packageId: `${packageId}-taxon` },
      taxa: [...taxonAcc.taxa.values()],
      distributions: taxonAcc.distributions,
    }),
  };
}
