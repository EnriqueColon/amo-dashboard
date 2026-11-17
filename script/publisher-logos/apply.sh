#!/usr/bin/env bash
# Hand-set publisher logos for Market Research (17 Nov 2026). colliers.com and mba.org
# refuse servers, so the logo fetcher can't get them; these were read in a browser from
# the pages the owner sent. Status 'ok' rows are never re-fetched, so this is run once
# per database. Usage: script/publisher-logos/apply.sh [path/to/miami_dade_amo.db]
set -euo pipefail
DB="$(cd "$(dirname "${1:-miami_dade_amo.db}")" && pwd)/$(basename "${1:-miami_dade_amo.db}")"
cd "$(dirname "$0")"
sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS entity_logos (domain TEXT PRIMARY KEY, status TEXT NOT NULL, mime TEXT, bytes BLOB, width INTEGER, source_url TEXT, fetched_at TEXT NOT NULL);
INSERT INTO entity_logos (domain, status, mime, bytes, width, source_url, fetched_at) VALUES
 ('colliers.com','ok','image/png',readfile('colliers.com.png'),124,'hand-set 2026-11-17: https://www.colliers.com/-/media/images/colliers/unitedstates/national/footer/logofooter.ashx', strftime('%Y-%m-%dT%H:%M:%fZ','now')),
 ('mba.org','ok','image/png',readfile('mba.org.png'),152,'hand-set 2026-11-17: https://www.mba.org/ResourcePackages/mba/assets/favicon/apple-touch-icon-152x152.png', strftime('%Y-%m-%dT%H:%M:%fZ','now'))
ON CONFLICT(domain) DO UPDATE SET status=excluded.status, mime=excluded.mime, bytes=excluded.bytes, width=excluded.width, source_url=excluded.source_url, fetched_at=excluded.fetched_at;
SELECT domain || ' ' || status || ' ' || length(bytes) || ' bytes' FROM entity_logos WHERE domain IN ('colliers.com','mba.org');
SQL
