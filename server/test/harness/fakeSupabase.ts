import crypto from 'node:crypto';

/**
 * Hermetic test harness: in-memory Supabase.
 *
 * Replaces supabase.from(...) on the shared client exports (supabase,
 * supabaseAnon) with a generic in-memory table store. Every insert/upsert/
 * update/delete is recorded; reads filter rows by the chained eq/is/in/ilike
 * predicates, project select() columns and honour maybeSingle()/single().
 *
 * This mirrors the proven pattern from test/connectors/github/sync.test.ts but
 * is table-agnostic. Suites that need precise per-table semantics (e.g. the
 * github sync test) still install their own fake on top.
 */

type Row = Record<string, any>;

interface OrCondition {
  col: string;
  op: string;
  val: unknown;
}

interface QueryFilters {
  eq: Array<[string, unknown]>;
  in: Array<[string, unknown[]]>;
  is: Array<[string, unknown]>;
  ilike: Array<[string, string]>;
  lt: Array<[string, unknown]>;
  or: Array<OrCondition[]>;
  not: Array<[string, string, unknown]>;
  limit: number | null;
  order: Array<[string, 'asc' | 'desc']>;
}

function parseOrFilter(filterStr: string): OrCondition[] {
  const groups: OrCondition[] = [];
  for (let part of filterStr.split(',')) {
    part = part.trim();
    if (part.startsWith('(') && part.endsWith(')')) part = part.slice(1, -1);
    const sep = part.indexOf('.');
    if (sep <= 0) continue;
    const col = part.slice(0, sep);
    const rest = part.slice(sep + 1);
    const opSep = rest.indexOf('.');
    const op = opSep === -1 ? rest : rest.slice(0, opSep);
    let val: unknown = opSep === -1 ? null : rest.slice(opSep + 1);
    if (val === 'null') val = null;
    else if (val === 'true' || val === 'false') val = val === 'true';
    else if (val !== '' && !Number.isNaN(Number(val))) val = Number(val);
    groups.push({ col, op, val });
  }
  return groups;
}

class FakeSupabaseQuery {
  private readonly table: string;
  private readonly store: FakeSupabaseStore;
  private readonly selectCols: string[];
  private readonly filters: QueryFilters;
  private readonly pendingUpdate: Record<string, any> | null;
  private readonly pendingDelete: boolean;
  // Mirrors real Postgres UPDATE ... RETURNING: set when .select() is called
  // after .update(), so maybeSingle()/single()/then() apply the update and
  // return the updated row(s) instead of only mutating in place.
  private readonly withReturning: boolean;

  constructor(
    table: string,
    store: FakeSupabaseStore,
    selectCols: string[] = ['*'],
    filters: QueryFilters = { eq: [], in: [], is: [], ilike: [], lt: [], or: [], not: [], limit: null, order: [] },
    pendingUpdate: Record<string, any> | null = null,
    pendingDelete = false,
    withReturning = false
  ) {
    this.table = table;
    this.store = store;
    this.selectCols = selectCols;
    this.filters = filters;
    this.pendingUpdate = pendingUpdate;
    this.pendingDelete = pendingDelete;
    this.withReturning = withReturning;
  }

  private cloneFilters(): QueryFilters {
    return {
      eq: [...this.filters.eq],
      in: [...this.filters.in],
      is: [...this.filters.is],
      ilike: [...this.filters.ilike],
      lt: [...this.filters.lt],
      or: [...this.filters.or],
      not: [...this.filters.not],
      limit: this.filters.limit,
      order: [...this.filters.order],
    };
  }

