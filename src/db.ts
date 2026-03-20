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

export function clearDb(): void {
  db.exec("DELETE FROM stamps");
  db.exec("DELETE FROM segments");
}
