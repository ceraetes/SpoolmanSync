'use client';

import { useEffect } from 'react';

/**
 * Patches fetch(), EventSource, and navigation to work through HA ingress proxy.
 *
 * When the app runs inside HA's ingress iframe, the browser URL includes the
 * ingress prefix (e.g., /api/hassio_ingress/abc123/) but the Next.js app only
 * knows about its own routes (/, /settings, etc.). This component intercepts
 * network requests and navigation to rewrite URLs through ingress.
 *
 * Key insight: Next.js App Router constructs full URLs for RSC payload fetches
 * using new URL(href, window.location.href), which produces URLs like
 * http://ha:8123/settings that bypass ingress. The fetch patcher must handle
 * full URL strings, URL objects, and Request objects — not just absolute paths.
 */
export function IngressPatcher({ ingressPath }: { ingressPath: string }) {
  useEffect(() => {
    const base = ingressPath.endsWith('/') ? ingressPath : `${ingressPath}/`;
    const origin = window.location.origin;

    // Rewrite a URL string to go through ingress.
    // Handles absolute paths (/settings) and full URLs (http://origin/settings).
    const rewriteUrl = (url: string): string => {
      if (url.startsWith('/') && !url.startsWith(ingressPath)) {
        return base + url.slice(1);
      }
      if (url.startsWith(origin + '/')) {
        const pathAndQuery = url.slice(origin.length);
        if (!pathAndQuery.startsWith(ingressPath)) {
          return origin + base + pathAndQuery.slice(1);
        }
      }
      return url;
    };

    // Patch fetch to rewrite URLs through ingress.
    // Handles string URLs, URL objects, and Request objects.
    const originalFetch = window.fetch;
    window.fetch = function (input: RequestInfo | URL, init?: RequestInit) {
      if (typeof input === 'string') {
        input = rewriteUrl(input);
      } else if (input instanceof URL) {
        if (input.origin === origin && !input.pathname.startsWith(ingressPath)) {
          input = new URL(origin + base + input.pathname.slice(1) + input.search + input.hash);
        }
      } else if (input instanceof Request) {
        const url = new URL(input.url);
        if (url.origin === origin && !url.pathname.startsWith(ingressPath)) {
          const newUrl = origin + base + url.pathname.slice(1) + url.search + url.hash;
          input = new Request(newUrl, input);
        }
      }
      return originalFetch.call(this, input, init);
    };

    // Patch EventSource (used for SSE on dashboard/logs).
    // Subclassing preserves the prototype chain and the inherited static
    // constants (CONNECTING / OPEN / CLOSED) that code may reference, which a
    // plain function wrapper + Object.assign would drop (those constants are
    // non-enumerable own props on the native constructor).
    const OriginalEventSource = window.EventSource;
    class PatchedEventSource extends OriginalEventSource {
      constructor(url: string | URL, config?: EventSourceInit) {
        super(typeof url === 'string' ? rewriteUrl(url) : url, config);
      }
    }
    window.EventSource = PatchedEventSource as unknown as typeof EventSource;

    // Patch history.pushState and replaceState so Next.js router
    // updates the iframe URL with the ingress prefix
    const originalPushState = window.history.pushState.bind(window.history);
    const originalReplaceState = window.history.replaceState.bind(window.history);

    window.history.pushState = function (data: unknown, unused: string, url?: string | URL | null) {
      if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(ingressPath)) {
        url = base + url.slice(1);
      }
      return originalPushState(data, unused, url);
    };

    window.history.replaceState = function (data: unknown, unused: string, url?: string | URL | null) {
      if (typeof url === 'string' && url.startsWith('/') && !url.startsWith(ingressPath)) {
        url = base + url.slice(1);
      }
      return originalReplaceState(data, unused, url);
    };

    // Intercept link clicks to rewrite absolute hrefs through ingress.
    // This handles regular <a> tags; Next.js Link components use React props
    // for navigation so the DOM modification doesn't affect SPA routing.
    const handleClick = (e: MouseEvent) => {
      const link = (e.target as HTMLElement).closest('a');
      if (!link) return;

      const href = link.getAttribute('href');
      if (href && href.startsWith('/') && !href.startsWith(ingressPath)) {
        link.setAttribute('href', base + href.slice(1));
      }
    };
    document.addEventListener('click', handleClick, true);

    return () => {
      window.fetch = originalFetch;
      window.EventSource = OriginalEventSource;
      window.history.pushState = originalPushState;
      window.history.replaceState = originalReplaceState;
      document.removeEventListener('click', handleClick, true);
    };
  }, [ingressPath]);

  return null;
}
