import { HomeAssistantClient, HAPrinter, HATray } from '@/lib/api/homeassistant';
import { Filament, parseExtraValue, Spool } from '@/lib/api/spoolman';
import { BambuAmsPushSettings } from '@/lib/bambu-ams-settings';
import { isValidTrayUuid } from '@/lib/tray-uuid';

export type AmsPushStatus =
  | 'pushed'
  | 'skipped_disabled'
  | 'skipped_not_bambu_printer'
  | 'skipped_bambu_vendor'
  | 'skipped_tray_has_rfid'
  | 'skipped_missing_tray_info_idx'
  | 'skipped_no_ha'
  | 'skipped_tray_not_found'
  | 'failed';

export interface AmsPushResult {
  status: AmsPushStatus;
  reason?: string;
}

export interface SetFilamentPayload {
  tray_info_idx: string;
  tray_color: string;
  tray_type: string;
  nozzle_temp_min: number;
  nozzle_temp_max: number;
}

const MATERIAL_TEMP_DEFAULTS: Record<string, { min: number; max: number }> = {
  PLA: { min: 190, max: 230 },
  'PLA+': { min: 200, max: 230 },
  'PLA-CF': { min: 210, max: 240 },
  PETG: { min: 230, max: 260 },
  ABS: { min: 240, max: 270 },
  ASA: { min: 240, max: 270 },
  TPU: { min: 220, max: 250 },
  PA: { min: 260, max: 290 },
  PC: { min: 260, max: 300 },
  PVA: { min: 200, max: 230 },
};

export function isBambuVendor(
  vendorName: string | undefined | null,
  vendorNames: string[]
): boolean {
  if (!vendorName) return false;
  const normalized = vendorName.trim().toLowerCase();
  return vendorNames.some((v) => normalized === v.trim().toLowerCase());
}

export function getFilamentTrayInfoIdx(filament: Filament): string {
  const raw = filament.extra?.['bambu_tray_info_idx'];
  if (!raw) return '';
  return parseExtraValue(raw).trim();
}

export function formatTrayColor(colorHex: string | null | undefined): string {
  if (!colorHex) return 'FFFFFFFF';
  const hex = colorHex.replace(/^#/, '').replace(/[^a-fA-F0-9]/g, '');
  if (hex.length === 6) return `${hex.toUpperCase()}FF`;
  if (hex.length === 8) return hex.toUpperCase();
  if (hex.length === 3) {
    const expanded = hex
      .split('')
      .map((c) => c + c)
      .join('');
    return `${expanded.toUpperCase()}FF`;
  }
  return 'FFFFFFFF';
}

export function normalizeTrayType(material: string | undefined | null): string {
  if (!material) return 'PLA';
  const base = material.trim().split(/\s+/)[0] || 'PLA';
  const upper = base.toUpperCase();
  if (upper.startsWith('PLA')) return upper.includes('CF') ? 'PLA-CF' : 'PLA';
  if (upper.startsWith('PETG')) return 'PETG';
  if (upper.startsWith('ABS')) return 'ABS';
  if (upper.startsWith('ASA')) return 'ASA';
  if (upper.startsWith('TPU')) return 'TPU';
  if (upper.startsWith('PA')) return 'PA';
  if (upper.startsWith('PC')) return 'PC';
  if (upper.startsWith('PVA')) return 'PVA';
  return upper.length <= 12 ? upper : 'PLA';
}

export function resolveNozzleTemps(filament: Filament): { min: number; max: number } {
  const temp = filament.settings_extruder_temp;
  if (temp != null && temp > 0) {
    return { min: temp, max: temp };
  }
  const trayType = normalizeTrayType(filament.material);
  const defaults = MATERIAL_TEMP_DEFAULTS[trayType] ?? MATERIAL_TEMP_DEFAULTS.PLA;
  return defaults;
}

export function buildSetFilamentPayload(
  filament: Filament,
  trayInfoIdx: string
): SetFilamentPayload {
  const temps = resolveNozzleTemps(filament);
  return {
    tray_info_idx: trayInfoIdx.toUpperCase(),
    tray_color: formatTrayColor(filament.color_hex),
    tray_type: normalizeTrayType(filament.material),
    nozzle_temp_min: temps.min,
    nozzle_temp_max: temps.max,
  };
}

function findTrayInPrinters(
  printers: HAPrinter[],
  trayId: string
): { printer: HAPrinter; tray: HATray } | null {
  for (const printer of printers) {
    for (const ams of printer.ams_units) {
      for (const tray of ams.trays) {
        if (tray.unique_id === trayId || tray.entity_id === trayId) {
          return { printer, tray };
        }
      }
    }
    for (const tray of printer.external_spools) {
      if (tray.unique_id === trayId || tray.entity_id === trayId) {
        return { printer, tray };
      }
    }
  }
  return null;
}

export async function pushFilamentToTray(
  haClient: HomeAssistantClient,
  trayEntityId: string,
  payload: SetFilamentPayload
): Promise<void> {
  await haClient.callService('bambu_lab', 'set_filament', {
    entity_id: trayEntityId,
    ...payload,
  });
}

export async function tryPushSpoolToAms(
  haClient: HomeAssistantClient | null,
  settings: BambuAmsPushSettings,
  spool: Spool,
  trayId: string,
  trayInfoIdxOverride?: string
): Promise<AmsPushResult> {
  if (!settings.pushFilamentToAms) {
    return { status: 'skipped_disabled', reason: 'Push to AMS is disabled in settings' };
  }

  if (!haClient) {
    return { status: 'skipped_no_ha', reason: 'Home Assistant is not connected' };
  }

  if (isBambuVendor(spool.filament.vendor?.name, settings.bambuVendorNames)) {
    return { status: 'skipped_bambu_vendor', reason: 'Bambu Lab vendor spool uses RFID' };
  }

  const trayInfoIdx = (trayInfoIdxOverride || getFilamentTrayInfoIdx(spool.filament)).trim();
  if (!trayInfoIdx) {
    return {
      status: 'skipped_missing_tray_info_idx',
      reason: 'Set bambu_tray_info_idx on the filament in Spoolman or pick a Bambu profile when assigning',
    };
  }

  const printers = await haClient.discoverPrinters();
  const match = findTrayInPrinters(printers, trayId);
  if (!match) {
    return { status: 'skipped_tray_not_found', reason: `Tray ${trayId} not found` };
  }

  if (match.printer.brand !== 'bambu_lab') {
    return { status: 'skipped_not_bambu_printer', reason: 'Not a Bambu Lab printer' };
  }

  if (isValidTrayUuid(match.tray.tray_uuid)) {
    return {
      status: 'skipped_tray_has_rfid',
      reason: 'Tray already has RFID data from the printer',
    };
  }

  const payload = buildSetFilamentPayload(spool.filament, trayInfoIdx);
  try {
    await pushFilamentToTray(haClient, match.tray.entity_id, payload);
    return { status: 'pushed' };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: 'failed', reason: message };
  }
}
