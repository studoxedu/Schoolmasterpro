// ============================================================
// sw.js — SchoolMasterPro Service Worker
// Cache-first strategy for all self-hosted app shell assets.
// Version bumping the CACHE_NAME causes the new SW to take over
// and purge old caches on next activate.
// ============================================================

const CACHE_NAME = 'smp-shell-v1';

// Every self-hosted HTML, JS, and support file.
// Supabase API calls are never cached (network-only by default).
const SHELL_ASSETS = [
  // Core pages
  '/login.html',   '/login',
  '/register.html', '/register',
  '/index.html',   '/',
  '/students.html', '/students',
  '/scores.html',   '/scores',
  '/fees.html',     '/fees',
  '/receipts.html', '/receipts',
  '/staff.html',    '/staff',
  '/term-comparison.html', '/term-comparison',
  '/transcript.html', '/transcript',
  '/audit.html',   '/audit',
  '/term-settings.html', '/term-settings',
  '/notif-settings.html', '/notif-settings',
  '/bulk-upload.html', '/bulk-upload',
  '/documents.html', '/documents',
  '/promotion.html', '/promotion',
  '/notifications.html', '/notifications',
  '/student-profile.html', '/student-profile',
  '/admin-login.html', '/admin-login',
  '/admin.html',   '/admin',
  // Scripts
  '/supabase.min.js',
  '/smp-supabase.js',
  '/smp-offline.js',
  '/jspdf.umd.min.js',
  // PWA assets
  '/manifest.json',
  '/icon.svg',
];

// ── Install: cache all shell assets ──────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => {
        // Don't fail install if some assets 404 — the cache will have what it can
        console.warn('[SW] Cache addAll partial failure:', err);
        return self.skipWaiting();
      })
  );
});

// ── Activate: purge stale caches ─────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys
          .filter(k => k !== CACHE_NAME)
          .map(k => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

// ── Fetch: cache-first for app shell ─────────────────────────
self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);

  // Never intercept non-GET or cross-origin (Supabase API, etc.)
  if (req.method !== 'GET') return;
  if (url.origin !== self.location.origin) return;

  // Supabase storage/functions URLs served from same origin? Unlikely,
  // but guard against it explicitly.
  if (url.pathname.startsWith('/supabase/functions/')) return;

  event.respondWith(
    caches.match(req).then(cached => {
      // Cache hit → serve immediately, refresh in background
      if (cached) {
        // Background refresh so cache stays current after deploys
        const networkFetch = fetch(req).then(response => {
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(c => c.put(req, clone));
          }
          return response;
        }).catch(() => {});
        // Return cached version immediately (don't await background refresh)
        return cached;
      }

      // Cache miss → try network, then cache the response
      return fetch(req).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(req, clone));
        }
        return response;
      }).catch(() => {
        // Network failed and no cache — serve offline fallback for navigations
        if (req.mode === 'navigate') {
          return caches.match('/login.html').then(fb => fb || new Response(
            '<!DOCTYPE html><html><body style="font-family:sans-serif;padding:40px;text-align:center">' +
            '<h2>You are offline</h2><p>SchoolMasterPro is loading its offline cache on first visit.</p>' +
            '<p>Please connect to the internet once, then this message will go away.</p></body></html>',
            { headers: { 'Content-Type': 'text/html' } }
          ));
        }
        return new Response('', { status: 503 });
      });
    })
  );
});
