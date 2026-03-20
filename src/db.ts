import { Database } from "bun:sqlite";

const db = new Database("otslog.db");

db.exec(`
  CREATE TABLE IF NOT EXISTS stamps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    segment_name TEXT NOT NULL,
    offset INTEGER NOT NULL,
    time INTEGER NOT NULL,
    midstate TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(segment_name, offset)
  );

  CREATE TABLE IF NOT EXISTS segments (
    name TEXT PRIMARY KEY,
    camera_id TEXT,
    size INTEGER DEFAULT 0,
    mtime TEXT,
    stamping INTEGER DEFAULT 0,
    completed INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE INDEX IF NOT EXISTS idx_stamps_segment ON stamps(segment_name);
  CREATE INDEX IF NOT EXISTS idx_stamps_time ON stamps(time);

  CREATE TABLE IF NOT EXISTS export_jobs (
    id TEXT PRIMARY KEY,
    segment_name TEXT NOT NULL,
    offset INTEGER NOT NULL,
    status TEXT NOT NULL,
    progress INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    completed_at INTEGER,
    zip_name TEXT NOT NULL,
    zip_path TEXT,
    s3_key TEXT,
    download_url TEXT,
    download_url_expires_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_export_jobs_updated ON export_jobs(updated_at);
`);

export interface Stamp {
  id?: number;
  segment_name: string;
  offset: number;
  time: number;
  midstate: string;
  created_at?: string;
}

export interface Segment {
  name: string;
  camera_id: string | null;
  size: number;
  mtime: string | null;
  stamping: number;
  completed: number;
  created_at?: string;
  updated_at?: string;
}

export interface ExportJobRecord {
  id: string;
  segment_name: string;
  offset: number;
  status: string;
  progress: number;
  error: string | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  zip_name: string;
  zip_path: string | null;
  s3_key: string | null;
  download_url: string | null;
  download_url_expires_at: number | null;
}

export function saveStamp(stamp: Stamp): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO stamps (segment_name, offset, time, midstate)
    VALUES ($segment_name, $offset, $time, $midstate)
  `);
  stmt.run({
    $segment_name: stamp.segment_name,
    $offset: stamp.offset,
    $time: stamp.time,
    $midstate: stamp.midstate,
  });
}

export function getStampsBySegment(segmentName: string): Stamp[] {
  const stmt = db.prepare(`
    SELECT * FROM stamps WHERE segment_name = $segment_name ORDER BY offset ASC
  `);
  return stmt.all({ $segment_name: segmentName }) as Stamp[];
}

export function getAllStamps(limit = 100): Stamp[] {
  const stmt = db.prepare(`
    SELECT * FROM stamps ORDER BY time DESC LIMIT $limit
  `);
  return stmt.all({ $limit: limit }) as Stamp[];
}

export interface StampCount {
  segment_name: string;
  stamps: number;
}

export function getStampCounts(cameraId?: string): StampCount[] {
  if (cameraId) {
    const stmt = db.prepare(`
      SELECT segment_name, COUNT(*) AS stamps
      FROM stamps
      WHERE segment_name LIKE $prefix
      GROUP BY segment_name
      ORDER BY segment_name DESC
    `);
    return stmt.all({ $prefix: `${cameraId}_output_%` }) as StampCount[];
  }

  const stmt = db.prepare(`
    SELECT segment_name, COUNT(*) AS stamps
    FROM stamps
    GROUP BY segment_name
    ORDER BY segment_name DESC
  `);
  return stmt.all() as StampCount[];
}

export function saveSegment(segment: Partial<Segment> & { name: string }): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO segments (name, camera_id, size, mtime, stamping, completed, updated_at)
    VALUES ($name, $camera_id, $size, $mtime, $stamping, $completed, CURRENT_TIMESTAMP)
  `);
  stmt.run({
    $name: segment.name,
    $camera_id: segment.camera_id ?? null,
    $size: segment.size ?? 0,
    $mtime: segment.mtime ?? null,
    $stamping: segment.stamping ?? 0,
    $completed: segment.completed ?? 0,
  });
}

export function getSegments(): Segment[] {
  const stmt = db.prepare(`
    SELECT * FROM segments ORDER BY mtime DESC
  `);
  return stmt.all() as Segment[];
}

export function markSegmentStamping(name: string, stamping: boolean): void {
  const stmt = db.prepare(`
    UPDATE segments SET stamping = $stamping, updated_at = CURRENT_TIMESTAMP WHERE name = $name
  `);
  stmt.run({ $name: name, $stamping: stamping ? 1 : 0 });
}

export function markSegmentCompleted(name: string): void {
  const stmt = db.prepare(`
    UPDATE segments SET stamping = 0, completed = 1, updated_at = CURRENT_TIMESTAMP WHERE name = $name
  `);
  stmt.run({ $name: name });
}

export function saveExportJob(job: ExportJobRecord): void {
  const stmt = db.prepare(`
    INSERT OR REPLACE INTO export_jobs (
      id, segment_name, offset, status, progress, error,
      created_at, updated_at, completed_at,
      zip_name, zip_path, s3_key, download_url, download_url_expires_at
    ) VALUES (
      $id, $segment_name, $offset, $status, $progress, $error,
      $created_at, $updated_at, $completed_at,
      $zip_name, $zip_path, $s3_key, $download_url, $download_url_expires_at
    )
  `);

  stmt.run({
    $id: job.id,
    $segment_name: job.segment_name,
    $offset: job.offset,
    $status: job.status,
    $progress: job.progress,
    $error: job.error,
    $created_at: job.created_at,
    $updated_at: job.updated_at,
    $completed_at: job.completed_at,
    $zip_name: job.zip_name,
    $zip_path: job.zip_path,
    $s3_key: job.s3_key,
    $download_url: job.download_url,
    $download_url_expires_at: job.download_url_expires_at,
  });
}

export function getExportJob(id: string): ExportJobRecord | null {
  const stmt = db.prepare(`SELECT * FROM export_jobs WHERE id = $id LIMIT 1`);
  return (stmt.get({ $id: id }) as ExportJobRecord | null) ?? null;
}

export function getRecentExportJobs(limit = 200): ExportJobRecord[] {
  const stmt = db.prepare(`
    SELECT * FROM export_jobs ORDER BY updated_at DESC LIMIT $limit
  `);
  return stmt.all({ $limit: limit }) as ExportJobRecord[];
}

export function deleteExportJob(id: string): void {
  const stmt = db.prepare(`DELETE FROM export_jobs WHERE id = $id`);
  stmt.run({ $id: id });
}

export function deleteOldExportJobs(olderThanEpochMs: number): void {
  const stmt = db.prepare(`DELETE FROM export_jobs WHERE updated_at < $ts`);
  stmt.run({ $ts: olderThanEpochMs });
}

export function clearDb(): void {
  db.exec("DELETE FROM stamps");
  db.exec("DELETE FROM segments");
  db.exec("DELETE FROM export_jobs");
}
