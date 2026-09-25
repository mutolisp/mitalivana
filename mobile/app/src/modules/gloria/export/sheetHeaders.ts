/**
 * Column headers of the Taiwan GLORIA vegetation sheet
 * ("[GLORIA] Taiwan_GLORIA_vegetation_data"), copied verbatim — including
 * the duplicated `aspect` in 10_ and the sheet's own spellings — so exported
 * rows paste straight under the existing ones. Pure.
 *
 * Deliberate differences from the sheet:
 *   - `spCode` / `spcode` (12_, 22_, 32_) are omitted: they are temporary
 *     analysis codes, not survey data.
 *   - 12_ and 13_ are merged into one table: species cover and frequency
 *     cells on one row per quadrat × species.
 */

import { F_COLUMNS } from '../model/grid';

export const H00_PLOT_COORDINATES = [
  'fullSummitCode', 'targetRegion', 'summit', 'decimalLongitude', 'Longitude', 'decimalLatitude', 'Latitude',
  'twd97x', 'twd97y', 'elevation', 'Vegetation Zone',
] as const;

export const H01_SUMMITS_SURVEY_INFO = [
  'mocy', 'year', 'targetRegion', 'summit', 'surveyStartDate', 'surveyStopDate', 'summitOverview',
  'temperature_loggers', 'vegdata_1x1_form', 'vegdata_sas', 'vegdata_10x10', 'comments', 'update',
] as const;

export const H02_POINTS = [
  'id', 'quadratCode', 'country', 'targetRegion', 'summit', 'aspect', 'quadratCluster', 'pointNumber', 'p5m',
  'quadrat1x1', 'distance', 'compassDirection', 'mocy', 'hsp_x', 'hsp_y', 'p_x', 'p_y', 'decimalLongitude',
  'decimalLatitude', 'comments', 'uuid',
] as const;

/** The second `aspect` is the quadrat's slope aspect in degrees. */
export const H10_1X1_PLOTINFO = ['id', 'country', 'targetRegion', 'summit', 'aspect', 'quadratCode', 'aspect', 'slope'] as const;

export const H11_1X1_ENV = [
  'Needs confirm again', 'id', 'samplingProtocol', 'mocy', 'country', 'targetRegion', 'summit', 'aspect',
  'quadratCode', 'eventDate', 'covEstStartTime', 'covEstStopTime', 'freqEstStartTime', 'freqEstStopTime',
  'researcher', 'totalVasPlantsCover', 'check_totalCoverCorrect', 'totalNumSpecies', 'comments',
  'topCoverVascularPlants', 'topCoverSolidRock', 'topCoverScree', 'topCoverLichen', 'topCoverBryophytes',
  'topCoverBareground', 'topCoverLitter', 'subtypeLichensBelowVasPlants', 'subtypeLichensOnRock',
  'subtypeLichensOnScree', 'subtypeBryBelowVasPlants', 'subtypeBryOnRock', 'subtypeBryOnScree', 'tphSolidRock',
  'tphScree', 'tphLichensOnSoil', 'tphBryOnSoil', 'tphBareground', 'tphLitter', 'uuid', 'update_time',
] as const;

/** 12_1x1m_sp (without spCode) + 13_1x1m_sp_freq's freq and f11…f00. */
export const H12_13_1X1_SP_FREQ = [
  'uuid', 'id', 'samplingProtocol', 'mocy', 'country', 'targetRegion', 'summit', 'aspect', 'quadratCode',
  'speciesNumber', 'vernacularName', 'scientificName', 'taxonRank', 'family', 'coverInPercentage',
  'totalPointsHitCalc', 'freq', ...F_COLUMNS, 'comments',
] as const;

export const H14_1X1_DISTURBANCE = [
  'id', 'mocy', 'country', 'targetRegion', 'summit', 'quadratCode', 'disturbanceCode', 'Disturbance Type', 'freq',
  ...F_COLUMNS,
] as const;

export const H21_SAS_ENV = [
  'id', 'samplingProtocol', 'mocy', 'country', 'targetRegion', 'summit', 'aspect', 'quadratCode', 'eventDate',
  'covEstStartTime', 'covEstStopTime', 'researcher', 'topCoverVascularPlants', 'topCoverSolidRock',
  'topCoverScree', 'topCoverLichen', 'topCoverBryophytes', 'topCoverBareground', 'topCoverLitter',
  'totalNumSpecies', 'vernacularComments', 'comments', 'uuid',
] as const;

export const H22_SAS_SP = [
  'id', 'samplingProtocol', 'mocy', 'country', 'targetRegion', 'summit', 'aspect', 'quadratCode',
  'speciesNumber', 'vernacularName', 'scientificName', 'taxonRank', 'family', 'abundance', 'abundanceCode',
  'comments', 'uuid',
] as const;

/** 31_ `topCover*` hold surface HITS out of 400 points, as in the sheet. */
export const H31_10X10_ENV = [
  'id', 'samplingProtocol', 'mocy', 'country', 'targetRegion', 'summit', 'aspect', 'eventDate', 'startTime',
  'stopTime', 'researcher', 'topCoverSolidRock', 'topCoverScree', 'topCoverLichen', 'topCoverBryophytes',
  'topCoverBareground', 'topCoverLitter', 'totalNumSpecies', 'comments', 'uuid',
] as const;

export const H32_10X10_SP = [
  'id', 'samplingProtocol', 'mocy', 'country', 'targetRegion', 'summit', 'aspect', 'speciesNumber',
  'vernacularName', 'scientificName', 'taxonRank', 'family', 'totalHits', 'comments', 'uuid',
] as const;

/** 33_sas_abundanceCode. */
export const SAS_ABUNDANCE_CODE: Record<string, number> = { d: 1, c: 2, s: 3, r: 4, 'r!': 5 };

/** Sheet `samplingProtocol` strings. */
export const PROTOCOL = {
  quadrat: '1m x 1m visual estimation',
  sas: 'Summit Area Section cover estimation',
  square: '10 m x 10 m',
} as const;

/** 14_ disturbance rows (manual p.52; Form 5-S "H.i. 1/2/3"). */
export const DISTURBANCES = [
  { code: 'Hi1', type: 'faeces/droppings' },
  { code: 'Hi2', type: 'browsing damage' },
  { code: 'Hi3', type: 'trampling' },
] as const;
