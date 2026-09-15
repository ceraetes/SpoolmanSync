/**
 * Virtual printers (issue #67).
 *
 * A "virtual printer" is a user-defined storage location — a filament dryer, a
 * dry box, a shelf — that has no Home Assistant entity behind it. Its slots are
 * assignable exactly like real AMS trays, enabling QR/NFC-based inventory
 * management for filament that isn't loaded in a printer.
 *
 * Virtual printers are persisted as JSON in the Settings key/value table. Their
 * slots are assigned by a key stored in Spoolman's extra.active_tray, in the
 * human-readable form `virtual_<printer name>_tray_<N>` — same underscore-
 * delimited structure as a real AMS unique_id, so it reads cleanly in Spoolman
 * (issue #70). The key never starts with `sensor.`, so it bypasses the
 * entity_id→unique_id resolver and is never written into any HA automation;
 * virtual slots therefore receive no usage tracking (by design).
 *
 * Stability: each slot carries a stable integer `number` assigned at creation
 * and never reused, so the displayed/keyed `tray_<N>` is stable across slot
 * add/remove. Only a printer rename changes the `<printer name>` segment of the
 * key — handled deterministically by re-keying the affected Spoolman spools
 * (see rekeyVirtualAssignments).
 */
import { randomUUID } from 'crypto';
import prisma from '@/lib/db';
import type { HAPrinter, HATray } from '@/lib/api/homeassistant';
import { SpoolmanClient } from '@/lib/api/spoolman';

export const VIRTUAL_PRINTERS_KEY = 'virtual_printers';
export const VIRTUAL_KEY_PREFIX = 'virtual_';
/** Set once the v1.6.2 friendly-key migration has run. */
export const VIRTUAL_MIGRATION_KEY = 'virtual_keys_migrated_v162';

export interface VirtualSlot {
  id: string;       // internal stable identity (not user-facing)
  number: number;   // stable, never-reused slot number used in the key and display
}

export interface VirtualPrinter {
  id: string;
  name: string;
  slots: VirtualSlot[];
}

/**
 * Build the friendly assignment key for a virtual slot, e.g.
 * `virtual_Dry Box A_tray_1`. Mirrors the real-AMS key structure.
 */
export function virtualSlotKey(printerName: string, slotNumber: number): string {
  return `${VIRTUAL_KEY_PREFIX}${printerName}_tray_${slotNumber}`;
}

/** Next never-reused slot number for a printer. */
export function nextSlotNumber(slots: VirtualSlot[]): number {
  return slots.reduce((max, s) => Math.max(max, s.number), 0) + 1;
}

/**
 * Normalize stored slots into `{ id, number }`, assigning stable unique numbers.
 * Tolerates the legacy `{ id, name }` shape (pre-v1.6.2) and any partial data:
 * existing valid numbers are preserved; missing ones get the smallest unused
 * positive integer, in array order. Deterministic for a given stored array.
 */
function normalizeSlots(rawSlots: unknown): VirtualSlot[] {
  if (!Array.isArray(rawSlots)) return [];
  const slots: VirtualSlot[] = rawSlots
    .filter((s): s is Record<string, unknown> => !!s && typeof s === 'object')
    .map((s) => ({
      id: typeof s.id === 'string' && s.id ? s.id : randomUUID(),
      number: typeof s.number === 'number' && Number.isInteger(s.number) && s.number > 0 ? s.number : 0,
    }));

  const used = new Set<number>();
  for (const s of slots) {
    if (s.number > 0 && !used.has(s.number)) used.add(s.number);
    else s.number = 0; // collision or missing → reassign below
  }
  let next = 1;
  for (const s of slots) {
    if (s.number === 0) {
      while (used.has(next)) next++;
      s.number = next;
      used.add(next);
    }
  }
  return slots;
}

/** Read and parse the stored virtual printers (always returns an array, normalized). */
export async function getVirtualPrinters(): Promise<VirtualPrinter[]> {
  const setting = await prisma.settings.findUnique({ where: { key: VIRTUAL_PRINTERS_KEY } });
  if (!setting?.value) return [];
  try {
    const parsed = JSON.parse(setting.value);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((p): p is Record<string, unknown> => !!p && typeof p === 'object' && typeof p.id === 'string' && typeof p.name === 'string')
      .map((p) => ({
        id: p.id as string,
        name: p.name as string,
        slots: normalizeSlots(p.slots),
      }));
  } catch {
    return [];
  }
}

/** Persist the full virtual-printers list. */
export async function saveVirtualPrinters(printers: VirtualPrinter[]): Promise<void> {
  const value = JSON.stringify(printers);
  await prisma.settings.upsert({
    where: { key: VIRTUAL_PRINTERS_KEY },
    create: { key: VIRTUAL_PRINTERS_KEY, value },
    update: { value },
  });
}

/**
 * Serialize virtual-printer read-modify-write operations (the stored model is a
 * single JSON blob, so concurrent mutations would otherwise clobber each other
 * last-write-wins). Module-level promise chain — not reentrant, so callers must
 * NOT nest withVirtualLock calls.
 */
let virtualLock: Promise<unknown> = Promise.resolve();
export function withVirtualLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = virtualLock.then(fn, fn);
  virtualLock = run.then(() => undefined, () => undefined);
  return run;
}

/**
 * Re-point Spoolman spools whose active_tray equals one of the old keys onto the
 * corresponding new key, preserving all other extra fields. Used by the v1.6.2
 * migration and by printer renames. No-op for keys with no matching spool.
 */
