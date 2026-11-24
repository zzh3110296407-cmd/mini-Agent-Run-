import Database from 'better-sqlite3';

export function checkSqliteSmoke(): boolean {
  const database = new Database(':memory:');

  try {
    const row = database.prepare<[], { ok: number }>('SELECT 1 AS ok').get();
    return row?.ok === 1;
  } finally {
    database.close();
  }
}
