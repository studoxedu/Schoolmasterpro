# SchoolMasterPro — Deployment Package

## Setup Steps

### 1. Supabase SQL (run in order)
01_schema.sql → 02_rls.sql → 03_functions.sql → 04_demo_seed.sql → 05_storage.sql → 07_features.sql → 08_notification_settings.sql → 09_onboarding.sql → 10_audit.sql → 11_smp_id.sql → 12_missing_features.sql

### 2. Configure smp-supabase.js
Replace in smp-supabase.js:
- YOUR_SUPABASE_URL → your project URL
- YOUR_SUPABASE_ANON_KEY → your anon key

### 3. Edge Function
supabase functions deploy send-notifications
Set secrets: TERMII_API_KEY, RESEND_API_KEY, FROM_EMAIL

### 4. Deploy
Push to GitHub → import on Vercel (no build settings)
Add Vercel domain to Supabase Auth URL config

## Pages
- login.html — Auth
- register.html — School onboarding (3-step wizard)
- index.html — Dashboard
- students.html — Student list with bulk actions + duplicate guard
- student-profile.html — Student detail
- scores.html — Score entry (keyboard nav)
- fees.html — Fee management
- receipts.html — Payment recording + PDF receipts ← NEW
- reports.html — PDF report cards
- staff.html — Staff register
- bulk-upload.html — CSV score import
- notifications.html — SMS/email dispatch
- notif-settings.html — Provider config
- documents.html — File storage
- promotion.html — End-of-session promotion
- term-settings.html — Sessions/terms/classes/subjects
- term-comparison.html — Term-on-term comparison ← NEW
- transcript.html — Full academic transcript + PDF ← NEW
- audit.html — Audit log viewer ← NEW
- admin-login.html / admin.html — Platform admin

## New SQL Files (this build)
- 09_onboarding.sql — provision_school(), seed_trial_demo_data()
- 10_audit.sql — Full audit logging with DB triggers
- 11_smp_id.sql — SMP-ID assignment + transfer scaffolding
- 12_missing_features.sql — Receipts, delivery tracking, health scores, term comparison, orphan prevention, duplicate guard, usage tracking
