export type Lease = {
  scope: string;
  id: string;
  owner: string;
  generation: number;
  expires_at: number;
};
export const LEASE_MS = 45000;
export const RENEW_MS = 10000;
export class Leases {
  constructor(private readonly db: D1Database) {}
  async claim(
    scope: string,
    id: string,
    now = Date.now(),
  ): Promise<Lease | null> {
    const owner = crypto.randomUUID();
    return this.db
      .prepare(
        `INSERT INTO assistant_leases(scope,id,owner,generation,expires_at) VALUES (?1,?2,?3,1,?4)
      ON CONFLICT(scope,id) DO UPDATE SET owner=excluded.owner,generation=assistant_leases.generation+1,expires_at=excluded.expires_at
      WHERE assistant_leases.expires_at<=?5 RETURNING *`,
      )
      .bind(scope, id, owner, now + LEASE_MS, now)
      .first<Lease>();
  }
  async active(scope: string, id: string) {
    return !!(await this.db
      .prepare(
        "SELECT 1 FROM assistant_leases WHERE scope=? AND id=? AND expires_at>?",
      )
      .bind(scope, id, Date.now())
      .first());
  }
  async renew(lease: Lease, now = Date.now()): Promise<boolean> {
    const result = await this.db
      .prepare(
        `UPDATE assistant_leases SET expires_at=?1 WHERE scope=?2 AND id=?3 AND owner=?4 AND generation=?5 AND expires_at>?6`,
      )
      .bind(
        now + LEASE_MS,
        lease.scope,
        lease.id,
        lease.owner,
        lease.generation,
        now,
      )
      .run();
    if (result.meta.changes === 1) lease.expires_at = now + LEASE_MS;
    return result.meta.changes === 1;
  }
  async valid(lease: Lease, now = Date.now()): Promise<boolean> {
    return !!(await this.db
      .prepare(
        `SELECT 1 FROM assistant_leases WHERE scope=?1 AND id=?2 AND owner=?3 AND generation=?4 AND expires_at>?5`,
      )
      .bind(lease.scope, lease.id, lease.owner, lease.generation, now)
      .first());
  }
  async release(lease: Lease): Promise<void> {
    await this.db
      .prepare(
        `UPDATE assistant_leases SET expires_at=0 WHERE scope=?1 AND id=?2 AND owner=?3 AND generation=?4`,
      )
      .bind(lease.scope, lease.id, lease.owner, lease.generation)
      .run();
  }
}
