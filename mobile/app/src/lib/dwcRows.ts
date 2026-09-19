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
import { establishmentDwcValue } from './dwcAttributes';
import { buildDwcArchive, type DwcRow } from './dwcArchive';

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

/**
 * Every record kind → one Darwin Core Archive.
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
}: DwcaInput): Uint8Array {
  const events: DwcRow[] = [];
  const occurrences: DwcRow[] = [];
  const humboldt: DwcRow[] = [];
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
        taxonID: r.taxon_id,
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
        eventDate: r.observed_at != null ? localIso(r.observed_at) : '',
        decimalLatitude: r.lat,
        decimalLongitude: r.lng,
        coordinateUncertaintyInMeters: r.accuracy,
        occurrenceRemarks: r.notes,
      });
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
        taxonID: r.taxon_id,
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
        eventDate: localIso(r.observed_at),
        decimalLatitude: r.lat,
        decimalLongitude: r.lng,
        coordinateUncertaintyInMeters: r.accuracy,
        occurrenceRemarks: r.notes,
      });
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
        taxonID: sp.taxon_id,
        scientificName: sp.used_scientific_name || sp.simple_name,
        scientificNameAuthorship: sp.name_author,
        vernacularName: sp.common_name_c,
        family: sp.family,
        kingdom: sp.kingdom,
        sex: multiToPipe(sp.sex),
        lifeStage: sp.life_stage,
        reproductiveCondition: multiToPipe(sp.reproductive_condition),
        degreeOfEstablishment: establishmentDwcValue(sp.degree_of_establishment),
        eventDate: sp.collected_at != null ? localIso(sp.collected_at) : '',
        decimalLatitude: sp.lat,
        decimalLongitude: sp.lng,
        coordinateUncertaintyInMeters: sp.accuracy,
        occurrenceRemarks: sp.notes,
      });
    }
  }

  const now = new Date();
  return buildDwcArchive({
    meta: {
      title,
      abstract,
      creator: [...creators].join(', '),
      pubDate: now.toISOString().slice(0, 10),
      packageId,
    },
    events,
    occurrences,
    humboldt,
  });
}
