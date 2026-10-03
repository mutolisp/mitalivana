import type { DB } from '@op-engineering/op-sqlite';

type Migration = {
  version: number;
  up: (db: DB) => void;
};

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS projects (
          id INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          abstract TEXT,
          location_description TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.executeSync(`
        INSERT OR IGNORE INTO projects (id, name, created_at, updated_at)
        VALUES (0, '未分類', strftime('%s','now')*1000, strftime('%s','now')*1000);
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          type TEXT NOT NULL DEFAULT 'checklist',
          project_id INTEGER NOT NULL DEFAULT 0,
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          gps_mode TEXT,
          start_lat REAL,
          start_lng REAL,
          track_geojson TEXT,
          notes TEXT,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_sessions_started_at ON sessions(started_at DESC);`,
      );
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id);`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(ended_at) WHERE ended_at IS NULL;`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS checklist_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          observed_at INTEGER NOT NULL,
          notes TEXT,
          photo_paths TEXT,
          lat REAL,
          lng REAL,
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_records_session ON checklist_records(session_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_records_taxon ON checklist_records(taxon_id);`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS search_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          query TEXT NOT NULL,
          searched_at INTEGER NOT NULL
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_history_searched ON search_history(searched_at DESC);`,
      );
    },
  },
  {
    version: 2,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL DEFAULT 0,
          session_id INTEGER,
          name TEXT NOT NULL,
          geometry_type TEXT NOT NULL CHECK (geometry_type IN (
            'Point','LineString','Polygon',
            'MultiPoint','MultiLineString','MultiPolygon'
          )),
          geometry_geojson TEXT NOT NULL,
          color TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sites_project ON sites(project_id);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sites_session ON sites(session_id);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(updated_at DESC);`);
    },
  },
  {
    // v3: extend sites geometry_type CHECK to include Multi* types.
    // For installs already on v2 with the old CHECK, recreate the table.
    // SQLite cannot ALTER a CHECK constraint, so rename + create + copy + drop.
    version: 3,
    up: (db) => {
      db.executeSync(`ALTER TABLE sites RENAME TO sites_v2;`);
      db.executeSync(`
        CREATE TABLE sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          project_id INTEGER NOT NULL DEFAULT 0,
          session_id INTEGER,
          name TEXT NOT NULL,
          geometry_type TEXT NOT NULL CHECK (geometry_type IN (
            'Point','LineString','Polygon',
            'MultiPoint','MultiLineString','MultiPolygon'
          )),
          geometry_geojson TEXT NOT NULL,
          color TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(`
        INSERT INTO sites (id, project_id, session_id, name, geometry_type, geometry_geojson, color, notes, created_at, updated_at)
        SELECT id, project_id, session_id, name, geometry_type, geometry_geojson, color, notes, created_at, updated_at FROM sites_v2;
      `);
      db.executeSync(`DROP TABLE sites_v2;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sites_project ON sites(project_id);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sites_session ON sites(session_id);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(updated_at DESC);`);
    },
  },
  {
    // v4: sessions can optionally reference a site (e.g., revisit of a known plot).
    // Most sessions will have NULL site_id; site capture is opt-in.
    version: 4,
    up: (db) => {
      addColumnIfMissing(
        db,
        `ALTER TABLE sessions ADD COLUMN site_id INTEGER REFERENCES sites(id) ON DELETE SET NULL;`,
      );
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sessions_site ON sessions(site_id);`);
    },
  },
  {
    // v5: vegetation plot survey tables (Phase 3).
    // plot_surveys = environmental data (Darwin Core aligned columns) + per-layer
    // cover/height/method. plot_species_records = one row per (species, layer)
    // pairing with method-specific value (bb_value / percent / dbh_values_json).
    // Bidirectional link with sites: plot_surveys.site_id references sites.id.
    version: 5,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS plot_surveys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          plotid TEXT NOT NULL,
          project_id INTEGER NOT NULL DEFAULT 0,
          site_id INTEGER,
          start_ts INTEGER,
          stop_ts INTEGER,
          status TEXT NOT NULL DEFAULT 'active',
          -- DwC core
          decimal_longitude REAL,
          decimal_latitude REAL,
          coord_uncertainty_m REAL,
          sample_size_value REAL,
          sample_size_unit TEXT,
          sampling_protocol TEXT,
          total_cover_pct REAL,
          recorded_by TEXT,
          locality TEXT,
          field_note TEXT,
          -- env (optional)
          elevation_m REAL,
          slope_deg REAL,
          aspect_deg REAL,
          terrain_position TEXT,
          rock_cover_pct REAL,
          gravel_cover_pct REAL,
          bareland_cover_pct REAL,
          -- per-layer cover (%) + height (cm)
          e0_cover_pct REAL,
          e0_height_cm REAL,
          e1_cover_pct REAL,
          e1_height_cm REAL,
          e2_cover_pct REAL,
          e2_height_cm REAL,
          e3_cover_pct REAL,
          e3_height_cm REAL,
          -- per-layer abundance method: 'BB' | 'percent' | 'DBH'
          e0_method TEXT NOT NULL DEFAULT 'BB',
          e1_method TEXT NOT NULL DEFAULT 'BB',
          e2_method TEXT NOT NULL DEFAULT 'BB',
          e3_method TEXT NOT NULL DEFAULT 'DBH',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          FOREIGN KEY (site_id) REFERENCES sites(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_surveys_project ON plot_surveys(project_id);`,
      );
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_plot_surveys_site ON plot_surveys(site_id);`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_surveys_started ON plot_surveys(start_ts DESC);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_surveys_active ON plot_surveys(status) WHERE status = 'active';`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS plot_species_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plot_survey_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          layer TEXT NOT NULL CHECK (layer IN ('E0','E1','E2','E3')),
          -- exactly one of these is populated per record, dictated by the
          -- corresponding plot_surveys.<layer>_method.
          bb_value TEXT,             -- '+', 'r', '1'..'5'
          percent REAL,              -- 0..100
          dbh_values_json TEXT,      -- JSON array of cm values for multi-stem
          notes TEXT,
          photo_paths TEXT,          -- JSON array of photo URIs
          observed_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (plot_survey_id) REFERENCES plot_surveys(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_plot ON plot_species_records(plot_survey_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_taxon ON plot_species_records(taxon_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_layer ON plot_species_records(plot_survey_id, layer);`,
      );
    },
  },
  {
    // v6: support transect plots alongside fixed (4-layer) plots.
    //   * plot_surveys.plot_type ('fixed' | 'transect'), defaulting to 'fixed'
    //   * plot_surveys.track_geojson — the transect track (LineString GeoJSON)
    //   * plot_species_records.layer's CHECK gains 'T' (a transect has no layers).
    //     SQLite cannot ALTER a CHECK, so the table is rebuilt by
    //     rename+create+copy.
    version: 6,
    up: (db) => {
      addColumnIfMissing(
        db,
        `ALTER TABLE plot_surveys ADD COLUMN plot_type TEXT NOT NULL DEFAULT 'fixed';`,
      );
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN track_geojson TEXT;`);

      db.executeSync(`ALTER TABLE plot_species_records RENAME TO plot_species_records_old;`);
      db.executeSync(`
        CREATE TABLE plot_species_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plot_survey_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          layer TEXT NOT NULL CHECK (layer IN ('E0','E1','E2','E3','T')),
          bb_value TEXT,
          percent REAL,
          dbh_values_json TEXT,
          notes TEXT,
          photo_paths TEXT,
          observed_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (plot_survey_id) REFERENCES plot_surveys(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(`
        INSERT INTO plot_species_records
          (id, plot_survey_id, taxon_id, layer, bb_value, percent, dbh_values_json, notes, photo_paths, observed_at, created_at)
        SELECT id, plot_survey_id, taxon_id, layer, bb_value, percent, dbh_values_json, notes, photo_paths, observed_at, created_at
        FROM plot_species_records_old;
      `);
      db.executeSync(`DROP TABLE plot_species_records_old;`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_plot ON plot_species_records(plot_survey_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_taxon ON plot_species_records(taxon_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_layer ON plot_species_records(plot_survey_id, layer);`,
      );
    },
  },
  {
    // v7: transect track finalization flag.
    //   * track_finalized = 1 means the track has been stopped and saved and can no
    //     longer be appended to; the plot still accepts species.
    //   * track_geojson goes from LineString to MultiLineString (an array of
    //     segments), handled in code;
    //     the DB schema is unchanged (TEXT GeoJSON).
    version: 7,
    up: (db) => {
      addColumnIfMissing(
        db,
        `ALTER TABLE plot_surveys ADD COLUMN track_finalized INTEGER NOT NULL DEFAULT 0;`,
      );
    },
  },
  {
    // v8: DwC species attribute columns shared by checklist_records and
    // plot_species_records.
    //   * sex                     DwC sex
    //   * life_stage              DwC lifeStage (animals; enum varies by class)
    //   * reproductive_condition  DwC reproductiveCondition (plant flower/fruit)
    //   * leaf_phenology          dynamicProperties.leafPhenology (plant leaves)
    version: 8,
    up: (db) => {
      for (const tbl of ['checklist_records', 'plot_species_records']) {
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN sex TEXT;`);
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN life_stage TEXT;`);
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN reproductive_condition TEXT;`);
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN leaf_phenology TEXT;`);
      }
    },
  },
  {
    // v9: DwC abundance generalization.
    //   * organism_quantity       DwC organismQuantity (string; may carry
    //                             a JSON array for multi-stem DBH)
    //   * organism_quantity_type  DwC organismQuantityType
    //   Existing bb_value / percent / dbh_values_json data is migrated into
    //   the new pair of columns; the legacy columns are kept for now (SQLite
    //   DROP COLUMN is painful and the export pipeline still references them).
    version: 9,
    up: (db) => {
      for (const tbl of ['checklist_records', 'plot_species_records']) {
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN organism_quantity TEXT;`);
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN organism_quantity_type TEXT;`);
      }
      // Migrate plot_species_records (only this table has the legacy abundance
      // columns; checklist_records never carried abundance data).
      db.executeSync(`
        UPDATE plot_species_records
        SET organism_quantity = bb_value,
            organism_quantity_type = 'Braun-Blanquet Scale'
        WHERE bb_value IS NOT NULL AND organism_quantity IS NULL;
      `);
      db.executeSync(`
        UPDATE plot_species_records
        SET organism_quantity = CAST(percent AS TEXT),
            organism_quantity_type = '% cover'
        WHERE percent IS NOT NULL AND organism_quantity IS NULL;
      `);
      db.executeSync(`
        UPDATE plot_species_records
        SET organism_quantity = dbh_values_json,
            organism_quantity_type = 'DBH (cm)'
        WHERE dbh_values_json IS NOT NULL AND organism_quantity IS NULL;
      `);
    },
  },
  {
    // v10: capture per-record GNSS accuracy (meters) so DwC
    // `coordinateUncertaintyInMeters` can be populated on export.
    // expo-location returns `pos.coords.accuracy` for free; without a column
    // to land it in we were dropping it on the floor.
    version: 10,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE checklist_records ADD COLUMN accuracy REAL;`);
    },
  },
  {
    // v11: track when a session / plot was last resumed (status: done → active
    // toggle). Stale-record watchers were using `started_at` as the baseline,
    // which triggers a noisy "已開了 72 小時" alert the moment a user reopens
    // a 3-day-old record to add one more taxon. With `resumed_at` populated on
    // reopen, the watcher can compute the baseline as
    // `MAX(started_at, resumed_at, latest_activity)` and only warn when the
    // ACTIVE session has genuinely been idle/running too long.
    version: 11,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE sessions ADD COLUMN resumed_at INTEGER;`);
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN resumed_at INTEGER;`);
    },
  },
  {
    // v12: normalise per-layer environmental data into `plot_survey_layers`
    // (1..6 rows per plot) and expand the vegetation profile from 4 fixed
    // layers (E0-E3) to a user-configurable 1-6 layers with fixed semantic
    // labels. Adds env_photos_json for plot-wide environment context photos.
    //
    // Label shift (preserves ecological meaning):
    //   old E0 苔蘚 → new E1 (layer_index 1)
    //   old E1 草本 → new E2 (layer_index 2)
    //   old E2 灌木 → new E3 (layer_index 3)
    //   old E3 喬木 → new E4 (layer_index 4)
    //   (new) E5 主林冠層 (layer_index 5)
    //   (new) E6 突出層   (layer_index 6)
    //
    // plot_surveys.e0_*..e3_* columns are KEPT in this migration to allow
    // emergency rollback by reading the legacy columns. v13 will drop them
    // after production stability is verified.
    version: 12,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE plot_survey_layers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plot_survey_id INTEGER NOT NULL,
          layer_index INTEGER NOT NULL CHECK (layer_index BETWEEN 1 AND 6),
          cover_pct REAL,
          height_cm REAL,
          method TEXT NOT NULL DEFAULT 'BB' CHECK (method IN ('BB','percent','DBH')),
          FOREIGN KEY (plot_survey_id) REFERENCES plot_surveys(id) ON DELETE CASCADE,
          UNIQUE(plot_survey_id, layer_index)
        );
      `);
      db.executeSync(
        `CREATE INDEX idx_plot_survey_layers_plot ON plot_survey_layers(plot_survey_id);`,
      );

      // layer_count default 4 = existing plots keep 4 layers (E1-E4). User can
      // bump to 6 via the env tab; lowered count just hides the trailing
      // layers in UI, the data stays for safety.
      addColumnIfMissing(
        db,
        `ALTER TABLE plot_surveys ADD COLUMN layer_count INTEGER NOT NULL DEFAULT 4 CHECK (layer_count BETWEEN 1 AND 6);`,
      );
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN env_photos_json TEXT;`);

      // Backfill: every existing FIXED plot gets 4 layer rows from its
      // e0_*..e3_* columns (transect plots have no layer concept).
      for (let i = 0; i < 4; i++) {
        const col = `e${i}`;
        const newIndex = i + 1;
        db.executeSync(
          `INSERT INTO plot_survey_layers (plot_survey_id, layer_index, cover_pct, height_cm, method)
           SELECT id, ?, ${col}_cover_pct, ${col}_height_cm, ${col}_method
           FROM plot_surveys
           WHERE plot_type = 'fixed';`,
          [newIndex],
        );
      }

      // plot_species_records: rebuild table to:
      //   (a) update CHECK from ('E0'..'E3','T') → ('E1'..'E6','T')
      //   (b) shift existing layer values E0..E3 → E1..E4 (transect 'T' unchanged)
      // Must preserve every column that subsequent migrations added (v8 attrs,
      // v9 organism_quantity pair).
      db.executeSync(`ALTER TABLE plot_species_records RENAME TO plot_species_records_old_v11;`);
      db.executeSync(`
        CREATE TABLE plot_species_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plot_survey_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          layer TEXT NOT NULL CHECK (layer IN ('E1','E2','E3','E4','E5','E6','T')),
          bb_value TEXT,
          percent REAL,
          dbh_values_json TEXT,
          notes TEXT,
          photo_paths TEXT,
          observed_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          sex TEXT,
          life_stage TEXT,
          reproductive_condition TEXT,
          leaf_phenology TEXT,
          organism_quantity TEXT,
          organism_quantity_type TEXT,
          FOREIGN KEY (plot_survey_id) REFERENCES plot_surveys(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(`
        INSERT INTO plot_species_records
          (id, plot_survey_id, taxon_id, layer, bb_value, percent, dbh_values_json,
           notes, photo_paths, observed_at, created_at,
           sex, life_stage, reproductive_condition, leaf_phenology,
           organism_quantity, organism_quantity_type)
        SELECT id, plot_survey_id, taxon_id,
          CASE layer
            WHEN 'E0' THEN 'E1'
            WHEN 'E1' THEN 'E2'
            WHEN 'E2' THEN 'E3'
            WHEN 'E3' THEN 'E4'
            ELSE layer
          END,
          bb_value, percent, dbh_values_json, notes, photo_paths, observed_at, created_at,
          sex, life_stage, reproductive_condition, leaf_phenology,
          organism_quantity, organism_quantity_type
        FROM plot_species_records_old_v11;
      `);
      db.executeSync(`DROP TABLE plot_species_records_old_v11;`);
      db.executeSync(`CREATE INDEX idx_plot_records_plot ON plot_species_records(plot_survey_id);`);
      db.executeSync(`CREATE INDEX idx_plot_records_taxon ON plot_species_records(taxon_id);`);
      db.executeSync(
        `CREATE INDEX idx_plot_records_layer ON plot_species_records(plot_survey_id, layer);`,
      );
    },
  },
  {
    // v13: per-record GNSS + detection method on plot species records, and a
    // radius column on plot_surveys for the new 定點計數法 (point count) survey
    // type. All additive ALTERs — no table rebuild:
    //   - plot_species_records.layer CHECK is untouched: point count reuses the
    //     'T' bucket (disambiguated by plot_surveys.plot_type), so no rebuild.
    //   - plot_surveys.plot_type is TEXT DEFAULT 'fixed' with no CHECK, so the
    //     new 'point_count' literal is a pure code/type change.
    // `accuracy` mirrors checklist_records.accuracy so the same
    // updateRecordLocation-shaped helper + DwC mapper key apply unchanged.
    //
    // op-sqlite runs each executeSync in autocommit (no transaction wrapper);
    // the version row is inserted only after up() returns. If the process dies
    // mid-way, v13 re-runs from the top and ADD COLUMN (not IF NOT EXISTS)
    // would throw "duplicate column". This is the same latent risk every prior
    // multi-ALTER version carries (v8/v9/v11) and matches convention — we do
    // not introduce a transaction wrapper here. The MAX(version) gate in
    // runUserMigrations is the existing self-heal.
    version: 13,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN lat REAL;`);
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN lng REAL;`);
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN accuracy REAL;`);
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN detection_type TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN point_radius_m REAL;`);
    },
  },
  {
    // v14: 常用名錄 (favorite taxa). User-curated shortlist of frequently used
    // taxa for fast field entry. Denormalised display/sort columns are copied
    // from the matched TaiCOL row at add-time so the list renders offline
    // without a per-row join against twnamelist.db. taxon_id PK dedupes.
    version: 14,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS favorite_taxa (
          taxon_id TEXT PRIMARY KEY,
          simple_name TEXT,
          common_name_c TEXT,
          family TEXT,
          family_c TEXT,
          rank TEXT,
          kingdom TEXT,
          added_at INTEGER NOT NULL
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_favorite_added ON favorite_taxa(added_at DESC);`,
      );
    },
  },
  {
    // v15: 常用調查者 (surveyors / DwC recordedBy). A curated list of people who
    // can be auto-filled (is_default) or picked when creating a record. Also
    // adds sessions.recorded_by (plot_surveys already has it from v5) so quick
    // checklists carry recordedBy too.
    version: 15,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS surveyors (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      addColumnIfMissing(db, `ALTER TABLE sessions ADD COLUMN recorded_by TEXT;`);
    },
  },
  {
    // v16: DwC occurrenceID (stable v4 uuid) per species occurrence, on both
    // checklist_records (快速名錄) and plot_species_records (樣區). New rows get
    // a uuid from generateUuid() at insert; existing rows are backfilled here
    // with a per-row v4 uuid built from SQLite randomblob (no JS needed, avoids
    // a migrations→plots import cycle).
    version: 16,
    up: (db) => {
      const uuidExpr = `lower(
        hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
        hex(randomblob(6))
      )`;
      for (const tbl of ['checklist_records', 'plot_species_records']) {
        addColumnIfMissing(db, `ALTER TABLE ${tbl} ADD COLUMN occurrence_id TEXT;`);
        db.executeSync(
          `UPDATE ${tbl} SET occurrence_id = ${uuidExpr} WHERE occurrence_id IS NULL;`,
        );
      }
    },
  },
  {
    // v17: per-layer height unit (cm / m). height_cm stays the canonical stored
    // value (always cm); height_unit only controls how it is displayed in the
    // env tab and which column name + value the export emits.
    version: 17,
    up: (db) => {
      addColumnIfMissing(
        db,
        `ALTER TABLE plot_survey_layers ADD COLUMN height_unit TEXT NOT NULL DEFAULT 'cm';`,
      );
    },
  },
  {
    // v18: fixed-plot subplots (小區). A fixed plot can be split into N subplots;
    // each subplot records its own per-layer cover/height (subplot_layers) and
    // its own species (plot_species_records.subplot_id). The layer DEFINITION
    // (layer_count + per-layer method + height_unit) stays shared at plot level
    // in plot_survey_layers. subplot_id NULL = un-split plot (legacy behaviour).
    version: 18,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS plot_subplots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plot_survey_id INTEGER NOT NULL,
          idx INTEGER NOT NULL,
          label TEXT NOT NULL,
          width_m REAL,
          length_m REAL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (plot_survey_id) REFERENCES plot_surveys(id) ON DELETE CASCADE,
          UNIQUE(plot_survey_id, idx)
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_subplots_plot ON plot_subplots(plot_survey_id);`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS subplot_layers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          subplot_id INTEGER NOT NULL,
          layer_index INTEGER NOT NULL CHECK (layer_index BETWEEN 1 AND 6),
          cover_pct REAL,
          height_cm REAL,
          FOREIGN KEY (subplot_id) REFERENCES plot_subplots(id) ON DELETE CASCADE,
          UNIQUE(subplot_id, layer_index)
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_subplot_layers_subplot ON subplot_layers(subplot_id);`,
      );
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN subplot_id INTEGER;`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_plot_records_subplot ON plot_species_records(subplot_id);`,
      );
    },
  },
  {
    // v19: specimen collection (標本採集). A collection trip (採集行程) groups the
    // specimens gathered on one outing, mirroring how `sessions` groups
    // `checklist_records`.
    //
    // `status` here is COLLECTION-LOCAL: it only decides which trip an "add to
    // collection" lands in. It deliberately does NOT participate in the app-wide
    // single-active invariant, so creating or reopening a trip never ends an
    // active session or plot survey (and vice versa).
    version: 19,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS collection_trips (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          name TEXT NOT NULL,
          project_id INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'active',
          started_at INTEGER NOT NULL,
          ended_at INTEGER,
          recorded_by TEXT,
          locality TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_ctrips_started ON collection_trips(started_at DESC);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_ctrips_project ON collection_trips(project_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_ctrips_active ON collection_trips(status) WHERE status = 'active';`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS collection_specimens (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          trip_id INTEGER NOT NULL,
          occurrence_id TEXT,
          taxon_id TEXT NOT NULL,
          record_number TEXT NOT NULL,
          record_number_seq INTEGER,
          collected_at INTEGER NOT NULL,
          recorded_by TEXT,
          lat REAL,
          lng REAL,
          accuracy REAL,
          locality TEXT,
          reproductive_condition TEXT,
          leaf_phenology TEXT,
          notes TEXT,
          photo_paths TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (trip_id) REFERENCES collection_trips(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_cspec_trip ON collection_specimens(trip_id);`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_cspec_taxon ON collection_specimens(taxon_id);`,
      );
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_cspec_seq ON collection_specimens(record_number_seq DESC);`,
      );
    },
  },
  {
    // v20: sex / life_stage on specimens, so the collection detail sheet can
    // show the same taxon-driven DwC attribute set as checklist and plot
    // records — `SpeciesAttributesBlock` gives sex to every kingdom, lifeStage
    // to animals and phenology to plants. v19 shipped with only the two
    // phenology columns, which limited specimens to plants in practice.
    //
    // Mirrors v8, which added the same four columns to checklist_records and
    // plot_species_records. Additive ALTERs, no table rebuild; carries the same
    // known property as v8/v9/v11/v13 — the runner has no transaction wrapper,
    // so a crash between the two statements re-runs both and ADD COLUMN throws
    // "duplicate column" (see the v13 note; deliberately not changed here).
    version: 20,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN sex TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN life_stage TEXT;`);
    },
  },
  {
    // v21: three more ground-cover fractions on plot surveys, alongside the
    // existing rock / gravel / bareland trio. These record the *living* cover
    // (vascular plants, bryophytes, lichens) that the substrate columns don't:
    //   vascular_cover_pct   維管束植物覆蓋
    //   bryophyte_cover_pct  苔蘚覆蓋   (surface cover of bryophytes)
    //   lichen_cover_pct     地表地衣覆蓋 (surface cover of lichens)
    //
    // Additive ALTERs, same shape and caveat as v20 (no transaction wrapper;
    // a crash mid-way re-runs all three and ADD COLUMN throws duplicate column).
    version: 21,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN vascular_cover_pct REAL;`);
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN bryophyte_cover_pct REAL;`);
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN lichen_cover_pct REAL;`);
    },
  },
  {
    // v22: litterfall cover (枯落物覆蓋) — dead organic matter on the ground,
    // sitting between the living cover added in v21 and the mineral substrate
    // (rock / gravel / bareland) that has been there since v5.
    version: 22,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN litter_cover_pct REAL;`);
    },
  },
  {
    // v23: favourites become two levels (folder → species).
    //
    // favorite_taxa had taxon_id as its PK, so a species could exist only once
    // overall. For one species to sit in several folders the PK must become a
    // surrogate key + UNIQUE(folder_id, taxon_id). SQLite cannot ALTER a PK, so
    // the table is rebuilt the v3 way: rename + create + copy + drop.
    //
    // All existing rows move into one default folder; the row count must not change.
    //
    // is_default lets the UI show the folder name through i18n (instead of baking
    // Chinese into the data) and guarantees a quick add-to-favourites always has
    // somewhere to land. The user can still rename it.
    version: 23,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS favorite_folders (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          note TEXT,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      // The default folder is fixed at id=1, so the DB layer can land there without a lookup (like projects id=0 未分類).
      const now = Date.now();
      db.executeSync(
        `INSERT OR IGNORE INTO favorite_folders
           (id, name, is_default, sort_order, created_at, updated_at)
         VALUES (1, '常用名錄', 1, 0, ?, ?);`,
        [now, now],
      );

      // The old table may be missing (a fresh install created it at v14; handled here as possibly present).
      const hasOld = db.executeSync(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='favorite_taxa';`,
      );
      const oldExists = (hasOld.rows?.length ?? 0) > 0;
      if (oldExists) db.executeSync(`ALTER TABLE favorite_taxa RENAME TO favorite_taxa_v14;`);

      db.executeSync(`
        CREATE TABLE favorite_taxa (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          folder_id INTEGER NOT NULL DEFAULT 1,
          taxon_id TEXT NOT NULL,
          simple_name TEXT,
          common_name_c TEXT,
          family TEXT,
          family_c TEXT,
          rank TEXT,
          kingdom TEXT,
          added_at INTEGER NOT NULL,
          UNIQUE(folder_id, taxon_id),
          FOREIGN KEY (folder_id) REFERENCES favorite_folders(id) ON DELETE CASCADE
        );
      `);

      if (oldExists) {
        db.executeSync(`
          INSERT INTO favorite_taxa
            (folder_id, taxon_id, simple_name, common_name_c, family, family_c, rank, kingdom, added_at)
          SELECT 1, taxon_id, simple_name, common_name_c, family, family_c, rank, kingdom, added_at
          FROM favorite_taxa_v14;
        `);
        db.executeSync(`DROP TABLE favorite_taxa_v14;`);
      }

      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_favorite_folder ON favorite_taxa(folder_id, added_at DESC);`,
      );
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_favorite_taxon ON favorite_taxa(taxon_id);`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_favorite_folders_sort ON favorite_folders(sort_order, id);`,
      );
    },
  },
  {
    // v24: taxon cache for external checklists (GBIF / iNaturalist).
    //
    // Only species the local TaiCOL / jp_names does not have are stored — any that
    // match are bound to the existing t… / y… id, or one species would have two
    // identities and records and exports would split.
    //
    // In user.db, not twnamelist.db: the latter is a build product that init.ts
    // compares by Metro's asset.hash and deletes and re-copies whole when the
    // bundle changes — anything written into it vanishes on the next app update.
    // Here it also gets backup (VACUUM INTO of the whole file) and clear semantics
    // for free.
    //
    // The columns deliberately match favorite_taxa's denormalised columns: an
    // external taxon has no bundled row, so it has to carry its own display data.
    version: 24,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS external_taxa (
          taxon_id TEXT PRIMARY KEY,
          source TEXT NOT NULL,
          source_key TEXT NOT NULL,
          simple_name TEXT NOT NULL,
          name_author TEXT,
          rank TEXT,
          kingdom TEXT,
          phylum TEXT,
          class TEXT,
          "order" TEXT,
          family TEXT,
          genus TEXT,
          common_name_c TEXT,
          fetched_at INTEGER NOT NULL
        );
      `);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_external_source ON external_taxa(source, source_key);`,
      );
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_external_name ON external_taxa(simple_name);`);
    },
  },
  // v25: favourite folders remember their source. A folder built from a map area
  // must be able to say "which area, fetched from which service", or a few days
  // later the user cannot tell why the list holds these species.
  // area_geojson stores the queried area (GeoJSON Polygon), source stores
  // 'inat' / 'gbif' / 'manual'; both NULL = a folder made by hand.
  {
    version: 25,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE favorite_folders ADD COLUMN area_geojson TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE favorite_folders ADD COLUMN source TEXT;`);
    },
  },
  // v26: each specimen's identifier (DwC identifiedBy). The collector is who
  // collected it, the identifier who named it — often not the same person, and a
  // herbarium label prints both. Nullable: old specimens lack it and must not
  // fake it as the collector.
  {
    version: 26,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN identified_by TEXT;`);
    },
  },
  // v27: uuid for checklists. Plots have had a uuid (NOT NULL UNIQUE) since v5,
  // checklists had none, so an exported .yml imported back could not be
  // recognised as the same record — the round trip lacked an upsert key.
  //
  // ALTER TABLE cannot add NOT NULL UNIQUE (a constant DEFAULT gives every row the
  // same value), so it takes three steps: add a nullable column → backfill → add
  // a UNIQUE index. All three can rerun: addColumnIfMissing skips an existing
  // column, the UPDATE's WHERE fills only empty values, the index uses IF NOT
  // EXISTS — the migration runner has no transaction around it, so an interrupted
  // run must be able to pick up where it stopped.
  {
    version: 27,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE sessions ADD COLUMN uuid TEXT;`);
      // Same format (v4) as the runtime generator in src/db/uuid.ts.
      db.executeSync(`
        UPDATE sessions SET uuid = lower(
          hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
          substr(hex(randomblob(2)), 2) || '-' ||
          substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
          hex(randomblob(6))
        ) WHERE uuid IS NULL OR uuid = '';
      `);
      db.executeSync(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_uuid ON sessions(uuid);`);
    },
  },
  // v28: the name the user adopts (a taxonomic opinion).
  //
  // TaiCOL's taxon_id is a taxon concept, name_id is a name — 269,824 names hang on
  // 96,677 concepts, and about 27.7% of the concepts have synonyms. Records used to
  // store only taxon_id, which always meant TaiCOL's accepted name; but a synonym
  // or misapplied name often stands for a different taxonomic treatment, and the
  // user may deliberately record under that name.
  //
  // Two columns rather than one: name_id is TaiCOL's own CSV identifier (measured
  // between the 2026-02 and 2026-04 releases: of 242,282 shared ids only 13 changed
  // their scientific name and 3 disappeared), so it is exact; the name string is
  // self-describing, so it still shows when the id cannot be found or does not
  // match, and never silently turns into another name.
  //
  // Both NULL = the accepted name, which is the state of every existing row, so no
  // backfill is needed. usage_status is deliberately not stored: TaiCOL's opinion
  // changes (283 names changed status between the same two releases); the user's
  // choice is what persists, and the status is looked up live at display / export.
  {
    version: 28,
    up: (db) => {
      for (const t of ['checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN used_name_id INTEGER;`);
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN used_scientific_name TEXT;`);
      }
      // Lets external_taxa describe itself honestly: a row may be a non-accepted
      // name the user deliberately adopted, rather than every row claiming accepted.
      addColumnIfMissing(db, `ALTER TABLE external_taxa ADD COLUMN taxonomic_status TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE external_taxa ADD COLUMN accepted_name TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE external_taxa ADD COLUMN local_taxon_id TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE external_taxa ADD COLUMN local_status TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE external_taxa ADD COLUMN higher_classification TEXT;`);
      // 1 = adopted deliberately by the user (not minted by an area import). Must survive an upsert.
      addColumnIfMissing(
        db,
        `ALTER TABLE external_taxa ADD COLUMN adopted INTEGER NOT NULL DEFAULT 0;`,
      );
    },
  },
  // v29: audio attachments. audio_paths = JSON array of file:// URIs
  // (documentDirectory/audio/<uuid>.m4a), the same shape as photo_paths.
  // Deliberately left out of the export bundle / photo backup (the first version
  // only records → plays → deletes → uploads to iNaturalist).
  {
    version: 29,
    up: (db) => {
      for (const t of ['checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN audio_paths TEXT;`);
      }
    },
  },
  // v30: iNaturalist upload state.
  //
  // inat_observation_id: written as soon as the observation is created (even
  //   before its media are sent); non-NULL = the server already has it, and a
  //   retry reuses it instead of creating another.
  // inat_media_done: media confirmed delivered (photo_paths first, then audio).
  //   A retry resumes from here — v2 observation_sounds have no uuid to
  //   deduplicate, so this cursor is the only guarantee a sound is not uploaded twice.
  // inat_uploaded_at: written only when the observation and all its media
  //   succeeded; NULL with a non-NULL id = interrupted halfway.
  //
  // Only what we did is stored, not iNat's opinion (research grade etc.), by v28's
  // principle: state the other side can change is always looked up live.
  {
    version: 30,
    up: (db) => {
      for (const t of ['checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN inat_observation_id INTEGER;`);
        addColumnIfMissing(
          db,
          `ALTER TABLE ${t} ADD COLUMN inat_media_done INTEGER NOT NULL DEFAULT 0;`,
        );
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN inat_uploaded_at INTEGER;`);
      }
    },
  },
  // v31: iNat sync fingerprint. On a successful upload / sync, a hash of what was
  // sent (taxon, time, coordinates, description, annotations, media count) is
  // written; the detail page uses it to show "sync iNat (changed)".
  // NULL = old data or never synced; only the plain "sync" shows.
  {
    version: 31,
    up: (db) => {
      for (const t of ['checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN inat_sync_hash TEXT;`);
      }
    },
  },
  // v32: last-updated time, shown in the footer of the species / specimen detail
  // page (with occurrence_id).
  //
  // "Updated" = the user changed the record's content (abundance, attributes,
  // notes, coordinates, photos, sounds, layer, taxon). The inat_* columns written
  // back by an iNat upload deliberately do not count — that is our bookkeeping,
  // not a change to field data; it all lives in src/db/inatSync.ts, so leaving
  // that file alone excludes it automatically.
  //
  // Existing rows are backfilled with the earliest time known for them (record /
  // collection time), not the moment the migration ran: that would make all old
  // data look as if it had just been edited.
  {
    version: 32,
    up: (db) => {
      for (const [t, seed] of [
        ['checklist_records', 'observed_at'],
        ['plot_species_records', 'created_at'],
        ['collection_specimens', 'collected_at'],
      ] as const) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN updated_at INTEGER;`);
        db.executeSync(`UPDATE ${t} SET updated_at = ${seed} WHERE updated_at IS NULL;`);
      }
    },
  },
  // v33: degreeOfEstablishment (wild / captive / cultivated), a per-record DwC
  // attribute.
  //
  // Not the same as the taxon-level alien_type: that says whether the taxon is
  // native or introduced in Taiwan (from TaiCOL, one value per species, exported as
  // establishmentMeans); this says whether this one individual is wild or kept /
  // planted by people — one species can be both.
  //
  // NULL = not recorded, which differs from an explicit 'wild': the first says
  // nothing, the second says something.
  {
    version: 33,
    up: (db) => {
      for (const t of ['checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN degree_of_establishment TEXT;`);
      }
    },
  },
  // v34: starred records (starred) sort to the top of the record list.
  //
  // 0 = not starred (default), 1 = starred. An integer rather than a boolean on
  // purpose: SQLite has no boolean type, and existing columns (inat_media_done,
  // track_finalized) follow this convention.
  //
  // Not the same as the favourites (favorite_taxa): those collect **species**,
  // this marks a whole survey record.
  //
  // Not exported or imported: the star is how this device organises things, not
  // an observed fact of the survey, and writing it into the yml would blur what
  // "the same record on two devices" means.
  {
    version: 34,
    up: (db) => {
      for (const t of ['sessions', 'plot_surveys', 'collection_trips']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN starred INTEGER NOT NULL DEFAULT 0;`);
      }
    },
  },
  {
    // Once checklist modules became downloadable, deletable files, a t… / y… taxon
    // a record points at can become unresolvable at any time — the module not yet
    // downloaded, deleted by the user, or restored onto a device without it.
    //
    // This table is the twin of the `ensureExternalCopy` invariant: a pack's g…
    // taxon is copied into external_taxa as soon as it is written to a record, and
    // likewise a t… / y… taxon leaves a copy of its name here. The difference is
    // that **the taxon_id must never change** (external_taxa mints a new g… id,
    // which would split the record's statistics and exports), so that table cannot
    // be reused and this one is needed.
    //
    // The columns deliberately mirror `TaxonFields` (taxonLookup.ts) one for one, so
    // `resolveTaxa`'s fallback is a direct row → fields mapping with no special cases.
    version: 35,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS taxon_name_cache (
          taxon_id TEXT PRIMARY KEY,
          dataset_id TEXT NOT NULL,
          simple_name TEXT NOT NULL DEFAULT '',
          name_author TEXT NOT NULL DEFAULT '',
          common_name_c TEXT NOT NULL DEFAULT '',
          alternative_name_c TEXT NOT NULL DEFAULT '',
          family TEXT NOT NULL DEFAULT '',
          family_c TEXT NOT NULL DEFAULT '',
          rank TEXT NOT NULL DEFAULT '',
          is_endemic TEXT NOT NULL DEFAULT '',
          alien_type TEXT NOT NULL DEFAULT '',
          redlist TEXT NOT NULL DEFAULT '',
          iucn TEXT NOT NULL DEFAULT '',
          cites TEXT NOT NULL DEFAULT '',
          protected TEXT NOT NULL DEFAULT '',
          is_hybrid TEXT NOT NULL DEFAULT '',
          kingdom TEXT NOT NULL DEFAULT '',
          kingdom_c TEXT NOT NULL DEFAULT '',
          phylum TEXT NOT NULL DEFAULT '',
          phylum_c TEXT NOT NULL DEFAULT '',
          class TEXT NOT NULL DEFAULT '',
          class_c TEXT NOT NULL DEFAULT '',
          "order" TEXT NOT NULL DEFAULT '',
          order_c TEXT NOT NULL DEFAULT '',
          genus TEXT NOT NULL DEFAULT '',
          genus_c TEXT NOT NULL DEFAULT '',
          is_terrestrial TEXT NOT NULL DEFAULT '',
          is_freshwater TEXT NOT NULL DEFAULT '',
          is_brackish TEXT NOT NULL DEFAULT '',
          is_marine TEXT NOT NULL DEFAULT '',
          is_fossil TEXT NOT NULL DEFAULT '',
          cached_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // The iNaturalist observation grid on a species record's mini map needs the
    // scientific name turned into an iNat taxon id.
    //
    // This table caches that lookup. **The negative cache (`inat_taxon_id IS NULL`)
    // is the point**: of 30 TaiCOL accepted names tested, 5 were missing from iNat
    // altogether (rove beetles, clown beetles, adelgids — obscure groups its backbone
    // lacks), about 17%. Without a negative cache every opening of those species
    // would run an autocomplete whose answer is always "none".
    //
    // In user.db rather than a checklist module: it is a lookup result, so going
    // along with backups is right, and being wiped by "clear all data" is right too.
    // `checked_at` re-verifies entries after 30 days (see inatHeatmap.ts).
    version: 36,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS inat_taxon_map (
          name TEXT NOT NULL,
          kingdom TEXT NOT NULL DEFAULT '',
          -- NULL = 查過、iNat 沒有這個名字（負快取），不是「還沒查」
          inat_taxon_id INTEGER,
          -- captive=false 的筆數
          obs_wild INTEGER NOT NULL DEFAULT 0,
          -- 未過濾的總筆數。NULL = 沒去問（obs_wild > 0 時不需要問，省一次請求）
          obs_total INTEGER,
          checked_at INTEGER NOT NULL,
          PRIMARY KEY (name, kingdom)
        );
      `);
    },
  },
  {
    // The name iNaturalist actually files the taxon under, plus how it was
    // reached.
    //
    // v36 stored the id alone, which cannot tell the two answers apart: "iNat
    // has Sphaeropteris lepifera, which is what you asked for" and "iNat has
    // Sphaeropteris lepifera, which is where your Cyathea lepifera went". The
    // grid draws the same tiles either way, so without this the caption would
    // have to stay silent about a name swap the user never agreed to — the one
    // thing src/lib/inat.ts's header says this feature must never do.
    //
    // Nullable, and the old rows keep their NULLs: they were resolved by the
    // strict matcher, where the name is by definition the one that was asked
    // for, so backfilling would only invent a fact the row never recorded.
    version: 37,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE inat_taxon_map ADD COLUMN inat_name TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE inat_taxon_map ADD COLUMN matched_via TEXT;`);
    },
  },
  {
    // Preferred identifiers (DwC identifiedBy), the determiner's counterpart to
    // v15's `surveyors`.
    //
    // A SEPARATE table rather than a `kind` column on `surveyors`: that table
    // declares `name TEXT NOT NULL UNIQUE`, and SQLite cannot relax a column
    // constraint without rebuilding the table. Sharing it would make
    // `INSERT OR IGNORE` silently drop an identifier who is already in the
    // surveyor list — and being both is the normal case, not an edge one.
    //
    // The old free-text `default_identified_by` preference is carried in as
    // default rows, so a user who had one keeps having it.
    version: 38,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS identifiers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL UNIQUE,
          is_default INTEGER NOT NULL DEFAULT 0,
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
      `);
      try {
        const res = db.executeSync(
          `SELECT value FROM settings WHERE key = 'default_identified_by' LIMIT 1;`,
        );
        const raw = String((res.rows?.[0] as { value?: string } | undefined)?.value ?? '').trim();
        raw
          .split(',')
          .map((n) => n.trim())
          .filter(Boolean)
          .forEach((name, i) => {
            db.executeSync(
              `INSERT OR IGNORE INTO identifiers (name, is_default, sort_order, created_at)
               VALUES (?, 1, ?, ?);`,
              [name, i, Date.now()],
            );
          });
      } catch {
        // Seeding is a convenience, not the migration's job. A DB without the
        // settings table (or with an unreadable row) must still end up with the
        // table this migration exists to create.
      }
    },
  },
  {
    /**
     * v39 — `verbatim_identification`: the determination as it was written in
     * the field.
     *
     * A field identification often stops above species: `Orchidaceae sp1` and
     * `sp2` are two distinct morphospecies that share one taxon_id, because the
     * only name either can be given is the family's. Same at genus —
     * `Cinnamomum sp1` / `sp2`. Without somewhere to put "sp1" the two rows are
     * indistinguishable, and the checklist cannot say there were two of them.
     *
     * DwC `verbatimIdentification`, which is exactly "the taxonomic
     * identification as it appeared in the original record".
     *
     * NULL = no morphospecies label, which is the ordinary case and is a
     * different statement from an empty string. All three record kinds get it:
     * a plot or a collection meets an unidentifiable individual just as often.
     */
    version: 39,
    up: (db) => {
      for (const t of ['checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${t} ADD COLUMN verbatim_identification TEXT;`);
      }
    },
  },
  {
    // DwC `dateIdentified` — when the determination on this specimen was made.
    //
    // `identified_by` has existed since v33 but nothing wrote it on
    // re-identification, so swapping a name left the PREVIOUS determiner
    // attached to the NEW name. That is not a display glitch, it is a false
    // attribution in the exported record. The date was missing entirely, so
    // there was no way to tell an original determination from a later one.
    //
    // ISO-8601 date (YYYY-MM-DD), matching DwC and the rest of the export
    // layer, rather than an epoch — this is a determination date, not an event
    // timestamp, and day precision is all a herbarium label carries.
    version: 40,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN date_identified TEXT;`);
    },
  },
  {
    // Where a picked photo said it was taken.
    //
    // The position lives in the photo's own metadata, but for a HEIC — what an
    // iPhone camera writes by default — it is only legible at the moment the
    // picker hands it over: `piexif` parses JPEG / TIFF / a bare Exif blob and
    // throws on HEIC, and `persistPickedPhoto` copies the file unchanged, so
    // nothing can read it back off disk afterwards.
    //
    // Without this, attaching a photo could fill in a missing coordinate but
    // 「用照片的 GNSS 定位」 could not recover it once the coordinate was
    // cleared — the same photo, two different answers, depending on whether
    // the app still happened to be holding the picker's EXIF in memory.
    //
    // Keyed by the stored URI, which is a uuid under documentDirectory/photos/
    // and never reused. Rows are a cache: losing one costs a coordinate that
    // has to be re-entered, never a record.
    version: 41,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS photo_fix (
          uri TEXT PRIMARY KEY,
          lat REAL,
          lng REAL,
          accuracy REAL,
          taken_at INTEGER,
          created_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // Drop the pre-v12 per-layer columns.
    //
    // v12 moved per-layer cover / height / method into the normalised
    // `plot_survey_layers` table and kept these for rollback safety. That was
    // 2026-05; nothing in `src/` or `app/` reads them any more, and
    // `check-roundtrip.mjs` already lists every one of them as legacy.
    //
    // Deliberately tolerant. `ALTER TABLE … DROP COLUMN` needs SQLite 3.35+
    // (op-sqlite ships 3.51.3, so this does work), but a migration that throws
    // is a migration that fails on every launch — and these columns cost
    // nothing but bytes. Better to leave one behind than to brick the app over
    // tidiness. `columnsOf` also makes the whole thing idempotent.
    version: 42,
    up: (db) => {
      const present = columnsOf(db, 'plot_surveys');
      const legacy = ['e0', 'e1', 'e2', 'e3'].flatMap((e) => [
        `${e}_cover_pct`,
        `${e}_height_cm`,
        `${e}_method`,
      ]);
      for (const col of legacy) {
        if (!present.has(col)) continue;
        try {
          db.executeSync(`ALTER TABLE plot_surveys DROP COLUMN ${col};`);
        } catch {
          // Older SQLite, or the column is referenced by something we cannot
          // see. Nothing reads it either way.
        }
      }
    },
  },
  {
    // v43: herbarium bookkeeping the field app was missing.
    //
    // Duplicates are a COUNT, not a child table. In the field you know you
    // took three sheets; which herbaria they end up in is decided back at the
    // herbarium, often not by the collector. Modelling per-duplicate
    // institutions here would ask for information nobody has yet, and the
    // curation system that does have it is not this app.
    //
    // `institution_code` sits on both tables on purpose: the trip carries the
    // default (a collecting trip usually feeds one herbarium) and the specimen
    // overrides it when one sheet goes elsewhere. The specimen's value wins
    // when set; NULL means "whatever the trip says".
    version: 43,
    up: (db) => {
      addColumnIfMissing(
        db,
        `ALTER TABLE collection_specimens ADD COLUMN duplicate_count INTEGER;`,
      );
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN institution_code TEXT;`);
      addColumnIfMissing(
        db,
        `ALTER TABLE collection_specimens ADD COLUMN other_catalog_numbers TEXT;`,
      );
      addColumnIfMissing(db, `ALTER TABLE collection_trips ADD COLUMN institution_code TEXT;`);
      // E5: a collecting trip can be pinned to a geographic site, the same
      // way a session already can. No FK: sites are deletable and a trip
      // that outlives its site should keep its other data rather than
      // cascade away.
      addColumnIfMissing(db, `ALTER TABLE collection_trips ADD COLUMN site_id INTEGER;`);
    },
  },
  {
    // Herbarium label fields.
    // `catalog_number` is the receiving herbarium's accession number for this
    // sheet (DwC catalogNumber, e.g. 13450 of TAI13450); `other_catalog_numbers`
    // stays for any further numbering. `elevation_m` is the collecting
    // altitude in metres — from the GNSS fix when it reports one, otherwise
    // typed in. NULL = not recorded.
    version: 44,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN catalog_number TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE collection_specimens ADD COLUMN elevation_m REAL;`);
    },
  },
  {
    // Per-record altitude for the other two record kinds, filled with the
    // coordinate when a species is entered (GNSS) and editable afterwards —
    // the same metres column the specimen got in v44. NULL = not recorded.
    version: 45,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE checklist_records ADD COLUMN elevation_m REAL;`);
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN elevation_m REAL;`);
    },
  },
  {
    // Where each altitude came from, so the export can state its vertical
    // datum (dwcLocation.ts): 'gnss' = height above the WGS 84 ellipsoid as
    // the receiver reported it (EPSG:7030); 'manual' = typed in, datum
    // unknown ('not recorded'). NULL = no altitude, or one recorded before
    // this column existed — exported as 'not recorded', never guessed.
    version: 46,
    up: (db) => {
      for (const table of ['plot_surveys', 'checklist_records', 'plot_species_records', 'collection_specimens']) {
        addColumnIfMissing(db, `ALTER TABLE ${table} ADD COLUMN elevation_source TEXT;`);
      }
    },
  },
  {
    // GLORIA summit monitoring (src/modules/gloria). One survey = one
    // monitoring cycle (mocy) on one summit; it owns 28 units (16 quadrats,
    // 8 summit area sections, 4 10×10 m squares) and 28 measurement points,
    // all created with the survey.
    //
    // Cell and point data are fixed-length strings, one character per cell
    // or point (model/grid.ts): NULL = method not done, all '0' = done and
    // nothing found. `gloria_taxa` is the survey's roster and the only table
    // here that holds a taxon_id; unit rows point at it, so re-identifying a
    // taxon fixes every unit at once.
    //
    // `status` takes part in the app-wide single-active invariant, like
    // sessions and plot surveys.
    version: 47,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_summits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          full_code TEXT NOT NULL UNIQUE,
          country TEXT NOT NULL,
          target_region TEXT NOT NULL,
          summit TEXT NOT NULL,
          name TEXT,
          decimal_latitude REAL,
          decimal_longitude REAL,
          twd97x REAL,
          twd97y REAL,
          elevation_m REAL,
          veg_zone TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_surveys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          summit_id INTEGER NOT NULL,
          mocy INTEGER NOT NULL,
          year INTEGER,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
          start_ts INTEGER NOT NULL,
          stop_ts INTEGER,
          recorded_by TEXT,
          prev_survey_id INTEGER,
          project_id INTEGER NOT NULL DEFAULT 0,
          site_id INTEGER,
          grid_ok_n INTEGER NOT NULL DEFAULT 0,
          grid_ok_e INTEGER NOT NULL DEFAULT 0,
          grid_ok_s INTEGER NOT NULL DEFAULT 0,
          grid_ok_w INTEGER NOT NULL DEFAULT 0,
          notes TEXT,
          starred INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (summit_id) REFERENCES gloria_summits(id),
          FOREIGN KEY (prev_survey_id) REFERENCES gloria_surveys(id) ON DELETE SET NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          UNIQUE (summit_id, mocy)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_gsurv_summit ON gloria_surveys(summit_id, mocy);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_gsurv_start ON gloria_surveys(start_ts DESC);`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_gsurv_active ON gloria_surveys(status) WHERE status = 'active';`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_points (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          survey_id INTEGER NOT NULL,
          point_key TEXT NOT NULL,
          is_p5m INTEGER NOT NULL DEFAULT 0,
          distance_m REAL,
          compass_deg REAL,
          photo_m2 TEXT,
          photo_m2f TEXT,
          photo_point TEXT,
          comments TEXT,
          uuid TEXT NOT NULL UNIQUE,
          FOREIGN KEY (survey_id) REFERENCES gloria_surveys(id) ON DELETE CASCADE,
          UNIQUE (survey_id, point_key)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_units (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          survey_id INTEGER NOT NULL,
          code TEXT NOT NULL,
          unit_type TEXT NOT NULL CHECK (unit_type IN ('quadrat', 'sas', 'square')),
          start_ts INTEGER,
          stop_ts INTEGER,
          freq_start_ts INTEGER,
          freq_stop_ts INTEGER,
          recorded_by TEXT,
          aspect_deg REAL,
          slope_deg REAL,
          cov_vascular REAL,
          cov_solid_rock REAL,
          cov_scree REAL,
          cov_lichens REAL,
          cov_bryophytes REAL,
          cov_bare_ground REAL,
          cov_litter REAL,
          sub_lich_below_vasc REAL,
          sub_lich_on_rock REAL,
          sub_lich_on_scree REAL,
          sub_bry_below_vasc REAL,
          sub_bry_on_rock REAL,
          sub_bry_on_scree REAL,
          dist_hi1 TEXT,
          dist_hi2 TEXT,
          dist_hi3 TEXT,
          point_surface TEXT,
          walk_option INTEGER CHECK (walk_option IS NULL OR walk_option BETWEEN 1 AND 4),
          legacy_surface_hits TEXT,
          grazing_note TEXT,
          comments TEXT,
          photo_paths TEXT,
          uuid TEXT NOT NULL UNIQUE,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES gloria_surveys(id) ON DELETE CASCADE,
          UNIQUE (survey_id, code)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_taxa (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          survey_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          serial INTEGER NOT NULL,
          used_name_id INTEGER,
          used_scientific_name TEXT,
          verbatim_identification TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES gloria_surveys(id) ON DELETE CASCADE,
          UNIQUE (survey_id, taxon_id),
          UNIQUE (survey_id, serial)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_gtaxa_taxon ON gloria_taxa(taxon_id);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_unit_species (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          unit_id INTEGER NOT NULL,
          gloria_taxon_id INTEGER NOT NULL,
          occurrence_id TEXT NOT NULL UNIQUE,
          cover_pct REAL CHECK (cover_pct IS NULL OR (cover_pct >= 0 AND cover_pct <= 100)),
          abundance TEXT CHECK (abundance IS NULL OR abundance IN ('r!', 'r', 's', 'c', 'd')),
          layer TEXT,
          cf TEXT CHECK (cf IS NULL OR cf IN ('g', 's', 't')),
          freq_cells TEXT,
          point_hits TEXT,
          legacy_hits INTEGER,
          reproductive_condition TEXT,
          leaf_phenology TEXT,
          comments TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (unit_id) REFERENCES gloria_units(id) ON DELETE CASCADE,
          FOREIGN KEY (gloria_taxon_id) REFERENCES gloria_taxa(id) ON DELETE CASCADE,
          UNIQUE (unit_id, gloria_taxon_id)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_gus_taxon ON gloria_unit_species(gloria_taxon_id);`);
    },
  },
  {
    // GLORIA frequency as a count only. Some past cycles (e.g. the first
    // resurvey) recorded how many of the 100 cells a species occupied without
    // marking which ones. `freq_mode` says how a quadrat's frequency was taken:
    // 'cells' (freq_cells / dist_hi* masks) or 'count' (freq_count /
    // dist_hi*_n); NULL = frequency not done.
    version: 48,
    up: (db) => {
      addColumnIfMissing(
        db,
        `ALTER TABLE gloria_unit_species ADD COLUMN freq_count INTEGER CHECK (freq_count IS NULL OR (freq_count >= 0 AND freq_count <= 100));`,
      );
      addColumnIfMissing(
        db,
        `ALTER TABLE gloria_units ADD COLUMN freq_mode TEXT CHECK (freq_mode IS NULL OR freq_mode IN ('cells', 'count'));`,
      );
      for (const c of ['dist_hi1_n', 'dist_hi2_n', 'dist_hi3_n']) {
        addColumnIfMissing(
          db,
          `ALTER TABLE gloria_units ADD COLUMN ${c} INTEGER CHECK (${c} IS NULL OR (${c} >= 0 AND ${c} <= 100));`,
        );
      }
      // Quadrats that already have cell masks were done by cells.
      db.executeSync(
        `UPDATE gloria_units SET freq_mode = 'cells' WHERE freq_mode IS NULL
           AND (dist_hi1 IS NOT NULL OR dist_hi2 IS NOT NULL OR dist_hi3 IS NOT NULL
             OR EXISTS (SELECT 1 FROM gloria_unit_species us WHERE us.unit_id = gloria_units.id AND us.freq_cells IS NOT NULL))`,
      );
    },
  },
  {
    // GLORIA summit overview photos (manual Annex III item SU-OV): JSON array
    // of { uri, viewpoint } — the viewpoint is element 8 of the file name.
    version: 49,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_surveys ADD COLUMN overview_photos TEXT;`);
    },
  },
  {
    // The frequency end time follows the last edit until the user sets it by
    // hand; from then on it is theirs (see touchFrequency).
    version: 50,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN freq_stop_manual INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    // GLORIA photo checklist (manual Box 4.4: tick every obligatory photo on
    // Form 1). One row per ticked or photographed item; `item` is a key from
    // model/photoChecks. Photos of items that already have a column
    // (gloria_points.photo_*, overview_photos) stay there.
    version: 51,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_photo_checks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          survey_id INTEGER NOT NULL,
          item TEXT NOT NULL,
          checked INTEGER NOT NULL DEFAULT 0 CHECK (checked IN (0, 1)),
          photo_uri TEXT,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES gloria_surveys(id) ON DELETE CASCADE,
          UNIQUE (survey_id, item)
        );
      `);
    },
  },
  {
    // Frequency of a quadrat marked done: the screen refuses edits until reopened.
    version: 52,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN freq_locked INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    // Point-framing of a 1×1 m quadrat gets its own start / end and lock, apart
    // from the cover estimate (start_ts / stop_ts). A 10×10 m square's walk is
    // the unit itself and keeps using start_ts / stop_ts.
    version: 53,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN pf_start_ts INTEGER;`);
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN pf_stop_ts INTEGER;`);
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN pf_locked INTEGER NOT NULL DEFAULT 0;`);
    },
  },
  {
    // End times become plain, editable data (digitising old field sheets
    // means typing a past time, or leaving it blank), so "finished" needs a
    // column of its own wherever it was the end time itself:
    //   - sessions: active WAS `ended_at IS NULL`; now `status`, like plots
    //     and collection trips already have;
    //   - GLORIA units: done WAS `stop_ts IS NOT NULL`; now `done_locked`.
    version: 54,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE sessions ADD COLUMN status TEXT NOT NULL DEFAULT 'active';`);
      db.executeSync(`UPDATE sessions SET status = 'done' WHERE ended_at IS NOT NULL;`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_sessions_status_active ON sessions(status) WHERE status = 'active';`,
      );
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN done_locked INTEGER NOT NULL DEFAULT 0;`);
      db.executeSync(`UPDATE gloria_units SET done_locked = 1 WHERE stop_ts IS NOT NULL;`);
    },
  },
  {
    // The order species are listed in a unit — the field sheet's order,
    // dragged into place by the user. NULL = never reordered: after the
    // reordered ones, by roster serial (model/speciesOrder.ts).
    version: 55,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_unit_species ADD COLUMN sort_order INTEGER;`);
    },
  },
  {
    // Intermediate ranks (subfamily, tribe, superfamily, subgenus …) the user
    // adds or re-places in the taxonomy tree. TaiCOL's own parent links ship in
    // the tw-taicol module (`taxon_tree` / `rank_bridge`); these two tables are
    // the user layer on top and win over it (db/intermediateTaxa.ts).
    //
    // user_taxon_node: a user-created intermediate taxon. It hangs below the
    // fixed-rank taxon `anchor_rank`/`anchor_name` (e.g. family Poaceae), under
    // `parent_ref` (another intermediate: TaiCOL taxon_id or 'un…') or
    // directly under the anchor when NULL.
    //
    // taxon_parent_override: re-places an existing child. `child_key` is
    // 'kingdom|rank|name' for a fixed-rank taxon or species (names survive a
    // TaiCOL re-import, taxon_ids may not) or a TaiCOL taxon_id for a TaiCOL
    // intermediate. `parent_ref` NULL = directly under the anchor, i.e. the user
    // detached it from TaiCOL's intermediate.
    version: 56,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS user_taxon_node (
          id TEXT PRIMARY KEY,
          rank TEXT NOT NULL,
          simple_name TEXT NOT NULL,
          name_author TEXT,
          common_name_c TEXT,
          kingdom TEXT NOT NULL,
          anchor_rank TEXT NOT NULL,
          anchor_name TEXT NOT NULL,
          parent_ref TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.executeSync(`
        CREATE INDEX IF NOT EXISTS idx_user_taxon_node_anchor
          ON user_taxon_node(kingdom, anchor_rank, anchor_name);
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS taxon_parent_override (
          child_key TEXT PRIMARY KEY,
          parent_ref TEXT,
          updated_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // Team merge (src/lib/mergeEngine.ts). `sync_base` is the common ancestor
    // for a record: each row's content hash as of the last exchange (import or
    // merge) with another device. A row whose hash moved changed since then; a
    // row in the base but gone now was deleted — no updated_at stamping or
    // tombstones needed in the write helpers.
    //
    // Merging matches species rows by occurrence_id, so none may be blank.
    // v16 backfilled them once; this catches any written without since.
    version: 57,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_base (
          record_kind TEXT NOT NULL,
          record_uuid TEXT NOT NULL,
          tbl TEXT NOT NULL,
          row_key TEXT NOT NULL,
          hash TEXT NOT NULL,
          PRIMARY KEY (record_kind, record_uuid, tbl, row_key)
        );
      `);
      const uuidExpr = `lower(
        hex(randomblob(4)) || '-' || hex(randomblob(2)) || '-4' ||
        substr(hex(randomblob(2)), 2) || '-' ||
        substr('89ab', abs(random()) % 4 + 1, 1) || substr(hex(randomblob(2)), 2) || '-' ||
        hex(randomblob(6))
      )`;
      for (const tbl of ['checklist_records', 'plot_species_records']) {
        db.executeSync(`UPDATE ${tbl} SET occurrence_id = ${uuidExpr} WHERE occurrence_id IS NULL OR occurrence_id = '';`);
      }
    },
  },
  {
    // Team sync through a relay (src/lib/teamSync.ts, docs/Team_sync.md).
    // The team secret itself is NOT here: it lives in the Keychain / Keystore
    // (expo-secure-store) and never enters a backup. These tables hold only
    // what this device needs to resume: which teams, which records sync with
    // which team (and under which server-side name), the peers' uploads
    // already merged (by etag), and records waiting for a connection.
    version: 58,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_teams (
          team_id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          server TEXT,
          is_owner INTEGER NOT NULL DEFAULT 0,
          joined_at INTEGER NOT NULL,
          last_sync_at INTEGER
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_links (
          team_id TEXT NOT NULL,
          record_kind TEXT NOT NULL,
          record_uuid TEXT NOT NULL,
          rec_key TEXT NOT NULL,
          last_synced_at INTEGER,
          PRIMARY KEY (team_id, record_kind, record_uuid)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_seen (
          team_id TEXT NOT NULL,
          rec_key TEXT NOT NULL,
          dev TEXT NOT NULL,
          etag TEXT NOT NULL,
          PRIMARY KEY (team_id, rec_key, dev)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_queue (
          team_id TEXT NOT NULL,
          record_kind TEXT NOT NULL,
          record_uuid TEXT NOT NULL,
          queued_at INTEGER NOT NULL,
          PRIMARY KEY (team_id, record_kind, record_uuid)
        );
      `);
    },
  },
  {
    // Team sync: names. `member_name` is how this device signs its uploads in
    // that team; it travels only inside the sealed record (sync.author), so
    // the relay never sees it. `sync_members` is who this device has heard
    // from, learnt from teammates' decrypted uploads — keyed by the keyed
    // device name, so a teammate who renames themselves updates in place.
    version: 59,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE sync_teams ADD COLUMN member_name TEXT;`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_members (
          team_id TEXT NOT NULL,
          dev TEXT NOT NULL,
          name TEXT NOT NULL,
          last_upload_at INTEGER,
          PRIMARY KEY (team_id, dev)
        );
      `);
    },
  },
  {
    // Team sync: relays this device knows besides the built-in default — the
    // one it deployed (is_own) or a URL typed when creating a team — and which
    // one new teams start on (is_default; none set = the built-in default).
    // Only URLs: a relay's admin token stays in the Keychain / Keystore.
    version: 60,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_servers (
          url TEXT PRIMARY KEY,
          is_own INTEGER NOT NULL DEFAULT 0,
          is_default INTEGER NOT NULL DEFAULT 0,
          added_at INTEGER NOT NULL
        );
      `);
    },
  },
  {
    // Team sync: what this device last uploaded for a record — a hash of the
    // content, base and name (not the export time) and when. The team page's
    // pull-down skips a record whose hash is unchanged and was uploaded in the
    // last 30 days, so an untouched record is not re-sent on every pull.
    version: 61,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE sync_links ADD COLUMN uploaded_hash TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE sync_links ADD COLUMN uploaded_at INTEGER;`);
    },
  },
  {
    // GLORIA: a 1×1 m quadrat where the grid frame cannot be mounted (shrubs,
    // tall vegetation; manual §5.1.2 p.51) skips frequency and point-framing.
    // 1 = skipped, NULL = not. Never 0, so a file from an older app (no such
    // key, read as NULL) does not differ from an untouched quadrat in a merge.
    version: 62,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN freq_skipped INTEGER;`);
    },
  },
  {
    // GLORIA morphospecies: a determination that stopped at a genus or family
    // can be on the roster more than once, told apart by its label (sp1,
    // sp2 — `verbatim_identification`, shared by the whole survey). The roster
    // was UNIQUE (survey_id, taxon_id); it becomes unique per taxon AND label.
    //
    // Rebuilt the way SQLite documents (new table, copy, drop, rename the new
    // one): renaming the OLD table first would rewrite gloria_unit_species'
    // `REFERENCES gloria_taxa` to follow it. Migrations run with foreign keys
    // off (db/init.ts), so the drop leaves the unit species rows alone; ids
    // are copied, so their gloria_taxon_id still points at the same entry.
    version: 63,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE gloria_taxa_v63 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          survey_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          serial INTEGER NOT NULL,
          used_name_id INTEGER,
          used_scientific_name TEXT,
          verbatim_identification TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES gloria_surveys(id) ON DELETE CASCADE,
          UNIQUE (survey_id, serial)
        );
      `);
      db.executeSync(`
        INSERT INTO gloria_taxa_v63 (id, survey_id, taxon_id, serial, used_name_id, used_scientific_name, verbatim_identification, created_at)
        SELECT id, survey_id, taxon_id, serial, used_name_id, used_scientific_name, verbatim_identification, created_at FROM gloria_taxa;
      `);
      db.executeSync(`DROP TABLE gloria_taxa;`);
      db.executeSync(`ALTER TABLE gloria_taxa_v63 RENAME TO gloria_taxa;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_gtaxa_taxon ON gloria_taxa(taxon_id);`);
      // An empty label and no label are the same entry.
      db.executeSync(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_gtaxa_label ON gloria_taxa(survey_id, taxon_id, IFNULL(verbatim_identification, ''));`,
      );
    },
  },
  {
    // GLORIA: a unit start filled from the survey's start date carries no
    // time of day — 1 = `start_ts` is local midnight standing for "that date,
    // time unknown". NULL otherwise (never 0; merge-safe like freq_skipped).
    // Such a unit is not "started": status, counts and the first-input stamp
    // treat it as untouched.
    version: 64,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN date_only INTEGER;`);
    },
  },
  {
    // GLORIA temperature loggers (manual §4.3, Form 4). A visit is one Form 4:
    // readings, battery or logger changes and new installations on one day.
    // Visits belong to the SUMMIT, not to a survey — loggers are read and
    // swapped several times between two monitoring cycles — and fall into a
    // cycle by date (model/loggers cycleOf), so the cycle is never stored.
    // `survey_id` only notes the survey a visit was entered from.
    // Locks and ticks are 1 / NULL (never 0), merge-safe like freq_skipped.
    // File columns hold JSON [{uri, name, size}] of files kept in
    // Documents/files/.
    version: 65,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_logger_visits (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          summit_id INTEGER NOT NULL,
          survey_id INTEGER,
          visit_ts INTEGER NOT NULL,
          researchers TEXT,
          comments TEXT,
          form4_files TEXT,
          locked INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (summit_id) REFERENCES gloria_summits(id) ON DELETE CASCADE,
          FOREIGN KEY (survey_id) REFERENCES gloria_surveys(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_glv_summit ON gloria_logger_visits(summit_id, visit_ts);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS gloria_loggers (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          visit_id INTEGER NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('install', 'readout')),
          direction TEXT NOT NULL CHECK (direction IN ('N', 'E', 'S', 'W')),
          quadrat TEXT NOT NULL,
          label TEXT,
          serial TEXT,
          logger_type TEXT,
          start_ts INTEGER,
          stop_ts INTEGER,
          utc_diff_h REAL,
          dist11_m REAL,
          dist31_m REAL,
          photo_open INTEGER,
          photo_closed INTEGER,
          photo_open_uri TEXT,
          photo_closed_uri TEXT,
          flags TEXT,
          researcher TEXT,
          comments TEXT,
          data_files TEXT,
          prev_uuid TEXT,
          sort_order INTEGER,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (visit_id) REFERENCES gloria_logger_visits(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_glog_visit ON gloria_loggers(visit_id);`);
    },
  },
  {
    // A GLORIA unit with explicitly no researchers (1; after 清空此樣區資料),
    // as against NULL recorded_by, which follows the survey's list. A flag,
    // not an empty string: the merge engine treats '' as NULL. 1 / NULL,
    // never 0, merge-safe like freq_skipped.
    version: 66,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE gloria_units ADD COLUMN no_researchers INTEGER;`);
    },
  },
  {
    // Merge log: what each merge (team sync or an imported teammate's file)
    // changed in a record, row by row (mergeEngine describeMerge), for the
    // record's 合併紀錄. Kept per device, not exported or synced; orphans are
    // cleared with the record (db/cleanup).
    version: 67,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS merge_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_kind TEXT NOT NULL,
          record_uuid TEXT NOT NULL,
          author TEXT,
          merged_at INTEGER NOT NULL,
          changes TEXT NOT NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_merge_log_record ON merge_log(record_kind, record_uuid, merged_at);`);
    },
  },
  {
    // MIREN road / trail surveys (src/modules/miren; design in
    // docs/planned/MIREN.md). Reference data — regions, routes, sites and
    // the region's native/alien table (S2 table B) — is shared across
    // years, like gloria_summits. One survey = one route in one year; it owns
    // its plots (site × plot number × visit), its roster and its rechecks,
    // so a survey exports and merges on its own.
    //
    // Cover and abundance are stored as class numbers; which scale applies
    // follows from route kind + plot number (model/scales.ts). Road tree
    // cover / bare ground / litter are percentages (project decision
    // 2026-09-27); the trail plot covers are classes 0–8 as the trail
    // protocol asks. Field dates are ISO 8601 text; bookkeeping times are
    // epoch ms like every other table, written out as ISO 8601 on export.
    //
    // Blind recording and recheck: `blind_closed_at` seals the blind list,
    // `compared_at` finishes the plot; `miren_plot_species.phase` tells a
    // species found in the recheck ('recheck') from a blind one.
    //
    // `status` takes part in the app-wide single-active invariant.
    version: 68,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_regions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          code_road TEXT UNIQUE CHECK (code_road IS NULL OR length(code_road) = 3),
          code_trail TEXT UNIQUE CHECK (code_trail IS NULL OR length(code_trail) = 2),
          name TEXT,
          country TEXT,
          default_literature TEXT,
          regional_description TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          CHECK (code_road IS NOT NULL OR code_trail IS NOT NULL)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_region_status (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          region_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          verbatim_identification TEXT,
          status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('native', 'alien', 'unknown')),
          status_source TEXT,
          comments TEXT,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (region_id) REFERENCES miren_regions(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mstatus_taxon ON miren_region_status(region_id, taxon_id, IFNULL(verbatim_identification, ''));`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          region_id INTEGER NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('road', 'trail')),
          code TEXT NOT NULL CHECK (length(code) = 2),
          name TEXT,
          traffic_intensity INTEGER CHECK (traffic_intensity IS NULL OR traffic_intensity BETWEEN 1 AND 3),
          road_open_months INTEGER CHECK (road_open_months IS NULL OR road_open_months BETWEEN 0 AND 12),
          road_type TEXT,
          length_m REAL,
          category TEXT CHECK (category IS NULL OR category IN ('formal', 'informal')),
          substrate TEXT,
          activities TEXT,
          history TEXT,
          width_m REAL,
          track_geojson TEXT,
          focal_points_geojson TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (region_id) REFERENCES miren_regions(id) ON DELETE CASCADE,
          UNIQUE (region_id, kind, code)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_sites (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          route_id INTEGER NOT NULL,
          site_no INTEGER NOT NULL CHECK (site_no BETWEEN 1 AND 99),
          suffix TEXT NOT NULL DEFAULT '' CHECK (suffix IN ('', 'a')),
          planned_lat REAL,
          planned_lon REAL,
          planned_elev REAL,
          side TEXT CHECK (side IS NULL OR side IN ('left', 'right')),
          marker_note TEXT,
          photo_point TEXT,
          road_clearance_m REAL,
          clearance_checked_at INTEGER,
          mountain_zone TEXT CHECK (mountain_zone IS NULL OR mountain_zone IN ('lowland', 'montane', 'alpine', 'nival')),
          verge_width_m REAL,
          herbivores TEXT,
          dist_trailhead_along_m REAL,
          dist_trailhead_direct_m REAL,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (route_id) REFERENCES miren_routes(id) ON DELETE CASCADE,
          UNIQUE (route_id, site_no, suffix)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_surveys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          route_id INTEGER NOT NULL,
          year INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
          start_ts INTEGER NOT NULL,
          stop_ts INTEGER,
          recorded_by TEXT,
          prev_survey_id INTEGER,
          project_id INTEGER NOT NULL DEFAULT 0,
          site_id INTEGER,
          literature TEXT,
          notes TEXT,
          starred INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (route_id) REFERENCES miren_routes(id),
          FOREIGN KEY (prev_survey_id) REFERENCES miren_surveys(id) ON DELETE SET NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id),
          UNIQUE (route_id, year)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_msurv_start ON miren_surveys(start_ts DESC);`);
      db.executeSync(
        `CREATE INDEX IF NOT EXISTS idx_msurv_active ON miren_surveys(status) WHERE status = 'active';`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_plots (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          site_id INTEGER NOT NULL,
          plot_no INTEGER NOT NULL CHECK (plot_no BETWEEN 1 AND 4),
          visit INTEGER NOT NULL DEFAULT 1 CHECK (visit BETWEEN 1 AND 3),
          sampled INTEGER NOT NULL DEFAULT 1 CHECK (sampled IN (0, 1)),
          not_sampled_reason TEXT,
          lat REAL,
          lon REAL,
          elev REAL,
          date TEXT CHECK (date IS NULL OR date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
          observers TEXT,
          start_ts INTEGER,
          stop_ts INTEGER,
          tree_cover_pct REAL CHECK (tree_cover_pct IS NULL OR (tree_cover_pct >= 0 AND tree_cover_pct <= 100)),
          bare_ground_pct REAL CHECK (bare_ground_pct IS NULL OR (bare_ground_pct >= 0 AND bare_ground_pct <= 100)),
          litter_pct REAL CHECK (litter_pct IS NULL OR (litter_pct >= 0 AND litter_pct <= 100)),
          additional_data TEXT CHECK (additional_data IS NULL OR length(additional_data) <= 50),
          protected_area INTEGER CHECK (protected_area IS NULL OR protected_area IN (0, 1)),
          literature TEXT,
          habitat TEXT CHECK (habitat IS NULL OR habitat IN ('forb-grass', 'shrubland', 'open-forest', 'closed-forest', 'bare-rock', 'riparian-wetland')),
          disturbance_type TEXT CHECK (disturbance_type IS NULL OR disturbance_type IN ('none', 'human', 'animal', 'environmental')),
          disturbance_intensity INTEGER CHECK (disturbance_intensity IS NULL OR disturbance_intensity BETWEEN 0 AND 2),
          cls_bare_ground INTEGER CHECK (cls_bare_ground IS NULL OR cls_bare_ground BETWEEN 0 AND 8),
          cls_bare_rock INTEGER CHECK (cls_bare_rock IS NULL OR cls_bare_rock BETWEEN 0 AND 8),
          cls_vegetation INTEGER CHECK (cls_vegetation IS NULL OR cls_vegetation BETWEEN 0 AND 8),
          cls_canopy INTEGER CHECK (cls_canopy IS NULL OR cls_canopy BETWEEN 0 AND 8),
          cls_shrub INTEGER CHECK (cls_shrub IS NULL OR cls_shrub BETWEEN 0 AND 8),
          cls_herb INTEGER CHECK (cls_herb IS NULL OR cls_herb BETWEEN 0 AND 8),
          riparian INTEGER CHECK (riparian IS NULL OR riparian IN (0, 1)),
          fenced INTEGER CHECK (fenced IS NULL OR fenced IN (0, 1)),
          herbivore_rating INTEGER CHECK (herbivore_rating IS NULL OR herbivore_rating BETWEEN 0 AND 8),
          herbivore_type TEXT CHECK (herbivore_type IS NULL OR herbivore_type IN ('i', 'v', 'b')),
          trampling_rating INTEGER CHECK (trampling_rating IS NULL OR trampling_rating BETWEEN 0 AND 8),
          trampling_type TEXT,
          comments TEXT,
          blind_closed_at INTEGER,
          compared_at INTEGER,
          photo_paths TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES miren_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (site_id) REFERENCES miren_sites(id),
          UNIQUE (survey_id, site_id, plot_no, visit)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_taxa (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          survey_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          used_name_id INTEGER,
          used_scientific_name TEXT,
          verbatim_identification TEXT,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES miren_surveys(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_mtaxa_taxon ON miren_taxa(taxon_id);`);
      db.executeSync(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mtaxa_label ON miren_taxa(survey_id, taxon_id, IFNULL(verbatim_identification, ''));`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_plot_species (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          plot_id INTEGER NOT NULL,
          miren_taxon_id INTEGER NOT NULL,
          occurrence_id TEXT NOT NULL UNIQUE,
          cover_class INTEGER CHECK (cover_class IS NULL OR cover_class BETWEEN 0 AND 8),
          abundance_class INTEGER CHECK (abundance_class IS NULL OR abundance_class BETWEEN 0 AND 3),
          presence INTEGER CHECK (presence IS NULL OR presence IN (0, 1)),
          phase TEXT NOT NULL DEFAULT 'blind' CHECK (phase IN ('blind', 'recheck')),
          note TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (plot_id) REFERENCES miren_plots(id) ON DELETE CASCADE,
          FOREIGN KEY (miren_taxon_id) REFERENCES miren_taxa(id) ON DELETE CASCADE,
          UNIQUE (plot_id, miren_taxon_id)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_mps_taxon ON miren_plot_species(miren_taxon_id);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS miren_rechecks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          plot_id INTEGER NOT NULL,
          prev_taxon_id TEXT NOT NULL,
          prev_verbatim_identification TEXT,
          outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'reidentified')),
          new_miren_taxon_id INTEGER,
          checked_at INTEGER NOT NULL,
          FOREIGN KEY (plot_id) REFERENCES miren_plots(id) ON DELETE CASCADE,
          FOREIGN KEY (new_miren_taxon_id) REFERENCES miren_taxa(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_mrecheck_taxon ON miren_rechecks(plot_id, prev_taxon_id, IFNULL(prev_verbatim_identification, ''));`,
      );
    },
  },
  {
    // Scans of the paper GLORIA forms kept with the survey (model/formScans):
    // Form 1, Form 2 (1-m² quadrat), Form 3 (SAS), Form 6-S (10 × 10 m). Each
    // is a JSON FileRef[] like gloria_logger_visits.form4_files — files in
    // Documents/files/ or photo-library references; not merged, like all media.
    version: 69,
    up: (db) => {
      for (const c of ['form1_files', 'form2_files', 'form3_files', 'form6s_files'])
        addColumnIfMissing(db, `ALTER TABLE gloria_surveys ADD COLUMN ${c} TEXT;`);
    },
  },
  {
    // Team sync log: what this device sent, skipped, merged, imported or
    // failed, per record — so "did it upload, and where?" has an answer
    // (settings → 隊伍同步 → 同步紀錄). `label` is the record's name at the
    // time, readable after the record is deleted; `server` is the relay it
    // went to. Kept on this device only (not exported, backed up with
    // user.db), trimmed at start-up (db/cleanup) and with the team.
    version: 70,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          team_id TEXT NOT NULL,
          record_kind TEXT,
          record_uuid TEXT,
          label TEXT,
          action TEXT NOT NULL CHECK (action IN ('upload', 'skip', 'merge', 'import', 'link', 'queued', 'fail')),
          server TEXT,
          bytes INTEGER,
          detail TEXT,
          at INTEGER NOT NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_sync_log_team ON sync_log(team_id, at);`);
    },
  },
  {
    // Short names for relays (settings → 隊伍同步 → 伺服器): shown instead of
    // the long workers.dev address wherever a server is named. Any URL,
    // the built-in default included (it is not in sync_servers). This device
    // only; the invitation still carries the full URL.
    version: 71,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS sync_server_alias (
          url TEXT PRIMARY KEY,
          alias TEXT NOT NULL
        );
      `);
    },
  },
  {
    // File sync (docs/planned/Media_sync.md phase 2). `media_hash` caches the
    // SHA-256 of files this device sent or received, by the reference stored
    // in the record (so a photo is hashed once, and a received file is
    // recognised as already here). `media_pending` holds files a teammate's
    // record refers to that could not be fetched yet (no signal); every sync
    // of the record tries them again. Both are device-local.
    version: 72,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS media_hash (
          uri TEXT PRIMARY KEY,
          size INTEGER,
          sha TEXT NOT NULL,
          at INTEGER NOT NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_media_hash_sha ON media_hash(sha);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS media_pending (
          team_id TEXT NOT NULL,
          record_kind TEXT NOT NULL,
          record_uuid TEXT NOT NULL,
          entry_key TEXT NOT NULL,
          entry TEXT NOT NULL,
          at INTEGER NOT NULL,
          PRIMARY KEY (team_id, record_kind, record_uuid, entry_key)
        );
      `);
    },
  },
  {
    // Record versions (plan 2026-09-28): whole snapshots of a checklist, plot
    // survey or GLORIA survey — the local document team merge compares —
    // deflated and base64-encoded in `doc`. Taken when a record is finished,
    // around merges and imports, before a restore, on leaving its screen
    // (consecutive leaves within 30 min update one row: `updated_at`) and by
    // hand (`note`). `label` keeps the record's name for after a deletion;
    // `deleted_at` is set when the record is gone and the versions are kept
    // 30 days for recovery (db/cleanup). Device-local: not synced or exported;
    // backups carry them with user.db. Media are referenced, not copied.
    version: 73,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS record_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'plot', 'gloria')),
          record_uuid TEXT NOT NULL,
          label TEXT,
          reason TEXT NOT NULL CHECK (reason IN ('done', 'leave', 'before_merge', 'after_merge', 'before_restore', 'before_import', 'manual')),
          note TEXT,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          doc TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_record_versions ON record_versions(record_kind, record_uuid, created_at);`);
    },
  },
  {
    // v74: record_versions.reason gains 'before_delete' — a record is
    // snapshotted as it is deleted, so one never opened since v73 can still
    // be recovered. SQLite cannot ALTER a CHECK: rename + create + copy + drop
    // (inside the runner's per-migration transaction).
    version: 74,
    up: (db) => {
      db.executeSync(`ALTER TABLE record_versions RENAME TO record_versions_v73;`);
      db.executeSync(`
        CREATE TABLE record_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'plot', 'gloria')),
          record_uuid TEXT NOT NULL,
          label TEXT,
          reason TEXT NOT NULL CHECK (reason IN ('done', 'leave', 'before_merge', 'after_merge', 'before_restore', 'before_import', 'before_delete', 'manual')),
          note TEXT,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          doc TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
      `);
      db.executeSync(`
        INSERT INTO record_versions (id, record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at)
        SELECT id, record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at FROM record_versions_v73;
      `);
      db.executeSync(`DROP TABLE record_versions_v73;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_record_versions ON record_versions(record_kind, record_uuid, created_at);`);
    },
  },
  {
    // v75: CHECK the status / plot_type of sessions, plot_surveys and
    // collection_trips, as GLORIA and MIREN already do (data-model audit A4).
    // Out-of-range values are normalised first so the copy cannot fail.
    version: 75,
    up: (db) => {
      db.executeSync(`UPDATE sessions SET status = CASE WHEN ended_at IS NULL THEN 'active' ELSE 'done' END WHERE status NOT IN ('active', 'done');`);
      db.executeSync(`UPDATE plot_surveys SET status = CASE WHEN stop_ts IS NULL THEN 'active' ELSE 'done' END WHERE status NOT IN ('active', 'done');`);
      db.executeSync(`UPDATE plot_surveys SET plot_type = 'fixed' WHERE plot_type NOT IN ('fixed', 'transect', 'point_count');`);
      db.executeSync(`UPDATE collection_trips SET status = CASE WHEN ended_at IS NULL THEN 'active' ELSE 'done' END WHERE status NOT IN ('active', 'done');`);
      addTableChecks(db, 'sessions', [`status IN ('active', 'done')`]);
      addTableChecks(db, 'plot_surveys', [`status IN ('active', 'done')`, `plot_type IN ('fixed', 'transect', 'point_count')`]);
      addTableChecks(db, 'collection_trips', [`status IN ('active', 'done')`]);
    },
  },
  {
    // v76: duplicate sheets are at least 1 (user decision, 2026-09-29). The
    // v43 NULL ("not recorded") is folded into 1; from here every write goes
    // through `duplicateCountOf`. No CHECK: that would mean rebuilding the
    // table, and the helper already refuses anything below 1.
    version: 76,
    up: (db) => {
      db.executeSync(
        `UPDATE collection_specimens SET duplicate_count = 1 WHERE duplicate_count IS NULL OR duplicate_count < 1;`,
      );
    },
  },
  {
    // v77: 1×1 m quadrats in a fixed plot (docs/planned/ui-redesign/06-plot-quadrats.md §2).
    // Their own tables, not plot_species_records: a quadrat species has a cover
    // and a frequency mask, not a layer, and the layer CHECK and every existing
    // export stay as they are. Masks follow src/lib/grid.ts: '0'/'1' per cell,
    // idx = row * grid_n + col, row 0 = the top edge; NULL = frequency not done.
    // grid_n is chosen per quadrat, 2–10 (user decision, 2026-09-29).
    // plot_surveys.quadrat_config holds the module's settings as JSON only.
    version: 77,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS plot_quadrats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          plot_survey_id INTEGER NOT NULL,
          subplot_id INTEGER,
          idx INTEGER NOT NULL,
          label TEXT NOT NULL,
          position TEXT,
          size_m REAL NOT NULL DEFAULT 1 CHECK (size_m > 0),
          grid_n INTEGER NOT NULL DEFAULT 10 CHECK (grid_n BETWEEN 2 AND 10),
          top_edge TEXT NOT NULL DEFAULT 'N' CHECK (top_edge IN ('N', 'E', 'S', 'W', 'upslope')),
          lat REAL,
          lng REAL,
          accuracy REAL,
          cov_vascular REAL,
          cov_solid_rock REAL,
          cov_scree REAL,
          cov_lichens REAL,
          cov_bryophytes REAL,
          cov_bare_ground REAL,
          cov_litter REAL,
          freq_mode TEXT NOT NULL DEFAULT 'cells' CHECK (freq_mode IN ('cells', 'count')),
          locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
          started_at INTEGER,
          ended_at INTEGER,
          notes TEXT,
          photo_paths TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (plot_survey_id) REFERENCES plot_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (subplot_id) REFERENCES plot_subplots(id) ON DELETE SET NULL,
          UNIQUE (plot_survey_id, idx)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_plot_quadrats_plot ON plot_quadrats(plot_survey_id);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS plot_quadrat_species (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          quadrat_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          cover_pct REAL CHECK (cover_pct IS NULL OR (cover_pct > 0 AND cover_pct <= 100)),
          freq_cells TEXT,
          freq_count INTEGER CHECK (freq_count IS NULL OR freq_count >= 0),
          height_cm REAL,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (quadrat_id) REFERENCES plot_quadrats(id) ON DELETE CASCADE,
          UNIQUE (quadrat_id, taxon_id)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_plot_quadrat_species_quadrat ON plot_quadrat_species(quadrat_id);`);
      addColumnIfMissing(db, `ALTER TABLE plot_surveys ADD COLUMN quadrat_config TEXT;`);
    },
  },
  {
    // v78: frequency over the whole plot (user decision 2026-09-29): the plot
    // itself is the one grid, and each plot species record (taxon + layer)
    // gets a mask or a count, as a GLORIA quadrat species does. Same meaning
    // as plot_quadrat_species.freq_cells / freq_count. The grid, its top edge
    // and the method are plot settings in quadrat_config (freqEnabled,
    // freqGridN, freqTopEdge, freqMode). Every quadrat of a plot shares one
    // grid too (same decision), enforced in quadratsCore.
    version: 78,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN freq_cells TEXT;`);
      addColumnIfMissing(db, `ALTER TABLE plot_species_records ADD COLUMN freq_count INTEGER;`);
    },
  },
  {
    // v79: the altitude a photo stated (GPSAltitude, metres), cached with its
    // position so 「用照片的 GNSS 定位」 later also restores the elevation.
    version: 79,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE photo_fix ADD COLUMN altitude REAL;`);
    },
  },
  {
    // v80: the modular survey framework, tree census first
    // (docs/planned/Modular_survey.md §5; docs/ForestGEO/Stem_mapping.md).
    // Only the tables the individual style needs; the plot-style ones come
    // with Phase 2. Columns inside a UNIQUE key are NOT NULL (an `idx` that
    // could be NULL would let duplicates through). record_versions gains the
    // kind 'survey_quadrat': a census is versioned per 20 m quadrat.
    version: 80,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_frames (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          code TEXT NOT NULL UNIQUE,
          name TEXT,
          project_id INTEGER NOT NULL DEFAULT 0,
          site_id INTEGER,
          size_x_m REAL NOT NULL CHECK (size_x_m > 0),
          size_y_m REAL NOT NULL CHECK (size_y_m > 0),
          quadrat_m REAL NOT NULL DEFAULT 20 CHECK (quadrat_m > 0),
          subquadrat_m REAL NOT NULL DEFAULT 5 CHECK (subquadrat_m > 0),
          tag_block_quadrats INTEGER NOT NULL DEFAULT 5 CHECK (tag_block_quadrats >= 1),
          tag_block_size INTEGER NOT NULL DEFAULT 10000 CHECK (tag_block_size >= 1),
          origin_lat REAL CHECK (origin_lat IS NULL OR origin_lat BETWEEN -90 AND 90),
          origin_lng REAL CHECK (origin_lng IS NULL OR origin_lng BETWEEN -180 AND 180),
          origin_accuracy_m REAL CHECK (origin_accuracy_m IS NULL OR origin_accuracy_m >= 0),
          origin_datum TEXT NOT NULL DEFAULT 'WGS84',
          bearing_deg REAL NOT NULL DEFAULT 0 CHECK (bearing_deg >= 0 AND bearing_deg < 360),
          bearing_ref TEXT NOT NULL DEFAULT 'true' CHECK (bearing_ref IN ('true', 'magnetic')),
          declination_deg REAL NOT NULL DEFAULT 0 CHECK (declination_deg BETWEEN -90 AND 90),
          dbh_min_cm REAL NOT NULL DEFAULT 1 CHECK (dbh_min_cm IN (1, 5)),
          extreme_pct REAL NOT NULL DEFAULT 0.05 CHECK (extreme_pct > 0 AND extreme_pct <= 0.5),
          extreme_min INTEGER NOT NULL DEFAULT 3 CHECK (extreme_min >= 1),
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (project_id) REFERENCES projects(id)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_frame_series (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          frame_id INTEGER NOT NULL,
          template_id TEXT NOT NULL,
          series_code TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (frame_id) REFERENCES fw_frames(id) ON DELETE CASCADE,
          UNIQUE (frame_id, template_id),
          UNIQUE (frame_id, series_code)
        );
      `);
      // A frame that has surveys cannot be deleted: frame_id is NO ACTION.
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_surveys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          frame_id INTEGER NOT NULL,
          series_id INTEGER NOT NULL,
          census_no INTEGER NOT NULL CHECK (census_no >= 1),
          template_id TEXT NOT NULL,
          template_version INTEGER NOT NULL CHECK (template_version >= 1),
          template_snapshot TEXT NOT NULL,
          template_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
          start_ts INTEGER NOT NULL,
          stop_ts INTEGER,
          investigators TEXT,
          notes TEXT,
          project_id INTEGER NOT NULL DEFAULT 0,
          site_id INTEGER,
          sync_block_quadrats INTEGER CHECK (sync_block_quadrats IS NULL OR sync_block_quadrats >= 1),
          lat REAL,
          lng REAL,
          accuracy REAL,
          starred INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (frame_id) REFERENCES fw_frames(id),
          FOREIGN KEY (series_id) REFERENCES fw_frame_series(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          UNIQUE (series_id, census_no)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwsurv_frame ON fw_surveys(frame_id, census_no);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwsurv_start ON fw_surveys(start_ts DESC);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_survey_quadrats (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          quadrat_code TEXT NOT NULL CHECK (length(quadrat_code) = 4),
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'done')),
          started_at INTEGER,
          ended_at INTEGER,
          recorded_by TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          UNIQUE (survey_id, quadrat_code)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_individuals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          frame_id INTEGER NOT NULL,
          tag TEXT NOT NULL CHECK (length(trim(tag)) > 0),
          taxon_id TEXT NOT NULL,
          used_name_id TEXT,
          used_scientific_name TEXT,
          verbatim_identification TEXT,
          x_m REAL NOT NULL,
          y_m REAL NOT NULL,
          quadrat_code TEXT NOT NULL CHECK (length(quadrat_code) = 4),
          coord_method TEXT NOT NULL CHECK (coord_method IN ('grid', 'xy', 'polar', 'gps')),
          local_x_m REAL,
          local_y_m REAL,
          ref_kind TEXT CHECK (ref_kind IS NULL OR ref_kind IN ('stake', 'tree')),
          ref_code TEXT,
          distance_m REAL CHECK (distance_m IS NULL OR distance_m >= 0),
          azimuth_deg REAL CHECK (azimuth_deg IS NULL OR (azimuth_deg >= 0 AND azimuth_deg < 360)),
          azimuth_ref TEXT CHECK (azimuth_ref IS NULL OR azimuth_ref IN ('magnetic', 'true')),
          slope_deg REAL CHECK (slope_deg IS NULL OR (slope_deg >= 0 AND slope_deg < 90)),
          lat REAL,
          lng REAL,
          accuracy REAL,
          first_survey_id INTEGER,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (frame_id) REFERENCES fw_frames(id) ON DELETE CASCADE,
          FOREIGN KEY (first_survey_id) REFERENCES fw_surveys(id) ON DELETE SET NULL,
          UNIQUE (frame_id, tag)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwind_quadrat ON fw_individuals(frame_id, quadrat_code);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_individual_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          individual_id INTEGER NOT NULL,
          survey_id INTEGER,
          field TEXT NOT NULL CHECK (field IN ('taxon', 'position', 'tag')),
          old_value TEXT,
          new_value TEXT,
          reason TEXT,
          by TEXT,
          at INTEGER NOT NULL,
          FOREIGN KEY (individual_id) REFERENCES fw_individuals(id) ON DELETE CASCADE,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwhist_ind ON fw_individual_history(individual_id, at);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_stems (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          individual_id INTEGER NOT NULL,
          stem_no INTEGER NOT NULL CHECK (stem_no >= 1),
          first_survey_id INTEGER,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (individual_id) REFERENCES fw_individuals(id) ON DELETE CASCADE,
          FOREIGN KEY (first_survey_id) REFERENCES fw_surveys(id) ON DELETE SET NULL,
          UNIQUE (individual_id, stem_no)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_stem_measures (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          stem_id INTEGER NOT NULL,
          dbh_cm REAL CHECK (dbh_cm IS NULL OR dbh_cm >= 0),
          pom_m REAL NOT NULL DEFAULT 1.3 CHECK (pom_m >= 0),
          pom_seq INTEGER NOT NULL DEFAULT 1 CHECK (pom_seq >= 1),
          is_main INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
          stem_dead INTEGER NOT NULL DEFAULT 0 CHECK (stem_dead IN (0, 1)),
          pending TEXT CHECK (pending IS NULL OR pending = 'big_tree'),
          measured_at INTEGER,
          recorded_by TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (stem_id) REFERENCES fw_stems(id) ON DELETE CASCADE,
          UNIQUE (survey_id, stem_id)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwmeas_stem ON fw_stem_measures(stem_id);`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_stem_values (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          measure_id INTEGER NOT NULL,
          component TEXT NOT NULL,
          field TEXT NOT NULL,
          idx INTEGER NOT NULL DEFAULT 0,
          value_num REAL,
          value_text TEXT,
          unit TEXT,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (measure_id) REFERENCES fw_stem_measures(id) ON DELETE CASCADE,
          UNIQUE (measure_id, component, field, idx)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_individual_values (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          individual_id INTEGER NOT NULL,
          component TEXT NOT NULL,
          field TEXT NOT NULL,
          idx INTEGER NOT NULL DEFAULT 0,
          value_num REAL,
          value_text TEXT,
          unit TEXT,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (individual_id) REFERENCES fw_individuals(id) ON DELETE CASCADE,
          UNIQUE (survey_id, individual_id, component, field, idx)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwival_ind ON fw_individual_values(individual_id);`);
      // Photos are always taken in a census; the tree / stem they show is optional.
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_media (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          individual_id INTEGER,
          measure_id INTEGER,
          component TEXT NOT NULL,
          kind TEXT NOT NULL CHECK (kind IN ('photo', 'audio')),
          uri TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (individual_id) REFERENCES fw_individuals(id) ON DELETE CASCADE,
          FOREIGN KEY (measure_id) REFERENCES fw_stem_measures(id) ON DELETE CASCADE
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwmedia_owner ON fw_media(survey_id, individual_id);`);

      // record_versions: + 'survey_quadrat'. Same rebuild as v74 (nothing
      // references record_versions).
      db.executeSync(`ALTER TABLE record_versions RENAME TO record_versions_v79;`);
      db.executeSync(`
        CREATE TABLE record_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'plot', 'gloria', 'survey_quadrat')),
          record_uuid TEXT NOT NULL,
          label TEXT,
          reason TEXT NOT NULL CHECK (reason IN ('done', 'leave', 'before_merge', 'after_merge', 'before_restore', 'before_import', 'before_delete', 'manual')),
          note TEXT,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          doc TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
      `);
      db.executeSync(`
        INSERT INTO record_versions (id, record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at)
        SELECT id, record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at FROM record_versions_v79;
      `);
      db.executeSync(`DROP TABLE record_versions_v79;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_record_versions ON record_versions(record_kind, record_uuid, created_at);`);
    },
  },
  {
    // record_versions: + 'survey', a whole census kept when it is deleted (its
    // header and quadrat list; the quadrats keep 'survey_quadrat' versions),
    // so a deleted census can be recovered for 30 days (decided 2026-10-01).
    // Same rebuild as v74 / v80.
    version: 81,
    up: (db) => {
      db.executeSync(`ALTER TABLE record_versions RENAME TO record_versions_v80;`);
      db.executeSync(`
        CREATE TABLE record_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'plot', 'gloria', 'survey_quadrat', 'survey')),
          record_uuid TEXT NOT NULL,
          label TEXT,
          reason TEXT NOT NULL CHECK (reason IN ('done', 'leave', 'before_merge', 'after_merge', 'before_restore', 'before_import', 'before_delete', 'manual')),
          note TEXT,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          doc TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        );
      `);
      db.executeSync(`
        INSERT INTO record_versions (id, record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at)
        SELECT id, record_kind, record_uuid, label, reason, note, content_hash, size, doc, created_at, updated_at, deleted_at FROM record_versions_v80;
      `);
      db.executeSync(`DROP TABLE record_versions_v80;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_record_versions ON record_versions(record_kind, record_uuid, created_at);`);
    },
  },
  {
    // fw_individual_history: + field 'merge' — two trees found to be one in a
    // team merge (Modular_survey.md §9, 1C-b, decided 2026-10-01). The row sits
    // on the tree kept; old_value / new_value hold {uuid, tag} of the tree
    // folded in and the one kept. It travels with the sync block, so a
    // teammate's phone folds the same two trees without asking again.
    // No table points at this one, so renaming the old table first is safe.
    version: 82,
    up: (db) => {
      db.executeSync(`ALTER TABLE fw_individual_history RENAME TO fw_individual_history_v81;`);
      db.executeSync(`
        CREATE TABLE fw_individual_history (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          individual_id INTEGER NOT NULL,
          survey_id INTEGER,
          field TEXT NOT NULL CHECK (field IN ('taxon', 'position', 'tag', 'merge')),
          old_value TEXT,
          new_value TEXT,
          reason TEXT,
          by TEXT,
          at INTEGER NOT NULL,
          FOREIGN KEY (individual_id) REFERENCES fw_individuals(id) ON DELETE CASCADE,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(`
        INSERT INTO fw_individual_history (id, uuid, individual_id, survey_id, field, old_value, new_value, reason, by, at)
        SELECT id, uuid, individual_id, survey_id, field, old_value, new_value, reason, by, at FROM fw_individual_history_v81;
      `);
      db.executeSync(`DROP TABLE fw_individual_history_v81;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwhist_ind ON fw_individual_history(individual_id, at);`);
    },
  },
  {
    // v83: the checklist and plot styles (Modular_survey.md §5.2, Phase 2A).
    //
    // fw_surveys is rebuilt so a survey may have no permanent plot (decided
    // 2026-10-02): frame_id, series_id and census_no become nullable, held
    // together by CHECKs, and a tree census (style 'individual') must still
    // have all three. `style` is a column (copied from the template snapshot
    // at creation) so the CHECK and the census queries can see it; every row
    // before v83 is a tree census, the only template v80–v82 could start.
    // `blind_closed_at`: when a recheck's blind phase ended (§5.5).
    // Seven tables point at fw_surveys, so the rebuild renames the new table,
    // never the old one (replaceTable).
    //
    // New tables: user templates (built-ins stay in code), a frame's unit
    // layout and morphospecies list, a survey's units and occurrences, and
    // one values table per owner with a real foreign key (§5.1). Occurrence
    // columns are plot_species_records' names, so Phase 3 copies rows across;
    // left out: bb_value / percent / dbh_values_json (organism_quantity
    // replaced them), photo_paths / audio_paths (fw_media), inat_* (added
    // with iNaturalist upload). A deleted unit's occurrences and sub-units
    // stay (SET NULL), as plot_species_records / plot_quadrats do with a
    // deleted subplot; its photos and values go with it.
    version: 83,
    up: (db) => {
      replaceTable(
        db,
        'fw_surveys',
        `CREATE TABLE fw_surveys (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          style TEXT NOT NULL CHECK (style IN ('checklist', 'plot', 'individual')),
          frame_id INTEGER,
          series_id INTEGER,
          census_no INTEGER CHECK (census_no IS NULL OR census_no >= 1),
          template_id TEXT NOT NULL,
          template_version INTEGER NOT NULL CHECK (template_version >= 1),
          template_snapshot TEXT NOT NULL,
          template_hash TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'done')),
          start_ts INTEGER NOT NULL,
          stop_ts INTEGER,
          blind_closed_at INTEGER,
          investigators TEXT,
          notes TEXT,
          project_id INTEGER NOT NULL DEFAULT 0,
          site_id INTEGER,
          sync_block_quadrats INTEGER CHECK (sync_block_quadrats IS NULL OR sync_block_quadrats >= 1),
          lat REAL,
          lng REAL,
          accuracy REAL,
          starred INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (frame_id) REFERENCES fw_frames(id),
          FOREIGN KEY (series_id) REFERENCES fw_frame_series(id),
          FOREIGN KEY (project_id) REFERENCES projects(id),
          UNIQUE (series_id, census_no),
          CHECK ((frame_id IS NULL) = (series_id IS NULL)),
          CHECK ((series_id IS NULL) = (census_no IS NULL)),
          CHECK (style <> 'individual' OR frame_id IS NOT NULL)
        )`,
        { style: `'individual'` },
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS survey_templates (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          template_id TEXT NOT NULL,
          version INTEGER NOT NULL CHECK (version >= 1),
          origin TEXT NOT NULL CHECK (origin IN ('user', 'imported')),
          doc TEXT NOT NULL,
          hash TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          UNIQUE (template_id, version)
        );
      `);
      // Codes are unique per level within a frame, as subplots and quadrats
      // are per plot today (plot_subplots, plot_quadrats).
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_frame_units (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          frame_id INTEGER NOT NULL,
          parent_id INTEGER,
          level_key TEXT NOT NULL CHECK (length(trim(level_key)) > 0),
          code TEXT NOT NULL CHECK (length(trim(code)) > 0),
          label TEXT,
          shape TEXT NOT NULL CHECK (shape IN ('rect', 'circle', 'line', 'point')),
          x_m REAL,
          y_m REAL,
          width_m REAL CHECK (width_m IS NULL OR width_m > 0),
          length_m REAL CHECK (length_m IS NULL OR length_m > 0),
          radius_m REAL CHECK (radius_m IS NULL OR radius_m > 0),
          geometry_geojson TEXT,
          retired_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (frame_id) REFERENCES fw_frames(id) ON DELETE CASCADE,
          FOREIGN KEY (parent_id) REFERENCES fw_frame_units(id) ON DELETE SET NULL,
          UNIQUE (frame_id, level_key, code)
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_frame_labels (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          frame_id INTEGER NOT NULL,
          taxon_id TEXT NOT NULL,
          verbatim_identification TEXT NOT NULL CHECK (length(trim(verbatim_identification)) > 0),
          note TEXT,
          photo_uri TEXT,
          first_survey_id INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (frame_id) REFERENCES fw_frames(id) ON DELETE CASCADE,
          FOREIGN KEY (first_survey_id) REFERENCES fw_surveys(id) ON DELETE SET NULL,
          UNIQUE (frame_id, taxon_id, verbatim_identification)
        );
      `);
      // frame_unit_id is NO ACTION: a frame unit a survey used cannot be deleted, only retired.
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_units (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          frame_unit_id INTEGER,
          parent_id INTEGER,
          level_key TEXT NOT NULL CHECK (length(trim(level_key)) > 0),
          code TEXT NOT NULL CHECK (length(trim(code)) > 0),
          label TEXT,
          sort INTEGER NOT NULL DEFAULT 0,
          lat REAL,
          lng REAL,
          accuracy REAL,
          geometry_geojson TEXT,
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (frame_unit_id) REFERENCES fw_frame_units(id),
          FOREIGN KEY (parent_id) REFERENCES fw_units(id) ON DELETE SET NULL,
          UNIQUE (survey_id, level_key, code),
          UNIQUE (survey_id, frame_unit_id)
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwunit_frame_unit ON fw_units(frame_unit_id) WHERE frame_unit_id IS NOT NULL;`);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_occurrences (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          unit_id INTEGER,
          taxon_id TEXT NOT NULL,
          used_name_id INTEGER,
          used_scientific_name TEXT,
          verbatim_identification TEXT,
          layer TEXT,
          organism_quantity TEXT,
          organism_quantity_type TEXT,
          freq_cells TEXT,
          freq_count INTEGER CHECK (freq_count IS NULL OR freq_count >= 0),
          sex TEXT,
          life_stage TEXT,
          reproductive_condition TEXT,
          leaf_phenology TEXT,
          degree_of_establishment TEXT,
          detection_type TEXT,
          observed_at INTEGER NOT NULL,
          recorded_by TEXT,
          identified_by TEXT,
          lat REAL,
          lng REAL,
          accuracy REAL,
          elevation_m REAL,
          elevation_source TEXT,
          phase TEXT CHECK (phase IS NULL OR phase IN ('blind', 'recheck')),
          notes TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (unit_id) REFERENCES fw_units(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwocc_survey ON fw_occurrences(survey_id, unit_id);`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwocc_unit ON fw_occurrences(unit_id) WHERE unit_id IS NOT NULL;`);
      for (const [table, owner, parent] of [
        ['fw_survey_values', 'survey_id', 'fw_surveys'],
        ['fw_unit_values', 'unit_id', 'fw_units'],
        ['fw_occurrence_values', 'occurrence_id', 'fw_occurrences'],
      ] as const) {
        db.executeSync(`
          CREATE TABLE IF NOT EXISTS ${table} (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            uuid TEXT NOT NULL UNIQUE,
            ${owner} INTEGER NOT NULL,
            component TEXT NOT NULL,
            field TEXT NOT NULL,
            idx INTEGER NOT NULL DEFAULT 0,
            value_num REAL,
            value_text TEXT,
            unit TEXT,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (${owner}) REFERENCES ${parent}(id) ON DELETE CASCADE,
            UNIQUE (${owner}, component, field, idx)
          );
        `);
      }
      addColumnIfMissing(db, `ALTER TABLE fw_media ADD COLUMN unit_id INTEGER REFERENCES fw_units(id) ON DELETE CASCADE;`);
      addColumnIfMissing(db, `ALTER TABLE fw_media ADD COLUMN occurrence_id INTEGER REFERENCES fw_occurrences(id) ON DELETE CASCADE;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwmedia_unit ON fw_media(unit_id) WHERE unit_id IS NOT NULL;`);
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwmedia_occ ON fw_media(occurrence_id) WHERE occurrence_id IS NOT NULL;`);
    },
  },
  {
    // v84: the checklist / plot-style screens (Phase 2C-a, decided 2026-10-03).
    //
    // `fw_surveys.name`: what the records list, the title and the eventID of a
    // checklist / plot-style survey show. A census keeps NULL (its name is the
    // frame code and census number). Rows from v83 get the frame code, or the
    // start time as a checklist session is named.
    //
    // `fw_rechecks`: the answer for each taxon the previous survey of a
    // permanent plot had in a unit and this survey's blind list has not, as in
    // MIREN (miren_rechecks): found, not found, or re-identified as an
    // occurrence of this survey. It tells "looked for, not there" from "not
    // looked for". The key is the frame unit (NULL: recorded outside any unit)
    // and the previous taxon and label; the label is '' rather than NULL so
    // the unique key holds (Modular_survey.md §5.1). `occurrence_id`: the
    // recheck occurrence a 'found' added, or the occurrence a 'reidentified'
    // names; SET NULL when that occurrence is deleted.
    version: 84,
    up: (db) => {
      addColumnIfMissing(db, `ALTER TABLE fw_surveys ADD COLUMN name TEXT;`);
      db.executeSync(
        `UPDATE fw_surveys SET name = (SELECT code FROM fw_frames WHERE fw_frames.id = fw_surveys.frame_id)
          WHERE style <> 'individual' AND name IS NULL AND frame_id IS NOT NULL`,
      );
      db.executeSync(
        `UPDATE fw_surveys SET name = strftime('%Y-%m-%d %H:%M', start_ts / 1000, 'unixepoch', 'localtime')
          WHERE style <> 'individual' AND name IS NULL`,
      );
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS fw_rechecks (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          uuid TEXT NOT NULL UNIQUE,
          survey_id INTEGER NOT NULL,
          frame_unit_id INTEGER,
          prev_taxon_id TEXT NOT NULL,
          prev_verbatim_identification TEXT NOT NULL DEFAULT '',
          outcome TEXT NOT NULL CHECK (outcome IN ('found', 'not_found', 'reidentified')),
          occurrence_id INTEGER,
          checked_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (survey_id) REFERENCES fw_surveys(id) ON DELETE CASCADE,
          FOREIGN KEY (frame_unit_id) REFERENCES fw_frame_units(id),
          FOREIGN KEY (occurrence_id) REFERENCES fw_occurrences(id) ON DELETE SET NULL
        );
      `);
      db.executeSync(
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_fwrecheck_key ON fw_rechecks(survey_id, IFNULL(frame_unit_id, 0), prev_taxon_id, prev_verbatim_identification);`,
      );
      db.executeSync(`CREATE INDEX IF NOT EXISTS idx_fwrecheck_occ ON fw_rechecks(occurrence_id) WHERE occurrence_id IS NOT NULL;`);
    },
  },
  {
    // record_versions: + 'modular', a checklist / plot-style survey kept as one
    // document (Phase 2C-b; src/survey/db/surveyDocCore.ts) — its versions,
    // and recovery for 30 days after it is deleted.
    version: 85,
    up: (db) => {
      replaceTable(
        db,
        'record_versions',
        `CREATE TABLE record_versions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_kind TEXT NOT NULL CHECK (record_kind IN ('session', 'plot', 'gloria', 'survey_quadrat', 'survey', 'modular')),
          record_uuid TEXT NOT NULL,
          label TEXT,
          reason TEXT NOT NULL CHECK (reason IN ('done', 'leave', 'before_merge', 'after_merge', 'before_restore', 'before_import', 'before_delete', 'manual')),
          note TEXT,
          content_hash TEXT NOT NULL,
          size INTEGER NOT NULL,
          doc TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          deleted_at INTEGER
        )`,
        {},
      );
    },
  },
  {
    // The template builder (Phase 2D-a). A template being edited is a draft
    // until it is saved as its next version (survey_templates); the builder
    // keeps it here so leaving a screen, or the app, loses nothing. A
    // template is archived rather than deleted: surveys keep their own copy,
    // so an archived one only stops being offered. Both device-local, not
    // synced; one row per template id. No foreign keys: built-in and sample
    // templates live in code.
    version: 86,
    up: (db) => {
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS survey_template_drafts (
          template_id TEXT PRIMARY KEY,
          base_version INTEGER,
          doc TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);
      db.executeSync(`
        CREATE TABLE IF NOT EXISTS survey_template_archive (
          template_id TEXT PRIMARY KEY,
          archived_at INTEGER NOT NULL
        );
      `);
    },
  },
];

