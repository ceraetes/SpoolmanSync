'use client';

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { SpoolFilterBar } from '@/components/dashboard/spool-filter-bar';
import { SpoolColorSwatch } from '@/components/spool-color-swatch';
import type { HATray } from '@/lib/api/homeassistant';
import type { Spool } from '@/lib/api/spoolman';
import { buildSpoolSearchValue, parseExtraValue } from '@/lib/api/spoolman';
import { isBambuVendor, getFilamentTrayInfoIdx } from '@/lib/bambu-ams-push';
import { isValidTrayUuid } from '@/lib/tray-uuid';
import type { BambuCatalogEntry } from '@/lib/bambu/filament-catalog';

const DEFAULT_BAMBU_VENDORS = ['Bambu Lab', 'Bambu'];

/** Value used for auto-match vs tag / nfc_uid / nfc_uid_2 */
function isTrayUuidValidForAutoMatch(trayUuid: string | undefined | null): boolean {
  return isValidTrayUuid(trayUuid);
}

function autoMatchBlockedReason(trayUuid: string | undefined | null): string {
  if (trayUuid == null || trayUuid === '') {
    return 'No tray_uuid from Home Assistant. Open the tray entity in HA → Attributes, and confirm your SpoolmanSync automation sends tray_uuid in the webhook.';
  }
  if (trayUuid === 'unknown') {
    return 'tray_uuid is "unknown" — auto-match is disabled until the printer reports a real identifier.';
  }
  if (trayUuid.replace(/0/g, '') === '') {
    return 'tray_uuid is all zeros — the printer reports no spool RFID id for this slot (common for empty or third-party spools).';
  }
  return '';
}

function normalizedHexIsh(s: string): string {
  return s.replace(/[^a-fA-F0-9]/g, '').toLowerCase();
}

type SortBy = 'id' | 'name' | 'material' | 'vendor';

interface MismatchInfo {
  type: 'material' | 'color' | 'both';
  printerReports: {
    material?: string;
    color?: string;
  };
  spoolmanHas: {
    material: string;
    color: string;
  };
  message: string;
}

interface FilterField {
  key: string;
  name: string;
  values: string[];
  builtIn: boolean;
}

interface TraySlotProps {
  tray: HATray;
  assignedSpool?: Spool;
  spools: Spool[];
  isBambuPrinter?: boolean;
  onAssign: (spoolId: number, options?: { bambuTrayInfoIdx?: string }) => void | Promise<void>;
  onUnassign?: (spoolId: number) => void;
  mismatch?: MismatchInfo;
  showLocation?: boolean;
}

function spoolNeedsBambuProfile(
  spool: Spool,
  isBambuPrinter: boolean,
  tray: HATray
): boolean {
  if (!isBambuPrinter) return false;
  if (isValidTrayUuid(tray.tray_uuid)) return false;
  if (isBambuVendor(spool.filament.vendor?.name, DEFAULT_BAMBU_VENDORS)) return false;
  return !getFilamentTrayInfoIdx(spool.filament);
}

/**
 * Get the value of a filter field from a spool
 */
function getSpoolFieldValue(spool: Spool, fieldKey: string): string | null {
  switch (fieldKey) {
    case 'material':
      return spool.filament.material || null;
    case 'vendor':
      return spool.filament.vendor?.name || null;
    case 'location':
      return spool.location || null;
    case 'lot_nr':
      return spool.lot_nr || null;
    default:
      // Extra field (key starts with extra_)
      if (fieldKey.startsWith('extra_')) {
        const extraKey = fieldKey.replace('extra_', '');
        return parseExtraValue(spool.extra?.[extraKey]) || null;
      }
      return null;
  }
}

function sortSpools(spools: Spool[], sortBy: SortBy): Spool[] {
  return [...spools].sort((a, b) => {
    switch (sortBy) {
      case 'id':
        return a.id - b.id;
      case 'name':
        return (a.filament.name || a.filament.material).localeCompare(b.filament.name || b.filament.material);
      case 'material':
        return (a.filament.material || '').localeCompare(b.filament.material || '');
      case 'vendor':
        return (a.filament.vendor?.name || '').localeCompare(b.filament.vendor?.name || '');
    }
  });
}

