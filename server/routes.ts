import type { Express } from 'express';
import type { Server } from 'http';
import { getDb } from './db';
import { fetchFDICFinancials } from './fdic';
import {
  getCached, setCached, clearCache, getCacheStats,
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
             assignor_type, assignee_type, txn_type, rec_book, rec_page, total_parties
      FROM aom_events_clean ${wc}
      ORDER BY rec_date DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload);
    res.json(payload);
  });

  // ─── GET /api/entity-nodes ────────────────────────────────────────────────
  app.get('/api/entity-nodes', (req, res) => {
    const { q, type } = req.query as Record<string, string>;
    const cacheKey = makeCacheKey('/api/entity-nodes', { q, type });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    let sql = 'SELECT entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen FROM entity_nodes';
    const params: any[] = [];
    const where: string[] = [];
    if (q)    { where.push('UPPER(entity) LIKE UPPER(?)'); params.push(`%${q}%`); }
    if (type) { where.push('entity_type = ?'); params.push(type); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY total_vol DESC LIMIT 200';
    const data = db.prepare(sql).all(...params);
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
      WHERE entity_type IN ('BANK','SERVICER')
        AND outbound_vol > inbound_vol * 1.5
        AND total_vol >= 20
    `),
    activePeBuyers: db.prepare(`
      SELECT COUNT(DISTINCT assignee_canon) as n FROM aom_events_clean
      WHERE assignee_type='PRIVATE_CREDIT'
        AND assignor_type IN ('BANK','SERVICER','GSE')
    `),
    sellerPressure: db.prepare(`
      SELECT entity, entity_type,
             inbound_vol, outbound_vol, total_vol,
             (outbound_vol - inbound_vol) AS net_outbound,
             first_seen, last_seen
      FROM entity_nodes
      WHERE entity_type IN ('BANK','SERVICER')
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

  // ─── GET /api/deal-intelligence/summary ───────────────────────────────────
  app.get('/api/deal-intelligence/summary', (_req, res) => {
    const KEY = '/api/deal-intelligence/summary';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const bank_to_pe_total  = (diStmts.bankToPeTotal.get()  as any).n;
    const inst_out_total    = (diStmts.instOutTotal.get()    as any).n;
    const net_sellers_count = (diStmts.netSellersCount.get() as any).n;
    const active_pe_buyers  = (diStmts.activePeBuyers.get() as any).n;
    const special_svc_vol = (db.prepare(`
      SELECT COALESCE(SUM(inbound_vol),0) as n FROM entity_nodes
      WHERE entity IN (${specialSvcPlaceholders})
    `).get(...SPECIAL_SERVICERS) as any).n;
    const payload = { bank_to_pe_total, inst_out_total, net_sellers_count, active_pe_buyers, special_svc_vol };
    setCached(KEY, payload);
    res.json(payload);
  });

  // ─── GET /api/deal-intelligence/seller-pressure ───────────────────────────
  app.get('/api/deal-intelligence/seller-pressure', (_req, res) => {
    const KEY = '/api/deal-intelligence/seller-pressure';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = diStmts.sellerPressure.all();
    setCached(KEY, data);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/pe-competitive ────────────────────────────
  app.get('/api/deal-intelligence/pe-competitive', (_req, res) => {
    const KEY = '/api/deal-intelligence/pe-competitive';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = diStmts.peCompetitive.all();
    setCached(KEY, data);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/special-servicers ────────────────────────
  app.get('/api/deal-intelligence/special-servicers', (_req, res) => {
    const KEY = '/api/deal-intelligence/special-servicers';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = db.prepare(`
      SELECT entity, inbound_vol, outbound_vol, total_vol, first_seen, last_seen
      FROM entity_nodes
      WHERE entity IN (${specialSvcPlaceholders})
      ORDER BY inbound_vol DESC
    `).all(...SPECIAL_SERVICERS);
    setCached(KEY, data);
    res.json(data);
  });

  // ─── GET /api/deal-intelligence/bank-to-pe ────────────────────────────────
  app.get('/api/deal-intelligence/bank-to-pe', (req, res) => {
    const { page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum  = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 200);
    const offset   = (pageNum - 1) * limitNum;
    const cacheKey = makeCacheKey('/api/deal-intelligence/bank-to-pe', { page, limit });
    const cached = getCached(cacheKey);
    if (cached) return res.json(cached);
    const total = (diStmts.bankToPeCount.get() as any).n;
    const rows  = diStmts.bankToPeRows.all(limitNum, offset);
    const payload = { total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows };
    setCached(cacheKey, payload);
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
  app.get('/api/deal-intelligence/recent-bank-to-pe', (_req, res) => {
    const KEY = '/api/deal-intelligence/recent-bank-to-pe';
    const cached = getCached(KEY);
    if (cached) return res.json(cached);
    const data = diStmts.recentBankToPe.all();
    setCached(KEY, data);
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

  return httpServer;
}