/** Highest schema version this build knows how to produce. Backup/restore uses
 *  it to refuse a backup made by a newer app (whose schema this build can't
 *  satisfy). */
/** Column names of `table`; empty when the table does not exist. */
function columnsOf(db: DB, table: string): Set<string> {
  // PRAGMA cannot be parameterised; the table name always comes from our own
  // SQL literals in this file, never from user input.
  const res = db.executeSync(`PRAGMA table_info(${table});`);
  return new Set(((res.rows ?? []) as { name?: string }[]).map((r) => String(r.name ?? '')));
}

/**
 * Re-runnable `ALTER TABLE … ADD COLUMN`.
 *
 * Every ADD COLUMN in this file used to be bare, so replaying a migration
 * against a table that already had the column threw `duplicate column name`.
 * That is not hypothetical: the old `clearAllUserData` dropped only some
 * tables and then replayed from v1, dying at v6 on `plot_type` and leaving a
 * DB that bricked the app on next launch. The v13 / v20 / v21 comments in this
 * file already flag the same hazard for a crash mid-migration.
 *
 * Skipping when the column exists makes every migration idempotent, which is
 * what lets a half-applied schema heal itself on the next run.
 */
/**
 * Add table-level CHECK constraints to an existing table. SQLite cannot ALTER
 * a CHECK, so the table is rebuilt the way the SQLite docs prescribe for
 * tables other tables point at: CREATE the new one under a temporary name from
 * the table's own current DDL (every column added over the years kept as is),
 * copy, DROP the old, RENAME the new into place, then recreate the indexes and
 * the AUTOINCREMENT counter. Renaming the *new* table (not the old one) keeps
 * the children's `REFERENCES <table>` pointing at the right name. Needs
 * foreign_keys OFF, as the runner has it (init.ts).
 */
