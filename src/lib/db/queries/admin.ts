import { count, desc, eq, inArray, like } from 'drizzle-orm';
import { getDbAsync } from '../client';
import { chunkedInArray } from '../chunk';
import {
  adminEvents,
  leagueMembers,
  leagues,
  profiles,
  type AdminEvent,
  type NewAdminEvent,
} from '../schema';
import { encodeJson, decodeJson, type Json } from '../json';

export type AdminEventOut = Omit<AdminEvent, 'payload'> & { payload: Json | null };

export async function listAdminEvents(
  options: { limit?: number; offset?: number; eventType?: string } = {},
): Promise<AdminEventOut[]> {
  const db = await getDbAsync();
  // The event-type filter must be applied in SQL, not after slicing a page —
  // filtering an already-paginated page silently returns fewer rows than exist.
  const rows = await db
    .select()
    .from(adminEvents)
    .where(options.eventType ? eq(adminEvents.eventType, options.eventType) : undefined)
    .orderBy(desc(adminEvents.createdAt))
    .limit(options.limit ?? 100)
    .offset(options.offset ?? 0);
  return rows.map((r) => ({ ...r, payload: decodeJson(r.payload) }));
}

/**
 * Every event type that has actually been logged, for the /admin/events filter.
 * Derived rather than hardcoded: a literal list drifted to 5 of 13 types and
 * hid both `*_failed` events, the ones that need manual cleanup.
 */
export async function listAdminEventTypes(): Promise<string[]> {
  const db = await getDbAsync();
  const rows = await db
    .selectDistinct({ eventType: adminEvents.eventType })
    .from(adminEvents)
    .orderBy(adminEvents.eventType);
  return rows.map((r) => r.eventType);
}

/**
 * Count of `*_failed` events (e.g. a user whose app data was deleted but whose
 * Clerk account survived). Each one needs a manual look.
 */
export async function countFailedAdminEvents(): Promise<number> {
  const db = await getDbAsync();
  const rows = await db
    .select({ n: count() })
    .from(adminEvents)
    .where(like(adminEvents.eventType, '%failed'));
  return rows[0]?.n ?? 0;
}

export type AdminEventInput = {
  eventType: string;
  userId?: string | null;
  userEmail?: string | null;
  /**
   * Must name a league that still exists: `admin_events.league_id` is a
   * foreign key and D1 enforces it, so a row pointing at a deleted league is
   * rejected. An event about a league that is gone carries the id in its
   * payload instead.
   */
  leagueId?: string | null;
  payload?: Json | null;
};

/**
 * The row one event becomes. Shared by `logAdminEvent` and by the deletes
 * that write their log row in the same batch as the delete itself.
 */
export function adminEventRow(input: AdminEventInput): NewAdminEvent {
  return {
    id: crypto.randomUUID(),
    createdAt: new Date().toISOString(),
    eventType: input.eventType,
    userId: input.userId ?? null,
    userEmail: input.userEmail ?? null,
    leagueId: input.leagueId ?? null,
    payload: encodeJson(input.payload ?? null),
  };
}

export async function logAdminEvent(input: AdminEventInput): Promise<void> {
  // Never throws: callers log after their primary write has landed, and a
  // failed audit row must not turn a successful create into an error. That
  // trade is wrong for a delete, where the row is the only copy of what was
  // removed — deletes pass their event to the query instead, which writes it
  // in the same batch (see deleteSession, deleteLeague, deleteUserAppData).
  try {
    const db = await getDbAsync();
    await db.insert(adminEvents).values(adminEventRow(input));
  } catch (err) {
    console.error(`logAdminEvent(${input.eventType}) failed:`, err);
  }
}

/**
 * Add a user to leagues as the super-admin, who is not necessarily a league
 * admin (so `addMember`'s league-admin gate does not fit). The caller MUST be
 * `requireAdmin()`-gated. Unknown league ids are skipped; returns the ids
 * actually joined. Existing memberships are left untouched.
 */
export async function adminAddUserToLeagues(
  userId: string,
  email: string,
  leagueIds: string[],
): Promise<string[]> {
  const ids = Array.from(new Set(leagueIds));
  if (ids.length === 0) return [];
  const db = await getDbAsync();
  const known = await chunkedInArray(ids, (chunk) =>
    db.select({ id: leagues.id }).from(leagues).where(inArray(leagues.id, chunk)),
  );
  if (known.length === 0) return [];
  const now = new Date().toISOString();
  const rows = known.map((l) => ({
    leagueId: l.id,
    userId,
    email,
    role: 'player' as const,
    createdAt: now,
  }));
  // Five bound values per row against D1's 100-parameter cap: 18 rows a statement.
  await chunkedInArray(
    rows,
    async (chunk) => {
      await db.insert(leagueMembers).values(chunk).onConflictDoNothing();
      return [];
    },
    MEMBER_INSERT_CHUNK,
  );
  return known.map((l) => l.id);
}

const MEMBER_INSERT_CHUNK = 18;

/**
 * Delete a user's app data: their league memberships, the leagues they own
 * (sessions in those leagues keep existing with league_id set to NULL), and
 * their profile row.
 *
 * Deliberately NOT deleted: game_sessions.created_by and match_players.user_id
 * still hold the user's ID so other players keep their match history. Those
 * columns are plain text (Clerk IDs, no FK), and the UI renders the missing
 * profile as "Deleted player".
 *
 * Caller is responsible for deleting the Clerk user via Clerk Backend API.
 *
 * Each owned league takes its whole roster with it, so each gets a
 * `league.deleted` log row (name, owner, members) first — the same snapshot
 * the league's own delete button writes. A D1 batch is one transaction: the
 * snapshots and the deletes land together or not at all, and a re-run after
 * the leagues are gone finds nothing to snapshot.
 */
export async function deleteUserAppData(userId: string): Promise<void> {
  const db = await getDbAsync();
  const owned = await db.select().from(leagues).where(eq(leagues.ownerId, userId));
  const rosters =
    owned.length === 0
      ? []
      : await chunkedInArray(
          owned.map((l) => l.id),
          (chunk) => db.select().from(leagueMembers).where(inArray(leagueMembers.leagueId, chunk)),
        );
  const snapshots = owned.map((league) =>
    db.insert(adminEvents).values(
      adminEventRow({
        eventType: 'league.deleted',
        // No leagueId: the league is deleted later in this same batch.
        payload: {
          league_id: league.id,
          name: league.name,
          owner_id: league.ownerId,
          reason: 'owner_account_deleted',
          members: rosters
            .filter((m) => m.leagueId === league.id)
            .map((m) => ({ user_id: m.userId, role: m.role, email: m.email ?? null })),
        },
      }),
    ),
  );
  const ops = [
    ...snapshots,
    db.delete(leagueMembers).where(eq(leagueMembers.userId, userId)),
    db.delete(leagues).where(eq(leagues.ownerId, userId)),
    db.delete(profiles).where(eq(profiles.id, userId)),
  ];
  await db.batch(ops as [(typeof ops)[number], ...(typeof ops)[number][]]);
}
