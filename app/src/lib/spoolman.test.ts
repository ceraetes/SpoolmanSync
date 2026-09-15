import { describe, it, expect } from 'vitest';
import { parseExtraValue, buildSpoolSearchValue, type Spool } from './api/spoolman';

describe('parseExtraValue (Spoolman stores extra values as JSON strings)', () => {
  it('unwraps JSON-encoded strings', () => {
    expect(parseExtraValue('"hello"')).toBe('hello');
    expect(parseExtraValue('"sensor.x1c_ams_1_tray_1"')).toBe('sensor.x1c_ams_1_tray_1');
  });

  it('returns empty string for undefined/empty', () => {
    expect(parseExtraValue(undefined)).toBe('');
    expect(parseExtraValue('')).toBe('');
  });

  it('coerces non-string JSON to string and passes through non-JSON', () => {
    expect(parseExtraValue('123')).toBe('123');
    expect(parseExtraValue('raw-not-json')).toBe('raw-not-json');
  });
});

describe('buildSpoolSearchValue', () => {
  const spool = {
    id: 42,
    filament: {
      id: 1,
      name: 'Galaxy Black',
      material: 'PLA',
      vendor: { id: 1, name: 'Bambu Lab', registered: '' },
      color_hex: '000000',
      multi_color_hexes: null,
      multi_color_direction: null,
      density: 1.24,
      diameter: 1.75,
    },
    remaining_weight: 800,
    used_weight: 200,
    initial_weight: 1000,
    registered: '2026-01-01',
    extra: { active_tray: '"x1c_ams_1_tray_1"', location: '"Shelf A"' },
    archived: false,
  } as unknown as Spool;

  it('includes id, vendor, material, name and parsed extra values', () => {
    const s = buildSpoolSearchValue(spool);
    expect(s).toContain('42');
    expect(s).toContain('Bambu Lab');
    expect(s).toContain('PLA');
    expect(s).toContain('Galaxy Black');
    // extra values are unwrapped from their JSON encoding
    expect(s).toContain('x1c_ams_1_tray_1');
    expect(s).toContain('Shelf A');
  });
});
