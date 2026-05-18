import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';
import { HomeAssistantClient } from '@/lib/api/homeassistant';
import { spoolEvents, SPOOL_UPDATED, SpoolUpdateEvent } from '@/lib/events';
import { createActivityLog } from '@/lib/activity-log';
import { checkAndUpdateAlerts } from '@/lib/alerts';

/**
 * Webhook endpoint for Home Assistant automations
 *
 * This endpoint receives tray change events from HA and syncs with Spoolman.
 *
 * Expected payload:
 * {
 *   event: "tray_change",
 *   tray_entity_id: "sensor.x1c_..._tray_1_2",
 *   tray_uuid: "...",  // Bambu spool serial number (unique per spool)
 *   color: "#FFFFFF",
 *   material: "PLA",
 *   remaining_weight: 800
 * }
 */

/** Returns true if tray_uuid/rfid is a real spool identifier (not empty, unknown, or all zeros) */
function isValidTrayUuid(tray_uuid: string | undefined | null): boolean {
  if (!tray_uuid || tray_uuid === 'unknown' || tray_uuid === '') return false;
  // ha-bambulab reports all zeros for non-Bambu spools without RFID tags
  if (tray_uuid.replace(/0/g, '') === '') return false;
  return true;
}

/**
 * Material density lookup (g/cm³) for converting filament length to weight.
 * Used when Creality printers report usage in cm instead of grams.
 * Standard filament diameter: 1.75mm
 */
const MATERIAL_DENSITY: Record<string, number> = {
  PLA: 1.24,
  'PLA+': 1.24,
  PETG: 1.27,
  ABS: 1.04,
  ASA: 1.07,
  TPU: 1.21,
  PC: 1.20,
  PA: 1.14,    // Nylon
  'PA-CF': 1.35,
  'PA-GF': 1.36,
  PVA: 1.23,
  HIPS: 1.04,
};

/**
 * Convert filament length (cm) to weight (grams).
 * Uses filament diameter of 1.75mm and material-specific density.
 */
