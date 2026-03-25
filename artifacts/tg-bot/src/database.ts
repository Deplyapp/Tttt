import pg from "pg";

const { Pool, types } = pg;

// PostgreSQL returns BIGINT (OID 20) as a string by default.
// Telegram user IDs fit within Number.MAX_SAFE_INTEGER, so we parse them as numbers.
types.setTypeParser(20, (val: string) => parseInt(val, 10));

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL must be set.");
}

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });

export async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deployments (
      id TEXT PRIMARY KEY,
      user_id BIGINT NOT NULL,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'stopped',
      port INTEGER,
      file_path TEXT NOT NULL,
      entry_file TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deployment_envs (
      id SERIAL PRIMARY KEY,
      deployment_id TEXT NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      UNIQUE(deployment_id, key)
    );
  `);
}

export interface Deployment {
  id: string;
  user_id: number;
  name: string;
  type: string;
  status: string;
  port: number | null;
  file_path: string;
  entry_file: string | null;
  created_at: Date;
  updated_at: Date;
}

export async function createDeployment(data: {
  id: string;
  user_id: number;
  name: string;
  type: string;
  file_path: string;
  entry_file?: string;
  port?: number;
}): Promise<Deployment> {
  const res = await pool.query(
    `INSERT INTO deployments (id, user_id, name, type, file_path, entry_file, port)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING *`,
    [data.id, data.user_id, data.name, data.type, data.file_path, data.entry_file ?? null, data.port ?? null]
  );
  return res.rows[0];
}

export async function getDeployment(id: string): Promise<Deployment | null> {
  const res = await pool.query("SELECT * FROM deployments WHERE id = $1", [id]);
  return res.rows[0] ?? null;
}

export async function getUserDeployments(user_id: number): Promise<Deployment[]> {
  const res = await pool.query(
    "SELECT * FROM deployments WHERE user_id = $1 ORDER BY created_at DESC",
    [user_id]
  );
  return res.rows;
}

export async function updateDeploymentStatus(id: string, status: string, port?: number) {
  await pool.query(
    `UPDATE deployments SET status = $1, port = COALESCE($2, port), updated_at = NOW() WHERE id = $3`,
    [status, port ?? null, id]
  );
}

export async function deleteDeployment(id: string) {
  await pool.query("DELETE FROM deployments WHERE id = $1", [id]);
}

// Called on bot startup — any process that was "running" before is now dead
// because child processes don't survive a bot restart.
export async function resetAllRunningToStopped() {
  await pool.query(`UPDATE deployments SET status = 'stopped', port = NULL WHERE status = 'running'`);
}

export async function setEnv(deployment_id: string, key: string, value: string) {
  await pool.query(
    `INSERT INTO deployment_envs (deployment_id, key, value)
     VALUES ($1, $2, $3)
     ON CONFLICT (deployment_id, key) DO UPDATE SET value = $3`,
    [deployment_id, key, value]
  );
}

export async function removeEnv(deployment_id: string, key: string) {
  await pool.query(
    "DELETE FROM deployment_envs WHERE deployment_id = $1 AND key = $2",
    [deployment_id, key]
  );
}

export async function getEnvs(deployment_id: string): Promise<{ key: string; value: string }[]> {
  const res = await pool.query(
    "SELECT key, value FROM deployment_envs WHERE deployment_id = $1 ORDER BY key",
    [deployment_id]
  );
  return res.rows;
}
