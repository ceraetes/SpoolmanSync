import prisma from '@/lib/db';

export interface BambuAmsPushSettings {
  pushFilamentToAms: boolean;
  bambuVendorNames: string[];
}

const DEFAULT_VENDOR_NAMES = ['Bambu Lab', 'Bambu'];

const SETTINGS_KEY_PUSH = 'push_filament_to_ams';
const SETTINGS_KEY_VENDORS = 'bambu_vendor_names';

export async function getBambuAmsPushSettings(): Promise<BambuAmsPushSettings> {
  const [pushSetting, vendorsSetting] = await Promise.all([
    prisma.settings.findUnique({ where: { key: SETTINGS_KEY_PUSH } }),
    prisma.settings.findUnique({ where: { key: SETTINGS_KEY_VENDORS } }),
  ]);

  let bambuVendorNames = DEFAULT_VENDOR_NAMES;
  if (vendorsSetting?.value) {
    try {
      const parsed = JSON.parse(vendorsSetting.value);
      if (Array.isArray(parsed) && parsed.every((v) => typeof v === 'string')) {
        bambuVendorNames = parsed;
      }
    } catch {
      /* use defaults */
    }
  }

  return {
    pushFilamentToAms: pushSetting?.value !== 'false',
    bambuVendorNames,
  };
}

export async function saveBambuAmsPushSettings(
  partial: Partial<BambuAmsPushSettings>
): Promise<void> {
  if (partial.pushFilamentToAms !== undefined) {
    await prisma.settings.upsert({
      where: { key: SETTINGS_KEY_PUSH },
      create: { key: SETTINGS_KEY_PUSH, value: String(partial.pushFilamentToAms) },
      update: { value: String(partial.pushFilamentToAms) },
    });
  }
  if (partial.bambuVendorNames !== undefined) {
    await prisma.settings.upsert({
      where: { key: SETTINGS_KEY_VENDORS },
      create: { key: SETTINGS_KEY_VENDORS, value: JSON.stringify(partial.bambuVendorNames) },
      update: { value: JSON.stringify(partial.bambuVendorNames) },
    });
  }
}
