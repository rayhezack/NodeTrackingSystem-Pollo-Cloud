import type { D1Database, D1PreparedStatement } from './ai-tracking';
import type { BitableFilter, BitableRecord, BitableRecordPage } from './feishu-bitable';

export class StoreConflictError extends Error {}
export type AtomicDatabase = D1Database & { batch(statements: D1PreparedStatement[]): Promise<unknown[]> };
interface StoredRow { id: string; fields: string; revision: number; }
interface Change { instance: string; id: string; fields: Record<string, unknown> | null; patch: Record<string, unknown> | null; }
const initialized = new WeakMap<object, Promise<void>>();
export async function ensureRecordStore(db: D1Database): Promise<void> {
  let pending = initialized.get(db);
  if (!pending) {
    pending = (async () => {
      for (const sql of [
        'CREATE TABLE IF NOT EXISTS tracking_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
        'CREATE TABLE IF NOT EXISTS tracking_rows (instance TEXT NOT NULL, id TEXT NOT NULL, fields TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1, PRIMARY KEY(instance,id))',
        'CREATE INDEX IF NOT EXISTS idx_tracking_request ON tracking_rows(instance,json_extract(fields,\'$.需求ID\'))',
        'CREATE INDEX IF NOT EXISTS idx_tracking_evt ON tracking_rows(instance,json_extract(fields,\'$.evt_id\'))',
        'CREATE TABLE IF NOT EXISTS tracking_table_versions (instance TEXT PRIMARY KEY, revision INTEGER NOT NULL)',
        'CREATE TABLE IF NOT EXISTS tracking_commit_checks (id TEXT PRIMARY KEY, valid INTEGER NOT NULL CHECK(valid=1))',
        "CREATE TABLE IF NOT EXISTS tracking_sync_outbox (id INTEGER PRIMARY KEY AUTOINCREMENT, instance TEXT NOT NULL, record_id TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, error TEXT, created_at INTEGER NOT NULL, finished_at INTEGER)",
        'CREATE INDEX IF NOT EXISTS idx_sync_pending ON tracking_sync_outbox(status,id)',
        'CREATE TABLE IF NOT EXISTS tracking_base_mapping (instance TEXT NOT NULL, local_id TEXT NOT NULL, base_id TEXT NOT NULL, PRIMARY KEY(instance,local_id))',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_base_mapping_unique ON tracking_base_mapping(instance,base_id)',
      ]) await db.prepare(sql).run();
    })().catch((error: unknown) => { initialized.delete(db); throw error; });
    initialized.set(db, pending);
  }
  await pending;
}
export async function storeMode(db: D1Database): Promise<string> {
  try { return (await db.prepare("SELECT value FROM tracking_store_meta WHERE key='mode'").first<{ value: string }>())?.value || 'base'; }
  catch (error) { if (error instanceof Error && /no such table.*tracking_store_meta/i.test(error.message)) return 'base'; throw error; }
}

