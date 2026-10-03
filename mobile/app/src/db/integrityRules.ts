/**
 * Which tables point at what — the lists that deleteProject, countSiteReferences,
 * purgeOrphanRows and checkIntegrity each used to keep their own copy of, and
 * each missed a newer table in (MIREN: data-model audit A1–A3, 2026-09-28).
 *
 * Pure (no DB import), so check:integrity-rules compares them with the schema
 * the migrations actually build: every FOREIGN KEY to projects, every
 * ON DELETE CASCADE, every ON DELETE SET NULL and every site_id column must be
 * covered here, or be listed as an exemption with its reason.
 */

/** Tables with a FOREIGN KEY project_id → projects. Deleting a project moves their rows to 0 (未分類). */
export const PROJECT_FK_TABLES = ['sessions', 'plot_surveys', 'sites', 'collection_trips', 'gloria_surveys', 'miren_surveys', 'fw_frames', 'fw_surveys'] as const;

/** Tables whose site_id points at `sites` (declared FK or not). miren_plots.site_id is a MIREN site, not one of these. */
export const SITE_REF_TABLES = ['sessions', 'plot_surveys', 'collection_trips', 'gloria_surveys', 'miren_surveys', 'fw_frames', 'fw_surveys'] as const;

/**
 * Children of a declared ON DELETE CASCADE whose parent is gone: [table, WHERE].
 * Parent before child — FK enforcement is off during the sweep, so nothing
 * cascades, and deleting the parent level first lets the child level catch
 * the rows it orphaned in the same pass.
 */
export const CASCADE_ORPHANS: ReadonlyArray<readonly [string, string]> = [
  ['collection_specimens', 'trip_id NOT IN (SELECT id FROM collection_trips)'],
  ['checklist_records', 'session_id NOT IN (SELECT id FROM sessions)'],
  ['plot_species_records', 'plot_survey_id NOT IN (SELECT id FROM plot_surveys)'],
  ['plot_survey_layers', 'plot_survey_id NOT IN (SELECT id FROM plot_surveys)'],
  ['plot_subplots', 'plot_survey_id NOT IN (SELECT id FROM plot_surveys)'],
  ['subplot_layers', 'subplot_id NOT IN (SELECT id FROM plot_subplots)'],
  ['plot_quadrats', 'plot_survey_id NOT IN (SELECT id FROM plot_surveys)'],
  ['plot_quadrat_species', 'quadrat_id NOT IN (SELECT id FROM plot_quadrats)'],
  ['gloria_points', 'survey_id NOT IN (SELECT id FROM gloria_surveys)'],
  ['gloria_photo_checks', 'survey_id NOT IN (SELECT id FROM gloria_surveys)'],
  ['gloria_units', 'survey_id NOT IN (SELECT id FROM gloria_surveys)'],
  ['gloria_taxa', 'survey_id NOT IN (SELECT id FROM gloria_surveys)'],
  ['gloria_unit_species', 'unit_id NOT IN (SELECT id FROM gloria_units) OR gloria_taxon_id NOT IN (SELECT id FROM gloria_taxa)'],
  ['gloria_logger_visits', 'summit_id NOT IN (SELECT id FROM gloria_summits)'],
  ['gloria_loggers', 'visit_id NOT IN (SELECT id FROM gloria_logger_visits)'],
  ['miren_region_status', 'region_id NOT IN (SELECT id FROM miren_regions)'],
  ['favorite_taxa', 'folder_id NOT IN (SELECT id FROM favorite_folders)'],
  ['miren_taxa', 'survey_id NOT IN (SELECT id FROM miren_surveys)'],
  ['miren_plots', 'survey_id NOT IN (SELECT id FROM miren_surveys)'],
  ['miren_plot_species', 'plot_id NOT IN (SELECT id FROM miren_plots) OR miren_taxon_id NOT IN (SELECT id FROM miren_taxa)'],
  ['miren_rechecks', 'plot_id NOT IN (SELECT id FROM miren_plots)'],
  // Survey framework (v80).
  ['fw_frame_series', 'frame_id NOT IN (SELECT id FROM fw_frames)'],
  ['fw_survey_quadrats', 'survey_id NOT IN (SELECT id FROM fw_surveys)'],
  ['fw_individuals', 'frame_id NOT IN (SELECT id FROM fw_frames)'],
  ['fw_individual_history', 'individual_id NOT IN (SELECT id FROM fw_individuals)'],
  ['fw_stems', 'individual_id NOT IN (SELECT id FROM fw_individuals)'],
  ['fw_stem_measures', 'survey_id NOT IN (SELECT id FROM fw_surveys) OR stem_id NOT IN (SELECT id FROM fw_stems)'],
  ['fw_stem_values', 'measure_id NOT IN (SELECT id FROM fw_stem_measures)'],
  ['fw_individual_values', 'survey_id NOT IN (SELECT id FROM fw_surveys) OR individual_id NOT IN (SELECT id FROM fw_individuals)'],
  // Checklist / plot-style surveys (v83).
  ['fw_frame_units', 'frame_id NOT IN (SELECT id FROM fw_frames)'],
  ['fw_frame_labels', 'frame_id NOT IN (SELECT id FROM fw_frames)'],
  ['fw_units', 'survey_id NOT IN (SELECT id FROM fw_surveys)'],
  ['fw_occurrences', 'survey_id NOT IN (SELECT id FROM fw_surveys)'],
  ['fw_survey_values', 'survey_id NOT IN (SELECT id FROM fw_surveys)'],
  ['fw_unit_values', 'unit_id NOT IN (SELECT id FROM fw_units)'],
  ['fw_occurrence_values', 'occurrence_id NOT IN (SELECT id FROM fw_occurrences)'],
  ['fw_rechecks', 'survey_id NOT IN (SELECT id FROM fw_surveys)'],
  // Interactions (v87): both sides are occurrences of the survey.
  [
    'fw_interactions',
    'survey_id NOT IN (SELECT id FROM fw_surveys)' +
      ' OR subject_occurrence_id NOT IN (SELECT id FROM fw_occurrences)' +
      ' OR object_occurrence_id NOT IN (SELECT id FROM fw_occurrences)',
  ],
  // fw_media's owners other than the survey are optional. `NULL NOT IN
  // (<empty>)` is true in SQLite, so each tests IS NOT NULL first; without it
  // an empty fw_units would sweep every photo (check:integrity-rules).
  [
    'fw_media',
    'survey_id NOT IN (SELECT id FROM fw_surveys)' +
      ' OR (individual_id IS NOT NULL AND individual_id NOT IN (SELECT id FROM fw_individuals))' +
      ' OR (measure_id IS NOT NULL AND measure_id NOT IN (SELECT id FROM fw_stem_measures))' +
      ' OR (unit_id IS NOT NULL AND unit_id NOT IN (SELECT id FROM fw_units))' +
      ' OR (occurrence_id IS NOT NULL AND occurrence_id NOT IN (SELECT id FROM fw_occurrences))' +
      ' OR (interaction_id IS NOT NULL AND interaction_id NOT IN (SELECT id FROM fw_interactions))',
  ],
];

