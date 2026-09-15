import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient, Spool } from '@/lib/api/spoolman';

interface UsageRecord {
  spoolId: number;
  usedWeight: number;
  date: string; // YYYY-MM-DD in user's local timezone
}

interface SpoolSummary {
  spoolId: number;
  spoolName: string;
  material: string;
  vendor: string;
  colorHex: string | null;
  multiColorHexes: string | null;
  multiColorDirection: string | null;
  totalWeight: number;
  eventCount: number;
}

interface TimeBucket {
  date: string;
  totalWeight: number;
  bySpoolId: Record<number, number>;
}

/** Convert a Date to YYYY-MM-DD in a given timezone offset (minutes) */
function toLocalDateStr(date: Date, tzOffsetMinutes: number): string {
  const local = new Date(date.getTime() - tzOffsetMinutes * 60000);
  return local.toISOString().split('T')[0];
}

function getWeekStart(dateStr: string): string {
  const parts = dateStr.split('-');
  const year = parseInt(parts[0]);
  const month = parseInt(parts[1]) - 1;
  const day = parseInt(parts[2]);
  const date = new Date(year, month, day);
  const dow = date.getDay();
  const diff = dow === 0 ? 6 : dow - 1; // Monday = start of week
  date.setDate(date.getDate() - diff);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const from = searchParams.get('from');
    const to = searchParams.get('to');
    const bucket = searchParams.get('bucket') || 'day';
    // Client passes its timezone offset (minutes from UTC, same as Date.getTimezoneOffset())
    const tzOffset = parseInt(searchParams.get('tz') || '0') || 0;

    // Build date filter
    const where: Record<string, unknown> = {
      type: 'spool_usage',
    };

    if (from || to) {
      const createdAt: Record<string, Date> = {};
      if (from) createdAt.gte = new Date(from);
      if (to) createdAt.lte = new Date(to);
      where.createdAt = createdAt;
    }

    // Fetch all spool_usage logs in range
    const logs = await prisma.activityLog.findMany({
      where,
      orderBy: { createdAt: 'asc' },
    });

    // Parse each log's details JSON to extract spoolId and usedWeight
    const records: UsageRecord[] = [];
    for (const log of logs) {
      if (!log.details) continue;
      try {
        const details = JSON.parse(log.details);
        const spoolId = details.spoolId;
        const usedWeight = details.usedWeight;
        if (typeof spoolId === 'number' && typeof usedWeight === 'number') {
          records.push({
            spoolId,
            usedWeight,
            date: toLocalDateStr(log.createdAt, tzOffset),
          });
        }
      } catch {
        // Skip malformed entries
      }
    }

    // Aggregate by spool
    const spoolMap = new Map<number, { totalWeight: number; eventCount: number }>();
    for (const r of records) {
      const existing = spoolMap.get(r.spoolId);
      if (existing) {
        existing.totalWeight += r.usedWeight;
        existing.eventCount += 1;
      } else {
        spoolMap.set(r.spoolId, { totalWeight: r.usedWeight, eventCount: 1 });
      }
    }

    // Aggregate by time bucket
    const timeMap = new Map<string, TimeBucket>();
    for (const r of records) {
      const key = bucket === 'week' ? getWeekStart(r.date) : r.date;
      const existing = timeMap.get(key);
      if (existing) {
        existing.totalWeight += r.usedWeight;
        existing.bySpoolId[r.spoolId] = (existing.bySpoolId[r.spoolId] || 0) + r.usedWeight;
      } else {
        timeMap.set(key, {
          date: key,
          totalWeight: r.usedWeight,
          bySpoolId: { [r.spoolId]: r.usedWeight },
        });
      }
    }

    // Enrich with spool metadata from Spoolman
    let spoolLookup = new Map<number, Spool>();
    try {
      const spoolmanConnection = await prisma.spoolmanConnection.findFirst();
      if (spoolmanConnection) {
        const client = new SpoolmanClient(spoolmanConnection.url);
        const spools = await client.getSpools(true); // Include archived spools for historical reports
        spoolLookup = new Map(spools.map(s => [s.id, s]));
      }
    } catch {
      // Spoolman unavailable - continue with fallback names
    }

    const bySpool: SpoolSummary[] = [];
    for (const [spoolId, agg] of spoolMap) {
      const spool = spoolLookup.get(spoolId);
      bySpool.push({
        spoolId,
        spoolName: spool
          ? `${spool.filament.vendor?.name ? spool.filament.vendor.name + ' ' : ''}${spool.filament.name || spool.filament.material} #${spool.id}`
          : `Unknown Spool #${spoolId}`,
        material: spool?.filament.material || 'Unknown',
        vendor: spool?.filament.vendor?.name || 'Unknown',
        colorHex: spool?.filament.color_hex || null,
        multiColorHexes: spool?.filament.multi_color_hexes || null,
        multiColorDirection: spool?.filament.multi_color_direction || null,
        totalWeight: Math.round(agg.totalWeight * 100) / 100,
        eventCount: agg.eventCount,
      });
    }

    // Sort by total weight descending
    bySpool.sort((a, b) => b.totalWeight - a.totalWeight);

    // Sort time buckets chronologically
    const sortedBuckets = Array.from(timeMap.values()).sort((a, b) => a.date.localeCompare(b.date));

    // Fill gaps with zero-value entries so the chart has a continuous x-axis
    const overTime: TimeBucket[] = [];
    if (sortedBuckets.length > 0) {
      const first = sortedBuckets[0].date;
      const last = sortedBuckets[sortedBuckets.length - 1].date;
      const existingMap = new Map(sortedBuckets.map(b => [b.date, b]));

      const [fy, fm, fd] = first.split('-').map(Number);
      const [ly, lm, ld] = last.split('-').map(Number);
      const current = new Date(fy, fm - 1, fd);
      const end = new Date(ly, lm - 1, ld);
      const step = bucket === 'week' ? 7 : 1;

      while (current <= end) {
        const y = current.getFullYear();
        const m = String(current.getMonth() + 1).padStart(2, '0');
        const d = String(current.getDate()).padStart(2, '0');
        const key = `${y}-${m}-${d}`;

        const existing = existingMap.get(key);
        overTime.push(existing || { date: key, totalWeight: 0, bySpoolId: {} });

        current.setDate(current.getDate() + step);
      }
    }

    // Round weights in time buckets
    for (const tb of overTime) {
      tb.totalWeight = Math.round(tb.totalWeight * 100) / 100;
      for (const id of Object.keys(tb.bySpoolId)) {
        tb.bySpoolId[Number(id)] = Math.round(tb.bySpoolId[Number(id)] * 100) / 100;
      }
    }

    const totalWeight = Math.round(bySpool.reduce((sum, s) => sum + s.totalWeight, 0) * 100) / 100;
    const totalPrints = bySpool.reduce((sum, s) => sum + s.eventCount, 0);

    return NextResponse.json({
      summary: {
        totalWeight,
        totalPrints,
        uniqueSpools: bySpool.length,
      },
      bySpool,
      overTime,
    });
  } catch (error) {
    console.error('Reports API error:', error);
    return NextResponse.json(
      { error: 'Failed to generate usage report' },
      { status: 500 }
    );
  }
}
