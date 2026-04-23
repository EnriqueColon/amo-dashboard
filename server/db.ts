import Database from 'better-sqlite3';
import path from 'path';

// Point directly at the existing collected database
const DB_PATH = process.env.AMO_DB_PATH || path.resolve('/home/user/workspace/miami_dade_amo/miami_dade_amo.db');

let _db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH, { readonly: true });
    _db.pragma('journal_mode = WAL');
    _db.pragma('cache_size = -32000'); // 32MB cache
  }
  return _db;
}
