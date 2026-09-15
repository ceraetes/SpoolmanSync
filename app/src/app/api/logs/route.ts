import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/db';
import { SpoolmanClient } from '@/lib/api/spoolman';

/**
 * Look up a log entry and ensure it is a usage event. Only 'spool_usage' rows
 * may be edited/deleted — other rows (errors, tray-change detections, etc.)
 * must not be mutable from the reports UI.
 */
async function getUsageLog(id: string) {
  const log = await prisma.activityLog.findUnique({ where: { id } });
  if (!log) return { error: 'Log entry not found', status: 404 as const };
  if (log.type !== 'spool_usage') {
    return { error: 'Only usage events can be edited or deleted', status: 400 as const };
  }
  return { log };
}

/**
 * Optionally reflect a statistics edit back into Spoolman's remaining weight.
 * Positive delta deducts more; negative delta returns weight to the spool.
 */
async function adjustSpoolmanWeight(spoolId: number, delta: number): Promise<void> {
  if (!delta) return;
  const conn = await prisma.spoolmanConnection.findFirst();
  if (!conn) return;
  const client = new SpoolmanClient(conn.url);
  await client.useWeight(spoolId, delta);
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const page = Math.max(1, parseInt(searchParams.get('page') || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(searchParams.get('limit') || '20', 10)));
    const filter = searchParams.get('filter') || 'all';

    // Build where clause based on filter
    let where = {};
    if (filter === 'actions') {
      // Only show logs where SpoolmanSync took an action
      where = {
        type: {
          in: ['spool_usage', 'spool_change', 'spool_unassign', 'spool_assign', 'tag_stored'],
        },
      };
    } else if (filter === 'tray_changes') {
      // Only show tray change events (including detected ones with no action)
      where = {
        type: {
          in: ['spool_change', 'spool_unassign', 'tray_change_detected', 'tray_empty_detected'],
        },
      };
    } else if (filter === 'errors') {
      where = {
        type: 'error',
      };
    }
    // 'all' filter shows everything

    const [logs, total] = await Promise.all([
      prisma.activityLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.activityLog.count({ where }),
    ]);

    return NextResponse.json({
      logs,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error('Error fetching logs:', error);
    return NextResponse.json({ error: 'Failed to fetch logs' }, { status: 500 });
  }
}

/**
 * Edit the weight recorded for a usage event (issue #54 — correct statistics).
 * Body: { id, usedWeight, adjustSpoolman? }. By default this only corrects local
 * statistics; pass adjustSpoolman:true to also apply the delta to the spool's
 * remaining weight in Spoolman.
 */
export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const id = (body.id ?? '').toString();
    const usedWeight = body.usedWeight;
    if (!id) {
      return NextResponse.json({ error: 'A log id is required' }, { status: 400 });
    }
    if (typeof usedWeight !== 'number' || !isFinite(usedWeight) || usedWeight < 0) {
      return NextResponse.json({ error: 'usedWeight must be a non-negative number' }, { status: 400 });
    }

    const result = await getUsageLog(id);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    let details: Record<string, unknown> = {};
    try { details = JSON.parse(result.log.details || '{}'); } catch { /* keep empty */ }
    const oldWeight = typeof details.usedWeight === 'number' ? details.usedWeight : 0;
    const spoolId = details.spoolId;
    const newWeight = Math.round(usedWeight * 100) / 100;
    details.usedWeight = newWeight;

    await prisma.activityLog.update({
      where: { id },
      data: {
        details: JSON.stringify(details),
        message: `Usage event edited: ${newWeight.toFixed(2)}g${typeof spoolId === 'number' ? ` (spool #${spoolId})` : ''}`,
      },
    });

    if (body.adjustSpoolman === true && typeof spoolId === 'number') {
      try {
        await adjustSpoolmanWeight(spoolId, newWeight - oldWeight);
      } catch (err) {
        console.error('Failed to adjust Spoolman weight after usage edit:', err);
        return NextResponse.json({ success: true, spoolmanAdjusted: false, warning: 'Statistics updated, but Spoolman could not be adjusted.' });
      }
    }

    return NextResponse.json({ success: true, spoolmanAdjusted: body.adjustSpoolman === true });
  } catch (error) {
    console.error('Error editing usage event:', error);
    return NextResponse.json({ error: 'Failed to edit usage event' }, { status: 500 });
  }
}

/**
 * Delete a usage event (issue #54). Body: { id, adjustSpoolman? }. By default
 * only the local statistics row is removed; pass adjustSpoolman:true to also
 * return the deducted weight to the spool in Spoolman.
 */
export async function DELETE(request: NextRequest) {
  try {
    const body = await request.json();
    const id = (body.id ?? '').toString();
    if (!id) {
      return NextResponse.json({ error: 'A log id is required' }, { status: 400 });
    }

    const result = await getUsageLog(id);
    if ('error' in result) {
      return NextResponse.json({ error: result.error }, { status: result.status });
    }

    let details: Record<string, unknown> = {};
    try { details = JSON.parse(result.log.details || '{}'); } catch { /* keep empty */ }
    const spoolId = details.spoolId;
    const oldWeight = typeof details.usedWeight === 'number' ? details.usedWeight : 0;

    await prisma.activityLog.delete({ where: { id } });

    if (body.adjustSpoolman === true && typeof spoolId === 'number' && oldWeight > 0) {
      try {
        await adjustSpoolmanWeight(spoolId, -oldWeight);
      } catch (err) {
        console.error('Failed to return weight to Spoolman after usage delete:', err);
        return NextResponse.json({ success: true, spoolmanAdjusted: false, warning: 'Event deleted, but Spoolman could not be adjusted.' });
      }
    }

    return NextResponse.json({ success: true, spoolmanAdjusted: body.adjustSpoolman === true });
  } catch (error) {
    console.error('Error deleting usage event:', error);
    return NextResponse.json({ error: 'Failed to delete usage event' }, { status: 500 });
  }
}
