import { BAMBU_CATALOG } from './catalog-data';
import { MATERIAL_PROFILE_NAMES } from './material-names';

export interface BambuCatalogEntry {
  tray_info_idx: string;
  name: string;
  material: string;
  color_hex?: string;
}

let cachedCatalog: BambuCatalogEntry[] | null = null;

function buildCatalog(): BambuCatalogEntry[] {
  const entries: BambuCatalogEntry[] = [];

  for (const [name, e] of Object.entries(BAMBU_CATALOG)) {
    entries.push({
      tray_info_idx: e.material_id.toUpperCase(),
      name,
      material: e.material,
      color_hex: e.hex ? `#${e.hex}` : undefined,
    });
  }

  for (const [idx, name] of Object.entries(MATERIAL_PROFILE_NAMES)) {
    const material = inferMaterialFromName(name);
    entries.push({
      tray_info_idx: idx,
      name,
      material,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name));
  return entries;
}

function inferMaterialFromName(name: string): string {
  const upper = name.toUpperCase();
  if (upper.includes('PLA-CF') || upper.includes('PLA CF')) return 'PLA-CF';
  if (upper.includes('PETG')) return 'PETG';
  if (upper.includes('PLA')) return 'PLA';
  if (upper.includes('ABS')) return 'ABS';
  if (upper.includes('ASA')) return 'ASA';
  if (upper.includes('TPU')) return 'TPU';
  if (upper.includes('PA-CF') || upper.includes('PA ')) return 'PA';
  if (upper.includes('PC')) return 'PC';
  if (upper.includes('PVA')) return 'PVA';
  if (upper.includes('PPS')) return 'PPS';
  return 'PLA';
}

export function getFilamentCatalog(): BambuCatalogEntry[] {
  if (!cachedCatalog) {
    cachedCatalog = buildCatalog();
  }
  return cachedCatalog;
}

export function searchFilamentCatalog(query?: string): BambuCatalogEntry[] {
  const catalog = getFilamentCatalog();
  if (!query?.trim()) return catalog;

  const q = query.trim().toLowerCase();
  return catalog.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      e.tray_info_idx.toLowerCase().includes(q) ||
      e.material.toLowerCase().includes(q)
  );
}