/** Request-local unit of work. Existing business rules see their own pending changes; commit is atomic. */
export class D1RecordStore {
  private versions = new Map<string, number>();
  private changes = new Map<string, Change>();
  readonly notifications: Record<string, unknown>[] = [];
  constructor(readonly db: AtomicDatabase) {}
  private async observe(instance: string) {
    if (this.versions.has(instance)) return;
    const row = await this.db.prepare('SELECT revision FROM tracking_table_versions WHERE instance=?').bind(instance).first<{ revision: number }>();
    this.versions.set(instance, row?.revision || 0);
  }
  async get(instance: string, id: string): Promise<BitableRecord | null> {
    await this.observe(instance);
    const pending = this.changes.get(`${instance}:${id}`);
    if (pending) return pending.fields ? { id, record: pending.fields } : null;
    const row = await this.db.prepare('SELECT id,fields,revision FROM tracking_rows WHERE instance=? AND id=?').bind(instance, id).first<StoredRow>();
    return row ? { id: row.id, record: JSON.parse(row.fields) } : null;
  }
  async search(instance: string, options: { pageSize?: number; pageToken?: string; filter?: BitableFilter }): Promise<BitableRecordPage> {
    await this.observe(instance);
    const clauses: string[] = [];
    const bindings: unknown[] = [instance];
    for (const condition of options.filter?.conditions || []) {
      if (!['is', 'contains'].includes(condition.operator)) throw new Error(`D1 不支持筛选操作 ${condition.operator}`);
      const path = `$.${condition.field_name}`.replace(/'/g, "''");
      if (condition.operator === 'is') {
        clauses.push(`${cellTextSql(path)}=?`);
        bindings.push(condition.value[0]);
      } else {
        clauses.push(`(${cellTextSql(path)}=? OR EXISTS (SELECT 1 FROM json_tree(fields,'${path}') WHERE atom=?))`);
        bindings.push(condition.value[0], condition.value[0]);
      }
    }
    const where = clauses.length ? ` AND (${clauses.join(options.filter?.conjunction === 'or' ? ' OR ' : ' AND ')})` : '';
    const offset = Number(options.pageToken || 0);
    if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('无效分页标识');
    const size = Math.min(options.pageSize || 500, 500);
    if (![...this.changes.values()].some((change) => change.instance === instance)) {
      const page = await this.db.prepare(`SELECT id,fields,revision FROM tracking_rows WHERE instance=?${where} ORDER BY id LIMIT ? OFFSET ?`).bind(...bindings, size + 1, offset).all<StoredRow>();
      const rows = page.results || [];
      return { records: rows.slice(0,size).map((row) => ({ id: row.id, record: JSON.parse(row.fields) })), hasMore: rows.length > size, pageToken: rows.length > size ? String(offset + size) : undefined, total: rows.length <= size && !offset ? rows.length : undefined };
    }
    const result = await this.db.prepare(`SELECT id,fields,revision FROM tracking_rows WHERE instance=?${where} ORDER BY id`).bind(...bindings).all<StoredRow>();
    const records = new Map((result.results || []).map((row) => [row.id, { id: row.id, record: JSON.parse(row.fields) as Record<string, unknown> }]));
    for (const change of this.changes.values()) {
      if (change.instance !== instance) continue;
      records.delete(change.id);
      if (change.fields && matchesFilter(change.fields, options.filter)) records.set(change.id, { id: change.id, record: change.fields });
    }
    const all = [...records.values()].sort((a, b) => a.id.localeCompare(b.id));
    return { records: all.slice(offset, offset + size), total: all.length, hasMore: offset + size < all.length, pageToken: offset + size < all.length ? String(offset + size) : undefined };
  }
  async create(instance: string, records: Record<string, unknown>[]): Promise<BitableRecord[]> {
    await this.observe(instance);
    return records.map((record) => {
      const id = `d1_${crypto.randomUUID()}`;
      const fields = localMetadata(instance, record, true);
      this.changes.set(`${instance}:${id}`, { instance, id, fields, patch: record });
      return { id, record: fields };
    });
  }
  async update(instance: string, records: BitableRecord[]): Promise<BitableRecord[]> {
    const result: BitableRecord[] = [];
    for (const row of records) {
      const previous = await this.get(instance, row.id);
      if (!previous) throw new Error(`记录不存在：${row.id}`);
      const record = localMetadata(instance, { ...previous.record, ...row.record }, false);
      this.changes.set(`${instance}:${row.id}`, { instance, id: row.id, fields: record, patch: { ...(this.changes.get(`${instance}:${row.id}`)?.patch || {}), ...row.record } });
      result.push({ id: row.id, record });
    }
    return result;
  }
  async delete(instance: string, ids: string[]): Promise<void> {
    await this.observe(instance);
    for (const id of ids) this.changes.set(`${instance}:${id}`, { instance, id, fields: null, patch: null });
  }
  async commit(): Promise<void> {
    if (!this.changes.size && !this.notifications.length) return;
    const id = crypto.randomUUID();
    const statements: D1PreparedStatement[] = [];
    for (const [instance, version] of this.versions) {
      statements.push(this.db.prepare('INSERT INTO tracking_commit_checks(id,valid) SELECT ?, CASE WHEN COALESCE((SELECT revision FROM tracking_table_versions WHERE instance=?),0)=? THEN 1 ELSE 0 END').bind(`${id}:${instance}`, instance, version));
    }
    const touched = new Set<string>();
    for (const change of this.changes.values()) {
      const payload = JSON.stringify(change.fields);
      if (new TextEncoder().encode(payload).length > 60000) throw new Error('记录超过数据库字段大小限制，请将大段内容保存为附件');
      touched.add(change.instance);
      statements.push(change.fields
        ? this.db.prepare('INSERT INTO tracking_rows(instance,id,fields) VALUES(?,?,?) ON CONFLICT(instance,id) DO UPDATE SET fields=excluded.fields,revision=revision+1').bind(change.instance, change.id, payload)
        : this.db.prepare('DELETE FROM tracking_rows WHERE instance=? AND id=?').bind(change.instance, change.id));
      statements.push(this.db.prepare('INSERT INTO tracking_sync_outbox(instance,record_id,payload,created_at) VALUES(?,?,?,?)').bind(change.instance, change.id, JSON.stringify(change.patch), Date.now()));
    }
    for (const instance of touched) statements.push(this.db.prepare('INSERT INTO tracking_table_versions(instance,revision) VALUES(?,1) ON CONFLICT(instance) DO UPDATE SET revision=revision+1').bind(instance));
    for (const notification of this.notifications) statements.push(this.db.prepare('INSERT INTO tracking_sync_outbox(instance,record_id,payload,created_at) VALUES(?,?,?,?)').bind('__notification', id, JSON.stringify(notification), Date.now()));
    for (const instance of this.versions.keys()) statements.push(this.db.prepare('DELETE FROM tracking_commit_checks WHERE id=?').bind(`${id}:${instance}`));
    try { await this.db.batch(statements); }
    catch (error) { if (error instanceof Error && /CHECK constraint failed/i.test(error.message)) throw new StoreConflictError('数据已被其他操作更新，请重新加载后保存'); throw error; }
  }
}
/** Match the existing Base cell representation while preserving original stored fields. */
export function recordCellText(value: unknown): string {
  if (value == null) return '';
  if (['string', 'number', 'boolean'].includes(typeof value)) return String(value);
  if (Array.isArray(value)) return value.map(recordCellText).filter(Boolean).join('、');
  if (typeof value === 'object') {
    const item = value as Record<string, unknown>;
    return [item.name,item.link,item.url,item.text,item.id].find((entry) => typeof entry === 'string' && entry.trim() || typeof entry === 'number')?.toString().trim() || '';
  }
  return '';
}
function cellTextSql(path: string): string {
  const objectText = (value: string) => `COALESCE(json_extract(${value},'$.name'),json_extract(${value},'$.link'),json_extract(${value},'$.url'),json_extract(${value},'$.text'),json_extract(${value},'$.id'),'')`;
  return `(CASE json_type(fields,'${path}') WHEN 'array' THEN COALESCE((SELECT group_concat(text,'、') FROM (SELECT CASE WHEN type='object' THEN ${objectText('value')} ELSE CAST(value AS TEXT) END AS text FROM json_each(fields,'${path}')) WHERE text!=''),'') WHEN 'object' THEN ${objectText(`json_extract(fields,'${path}')`)} ELSE COALESCE(CAST(json_extract(fields,'${path}') AS TEXT),'') END)`;
}
function containsCell(value: unknown, expected: string): boolean {
  if (recordCellText(value) === expected) return true;
  if (Array.isArray(value)) return value.some((item) => containsCell(item,expected));
  if (value && typeof value === 'object') return Object.values(value).some((item) => containsCell(item,expected));
  return false;
}
function matchesFilter(fields: Record<string, unknown>, filter?: BitableFilter): boolean {
  if (!filter?.conditions.length) return true;
  const values = filter.conditions.map((condition) => condition.operator === 'contains' ? containsCell(fields[condition.field_name],condition.value[0]) : recordCellText(fields[condition.field_name]) === condition.value[0]);
  return filter.conjunction === 'or' ? values.some(Boolean) : values.every(Boolean);
}

/** Base system columns are calculated locally; never send them in an outbox patch. */
function localMetadata(instance: string, fields: Record<string, unknown>, created: boolean): Record<string, unknown> {
  const now = Date.now();
  const result = { ...fields, ...(created ? { 创建时间: now } : {}), 更新时间: now };
  if (instance === 'paramDetail' || instance === 'webParamDetail') {
    const evtId = recordCellText(fields.evt_id), name = recordCellText(fields['参数名']);
    return { ...result, 设计参数主键: evtId && name ? `${evtId}.${name}` : '' };
  }
  return result;
}
