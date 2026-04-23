import type { Express } from 'express';
import type { Server } from 'http';
import { getDb } from './db';
import { fetchFDICFinancials } from './fdic';

export async function registerRoutes(httpServer: Server, app: Express) {
  const db = getDb();

  // ─── GET /api/stats ───────────────────────────────────────────────────────
  app.get('/api/stats', (_req, res) => {
    const total = (db.prepare('SELECT COUNT(*) as n FROM assignments').get() as any).n;
    const unique_cfns = (db.prepare('SELECT COUNT(DISTINCT cfn) as n FROM assignments').get() as any).n;
    const { min_date, max_date } = db.prepare('SELECT MIN(rec_date) as min_date, MAX(rec_date) as max_date FROM assignments').get() as any;
    const unique_grantors = (db.prepare('SELECT COUNT(DISTINCT grantor) as n FROM assignments').get() as any).n;
    const unique_grantees = (db.prepare('SELECT COUNT(DISTINCT grantee) as n FROM assignments').get() as any).n;
    const private_credit_txns = (db.prepare(`
      SELECT COUNT(*) as n FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      WHERE ec_g.category='PRIVATE_CREDIT' OR ec_a.category='PRIVATE_CREDIT'
    `).get() as any).n;
    const collection_log_count = (db.prepare('SELECT COUNT(*) as n FROM collection_log').get() as any).n;
    const last_collected = (db.prepare(`SELECT MAX(date_to) as dt FROM collection_log WHERE status='OK'`).get() as any)?.dt;

    res.json({ total, unique_cfns, min_date, max_date, unique_grantors, unique_grantees, private_credit_txns, collection_log_count, last_collected });
  });

  // ─── GET /api/monthly-volume ──────────────────────────────────────────────
  app.get('/api/monthly-volume', (_req, res) => {
    const rows = db.prepare(`
      SELECT strftime('%Y-%m', rec_date) as month,
        COUNT(*) as total,
        COUNT(DISTINCT cfn) as unique_cfns,
        COUNT(DISTINCT grantor) as unique_grantors,
        COUNT(DISTINCT grantee) as unique_grantees
      FROM assignments GROUP BY month ORDER BY month
    `).all();
    res.json(rows);
  });

  // ─── GET /api/top-assignors ───────────────────────────────────────────────
  app.get('/api/top-assignors', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 25, 200);
    const rows = db.prepare(`
      SELECT a.grantor as name, COALESCE(ec.category,'UNCLASSIFIED') as category,
        COUNT(*) as total, MIN(a.rec_date) as first_date, MAX(a.rec_date) as last_date
      FROM assignments a
      LEFT JOIN entity_classifications ec ON UPPER(a.grantor)=UPPER(ec.name)
      GROUP BY a.grantor ORDER BY total DESC LIMIT ?
    `).all(n);
    res.json(rows);
  });

  // ─── GET /api/top-assignees ───────────────────────────────────────────────
  app.get('/api/top-assignees', (req, res) => {
    const n = Math.min(parseInt(req.query.n as string) || 25, 200);
    const rows = db.prepare(`
      SELECT a.grantee as name, COALESCE(ec.category,'UNCLASSIFIED') as category,
        COUNT(*) as total, MIN(a.rec_date) as first_date, MAX(a.rec_date) as last_date
      FROM assignments a
      LEFT JOIN entity_classifications ec ON UPPER(a.grantee)=UPPER(ec.name)
      GROUP BY a.grantee ORDER BY total DESC LIMIT ?
    `).all(n);
    res.json(rows);
  });

  // ─── GET /api/assignments ─────────────────────────────────────────────────
  // Supports: grantor, grantee, start_date, end_date, category, page, limit
  app.get('/api/assignments', (req, res) => {
    const { grantor, grantee, start_date, end_date, page = '1', limit = '50' } = req.query as Record<string, string>;
    const category = req.query['category'] as string | string[] | undefined;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    let where: string[] = [];
    let params: any[] = [];

    if (grantor) { where.push("UPPER(a.grantor) LIKE UPPER(?)"); params.push(`%${grantor}%`); }
    if (grantee) { where.push("UPPER(a.grantee) LIKE UPPER(?)"); params.push(`%${grantee}%`); }
    if (start_date) { where.push("a.rec_date >= ?"); params.push(start_date); }
    if (end_date) { where.push("a.rec_date <= ?"); params.push(end_date); }
    // category can be a single string or array (multi-select)
    const categories = category
      ? (Array.isArray(category) ? category : [category])
      : (req.query['category[]'] ? (Array.isArray(req.query['category[]']) ? req.query['category[]'] : [req.query['category[]']]) : []);
    if (categories.length > 0) {
      const placeholders = categories.map(() => '?').join(', ');
      where.push(`(ec_g.category IN (${placeholders}) OR ec_a.category IN (${placeholders}))`);
      params.push(...categories, ...categories);
    }

    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

    const countSql = `
      SELECT COUNT(*) as n FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      ${whereClause}
    `;
    const total = (db.prepare(countSql).get(...params) as any).n;

    const dataSql = `
      SELECT a.cfn, a.rec_date, a.grantor, a.grantee, a.address,
        a.rec_book, a.rec_page, a.misc_ref, a.legal_desc,
        COALESCE(ec_g.category,'UNCLASSIFIED') as grantor_category,
        COALESCE(ec_a.category,'UNCLASSIFIED') as grantee_category
      FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      ${whereClause}
      ORDER BY a.rec_date DESC LIMIT ? OFFSET ?
    `;
    const rows = db.prepare(dataSql).all(...params, limitNum, offset);

    res.json({ total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows });
  });

  // ─── GET /api/entities ────────────────────────────────────────────────────
  app.get('/api/entities', (req, res) => {
    const { category } = req.query as Record<string, string>;
    let sql = 'SELECT name, category, sub_category FROM entity_classifications';
    const params: any[] = [];
    if (category) { sql += ' WHERE category = ?'; params.push(category); }
    sql += ' ORDER BY category, name';
    res.json(db.prepare(sql).all(...params));
  });

  // ─── GET /api/flow-matrix ─────────────────────────────────────────────────
  app.get('/api/flow-matrix', (_req, res) => {
    const rows = db.prepare(`
      SELECT COALESCE(ec_g.category,'UNCLASSIFIED') as from_cat,
             COALESCE(ec_a.category,'UNCLASSIFIED') as to_cat,
             COUNT(*) as count
      FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      GROUP BY from_cat, to_cat ORDER BY count DESC
    `).all();
    res.json(rows);
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
    const rows = db.prepare('SELECT date_from, date_to, records_found, status FROM collection_log ORDER BY date_from DESC').all();
    res.json(rows);
  });

  // ─── GET /api/private-credit ──────────────────────────────────────────────
  app.get('/api/private-credit', (req, res) => {
    const { page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    const total = (db.prepare(`
      SELECT COUNT(*) as n FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      WHERE ec_g.category='PRIVATE_CREDIT' OR ec_a.category='PRIVATE_CREDIT'
    `).get() as any).n;

    const rows = db.prepare(`
      SELECT a.cfn, a.rec_date, a.grantor, a.grantee, a.address,
        COALESCE(ec_g.category,'UNCLASSIFIED') as grantor_category,
        COALESCE(ec_a.category,'UNCLASSIFIED') as grantee_category
      FROM assignments a
      LEFT JOIN entity_classifications ec_g ON UPPER(a.grantor)=UPPER(ec_g.name)
      LEFT JOIN entity_classifications ec_a ON UPPER(a.grantee)=UPPER(ec_a.name)
      WHERE ec_g.category='PRIVATE_CREDIT' OR ec_a.category='PRIVATE_CREDIT'
      ORDER BY a.rec_date DESC LIMIT ? OFFSET ?
    `).all(limitNum, offset);

    res.json({ total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows });
  });


  // ─── GET /api/network-stats ───────────────────────────────────────────────
  // Summary stats from the clean/denoised dataset
  app.get('/api/network-stats', (_req, res) => {
    const clean_total = (db.prepare('SELECT COUNT(*) as n FROM aom_events_clean').get() as any)?.n ?? 0;
    const node_count  = (db.prepare('SELECT COUNT(*) as n FROM entity_nodes').get() as any)?.n ?? 0;
    const edge_count  = (db.prepare('SELECT COUNT(*) as n FROM entity_relationships').get() as any)?.n ?? 0;
    const raw_total   = (db.prepare('SELECT COUNT(*) as n FROM assignments').get() as any).n;

    const top_acquirers = db.prepare(`
      SELECT entity, inbound_vol, outbound_vol, degree, entity_type
      FROM entity_nodes ORDER BY inbound_vol DESC LIMIT 10
    `).all();
    const top_sellers = db.prepare(`
      SELECT entity, inbound_vol, outbound_vol, degree, entity_type
      FROM entity_nodes ORDER BY outbound_vol DESC LIMIT 10
    `).all();
    const most_connected = db.prepare(`
      SELECT entity, inbound_vol, outbound_vol, degree, entity_type
      FROM entity_nodes ORDER BY degree DESC LIMIT 10
    `).all();

    res.json({ clean_total, raw_total, node_count, edge_count, top_acquirers, top_sellers, most_connected });
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
  app.get('/api/clean-events', (req, res) => {
    const { assignor, assignee, start_date, end_date, page = '1', limit = '50' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(parseInt(limit) || 50, 500);
    const offset = (pageNum - 1) * limitNum;

    const where: string[] = [];
    const params: any[] = [];
    if (assignor)    { where.push("UPPER(assignor_canon) LIKE UPPER(?)"); params.push(`%${assignor}%`); }
    if (assignee)    { where.push("UPPER(assignee_canon) LIKE UPPER(?)"); params.push(`%${assignee}%`); }
    if (start_date)  { where.push("rec_date >= ?"); params.push(start_date); }
    if (end_date)    { where.push("rec_date <= ?"); params.push(end_date); }

    const wc = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as n FROM aom_events_clean ${wc}`).get(...params) as any).n;
    const rows = db.prepare(`
      SELECT cfn, rec_date, assignor, assignee, assignor_canon, assignee_canon,
             assignor_type, assignee_type, rec_book, rec_page, total_parties
      FROM aom_events_clean ${wc}
      ORDER BY rec_date DESC LIMIT ? OFFSET ?
    `).all(...params, limitNum, offset);

    res.json({ total, page: pageNum, limit: limitNum, pages: Math.ceil(total / limitNum), rows });
  });

  // ─── GET /api/entity-nodes ────────────────────────────────────────────────
  app.get('/api/entity-nodes', (req, res) => {
    const { q, type } = req.query as Record<string, string>;
    let sql = 'SELECT entity, inbound_vol, outbound_vol, total_vol, degree, entity_type, first_seen, last_seen FROM entity_nodes';
    const params: any[] = [];
    const where: string[] = [];
    if (q)    { where.push('UPPER(entity) LIKE UPPER(?)'); params.push(`%${q}%`); }
    if (type) { where.push('entity_type = ?'); params.push(type); }
    if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
    sql += ' ORDER BY total_vol DESC LIMIT 200';
    res.json(db.prepare(sql).all(...params));
  });

  // ─── GET /api/fdic/financials ─────────────────────────────────────────────
  app.get('/api/fdic/financials', async (req, res) => {
    const state = typeof req.query.state === 'string' ? req.query.state : undefined;
    const result = await fetchFDICFinancials(state);
    res.json(result);
  });

  return httpServer;
}
