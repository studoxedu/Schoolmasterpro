// ============================================================
// smp-offline.js — SchoolMasterPro Offline-First PWA Layer
// ============================================================
// Load order (bottom of <body>):
//   <script src="supabase.min.js"></script>
//   <script src="smp-supabase.js"></script>
//   <script src="smp-offline.js"></script>
//   <script>/* page inline */</script>
//
// This module:
//   1. Registers the service worker (sw.js)
//   2. Manages smp_offline_db (IndexedDB)
//   3. Provides a sync queue for offline writes
//   4. Runs a sync engine that drains the queue when online
//   5. Patches SMP.* write methods to be offline-aware
//   6. Patches SMP.* read methods to serve from IndexedDB when offline
//   7. Injects the connectivity indicator into every page
// ============================================================

(function () {
  'use strict';

  // ── Constants ───────────────────────────────────────────────
  const DB_NAME    = 'smp_offline_db';
  const DB_VERSION = 1;

  // Tables mirrored locally. Must match Supabase table names.
  const MIRROR_TABLES = [
    'students', 'classes', 'subjects', 'terms', 'academic_sessions',
    'student_class_terms', 'assessments', 'score_entries',
    'fee_records', 'fee_payments', 'staff', 'notification_settings',
  ];

  // Exponential backoff delays in ms (retry 1 → 5 → 30 → 120 → 600 → 3600 seconds)
  const BACKOFF_MS = [5000, 30000, 120000, 600000, 3600000];

  // ── IndexedDB ────────────────────────────────────────────────
  let _db = null;

  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => { _db = req.result; resolve(_db); };
      req.onupgradeneeded = e => {
        const db = e.target.result;
        MIRROR_TABLES.forEach(t => {
          if (!db.objectStoreNames.contains(t))
            db.createObjectStore(t, { keyPath: 'id' });
        });
        if (!db.objectStoreNames.contains('sync_queue')) {
          const sq = db.createObjectStore('sync_queue', { keyPath: 'id' });
          sq.createIndex('by_status', 'status');
          sq.createIndex('by_retry', 'next_retry_at');
        }
        if (!db.objectStoreNames.contains('sync_meta')) {
          db.createObjectStore('sync_meta', { keyPath: 'key' });
        }
      };
    });
  }

  async function idbGet(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).get(key);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbPut(store, data) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).put(data);
      req.onsuccess = () => resolve(req.result);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbGetAll(store) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, 'readonly');
      const req = tx.objectStore(store).getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror   = () => reject(req.error);
    });
  }

  async function idbDelete(store, key) {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, 'readwrite');
      const req = tx.objectStore(store).delete(key);
      req.onsuccess = () => resolve();
      req.onerror   = () => reject(req.error);
    });
  }

  // Bulk-put an array of rows into an object store
  async function idbBulkPut(store, rows) {
    if (!rows || !rows.length) return;
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx  = db.transaction(store, 'readwrite');
      const os  = tx.objectStore(store);
      rows.forEach(r => os.put(r));
      tx.oncomplete = resolve;
      tx.onerror    = () => reject(tx.error);
    });
  }

  // ── Sync Queue helpers ───────────────────────────────────────
  function nextRetryAt(retryCount) {
    const delay = BACKOFF_MS[Math.min(retryCount, BACKOFF_MS.length - 1)];
    return new Date(Date.now() + delay).toISOString();
  }

  async function enqueue(table, operation, payload) {
    const item = {
      id:          crypto.randomUUID(),
      table,
      operation,
      payload:     Object.assign({}, payload),
      client_id:   payload.client_id || payload.id || crypto.randomUUID(),
      created_at:  new Date().toISOString(),
      status:      'pending',
      retry_count: 0,
      next_retry_at: new Date().toISOString(),
      last_error:  null,
    };
    await idbPut('sync_queue', item);
    _updateIndicator();
    return item;
  }

  async function _getPendingItems() {
    const all = await idbGetAll('sync_queue');
    const now = new Date();
    return all
      .filter(item =>
        item.status === 'pending' ||
        (item.status === 'failed' && new Date(item.next_retry_at) <= now)
      )
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  }

  async function _getQueueSummary() {
    const all = await idbGetAll('sync_queue');
    return {
      pending: all.filter(i => i.status === 'pending' || i.status === 'failed').length,
      total:   all.length,
    };
  }

  // ── Sync engine ──────────────────────────────────────────────
  let _syncing = false;
  let _syncInterval = null;

  async function syncNow() {
    if (_syncing || !navigator.onLine) { _updateIndicator(); return; }
    const pending = await _getPendingItems();
    if (!pending.length) { _updateIndicator(); return; }

    _syncing = true;
    _updateIndicator();

    for (const item of pending) {
      try {
        await idbPut('sync_queue', Object.assign({}, item, { status: 'syncing' }));
        await _syncItem(item);
        await idbDelete('sync_queue', item.id);
      } catch (err) {
        const newCount = (item.retry_count || 0) + 1;
        await idbPut('sync_queue', Object.assign({}, item, {
          status:       'failed',
          retry_count:  newCount,
          last_error:   err && err.message ? err.message : String(err),
          next_retry_at: nextRetryAt(newCount),
        }));
      }
    }

    _syncing = false;
    _updateIndicator();
  }

  async function _syncItem(item) {
    if (typeof SMP === 'undefined') throw new Error('SMP not loaded');
    const sb = SMP.client;

    if (item.operation === 'insert' || item.operation === 'upsert') {
      if (item.table === 'fee_payments') {
        // Use client_id for idempotency — ON CONFLICT DO NOTHING
        const { error } = await sb
          .from('fee_payments')
          .upsert(item.payload, { onConflict: 'client_id', ignoreDuplicates: true });
        if (error && error.code !== '23505') throw error;
      } else {
        const { error } = await sb
          .from(item.table)
          .upsert(item.payload, { onConflict: 'id', ignoreDuplicates: true });
        if (error && error.code !== '23505') throw error;
      }
    } else if (item.operation === 'update') {
      const { error } = await sb
        .from(item.table)
        .update(item.payload)
        .eq('id', item.payload.id);
      if (error) throw error;
    } else if (item.operation === 'delete') {
      const { error } = await sb
        .from(item.table)
        .delete()
        .eq('id', item.payload.id);
      if (error) throw error;
    } else if (item.operation === 'rpc') {
      // Generic RPC call (e.g. fee_payment RPC)
      const { error } = await sb.rpc(item.table, item.payload);
      if (error) throw error;
    }

    // Re-fetch server-computed fields back into IndexedDB
    if (['score_entries', 'assessments', 'fee_records'].includes(item.table) &&
        item.payload && item.payload.id) {
      try {
        const { data } = await sb
          .from(item.table)
          .select('*')
          .eq('id', item.payload.id)
          .single();
        if (data) await idbPut(item.table, data);
      } catch (_) {}
    }

    // For fee_payments: re-fetch parent fee_record for updated totals
    if (item.table === 'fee_payments' && item.payload && item.payload.fee_id) {
      try {
        const { data } = await sb
          .from('fee_records')
          .select('*')
          .eq('id', item.payload.fee_id)
          .single();
        if (data) await idbPut('fee_records', data);
      } catch (_) {}
    }
  }

  function _startSyncInterval() {
    if (_syncInterval) return;
    _syncInterval = setInterval(syncNow, 30000);
    window.addEventListener('online',  syncNow);
    window.addEventListener('offline', _updateIndicator);
  }

  // ── Connectivity indicator ────────────────────────────────────
  function _injectIndicator() {
    if (document.getElementById('smp-conn-bar')) return;
    const el = document.createElement('div');
    el.id = 'smp-conn-bar';
    el.style.cssText = [
      'position:fixed', 'top:10px', 'right:16px', 'z-index:9990',
      'display:flex', 'align-items:center', 'gap:6px',
      'background:rgba(15,17,23,0.88)', 'color:#fff',
      'padding:5px 11px 5px 8px', 'border-radius:20px',
      'font-size:12px', 'font-family:system-ui,sans-serif',
      'backdrop-filter:blur(6px)', 'box-shadow:0 2px 8px rgba(0,0,0,0.25)',
      'transition:opacity 0.3s', 'pointer-events:none',
    ].join(';');
    el.innerHTML =
      '<span id="smp-conn-dot" style="width:8px;height:8px;border-radius:50%;' +
      'background:#22c55e;display:inline-block;flex-shrink:0;' +
      'transition:background 0.3s"></span>' +
      '<span id="smp-conn-label">Online</span>';
    document.body.appendChild(el);
  }

  async function _updateIndicator() {
    const dot   = document.getElementById('smp-conn-dot');
    const label = document.getElementById('smp-conn-label');
    if (!dot || !label) return;

    const { pending } = await _getQueueSummary().catch(() => ({ pending: 0 }));

    if (!navigator.onLine) {
      dot.style.background = '#ef4444';
      label.textContent = pending > 0
        ? `Offline — ${pending} change${pending !== 1 ? 's' : ''} queued`
        : 'Offline';
    } else if (_syncing || pending > 0) {
      dot.style.background = '#f59e0b';
      label.textContent = `Syncing ${pending} change${pending !== 1 ? 's' : ''}…`;
    } else {
      dot.style.background = '#22c55e';
      label.textContent = 'Online — all saved';
    }
  }

  // ── Data pull (first login / incremental sync) ───────────────
  async function pullAllData(schoolId) {
    if (!navigator.onLine || !schoolId) return;
    const sb = SMP.client;

    const meta     = await idbGet('sync_meta', 'last_pull').catch(() => null);
    const lastPull = meta ? meta.value : null;

    // Tables scoped to school_id
    const schoolScoped = [
      'students', 'classes', 'subjects', 'terms', 'academic_sessions',
      'student_class_terms', 'staff', 'fee_records', 'notification_settings',
    ];
    // Tables without school_id scope (filtered via RLS)
    const rlsScoped = ['assessments', 'score_entries', 'fee_payments'];

    const allTables = [
      ...schoolScoped.map(t => ({ name: t, col: 'school_id', val: schoolId })),
      ...rlsScoped.map(t => ({ name: t, col: null, val: null })),
    ];

    for (const t of allTables) {
      try {
        let q = sb.from(t.name).select('*');
        if (t.col) q = q.eq(t.col, t.val);
        if (lastPull) q = q.gt('updated_at', lastPull);
        const { data, error } = await q;
        if (error || !data) continue;
        await idbBulkPut(t.name, data);
      } catch (_) {}
    }

    await idbPut('sync_meta', {
      key:   'last_pull',
      value: new Date().toISOString(),
    });
    await idbPut('sync_meta', { key: 'school_id', value: schoolId });
    _updateIndicator();
  }

  // ── Offline-safe write helper ────────────────────────────────
  // Called by the patched SMP.* methods when offline, or to keep
  // IndexedDB in sync after a successful online Supabase write.
  async function _localWrite(table, operation, payload) {
    const data = Object.assign({}, payload, {
      id:         payload.id || crypto.randomUUID(),
      updated_at: new Date().toISOString(),
    });

    if (operation === 'delete') {
      await idbDelete(table, data.id).catch(() => {});
    } else {
      await idbPut(table, data).catch(() => {});
    }
    return data;
  }

  // ── Conflict detection helper ────────────────────────────────
  async function _detectConflict(table, localData) {
    try {
      const sb = SMP.client;
      const { data: server } = await sb
        .from(table).select('updated_at').eq('id', localData.id).single();
      if (!server || !server.updated_at || !localData.updated_at) return false;
      const serverTs = new Date(server.updated_at).getTime();
      const localTs  = new Date(localData.updated_at).getTime();
      // Server version changed since our local pull
      const meta = await idbGet('sync_meta', 'last_pull').catch(() => null);
      const pullTs = meta ? new Date(meta.value).getTime() : 0;
      return serverTs > pullTs && serverTs > localTs;
    } catch (_) {
      return false;
    }
  }

  async function _logConflict(table, localData, serverData, schoolId) {
    try {
      await SMP.client.from('sync_conflicts').insert({
        school_id:   schoolId,
        table_name:  table,
        record_id:   localData.id,
        local_data:  localData,
        server_data: serverData,
      });
    } catch (_) {}
  }

  // ── SMP method patches ────────────────────────────────────────
  // Patched synchronously (not in DOMContentLoaded) so they're in
  // place before any page's DOMContentLoaded handler runs.

  function _patchSMP() {
    if (typeof SMP === 'undefined') return;

    // ── students ──
    const _sc = SMP.students.create.bind(SMP.students);
    SMP.students.create = async function (data) {
      if (!navigator.onLine) {
        const local = await _localWrite('students', 'insert', data);
        await enqueue('students', 'insert', local);
        return { data: local, error: null };
      }
      const result = await _sc(data);
      if (!result.error && result.data) await idbPut('students', result.data).catch(() => {});
      return result;
    };

    const _su = SMP.students.update.bind(SMP.students);
    SMP.students.update = async function (id, data) {
      if (!navigator.onLine) {
        const existing = await idbGet('students', id).catch(() => null);
        const merged = Object.assign({}, existing, data, { id });
        await _localWrite('students', 'update', merged);
        await enqueue('students', 'update', merged);
        return { data: merged, error: null };
      }
      const result = await _su(id, data);
      if (!result.error && result.data) await idbPut('students', result.data).catch(() => {});
      return result;
    };

    const _sd = SMP.students.delete.bind(SMP.students);
    SMP.students.delete = async function (id) {
      if (!navigator.onLine) {
        await _localWrite('students', 'delete', { id });
        await enqueue('students', 'delete', { id });
        return { data: null, error: null };
      }
      const result = await _sd(id);
      if (!result.error) await idbDelete('students', id).catch(() => {});
      return result;
    };

    const _sl = SMP.students.list.bind(SMP.students);
    SMP.students.list = async function (opts) {
      if (!navigator.onLine) {
        return _localStudentsList(opts || {});
      }
      return _sl(opts);
    };

    // ── assessments / scores ──
    const _au = SMP.assessments.upsert.bind(SMP.assessments);
    SMP.assessments.upsert = async function (data) {
      if (!navigator.onLine) {
        const local = await _localWrite('assessments', 'upsert', data);
        await enqueue('assessments', 'upsert', local);
        return { data: local, error: null };
      }
      const result = await _au(data);
      if (!result.error && result.data) await idbPut('assessments', result.data).catch(() => {});
      return result;
    };

    // ── fees: recordPayment wraps the RPC ──
    const _fp = SMP.fees.recordPayment.bind(SMP.fees);
    SMP.fees.recordPayment = async function (feeId, amount, method, paidBy, notes) {
      const clientId  = crypto.randomUUID();
      const paymentId = crypto.randomUUID();

      if (!navigator.onLine) {
        // Build local fee_payments row
        const payment = {
          id: paymentId, client_id: clientId,
          fee_id: feeId, amount: Number(amount),
          payment_method: method || 'cash',
          paid_by: paidBy || null, notes: notes || null,
          paid_at: new Date().toISOString(),
        };
        await idbPut('fee_payments', payment);
        await enqueue('fee_payments', 'insert', payment);

        // Optimistic update of fee_records
        const rec = await idbGet('fee_records', feeId).catch(() => null);
        if (rec) {
          const newPaid = (Number(rec.amount_paid) || 0) + Number(amount);
          const newStatus = newPaid >= Number(rec.amount_due) ? 'paid'
                          : newPaid > 0 ? 'partial' : 'unpaid';
          await idbPut('fee_records', Object.assign({}, rec, {
            amount_paid: newPaid, status: newStatus,
          }));
        }
        SMP.showToast('Payment saved offline — will sync when online.', 'warning');
        return { data: { success: true, offline: true }, error: null };
      }

      // Online: call the RPC (which does the proper DB work), then
      // also store the payment locally for IndexedDB consistency.
      const result = await _fp(feeId, amount, method, paidBy, notes);
      if (!result.error) {
        try {
          // Re-fetch the updated fee_record
          const { data: fr } = await SMP.client
            .from('fee_records').select('*').eq('id', feeId).single();
          if (fr) await idbPut('fee_records', fr);
        } catch (_) {}
      }
      return result;
    };

    // ── staff ──
    const _sfc = SMP.staff.create.bind(SMP.staff);
    SMP.staff.create = async function (data) {
      if (!navigator.onLine) {
        const local = await _localWrite('staff', 'insert', data);
        await enqueue('staff', 'insert', local);
        return { data: local, error: null };
      }
      const result = await _sfc(data);
      if (!result.error && result.data) await idbPut('staff', result.data).catch(() => {});
      return result;
    };

    const _sfu = SMP.staff.update.bind(SMP.staff);
    SMP.staff.update = async function (id, data) {
      if (!navigator.onLine) {
        const existing = await idbGet('staff', id).catch(() => null);
        const merged = Object.assign({}, existing, data, { id });
        await _localWrite('staff', 'update', merged);
        await enqueue('staff', 'update', merged);
        return { data: merged, error: null };
      }
      const result = await _sfu(id, data);
      if (!result.error && result.data) await idbPut('staff', result.data).catch(() => {});
      return result;
    };

    const _sfd = SMP.staff.delete.bind(SMP.staff);
    SMP.staff.delete = async function (id) {
      if (!navigator.onLine) {
        const existing = await idbGet('staff', id).catch(() => null);
        if (existing) {
          await idbPut('staff', Object.assign({}, existing, { status: 'inactive' }));
          await enqueue('staff', 'update', { id, status: 'inactive' });
        }
        return { data: null, error: null };
      }
      const result = await _sfd(id);
      if (!result.error) {
        const existing = await idbGet('staff', id).catch(() => null);
        if (existing) await idbPut('staff', Object.assign({}, existing, { status: 'inactive' }));
      }
      return result;
    };

    // ── setup reads (classes, subjects, terms) ──
    const _gc = SMP.setup.getClasses.bind(SMP.setup);
    SMP.setup.getClasses = async function () {
      if (!navigator.onLine) {
        const data = await idbGetAll('classes').catch(() => []);
        return { data, error: null };
      }
      const result = await _gc();
      if (!result.error && result.data) await idbBulkPut('classes', result.data).catch(() => {});
      return result;
    };

    const _gs = SMP.setup.getSubjects.bind(SMP.setup);
    SMP.setup.getSubjects = async function () {
      if (!navigator.onLine) {
        const data = await idbGetAll('subjects').catch(() => []);
        return { data, error: null };
      }
      const result = await _gs();
      if (!result.error && result.data) await idbBulkPut('subjects', result.data).catch(() => {});
      return result;
    };

    const _gt = SMP.setup.getCurrentTerm.bind(SMP.setup);
    SMP.setup.getCurrentTerm = async function () {
      if (!navigator.onLine) {
        const terms = await idbGetAll('terms').catch(() => []);
        return terms.find(t => t.is_current) || terms[0] || null;
      }
      return _gt();
    };
  }

  // ── Local student list (offline read) ───────────────────────
  async function _localStudentsList(opts) {
    const all    = await idbGetAll('students').catch(() => []);
    const status = opts.status || 'active';
    let results  = all.filter(s => s.status === status);

    if (opts.search) {
      const q = opts.search.toLowerCase();
      results = results.filter(s =>
        ((s.first_name || '') + ' ' + (s.last_name || '')).toLowerCase().includes(q) ||
        (s.student_code || '').toLowerCase().includes(q) ||
        (s.smp_id || '').toLowerCase().includes(q)
      );
    }
    if (opts.classId) {
      results = results.filter(s => s.class_id === opts.classId);
    }
    results.sort((a, b) => (a.last_name || '').localeCompare(b.last_name || ''));

    const offset = opts.offset || 0;
    const limit  = opts.limit  || 50;
    return {
      data:  results.slice(offset, offset + limit),
      count: results.length,
      error: null,
    };
  }

  // ── Service worker registration ──────────────────────────────
  function _registerSW() {
    if (!('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js', { scope: '/' })
      .then(reg => {
        // Auto-update when a new SW is waiting
        reg.addEventListener('updatefound', () => {
          const newSW = reg.installing;
          newSW.addEventListener('statechange', () => {
            if (newSW.state === 'installed' && navigator.serviceWorker.controller) {
              // New version available — notify (non-blocking)
              SMP.showToast('App updated — refresh for latest version.', 'warning', 6000);
            }
          });
        });
      })
      .catch(err => console.warn('[SMP] SW registration failed:', err));
  }

  // ── Public API ───────────────────────────────────────────────
  window.SMPOffline = {
    pullAllData,
    syncNow,
    enqueue,
    // IndexedDB access for advanced page use
    idb: { get: idbGet, put: idbPut, getAll: idbGetAll, delete: idbDelete, bulkPut: idbBulkPut },
    updateIndicator: _updateIndicator,
  };

  // ── Boot sequence ─────────────────────────────────────────────
  // 1. Patch SMP methods immediately (synchronous — before DOMContentLoaded)
  _patchSMP();

  // 2. DOM-dependent setup runs after DOM is ready
  document.addEventListener('DOMContentLoaded', function () {
    _registerSW();
    _injectIndicator();
    _updateIndicator();
    _startSyncInterval();
    // Kick off an initial sync if online
    if (navigator.onLine) setTimeout(syncNow, 1000);
  });

})();
