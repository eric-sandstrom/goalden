import { Timestamp } from 'firebase-admin/firestore';

// ---------------------------------------------------------------------------
// API shape (subset of what football-data.org returns)
// ---------------------------------------------------------------------------

export interface FootballDataPerson {
  readonly id: number | null;
  readonly name: string | null;
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly dateOfBirth?: string | null; // ISO date
  readonly nationality?: string | null;
}

export interface FootballDataPlayer extends FootballDataPerson {
  readonly position?: string | null; // "Goalkeeper" / "Defender" / etc.
  readonly shirtNumber?: number | null;
}

export interface FootballDataTeam {
  readonly id: number;
  readonly name: string | null;
  readonly shortName?: string | null;
  readonly tla?: string | null;
  readonly crest?: string | null;
  readonly founded?: number | null;
  readonly clubColors?: string | null;
  readonly venue?: string | null;
  readonly website?: string | null;
  readonly coach?: FootballDataPerson | null;
  readonly squad?: readonly FootballDataPlayer[];
}

export interface FootballDataTeamsResponse {
  readonly teams: readonly FootballDataTeam[];
}

// ---------------------------------------------------------------------------
// Firestore shape
// ---------------------------------------------------------------------------

export type PlayerPosition =
  | 'GOALKEEPER'
  | 'DEFENDER'
  | 'MIDFIELDER'
  | 'FORWARD'
  | 'UNKNOWN';

export interface PlayerDoc {
  id: number;
  name: string;
  position: PlayerPosition;
  nationality: string | null;
  dateOfBirth: Timestamp | null;
  shirtNumber: number | null;
}

export interface CoachDoc {
  id: number | null;
  name: string;
  nationality: string | null;
  dateOfBirth: Timestamp | null;
}

export interface TeamDoc {
  externalId: number;
  name: string;
  shortName: string | null;
  tla: string | null;
  crest: string | null;
  founded: number | null;
  clubColors: string | null;
  venue: string | null;
  website: string | null;
  coach: CoachDoc | null;
  squad: PlayerDoc[];
}

// ---------------------------------------------------------------------------
// Mapping
// ---------------------------------------------------------------------------

/** Maps football-data's free-text positions to our normalised enum. The API
 *  returns variations like "Centre-Back", "Right Winger", "Defensive Midfield"
 *  — we group them into the four conventional buckets so the team detail UI
 *  can sort and section the squad without dealing with dozens of strings. */
function normalisePosition(raw: string | null | undefined): PlayerPosition {
  if (!raw) return 'UNKNOWN';
  const v = raw.toLowerCase();
  if (v.includes('keeper')) return 'GOALKEEPER';
  if (v.includes('back') || v.includes('defen')) return 'DEFENDER';
  if (v.includes('midfield')) return 'MIDFIELDER';
  if (
    v.includes('forward') ||
    v.includes('striker') ||
    v.includes('winger') ||
    v.includes('offen')
  ) return 'FORWARD';
  return 'UNKNOWN';
}

function parseDate(iso: string | null | undefined): Timestamp | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return Timestamp.fromDate(d);
}

function personName(person: FootballDataPerson): string {
  if (person.name && person.name.trim().length > 0) return person.name;
  const first = person.firstName?.trim() ?? '';
  const last = person.lastName?.trim() ?? '';
  return [first, last].filter(Boolean).join(' ').trim();
}

export function mapTeam(t: FootballDataTeam): TeamDoc {
  const squad: PlayerDoc[] = (t.squad ?? []).map((p) => ({
    id: p.id ?? 0,
    name: personName(p),
    position: normalisePosition(p.position),
    nationality: p.nationality ?? null,
    dateOfBirth: parseDate(p.dateOfBirth),
    shirtNumber: typeof p.shirtNumber === 'number' ? p.shirtNumber : null,
  }));

  const coach: CoachDoc | null = t.coach
    ? {
        id: t.coach.id ?? null,
        name: personName(t.coach),
        nationality: t.coach.nationality ?? null,
        dateOfBirth: parseDate(t.coach.dateOfBirth),
      }
    : null;

  return {
    externalId: t.id,
    name: t.name ?? '',
    shortName: t.shortName ?? null,
    tla: t.tla ?? null,
    crest: t.crest ?? null,
    founded: t.founded ?? null,
    clubColors: t.clubColors ?? null,
    venue: t.venue ?? null,
    website: t.website ?? null,
    coach,
    squad,
  };
}

/** Cheap structural-ish equality check. Skips the squad's nested objects via
 *  JSON.stringify — squad lists are bounded (~25 players per team) so the
 *  serialise cost is trivial and saves an n*m field-by-field compare. Used
 *  to avoid pointless writes when football-data returns unchanged data. */
export function teamChanged(prev: TeamDoc | undefined, next: TeamDoc): boolean {
  if (!prev) return true;
  if (prev.name !== next.name) return true;
  if (prev.shortName !== next.shortName) return true;
  if (prev.tla !== next.tla) return true;
  if (prev.crest !== next.crest) return true;
  if (prev.founded !== next.founded) return true;
  if (prev.clubColors !== next.clubColors) return true;
  if (prev.venue !== next.venue) return true;
  if (prev.website !== next.website) return true;
  if (JSON.stringify(prev.coach) !== JSON.stringify(next.coach)) return true;
  if (JSON.stringify(prev.squad) !== JSON.stringify(next.squad)) return true;
  return false;
}
