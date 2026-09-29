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
export const PROJECT_FK_TABLES = ['sessions', 'plot_surveys', 'sites', 'collection_trips', 'gloria_surveys', 'miren_surveys'] as const;

/** Tables whose site_id points at `sites` (declared FK or not). miren_plots.site_id is a MIREN site, not one of these. */
export const SITE_REF_TABLES = ['sessions', 'plot_surveys', 'collection_trips', 'gloria_surveys', 'miren_surveys'] as const;

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
];