function addTableChecks(db: DB, table: string, checks: string[]): void {
  const ddl = tableDdl(db, table);
  const close = ddl.lastIndexOf(')');
  replaceTable(db, table, `${ddl.slice(0, close)}, ${checks.map((c) => `CHECK (${c})`).join(', ')})`, {});
}

/** The table's CREATE TABLE statement as SQLite keeps it. */
function tableDdl(db: DB, table: string): string {
  const ddl = String((db.executeSync(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]).rows?.[0] as { sql?: unknown } | undefined)?.sql ?? '');
  if (!ddl) throw new Error(`rebuild: no table ${table}`);
  return ddl;
}

/**
 * Replace `table` by a new definition, in the order addTableChecks describes:
 * `createSql` (a CREATE TABLE under the table's own name) is created under a
 * temporary name, the rows copied, the old table dropped, the new one renamed
 * into place, its indexes and AUTOINCREMENT counter restored. Columns in both
 * are copied as they are; `fill` gives each new column's value as SQL over
 * the old row. The old table's indexes are recreated as they were.
 */
function replaceTable(db: DB, table: string, createSql: string, fill: Readonly<Record<string, string>>): void {
  const indexes = (db.executeSync(`SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`, [table]).rows ?? []).map((r) =>
    String((r as { sql: unknown }).sql),
  );
  const seq = (db.executeSync(`SELECT seq FROM sqlite_sequence WHERE name = ?`, [table]).rows?.[0] as { seq?: number } | undefined)?.seq;
  const tmp = `${table}_rebuild`;
  const created = createSql.replace(new RegExp(`^\\s*CREATE TABLE\\s+(IF NOT EXISTS\\s+)?"?${table}"?`, 'i'), `CREATE TABLE ${tmp}`);
  if (created === createSql) throw new Error(`rebuild: cannot rename ${table} in its DDL`);
  db.executeSync(created);
  const kept = columnsOf(db, tmp);
  const cols = [...columnsOf(db, table)].filter((c) => kept.has(c) && !(c in fill));
  const names = [...cols, ...Object.keys(fill)].map((c) => `"${c}"`).join(', ');
  const values = [...cols.map((c) => `"${c}"`), ...Object.values(fill)].join(', ');
  db.executeSync(`INSERT INTO ${tmp} (${names}) SELECT ${values} FROM ${table}`);
  db.executeSync(`DROP TABLE ${table}`);
  db.executeSync(`ALTER TABLE ${tmp} RENAME TO ${table}`);
  for (const sql of indexes) db.executeSync(sql);
  // The copy made the new table's counter row even with no rows (seq 0).
  if (seq != null) db.executeSync(`UPDATE sqlite_sequence SET seq = MAX(seq, ?) WHERE name = ?`, [seq, table]);
}

