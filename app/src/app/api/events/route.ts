import { NextRequest } from 'next/server';
import { spoolEvents, SPOOL_UPDATED, ACTIVITY_LOG_CREATED, ALERT_UPDATED, SpoolUpdateEvent, ActivityLogEvent } from '@/lib/events';

/**
 * Server-Sent Events endpoint for real-time dashboard updates
 *
 * Clients connect to this endpoint and receive updates when:
 * - Spool usage is deducted (from webhook)
 * - Spools are assigned/unassigned to trays
 * - Activity logs are created
 */

// Ensure this route is never statically optimized
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest): Promise<Response> {
  const encoder = new TextEncoder();

  // Shared between start() and cancel() so the cancel callback can tear down
  // the EventEmitter listeners and heartbeat interval. Without this, every
  // client disconnect leaked listeners and a setInterval timer.
  let cleanup: () => void = () => {};

  const stream = new ReadableStream({
    start(controller) {
      // Send a large padding comment to flush through proxy buffers.
      // HA's ingress proxy and nginx may hold small chunks in internal
      // buffers (~4KB). SSE comments (lines starting with :) are ignored
      // by EventSource but push data through the proxy chain.
      const padding = `: ${' '.repeat(4096)}\n\n`;
      controller.enqueue(encoder.encode(padding));

      // Send initial connection message
      const connectMessage = `data: ${JSON.stringify({ type: 'connected', timestamp: Date.now() })}\n\n`;
      controller.enqueue(encoder.encode(connectMessage));

      // Subscribe to spool update events
      const unsubscribeSpool = spoolEvents.on(SPOOL_UPDATED, (data: unknown) => {
        try {
          const event = data as SpoolUpdateEvent;
          const message = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch {
          // Client disconnected — tear down immediately
          cleanup();
        }
      });

      // Subscribe to activity log events
      const unsubscribeLog = spoolEvents.on(ACTIVITY_LOG_CREATED, (data: unknown) => {
        try {
          const event = data as ActivityLogEvent;
          const message = `data: ${JSON.stringify({ ...event, eventType: 'activity_log' })}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch {
          // Client disconnected — tear down immediately
          cleanup();
        }
      });

      // Subscribe to alert update events
      const unsubscribeAlert = spoolEvents.on(ALERT_UPDATED, (data: unknown) => {
        try {
          const message = `data: ${JSON.stringify({ type: 'alert_update', alerts: data })}\n\n`;
          controller.enqueue(encoder.encode(message));
        } catch {
          // Client disconnected — tear down immediately
          cleanup();
        }
      });

      // Send heartbeat every 30 seconds to keep connection alive
      const heartbeatInterval = setInterval(() => {
        try {
          const heartbeat = `data: ${JSON.stringify({ type: 'heartbeat', timestamp: Date.now() })}\n\n`;
          controller.enqueue(encoder.encode(heartbeat));
        } catch {
          // Client disconnected — tear down immediately
          cleanup();
        }
      }, 30000);

      // Idempotent teardown: unsubscribe listeners and clear the heartbeat.
      // Guarded so repeated invocations (enqueue failures, cancel, abort) are
      // safe to call multiple times.
      let cleanedUp = false;
      cleanup = () => {
        if (cleanedUp) return;
        cleanedUp = true;
        unsubscribeSpool();
        unsubscribeLog();
        unsubscribeAlert();
        clearInterval(heartbeatInterval);
      };

      // Tear down if the request is aborted (e.g. client navigates away).
      if (request.signal) {
        if (request.signal.aborted) {
          cleanup();
        } else {
          request.signal.addEventListener('abort', () => cleanup());
        }
      }
    },
    cancel() {
      // Stream was cancelled (client disconnected)
      cleanup();
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      // Prevent HA's ingress proxy from adding Content-Encoding: deflate
      // which causes browsers to buffer the entire response instead of streaming
      'Content-Encoding': 'identity',
    },
  });
}
