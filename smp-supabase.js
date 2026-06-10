// ============================================================
// smp-supabase.js — SchoolMasterPro Shared SDK
// Version 2.0 — Full feature set
// ============================================================

const SMP_CONFIG = {
  supabaseUrl: 'https://wpumtrgiffajjynoqaiw.supabase.co',
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndwdW10cmdpZmZhamp5bm9xYWl3Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4Nzc3OTQsImV4cCI6MjA5MzQ1Mzc5NH0.Iw1QdxnujWPekNavhes7ThWBLY8GjxdWD29fTNE5L98'
};

const { createClient } = supabase;
const _sb = createClient(SMP_CONFIG.supabaseUrl, SMP_CONFIG.supabaseKey);

// ── Cache ────────────────────────────────────────────────────
let _schoolCache = null;
let _sessionCache = null;

// ── Utility ─────────────────────────────────────────────────
function formatNaira(n) {
  return '₦' + Number(n || 0).toLocaleString('en-NG', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function showToast(msg, type = 'success', duration = 3500) {
  let t = document.getElementById('smp-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'smp-toast';
    t.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:9999;padding:12px 20px;border-radius:10px;font-size:14px;font-weight:500;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,0.15);transition:all 0.3s;opacity:0;transform:translateY(10px)';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.style.background = type === 'error' ? '#c0392b' : type === 'warning' ? '#d97706' : '#0f1117';
  requestAnimationFrame(() => { t.style.opacity = '1'; t.style.transform = 'translateY(0)'; });
  clearTimeout(t._timer);
  t._timer = setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateY(10px)'; }, duration);
}

function setLoading(btnId, loading, text = 'Save') {
  const btn = document.getElementById(btnId);
  if (!btn) return;
  btn.disabled = loading;
  btn.innerHTML = loading
    ? '<span style="display:inline-block;width:14px;height:14px;border:2px solid rgba(255,255,255,0.3);border-top-color:white;border-radius:50%;animation:spin 0.7s linear infinite;margin-right:6px;vertical-align:middle"></span>Processing…'
    : text;
}

function initPage(requireAuth = true) {
  if (!document.getElementById('smp-spin-style')) {
    const s = document.createElement('style');
    s.id = 'smp-spin-style';
    s.textContent = '@keyframes spin{to{transform:rotate(360deg)}}';
    document.head.appendChild(s);
  }
  if (requireAuth) {
    _sb.auth.getSession().then(({ data }) => {
      if (!data.session) window.location.href = 'login.html';
    });
  }
}

// ── Auth ─────────────────────────────────────────────────────
const AuthAPI = {
  async signIn(email, password) {
    return _sb.auth.signInWithPassword({ email, password });
  },
  async signOut() {
    _schoolCache = null; _sessionCache = null;
    return _sb.auth.signOut();
  },
  async getSession() {
    const { data } = await _sb.auth.getSession();
    return data.session;
  },
  async getUser() {
    const { data } = await _sb.auth.getUser();
    return data.user;
  }
};

// ── School ───────────────────────────────────────────────────
const SchoolAPI = {
  async get() {
    if (_schoolCache) return _schoolCache;
    const user = await AuthAPI.getUser();
    if (!user) return null;
    const { data } = await _sb.from('operators')
      .select('school_id, schools(*)')
      .eq('user_id', user.id)
      .single();
    _schoolCache = data?.schools || null;
    return _schoolCache;
  },
  async update(updates) {
    const school = await this.get();
    if (!school) throw new Error('No school found');
    const { data, error } = await _sb.from('schools').update(updates).eq('id', school.id).select().single();
    if (!error) _schoolCache = data;
    return { data, error };
  }
};

// ── Dashboard ────────────────────────────────────────────────
const DashboardAPI = {
  async getStats() {
    return _sb.rpc('get_dashboard_stats');
  },
  async getOnboardingStatus() {
    return _sb.rpc('get_onboarding_status');
  }
};

// ── Students ─────────────────────────────────────────────────
const StudentsAPI = {
  async list({ search = '', classId = null, status = 'active', limit = 50, offset = 0 } = {}) {
    let q = _sb.from('students')
      .select('*, classes(name)', { count: 'exact' })
      .eq('status', status)
      .order('last_name', { ascending: true })
      .range(offset, offset + limit - 1);
    if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,student_code.ilike.%${search}%,smp_id.ilike.%${search}%`);
    if (classId) q = q.eq('class_id', classId);
    return q;
  },
  async get(id) {
    return _sb.from('students').select('*, classes(name,level)').eq('id', id).single();
  },
  async create(data) {
    return _sb.from('students').insert(data).select().single();
  },
  async update(id, data) {
    return _sb.from('students').update(data).eq('id', id).select().single();
  },
  async delete(id) {
    return _sb.from('students').update({ status: 'withdrawn' }).eq('id', id);
  },
  async checkDuplicate(firstName, lastName) {
    return _sb.rpc('check_duplicate_student', { p_first_name: firstName, p_last_name: lastName });
  },
  async getTranscript(studentId) {
    return _sb.rpc('get_student_transcript', { p_student_id: studentId });
  },
  async initiateTransfer(studentId, toSchoolId = null, notes = null) {
    return _sb.rpc('initiate_transfer', { p_student_id: studentId, p_to_school_id: toSchoolId, p_notes: notes });
  },
  async exportPackage(studentId) {
    return _sb.rpc('export_student_package', { p_student_id: studentId });
  }
};

// ── Assessments / Scores ──────────────────────────────────────
const AssessmentsAPI = {
  async list({ classId, subjectId, termId } = {}) {
    let q = _sb.from('assessments')
      .select('*, students(first_name,last_name,student_code), subjects(name,code)')
      .order('students(last_name)', { ascending: true });
    if (classId)   q = q.eq('class_id', classId);
    if (subjectId) q = q.eq('subject_id', subjectId);
    if (termId)    q = q.eq('term_id', termId);
    return q;
  },
  async upsert(data) {
    return _sb.from('assessments').upsert(data, { onConflict: 'student_id,subject_id,term_id' }).select().single();
  },
  async lock(ids, locked = true) {
    return _sb.from('assessments').update({ is_locked: locked }).in('id', ids);
  },
  async recomputePositions(schoolId, termId, classId) {
    return _sb.rpc('recompute_positions', { p_school_id: schoolId, p_term_id: termId, p_class_id: classId });
  },
  async getReport(studentId, termId) {
    return _sb.rpc('get_student_report', { p_student_id: studentId, p_term_id: termId });
  },
  async getTermComparison(studentId) {
    return _sb.rpc('get_term_comparison', { p_student_id: studentId });
  }
};

// ── Fees ─────────────────────────────────────────────────────
const FeesAPI = {
  async list({ studentId = null, termId = null, status = null, limit = 50, offset = 0 } = {}) {
    let q = _sb.from('fees')
      .select('*, students(first_name,last_name,student_code,smp_id)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (studentId) q = q.eq('student_id', studentId);
    if (termId)    q = q.eq('term_id', termId);
    if (status)    q = q.eq('status', status);
    return q;
  },
  async create(data) {
    return _sb.from('fees').insert(data).select().single();
  },
  async recordPayment(feeId, amount, method = 'cash', paidBy = null, notes = null) {
    return _sb.rpc('record_fee_payment', {
      p_fee_id: feeId, p_amount: amount,
      p_method: method, p_paid_by: paidBy, p_notes: notes
    });
  },
  async getReceipts(studentId = null, feeId = null, limit = 50, offset = 0) {
    return _sb.rpc('get_receipts', { p_student_id: studentId, p_fee_id: feeId, p_limit: limit, p_offset: offset });
  },
  async getOverdue(daysOverdue = 0) {
    return _sb.rpc('get_overdue_fees', { p_days_overdue: daysOverdue });
  },
  async generateReminders(termId) {
    return _sb.rpc('generate_fee_reminders', { p_term_id: termId });
  }
};

// ── Staff ────────────────────────────────────────────────────
const StaffAPI = {
  async list({ search = '', status = 'active' } = {}) {
    let q = _sb.from('staff').select('*', { count: 'exact' }).eq('status', status).order('last_name');
    if (search) q = q.or(`first_name.ilike.%${search}%,last_name.ilike.%${search}%,email.ilike.%${search}%`);
    return q;
  },
  async create(data) { return _sb.from('staff').insert(data).select().single(); },
  async update(id, data) { return _sb.from('staff').update(data).eq('id', id).select().single(); },
  async delete(id) { return _sb.from('staff').update({ status: 'inactive' }).eq('id', id); }
};

// ── Setup (classes, subjects, terms, sessions) ───────────────
const SetupAPI = {
  async getClasses() { return _sb.from('classes').select('*').order('level,name'); },
  async getSubjects() { return _sb.from('subjects').select('*').order('name'); },
  async getCurrentTerm() {
    if (_sessionCache) return _sessionCache;
    const { data } = await _sb.from('terms').select('*, sessions(*)').eq('is_current', true).single();
    _sessionCache = data;
    return data;
  },
  async getTerms() { return _sb.from('terms').select('*, sessions(name)').order('created_at', { ascending: false }); },
  async createClass(data) { return _sb.from('classes').insert(data).select().single(); },
  async createSubject(data) { return _sb.from('subjects').insert(data).select().single(); },
  async createTerm(data) { return _sb.from('terms').insert(data).select().single(); },
  async createSession(data) { return _sb.from('sessions').insert(data).select().single(); }
};

// ── Reports ──────────────────────────────────────────────────
const ReportsAPI = {
  async getStudentReport(studentId, termId) {
    return _sb.rpc('get_student_report', { p_student_id: studentId, p_term_id: termId });
  }
};

// ── Documents ────────────────────────────────────────────────
const DocsAPI = {
  async list(schoolId) {
    return _sb.storage.from('school-documents').list(schoolId + '/');
  },
  async upload(schoolId, file) {
    const path = `${schoolId}/${Date.now()}_${file.name}`;
    return _sb.storage.from('school-documents').upload(path, file);
  },
  async getUrl(path) {
    return _sb.storage.from('school-documents').createSignedUrl(path, 3600);
  },
  async delete(path) {
    return _sb.storage.from('school-documents').remove([path]);
  }
};

// ── Notifications ────────────────────────────────────────────
const NotificationsAPI = {
  async list({ status = null, type = null, limit = 50, offset = 0 } = {}) {
    let q = _sb.from('notifications')
      .select('*, students(first_name,last_name,student_code)', { count: 'exact' })
      .order('created_at', { ascending: false })
      .range(offset, offset + limit - 1);
    if (status) q = q.eq('status', status);
    if (type)   q = q.eq('type', type);
    return q;
  },
  async generateFeeReminders(termId) {
    return _sb.rpc('generate_fee_reminders', { p_term_id: termId });
  },
  async generateResultsAlerts(termId) {
    return _sb.rpc('generate_results_notifications', { p_term_id: termId });
  },
  async dispatch(notificationIds, channels) {
    return _sb.functions.invoke('send-notifications', {
      body: { type: 'batch_dispatch', notification_ids: notificationIds, channels }
    });
  },
  async markDelivered(notificationId, providerRef = null) {
    return _sb.rpc('mark_notification_delivered', { p_notification_id: notificationId, p_provider_ref: providerRef });
  },
  async markFailed(notificationId, error = null) {
    return _sb.rpc('mark_notification_failed', { p_notification_id: notificationId, p_error: error });
  },
  async getDeliveryStats() {
    return _sb.rpc('get_notification_delivery_stats');
  },
  async retry(notificationId) {
    // Reset to pending for retry
    return _sb.from('notifications').update({ status: 'pending' }).eq('id', notificationId);
  }
};

// ── Notification Settings ────────────────────────────────────
const NotifSettingsAPI = {
  async get() {
    return _sb.from('notification_settings').select('*');
  },
  async upsert(provider, settings) {
    return _sb.from('notification_settings')
      .upsert({ ...settings, provider }, { onConflict: 'school_id,provider' });
  }
};

// ── Promotion ────────────────────────────────────────────────
const PromotionAPI = {
  async preview(sessionId) {
    return _sb.rpc('preview_promotions', { p_session_id: sessionId });
  },
  async execute(sessionId) {
    return _sb.rpc('execute_promotions', { p_session_id: sessionId });
  }
};

// ── Audit ────────────────────────────────────────────────────
const AuditAPI = {
  async getLogs({ entity = null, action = null, limit = 50, offset = 0 } = {}) {
    return _sb.rpc('get_audit_logs', { p_entity: entity, p_action: action, p_limit: limit, p_offset: offset });
  },
  async log(action, entity, entityId = null, oldData = null, newData = null) {
    return _sb.rpc('log_audit', {
      p_action: action, p_entity: entity,
      p_entity_id: entityId, p_old_data: oldData, p_new_data: newData
    });
  }
};

// ── Usage tracking ───────────────────────────────────────────
const UsageAPI = {
  async track(eventType, meta = null) {
    return _sb.rpc('track_usage', { p_event_type: eventType, p_meta: meta });
  }
};

// ── Platform Admin ───────────────────────────────────────────
const PlatformAPI = {
  async getStats() {
    return _sb.rpc('get_platform_stats');
  },
  async getHealthScores() {
    return _sb.rpc('get_school_health_scores');
  },
  async getUsageSummary(days = 30) {
    return _sb.rpc('get_platform_usage_summary', { p_days: days });
  },
  async listSchools() {
    return _sb.from('schools').select('*').order('created_at', { ascending: false });
  },
  async updateSchoolStatus(schoolId, status) {
    return _sb.from('schools').update({ status }).eq('id', schoolId);
  },
  async updateSchoolPlan(schoolId, plan) {
    return _sb.from('schools').update({ plan }).eq('id', schoolId);
  }
};

// ── Bulk Upload ──────────────────────────────────────────────
const BulkAPI = {
  async logUpload(data) {
    return _sb.from('bulk_upload_logs').insert(data).select().single();
  },
  async getUploadLogs(limit = 20) {
    return _sb.from('bulk_upload_logs').select('*').order('created_at', { ascending: false }).limit(limit);
  }
};

// ── SMP namespace (used by HTML pages) ───────────────────────
const SMP = {
  client:   _sb,
  auth:     AuthAPI,
  school:   SchoolAPI,
  dashboard: DashboardAPI,
  students: StudentsAPI,
  assessments: AssessmentsAPI,
  fees:     FeesAPI,
  staff:    StaffAPI,
  setup:    SetupAPI,
  reports:  ReportsAPI,
  docs:     DocsAPI,
  notifications: NotificationsAPI,
  notifSettings: NotifSettingsAPI,
  promotion: PromotionAPI,
  audit:    AuditAPI,
  usage:    UsageAPI,
  platform: PlatformAPI,
  bulk:     BulkAPI,

  // Utilities
  formatNaira,
  showToast,
  setLoading,
  initPage
};

// No auto-init — each page manages its own auth check