export async function rekeyVirtualAssignments(
  client: SpoolmanClient,
  remap: Array<{ oldKey: string; newKey: string; oldLocation?: string; newLocation?: string }>,
): Promise<void> {
  const pairs = remap.filter((r) => r.oldKey !== r.newKey);
  if (pairs.length === 0) return;
  const byOld = new Map(pairs.map((r) => [JSON.stringify(r.oldKey), r]));
  const spools = await client.getSpools(true); // include archived so history stays linked

  // All-or-nothing: if any spool fails to update, roll back the ones already
  // moved so a rename/migration never half-applies and leaves orphans.
  // `location` is captured/restored only when we actually change it, so a
  // manually-set location is never touched.
  const moved: Array<{ id: number; extra: Record<string, string>; location?: string | null }> = [];
  try {
    for (const spool of spools) {
      const raw = spool.extra?.['active_tray'];
      if (!raw || !byOld.has(raw)) continue;
      const entry = byOld.get(raw)!;
      const originalExtra: Record<string, string> = { ...(spool.extra || {}) };
      const newExtra: Record<string, string> = { ...originalExtra, active_tray: JSON.stringify(entry.newKey) };
      const data: Record<string, unknown> = { extra: newExtra };

      // Follow the location too, but only if it still equals the label we set
      // (i.e. the old virtual-printer name). A user-changed location is left as-is.
      const changesLocation =
        entry.newLocation !== undefined &&
        entry.oldLocation !== undefined &&
        spool.location === entry.oldLocation;
      if (changesLocation) data.location = entry.newLocation;

      await client.updateSpool(spool.id, data);
      moved.push({ id: spool.id, extra: originalExtra, location: changesLocation ? (spool.location ?? '') : undefined });
    }
  } catch (err) {
    for (const m of moved) {
      try {
        const rollback: Record<string, unknown> = { extra: m.extra };
        if (m.location !== undefined) rollback.location = m.location;
        await client.updateSpool(m.id, rollback);
      } catch { /* best-effort rollback */ }
    }
    throw err;
  }
}

/**
 * One-time migration from the legacy opaque key `virtual:<printerId>:<slotId>`
 * to the friendly `virtual_<name>_tray_<N>` key (issue #70). Idempotent and
 * guarded by a Settings flag; on failure the flag is left unset so it retries.
 */
export async function migrateVirtualKeys(client: SpoolmanClient): Promise<void> {
  try {
    const flag = await prisma.settings.findUnique({ where: { key: VIRTUAL_MIGRATION_KEY } });
    if (flag?.value === 'true') return;

    const printers = await getVirtualPrinters(); // normalized: slots have id + number

    // Build legacy oldKeys from the RAW stored slot ids (matched to the
    // normalized slot by id), so we never base a legacy key on an id that
    // normalizeSlots may have synthesized for a malformed entry.
    const rawSlotsByPrinter = new Map<string, Array<{ id?: unknown }>>();
    const rawSetting = await prisma.settings.findUnique({ where: { key: VIRTUAL_PRINTERS_KEY } });
    if (rawSetting?.value) {
      try {
        const rawParsed = JSON.parse(rawSetting.value);
        if (Array.isArray(rawParsed)) {
          for (const p of rawParsed) {
            if (p && typeof p.id === 'string' && Array.isArray(p.slots)) rawSlotsByPrinter.set(p.id, p.slots);
          }
        }
      } catch { /* ignore malformed raw data */ }
    }

    const remap: Array<{ oldKey: string; newKey: string }> = [];
    for (const vp of printers) {
      const numberById = new Map(vp.slots.map((s) => [s.id, s.number]));
      for (const rawSlot of rawSlotsByPrinter.get(vp.id) || []) {
        const rawId = rawSlot?.id;
        if (typeof rawId === 'string' && rawId && numberById.has(rawId)) {
          remap.push({
            oldKey: `virtual:${vp.id}:${rawId}`,                       // legacy format
            newKey: virtualSlotKey(vp.name, numberById.get(rawId)!),   // friendly format
          });
        }
      }
    }
    await rekeyVirtualAssignments(client, remap);

    // Persist the normalized model so slot numbers are stable from here on.
    if (printers.length > 0) await saveVirtualPrinters(printers);

    await prisma.settings.upsert({
      where: { key: VIRTUAL_MIGRATION_KEY },
      create: { key: VIRTUAL_MIGRATION_KEY, value: 'true' },
      update: { value: 'true' },
    });
  } catch (err) {
    console.error('Virtual-key migration failed (will retry on next call):', err);
  }
}

/**
 * Convert virtual printers into HAPrinter-shaped objects so they can be merged
 * into the dashboard's printer list and reuse the existing PrinterCard / TraySlot
 * rendering and assignment flow. Each slot becomes a "Tray N" keyed by its
 * friendly assignment key.
 */
export function virtualPrintersToHAPrinters(printers: VirtualPrinter[]): HAPrinter[] {
  return printers.map((vp) => {
    const trays: HATray[] = vp.slots.map((slot) => ({
      entity_id: virtualSlotKey(vp.name, slot.number),
      unique_id: virtualSlotKey(vp.name, slot.number),
      tray_number: slot.number,
    }));

    return {
      brand: 'virtual',
      is_virtual: true,
      entity_id: `${VIRTUAL_KEY_PREFIX}${vp.id}`,
      name: vp.name,
      state: 'idle',
      prefix: `virtual_${vp.id}`,
      ams_units: trays.length > 0
        ? [{ entity_id: `${VIRTUAL_KEY_PREFIX}${vp.id}_slots`, name: vp.name, ams_number: 1, trays }]
        : [],
      external_spools: [],
    };
  });
}