export function TraySlot({
  tray,
  assignedSpool,
  spools,
  isBambuPrinter = false,
  onAssign,
  onUnassign,
  mismatch,
  showLocation,
}: TraySlotProps) {
  const [open, setOpen] = useState(false);
  const [filters, setFilters] = useState<Record<string, string | null>>({});
  const [enabledFields, setEnabledFields] = useState<FilterField[]>([]);
  const [sortBy, setSortBy] = useState<SortBy>('id');
  const [pendingSpool, setPendingSpool] = useState<Spool | null>(null);
  const [catalogQuery, setCatalogQuery] = useState('');
  const [catalogEntries, setCatalogEntries] = useState<BambuCatalogEntry[]>([]);
  const [selectedBambuIdx, setSelectedBambuIdx] = useState('');
  const [catalogLoading, setCatalogLoading] = useState(false);

  // Fetch filter fields when dialog opens
  useEffect(() => {
    if (open) {
      fetch('/api/spools/extra-fields')
        .then((res) => res.json())
        .then((data) => {
          if (data.fields && data.filterConfig) {
            // Only show fields that are enabled in filter config
            const enabled = data.fields.filter(
              (f: FilterField) => data.filterConfig.includes(f.key)
            );
            setEnabledFields(enabled);
          }
        })
        .catch((err) => console.error('Failed to fetch filter fields:', err));
    }
  }, [open]);

  // Reset filters when dialog closes
  useEffect(() => {
    if (!open) {
      setFilters({});
      setPendingSpool(null);
      setCatalogQuery('');
      setSelectedBambuIdx('');
      setCatalogEntries([]);
    }
  }, [open]);

  useEffect(() => {
    if (!pendingSpool) return;
    const timer = setTimeout(async () => {
      setCatalogLoading(true);
      try {
        const params = catalogQuery.trim() ? `?q=${encodeURIComponent(catalogQuery.trim())}` : '';
        const res = await fetch(`/api/bambu/filament-catalog${params}`);
        if (res.ok) {
          const data = await res.json();
          setCatalogEntries((data.entries ?? []).slice(0, 40));
        }
      } catch {
        setCatalogEntries([]);
      } finally {
        setCatalogLoading(false);
      }
    }, 200);
    return () => clearTimeout(timer);
  }, [pendingSpool, catalogQuery]);

  const confirmAssign = useCallback(
    (spool: Spool, bambuTrayInfoIdx?: string) => {
      onAssign(spool.id, bambuTrayInfoIdx ? { bambuTrayInfoIdx } : undefined);
      setOpen(false);
    },
    [onAssign]
  );

  const handleSpoolSelect = useCallback(
    (spool: Spool) => {
      const existingIdx = getFilamentTrayInfoIdx(spool.filament);
      if (spoolNeedsBambuProfile(spool, isBambuPrinter, tray) && !existingIdx) {
        setPendingSpool(spool);
        setCatalogQuery(spool.filament.material || '');
        setSelectedBambuIdx('');
        return;
      }
      confirmAssign(spool, existingIdx || undefined);
    },
    [confirmAssign, isBambuPrinter, tray]
  );

  // Handle filter changes
  const handleFilterChange = useCallback((key: string, value: string | null) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
  }, []);

  // Clear all filters
  const handleClearAll = useCallback(() => {
    setFilters({});
  }, []);

  // Filter and sort spools
  const filteredSpools = useMemo(() => {
    const filtered = spools.filter((spool) => {
      for (const [key, value] of Object.entries(filters)) {
        if (value) {
          const spoolValue = getSpoolFieldValue(spool, key);
          if (spoolValue !== value) {
            return false;
          }
        }
      }
      return true;
    });
    return sortSpools(filtered, sortBy);
  }, [spools, filters, sortBy]);

  // Only show weight from Spoolman when a spool is assigned
  const displayWeight = assignedSpool?.remaining_weight;
  // Only show weight if spool is assigned and weight is a valid positive number
  const showWeight = assignedSpool && typeof displayWeight === 'number' && displayWeight >= 0;

  const handleUnassign = (e: React.MouseEvent) => {
    e.stopPropagation(); // Prevent opening the dialog
    if (assignedSpool && onUnassign) {
      onUnassign(assignedSpool.id);
    }
  };

  const trayLabel = tray.is_external ? 'External' : `Tray ${tray.tray_number}`;

  // Check if any enabled filters have values to show
  const hasFilterOptions = enabledFields.some(f => f.values.length > 0);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <button
          className="relative flex w-full flex-col rounded-lg border-2 border-border p-3 transition-colors hover:border-primary hover:bg-accent text-left min-h-[120px] md:min-h-[140px]"
        >
          {/* Header row with tray label and unassign button */}
          <div className="flex items-center justify-between w-full mb-2">
            <span className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
              {trayLabel}
            </span>
            {assignedSpool && onUnassign && (
              <span
                onClick={handleUnassign}
                className="h-5 w-5 flex items-center justify-center rounded-full text-muted-foreground hover:text-foreground hover:bg-muted transition-colors cursor-pointer text-xs"
                title="Unassign spool"
              >
                ✕
              </span>
            )}
          </div>

          {/* Mismatch warning banner */}
          {mismatch && assignedSpool && (
            <div
              className="flex items-center gap-1.5 px-2 py-1 mb-2 rounded bg-amber-100 dark:bg-amber-900/30 border border-amber-300 dark:border-amber-700"
              title={`RFID: ${mismatch.printerReports.color} (${mismatch.printerReports.material}) | Assigned: ${mismatch.spoolmanHas.color} (${mismatch.spoolmanHas.material})`}
            >
              <span className="text-amber-600 dark:text-amber-400 text-xs">⚠️</span>
              <span className="text-[10px] font-medium text-amber-700 dark:text-amber-300 truncate">
                Possible wrong spool
              </span>
            </div>
          )}

          {assignedSpool ? (
            <>
              {/* Main content: color circle + filament name */}
              <div className="flex items-center gap-2 mb-2">
                <SpoolColorSwatch filament={assignedSpool.filament} />
                <p className="text-sm font-semibold leading-tight line-clamp-2 [hyphens:none]" title={assignedSpool.filament.name || assignedSpool.filament.material}>
                  {assignedSpool.filament.name || assignedSpool.filament.material}
                </p>
              </div>

              {/* Info: material and vendor stacked */}
              <div className="space-y-1 mb-2 flex-1">
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] font-medium text-muted-foreground uppercase">Material:</span>
                  <span className="text-xs font-medium">{assignedSpool.filament.material}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="text-[9px] font-medium text-muted-foreground uppercase">Vendor:</span>
                  <span className="text-xs font-medium truncate">{assignedSpool.filament.vendor?.name || 'Unknown'}</span>
                </div>
                {showLocation && assignedSpool.location && (
                  <div className="flex items-baseline gap-1">
                    <span className="text-[9px] font-medium text-muted-foreground uppercase">Location:</span>
                    <span className="text-xs font-medium truncate">{assignedSpool.location}</span>
                  </div>
                )}
              </div>

              {/* Footer: spool ID and weight */}
              <div className="flex items-center justify-between mt-auto pt-1">
                <span className="text-[10px] text-muted-foreground">
                  #{assignedSpool.id}
                </span>
                {showWeight && (
                  <Badge variant="secondary" className="text-[10px] px-1.5 py-0 whitespace-nowrap">
                    {Math.round(displayWeight)}g<span className="hidden min-[320px]:inline"> Remaining</span>
                  </Badge>
                )}
              </div>
            </>
          ) : (
            /* Empty tray state */
            <div className="flex flex-col items-center justify-center flex-1 py-2">
              <div
                className="h-8 w-8 rounded-full border-2 border-dashed border-muted-foreground/30 mb-2"
              />
              <p className="text-xs text-muted-foreground">
                No spool assigned
              </p>
              <p className="text-[10px] text-blue-500 dark:text-blue-400 mt-1">
                Click to assign
              </p>
            </div>
          )}
        </button>
      </DialogTrigger>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>
            Assign Spool to {tray.is_external ? 'External Slot' : `Tray ${tray.tray_number}`}
          </DialogTitle>
          <DialogDescription>
            Search and select a spool from your Spoolman inventory.
          </DialogDescription>
        </DialogHeader>

        <div className="rounded-lg border bg-muted/50 p-3 text-xs space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="font-medium text-sm text-foreground">Identifiers for RFID / auto-match</span>
            {isTrayUuidValidForAutoMatch(tray.tray_uuid) ? (
              <Badge variant="outline" className="text-[10px] font-normal whitespace-normal text-left leading-snug max-w-[16rem] sm:max-w-none">
                Compared to Spoolman extra: tag, nfc_uid, nfc_uid_2
              </Badge>
            ) : (
              <Badge variant="secondary" className="text-[10px] shrink-0">Auto-match won&apos;t run</Badge>
            )}
          </div>
          <p className="text-muted-foreground leading-relaxed">
            SpoolmanSync matches the <strong>tray_uuid</strong> attribute from Home Assistant against your Spoolman extra fields (string compare, hex is case-insensitive).
          </p>
          <div className="space-y-2 rounded-md border bg-background px-2.5 py-2 font-mono text-[11px] break-all">
            <div>
              <div className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">tray_uuid (used for matching)</div>
              <div>{tray.tray_uuid?.trim() || '—'}</div>
            </div>
            {tray.tag_uid != null && String(tray.tag_uid).trim() !== '' ? (
              <div className="pt-2 border-t border-border/70">
                <div className="font-sans text-[10px] uppercase tracking-wide text-muted-foreground mb-0.5">tag_uid (from printer / ha-bambulab)</div>
                <div>{String(tray.tag_uid).trim()}</div>
              </div>
            ) : (
              <p className="pt-2 border-t border-border/70 font-sans text-[10px] text-muted-foreground">
                No <code className="text-[10px]">tag_uid</code> attribute on this tray entity — only tray_uuid applies.
              </p>
            )}
          </div>
          {!isTrayUuidValidForAutoMatch(tray.tray_uuid) && (
            <p className="text-amber-800 dark:text-amber-200 leading-relaxed">{autoMatchBlockedReason(tray.tray_uuid)}</p>
          )}
          {(() => {
            const a = normalizedHexIsh(tray.tray_uuid ?? '');
            const b = normalizedHexIsh(tray.tag_uid ?? '');
            if (!a || !b || a === b) return null;
            return (
              <p className="text-muted-foreground leading-relaxed">
                <strong className="text-foreground">Note:</strong> tray_uuid and tag_uid differ here. Populate Spoolman with the value shown under tray_uuid unless you deliberately map something else — that is what the webhook compares to <code>nfc_uid</code> / <code>nfc_uid_2</code>.
              </p>
            );
          })()}
        </div>

        {/* Mismatch warning in dialog */}
        {mismatch && (
          <div className="rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 p-3 text-sm">
            <div className="flex items-start gap-2">
              <span className="text-amber-500 mt-0.5">⚠️</span>
              <div className="space-y-1.5">
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  Possible wrong spool assigned
                </p>
                <div className="text-xs text-amber-600 dark:text-amber-400 space-y-0.5">
                  <p>
                    <span className="opacity-70">RFID reports:</span>{' '}
                    {mismatch.printerReports.material || 'unknown material'}
                    {mismatch.printerReports.color && (
                      <span className="inline-flex items-center gap-1 ml-1">
                        <span
                          className="inline-block w-3 h-3 rounded-full border border-amber-400"
                          style={{ backgroundColor: mismatch.printerReports.color }}
                        />
                        <span className="opacity-70">{mismatch.printerReports.color}</span>
                      </span>
                    )}
                  </p>
                  <p>
                    <span className="opacity-70">Assigned spool:</span>{' '}
                    {mismatch.spoolmanHas.material}
                    <span className="inline-flex items-center gap-1 ml-1">
                      <span
                        className="inline-block w-3 h-3 rounded-full border border-amber-400"
                        style={{ backgroundColor: mismatch.spoolmanHas.color }}
                      />
                      <span className="opacity-70">{mismatch.spoolmanHas.color}</span>
                    </span>
                  </p>
                </div>
                <p className="text-xs text-muted-foreground">
                  Select the correct spool below.
                </p>
              </div>
            </div>
          </div>
        )}

        <Command className="rounded-lg border shadow-md">
          {/* Filter bar with sort */}
          {hasFilterOptions ? (
            <SpoolFilterBar
              filters={filters}
              onFilterChange={handleFilterChange}
              onClearAll={handleClearAll}
              fields={enabledFields}
              extra={
                <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                  <SelectTrigger className="h-8 w-[140px] text-xs">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="id">Sort: ID</SelectItem>
                    <SelectItem value="name">Sort: Name</SelectItem>
                    <SelectItem value="material">Sort: Material</SelectItem>
                    <SelectItem value="vendor">Sort: Vendor</SelectItem>
                  </SelectContent>
                </Select>
              }
            />
          ) : (
            <div className="flex items-center justify-end border-b p-2">
              <Select value={sortBy} onValueChange={(v) => setSortBy(v as SortBy)}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="id">Sort: ID</SelectItem>
                  <SelectItem value="name">Sort: Name</SelectItem>
                  <SelectItem value="material">Sort: Material</SelectItem>
                  <SelectItem value="vendor">Sort: Vendor</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
          <CommandInput placeholder="Search spools by name, vendor, material, ID, or any field..." />
          <CommandList className="max-h-[300px]">
            <CommandEmpty>No spools found matching your filters.</CommandEmpty>
            <CommandGroup heading={`Available Spools (${filteredSpools.length})`}>
              {filteredSpools.map((spool) => (
                <CommandItem
                  key={spool.id}
                  value={buildSpoolSearchValue(spool)}
                  onSelect={() => handleSpoolSelect(spool)}
                  className="flex items-center gap-3 py-2"
                >
                  <SpoolColorSwatch filament={spool.filament} size="h-6 w-6" />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">
                      {spool.filament.name || spool.filament.material}
                    </p>
                    <p className="text-xs text-muted-foreground">
                      {spool.filament.vendor?.name ? `${spool.filament.vendor.name} • ` : ''}{spool.filament.material} • {Math.round(spool.remaining_weight)}g
                    </p>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    #{spool.id}
                  </span>
                  {assignedSpool?.id === spool.id && (
                    <Badge variant="outline" className="ml-1">Current</Badge>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>

        {pendingSpool && isBambuPrinter && (
          <div className="rounded-lg border border-amber-300/60 bg-amber-50/80 dark:bg-amber-950/30 p-3 space-y-3">
            <p className="text-xs text-amber-900 dark:text-amber-200">
              <strong>{pendingSpool.filament.name || pendingSpool.filament.material}</strong> needs a
              Bambu AMS profile (tray_info_idx) to push color and temperatures. Pick the closest match
              from Bambu Studio&apos;s catalog, or enter a custom ID (e.g. from your Bambu account).
            </p>
            {tray.filament_id && (
              <p className="text-[10px] text-muted-foreground">
                Current tray profile on printer: <code className="font-mono">{tray.filament_id}</code>
              </p>
            )}
            <Command shouldFilter={false}>
              <CommandInput
                placeholder="Search Bambu profiles (e.g. Generic PLA, Polymaker)..."
                value={catalogQuery}
                onValueChange={setCatalogQuery}
              />
              <CommandList className="max-h-[160px]">
                <CommandEmpty>
                  {catalogLoading ? 'Loading...' : 'No profiles found. Type a custom tray_info_idx below.'}
                </CommandEmpty>
                <CommandGroup>
                  {catalogEntries.map((entry) => (
                    <CommandItem
                      key={`${entry.tray_info_idx}-${entry.name}`}
                      value={`${entry.name} ${entry.tray_info_idx}`}
                      onSelect={() => setSelectedBambuIdx(entry.tray_info_idx)}
                    >
                      <span className="truncate flex-1">{entry.name}</span>
                      <span className="text-[10px] text-muted-foreground font-mono ml-2">
                        {entry.tray_info_idx}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </CommandList>
            </Command>
            <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
              <input
                className="flex h-8 w-full rounded-md border border-input bg-background px-2 text-xs font-mono"
                placeholder="Or type tray_info_idx (GFL99, P9816594, ...)"
                value={selectedBambuIdx}
                onChange={(e) => setSelectedBambuIdx(e.target.value.trim())}
              />
              <div className="flex gap-2 shrink-0">
                <Button
                  size="sm"
                  disabled={!selectedBambuIdx.trim()}
                  onClick={() => confirmAssign(pendingSpool, selectedBambuIdx.trim())}
                >
                  Assign & push to AMS
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPendingSpool(null)}>
                  Back
                </Button>
              </div>
            </div>
          </div>
        )}

        <div className="flex justify-end">
          <Button variant="ghost" onClick={() => setOpen(false)}>
            Cancel
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