function lengthToWeight(lengthCm: number, material?: string): number {
  const radiusCm = 0.0875; // 1.75mm / 2, converted to cm
  const volumeCm3 = Math.PI * radiusCm * radiusCm * lengthCm;
  const density = (material && MATERIAL_DENSITY[material.toUpperCase()]) || MATERIAL_DENSITY.PLA;
  return volumeCm3 * density;
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { event } = body;

    const spoolmanConnection = await prisma.spoolmanConnection.findFirst();

    if (!spoolmanConnection) {
      console.warn('Webhook received but Spoolman not configured');
      return NextResponse.json({ status: 'ignored', reason: 'spoolman not configured' });
    }

    const client = new SpoolmanClient(spoolmanConnection.url);

    // Resolve entity_id → unique_id for tray matching.
    // Spool assignments are stored by unique_id (stable across entity renames),
    // but HA automations send entity_ids. This mapping bridges the two.
    let entityIdToUniqueId: Map<string, string> | null = null;
    const resolveToUniqueId = async (entityId: string): Promise<string> => {
      if (!entityIdToUniqueId) {
        try {
          const haClient = await HomeAssistantClient.fromConnection();
          if (haClient) {
            entityIdToUniqueId = await haClient.getEntityIdToUniqueIdMap();
          }
        } catch (err) {
          console.warn('Could not fetch entity registry for unique_id mapping:', err);
        }
        if (!entityIdToUniqueId) entityIdToUniqueId = new Map();
      }
      return entityIdToUniqueId.get(entityId) || entityId;
    };

    // Wire up the resolver so all SpoolmanClient write paths defensively
    // convert any entity_id in active_tray to a stable unique_id.
    // This prevents race conditions where concurrent Spoolman API calls
    // revert extra fields to stale data containing entity_ids.
    client.setEntityIdResolver(resolveToUniqueId);

    // Handle spool_usage event - deduct filament weight from spool
    if (event === 'spool_usage') {
      const { used_weight, used_length, active_tray_id, tray_uuid, material } = body;

      // Determine weight to deduct: either directly provided (Bambu) or converted from length (Creality)
      let weightToDeduct = used_weight;
      let lengthConverted = false;
      if ((!weightToDeduct || weightToDeduct <= 0) && used_length && used_length > 0) {
        weightToDeduct = lengthToWeight(used_length, material);
        lengthConverted = true;
        console.log(`Converted ${used_length}cm to ${weightToDeduct.toFixed(2)}g (material: ${material || 'PLA default'})`);
      }

      if (!weightToDeduct || weightToDeduct <= 0) {
        return NextResponse.json({ status: 'ignored', reason: 'no weight to deduct' });
      }

      if (!active_tray_id) {
        return NextResponse.json({ status: 'ignored', reason: 'no active_tray_id provided' });
      }

      const spools = await client.getSpools();

      // Match by unique_id (resolved from entity_id sent by HA automation)
      const trayUniqueId = await resolveToUniqueId(active_tray_id);
      const jsonTrayId = JSON.stringify(trayUniqueId);
      let matchedSpool = spools.find(s => s.extra?.['active_tray'] === jsonTrayId);

      // Fallback: try matching by entity_id directly (for pre-migration spools)
      if (!matchedSpool) {
        const jsonEntityId = JSON.stringify(active_tray_id);
        matchedSpool = spools.find(s => s.extra?.['active_tray'] === jsonEntityId);
      }

      if (!matchedSpool) {
        console.warn(`No spool assigned to tray ${active_tray_id}`);
        return NextResponse.json({
          status: 'no_match',
          message: `No spool assigned to tray ${active_tray_id}. Assign a spool in SpoolmanSync first.`,
        });
      }

      // If we have a matched spool and converted from length, try to use the spool's
      // actual filament density for a more accurate conversion
      if (lengthConverted && matchedSpool.filament?.material) {
        const betterWeight = lengthToWeight(used_length, matchedSpool.filament.material);
        if (betterWeight !== weightToDeduct) {
          console.log(`Refined conversion using spool material ${matchedSpool.filament.material}: ${weightToDeduct.toFixed(2)}g -> ${betterWeight.toFixed(2)}g`);
          weightToDeduct = betterWeight;
        }
      }

      // Deduct the used weight from the spool
      await client.useWeight(matchedSpool.id, weightToDeduct);

      // Check low filament alerts (fire-and-forget)
      checkAndUpdateAlerts().catch(err => console.error('Alert check failed:', err));

      const deductionNote = lengthConverted ? ` (converted from ${used_length}cm)` : '';
      console.log(`Deducted ${weightToDeduct.toFixed(2)}g${deductionNote} from spool #${matchedSpool.id} (${matchedSpool.filament.name})`);

      // Store the spool serial/RFID if we have a valid one
      // This enables future auto-matching when the same spool is reinserted
      // For Bambu: tray_uuid is the spool serial (unique per physical spool)
      // For Creality: rfid is a numeric RFID tag ID
      let tagStored = false;
      if (isValidTrayUuid(tray_uuid)) {
        // Check if this spool already has this serial number stored
        const existingTagRaw = matchedSpool.extra?.['tag'];
        let alreadyHasTag = false;
        if (existingTagRaw) {
          try {
            const parsed = JSON.parse(existingTagRaw);
            alreadyHasTag = parsed === tray_uuid;
          } catch {
            // If parsing fails, assume tag not stored
          }
        }

        if (!alreadyHasTag) {
          console.log(`Storing spool serial "${tray_uuid}" on spool #${matchedSpool.id}`);
          await client.setSpoolTag(matchedSpool.id, tray_uuid);
          tagStored = true;

          await createActivityLog({
            type: 'tag_stored',
            message: `Stored spool serial on spool #${matchedSpool.id} (${matchedSpool.filament.name})`,
            details: {
              spoolId: matchedSpool.id,
              trayUuid: tray_uuid,
            },
          });
        }
      }

      // Emit real-time update event for dashboard
      const updateEvent: SpoolUpdateEvent = {
        type: 'usage',
        spoolId: matchedSpool.id,
        spoolName: matchedSpool.filament.name,
        deducted: weightToDeduct,
        newWeight: matchedSpool.remaining_weight - weightToDeduct,
        trayId: active_tray_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, updateEvent);

      await createActivityLog({
        type: 'spool_usage',
        message: `Deducted ${weightToDeduct.toFixed(2)}g${deductionNote} from spool #${matchedSpool.id} (${matchedSpool.filament.name})`,
        details: {
          spoolId: matchedSpool.id,
          usedWeight: weightToDeduct,
          ...(lengthConverted && { usedLengthCm: used_length }),
          trayId: active_tray_id,
          tagStored,
        },
      });

      return NextResponse.json({
        status: 'success',
        spoolId: matchedSpool.id,
        deducted: weightToDeduct,
        newRemainingWeight: matchedSpool.remaining_weight - weightToDeduct,
        tagStored,
      });
    }

    // Handle tray_change event - auto-assign spool by serial number or handle empty tray
    if (event === 'tray_change') {
      const { tray_entity_id, tray_uuid, name, material } = body;
      const spools = await client.getSpools();

      // Resolve entity_id to unique_id for matching and assignment
      const trayUniqueId = await resolveToUniqueId(tray_entity_id);

      // Check if tray is now empty (no filament, or explicitly "Empty")
      // ha-bambulab reports name="Empty" when tray has no filament
      // ha_creality_ws reports empty string or no name when slot is empty
      const trayIsEmpty = !name || name.toLowerCase() === 'empty' || name === '' || name === 'unavailable';

      if (trayIsEmpty) {
        // Auto-unassign any spool currently assigned to this tray
        const jsonTrayId = JSON.stringify(trayUniqueId);
        let assignedSpool = spools.find(s => s.extra?.['active_tray'] === jsonTrayId);
        // Fallback: try matching by entity_id directly (pre-migration)
        if (!assignedSpool) {
          const jsonEntityId = JSON.stringify(tray_entity_id);
          assignedSpool = spools.find(s => s.extra?.['active_tray'] === jsonEntityId);
        }

        if (assignedSpool) {
          console.log(`Tray ${tray_entity_id} is now empty, unassigning spool #${assignedSpool.id}`);
          await client.unassignSpoolFromTray(assignedSpool.id);

          // Emit real-time update event
          const updateEvent: SpoolUpdateEvent = {
            type: 'unassign',
            spoolId: assignedSpool.id,
            spoolName: assignedSpool.filament.name,
            trayId: tray_entity_id,
            timestamp: Date.now(),
          };
          spoolEvents.emit(SPOOL_UPDATED, updateEvent);

          await createActivityLog({
            type: 'spool_unassign',
            message: `Auto-unassigned spool #${assignedSpool.id} from ${tray_entity_id} (tray empty)`,
            details: { spoolId: assignedSpool.id, trayId: tray_entity_id, reason: 'tray_empty' },
          });

          return NextResponse.json({
            status: 'success',
            action: 'unassigned',
            spoolId: assignedSpool.id,
            reason: 'tray_empty',
          });
        }

        // Log the empty tray detection even though no action was taken
        await createActivityLog({
          type: 'tray_empty_detected',
          message: `Detected empty tray: ${tray_entity_id} (no spool was assigned)`,
          details: { trayId: tray_entity_id, reason: 'no_spool_assigned' },
        });

        return NextResponse.json({
          status: 'ignored',
          reason: 'tray empty and no spool was assigned',
        });
      }

      // Tray has filament - try to auto-match by spool serial number
      // Uses the `tag` field (stored on first spool_usage)
      if (!isValidTrayUuid(tray_uuid)) {
        // Log why we're skipping auto-match entirely
        let skipReason: string;
        if (!tray_uuid || tray_uuid === '') {
          skipReason = 'tray_uuid is empty or missing — HA automation did not send an identifier';
        } else if (tray_uuid === 'unknown') {
          skipReason = 'tray_uuid is "unknown" — printer has not reported an RFID identifier yet';
        } else if (tray_uuid.replace(/0/g, '') === '') {
          skipReason = `tray_uuid is all zeros (${tray_uuid}) — printer reports no RFID for this slot (third-party or non-RFID spool)`;
        } else {
          skipReason = `tray_uuid "${tray_uuid}" did not pass validation`;
        }
        console.log(`[AutoMatch] Skipping auto-match for ${tray_entity_id}: ${skipReason}`);
        await createActivityLog({
          type: 'tray_change_detected',
          message: `Tray change detected: ${tray_entity_id} — auto-match skipped`,
          details: {
            trayId: tray_entity_id,
            printerReports: { name, material, tray_uuid },
            autoMatchSkipped: true,
            skipReason,
            action: 'manual_assignment_required',
          },
        });
        const updateEvent: SpoolUpdateEvent = {
          type: 'tray_change',
          trayId: tray_entity_id,
          timestamp: Date.now(),
        };
        spoolEvents.emit(SPOOL_UPDATED, updateEvent);
        return NextResponse.json({
          status: 'no_match',
          message: 'No spool assigned to this tray. Please assign a spool manually in SpoolmanSync.',
          printerReports: { name, material, tray_uuid },
          autoMatchSkipped: true,
          skipReason,
        });
      }

      // tray_uuid is valid — attempt matching (tag → nfc_uid → nfc_uid_2)
      console.log(`[AutoMatch] Attempting auto-match for ${tray_entity_id} with tray_uuid="${tray_uuid}"`);
      const matchedSpool = await client.findSpoolByTag(tray_uuid);

      if (matchedSpool) {
        await client.assignSpoolToTray(matchedSpool.id, trayUniqueId);

        // Emit real-time update event
        const updateEvent: SpoolUpdateEvent = {
          type: 'assign',
          spoolId: matchedSpool.id,
          spoolName: matchedSpool.filament.name,
          trayId: tray_entity_id,
          timestamp: Date.now(),
        };
        spoolEvents.emit(SPOOL_UPDATED, updateEvent);

        await createActivityLog({
          type: 'spool_change',
          message: `Auto-assigned spool #${matchedSpool.id} to ${tray_entity_id} (matched by spool serial)`,
          details: { spoolId: matchedSpool.id, trayId: tray_entity_id, matchedBy: 'spool_serial', trayUuid: tray_uuid },
        });

        return NextResponse.json({
          status: 'success',
          spool: matchedSpool,
          matchedBy: 'spool_serial',
        });
      }

      console.log(`[AutoMatch] No extra.tag match for "${tray_uuid}" — trying nfc_uid / nfc_uid_2 fallback`);

      // Fallback: match against user-defined nfc_uid / nfc_uid_2 extra fields.
      // This catches brand-new spools whose `tag` field has never been written
      // by a prior print, as long as the user pre-populated those NFC UID fields
      // in Spoolman.
      const nfcMatchedSpool = await client.findSpoolByNfcUid(tray_uuid);

      if (nfcMatchedSpool) {
        await client.assignSpoolToTray(nfcMatchedSpool.id, trayUniqueId);

        // Also store the serial in `tag` so subsequent inserts use the faster path
        await client.setSpoolTag(nfcMatchedSpool.id, tray_uuid);

        const updateEvent: SpoolUpdateEvent = {
          type: 'assign',
          spoolId: nfcMatchedSpool.id,
          spoolName: nfcMatchedSpool.filament.name,
          trayId: tray_entity_id,
          timestamp: Date.now(),
        };
        spoolEvents.emit(SPOOL_UPDATED, updateEvent);

        await createActivityLog({
          type: 'spool_change',
          message: `Auto-assigned spool #${nfcMatchedSpool.id} to ${tray_entity_id} (matched by NFC UID)`,
          details: { spoolId: nfcMatchedSpool.id, trayId: tray_entity_id, matchedBy: 'nfc_uid', trayUuid: tray_uuid },
        });

        return NextResponse.json({
          status: 'success',
          spool: nfcMatchedSpool,
          matchedBy: 'nfc_uid',
        });
      }

      // All auto-match fallbacks exhausted — gather diagnostics so the user can
      // see exactly what was searched for and what values exist in Spoolman.
      const diag = await client.getMatchDiagnostics(tray_uuid);

      // Build readable summaries for the activity log
      const tagSummary = diag.tagEntries.length > 0
        ? diag.tagEntries.map(e => `  spool #${e.spoolId} (${e.spoolName}): tag="${e.storedValue}"`).join('\n')
        : '  (no spools have an extra.tag value)';

      const nfcSummary = diag.nfcUidEntries.length > 0
        ? diag.nfcUidEntries.map(e => `  spool #${e.spoolId} (${e.spoolName}): ${e.field}="${e.storedValue}"`).join('\n')
        : '  (no spools have extra.nfc_uid or extra.nfc_uid_2 values)';

      console.log(
        `[AutoMatch] No match found for ${tray_entity_id}.\n` +
        `  Searched for tray_uuid: "${tray_uuid}"\n` +
        `  Scanned ${diag.spoolsScanned} spools.\n` +
        `  extra.tag values found:\n${tagSummary}\n` +
        `  extra.nfc_uid / nfc_uid_2 values found:\n${nfcSummary}`
      );

      await createActivityLog({
        type: 'tray_change_detected',
        message: `Tray change detected: ${tray_entity_id} — no match after all fallbacks (tag + nfc_uid + nfc_uid_2)`,
        details: {
          trayId: tray_entity_id,
          printerReports: { name, material, tray_uuid },
          autoMatch: {
            searchedFor: diag.searchedFor,
            spoolsScanned: diag.spoolsScanned,
            tagEntriesFound: diag.tagEntries.map(e => ({ spoolId: e.spoolId, spoolName: e.spoolName, storedValue: e.storedValue })),
            nfcEntriesFound: diag.nfcUidEntries.map(e => ({ spoolId: e.spoolId, spoolName: e.spoolName, field: e.field, storedValue: e.storedValue })),
          },
          action: 'manual_assignment_required',
        },
      });

      // Emit tray_change event so dashboard can refresh and show warning banner
      const updateEvent: SpoolUpdateEvent = {
        type: 'tray_change',
        trayId: tray_entity_id,
        timestamp: Date.now(),
      };
      spoolEvents.emit(SPOOL_UPDATED, updateEvent);

      return NextResponse.json({
        status: 'no_match',
        message: 'No spool assigned to this tray. Please assign a spool manually in SpoolmanSync.',
        printerReports: { name, material, tray_uuid },
        autoMatchDiagnostics: {
          searchedFor: diag.searchedFor,
          spoolsScanned: diag.spoolsScanned,
          tagEntriesFound: diag.tagEntries,
          nfcEntriesFound: diag.nfcUidEntries,
        },
      });
    }

    return NextResponse.json({ status: 'ignored', reason: 'unknown event type' });
  } catch (error) {
    console.error('Webhook error:', error);

    await createActivityLog({
      type: 'error',
      message: 'Webhook processing failed',
      details: { error: error instanceof Error ? error.message : String(error) },
    });

    return NextResponse.json({ error: 'Webhook processing failed' }, { status: 500 });
  }
}

// GET endpoint for testing/verification
export async function GET() {
  return NextResponse.json({
    status: 'ok',
    message: 'SpoolmanSync webhook endpoint',
    events: {
      spool_usage: {
        description: 'Deduct filament weight from spool after print',
        payload: {
          event: 'spool_usage',
          name: 'Filament Name',
          material: 'PLA',
          tray_uuid: '...',
          used_weight: 3.91,
          color: '#FFFFFF',
          active_tray_id: 'sensor.x1c_..._tray_1',
        },
      },
      tray_change: {
        description: 'Auto-assign spool by tray_uuid (Bambu spools only)',
        payload: {
          event: 'tray_change',
          tray_entity_id: 'sensor.x1c_..._tray_1',
          tray_uuid: '...',
          color: '#FFFFFF',
          material: 'PLA',
        },
      },
    },
  });
}