  select(cols: string) {
    return new FakeSupabaseQuery(this.table, this.store, cols.split(',').map((c) => c.trim()), this.cloneFilters(), this.pendingUpdate, this.pendingDelete, this.pendingUpdate !== null);
  }
  eq(col: string, val: unknown) {
    const f = this.cloneFilters();
    f.eq.push([col, val]);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  in(col: string, vals: unknown[]) {
    const f = this.cloneFilters();
    f.in.push([col, vals]);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  is(col: string, val: unknown) {
    const f = this.cloneFilters();
    f.is.push([col, val]);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  ilike(col: string, pattern: string) {
    const f = this.cloneFilters();
    f.ilike.push([col, pattern]);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  lt(col: string, val: unknown) {
    const f = this.cloneFilters();
    f.lt.push([col, val]);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  or(filterStr: string) {
    const f = this.cloneFilters();
    f.or.push(parseOrFilter(filterStr));
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  not(col: string, op: string, val: unknown) {
    const f = this.cloneFilters();
    f.not.push([col, op, val]);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  order(col: string, opts: { ascending?: boolean } = {}) {
    const f = this.cloneFilters();
    f.order.push([col, opts.ascending === false ? 'desc' : 'asc']);
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  limit(n: number) {
    const f = this.cloneFilters();
    f.limit = n;
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, f, this.pendingUpdate, this.pendingDelete, this.withReturning);
  }
  upsert(rows: unknown) {
    this.store.upsert(this.table, rows);
    return this;
  }
  insert(rows: unknown) {
    this.store.insert(this.table, rows);
    return this;
  }
  update(patch: unknown) {
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, this.cloneFilters(), patch as Record<string, any>, false, false);
  }
  delete() {
    return new FakeSupabaseQuery(this.table, this.store, this.selectCols, this.cloneFilters(), null, true, false);
  }
  maybeSingle() {
    if (this.pendingUpdate && this.withReturning) {
      const rows = this.store.updateMatchingReturning(this.table, this.pendingUpdate, this.filters);
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
    return this.store.resolve(this.table, this.selectCols, this.filters, true);
  }
  single() {
    if (this.pendingUpdate && this.withReturning) {
      const rows = this.store.updateMatchingReturning(this.table, this.pendingUpdate, this.filters);
      return Promise.resolve({ data: rows.length >= 1 ? rows[0] : null, error: null });
    }
    return this.store.resolve(this.table, this.selectCols, this.filters, false, true);
  }
  then(resolve: (value: any) => any, reject?: (reason?: any) => any) {
    if (this.pendingDelete) {
      this.store.deleteRows(this.table, this.filters);
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
    if (this.pendingUpdate) {
      if (this.withReturning) {
        const rows = this.store.updateMatchingReturning(this.table, this.pendingUpdate, this.filters);
        return Promise.resolve({ data: rows.map((r) => this.store.project(r, this.selectCols)), error: null }).then(resolve, reject);
      }
      this.store.updateMatching(this.table, this.pendingUpdate, this.filters);
      return Promise.resolve({ data: null, error: null }).then(resolve, reject);
    }
    return this.store.resolve(this.table, this.selectCols, this.filters, false).then(resolve, reject);
  }
}

class FakeSupabaseStore {
  private readonly tables = new Map<string, Row[]>();

  from(table: string) {
    return new FakeSupabaseQuery(table, this);
  }

  tableRows(table: string): Row[] {
    let rows = this.tables.get(table);
    if (!rows) {
      rows = [];
      this.tables.set(table, rows);
    }
    return rows;
  }

  insert(table: string, payload: unknown): void {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      // Mirrors real Postgres `id uuid primary key default gen_random_uuid()`.
      if (row.id == null) row.id = crypto.randomUUID();
      this.tableRows(table).push({ ...row });
    }
  }

  upsert(table: string, payload: unknown): void {
    const rows = Array.isArray(payload) ? payload : [payload];
    for (const row of rows) {
      if (row.id == null) row.id = crypto.randomUUID();
      const existing = this.tableRows(table).find((r) => r.id === (row as Row).id);
      if (existing) {
        Object.assign(existing, row);
      } else {
        this.tableRows(table).push({ ...row });
      }
    }
  }

  update(table: string, patch: Record<string, any>): void {
    for (const row of this.tableRows(table)) {
      Object.assign(row, patch);
    }
  }

  updateMatching(table: string, patch: Record<string, any>, filters: QueryFilters): void {
    for (const row of this.tableRows(table)) {
      if (this.matches(row, filters)) {
        Object.assign(row, patch);
      }
    }
  }

  /**
   * Mirrors UPDATE ... WHERE ... RETURNING: applies `patch` to every row
   * matching `filters` and returns the updated rows (in store order).
   */
  updateMatchingReturning(table: string, patch: Record<string, any>, filters: QueryFilters): Row[] {
    const updated: Row[] = [];
    for (const row of this.tableRows(table)) {
      if (this.matches(row, filters)) {
        Object.assign(row, patch);
        updated.push(row);
      }
    }
    return updated;
  }

  deleteRows(table: string, filters: QueryFilters): void {
    const rows = this.tableRows(table);
    const remaining = rows.filter((r) => !this.matches(r, filters));
    if (remaining.length !== rows.length) {
      this.tables.set(table, remaining);
    }
  }

  private matches(row: Row, filters: QueryFilters): boolean {
    for (const [col, val] of filters.eq) {
      if (row[col] !== val) return false;
    }
    for (const [col, vals] of filters.in) {
      if (!vals.includes(row[col])) return false;
    }
    for (const [col, val] of filters.is) {
      if (val === null) {
        if (row[col] != null) return false;
      } else if (row[col] !== val) return false;
    }
    for (const [col, pattern] of filters.ilike) {
      const hay = String(row[col] ?? '');
      const needle = pattern.replace(/^%/, '').replace(/%$/, '');
      if (!hay.toLowerCase().includes(needle.toLowerCase())) return false;
    }
    for (const [col, val] of filters.lt) {
      const actual = row[col];
      if (actual == null || !(actual < val)) return false;
    }
    for (const [col, op, val] of filters.not) {
      if (op === 'is') {
        if (val === null ? row[col] == null : row[col] === val) return false;
      } else if (op === 'ilike' || op === 'like') {
        const needle = String(val).replace(/^%/, '').replace(/%$/, '');
        if (String(row[col] ?? '').toLowerCase().includes(needle.toLowerCase())) return false;
      } else if (op === 'in') {
        if (Array.isArray(val) && (val as unknown[]).includes(row[col])) return false;
      } else {
        if (row[col] === val || String(row[col] ?? '') === String(val)) return false;
      }
    }
    for (const group of filters.or) {
      const anyMatch = group.some((c) => {
        const actual = row[c.col];
        switch (c.op) {
          case 'eq':
            return actual === c.val || String(actual ?? '') === String(c.val);
          case 'neq':
            return actual !== c.val && String(actual ?? '') !== String(c.val);
          case 'ilike':
          case 'like': {
            const needle = String(c.val).replace(/^%/, '').replace(/%$/, '');
            return String(actual ?? '').toLowerCase().includes(needle.toLowerCase());
          }
          case 'is':
            return c.val === null ? actual == null : actual === c.val;
          case 'gt':
            return actual != null && actual > c.val;
          case 'gte':
            return actual != null && actual >= c.val;
          case 'lt':
            return actual != null && actual < c.val;
          case 'lte':
            return actual != null && actual <= c.val;
          case 'in':
            return Array.isArray(c.val) && (c.val as unknown[]).includes(actual);
          default:
            return actual === c.val || String(actual ?? '') === String(c.val);
        }
      });
      if (!anyMatch) return false;
    }
    return true;
  }

  project(row: Row, cols: string[]): Row {
    if (cols.length === 0 || (cols.length === 1 && cols[0] === '*')) return row;
    const out: Row = {};
    for (const col of cols) out[col] = row[col];
    return out;
  }

  resolve(table: string, cols: string[], filters: QueryFilters, maybe: boolean, single = false): Promise<{ data: Row | Row[] | null; error: null }> {
    let rows = this.tableRows(table).filter((r) => this.matches(r, filters));
    if (filters.order.length > 0) {
      for (const [col, dir] of [...filters.order].reverse()) {
        rows = [...rows].sort((a, b) => {
          const av = a[col];
          const bv = b[col];
          const cmp = av === bv ? 0 : av < bv ? -1 : 1;
          return dir === 'asc' ? cmp : -cmp;
        });
      }
    }
    if (filters.limit != null) rows = rows.slice(0, filters.limit);
    if (maybe) {
      return Promise.resolve({ data: rows[0] ?? null, error: null });
    }
    if (single) {
      // Mirrors real Supabase .single(): a lone row, or null when no rows match.
      return Promise.resolve({ data: rows.length >= 1 ? this.project(rows[0], cols) : null, error: null });
    }
    return Promise.resolve({ data: rows.map((r) => this.project(r, cols)), error: null });
  }
}

export async function installFakeSupabase(): Promise<void> {
  const { supabase, supabaseAnon } = await import('../../src/config/supabase.js');
  const store = new FakeSupabaseStore();
  (supabase as any).from = store.from.bind(store);
  if (supabaseAnon) (supabaseAnon as any).from = store.from.bind(store);
}
