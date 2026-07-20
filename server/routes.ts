import type { Express } from 'express';
import type { Server } from 'http';
import { getDb } from './db';
import { fetchFDICFinancials } from './fdic';
import {
  getCached, setCached, clearCache, clearCacheByPrefix, getCacheStats,
  makeCacheKey, DEFAULT_TTL_MS, STATS_TTL_MS,
} from './cache';

export async function registerRoutes(httpServer: Server, app: Express) {
  const db = getDb();

  // ── Pre-compile all frequently-used statements once at startup ─────────────
  const stmts = {
    statsTotal:          db.prepare('SELECT COUNT(*) as n FROM assignments'),
    statsRange:          db.prepare('SELECT MIN(rec_date) as min_date, MAX(rec_date) as max_date FROM assignments'),
    statsGrantors:       db.prepare('SELECT COUNT(DISTINCT grantor) as n FROM assignments'),
    statsGrantees:       db.prepare('SELECT COUNT(DISTINCT grantee) as n FROM assignments'),
    statsUniqueEntities: db.prepare('SELECT COUNT(DISTINCT entity) as n FROM entity_nodes'),
    statsSelfAssigns:    db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean WHERE txn_type='SELF_ASSIGN'`),
    statsPrivCredit:     db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean WHERE (assignor_type='PRIVATE_CREDIT' OR assignee_type='PRIVATE_CREDIT') AND txn_type != 'SELF_ASSIGN'`),
    statsMarketTransfers:db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean WHERE txn_type='MARKET_TRANSFER'`),
    statsTxnBreakdown:   db.prepare(`SELECT txn_type, COUNT(*) as n FROM aom_events_clean GROUP BY txn_type ORDER BY n DESC`),
    statsLogCount:       db.prepare('SELECT COUNT(*) as n FROM collection_log'),
    statsLastCollected:  db.prepare(`SELECT MAX(date_to) as dt FROM collection_log WHERE status='OK'`),
    monthlyVolume:       db.prepare(`
      SELECT strftime('%Y-%m', rec_date) as month,
        COUNT(*) as total,
        SUM(CASE WHEN txn_type='MARKET_TRANSFER' THEN 1 ELSE 0 END) as market_transfers,
        SUM(CASE WHEN txn_type='ORIGINATION'     THEN 1 ELSE 0 END) as originations,
        COUNT(DISTINCT assignor_canon) as unique_assignors,
        COUNT(DISTINCT assignee_canon) as unique_assignees
      FROM aom_events_clean GROUP BY month ORDER BY month
    `),
    topAssignors:        db.prepare(`
      SELECT entity as name, entity_type as category, outbound_vol as total, first_seen as first_date, last_seen as last_date
      FROM entity_nodes WHERE outbound_vol > 0 ORDER BY outbound_vol DESC LIMIT 25
    `),
    topAssignees:        db.prepare(`
      SELECT entity as name, entity_type as category, inbound_vol as total, first_seen as first_date, last_seen as last_date
      FROM entity_nodes WHERE inbound_vol > 0 ORDER BY inbound_vol DESC LIMIT 25
    `),
    flowMatrix:          db.prepare(`
      SELECT COALESCE(assignor_type,'OTHER') as from_cat,
             COALESCE(assignee_type,'OTHER') as to_cat,
             COUNT(*) as count
      FROM aom_events_clean
      WHERE txn_type != 'SELF_ASSIGN'
      GROUP BY from_cat, to_cat ORDER BY count DESC
    `),
    networkStats:        db.prepare('SELECT COUNT(*) as n FROM aom_events_clean'),
    nodeCount:           db.prepare('SELECT COUNT(*) as n FROM entity_nodes'),
    edgeCount:           db.prepare('SELECT COUNT(*) as n FROM entity_relationships'),
    topAcquirers:        db.prepare('SELECT entity, inbound_vol, outbound_vol, degree, entity_type FROM entity_nodes ORDER BY inbound_vol DESC LIMIT 10'),
    topSellers:          db.prepare('SELECT entity, inbound_vol, outbound_vol, degree, entity_type FROM entity_nodes ORDER BY outbound_vol DESC LIMIT 10'),
    mostConnected:       db.prepare('SELECT entity, inbound_vol, outbound_vol, degree, entity_type FROM entity_nodes ORDER BY degree DESC LIMIT 10'),
    privateCreditTotal:  db.prepare(`
      SELECT COUNT(*) as n FROM aom_events_clean
      WHERE (assignor_type='PRIVATE_CREDIT' OR assignee_type='PRIVATE_CREDIT')
        AND txn_type != 'SELF_ASSIGN'
    `),
    privateCreditRows:   db.prepare(`
      SELECT c.cfn, c.rec_date,
             c.assignor  AS grantor, c.assignee  AS grantee,
             c.assignor_canon, c.assignee_canon,
             c.assignor_type AS grantor_category,
             c.assignee_type AS grantee_category,
             c.txn_type,
             a.address
      FROM aom_events_clean c
      LEFT JOIN assignments a ON c.cfn = a.cfn
      WHERE (c.assignor_type='PRIVATE_CREDIT' OR c.assignee_type='PRIVATE_CREDIT')
        AND c.txn_type != 'SELF_ASSIGN'
      ORDER BY c.rec_date DESC LIMIT ? OFFSET ?
    `),
    privateCreditTopGrantees: db.prepare(`
      SELECT assignee_canon AS name, COUNT(*) AS count
      FROM aom_events_clean
      WHERE assignee_type = 'PRIVATE_CREDIT'
        AND txn_type != 'SELF_ASSIGN'
        AND assignor_canon != assignee_canon
      GROUP BY assignee_canon
      ORDER BY count DESC LIMIT 10
    `),
    collectionLog:       db.prepare('SELECT date_from, date_to, records_found, status FROM collection_log ORDER BY date_from DESC'),
  };

  // ─── POST /api/cache/bust ─────────────────────────────────────────────────
  // Call this after running normalize.py to immediately serve fresh data.
  app.post('/api/cache/bust', (_req, res) => {
    const cleared = clearCache();
    console.log(`[cache] busted — ${cleared} entries cleared`);
    res.json({ ok: true, cleared });
  });

  // ─── GET /api/cache/stats ─────────────────────────────────────────────────
  app.get('/api/cache/stats', (_req, res) => {
    res.json(getCacheStats());
  });

  // ─── GET /api/stats ───────────────────────────────────────────────────────
  app.get('/api/stats', (_req, res) => {
    const KEY = '/api/stats';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);

    const total               = (stmts.statsTotal.get() as any).n;
    const { min_date, max_date } = stmts.statsRange.get() as any;
    const unique_grantors     = (stmts.statsGrantors.get() as any).n;
    const unique_grantees     = (stmts.statsGrantees.get() as any).n;
    const unique_entities     = (stmts.statsUniqueEntities.get() as any).n;
    const self_assigns        = (stmts.statsSelfAssigns.get() as any).n;
    const private_credit_txns = (stmts.statsPrivCredit.get() as any).n;
    const market_transfers    = (stmts.statsMarketTransfers.get() as any).n;
    const txn_breakdown       = stmts.statsTxnBreakdown.all();
    const collection_log_count = (stmts.statsLogCount.get() as any).n;
    const last_collected      = (stmts.statsLastCollected.get() as any)?.dt;
    const unique_cfns = total;
    const payload = { total, unique_cfns, unique_entities, self_assigns, min_date, max_date, unique_grantors, unique_grantees, private_credit_txns, market_transfers, txn_breakdown, collection_log_count, last_collected };
    setCached(KEY, payload, STATS_TTL_MS);
    res.json(payload);
  });

  // ─── GET /api/monthly-volume ──────────────────────────────────────────────
  app.get('/api/monthly-volume', (_req, res) => {
    const KEY = '/api/monthly-volume';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = stmts.monthlyVolume.all();
    setCached(KEY, data);
    res.json(data);
  });

  // ─── GET /api/top-assignors ───────────────────────────────────────────────
  app.get('/api/top-assignors', (_req, res) => {
    res.json(stmts.topAssignors.all());
  });

  // ─── GET /api/top-assignees ───────────────────────────────────────────────
  app.get('/api/top-assignees', (_req, res) => {
    res.json(stmts.topAssignees.all());
  });

  // ─── GET /api/assignments ─────────────────────────────────────────────────
  // Supports: grantor, grantee, start_date, end_date, category, page, limit
  // Types come from aom_events_clean joined on CFN — accurate canonical types,
  // no more UNCLASSIFIED for known entities.
  app.get('/api/assignments', (req, res) => {
    const { grantor, grantee, start_date, end_date, page = '1', limit = '50' } = req.query as Record<string, string>;
    const category = req.query['category'] as string | string[] | undefined;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    const categories = category
      ? (Array.isArray(category) ? category : [category])
      : (req.query['category[]'] ? (Array.isArray(req.query['category[]']) ? req.query['category[]'] : [req.query['category[]']]) : []);

    const cacheKey = makeCacheKey('/api/assignments', { grantor, grantee, start_date, end_date, categories, page, limit });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const where: string[] = [];
    const params: any[] = [];

    if (grantor)    { where.push("UPPER(a.grantor) LIKE UPPER(?)"); params.push(`%${grantor}%`); }
    if (grantee)    { where.push("UPPER(a.grantee) LIKE UPPER(?)"); params.push(`%${grantee}%`); }
    if (start_date) { where.push("a.rec_date >= ?"); params.push(start_date); }
    if (end_date)   { where.push("a.rec_date <= ?"); params.push(end_date); }
    if (categories.length > 0) {
      // Filter using canonical types from aom_events_clean
      const placeholders = categories.map(() => '?').join(', ');
      where.push(`(c.assignor_type IN (${placeholders}) OR c.assignee_type IN (${placeholders}))`);
      params.push(...categories, ...categories);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // COUNT: join aom_events_clean on CFN (indexed, fast) only when filtering by category
    const countSql = categories.length > 0
      ? `SELECT COUNT(*) as n FROM assignments a
         LEFT JOIN aom_events_clean c ON a.cfn = c.cfn
         ${whereClause}`
      : `SELECT COUNT(*) as n FROM assignments a ${whereClause}`;
    const total = (db.prepare(countSql).get(...params) as any).n;

    // DATA: always join aom_events_clean to get canonical types per CFN
    const dataSql = `
      SELECT a.cfn, a.rec_date, a.grantor, a.grantee, a.address,
        a.rec_book, a.rec_page, a.misc_ref, a.legal_desc,
        COALESCE(c.assignor_type, 'UNCLASSIFIED') as grantor_category,
        COALESCE(c.assignee_type, 'UNCLASSIFIED') as grantee_category
      FROM assignments a
      LEFT JOIN aom_events_clean c ON a.cfn = c.cfn
      ${whereClause}
      ORDER BY a.rec_date DESC LIMIT ? OFFSET ?
    `;
    const rows = db.prepare(dataSql).all(...params, limitNum, offset);

    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/entities ────────────────────────────────────────────────────
  app.get('/api/entities', (req, res) => {
    const { category } = req.query as Record<string, string>;
    const cacheKey = makeCacheKey('/api/entities', { category });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    let sql = 'SELECT name, category, sub_category FROM entity_classifications';
    const params: any[] = [];
    if (category) { sql += ' WHERE category = ?'; params.push(category); }
    sql += ' ORDER BY category, name';
    const data = db.prepare(sql).all(...params);
    setCached(cacheKey, data);
    res.json(data);
  });

  // ─── GET /api/flow-matrix ─────────────────────────────────────────────────
  app.get('/api/flow-matrix', (_req, res) => {
    res.json(stmts.flowMatrix.all());
  });

  // ─── GET /api/search ──────────────────────────────────────────────────────
  app.get('/api/search', (req, res) => {
    const { q } = req.query as Record<string, string>;
    if (!q || q.trim().length < 2) return res.json([]);
    const term = `%${q.trim()}%`;
    const rows = db.prepare(`
      SELECT a.cfn, a.rec_date, a.grantor, a.grantee, a.address,
        COALESCE(ec_g.category,'UNCLASSIFIED') as grantor_category,
        COALESCE(ec_a.category,'UNCLASSIFIED') as grantee_category
      FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      WHERE UPPER(a.grantor) LIKE UPPER(?) OR UPPER(a.grantee) LIKE UPPER(?) OR a.cfn LIKE ?
      ORDER BY a.rec_date DESC LIMIT 100
    `).all(term, term, term);
    res.json(rows);
  });

  // ─── GET /api/entity/:name ────────────────────────────────────────────────
  app.get('/api/entity/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);

    // Node stats — first try exact canonical match, then fuzzy (strip common suffixes)
    let node = (db.prepare(`
      SELECT entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen
      FROM entity_nodes WHERE entity=?
    `).get(name) as any) || null;

    // If no exact match, try stripping common suffixes to find canonical
    if (!node) {
      const stripped = name
        .replace(/\s+(LLC|CORP|INC|NA|N\.A\.|TRUST|NATIONAL ASSOCIATION|NATIONAL ASSN|NATIONAL ASSOCATION|N A|TRU|ASSN|LP|LLP|CO|COMPANY|BANK)\s*$/i, '')
        .trim();
      if (stripped !== name) {
        node = (db.prepare(`
          SELECT entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen
          FROM entity_nodes WHERE entity=?
        `).get(stripped) as any) || null;
      }
    }

    // Classification
    const classification = (db.prepare(`
      SELECT * FROM entity_classifications WHERE UPPER(name)=UPPER(?)
    `).get(name) as any) || null;

    // Clean inbound transactions (assigned TO this entity)
    const as_grantee = db.prepare(`
      SELECT cfn, rec_date, assignor_canon AS counterparty, assignor_type AS counterparty_type,
             assignor, rec_book, rec_page, total_parties
      FROM aom_events_clean
      WHERE assignee_canon=?
      ORDER BY rec_date DESC LIMIT 500
    `).all(name);

    // Clean outbound transactions (assigned FROM this entity)
    const as_grantor = db.prepare(`
      SELECT cfn, rec_date, assignee_canon AS counterparty, assignee_type AS counterparty_type,
             assignee, rec_book, rec_page, total_parties
      FROM aom_events_clean
      WHERE assignor_canon=?
      ORDER BY rec_date DESC LIMIT 500
    `).all(name);

    // Top inbound counterparties (who assigns TO this entity most)
    const top_senders = db.prepare(`
      SELECT assignor_canon AS entity, assignor_type AS entity_type, COUNT(*) AS txn_count
      FROM aom_events_clean WHERE assignee_canon=?
      GROUP BY assignor_canon ORDER BY txn_count DESC LIMIT 10
    `).all(name);

    // Top outbound counterparties (who this entity assigns TO most)
    const top_receivers = db.prepare(`
      SELECT assignee_canon AS entity, assignee_type AS entity_type, COUNT(*) AS txn_count
      FROM aom_events_clean WHERE assignor_canon=?
      GROUP BY assignee_canon ORDER BY txn_count DESC LIMIT 10
    `).all(name);

    res.json({ name, node, classification, as_grantee, as_grantor, top_senders, top_receivers });
  });

  // ─── PATCH /api/entity/:name/type ────────────────────────────────────────
  // Override the entity type for a canonical entity (persists in entity_nodes
  // and entity_classifications so it survives page refreshes).
  app.patch('/api/entity/:name/type', (req, res) => {
    const name    = decodeURIComponent(req.params.name);
    const { type } = req.body as { type: string };
    const VALID = ['BANK','PRIVATE_CREDIT','TRUST','GSE','SERVICER','MERS','OTHER'];
    if (!VALID.includes(type)) return res.status(400).json({ error: `Invalid type. Must be one of: ${VALID.join(', ')}` });

    // Update entity_nodes immediately
    db.prepare(`UPDATE entity_nodes SET entity_type = ? WHERE entity = ?`).run(type, name);

    // Upsert into entity_classifications with manual_override confidence
    db.prepare(`
      INSERT INTO entity_classifications (name, category, sub_category, confidence_source)
      VALUES (?, ?, '', 'manual_override')
      ON CONFLICT(name) DO UPDATE SET category = excluded.category,
                                      confidence_source = 'manual_override'
    `).run(name, type);

    // Cascade into aom_events_clean
    db.prepare(`UPDATE aom_events_clean SET assignor_type = ? WHERE assignor_canon = ?`).run(type, name);
    db.prepare(`UPDATE aom_events_clean SET assignee_type = ? WHERE assignee_canon = ?`).run(type, name);

    // Re-derive txn_type for all affected transactions
    db.prepare(`
      UPDATE aom_events_clean SET txn_type =
      CASE
        WHEN assignor_canon = assignee_canon THEN 'SELF_ASSIGN'
        WHEN assignor_type  = 'MERS'         THEN 'MERS_RELEASE'
        WHEN assignor_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST')
         AND assignee_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST') THEN 'MARKET_TRANSFER'
        WHEN assignor_type NOT IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST','MERS')
         AND assignee_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST') THEN 'ORIGINATION'
        WHEN assignor_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST')
         AND assignee_type NOT IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST','MERS') THEN 'INSTITUTIONAL_OUT'
        ELSE 'PRIVATE'
      END
      WHERE assignor_canon = ? OR assignee_canon = ?
    `).run(name, name);

    // Clear all relevant cache keys so next request sees fresh data
    clearCacheByPrefix('/api/entity');
    clearCacheByPrefix('/api/entity-nodes');
    clearCacheByPrefix('/api/deal-intelligence');
    clearCacheByPrefix('/api/network');
    clearCacheByPrefix('/api/stats');
    clearCacheByPrefix('/api/assignments');
    clearCacheByPrefix('/api/clean-events');
    clearCacheByPrefix('/api/flow-matrix');

    res.json({ ok: true, name, type });
  });

  // ─── GET /api/entity/:name/sub-entities ───────────────────────────────────
  // Returns all raw name variants (legal vehicles) that canonicalize to this entity,
  // with transaction counts, date ranges, and top counterparties per variant.
  app.get('/api/entity/:name/sub-entities', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const cacheKey = `/api/entity/${name}/sub-entities`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    // All raw names that appear as buyer (assignee) under this canonical
    const buyerSubs = db.prepare(`
      SELECT assignee AS raw_name,
             COUNT(*)            AS txn_count,
             MIN(rec_date)       AS first_seen,
             MAX(rec_date)       AS last_seen,
             assignee_type       AS entity_type
      FROM aom_events_clean
      WHERE assignee_canon = ?
      GROUP BY assignee
      ORDER BY txn_count DESC
      LIMIT 100
    `).all(name) as any[];

    // Top sellers into each buyer sub-entity
    const buyerCounterparties = db.prepare(`
      SELECT assignee AS sub_name, assignor_canon AS counterparty,
             assignor_type AS counterparty_type, COUNT(*) AS n
      FROM aom_events_clean
      WHERE assignee_canon = ?
      GROUP BY assignee, assignor_canon
      ORDER BY assignee, n DESC
    `).all(name) as any[];

    // All raw names that appear as seller (assignor) under this canonical
    const sellerSubs = db.prepare(`
      SELECT assignor AS raw_name,
             COUNT(*)        AS txn_count,
             MIN(rec_date)   AS first_seen,
             MAX(rec_date)   AS last_seen,
             assignor_type   AS entity_type
      FROM aom_events_clean
      WHERE assignor_canon = ?
      GROUP BY assignor
      ORDER BY txn_count DESC
      LIMIT 100
    `).all(name) as any[];

    // Top buyers from each seller sub-entity
    const sellerCounterparties = db.prepare(`
      SELECT assignor AS sub_name, assignee_canon AS counterparty,
             assignee_type AS counterparty_type, COUNT(*) AS n
      FROM aom_events_clean
      WHERE assignor_canon = ?
      GROUP BY assignor, assignee_canon
      ORDER BY assignor, n DESC
    `).all(name) as any[];

    // Attach top counterparties (max 5 per sub) to each sub-entity row
    const buyerCpMap = new Map<string, any[]>();
    for (const r of buyerCounterparties) {
      if (!buyerCpMap.has(r.sub_name)) buyerCpMap.set(r.sub_name, []);
      const arr = buyerCpMap.get(r.sub_name)!;
      if (arr.length < 5) arr.push({ entity: r.counterparty, type: r.counterparty_type, n: r.n });
    }
    const sellerCpMap = new Map<string, any[]>();
    for (const r of sellerCounterparties) {
      if (!sellerCpMap.has(r.sub_name)) sellerCpMap.set(r.sub_name, []);
      const arr = sellerCpMap.get(r.sub_name)!;
      if (arr.length < 5) arr.push({ entity: r.counterparty, type: r.counterparty_type, n: r.n });
    }

    const buyer_subs  = buyerSubs.map(s  => ({ ...s, counterparties: buyerCpMap.get(s.raw_name)  ?? [] }));
    const seller_subs = sellerSubs.map(s => ({ ...s, counterparties: sellerCpMap.get(s.raw_name) ?? [] }));

    const payload = { name, buyer_subs, seller_subs };
    setCached(cacheKey, payload, 30 * 60 * 1000);
    res.json(payload);
  });

  // ─── GET /api/collection-log ──────────────────────────────────────────────
  app.get('/api/collection-log', (_req, res) => {
    const KEY = '/api/collection-log';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = stmts.collectionLog.all();
    setCached(KEY, data, STATS_TTL_MS);
    res.json(data);
  });

  // ─── GET /api/private-credit ──────────────────────────────────────────────
  app.get('/api/private-credit', (req, res) => {
    const { page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset   = (pageNum - 1) * limitNum;
    const cacheKey = makeCacheKey('/api/private-credit', { page, limit });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const total = (stmts.privateCreditTotal.get() as any).n;
    const rows  = stmts.privateCreditRows.all(limitNum, offset);
    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/private-credit/top-grantees ─────────────────────────────────
  app.get('/api/private-credit/top-grantees', (_req, res) => {
    const KEY = '/api/private-credit/top-grantees';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = stmts.privateCreditTopGrantees.all();
    setCached(KEY, data);
    res.json(data);
  });


  // ─── GET /api/network-stats ───────────────────────────────────────────────
  app.get('/api/network-stats', (_req, res) => {
    const KEY = '/api/network-stats';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const clean_total    = (stmts.networkStats.get() as any)?.n ?? 0;
    const node_count     = (stmts.nodeCount.get() as any)?.n ?? 0;
    const edge_count     = (stmts.edgeCount.get() as any)?.n ?? 0;
    const raw_total      = (stmts.statsTotal.get() as any).n;
    const top_acquirers  = stmts.topAcquirers.all();
    const top_sellers    = stmts.topSellers.all();
    const most_connected = stmts.mostConnected.all();
    const payload = { clean_total, raw_total, node_count, edge_count, top_acquirers, top_sellers, most_connected };
    setCached(KEY, payload);
    res.json(payload);
  });

  // ─── GET /api/network-graph ───────────────────────────────────────────────
  // Returns nodes + edges for D3 force layout
  // ?min_txns=N  — filter edges with fewer than N transactions
  // ?days=N      — filter by last N days
  // ?entity=X    — only include edges touching this entity
  app.get('/api/network-graph', (req, res) => {
    const min_txns = parseInt(req.query.min_txns as string) || 5;
    const days     = parseInt(req.query.days as string) || 0;
    const entity   = (req.query.entity as string || '').trim().toUpperCase();

    let edgeWhere = `transaction_count >= ${min_txns}`;
    const params: any[] = [];

    if (days > 0) {
      edgeWhere += ` AND last_seen_date >= date('now', '-${days} days')`;
    }
    if (entity) {
      edgeWhere += ` AND (UPPER(source_entity) LIKE ? OR UPPER(target_entity) LIKE ?)`;
      params.push(`%${entity}%`, `%${entity}%`);
    }

    const edges = db.prepare(`
      SELECT source_entity, target_entity, transaction_count, first_seen_date, last_seen_date
      FROM entity_relationships WHERE ${edgeWhere}
      ORDER BY transaction_count DESC LIMIT 500
    `).all(...params) as any[];

    // Collect all unique entity names from edges
    const entityNames = new Set<string>();
    for (const e of edges) {
      entityNames.add(e.source_entity);
      entityNames.add(e.target_entity);
    }

    // Fetch node stats for those entities
    const nodes: any[] = [];
    if (entityNames.size > 0) {
      const placeholders = Array.from(entityNames).map(() => '?').join(',');
      const nodeRows = db.prepare(`
        SELECT entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen
        FROM entity_nodes WHERE entity IN (${placeholders})
      `).all(...Array.from(entityNames)) as any[];
      nodes.push(...nodeRows);
    }

    // Reshape for D3: entity→id, source_entity→source, target_entity→target
    const d3Nodes = nodes.map((n: any) => ({ ...n, id: n.entity }));
    const d3Edges = edges.map((e: any) => ({
      source: e.source_entity,
      target: e.target_entity,
      transaction_count: e.transaction_count,
      first_seen_date: e.first_seen_date,
      last_seen_date: e.last_seen_date,
    }));
    res.json({ nodes: d3Nodes, edges: d3Edges });
  });

  // ─── GET /api/clean-events ────────────────────────────────────────────────
  // Deduplicated clean transaction table
  // Supports: assignor, assignee, start_date, end_date, txn_type, page, limit
  app.get('/api/clean-events', (req, res) => {
    const { assignor, assignee, start_date, end_date, txn_type, page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = makeCacheKey('/api/clean-events', { assignor, assignee, start_date, end_date, txn_type, page, limit });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const where: string[] = [];
    const params: any[] = [];
    if (assignor)    { where.push("UPPER(assignor_canon) LIKE UPPER(?)"); params.push(`%${assignor}%`); }
    if (assignee)    { where.push("UPPER(assignee_canon) LIKE UPPER(?)"); params.push(`%${assignee}%`); }
    if (start_date)  { where.push("rec_date >= ?"); params.push(start_date); }
    if (end_date)    { where.push("rec_date <= ?"); params.push(end_date); }
    if (txn_type)    { where.push("txn_type = ?"); params.push(txn_type.toUpperCase()); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean ${wc}`).get(...params) as any).n;
    const rows = db.prepare(`
      SELECT cfn, rec_date, assignor, assignee, assignor_canon, assignee_canon,
             assignor_type, assignee_type, txn_type, rec_book, rec_page, total_parties,
             doc_type, doc_category, doc_title, pdf_assignor, pdf_assignee,
             assignor_parent, assignee_parent, property_address,
             loan_amount, consideration_amount
      FROM aom_events_clean ${wc}
      ORDER BY rec_date DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/credit-facility-events ──────────────────────────────────────
  // Documents where the PDF-extraction pipeline found real warehouse/revolving
  // credit-facility language (see collector/extract_pdfs.py's FACILITY_SYSTEM_PROMPT
  // and collector/normalize.py, which builds this table).
  app.get('/api/credit-facility-events', (req, res) => {
    const { lender, borrower, facility_type, start_date, end_date, page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = makeCacheKey('/api/credit-facility-events', { lender, borrower, facility_type, start_date, end_date, page, limit });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const where: string[] = [];
    const params: any[] = [];
    if (lender)        { where.push("UPPER(facility_lender_name) LIKE UPPER(?)"); params.push(`%${lender}%`); }
    if (borrower)      { where.push("UPPER(facility_borrower_name) LIKE UPPER(?)"); params.push(`%${borrower}%`); }
    if (facility_type) { where.push("facility_type = ?"); params.push(facility_type); }
    if (start_date)    { where.push("rec_date >= ?"); params.push(start_date); }
    if (end_date)      { where.push("rec_date <= ?"); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM credit_facility_events ${wc}`).get(...params) as any).n;
    const rows = db.prepare(`
      SELECT cfn, rec_date, doc_type, grantor, grantee,
             facility_type, facility_agreement_name, facility_agreement_date,
             facility_lender_name, facility_agent_name, facility_borrower_name,
             facility_amount, facility_amount_type, facility_evidence_quote, facility_confidence,
             rec_book, rec_page
      FROM credit_facility_events ${wc}
      ORDER BY rec_date DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/credit-facility-events/facilities ───────────────────────────
  // Relationship-grouped view: one row per lender↔borrower pair (grouped
  // case-insensitively, since extraction casing varies across filings). The
  // same facility recurs across filings as loans are pledged into / released
  // from it, so the pair — not the filing — is the real unit of interest.
  app.get('/api/credit-facility-events/facilities', (req, res) => {
    const { lender, borrower, facility_type, start_date, end_date, page = '1', limit = '50', sort = '', dir = '' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    const cacheKey = makeCacheKey('/api/credit-facility-events/facilities', { lender, borrower, facility_type, start_date, end_date, page, limit, sort, dir });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const where: string[] = [];
    const params: any[] = [];
    if (lender)        { where.push("UPPER(facility_lender_name) LIKE UPPER(?)"); params.push(`%${lender}%`); }
    if (borrower)      { where.push("UPPER(facility_borrower_name) LIKE UPPER(?)"); params.push(`%${borrower}%`); }
    if (facility_type) { where.push("facility_type = ?"); params.push(facility_type); }
    if (start_date)    { where.push("rec_date >= ?"); params.push(start_date); }
    if (end_date)      { where.push("rec_date <= ?"); params.push(end_date); }
    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const grouped = `
      SELECT COALESCE(lender_key, UPPER(COALESCE(facility_lender_name, '')))     AS lender_key,
             COALESCE(borrower_key, UPPER(COALESCE(facility_borrower_name, ''))) AS borrower_key,
             MAX(facility_lender_name)    AS lender,
             MAX(facility_borrower_name)  AS borrower,
             MAX(facility_type)           AS facility_type,
             MAX(facility_amount)         AS facility_amount,
             MAX(facility_amount_type)    AS facility_amount_type,
             MAX(facility_agent_name)     AS agent_name,
             MAX(facility_agreement_name) AS agreement_name,
             MAX(facility_agreement_date) AS agreement_date,
             COUNT(*)                     AS filings,
             MIN(rec_date)                AS first_date,
             MAX(rec_date)                AS last_date
      FROM credit_facility_events ${wc}
      GROUP BY 1, 2
    `;
    // Whitelisted sort columns (aliases from the grouped SELECT) — anything
    // else falls back to the default most-active-first ordering.
    const SORT_COLS: Record<string, string> = {
      lender: 'lender COLLATE NOCASE', borrower: 'borrower COLLATE NOCASE',
      type: 'facility_type COLLATE NOCASE',
      amount: 'facility_amount', filings: 'filings', activity: 'last_date',
    };
    const sortCol = SORT_COLS[sort];
    const sortDir = dir === 'asc' ? 'ASC' : 'DESC';
    const orderBy = sortCol
      ? `${sortCol} ${sortDir}, filings DESC, last_date DESC`
      : 'filings DESC, facility_amount DESC, last_date DESC';

    const totals = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(filings), 0) AS f FROM (${grouped})`).get(...params) as any;
    const rows = db.prepare(`${grouped} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(...params, limitNum, offset);

    const payload = { total: totals.n, total_filings: totals.f, page: pageNum, limit: limitNum, pages: Math.ceil(totals.n / limitNum), rows };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/credit-facility-events/filings ──────────────────────────────
  // Filing history for one facility relationship. lender/borrower are the
  // UPPER()'d keys returned by /facilities (empty string = extracted as null).
  app.get('/api/credit-facility-events/filings', (req, res) => {
    const { lender = '', borrower = '' } = req.query as Record<string, string>;
    const cacheKey = makeCacheKey('/api/credit-facility-events/filings', { lender, borrower });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    // loan_amount / property_address describe the specific underlying mortgage
    // being pledged or released in this filing — the closest public proxy for
    // per-transaction activity, since actual draw amounts are never recorded.
    // Guard: when a document only states the facility's credit limit, the
    // extractor tends to store that same number as loan_amount too (blanket
    // collateral assignments have no per-loan principal to extract). Null it
    // out so the credit limit doesn't masquerade as a per-filing mortgage.
    // When facility_amount_type is note_principal the amounts legitimately
    // coincide (the facility size WAS taken from the note), so keep it.
    const rows = db.prepare(`
      SELECT e.cfn, e.rec_date, e.doc_type, e.grantor, e.grantee,
             e.facility_amount, e.facility_amount_type,
             e.facility_agreement_name, e.facility_agreement_date,
             e.facility_evidence_quote, e.facility_confidence,
             e.rec_book, e.rec_page,
             CASE WHEN px.loan_amount = e.facility_amount
                   AND e.facility_amount_type = 'credit_limit'
                  THEN NULL ELSE px.loan_amount END AS loan_amount,
             px.property_address
      FROM credit_facility_events e
      LEFT JOIN pdf_extractions px ON px.cfn = e.cfn
      WHERE COALESCE(e.lender_key, UPPER(COALESCE(e.facility_lender_name, '')))     = ?
        AND COALESCE(e.borrower_key, UPPER(COALESCE(e.facility_borrower_name, ''))) = ?
      ORDER BY e.rec_date DESC
    `).all(lender.toUpperCase(), borrower.toUpperCase());

    setCached(cacheKey, rows);
    res.json(rows);
  });

  // ─── GET /api/credit-facility-events/chart ────────────────────────────────
  app.get('/api/credit-facility-events/chart', (req, res) => {
    const type      = typeof req.query.type === 'string' ? req.query.type : 'monthly';
    const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : '';
    const endDate   = typeof req.query.end_date === 'string' ? req.query.end_date : '';

    const dateClauses: string[] = [];
    const dateParams: any[] = [];
    if (startDate) { dateClauses.push(`rec_date >= ?`); dateParams.push(startDate); }
    if (endDate)   { dateClauses.push(`rec_date <= ?`); dateParams.push(endDate); }
    const dwc = dateClauses.length ? `WHERE ${dateClauses.join(' AND ')}` : '';

    if (type === 'monthly') {
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', rec_date) as period, COUNT(*) as count
        FROM credit_facility_events ${dwc}
        GROUP BY period ORDER BY period
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'top_lenders') {
      // Group case-insensitively — the same lender is sometimes extracted with
      // different capitalization across filings (e.g. "City National Bank of
      // Florida" vs "CITY NATIONAL BANK OF FLORIDA").
      const rows = db.prepare(`
        SELECT MAX(facility_lender_name) as label, COUNT(*) as count
        FROM credit_facility_events
        WHERE ${[...dateClauses, 'facility_lender_name IS NOT NULL'].join(' AND ')}
        GROUP BY COALESCE(lender_key, UPPER(facility_lender_name))
        ORDER BY count DESC LIMIT 15
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'by_facility_type') {
      const rows = db.prepare(`
        SELECT COALESCE(facility_type, 'unknown') as label, COUNT(*) as count
        FROM credit_facility_events ${dwc}
        GROUP BY facility_type ORDER BY count DESC
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'total_volume') {
      // Dedupe on (lender, borrower, amount) before summing — the same facility
      // is often cited across multiple separate filings (a facility gets
      // pledged/released one document at a time), so a naive SUM(facility_amount)
      // across every row would multiply-count it. UPPER() because extraction
      // casing varies across filings of the same facility — case-sensitive
      // DISTINCT would double-count those.
      const row = db.prepare(`
        SELECT SUM(facility_amount) as total, COUNT(*) as distinct_facilities
        FROM (
          SELECT DISTINCT COALESCE(lender_key, UPPER(facility_lender_name))     AS lender,
                          COALESCE(borrower_key, UPPER(facility_borrower_name)) AS borrower,
                          facility_amount
          FROM credit_facility_events
          WHERE facility_amount IS NOT NULL ${dwc.replace('WHERE', 'AND')}
        )
      `).get(...dateParams);
      return res.json(row);
    }

    res.status(400).json({ error: 'Unknown chart type' });
  });

  // ─── GET /api/entity-nodes ────────────────────────────────────────────────
  app.get('/api/entity-nodes', (req, res) => {
    const { q, type, limit: limitParam } = req.query as Record<string, string>;
    const limitNum = Math.min(parseInt(limitParam) || 5000, 25000);
    const cacheKey = makeCacheKey('/api/entity-nodes', { q, type, limit: String(limitNum) });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    // Primary source: entity_nodes (pre-aggregated by pipeline)
    // UNION with any canonical entities in aom_events_clean that the pipeline missed
    // (e.g. entities that only appear in self-assign transactions)
    const params: any[] = [];
    const where: string[] = [];
    if (q)    { where.push('UPPER(entity) LIKE UPPER(?)'); params.push(`%${q}%`); }
    if (type) { where.push('entity_type = ?'); params.push(type); }
    const whereClause = where.length ? ` WHERE ${where.join(' AND ')}` : '';

    const sql = `
      SELECT entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen
      FROM entity_nodes ${whereClause}
      UNION
      SELECT entity, inbound_vol, outbound_vol,
             inbound_vol + outbound_vol as total_vol,
             in_deg + out_deg as degree,
             entity_type, first_seen, last_seen
      FROM (
        SELECT ae.entity,
               COALESCE(i.cnt, 0) as inbound_vol,
               COALESCE(o.cnt, 0) as outbound_vol,
               COALESCE(i.deg, 0) as in_deg,
               COALESCE(o.deg, 0) as out_deg,
               COALESCE(i.fs, o.fs) as first_seen,
               COALESCE(i.ls, o.ls) as last_seen,
               COALESCE(t.etype, 'OTHER') as entity_type
        FROM (
          SELECT assignor_canon as entity FROM aom_events_clean
          UNION SELECT assignee_canon FROM aom_events_clean
        ) ae
        LEFT JOIN (
          SELECT assignee_canon as entity, COUNT(*) as cnt, COUNT(DISTINCT assignor_canon) as deg,
                 MIN(rec_date) as fs, MAX(rec_date) as ls
          FROM aom_events_clean GROUP BY assignee_canon
        ) i ON ae.entity = i.entity
        LEFT JOIN (
          SELECT assignor_canon as entity, COUNT(*) as cnt, COUNT(DISTINCT assignee_canon) as deg,
                 MIN(rec_date) as fs, MAX(rec_date) as ls
          FROM aom_events_clean GROUP BY assignor_canon
        ) o ON ae.entity = o.entity
        LEFT JOIN (
          SELECT assignee_canon as entity, assignee_type as etype FROM aom_events_clean GROUP BY assignee_canon
          UNION SELECT assignor_canon, assignor_type FROM aom_events_clean GROUP BY assignor_canon
        ) t ON ae.entity = t.entity
        WHERE ae.entity NOT IN (SELECT entity FROM entity_nodes)
          AND ae.entity != 'UNKNOWN' ${where.length ? `AND ${where.map(w => w.replace('entity', 'ae.entity')).join(' AND ')}` : ''}
      )
      ORDER BY total_vol DESC
      LIMIT ${limitNum}
    `;

    const data = db.prepare(sql).all(...params, ...(where.length ? params : []));
    setCached(cacheKey, data);
    res.json(data);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // DEAL INTELLIGENCE ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════════

  // Known special servicers (handle distressed / non-performing loans)
  const SPECIAL_SERVICERS = [
    'MORTGAGE ASSETS MANAGEMENT',
    'SELECT PORTFOLIO SERVICING',
    'CARRINGTON MORTGAGE',
    'SPECIALIZED LOAN SERVICING',
    'OCWEN LOAN SERVICING',
    'PHH MORTGAGE',
    'RUSHMORE LOAN MANAGEMENT',
    'FAYERWEATHER STREET MORTGAGE',
    'REVERSE MORTGAGE FUNDING',
    'FINANCE OF AMERICA REVERSE',
  ];
  const specialSvcPlaceholders = SPECIAL_SERVICERS.map(() => '?').join(',');

  // Pre-compile Deal Intelligence statements
  const diStmts = {
    bankToPeTotal: db.prepare(`
      SELECT COUNT(*) as n FROM aom_events_clean
      WHERE assignor_type='BANK' AND assignee_type='PRIVATE_CREDIT' AND txn_type='MARKET_TRANSFER'
    `),
    instOutTotal: db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean WHERE txn_type='INSTITUTIONAL_OUT'`),
    netSellersCount: db.prepare(`
      SELECT COUNT(*) as n FROM entity_nodes
      WHERE entity_type IN ('BANK','SERVICER','TRUST')
        AND outbound_vol > inbound_vol * 1.5
        AND total_vol >= 20
    `),
    activePeBuyers: db.prepare(`
      SELECT COUNT(DISTINCT assignee_canon) as n FROM aom_events_clean
      WHERE assignee_type='PRIVATE_CREDIT'
        AND assignor_type IN ('BANK','SERVICER','GSE','TRUST')
    `),
    sellerPressure: db.prepare(`
      SELECT entity, entity_type,
             inbound_vol, outbound_vol, total_vol,
             (outbound_vol - inbound_vol) AS net_outbound,
             first_seen, last_seen
      FROM entity_nodes
      WHERE entity_type IN ('BANK','SERVICER','TRUST')
        AND total_vol >= 20
      ORDER BY net_outbound DESC
      LIMIT 25
    `),
    peCompetitive: db.prepare(`
      SELECT en.entity, en.inbound_vol, en.outbound_vol, en.total_vol,
             en.first_seen, en.last_seen,
             (SELECT COUNT(*) FROM aom_events_clean
              WHERE assignee_canon=en.entity
                AND assignor_type IN ('BANK','SERVICER','GSE')
             ) AS inst_inbound
      FROM entity_nodes en
      WHERE en.entity_type = 'PRIVATE_CREDIT'
        AND en.total_vol >= 5
      ORDER BY en.inbound_vol DESC
      LIMIT 20
    `),
    bankToPeRows: db.prepare(`
      SELECT c.cfn, c.rec_date,
             c.assignor_canon AS seller, c.assignee_canon AS buyer,
             c.assignor, c.assignee,
             c.rec_book, c.rec_page
      FROM aom_events_clean c
      WHERE c.assignor_type='BANK' AND c.assignee_type='PRIVATE_CREDIT'
        AND c.txn_type='MARKET_TRANSFER'
      ORDER BY c.rec_date DESC
      LIMIT ? OFFSET ?
    `),
    bankToPeCount: db.prepare(`
      SELECT COUNT(*) as n FROM aom_events_clean
      WHERE assignor_type='BANK' AND assignee_type='PRIVATE_CREDIT' AND txn_type='MARKET_TRANSFER'
    `),
    monthlyDistressed: db.prepare(`
      SELECT strftime('%Y-%m', rec_date) AS month,
        SUM(CASE WHEN assignor_type='BANK' AND assignee_type='PRIVATE_CREDIT'
                  AND txn_type='MARKET_TRANSFER' THEN 1 ELSE 0 END) AS bank_to_pe,
        SUM(CASE WHEN txn_type='INSTITUTIONAL_OUT' THEN 1 ELSE 0 END) AS inst_out,
        SUM(CASE WHEN txn_type='MARKET_TRANSFER'   THEN 1 ELSE 0 END) AS market_transfers
      FROM aom_events_clean
      GROUP BY month ORDER BY month
    `),
    recentBankToPe: db.prepare(`
      SELECT c.rec_date, c.assignor_canon AS seller, c.assignee_canon AS buyer, COUNT(*) AS n
      FROM aom_events_clean c
      WHERE c.assignor_type='BANK' AND c.assignee_type='PRIVATE_CREDIT'
        AND c.txn_type='MARKET_TRANSFER'
        AND c.rec_date >= date('now', '-180 days')
      GROUP BY c.assignor_canon, c.assignee_canon
      ORDER BY n DESC LIMIT 10
    `),
  };

  // ── Date range helper ────────────────────────────────────────────────────
  function shiftOneYearBack(iso: string): string {
    const d = new Date(iso);
    d.setUTCFullYear(d.getUTCFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }

  function parseDateRange(query: Record<string, string>) {
    const start = query.start_date?.trim() || '';
    const end   = query.end_date?.trim()   || '';
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end);
    if (!valid) return { hasFilter: false, start: '', end: '', priorStart: '', priorEnd: '', days: 0 };
    const days = Math.max(1, Math.round((new Date(end).getTime() - new Date(start).getTime()) / 86400000));
    // Prior period = same calendar window one year earlier (year-over-year comparison)
    const priorStart = shiftOneYearBack(start);
    const priorEnd   = shiftOneYearBack(end);
    return { hasFilter: true, start, end, priorStart, priorEnd, days };
  }

  function diCountsForPeriod(dateWhere: string, params: any[]) {
    const bank_to_pe = (db.prepare(`
      SELECT COUNT(*) as n FROM aom_events_clean
      WHERE assignor_type='BANK' AND assignee_type='PRIVATE_CREDIT' AND txn_type='MARKET_TRANSFER'
      ${dateWhere}
    `).get(...params) as any).n;
    const inst_out = (db.prepare(`
      SELECT COUNT(*) as n FROM aom_events_clean WHERE txn_type='INSTITUTIONAL_OUT' ${dateWhere}
    `).get(...params) as any).n;
    const active_pe_buyers = (db.prepare(`
      SELECT COUNT(DISTINCT assignee_canon) as n FROM aom_events_clean
      WHERE assignee_type='PRIVATE_CREDIT' AND assignor_type IN ('BANK','SERVICER','GSE','TRUST') ${dateWhere}
    `).get(...params) as any).n;
    // Net sellers: computed from aom_events_clean for the period
    const net_sellers = (db.prepare(`
      SELECT COUNT(*) as n FROM (
        SELECT entity,
          SUM(CASE WHEN dir='out' THEN cnt ELSE 0 END) as out_vol,
          SUM(CASE WHEN dir='in'  THEN cnt ELSE 0 END) as in_vol
        FROM (
          SELECT assignor_canon as entity, 'out' as dir, COUNT(*) as cnt
          FROM aom_events_clean
          WHERE assignor_type IN ('BANK','SERVICER','TRUST') ${dateWhere}
          GROUP BY assignor_canon
          UNION ALL
          SELECT assignee_canon, 'in', COUNT(*)
          FROM aom_events_clean
          WHERE assignee_type IN ('BANK','SERVICER','TRUST') ${dateWhere}
          GROUP BY assignee_canon
        ) GROUP BY entity
        HAVING out_vol >= 3 AND out_vol > in_vol * 1.5
      )
    `).get(...params, ...params) as any).n;
    // Special servicer inbound for the period
    const special_svc_vol = (db.prepare(`
      SELECT COALESCE(COUNT(*), 0) as n FROM aom_events_clean
      WHERE assignee_canon IN (${specialSvcPlaceholders}) ${dateWhere}
    `).get(...SPECIAL_SERVICERS, ...params) as any).n;
    return { bank_to_pe_total: bank_to_pe, inst_out_total: inst_out, active_pe_buyers, net_sellers_count: net_sellers, special_svc_vol };
  }

  // ─── GET /api/deal-intelligence/summary ───────────────────────────────────
  app.get('/api/deal-intelligence/summary', (req, res) => {
    const dr = parseDateRange(req.query as Record<string, string>);
    const cacheKey = makeCacheKey('/api/deal-intelligence/summary', { start: dr.start, end: dr.end });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    let payload: any;
    if (!dr.hasFilter) {
      // All-time: use pre-compiled statements (fast path)
      const bank_to_pe_total  = (diStmts.bankToPeTotal.get()  as any).n;
      const inst_out_total    = (diStmts.instOutTotal.get()    as any).n;
      const net_sellers_count = (diStmts.netSellersCount.get() as any).n;
      const active_pe_buyers  = (diStmts.activePeBuyers.get()  as any).n;
      const special_svc_vol   = (db.prepare(
        `SELECT COALESCE(SUM(inbound_vol),0) as n FROM entity_nodes WHERE entity IN (${specialSvcPlaceholders})`
      ).get(...SPECIAL_SERVICERS) as any).n;
      payload = { bank_to_pe_total, inst_out_total, net_sellers_count, active_pe_buyers, special_svc_vol, period: null, prior: null };
    } else {
      const currWhere  = `AND rec_date BETWEEN ? AND ?`;
      const currParams = [dr.start, dr.end];
      const priorWhere  = `AND rec_date BETWEEN ? AND ?`;
      const priorParams = [dr.priorStart, dr.priorEnd];
      const curr  = diCountsForPeriod(currWhere,  currParams);
      const prior = diCountsForPeriod(priorWhere, priorParams);
      payload = {
        ...curr,
        period: { start: dr.start, end: dr.end, days: dr.days },
        prior: { ...prior, start: dr.priorStart, end: dr.priorEnd },
      };
    }
    setCached(cacheKey, payload, 30 * 60 * 1000); // 30 min TTL for date-filtered
    res.json(payload);
  });

  // ─── GET /api/deal-intelligence/seller-pressure ───────────────────────────
  app.get('/api/deal-intelligence/seller-pressure', (req, res) => {
    const dr = parseDateRange(req.query as Record<string, string>);
    const cacheKey = makeCacheKey('/api/deal-intelligence/seller-pressure', { start: dr.start, end: dr.end });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    let data: any[];
    if (!dr.hasFilter) {
      data = diStmts.sellerPressure.all();
    } else {
      data = db.prepare(`
        SELECT entity, entity_type,
               SUM(CASE WHEN dir='out' THEN cnt ELSE 0 END) as outbound_vol,
               SUM(CASE WHEN dir='in'  THEN cnt ELSE 0 END) as inbound_vol,
               SUM(cnt) as total_vol,
               SUM(CASE WHEN dir='out' THEN cnt ELSE 0 END) -
               SUM(CASE WHEN dir='in'  THEN cnt ELSE 0 END) as net_outbound
        FROM (
          SELECT assignor_canon as entity, assignor_type as entity_type, 'out' as dir, COUNT(*) as cnt
          FROM aom_events_clean
          WHERE assignor_type IN ('BANK','SERVICER','TRUST')
            AND rec_date BETWEEN ? AND ?
          GROUP BY assignor_canon
          UNION ALL
          SELECT assignee_canon, assignee_type, 'in', COUNT(*)
          FROM aom_events_clean
          WHERE assignee_type IN ('BANK','SERVICER','TRUST')
            AND rec_date BETWEEN ? AND ?
          GROUP BY assignee_canon
        )
        GROUP BY entity
        HAVING total_vol >= 3
        ORDER BY net_outbound DESC
        LIMIT 25
      `).all(dr.start, dr.end, dr.start, dr.end) as any[];
    }
    setCached(cacheKey, data, 30 * 60 * 1000);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/pe-competitive ────────────────────────────
  app.get('/api/deal-intelligence/pe-competitive', (req, res) => {
    const dr = parseDateRange(req.query as Record<string, string>);
    const cacheKey = makeCacheKey('/api/deal-intelligence/pe-competitive', { start: dr.start, end: dr.end });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    let data: any[];
    if (!dr.hasFilter) {
      data = diStmts.peCompetitive.all();
    } else {
      data = db.prepare(`
        SELECT entity, entity_type,
               SUM(CASE WHEN dir='in'  THEN cnt ELSE 0 END) as inbound_vol,
               SUM(CASE WHEN dir='out' THEN cnt ELSE 0 END) as outbound_vol,
               SUM(cnt) as total_vol,
               MIN(rec_date) as first_seen, MAX(rec_date) as last_seen
        FROM (
          SELECT assignee_canon as entity, assignee_type as entity_type, 'in' as dir,
                 COUNT(*) as cnt, MIN(rec_date) as rec_date
          FROM aom_events_clean
          WHERE assignee_type='PRIVATE_CREDIT' AND rec_date BETWEEN ? AND ?
          GROUP BY assignee_canon
          UNION ALL
          SELECT assignor_canon, assignor_type, 'out', COUNT(*), MIN(rec_date)
          FROM aom_events_clean
          WHERE assignor_type='PRIVATE_CREDIT' AND rec_date BETWEEN ? AND ?
          GROUP BY assignor_canon
        )
        GROUP BY entity
        HAVING total_vol >= 1
        ORDER BY inbound_vol DESC
        LIMIT 20
      `).all(dr.start, dr.end, dr.start, dr.end) as any[];
    }
    setCached(cacheKey, data, 30 * 60 * 1000);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/special-servicers ────────────────────────
  app.get('/api/deal-intelligence/special-servicers', (req, res) => {
    const dr = parseDateRange(req.query as Record<string, string>);
    const cacheKey = makeCacheKey('/api/deal-intelligence/special-servicers', { start: dr.start, end: dr.end });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    let data: any[];
    if (!dr.hasFilter) {
      data = db.prepare(`
        SELECT entity, inbound_vol, outbound_vol, total_vol, first_seen, last_seen
        FROM entity_nodes WHERE entity IN (${specialSvcPlaceholders}) ORDER BY inbound_vol DESC
      `).all(...SPECIAL_SERVICERS) as any[];
    } else {
      data = db.prepare(`
        SELECT assignee_canon as entity,
               COUNT(*) as inbound_vol, 0 as outbound_vol, COUNT(*) as total_vol,
               MIN(rec_date) as first_seen, MAX(rec_date) as last_seen
        FROM aom_events_clean
        WHERE assignee_canon IN (${specialSvcPlaceholders})
          AND rec_date BETWEEN ? AND ?
        GROUP BY assignee_canon
        ORDER BY inbound_vol DESC
      `).all(...SPECIAL_SERVICERS, dr.start, dr.end) as any[];
    }
    setCached(cacheKey, data, 30 * 60 * 1000);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/bank-to-pe ────────────────────────────────
  app.get('/api/deal-intelligence/bank-to-pe', (req, res) => {
    const { page = '1', limit = '25', start_date = '', end_date = '' } = req.query as Record<string, string>;
    const dr = parseDateRange({ start_date, end_date });
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 25, 200);
    const offset   = (pageNum - 1) * limitNum;
    const cacheKey = makeCacheKey('/api/deal-intelligence/bank-to-pe', { page, limit, start: dr.start, end: dr.end });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const dateWhere = dr.hasFilter ? `AND c.rec_date BETWEEN '${dr.start}' AND '${dr.end}'` : '';
    const total = (db.prepare(`
      SELECT COUNT(*) as n FROM aom_events_clean c
      WHERE c.assignor_type='BANK' AND c.assignee_type='PRIVATE_CREDIT'
        AND c.txn_type='MARKET_TRANSFER' ${dateWhere}
    `).get() as any).n;
    const rows = db.prepare(`
      SELECT c.cfn, c.rec_date,
             c.assignor_canon AS seller, c.assignee_canon AS buyer,
             c.assignor, c.assignee, c.rec_book, c.rec_page
      FROM aom_events_clean c
      WHERE c.assignor_type='BANK' AND c.assignee_type='PRIVATE_CREDIT'
        AND c.txn_type='MARKET_TRANSFER' ${dateWhere}
      ORDER BY c.rec_date DESC LIMIT ? OFFSET ?
    `).all(limitNum, offset);
    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload, 30 * 60 * 1000);
    res.json(payload);
  });

  // ─── GET /api/deal-intelligence/monthly ───────────────────────────────────
  app.get('/api/deal-intelligence/monthly', (_req, res) => {
    const KEY = '/api/deal-intelligence/monthly';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = diStmts.monthlyDistressed.all();
    setCached(KEY, data);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/recent-bank-to-pe ────────────────────────
  app.get('/api/deal-intelligence/recent-bank-to-pe', (req, res) => {
    const dr = parseDateRange(req.query as Record<string, string>);
    const cacheKey = makeCacheKey('/api/deal-intelligence/recent-bank-to-pe', { start: dr.start, end: dr.end });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const dateWhere = dr.hasFilter
      ? `AND c.rec_date BETWEEN '${dr.start}' AND '${dr.end}'`
      : `AND c.rec_date >= date('now', '-180 days')`;
    const data = db.prepare(`
      SELECT c.rec_date, c.assignor_canon AS seller, c.assignee_canon AS buyer, COUNT(*) AS n
      FROM aom_events_clean c
      WHERE c.assignor_type='BANK' AND c.assignee_type='PRIVATE_CREDIT'
        AND c.txn_type='MARKET_TRANSFER' ${dateWhere}
      GROUP BY c.assignor_canon, c.assignee_canon
      ORDER BY n DESC LIMIT 10
    `).all();
    setCached(cacheKey, data, 30 * 60 * 1000);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/deal-detail/:cfn ──────────────────────────
  // Returns full filing + relationship intelligence for a single Bank→PE deal
  app.get('/api/deal-intelligence/deal-detail/:cfn', (req, res) => {
    const cfn = req.params.cfn;
    const cacheKey = `/api/deal-intelligence/deal-detail/${cfn}`;
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);

    const transaction = db.prepare(`
      SELECT c.cfn, c.rec_date, c.assignor, c.assignee,
             c.assignor_canon, c.assignee_canon,
             c.assignor_type, c.assignee_type,
             c.rec_book, c.rec_page, c.txn_type,
             a.address, a.legal_desc, a.misc_ref
      FROM aom_events_clean c
      LEFT JOIN assignments a ON c.cfn = a.cfn
      WHERE c.cfn = ?
    `).get(cfn) as any;

    if (!transaction) return res.status(404).json({ error: 'Not found' });

    const seller = transaction.assignor_canon;
    const buyer  = transaction.assignee_canon;

    // Full history between this exact pair (bank→PE market transfers only)
    const pairHistory = db.prepare(`
      SELECT cfn, rec_date FROM aom_events_clean
      WHERE assignor_canon = ? AND assignee_canon = ?
        AND assignor_type='BANK' AND assignee_type='PRIVATE_CREDIT'
        AND txn_type='MARKET_TRANSFER'
      ORDER BY rec_date DESC LIMIT 50
    `).all(seller, buyer) as any[];

    const totalPairDeals = pairHistory.length;
    const dealIndexFromLatest = pairHistory.findIndex((d: any) => d.cfn === cfn);
    // deal_number: 1 = most recent, totalPairDeals = oldest
    const dealNumber = dealIndexFromLatest >= 0 ? dealIndexFromLatest + 1 : null;

    // Seller & buyer node profiles
    const sellerProfile = db.prepare(
      'SELECT entity, entity_type, total_vol, inbound_vol, outbound_vol, degree, first_seen, last_seen FROM entity_nodes WHERE entity = ?'
    ).get(seller) as any;

    const buyerProfile = db.prepare(
      'SELECT entity, entity_type, total_vol, inbound_vol, outbound_vol, degree, first_seen, last_seen FROM entity_nodes WHERE entity = ?'
    ).get(buyer) as any;

    // Other PE funds this seller also sold to
    const sellerOtherBuyers = db.prepare(`
      SELECT assignee_canon AS buyer, COUNT(*) AS n FROM aom_events_clean
      WHERE assignor_canon = ? AND assignee_type = 'PRIVATE_CREDIT' AND txn_type = 'MARKET_TRANSFER'
      GROUP BY assignee_canon ORDER BY n DESC LIMIT 6
    `).all(seller) as any[];

    // Other banks this buyer also buys from
    const buyerOtherSellers = db.prepare(`
      SELECT assignor_canon AS seller, COUNT(*) AS n FROM aom_events_clean
      WHERE assignee_canon = ? AND assignor_type = 'BANK' AND txn_type = 'MARKET_TRANSFER'
      GROUP BY assignor_canon ORDER BY n DESC LIMIT 6
    `).all(buyer) as any[];

    // Monthly cadence for this pair (for sparkline)
    const pairMonthlyCadence = db.prepare(`
      SELECT strftime('%Y-%m', rec_date) AS month, COUNT(*) AS n FROM aom_events_clean
      WHERE assignor_canon = ? AND assignee_canon = ?
        AND assignor_type='BANK' AND assignee_type='PRIVATE_CREDIT'
        AND txn_type='MARKET_TRANSFER'
      GROUP BY month ORDER BY month DESC LIMIT 24
    `).all(seller, buyer) as any[];

    const payload = {
      transaction,
      relationship: {
        total_deals: totalPairDeals,
        first_deal:  pairHistory.length > 0 ? pairHistory[pairHistory.length - 1].rec_date : null,
        last_deal:   pairHistory.length > 0 ? pairHistory[0].rec_date : null,
        deal_number: dealNumber,
        recent_deals: pairHistory.slice(0, 10),
        monthly_cadence: pairMonthlyCadence.reverse(),
      },
      seller_profile: sellerProfile,
      buyer_profile:  buyerProfile,
      seller_other_buyers: sellerOtherBuyers,
      buyer_other_sellers: buyerOtherSellers,
    };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/fdic/financials ─────────────────────────────────────────────
  app.get('/api/fdic/financials', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const result = await fetchFDICFinancials(state);
    res.json(result);
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // TARGETS (user watchlist of market participants)
  // ═══════════════════════════════════════════════════════════════════════════

  // SQL fragment: transaction touches at least one targeted entity
  const TARGETS_MATCH = `(assignor_canon IN (SELECT entity FROM target_entities)
                       OR assignee_canon IN (SELECT entity FROM target_entities))`;

  // ─── GET /api/targets ─────────────────────────────────────────────────────
  // Watchlist with per-entity activity stats from the clean events table.
  app.get('/api/targets', (_req, res) => {
    const rows = db.prepare(`
      SELECT t.entity, t.added_at, t.notes,
             n.entity_type, n.inbound_vol, n.outbound_vol, n.total_vol,
             n.first_seen, n.last_seen,
             (SELECT COUNT(*) FROM aom_events_clean c
              WHERE (c.assignor_canon = t.entity OR c.assignee_canon = t.entity)
                AND c.rec_date >= date('now', '-90 days')) AS txns_90d,
             (SELECT MAX(rec_date) FROM aom_events_clean c
              WHERE c.assignor_canon = t.entity OR c.assignee_canon = t.entity) AS last_activity
      FROM target_entities t
      LEFT JOIN entity_nodes n ON n.entity = t.entity
      ORDER BY t.added_at DESC
    `).all();
    res.json(rows);
  });

  // ─── POST /api/targets ────────────────────────────────────────────────────
  app.post('/api/targets', (req, res) => {
    const { entity, notes } = req.body as { entity?: string; notes?: string };
    const name = (entity || '').trim().toUpperCase();
    if (!name) return res.status(400).json({ error: 'entity is required' });
    db.prepare(`
      INSERT INTO target_entities (entity, added_at, notes) VALUES (?, ?, ?)
      ON CONFLICT(entity) DO NOTHING
    `).run(name, new Date().toISOString(), notes || null);
    res.json({ ok: true, entity: name });
  });

  // ─── DELETE /api/targets/:entity ──────────────────────────────────────────
  app.delete('/api/targets/:entity', (req, res) => {
    const name = decodeURIComponent(req.params.entity);
    db.prepare(`DELETE FROM target_entities WHERE entity = ?`).run(name);
    res.json({ ok: true });
  });

  // ── Helper: parse ?entities= (repeatable) into a clean string array ────────
  function parseEntities(q: any): string[] {
    const raw = q.entities;
    if (!raw) return [];
    const arr = Array.isArray(raw) ? raw : [raw];
    return arr.map((e: string) => String(e).trim().toUpperCase()).filter(Boolean).slice(0, 50);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ENTITY ALIASES (entity-resolution crosswalk: merge duplicate entities)
  // ═══════════════════════════════════════════════════════════════════════════

  const TXN_TYPE_CASE = `
    CASE
      WHEN assignor_canon = assignee_canon THEN 'SELF_ASSIGN'
      WHEN assignor_type  = 'MERS'         THEN 'MERS_RELEASE'
      WHEN assignor_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST')
       AND assignee_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST') THEN 'MARKET_TRANSFER'
      WHEN assignor_type NOT IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST','MERS')
       AND assignee_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST') THEN 'ORIGINATION'
      WHEN assignor_type IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST')
       AND assignee_type NOT IN ('BANK','SERVICER','PRIVATE_CREDIT','GSE','TRUST','MERS') THEN 'INSTITUTIONAL_OUT'
      ELSE 'PRIVATE'
    END`;

  function clearMergeCaches() {
    clearCacheByPrefix('/api/entity');
    clearCacheByPrefix('/api/entity-nodes');
    clearCacheByPrefix('/api/deal-intelligence');
    clearCacheByPrefix('/api/network');
    clearCacheByPrefix('/api/stats');
    clearCacheByPrefix('/api/assignments');
    clearCacheByPrefix('/api/clean-events');
    clearCacheByPrefix('/api/flow-matrix');
    clearCacheByPrefix('/api/reporting');
    clearCacheByPrefix('/api/monthly-volume');
  }

  // Rebuild the entity_nodes row and entity_relationships rows for one canonical
  // entity from aom_events_clean (used after a merge collapses variants into it).
  function rebuildEntityAggregates(canonical: string, entityType: string | null) {
    const inb = db.prepare(`
      SELECT COUNT(*) cnt, COUNT(DISTINCT assignor_canon) deg, MIN(rec_date) fs, MAX(rec_date) ls
      FROM aom_events_clean WHERE assignee_canon = ?
    `).get(canonical) as any;
    const outb = db.prepare(`
      SELECT COUNT(*) cnt, COUNT(DISTINCT assignee_canon) deg, MIN(rec_date) fs, MAX(rec_date) ls
      FROM aom_events_clean WHERE assignor_canon = ?
    `).get(canonical) as any;

    const dates = [inb.fs, inb.ls, outb.fs, outb.ls].filter(Boolean).sort();
    db.prepare(`DELETE FROM entity_nodes WHERE entity = ?`).run(canonical);
    db.prepare(`
      INSERT INTO entity_nodes (entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      canonical, inb.cnt, outb.cnt, inb.cnt + outb.cnt, inb.deg + outb.deg,
      entityType || 'OTHER', dates[0] ?? null, dates[dates.length - 1] ?? null,
    );

    db.prepare(`DELETE FROM entity_relationships WHERE source_entity = ? OR target_entity = ?`).run(canonical, canonical);
    db.prepare(`
      INSERT OR REPLACE INTO entity_relationships (source_entity, target_entity, transaction_count, first_seen_date, last_seen_date)
      SELECT assignor_canon, assignee_canon, COUNT(*), MIN(rec_date), MAX(rec_date)
      FROM aom_events_clean
      WHERE (assignor_canon = ? OR assignee_canon = ?) AND assignor_canon != assignee_canon
        AND assignor_canon != 'UNKNOWN' AND assignee_canon != 'UNKNOWN'
      GROUP BY assignor_canon, assignee_canon
    `).run(canonical, canonical);
  }

  // ─── GET /api/aliases ─────────────────────────────────────────────────────
  // Existing merges, grouped by canonical name.
  app.get('/api/aliases', (_req, res) => {
    const rows = db.prepare(`
      SELECT a.variant, a.canonical, a.created_at, a.note,
             n.total_vol AS canonical_vol, n.entity_type AS canonical_type
      FROM entity_aliases a
      LEFT JOIN entity_nodes n ON n.entity = a.canonical
      ORDER BY a.canonical, a.variant
    `).all();
    res.json(rows);
  });

  // ─── POST /api/aliases/merge ──────────────────────────────────────────────
  // Body: { canonical: string, variants: string[] }
  // Records the alias rules and immediately cascades the merge through
  // aom_events_clean, entity_nodes, entity_relationships and target_entities.
  app.post('/api/aliases/merge', (req, res) => {
    const { canonical, variants } = req.body as { canonical?: string; variants?: string[] };
    const canon = (canonical || '').trim().toUpperCase();
    const vars = (variants || []).map(v => String(v).trim().toUpperCase())
      .filter(v => v && v !== canon);
    if (!canon || vars.length === 0) {
      return res.status(400).json({ error: 'canonical and at least one distinct variant are required' });
    }
    if (vars.length > 50) return res.status(400).json({ error: 'Too many variants in one merge (max 50)' });

    const now = new Date().toISOString();
    const varPh = vars.map(() => '?').join(',');

    // Determine entity type for the golden record before variant rows disappear:
    // keep the canonical's current type, else the best-classified variant type.
    const typeRow = db.prepare(`
      SELECT entity_type FROM entity_nodes
      WHERE entity IN (?, ${varPh})
      ORDER BY CASE WHEN entity = ? THEN 0 ELSE 1 END,
               CASE WHEN entity_type IS NOT NULL AND entity_type != 'OTHER' THEN 0 ELSE 1 END,
               total_vol DESC
    `).get(canon, ...vars, canon) as any;
    const entityType = typeRow?.entity_type ?? null;

    const doMerge = db.transaction(() => {
      // Record alias rules; re-point any earlier merges whose target is now itself merged
      for (const v of vars) {
        db.prepare(`
          INSERT INTO entity_aliases (variant, canonical, created_at, created_by, note)
          VALUES (?, ?, ?, 'user', NULL)
          ON CONFLICT(variant) DO UPDATE SET canonical = excluded.canonical, created_at = excluded.created_at
        `).run(v, canon, now);
      }
      db.prepare(`UPDATE entity_aliases SET canonical = ? WHERE canonical IN (${varPh})`).run(canon, ...vars);

      // Cascade into the clean events table
      db.prepare(`UPDATE aom_events_clean SET assignor_canon = ?, assignor_type = COALESCE(?, assignor_type) WHERE assignor_canon IN (${varPh})`).run(canon, entityType, ...vars);
      db.prepare(`UPDATE aom_events_clean SET assignee_canon = ?, assignee_type = COALESCE(?, assignee_type) WHERE assignee_canon IN (${varPh})`).run(canon, entityType, ...vars);

      // Re-derive txn_type for everything touching the golden record
      db.prepare(`UPDATE aom_events_clean SET txn_type = ${TXN_TYPE_CASE} WHERE assignor_canon = ? OR assignee_canon = ?`).run(canon, canon);

      // Watchlist follows the merge
      const inWatchlist = db.prepare(`SELECT entity, added_at, notes FROM target_entities WHERE entity IN (${varPh})`).all(...vars) as any[];
      if (inWatchlist.length > 0) {
        db.prepare(`
          INSERT INTO target_entities (entity, added_at, notes) VALUES (?, ?, ?)
          ON CONFLICT(entity) DO NOTHING
        `).run(canon, inWatchlist[0].added_at || now, inWatchlist[0].notes || null);
        db.prepare(`DELETE FROM target_entities WHERE entity IN (${varPh})`).run(...vars);
      }

      // Rebuild aggregates for the golden record; drop the variants' node rows
      db.prepare(`DELETE FROM entity_nodes WHERE entity IN (${varPh})`).run(...vars);
      db.prepare(`DELETE FROM entity_relationships WHERE source_entity IN (${varPh}) OR target_entity IN (${varPh})`).run(...vars, ...vars);
      rebuildEntityAggregates(canon, entityType);
    });
    doMerge();

    clearMergeCaches();
    const node = db.prepare(`SELECT * FROM entity_nodes WHERE entity = ?`).get(canon);
    res.json({ ok: true, canonical: canon, merged: vars, node });
  });

  // ─── DELETE /api/aliases/:variant ─────────────────────────────────────────
  // Removes a merge rule. Historical rows revert on the next data rebuild
  // (normalize.py re-derives canonical names from the preserved raw names).
  app.delete('/api/aliases/:variant', (req, res) => {
    const variant = decodeURIComponent(req.params.variant);
    const info = db.prepare(`DELETE FROM entity_aliases WHERE variant = ?`).run(variant);
    clearMergeCaches();
    res.json({ ok: true, removed: info.changes > 0, note: 'Data reverts on next pipeline rebuild (normalize.py)' });
  });

  // ─── GET /api/aliases/suggestions ─────────────────────────────────────────
  // Candidate duplicate clusters via blocking heuristics:
  //  - exact match when spaces/punctuation removed  (BANESCOUSA vs BANESCO USA)
  //  - exact match on sorted tokens                 (USA BANESCO vs BANESCO USA)
  //  - prefix extension (possible truncation)       (MCLP ASSET vs MCLP ASSET COMPANY)
  app.get('/api/aliases/suggestions', (_req, res) => {
    const nodes = db.prepare(`
      SELECT entity, entity_type, total_vol FROM entity_nodes
      WHERE total_vol >= 2 AND entity != 'UNKNOWN'
    `).all() as any[];
    const aliased = new Set((db.prepare(`SELECT variant FROM entity_aliases`).all() as any[]).map(r => r.variant));
    const dismissed = new Set((db.prepare(`SELECT cluster_key FROM alias_suggestion_dismissals`).all() as any[]).map(r => r.cluster_key));

    const active = nodes.filter(n => !aliased.has(n.entity));
    const byNoSpace = new Map<string, any[]>();
    const byTokens = new Map<string, any[]>();
    for (const n of active) {
      const ns = n.entity.replace(/[^A-Z0-9]/g, '');
      const tk = n.entity.split(/\s+/).sort().join(' ');
      if (!byNoSpace.has(ns)) byNoSpace.set(ns, []);
      byNoSpace.get(ns)!.push(n);
      if (!byTokens.has(tk)) byTokens.set(tk, []);
      byTokens.get(tk)!.push(n);
    }

    type Suggestion = { key: string; reason: string; entities: any[]; suggested_canonical: string; combined_vol: number };
    const out = new Map<string, Suggestion>();

    const addCluster = (group: any[], reason: string) => {
      if (group.length < 2) return;
      const names = group.map(g => g.entity).sort();
      const key = names.join('|');
      if (dismissed.has(key) || out.has(key)) return;
      const best = [...group].sort((a, b) => b.total_vol - a.total_vol)[0];
      out.set(key, {
        key, reason, entities: group,
        suggested_canonical: best.entity,
        combined_vol: group.reduce((s, g) => s + g.total_vol, 0),
      });
    };

    Array.from(byNoSpace.values()).forEach(group => addCluster(group, 'variant'));
    Array.from(byTokens.values()).forEach(group => addCluster(group, 'variant'));

    // Truncation pairs — sorted scan keeps this O(n·k)
    const sorted = [...active].sort((a, b) => a.entity.localeCompare(b.entity));
    for (let i = 0; i < sorted.length; i++) {
      const a = sorted[i];
      if (a.entity.length < 8) continue;
      for (let j = i + 1; j < Math.min(i + 8, sorted.length); j++) {
        const b = sorted[j];
        if (b.entity.startsWith(a.entity + ' ')) addCluster([a, b], 'truncation');
      }
    }

    const suggestions = Array.from(out.values()).sort((a, b) => {
      if (a.reason !== b.reason) return a.reason === 'variant' ? -1 : 1;
      return b.combined_vol - a.combined_vol;
    }).slice(0, 300);

    res.json({
      suggestions,
      counts: {
        variant: suggestions.filter(s => s.reason === 'variant').length,
        truncation: suggestions.filter(s => s.reason === 'truncation').length,
      },
    });
  });

  // ─── POST /api/aliases/suggestions/dismiss ────────────────────────────────
  app.post('/api/aliases/suggestions/dismiss', (req, res) => {
    const { key } = req.body as { key?: string };
    if (!key) return res.status(400).json({ error: 'key is required' });
    db.prepare(`
      INSERT INTO alias_suggestion_dismissals (cluster_key, dismissed_at) VALUES (?, ?)
      ON CONFLICT(cluster_key) DO NOTHING
    `).run(key, new Date().toISOString());
    res.json({ ok: true });
  });

  // ─── GET /api/reporting/entity-report ─────────────────────────────────────
  // Dynamic report for specific entities over a time window.
  // ?entities=A&entities=B&start_date=&end_date=
  app.get('/api/reporting/entity-report', (req, res) => {
    const entities = parseEntities(req.query);
    if (entities.length === 0) return res.status(400).json({ error: 'At least one entity is required' });
    const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : '';
    const endDate   = typeof req.query.end_date === 'string' ? req.query.end_date : '';

    const ph = entities.map(() => '?').join(',');
    let dateWhere = '';
    const dateParams: any[] = [];
    if (startDate) { dateWhere += ' AND rec_date >= ?'; dateParams.push(startDate); }
    if (endDate)   { dateWhere += ' AND rec_date <= ?'; dateParams.push(endDate); }

    // KPIs — distinct filings touching the selection
    const kpis = db.prepare(`
      SELECT COUNT(*) AS total,
             SUM(CASE WHEN assignee_canon IN (${ph}) THEN 1 ELSE 0 END) AS inbound,
             SUM(CASE WHEN assignor_canon IN (${ph}) THEN 1 ELSE 0 END) AS outbound,
             SUM(CASE WHEN loan_amount > 0 THEN loan_amount ELSE 0 END) AS dollar_volume,
             SUM(CASE WHEN loan_amount > 0 THEN 1 ELSE 0 END) AS dollar_known_count
      FROM aom_events_clean
      WHERE (assignor_canon IN (${ph}) OR assignee_canon IN (${ph}))
        AND txn_type != 'SELF_ASSIGN' ${dateWhere}
    `).get(...entities, ...entities, ...entities, ...entities, ...dateParams) as any;

    // Timeline — per entity per month, in/out counts
    const timeline = db.prepare(`
      SELECT strftime('%Y-%m', rec_date) AS month, entity,
             SUM(inb) AS in_count, SUM(outb) AS out_count
      FROM (
        SELECT rec_date, assignee_canon AS entity, 1 AS inb, 0 AS outb
        FROM aom_events_clean
        WHERE assignee_canon IN (${ph}) AND txn_type != 'SELF_ASSIGN' ${dateWhere}
        UNION ALL
        SELECT rec_date, assignor_canon, 0, 1
        FROM aom_events_clean
        WHERE assignor_canon IN (${ph}) AND txn_type != 'SELF_ASSIGN' ${dateWhere}
      )
      GROUP BY month, entity ORDER BY month
    `).all(...entities, ...dateParams, ...entities, ...dateParams) as any[];

    // Counterparties — who the selection sold to / bought from (outside the selection)
    const counterparties = db.prepare(`
      SELECT counterparty, counterparty_type,
             SUM(sold) AS sold_to, SUM(bought) AS bought_from,
             SUM(sold) + SUM(bought) AS total
      FROM (
        SELECT assignee_canon AS counterparty, assignee_type AS counterparty_type, 1 AS sold, 0 AS bought
        FROM aom_events_clean
        WHERE assignor_canon IN (${ph}) AND assignee_canon NOT IN (${ph})
          AND txn_type != 'SELF_ASSIGN' ${dateWhere}
        UNION ALL
        SELECT assignor_canon, assignor_type, 0, 1
        FROM aom_events_clean
        WHERE assignee_canon IN (${ph}) AND assignor_canon NOT IN (${ph})
          AND txn_type != 'SELF_ASSIGN' ${dateWhere}
      )
      WHERE counterparty IS NOT NULL AND counterparty != 'UNKNOWN'
      GROUP BY counterparty ORDER BY total DESC LIMIT 15
    `).all(...entities, ...entities, ...dateParams, ...entities, ...entities, ...dateParams) as any[];

    // Per-entity summary (also feeds the bought-vs-sold chart)
    const summary = entities.map(entity => {
      const row = db.prepare(`
        SELECT
          SUM(CASE WHEN assignee_canon = ? THEN 1 ELSE 0 END) AS inbound,
          SUM(CASE WHEN assignor_canon = ? THEN 1 ELSE 0 END) AS outbound,
          SUM(CASE WHEN loan_amount > 0 THEN loan_amount ELSE 0 END) AS dollar_volume,
          MIN(rec_date) AS first_activity, MAX(rec_date) AS last_activity
        FROM aom_events_clean
        WHERE (assignor_canon = ? OR assignee_canon = ?)
          AND txn_type != 'SELF_ASSIGN' ${dateWhere}
      `).get(entity, entity, entity, entity, ...dateParams) as any;
      const topCp = db.prepare(`
        SELECT counterparty, COUNT(*) AS n FROM (
          SELECT assignee_canon AS counterparty FROM aom_events_clean
          WHERE assignor_canon = ? AND assignee_canon != ? AND txn_type != 'SELF_ASSIGN' ${dateWhere}
          UNION ALL
          SELECT assignor_canon FROM aom_events_clean
          WHERE assignee_canon = ? AND assignor_canon != ? AND txn_type != 'SELF_ASSIGN' ${dateWhere}
        )
        WHERE counterparty IS NOT NULL AND counterparty != 'UNKNOWN'
        GROUP BY counterparty ORDER BY n DESC LIMIT 1
      `).get(entity, entity, ...dateParams, entity, entity, ...dateParams) as any;
      const node = db.prepare('SELECT entity_type FROM entity_nodes WHERE entity = ?').get(entity) as any;
      return {
        entity,
        entity_type: node?.entity_type || null,
        inbound: row?.inbound ?? 0,
        outbound: row?.outbound ?? 0,
        net: (row?.inbound ?? 0) - (row?.outbound ?? 0),
        dollar_volume: row?.dollar_volume ?? 0,
        first_activity: row?.first_activity ?? null,
        last_activity: row?.last_activity ?? null,
        top_counterparty: topCp?.counterparty ?? null,
        top_counterparty_count: topCp?.n ?? 0,
      };
    });

    res.json({
      entities, start_date: startDate || null, end_date: endDate || null,
      kpis, timeline, counterparties, summary,
    });
  });

  // ─── GET /api/reporting ───────────────────────────────────────────────────
  app.get('/api/reporting', (req, res) => {
    const page      = Math.max(1, parseInt(req.query.page as string) || 1);
    const limit     = Math.min(50, parseInt(req.query.limit as string) || 50);
    const offset    = (page - 1) * limit;
    const search    = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : '';
    const endDate   = typeof req.query.end_date === 'string' ? req.query.end_date : '';
    const reviewed  = typeof req.query.reviewed === 'string' ? req.query.reviewed : '';
    const targetsOnly = req.query.targets === '1';
    const entities  = parseEntities(req.query);

    const clauses: string[] = [];
    const params: any[] = [];

    if (search) {
      clauses.push(`(UPPER(assignor_canon) LIKE UPPER(?) OR UPPER(assignee_canon) LIKE UPPER(?) OR cfn LIKE ?)`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (entities.length > 0) {
      const ph = entities.map(() => '?').join(',');
      clauses.push(`(assignor_canon IN (${ph}) OR assignee_canon IN (${ph}))`);
      params.push(...entities, ...entities);
    }
    if (startDate) { clauses.push(`rec_date >= ?`); params.push(startDate); }
    if (endDate)   { clauses.push(`rec_date <= ?`); params.push(endDate); }
    if (reviewed === 'yes') { clauses.push(`reviewed_at IS NOT NULL`); }
    if (reviewed === 'no')  { clauses.push(`reviewed_at IS NULL`); }
    if (targetsOnly) { clauses.push(TARGETS_MATCH); }

    // Always exclude self-assignments — not true transfers
    clauses.push(`txn_type != 'SELF_ASSIGN'`);
    const wc = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const total = (db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean ${wc}`).get(...params) as any).n;
    const rows  = db.prepare(`
      SELECT cfn, rec_date, doc_type,
             assignor, assignee, assignor_canon, assignee_canon,
             assignor_type, assignee_type, txn_type,
             pdf_assignor, pdf_assignee, assignor_parent, assignee_parent,
             property_address, loan_amount, consideration_amount,
             doc_title, doc_category,
             folio_parcel, sponsor_address, signatory_officer,
             rec_book, rec_page, total_parties,
             classification, reviewed_by, reviewed_at
      FROM aom_events_clean ${wc}
      ORDER BY rec_date DESC LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    res.json({ rows, total, pages: Math.ceil(total / limit), page });
  });

  // ─── PATCH /api/reporting/:cfn/review ────────────────────────────────────
  app.patch('/api/reporting/:cfn/review', (req, res) => {
    const { cfn } = req.params;
    const { reviewed_by, classification } = req.body as any;
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE aom_events_clean
      SET reviewed_by = ?, reviewed_at = ?, classification = COALESCE(?, classification)
      WHERE cfn = ?
    `).run(reviewed_by || 'user', now, classification || null, cfn);
    res.json({ ok: true, reviewed_at: now });
  });

  // ─── DELETE /api/reporting/:cfn/review ───────────────────────────────────
  app.delete('/api/reporting/:cfn/review', (req, res) => {
    const { cfn } = req.params;
    db.prepare(`UPDATE aom_events_clean SET reviewed_by = NULL, reviewed_at = NULL WHERE cfn = ?`).run(cfn);
    res.json({ ok: true });
  });

  // ─── GET /api/reporting/export ───────────────────────────────────────────
  app.get('/api/reporting/export', (req, res) => {
    const search    = typeof req.query.search === 'string' ? req.query.search.trim() : '';
    const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : '';
    const endDate   = typeof req.query.end_date === 'string' ? req.query.end_date : '';
    const reviewed  = typeof req.query.reviewed === 'string' ? req.query.reviewed : '';
    const targetsOnly = req.query.targets === '1';
    const entities  = parseEntities(req.query);

    const clauses: string[] = [];
    const params: any[] = [];
    if (search) {
      clauses.push(`(UPPER(assignor_canon) LIKE UPPER(?) OR UPPER(assignee_canon) LIKE UPPER(?) OR cfn LIKE ?)`);
      params.push(`%${search}%`, `%${search}%`, `%${search}%`);
    }
    if (entities.length > 0) {
      const ph = entities.map(() => '?').join(',');
      clauses.push(`(assignor_canon IN (${ph}) OR assignee_canon IN (${ph}))`);
      params.push(...entities, ...entities);
    }
    if (startDate) { clauses.push(`rec_date >= ?`); params.push(startDate); }
    if (endDate)   { clauses.push(`rec_date <= ?`); params.push(endDate); }
    if (reviewed === 'yes') { clauses.push(`reviewed_at IS NOT NULL`); }
    if (reviewed === 'no')  { clauses.push(`reviewed_at IS NULL`); }
    if (targetsOnly) { clauses.push(TARGETS_MATCH); }
    clauses.push(`txn_type != 'SELF_ASSIGN'`);
    const wc = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

    const rows = db.prepare(`
      SELECT cfn, rec_date, doc_type, doc_category, doc_title,
             assignor_canon AS assignor, assignee_canon AS assignee,
             assignor_type, assignee_type, txn_type,
             pdf_assignor, pdf_assignee, assignor_parent, assignee_parent,
             property_address, folio_parcel, loan_amount, consideration_amount,
             sponsor_address, signatory_officer,
             rec_book, rec_page,
             classification, reviewed_by, reviewed_at
      FROM aom_events_clean ${wc}
      ORDER BY rec_date DESC
    `).all(...params) as any[];

    const escape = (v: any) => {
      if (v === null || v === undefined) return '';
      const s = String(v);
      return s.includes(',') || s.includes('"') || s.includes('\n')
        ? `"${s.replace(/"/g, '""')}"` : s;
    };

    const docLink = (r: any) =>
      r.rec_book && r.rec_page
        ? `https://onlineservices.miamidadeclerk.gov/officialrecords/api/DocumentImage/getdocumentimage?redact=false&sBook=${encodeURIComponent(r.rec_book)}&sBookType=O+&sPage=${encodeURIComponent(r.rec_page)}`
        : '';

    const headers = [
      'CFN','Document Link','Date','Doc Type','Category','Title',
      'Assignor','Assignee','Assignor Type','Assignee Type','Txn Type',
      'PDF Assignor','PDF Assignee','Assignor Parent','Assignee Parent',
      'Property Address','Folio/Parcel','Loan Amount','Consideration',
      'Sponsor Address','Signatory Officer',
      'Book','Page','Classification','Reviewed By','Reviewed At',
    ];

    const csv = [
      headers.join(','),
      ...rows.map(r => [
        r.cfn, docLink(r), r.rec_date, r.doc_type, r.doc_category, r.doc_title,
        r.assignor, r.assignee, r.assignor_type, r.assignee_type, r.txn_type,
        r.pdf_assignor, r.pdf_assignee, r.assignor_parent, r.assignee_parent,
        r.property_address, r.folio_parcel, r.loan_amount, r.consideration_amount,
        r.sponsor_address, r.signatory_officer,
        r.rec_book, r.rec_page, r.classification, r.reviewed_by, r.reviewed_at,
      ].map(escape).join(',')),
    ].join('\n');

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="amo-reporting-${new Date().toISOString().slice(0,10)}.csv"`);
    res.send(csv);
  });

  // ─── GET /api/reporting/participants ──────────────────────────────────────
  app.get('/api/reporting/participants', (req, res) => {
    const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : '';
    const endDate   = typeof req.query.end_date === 'string' ? req.query.end_date : '';
    const targetsOnly = req.query.targets === '1';
    const clauses: string[] = [];
    const params: any[] = [];
    if (startDate) { clauses.push(`rec_date >= ?`); params.push(startDate); }
    if (endDate)   { clauses.push(`rec_date <= ?`); params.push(endDate); }
    if (targetsOnly) { clauses.push(TARGETS_MATCH); }

    const sellerClauses = [...clauses, `assignor_canon IS NOT NULL`, `assignor_canon != 'UNKNOWN'`];
    if (targetsOnly) sellerClauses.push(`assignor_canon IN (SELECT entity FROM target_entities)`);
    const topSellers = db.prepare(`
      SELECT assignor_canon AS entity, assignor_type AS entity_type,
             COUNT(*) AS transfers_out,
             SUM(loan_amount) AS total_loan_amount
      FROM aom_events_clean
      WHERE ${sellerClauses.join(' AND ')}
      GROUP BY assignor_canon ORDER BY transfers_out DESC LIMIT 20
    `).all(...params);

    const buyerClauses = [...clauses, `assignee_canon IS NOT NULL`, `assignee_canon != 'UNKNOWN'`];
    if (targetsOnly) buyerClauses.push(`assignee_canon IN (SELECT entity FROM target_entities)`);
    const topBuyers = db.prepare(`
      SELECT assignee_canon AS entity, assignee_type AS entity_type,
             COUNT(*) AS transfers_in,
             SUM(loan_amount) AS total_loan_amount
      FROM aom_events_clean
      WHERE ${buyerClauses.join(' AND ')}
      GROUP BY assignee_canon ORDER BY transfers_in DESC LIMIT 20
    `).all(...params);

    const mostActive = db.prepare(`
      SELECT entity, entity_type,
             inbound_vol AS transfers_in,
             outbound_vol AS transfers_out,
             total_vol AS total,
             first_seen, last_seen
      FROM entity_nodes
      ${targetsOnly ? 'WHERE entity IN (SELECT entity FROM target_entities)' : ''}
      ORDER BY total_vol DESC LIMIT 20
    `).all();

    res.json({ topSellers, topBuyers, mostActive });
  });

  // ─── GET /api/reporting/chart ─────────────────────────────────────────────
  app.get('/api/reporting/chart', (req, res) => {
    const type      = typeof req.query.type === 'string' ? req.query.type : 'monthly';
    const startDate = typeof req.query.start_date === 'string' ? req.query.start_date : '';
    const endDate   = typeof req.query.end_date === 'string' ? req.query.end_date : '';
    const targetsOnly = req.query.targets === '1';

    const dateClauses: string[] = [];
    const dateParams: any[] = [];
    if (startDate) { dateClauses.push(`rec_date >= ?`); dateParams.push(startDate); }
    if (endDate)   { dateClauses.push(`rec_date <= ?`); dateParams.push(endDate); }
    if (targetsOnly) { dateClauses.push(TARGETS_MATCH); }
    const dwc = dateClauses.length ? `WHERE ${dateClauses.join(' AND ')}` : '';

    if (type === 'monthly') {
      const rows = db.prepare(`
        SELECT strftime('%Y-%m', rec_date) as period, COUNT(*) as count,
               SUM(loan_amount) as total_loan_amount
        FROM aom_events_clean ${dwc}
        GROUP BY period ORDER BY period
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'txn_type') {
      const rows = db.prepare(`
        SELECT COALESCE(txn_type, 'UNKNOWN') as label, COUNT(*) as count
        FROM aom_events_clean ${dwc}
        GROUP BY txn_type ORDER BY count DESC
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'top_buyers') {
      const rows = db.prepare(`
        SELECT assignee_canon as label, COUNT(*) as count
        FROM aom_events_clean
        WHERE ${[...dateClauses, 'assignee_canon IS NOT NULL'].join(' AND ')}
        GROUP BY assignee_canon ORDER BY count DESC LIMIT 15
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'top_sellers') {
      const rows = db.prepare(`
        SELECT assignor_canon as label, COUNT(*) as count
        FROM aom_events_clean
        WHERE ${[...dateClauses, 'assignor_canon IS NOT NULL'].join(' AND ')}
        GROUP BY assignor_canon ORDER BY count DESC LIMIT 15
      `).all(...dateParams);
      return res.json(rows);
    }

    if (type === 'entity_type') {
      const rows = db.prepare(`
        SELECT COALESCE(assignee_type, 'OTHER') as label, COUNT(*) as count
        FROM aom_events_clean ${dwc}
        GROUP BY assignee_type ORDER BY count DESC
      `).all(...dateParams);
      return res.json(rows);
    }

    res.status(400).json({ error: 'Unknown chart type' });
  });

  return httpServer;
}
