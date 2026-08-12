import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type Db = Database.Database;

export interface RepoRow {
  id: number;
  owner: string;
  name: string;
  default_branch: string | null;
  cloned_at: string | null;
  last_indexed_at: string | null;
}

export interface NewRepo {
  owner: string;
  name: string;
  defaultBranch: string | null;
}

export interface NewFile {
  path: string;
  basename: string;
  lang: string | null;
  size: number;
}

export interface NewSymbol {
  kind: string;
  name: string;
  line: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    name TEXT NOT NULL,
    default_branch TEXT,
    cloned_at TEXT,
    last_indexed_at TEXT,
    UNIQUE(owner, name)
  );
  CREATE TABLE IF NOT EXISTS files (
    id INTEGER PRIMARY KEY,
    repo_id INTEGER NOT NULL REFERENCES repos(id),
    path TEXT NOT NULL,
    basename TEXT NOT NULL,
    lang TEXT,
    size INTEGER,
    UNIQUE(repo_id, path)
  );
  CREATE TABLE IF NOT EXISTS symbols (
    id INTEGER PRIMARY KEY,
    file_id INTEGER NOT NULL REFERENCES files(id),
    kind TEXT NOT NULL,
    name TEXT NOT NULL,
    line INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);
  CREATE TABLE IF NOT EXISTS reviews (
    id INTEGER PRIMARY KEY,
    owner TEXT NOT NULL,
    repo TEXT NOT NULL,
    pr_number INTEGER NOT NULL,
    head_sha TEXT NOT NULL,
    status TEXT,
    summary TEXT,
    created_at TEXT,
    UNIQUE(owner, repo, pr_number, head_sha)
  );
`;

export function openDb(dbPath: string): Db {
  mkdirSync(dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function upsertRepo(db: Db, repo: NewRepo): number {
  const row = db
    .prepare(
      `INSERT INTO repos (owner, name, default_branch, cloned_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner, name) DO UPDATE SET
         default_branch = excluded.default_branch,
         cloned_at = excluded.cloned_at
       RETURNING id`,
    )
    .get(repo.owner, repo.name, repo.defaultBranch, new Date().toISOString());
  return (row as { id: number }).id;
}

export function getRepoId(db: Db, owner: string, name: string): number | undefined {
  const row = db.prepare('SELECT id FROM repos WHERE owner = ? AND name = ?').get(owner, name) as
    | { id: number }
    | undefined;
  return row?.id;
}

export function listReposByOwner(db: Db, owner: string): RepoRow[] {
  return db.prepare('SELECT * FROM repos WHERE owner = ? ORDER BY name').all(owner) as RepoRow[];
}

export function markRepoIndexed(db: Db, repoId: number): void {
  db.prepare('UPDATE repos SET last_indexed_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    repoId,
  );
}

export function clearRepoFiles(db: Db, repoId: number): void {
  db.prepare('DELETE FROM symbols WHERE file_id IN (SELECT id FROM files WHERE repo_id = ?)').run(
    repoId,
  );
  db.prepare('DELETE FROM files WHERE repo_id = ?').run(repoId);
}

export function insertFile(db: Db, repoId: number, file: NewFile): number {
  const row = db
    .prepare(
      `INSERT INTO files (repo_id, path, basename, lang, size)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(repo_id, path) DO UPDATE SET
         basename = excluded.basename,
         lang = excluded.lang,
         size = excluded.size
       RETURNING id`,
    )
    .get(repoId, file.path, file.basename, file.lang, file.size);
  return (row as { id: number }).id;
}

export function insertSymbol(db: Db, fileId: number, symbol: NewSymbol): void {
  db.prepare('INSERT INTO symbols (file_id, kind, name, line) VALUES (?, ?, ?, ?)').run(
    fileId,
    symbol.kind,
    symbol.name,
    symbol.line,
  );
}

export function reviewPosted(db: Db, owner: string, repo: string, prNumber: number, headSha: string): boolean {
  const row = db
    .prepare('SELECT 1 FROM reviews WHERE owner = ? AND repo = ? AND pr_number = ? AND head_sha = ?')
    .get(owner, repo, prNumber, headSha);
  return row !== undefined;
}

export function recordReview(
  db: Db,
  owner: string,
  repo: string,
  prNumber: number,
  headSha: string,
  status: string | null,
  summary: string,
): void {
  db.prepare(
    `INSERT INTO reviews (owner, repo, pr_number, head_sha, status, summary, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(owner, repo, pr_number, head_sha) DO UPDATE SET
       status = excluded.status,
       summary = excluded.summary`,
  ).run(owner, repo, prNumber, headSha, status, summary, new Date().toISOString());
}
