import Database from 'better-sqlite3';
import path from 'path';

const DB_PATH = process.env.AMO_DB_PATH || path.resolve('/home/user/workspace/miami_dade_amo/miami_dade_amo.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL');
    _db.pragma('cache_size = -32000');
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
        sub_category TEXT, notes TEXT
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
        rec_book TEXT, rec_page TEXT, total_parties INTEGER
      );
      CREATE TABLE IF NOT EXISTS entity_relationships (
        source_entity TEXT, target_entity TEXT,
        transaction_count INTEGER DEFAULT 0,
        first_seen_date TEXT, last_seen_date TEXT,
        PRIMARY KEY (source_entity, target_entity)
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
      CREATE INDEX IF NOT EXISTS idx_entity_class_name ON entity_classifications(name);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_type ON entity_nodes(entity_type);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_inbound ON entity_nodes(inbound_vol DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_outbound ON entity_nodes(outbound_vol DESC);
      CREATE INDEX IF NOT EXISTS idx_entity_nodes_total ON entity_nodes(total_vol DESC);
    `);
  }
  return _db;
}