/**
 * Declared CASCADE edges deliberately NOT swept, with the reason. MIREN routes
 * and sites are reference data that surveys and plots point at with NO ACTION
 * keys: deleting an orphaned route would strand those rows instead of fixing
 * them. (With FK enforcement on, such orphans cannot be created.)
 */
export const CASCADE_EXEMPT: Readonly<Record<string, string>> = {
  'miren_routes.region_id': 'reference data; miren_surveys.route_id (NO ACTION) may still point at it',
  'miren_sites.route_id': 'reference data; miren_plots.site_id (NO ACTION) may still point at it',
};

/** Dangling pointers to null: [table, column, parent table]. Declared ON DELETE SET NULL, or no FK at all. */
export const NULL_DANGLING: ReadonlyArray<readonly [string, string, string]> = [
  ['sessions', 'site_id', 'sites'],
  ['plot_surveys', 'site_id', 'sites'],
  ['collection_trips', 'site_id', 'sites'],
  ['gloria_surveys', 'site_id', 'sites'],
  ['miren_surveys', 'site_id', 'sites'],
  ['gloria_surveys', 'prev_survey_id', 'gloria_surveys'],
  ['miren_surveys', 'prev_survey_id', 'miren_surveys'],
  // The site's own back-reference to the 名錄 that created it. Left dangling
  // from before FK enforcement, it made countSiteReferences count a user that
  // no longer exists — the site showed as bound and was never cleaned up.
  ['sites', 'session_id', 'sessions'],
  // A pointer to a deleted subplot falls back to plot-level scope.
  ['plot_species_records', 'subplot_id', 'plot_subplots'],
  // A quadrat whose subplot is gone stays, placed in the plot directly.
  ['plot_quadrats', 'subplot_id', 'plot_subplots'],
  ['gloria_logger_visits', 'survey_id', 'gloria_surveys'],
  ['miren_rechecks', 'new_miren_taxon_id', 'miren_taxa'],
  ['fw_frames', 'site_id', 'sites'],
  ['fw_surveys', 'site_id', 'sites'],
  // The census a tree / stem first appeared in, and the census a correction was made in.
  ['fw_individuals', 'first_survey_id', 'fw_surveys'],
  ['fw_stems', 'first_survey_id', 'fw_surveys'],
  ['fw_individual_history', 'survey_id', 'fw_surveys'],
  // A unit or frame unit whose parent is gone is left without one; an
  // occurrence whose unit is gone is placed in the survey directly.
  ['fw_frame_units', 'parent_id', 'fw_frame_units'],
  ['fw_units', 'parent_id', 'fw_units'],
  ['fw_occurrences', 'unit_id', 'fw_units'],
  ['fw_frame_labels', 'first_survey_id', 'fw_surveys'],
  // A recheck answer whose occurrence is gone (a re-identification then needs answering again).
  ['fw_rechecks', 'occurrence_id', 'fw_occurrences'],
  // An interaction whose unit is gone stays, placed in the survey directly.
  ['fw_interactions', 'unit_id', 'fw_units'],
];
