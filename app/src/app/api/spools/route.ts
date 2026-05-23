import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { createActivityLog } from '@/lib/activity-log';
import { getBambuAmsPushSettings } from '@/lib/bambu-ams-settings';
import { tryPushSpoolToAms } from '@/lib/bambu-ams-push';

export async function GET() {
  try {
    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);
    const spools = await client.getSpools();

    // Filter out archived spools
    const activeSpools = spools.filter(s => !s.archived);

    return NextResponse.json({ spools: activeSpools });
  } catch (error) {
    console.error('Error fetching spools:', error);
    return NextResponse.json({ error: 'Failed to fetch spools' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId, trayId, bambuTrayInfoIdx } = body;

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Wire up entity_id → unique_id resolver for defense-in-depth
    let entityIdMap: Map<string, string> | null = null;
    client.setEntityIdResolver(async (entityId: string) => {
      if (!entityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) entityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!entityIdMap) entityIdMap = new Map();
      }
      return entityIdMap.get(entityId) || entityId;
    });

    let updatedSpool = await client.assignSpoolToTray(spoolId, trayId);

    if (bambuTrayInfoIdx && typeof bambuTrayInfoIdx === 'string' && bambuTrayInfoIdx.trim()) {
      await client.setFilamentTrayInfoIdx(updatedSpool.filament.id, bambuTrayInfoIdx.trim());
      updatedSpool = await client.getSpool(spoolId);
    }

    const pushSettings = await getBambuAmsPushSettings();
    const haClient = await HomeAssistantClient.fromConnection();
    const amsPush = await tryPushSpoolToAms(
      haClient,
      pushSettings,
      updatedSpool,
      trayId,
      typeof bambuTrayInfoIdx === 'string' ? bambuTrayInfoIdx.trim() : undefined
    );

    await createActivityLog({
      type: 'spool_change',
      message: `Assigned spool #${spoolId} to tray ${trayId}`,
      details: { spoolId, trayId, amsPush },
    });

    if (amsPush.status === 'pushed') {
      await createActivityLog({
        type: 'ams_filament_pushed',
        message: `Pushed filament settings to AMS for spool #${spoolId}`,
        details: { spoolId, trayId },
      });
    } else if (amsPush.status === 'failed') {
      await createActivityLog({
        type: 'ams_filament_push_failed',
        message: `AMS push failed for spool #${spoolId}: ${amsPush.reason}`,
        details: { spoolId, trayId, reason: amsPush.reason },
      });
    } else if (
      amsPush.status !== 'skipped_disabled' &&
      amsPush.status !== 'skipped_not_bambu_printer'
    ) {
      await createActivityLog({
        type: 'ams_filament_push_skipped',
        message: `AMS push skipped for spool #${spoolId}: ${amsPush.reason ?? amsPush.status}`,
        details: { spoolId, trayId, status: amsPush.status, reason: amsPush.reason },
      });
    }

    return NextResponse.json({ spool: updatedSpool, amsPush });
  } catch (error) {
    console.error('Error assigning spool:', error);
    return NextResponse.json({ error: 'Failed to assign spool' }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const { spoolId } = body;

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      return NextResponse.json({ error: 'Spoolman not configured' }, { status: 400 });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Wire up entity_id → unique_id resolver for defense-in-depth
    let deleteEntityIdMap: Map<string, string> | null = null;
    client.setEntityIdResolver(async (entityId: string) => {
      if (!deleteEntityIdMap) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) deleteEntityIdMap = await haClient.getEntityIdToUniqueIdMap();
        } catch { /* best-effort */ }
        if (!deleteEntityIdMap) deleteEntityIdMap = new Map();
      }
      return deleteEntityIdMap.get(entityId) || entityId;
    });

    const updatedSpool = await client.unassignSpoolFromTray(spoolId);

    // Log activity
    await createActivityLog({
      type: 'spool_change',
      message: `Unassigned spool #${spoolId} from tray`,
      details: { spoolId },
    });

    return NextResponse.json({ spool: updatedSpool });
  } catch (error) {
    console.error('Error unassigning spool:', error);
    return NextResponse.json({ error: 'Failed to unassign spool' }, { status: 500 });
  }
}
