import { eq, inArray } from 'drizzle-orm';
import { getDbAsync } from '../client';
import { chunkedInArray } from '../chunk';
import {
  gameSessions,
  matches,
  matchPlayers,
  matchResults,
  sessionGuests,
  type GameSession,
  type Match,
  type MatchPlayer,
  type NewGameSession,
  type NewMatchPlayer,
  type MatchResult,
} from '../schema';
import { AuthorizationError } from '../auth-helpers';
import { canManageSession, getSessionById } from './sessions';

async function requireSessionManager(callerId: string, sessionId: string): Promise<void> {
  const session = await getSessionById(sessionId);
  if (!session) throw new AuthorizationError(404, 'Session not found');
  if (!(await canManageSession(callerId, session))) {
    throw new AuthorizationError(403, 'Cannot manage matches for this session');
  }
}

export async function listMatchesForSession(sessionId: string): Promise<Match[]> {
  const db = await getDbAsync();
  return db.select().from(matches).where(eq(matches.sessionId, sessionId));
}

export async function getMatchById(id: string): Promise<Match | null> {
  const db = await getDbAsync();
  const rows = await db.select().from(matches).where(eq(matches.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function listPlayersForMatches(matchIds: string[]): Promise<MatchPlayer[]> {
  if (matchIds.length === 0) return [];
  const db = await getDbAsync();
  return chunkedInArray(matchIds, (chunk) =>
    db.select().from(matchPlayers).where(inArray(matchPlayers.matchId, chunk)),
  );
}

export async function listResultsForMatches(matchIds: string[]): Promise<MatchResult[]> {
  if (matchIds.length === 0) return [];
  const db = await getDbAsync();
  return chunkedInArray(matchIds, (chunk) =>
    db.select().from(matchResults).where(inArray(matchResults.matchId, chunk)),
  );
}

/**
 * Create a session with its guests, matches and players in ONE batch. A D1
 * batch is a single transaction, so a failure part-way leaves nothing behind;
 * as three separate writes, a failed guest or match insert used to leave an
 * empty session in the list.
 *
 * No gate of its own beyond "the caller becomes the creator": the action
 * checks league membership and that every placed user is a member before it
 * calls this, and nothing here reads or changes anyone else's rows.
 *
 * `players[].guestIndex` points into `guests`; IDs are generated here.
 */
export async function createSessionWithMatches(
  callerId: string,
  input: Omit<NewGameSession, 'id' | 'createdBy' | 'createdAt'>,
  guests: ReadonlyArray<{ displayName: string; dupr: number }>,
  newMatches: ReadonlyArray<{ scheduledOrder: number }>,
  players: ReadonlyArray<{
    matchIndex: number;
    userId?: string;
    guestIndex?: number;
    team: 1 | 2;
    position: number;
  }>,
): Promise<Pick<GameSession, 'id' | 'leagueId' | 'playerCount' | 'scheduledFor'>> {
  const db = await getDbAsync();
  const now = new Date().toISOString();
  const session = { ...input, id: crypto.randomUUID(), createdBy: callerId, createdAt: now };

  const guestRows = guests.map((g) => ({
    id: crypto.randomUUID(),
    sessionId: session.id,
    displayName: g.displayName.trim(),
    dupr: g.dupr,
    createdAt: now,
  }));
  const matchRows = newMatches.map((m) => ({
    id: crypto.randomUUID(),
    sessionId: session.id,
    courtNumber: null,
    scheduledOrder: m.scheduledOrder,
    status: 'scheduled' as const,
    createdAt: now,
  }));
  const playerRows: NewMatchPlayer[] = players.map((p) => ({
    id: crypto.randomUUID(),
    matchId: matchRows[p.matchIndex].id,
    userId: p.userId ?? null,
    guestId: p.guestIndex === undefined ? null : guestRows[p.guestIndex].id,
    team: p.team,
    position: p.position,
  }));

  // D1 caps a statement at 100 bound values. Guests bind 5 columns a row,
  // matches and match_players 6: 15 rows a statement stays at 90 or under.
  const INSERT_CHUNK = 15;
  const chunks = <T,>(rows: T[]): T[][] => {
    const out: T[][] = [];
    for (let i = 0; i < rows.length; i += INSERT_CHUNK) out.push(rows.slice(i, i + INSERT_CHUNK));
    return out;
  };
  // Parents before children: players point at both matches and guests.
  await db.batch([
    db.insert(gameSessions).values(session),
    ...chunks(guestRows).map((c) => db.insert(sessionGuests).values(c)),
    ...chunks(matchRows).map((c) => db.insert(matches).values(c)),
    ...chunks(playerRows).map((c) => db.insert(matchPlayers).values(c)),
  ]);

  return {
    id: session.id,
    leagueId: session.leagueId ?? null,
    playerCount: session.playerCount,
    scheduledFor: session.scheduledFor ?? null,
  };
}

/**
 * Save a score and mark the match completed, as one batch: the two rows can
 * no longer disagree (a score on a match still marked scheduled).
 */
export async function recordMatchResult(
  callerId: string,
  matchId: string,
  result: { team1Score: number; team2Score: number },
): Promise<void> {
  const match = await getMatchById(matchId);
  if (!match) throw new AuthorizationError(404, 'Match not found');
  await requireSessionManager(callerId, match.sessionId);
  const db = await getDbAsync();
  const now = new Date().toISOString();
  await db.batch([
    db
      .insert(matchResults)
      .values({
        matchId,
        team1Score: result.team1Score,
        team2Score: result.team2Score,
        completedAt: now,
      })
      .onConflictDoUpdate({
        target: matchResults.matchId,
        set: {
          team1Score: result.team1Score,
          team2Score: result.team2Score,
          completedAt: now,
        },
      }),
    db.update(matches).set({ status: 'completed' }).where(eq(matches.id, matchId)),
  ]);
}

/** Remove a score and put the match back to scheduled, as one batch. */
export async function clearMatchResult(callerId: string, matchId: string): Promise<void> {
  // A missing match must fail the gate, not skip it.
  const match = await getMatchById(matchId);
  if (!match) throw new AuthorizationError(404, 'Match not found');
  await requireSessionManager(callerId, match.sessionId);
  const db = await getDbAsync();
  await db.batch([
    db.delete(matchResults).where(eq(matchResults.matchId, matchId)),
    db.update(matches).set({ status: 'scheduled' }).where(eq(matches.id, matchId)),
  ]);
}
