import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.AMO_DB_PATH
  || path.resolve(process.cwd(), 'miami_dade_amo.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('cache_size = -32000');

    // Base schema — CREATE TABLE IF NOT EXISTS is safe on existing DBs
    _db.exec(`
      CREATE TABLE IF NOT EXISTS assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cfn TEXT, rec_date TEXT, grantor TEXT, grantee TEXT,
        address TEXT, legal_desc TEXT, doc_type TEXT,
        rec_book TEXT, rec_page TEXT, misc_ref TEXT,
        consideration REAL, raw_json TEXT
      );
      CREATE TABLE IF NOT EXISTS entity_classifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT UNIQUE, category TEXT, subcategory TEXT,
        sub_category TEXT, notes TEXT, confidence_source TEXT
      );
      CREATE TABLE IF NOT EXISTS collection_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        date_from TEXT, date_to TEXT, status TEXT,
        records_found INTEGER, records_inserted INTEGER, collected_at TEXT
      );
      CREATE TABLE IF NOT EXISTS entity_nodes (
        entity TEXT PRIMARY KEY, inbound_vol INTEGER DEFAULT 0,
        outbound_vol INTEGER DEFAULT 0, total_vol INTEGER DEFAULT 0,
        degree INTEGER DEFAULT 0, entity_type TEXT,
        first_seen TEXT, last_seen TEXT
      );
      CREATE TABLE IF NOT EXISTS entity_edges (
        source TEXT, target TEXT, weight INTEGER DEFAULT 0,
        PRIMARY KEY (source, target)
      );
      CREATE TABLE IF NOT EXISTS aom_events_clean (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        cfn TEXT, rec_date TEXT,
        assignor TEXT, assignee TEXT,
        assignor_canon TEXT, assignee_canon TEXT,
        assignor_type TEXT, assignee_type TEXT,
        txn_type TEXT,
        rec_book TEXT, rec_page TEXT, total_parties INTEGER
      );
      CREATE TABLE IF NOT EXISTS entity_relationships (
        source_entity TEXT, target_entity TEXT,
        transaction_count INTEGER DEFAULT 0,
        first_seen_date TEXT, last_seen_date TEXT,
        PRIMARY KEY (source_entity, target_entity)
      );
      CREATE TABLE IF NOT EXISTS credit_facility_events (
        cfn TEXT PRIMARY KEY, rec_date TEXT, doc_type TEXT,
        grantor TEXT, grantee TEXT, rec_book TEXT, rec_page TEXT,
        facility_type TEXT, facility_agreement_name TEXT, facility_agreement_date TEXT,
        facility_lender_name TEXT, facility_agent_name TEXT, facility_borrower_name TEXT,
        facility_amount REAL, facility_amount_type TEXT,
        facility_evidence_quote TEXT, facility_confidence TEXT,
        lender_key TEXT, borrower_key TEXT,
        lender_brand TEXT, borrower_brand TEXT,
        borrower_recorded TEXT, borrower_parent TEXT, lender_parent TEXT,
        direction TEXT, grantor_role TEXT, grantee_role TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_assignments_grantor ON assignments(grantor);
      CREATE INDEX IF NOT EXISTS idx_assignments_grantee ON assignments(grantee);
      CREATE INDEX IF NOT EXISTS idx_assignments_rec_date ON assignments(rec_date);
      CREATE INDEX IF NOT EXISTS idx_assignments_grantor_upper ON assignments(UPPER(grantor));
      CREATE INDEX IF NOT EXISTS idx_assignments_grantee_upper ON assignments(UPPER(grantee));
      CREATE INDEX IF NOT EXISTS idx_clean_assignor ON aom_events_clean(assignor_canon);
      CREATE INDEX IF NOT EXISTS idx_clean_assignee ON aom_events_clean(assignee_canon);
      CREATE INDEX IF NOT EXISTS idx_clean_assignor_type ON aom_events_clean(assignor_type);
      CREATE INDEX IF NOT EXISTS idx_clean_assignee_type ON aom_events_clean(assignee_type);
      CREATE INDEX IF NOT EXISTS idx_clean_date ON aom_events_clean(rec_date);
      CREATE INDEX IF NOT EXISTS idx_clean_txn_type ON aom_events_clean(txn_type);
      CREATE INDEX IF NOT EXISTS idx_cfe_lender ON credit_facility_events(facility_lender_name);
      CREATE INDEX IF NOT EXISTS idx_cfe_date ON credit_facility_events(rec_date);
      CREATE INDEX IF NOT EXISTS idx_cfe_type ON credit_facility_events(facility_type);
      CREATE INDEX IF NOT EXISTS idx_entity_class_name ON entity_classifications(name);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_type ON entity_nodes(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_inbound ON entity_nodes(inbound_vol DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_outbound ON entity_nodes(outbound_vol DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_total ON entity_nodes(total_vol DESC);
    `);

    // Migration: add txn_type to existing databases that predate the column.
    // ALTER TABLE ADD COLUMN throws if the column already exists — we catch and ignore.
    try {
      _db.exec(`ALTER TABLE aom_events_clean ADD COLUMN txn_type TEXT`);
      console.log('[db] migrated: added txn_type column to aom_events_clean');
    } catch (_e) {
      // Column already present — nothing to do
    }

    try {
      _db.exec(`ALTER TABLE entity_classifications ADD COLUMN confidence_source TEXT`);
      console.log('[db] migrated: added confidence_source column to entity_classifications');
    } catch (_e) {
      // Column already present — nothing to do
    }

    // Migration: PDF-extraction columns on aom_events_clean (populated by
    // collector/normalize.py from the pdf_extractions table).
    const pdfColumns: Array<[string, string]> = [
      ['doc_type', 'TEXT'],
      ['doc_category', 'TEXT'],
      ['doc_title', 'TEXT'],
      ['pdf_assignor', 'TEXT'],
      ['pdf_assignee', 'TEXT'],
      ['assignor_parent', 'TEXT'],
      ['assignee_parent', 'TEXT'],
      ['property_address', 'TEXT'],
      ['loan_amount', 'REAL'],
      ['consideration_amount', 'REAL'],
    ];
    for (const [col, type] of pdfColumns) {
      try {
        _db.exec(`ALTER TABLE aom_events_clean ADD COLUMN ${col} ${type}`);
        console.log(`[db] migrated: added ${col} column to aom_events_clean`);
      } catch (_e) {
        // Column already present — nothing to do
      }
    }

    // Migration: new PDF extraction fields
    const newPdfColumns: Array<[string, string]> = [
      ['folio_parcel', 'TEXT'],
      ['sponsor_address', 'TEXT'],
      ['signatory_officer', 'TEXT'],
    ];
    for (const [col, type] of newPdfColumns) {
      try { _db.exec(`ALTER TABLE pdf_extractions ADD COLUMN ${col} ${type}`); } catch (_e) {}
      try { _db.exec(`ALTER TABLE aom_events_clean ADD COLUMN ${col} ${type}`); } catch (_e) {}
    }

    // Migration: facility grouping-key columns (populated by normalize.py;
    // NULL until it re-runs — the routes COALESCE onto UPPER(name) meanwhile)
    for (const col of ['lender_key', 'borrower_key', 'lender_brand', 'borrower_brand',
                       'borrower_recorded', 'borrower_parent', 'lender_parent',
                       'direction', 'grantor_role', 'grantee_role']) {
      try { _db.exec(`ALTER TABLE credit_facility_events ADD COLUMN ${col} TEXT`); } catch (_e) {}
    }

    // Migration: review workflow columns
    const reviewColumns: Array<[string, string]> = [
      ['classification', 'TEXT'],
      ['reviewed_by', 'TEXT'],
      ['reviewed_at', 'TEXT'],
    ];
    for (const [col, type] of reviewColumns) {
      try {
        _db.exec(`ALTER TABLE aom_events_clean ADD COLUMN ${col} ${type}`);
        console.log(`[db] migrated: added ${col} column to aom_events_clean`);
      } catch (_e) {}
    }

    // Migration: multi-county support. Mirrors collector/migrate_add_county.py so
    // the server self-heals whichever side is deployed first — the Python
    // migration and this block are idempotent and agree on the same backfill.
    //
    // Every row that predates this column is Miami-Dade by definition, hence the
    // unconditional UPDATE of NULLs. Queries still COALESCE onto 'MIAMI-DADE'
    // rather than trusting the backfill, so a row inserted by an older collector
    // build can never silently drop out of a county-scoped result.
    for (const table of ['assignments', 'pdf_extractions', 'aom_events_clean',
                          'credit_facility_events', 'collection_log']) {
      try {
        _db.exec(`ALTER TABLE ${table} ADD COLUMN county TEXT`);
        console.log(`[db] migrated: added county column to ${table}`);
      } catch (_e) {}
      try {
        _db.exec(`UPDATE ${table} SET county = 'MIAMI-DADE' WHERE county IS NULL`);
      } catch (_e) {}
    }
    for (const [table, name, cols] of [
      ['assignments',            'idx_assignments_county_cfn',  '(county, cfn)'],
      ['assignments',            'idx_assignments_county_date', '(county, rec_date)'],
      ['aom_events_clean',       'idx_aom_clean_county_date',   '(county, rec_date)'],
      ['credit_facility_events', 'idx_cfe_county',              '(county)'],
    ] as Array<[string, string, string]>) {
      try { _db.exec(`CREATE INDEX IF NOT EXISTS ${name} ON ${table} ${cols}`); } catch (_e) {}
    }

    // Written by collector/broward_images.py, read here only for the liveness
    // signal on /api/stats. Declared defensively because the server must be
    // able to start against a database the harvester has never touched —
    // otherwise preparing that statement throws and takes the whole app down.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS broward_images (
        cfn           TEXT PRIMARY KEY,
        rec_date      TEXT,
        page_count    INTEGER,
        bytes_on_disk INTEGER,
        harvested_at  TEXT DEFAULT (datetime('now')),
        source_zip    TEXT
      );
    `);

    // Written by collector/run_backup.sh, read here only for the backup-health
    // signal on /api/stats. Declared defensively for the same reason as
    // broward_images above: the server has to start on a database no backup has
    // ever run against, including a freshly restored one.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS backup_runs (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        started_at    TEXT,
        finished_at   TEXT,
        status        TEXT,
        db_bytes      INTEGER,
        archive_bytes INTEGER,
        assignments   INTEGER,
        remote        TEXT,
        detail        TEXT
      );
    `);

    // Watchlist of market participants the user wants to monitor (Targets tab)
    _db.exec(`
      CREATE TABLE IF NOT EXISTS target_entities (
        entity TEXT PRIMARY KEY,
        added_at TEXT,
        notes TEXT
      );
    `);

    // Entity-resolution crosswalk: maps duplicate canonical names (variants)
    // onto one golden-record name. Managed from the Entities page; applied
    // immediately via the merge endpoint and re-applied by normalize.py on
    // every data rebuild.
    _db.exec(`
      CREATE TABLE IF NOT EXISTS entity_aliases (
        variant TEXT PRIMARY KEY,
        canonical TEXT NOT NULL,
        created_at TEXT,
        created_by TEXT,
        note TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_entity_aliases_canonical ON entity_aliases(canonical);
      CREATE TABLE IF NOT EXISTS alias_suggestion_dismissals (
        cluster_key TEXT PRIMARY KEY,
        dismissed_at TEXT
      );
    `);

    _db.exec(`
      CREATE TABLE IF NOT EXISTS pdf_extractions (
        cfn TEXT PRIMARY KEY,
        rec_book TEXT, rec_page TEXT,
        status TEXT, doc_category TEXT, doc_title TEXT,
        assignor_name TEXT, assignor_parent TEXT,
        assignee_name TEXT, assignee_parent TEXT,
        property_address TEXT, loan_amount REAL, consideration_amount REAL,
        ocr_chars INTEGER, model TEXT, extracted_at TEXT, raw_json TEXT
      );
    `);
  }
  return _db;
}
