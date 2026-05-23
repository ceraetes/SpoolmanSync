/**
 * Bambu AMS tray_uuid / RFID identifier validation.
 * Shared by webhook auto-match and AMS filament push skip logic.
 */

/** Returns true if tray_uuid/rfid is a real spool identifier (not empty, unknown, or all zeros). */
export function isValidTrayUuid(trayUuid: string | undefined | null): boolean {
  if (!trayUuid || trayUuid === 'unknown' || trayUuid === '') return false;
  // ha-bambulab reports all zeros for non-Bambu spools without RFID tags
  if (trayUuid.replace(/0/g, '') === '') return false;
  return true;
}