function addColumnIfMissing(db: DB, sql: string): void {
  const m = sql.match(/ALTER\s+TABLE\s+"?(\w+)"?\s+ADD\s+COLUMN\s+"?(\w+)"?/i);
  if (!m) {
    db.executeSync(sql);
    return;
  }
  if (columnsOf(db, m[1]).has(m[2])) return;
  db.executeSync(sql);
}

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1].version;

export async function runUserMigrations(db: DB, upTo = Infinity): Promise<void> {
  db.executeSync(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);`);
  const result = db.executeSync(`SELECT MAX(version) AS v FROM schema_version;`);
  const current = (result.rows?.[0]?.v as number | null) ?? 0;

  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    // Tests stop part-way (upTo) to put rows in before a table rebuild.
    if (migration.version > upTo) break;
    // One transaction per migration, and the version stamp goes inside it.
    //
    // Without this a crash part-way through a multi-statement migration left
    // the schema half-changed AND unrecorded, so the next launch replayed it
    // from the top — onto tables that were already partly migrated. That is
    // how a v12 run could die at v6's `plot_type` and brick the app. The
    // `addColumnIfMissing` guard makes the common case idempotent, but a table
    // rebuild (rename → create → copy → drop) has no such luxury.
    //
    // Either the schema change and its version stamp both land, or neither
    // does. SQLite's DDL is transactional, and `PRAGMA foreign_keys` is
    // toggled around this whole loop in `init.ts` — never inside a migration,
    // which is the one thing that would silently no-op in here.
    db.executeSync('BEGIN IMMEDIATE;');
    try {
      migration.up(db);
      db.executeSync(`INSERT INTO schema_version (version) VALUES (?);`, [migration.version]);
      db.executeSync('COMMIT;');
    } catch (e) {
      try {
        db.executeSync('ROLLBACK;');
      } catch {
        // SQLite may have rolled back already on a fatal statement error.
      }
      throw e;
    }
  }
}
