import prisma from '@/lib/db';
import { spoolEvents, ACTIVITY_LOG_CREATED, ActivityLogEvent } from '@/lib/events';

interface CreateLogParams {
  type: string;
  message: string;
  details?: Record<string, unknown>;
}

// How long non-report activity logs are retained before pruning.
// 'spool_usage' rows are NEVER pruned — reports/statistics depend on them.
const LOG_RETENTION_DAYS = 90;

/**
 * Prunes old activity logs to keep the table bounded.
 * Preserves ALL 'spool_usage' rows (report history) and any rows newer than
 * the retention window. Fire-and-forget: callers should not await this so a
 * pruning failure never breaks the log write path.
 */
async function pruneActivityLogs(): Promise<void> {
  const cutoff = new Date(Date.now() - LOG_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  await prisma.activityLog.deleteMany({
    where: {
      type: { not: 'spool_usage' },
      createdAt: { lt: cutoff },
    },
  });
}

/**
 * Creates an activity log entry and emits an SSE event for real-time updates
 */
export async function createActivityLog({ type, message, details }: CreateLogParams) {
  const log = await prisma.activityLog.create({
    data: {
      type,
      message,
      details: details ? JSON.stringify(details) : null,
    },
  });

  // Emit event for SSE subscribers
  const event: ActivityLogEvent = {
    id: log.id,
    type: log.type,
    message: log.message,
    details: log.details,
    createdAt: log.createdAt.toISOString(),
  };
  spoolEvents.emit(ACTIVITY_LOG_CREATED, event);

  // Fire-and-forget pruning — never block or fail the create path.
  pruneActivityLogs().catch((err) => {
    console.error('Failed to prune activity logs:', err);
  });

  return log;
}
