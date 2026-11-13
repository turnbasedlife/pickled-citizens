import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { Miniflare } from 'miniflare';
import { drizzle } from 'drizzle-orm/d1';
import { eq } from 'drizzle-orm';
import type { SQLiteTable } from 'drizzle-orm/sqlite-core';
import * as schema from '@/lib/db/schema';

/**
 * The write paths that span several tables, run against a real local D1
 * (Miniflare, the same engine `wrangler dev` uses) with the real migrations
 * applied. Every other test stubs the database, which pins statement order
 * but cannot see a foreign key reject a row or a batch roll back — the two
 * things these writes depend on.
 *
 * Miniflare serves the database over a local port. Where a sandbox forbids
 * that (it does not on CI or a normal terminal) the suite reports itself
 * skipped instead of hanging.
 */

const canListen = await new Promise<boolean>((resolve) => {
  const probe = createServer();
  probe.once('error', () => resolve(false));
  probe.listen(0, '127.0.0.1', () => probe.close(() => resolve(true)));
});

const holder: { db: ReturnType<typeof drizzle<typeof schema>> | null } = { db: null };
vi.mock('@/lib/db/client', () => ({ getDbAsync: async () => holder.db }));

let mf: Miniflare | undefined;
const db = () => holder.db!;
const count = async (table: SQLiteTable) => (await db().select().from(table)).length;

describe.skipIf(!canListen)('against a real local D1', () => {
  let sessionId = '';
  let matchId = '';

  beforeAll(async () => {
    mf = new Miniflare({
      modules: true,
      script: 'export default { fetch() { return new Response("ok"); } }',
      d1Databases: { DB: 'pickled-citizens-test' },
    });
    const d1 = (await mf.getD1Database('DB')) as unknown as D1Database;
    const dir = join(process.cwd(), 'drizzle');
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      for (const stmt of readFileSync(join(dir, file), 'utf8').split('--> statement-breakpoint')) {
        if (stmt.trim()) await d1.prepare(stmt).run();
      }
    }
    holder.db = drizzle(d1, { schema });
    await db().insert(schema.leagues).values({ id: 'L1', name: 'Tuesday Crew', ownerId: 'owner' });
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
  });

  it('creates a session with guests, matches and players in one batch', async () => {
    const { createSessionWithMatches } = await import('@/lib/db/queries/matches');
    const session = await createSessionWithMatches(
      'owner',
      { leagueId: 'L1', scheduledFor: null, playerCount: 6, location: null },
      Array.from({ length: 16 }, (_, i) => ({ displayName: `Guest ${i}`, dupr: 3.5 })),
      Array.from({ length: 20 }, (_, i) => ({ scheduledOrder: i })),
      Array.from({ length: 20 }, (_, i) => [
        { matchIndex: i, userId: 'owner', team: 1 as const, position: 0 },
        { matchIndex: i, guestIndex: i % 16, team: 2 as const, position: 0 },
      ]).flat(),
    );
    sessionId = session.id;
    expect(await count(schema.gameSessions)).toBe(1);
    expect(await count(schema.sessionGuests)).toBe(16);
    expect(await count(schema.matches)).toBe(20);
    expect(await count(schema.matchPlayers)).toBe(40);
    matchId = (await db().select().from(schema.matches))[0].id;
  });

  it('rolls the whole create back when one row is refused', async () => {
    const { createSessionWithMatches } = await import('@/lib/db/queries/matches');
    await expect(
      createSessionWithMatches(
        'owner',
        // player_count is constrained to 6, 8, 10 or 12.
        { leagueId: 'L1', scheduledFor: null, playerCount: 7 as 6, location: null },
        [{ displayName: 'Ringer', dupr: 3.5 }],
        [{ scheduledOrder: 0 }],
        [{ matchIndex: 0, userId: 'owner', team: 1, position: 0 }],
      ),
    ).rejects.toThrow();
    expect(await count(schema.gameSessions)).toBe(1);
    expect(await count(schema.sessionGuests)).toBe(16);
    expect(await count(schema.matches)).toBe(20);
  });

  it('records a score and completes the match, then clears both', async () => {
    const { recordMatchResult, clearMatchResult } = await import('@/lib/db/queries/matches');
    const status = async () =>
      (await db().select().from(schema.matches).where(eq(schema.matches.id, matchId)))[0].status;

    await recordMatchResult('owner', matchId, { team1Score: 1, team2Score: 0 });
    await recordMatchResult('owner', matchId, { team1Score: 0, team2Score: 1 }); // re-score
    const results = await db().select().from(schema.matchResults);
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ matchId, team1Score: 0, team2Score: 1 });
    expect(await status()).toBe('completed');

    await clearMatchResult('owner', matchId);
    expect(await count(schema.matchResults)).toBe(0);
    expect(await status()).toBe('scheduled');
  });

  it('deletes a session with its log row, cascading its matches and guests', async () => {
    const { deleteSession } = await import('@/lib/db/queries/sessions');
    await deleteSession('owner', sessionId, {
      eventType: 'session.deleted',
      userId: 'owner',
      leagueId: 'L1',
      payload: { session_id: sessionId },
    });
    expect(await count(schema.gameSessions)).toBe(0);
    expect(await count(schema.matches)).toBe(0);
    expect(await count(schema.matchPlayers)).toBe(0);
    expect(await count(schema.sessionGuests)).toBe(0);
    const events = await db().select().from(schema.adminEvents);
    expect(events.map((e) => [e.eventType, e.leagueId])).toEqual([['session.deleted', 'L1']]);
  });

  it('refuses a log row that points at a league that is gone', async () => {
    // The 2026-11-06 bug: this insert failed and the logger swallowed it.
    await expect(
      db().insert(schema.adminEvents).values({ eventType: 'league.deleted', leagueId: 'gone' }),
    ).rejects.toThrow();
  });

  it('deletes a league with its log row in the same batch', async () => {
    const { deleteLeague } = await import('@/lib/db/queries/leagues');
    await deleteLeague('owner', 'L1', {
      eventType: 'league.deleted',
      userId: 'owner',
      payload: { league_id: 'L1', name: 'Tuesday Crew' },
    });
    expect(await count(schema.leagues)).toBe(0);
    const events = await db().select().from(schema.adminEvents);
    const row = events.find((e) => e.eventType === 'league.deleted');
    expect(row?.leagueId).toBeNull();
    expect(JSON.parse(row?.payload ?? '{}')).toMatchObject({ league_id: 'L1' });
    // The earlier session.deleted row pointed at L1: ON DELETE SET NULL kept it.
    expect(events.find((e) => e.eventType === 'session.deleted')?.leagueId).toBeNull();
  });
});
