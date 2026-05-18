import { NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { HomeAssistantClient, HATray } from '@/lib/api/homeassistant';
import { parseExtraValue, Spool, SpoolmanClient } from '@/lib/api/spoolman';
import { createActivityLog } from '@/lib/activity-log';
import { spoolEvents, SPOOL_UPDATED, SpoolUpdateEvent } from '@/lib/events';
import { getHiddenPrinters } from '@/app/api/printers/setup/route';

interface TrayToMatch extends HATray {
  printerName: string;
}

/** Returns true if tray_uuid/rfid is a real spool identifier (not empty, unknown, or all zeros). */
function isValidTrayUuid(trayUuid: string | undefined | null): trayUuid is string {
  if (!trayUuid || trayUuid === 'unknown' || trayUuid === '') return false;
  if (trayUuid.replace(/0/g, '') === '') return false;
  return true;
}

function trayHasFilament(tray: HATray): boolean {
  const trayName = tray.name?.toLowerCase().trim() || '';
  return Boolean(trayName && trayName !== 'empty' && trayName !== 'unavailable');
}

function getActiveTrayId(spool: Spool): string {
  return parseExtraValue(spool.extra?.['active_tray']);
}

function findSpoolMatch(spools: Spool[], trayUuid: string): { spool: Spool | null; matchedBy: 'tag' | 'nfc_uid' | null } {
  for (const spool of spools) {
    if (parseExtraValue(spool.extra?.['tag']) === trayUuid) {
      return { spool, matchedBy: 'tag' };
    }
  }

  const normalizedUuid = trayUuid.toLowerCase();
  for (const spool of spools) {
    for (const key of ['nfc_uid', 'nfc_uid_2'] as const) {
      if (parseExtraValue(spool.extra?.[key]).toLowerCase() === normalizedUuid) {
        return { spool, matchedBy: 'nfc_uid' };
      }
    }
  }

  return { spool: null, matchedBy: null };
}

export async function POST() {
  try {
    const haClient = await HomeAssistantClient.fromConnection();
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!haClient) {
      return NextResponse.json({ error: 'Home Assistant not configured' }, { status: 400 });
    }

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const spoolmanClient = new SpoolmanClient(spoolmanConnection.url);
    const [allPrinters, spools, hiddenPrintersList] = await Promise.all([
      haClient.discoverPrinters(),
      spoolmanClient.getSpools(),
      getHiddenPrinters(),
    ]);

    const hiddenTitles = new Set(hiddenPrintersList.map(h => h.title.toLowerCase()).filter(Boolean));
    const printers = hiddenTitles.size > 0
      ? allPrinters.filter(p => {
          const name = p.name.toLowerCase();
          const entityId = p.entity_id.toLowerCase();
          return ![...hiddenTitles].some(t => name.includes(t) || entityId.includes(t));
        })
      : allPrinters;

    const entityIdToUniqueId = new Map<string, string>();
    const trays: TrayToMatch[] = [];

    for (const printer of printers) {
      for (const ams of printer.ams_units) {
        for (const tray of ams.trays) {
          if (tray.unique_id) entityIdToUniqueId.set(tray.entity_id, tray.unique_id);
          trays.push({ ...tray, printerName: printer.name });
        }
      }

      for (const tray of printer.external_spools) {
        if (tray.unique_id) entityIdToUniqueId.set(tray.entity_id, tray.unique_id);
        trays.push({ ...tray, printerName: printer.name });
      }
    }

    spoolmanClient.setEntityIdResolver(async (entityId: string) => {
      return entityIdToUniqueId.get(entityId) || entityId;
    });

    let assigned = 0;
    let alreadyAssigned = 0;
    let skipped = 0;
    let noMatch = 0;
    const results: Array<{
      trayId: string;
      trayLabel: string;
      status: 'assigned' | 'already_assigned' | 'skipped' | 'no_match';
      spoolId?: number;
      matchedBy?: 'tag' | 'nfc_uid';
      reason?: string;
    }> = [];

    for (const tray of trays) {
      const trayId = tray.unique_id || tray.entity_id;
      const trayLabel = `${tray.printerName} ${tray.is_external ? 'External' : `Tray ${tray.tray_number}`}`;

      if (!trayHasFilament(tray)) {
        skipped++;
        results.push({ trayId, trayLabel, status: 'skipped', reason: 'tray empty' });
        continue;
      }

      if (!isValidTrayUuid(tray.tray_uuid)) {
        skipped++;
        results.push({ trayId, trayLabel, status: 'skipped', reason: 'missing or invalid tray_uuid' });
        continue;
      }
      const trayUuid = tray.tray_uuid;

      const { spool, matchedBy } = findSpoolMatch(spools, trayUuid);
      if (!spool || !matchedBy) {
        noMatch++;
        results.push({ trayId, trayLabel, status: 'no_match', reason: 'no matching Spoolman tag or NFC UID' });
        continue;
      }

      if (getActiveTrayId(spool) === trayId) {
        alreadyAssigned++;
        results.push({ trayId, trayLabel, status: 'already_assigned', spoolId: spool.id, matchedBy });
        continue;
      }

      await spoolmanClient.assignSpoolToTray(spool.id, trayId);
      if (matchedBy === 'nfc_uid') {
        await spoolmanClient.setSpoolTag(spool.id, trayUuid);
      }

      assigned++;
      results.push({ trayId, trayLabel, status: 'assigned', spoolId: spool.id, matchedBy });

      const updateEvent: SpoolUpdateEvent = {
        type: 'assign',
        spoolId: spool.id,
        spoolName: spool.filament.name,
        trayId: tray.entity_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, updateEvent);

      await createActivityLog({
        type: 'spool_change',
        message: `Force-matched spool #${spool.id} to ${tray.entity_id}`,
        details: {
          spoolId: spool.id,
          trayId: tray.entity_id,
          trayUniqueId: trayId,
          trayUuid,
          matchedBy,
        },
      });
    }

    return NextResponse.json({
      assigned,
      alreadyAssigned,
      skipped,
      noMatch,
      results,
    });
  } catch (error) {
    console.error('Error force-matching current trays:', error);
    await createActivityLog({
      type: 'error',
      message: 'Force match current trays failed',
      details: { error: error instanceof Error ? error.message : String(error) },
    });
    return NextResponse.json({ error: 'Failed to force match current trays' }, { status: 500 });
  }
}
