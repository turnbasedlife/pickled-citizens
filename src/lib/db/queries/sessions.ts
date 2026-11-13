import { eq } from 'drizzle-orm';
import { getDbAsync } from '../client';
import {
  adminEvents,
  gameSessions,
  sessionGuests,
  type GameSession,
  type SessionGuest,
} from '../schema';
import { AuthorizationError } from '../auth-helpers';
import { isLeagueAdmin, isLeagueMember } from './leagues';
import { adminEventRow, type AdminEventInput } from './admin';

export async function getSessionById(id: string): Promise<GameSession | null> {
  const db = await getDbAsync();
  const rows = await db.select().from(gameSessions).where(eq(gameSessions.id, id)).limit(1);
  return rows[0] ?? null;
}

/**
 * Write access to a session: scores, guests, deletion. The creator, or anyone
 * who runs the league — its owner or a member with the admin role. League
 * admins manage sessions other admins created; without this they could only
 * read them.
 */
export async function canManageSession(
  callerId: string,
  session: Pick<GameSession, 'createdBy' | 'leagueId'>,
): Promise<boolean> {
  if (session.createdBy === callerId) return true;
  if (session.leagueId && (await isLeagueAdmin(session.leagueId, callerId))) return true;
  return false;
}

/**
 * Read access to a session. Broader than canManageSession: any league member
 * may view, not just the creator and league admins.
 *
 * `participantIds` are the user IDs already loaded from match_players. They
 * matter because `game_sessions.league_id` is ON DELETE SET NULL — deleting a
 * league orphans its sessions, and the people who played in them should keep
 * access to their own history even though there is no league left to join.
 */
export async function canViewSession(
  callerId: string,
  session: Pick<GameSession, 'createdBy' | 'leagueId'>,
  participantIds: ReadonlyArray<string | null>,
): Promise<boolean> {
  if (session.createdBy === callerId) return true;
  if (participantIds.includes(callerId)) return true;
  if (session.leagueId && (await isLeagueMember(session.leagueId, callerId))) return true;
  return false;
}

/**
 * `event`, when given, is the delete's log row, written in the same batch as
 * the delete. A D1 batch is one transaction, so the session cannot go without
 * its row landing: the cascade removes matches, players, scores and guests,
 * and that row is the only copy left. A failed insert fails the delete.
 */
export async function deleteSession(
  callerId: string,
  sessionId: string,
  event?: AdminEventInput,
): Promise<void> {
  const session = await getSessionById(sessionId);
  if (!session) return;
  if (!(await canManageSession(callerId, session))) {
    throw new AuthorizationError(403, 'Cannot delete this session');
  }
  const db = await getDbAsync();
  const remove = db.delete(gameSessions).where(eq(gameSessions.id, sessionId));
  if (!event) {
    await remove;
    return;
  }
  await db.batch([db.insert(adminEvents).values(adminEventRow(event)), remove]);
}

// ---- Session guests ----

export async function listGuestsForSession(sessionId: string): Promise<SessionGuest[]> {
  const db = await getDbAsync();
  return db.select().from(sessionGuests).where(eq(sessionGuests.sessionId, sessionId));
}
