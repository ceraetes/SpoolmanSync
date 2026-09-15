import { describe, it, expect } from 'vitest';
import {
  virtualSlotKey,
  nextSlotNumber,
  virtualPrintersToHAPrinters,
  rekeyVirtualAssignments,
  VIRTUAL_KEY_PREFIX,
} from './virtual-printers';
import type { SpoolmanClient } from './api/spoolman';

/** Minimal fake SpoolmanClient that records updateSpool calls. */
function fakeClient(spools: Array<Record<string, unknown>>) {
  const updates: Array<{ id: number; data: Record<string, unknown> }> = [];
  const client = {
    getSpools: async () => spools,
    updateSpool: async (id: number, data: Record<string, unknown>) => {
      updates.push({ id, data });
      return {} as unknown;
    },
  } as unknown as SpoolmanClient;
  return { client, updates };
}

describe('virtualSlotKey (issue #70 — friendly key)', () => {
  it('builds a readable underscore-delimited key mirroring real AMS keys', () => {
    expect(virtualSlotKey('Dry Box A', 1)).toBe('virtual_Dry Box A_tray_1');
    expect(virtualSlotKey('Dryer', 3)).toBe('virtual_Dryer_tray_3');
  });

  it('never starts with sensor. (so it bypasses the entity_id resolver)', () => {
    const key = virtualSlotKey('Anything', 2);
    expect(key.startsWith('sensor.')).toBe(false);
    expect(key.startsWith(VIRTUAL_KEY_PREFIX)).toBe(true);
  });
});

describe('nextSlotNumber (stable, never reused)', () => {
  it('returns 1 for an empty printer', () => {
    expect(nextSlotNumber([])).toBe(1);
  });
  it('returns max+1, so removing a middle slot never reuses a number', () => {
    expect(nextSlotNumber([{ id: 'a', number: 1 }, { id: 'c', number: 3 }])).toBe(4);
  });
});

describe('virtualPrintersToHAPrinters (issue #67/#70)', () => {
  it('maps slots to "Tray N" trays keyed by the friendly key', () => {
    const [hp] = virtualPrintersToHAPrinters([
      { id: 'p1', name: 'Dry Box A', slots: [{ id: 's1', number: 1 }, { id: 's2', number: 2 }] },
    ]);
    expect(hp.brand).toBe('virtual');
    expect(hp.is_virtual).toBe(true);
    expect(hp.name).toBe('Dry Box A');
    expect(hp.external_spools).toEqual([]);
    expect(hp.ams_units).toHaveLength(1);
    expect(hp.ams_units[0].trays).toHaveLength(2);

    const t0 = hp.ams_units[0].trays[0];
    expect(t0.unique_id).toBe('virtual_Dry Box A_tray_1');
    expect(t0.entity_id).toBe('virtual_Dry Box A_tray_1');
    expect(t0.tray_number).toBe(1);
    // not flagged external → renders as "Tray 1", not "External"
    expect(t0.is_external).toBeUndefined();

    expect(hp.ams_units[0].trays[1].unique_id).toBe('virtual_Dry Box A_tray_2');
  });

  it('keeps a stable key when a non-final slot is removed (uses slot.number, not index)', () => {
    const [hp] = virtualPrintersToHAPrinters([
      { id: 'p1', name: 'Dryer', slots: [{ id: 's1', number: 1 }, { id: 's3', number: 3 }] },
    ]);
    expect(hp.ams_units[0].trays.map((t) => t.unique_id)).toEqual([
      'virtual_Dryer_tray_1',
      'virtual_Dryer_tray_3',
    ]);
  });

  it('produces no AMS group for a printer with zero slots', () => {
    const [hp] = virtualPrintersToHAPrinters([{ id: 'p2', name: 'Empty', slots: [] }]);
    expect(hp.ams_units).toEqual([]);
    expect(hp.external_spools).toEqual([]);
  });
});

describe('rekeyVirtualAssignments — key + location remap on rename', () => {
  it('moves active_tray to the new key and follows location when it matches the old name', async () => {
    const { client, updates } = fakeClient([
      {
        id: 7,
        extra: { active_tray: JSON.stringify('virtual_Dry Box A_tray_1') },
        location: 'Dry Box A',
      },
    ]);

    await rekeyVirtualAssignments(client, [
      { oldKey: 'virtual_Dry Box A_tray_1', newKey: 'virtual_Dry Box B_tray_1', oldLocation: 'Dry Box A', newLocation: 'Dry Box B' },
    ]);

    expect(updates).toHaveLength(1);
    const data = updates[0].data as { extra: Record<string, string>; location?: string };
    expect(data.extra.active_tray).toBe(JSON.stringify('virtual_Dry Box B_tray_1'));
    expect(data.location).toBe('Dry Box B');
  });

  it('re-keys but leaves a manually-changed location alone', async () => {
    const { client, updates } = fakeClient([
      {
        id: 8,
        extra: { active_tray: JSON.stringify('virtual_Dry Box A_tray_1') },
        location: 'Somewhere else',
      },
    ]);

    await rekeyVirtualAssignments(client, [
      { oldKey: 'virtual_Dry Box A_tray_1', newKey: 'virtual_Dry Box B_tray_1', oldLocation: 'Dry Box A', newLocation: 'Dry Box B' },
    ]);

    const data = updates[0].data as { extra: Record<string, string>; location?: string };
    expect(data.extra.active_tray).toBe(JSON.stringify('virtual_Dry Box B_tray_1'));
    expect('location' in data).toBe(false);
  });

  it('does not send location when no location remap is provided (sync off)', async () => {
    const { client, updates } = fakeClient([
      { id: 9, extra: { active_tray: JSON.stringify('virtual_Dry Box A_tray_1') }, location: 'Dry Box A' },
    ]);

    await rekeyVirtualAssignments(client, [
      { oldKey: 'virtual_Dry Box A_tray_1', newKey: 'virtual_Dry Box B_tray_1' },
    ]);

    const data = updates[0].data as { extra: Record<string, string>; location?: string };
    expect(data.extra.active_tray).toBe(JSON.stringify('virtual_Dry Box B_tray_1'));
    expect('location' in data).toBe(false);
  });
});
