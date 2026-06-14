// supabase/functions/send-notifications/index.ts
// Handles: fee_reminder | results_alert | welcome
// Providers: Termii (SMS), Resend (email)

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const TERMII_API_KEY = Deno.env.get("TERMII_API_KEY") ?? "";
const RESEND_API_KEY = Deno.env.get("RESEND_API_KEY") ?? "";
const FROM_EMAIL     = Deno.env.get("FROM_EMAIL") ?? "noreply@schoolmasterpro.ng";
const FROM_NAME      = "SchoolMasterPro";

// ─── CORS ────────────────────────────────────────────────────
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const body = await req.json();
    const { type } = body;

    let result;

    if (type === "welcome") {
      result = await handleWelcome(body);
    } else if (type === "fee_reminder") {
      result = await handleFeeReminder(body);
    } else if (type === "results_alert") {
      result = await handleResultsAlert(body);
    } else {
      return new Response(
        JSON.stringify({ error: `Unknown notification type: ${type}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ success: true, ...result }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });

  } catch (err) {
    console.error("Edge function error:", err);
    return new Response(
      JSON.stringify({ error: err.message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});


// ─────────────────────────────────────────────────────────────
// WELCOME EMAIL — sent on school registration
// ─────────────────────────────────────────────────────────────
async function handleWelcome(body: {
  to_email: string;
  to_name: string;
  school_name: string;
  plan: string;
}) {
  const { to_email, to_name, school_name, plan } = body;

  const planLabel: Record<string, string> = {
    trial: "Free Trial (30 days)",
    lite:  "Lite Plan",
    full:  "Full Plan",
  };

  const planFeatures: Record<string, string[]> = {
    trial: [
      "Demo school data pre-loaded — explore immediately",
      "All platform features unlocked for 30 days",
      "Up to 50 students",
      "Email support",
    ],
    lite: [
      "Student records & score entry",
      "Automated grading & report cards (PDF)",
      "Up to 200 students",
      "Email support",
    ],
    full: [
      "All modules — students, fees, staff, documents",
      "SMS notifications via Termii",
      "Bulk CSV score upload",
      "Unlimited students",
      "Priority support",
    ],
  };

  const features = planFeatures[plan] ?? planFeatures["trial"];
  const featureRows = features
    .map(f => `
      <tr>
        <td style="padding:6px 0; color:#3a3f4b; font-size:14px;">
          <span style="color:#1a6b3c; font-weight:700; margin-right:8px;">✓</span>${f}
        </td>
      </tr>`)
    .join("");

  const trialNote = plan === "trial"
    ? `<div style="background:#fef3cd; border:1px solid #ffc107; border-radius:8px; padding:16px; margin:24px 0; font-size:13px; color:#856404;">
        <strong>Trial account:</strong> Your demo data is already loaded. Log in and explore — no setup needed. When you're ready to go live, upgrade your plan from the admin settings.
       </div>`
    : "";

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#f7f7f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f7f7f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 4px 24px rgba(0,0,0,0.07);">

        <!-- HEADER -->
        <tr>
          <td style="background:#0f1117;padding:32px 40px;text-align:center;">
            <div style="display:inline-block;background:#1a6b3c;border-radius:10px;padding:10px 14px;margin-bottom:16px;">
              <span style="color:white;font-size:20px;">🛡️</span>
            </div>
            <div style="color:white;font-size:22px;font-weight:700;letter-spacing:-0.5px;">SchoolMasterPro</div>
            <div style="color:rgba(255,255,255,0.45);font-size:12px;letter-spacing:2px;text-transform:uppercase;margin-top:4px;">School Management Platform</div>
          </td>
        </tr>

        <!-- BODY -->
        <tr>
          <td style="padding:40px 40px 32px;">
            <h1 style="margin:0 0 8px;font-size:26px;font-weight:700;color:#0f1117;letter-spacing:-0.5px;">
              Welcome, ${to_name.split(" ")[0]}! 🎉
            </h1>
            <p style="margin:0 0 24px;font-size:15px;color:#3a3f4b;line-height:1.6;">
              <strong>${school_name}</strong> is now registered on SchoolMasterPro. You're on the <strong>${planLabel[plan] ?? plan}</strong>.
            </p>

            ${trialNote}

            <!-- PLAN FEATURES -->
            <div style="background:#f7f7f5;border-radius:10px;padding:20px 24px;margin-bottom:28px;">
              <div style="font-size:11px;font-weight:600;letter-spacing:2px;text-transform:uppercase;color:#3a3f4b;margin-bottom:12px;">What's included</div>
              <table width="100%" cellpadding="0" cellspacing="0">
                ${featureRows}
              </table>
            </div>

            <!-- CTA -->
            <table width="100%" cellpadding="0" cellspacing="0">
              <tr>
                <td align="center">
                  <a href="https://schoolmasterpro.vercel.app/login"
                     style="display:inline-block;background:#1a6b3c;color:white;padding:14px 36px;border-radius:10px;font-size:15px;font-weight:600;text-decoration:none;letter-spacing:-0.2px;">
                    Log in to your dashboard →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0;font-size:13px;color:#3a3f4b;line-height:1.6;">
              If you have questions, reply to this email — we're here to help.<br>
              <strong>The SchoolMasterPro Team</strong>
            </p>
          </td>
        </tr>

        <!-- FOOTER -->
        <tr>
          <td style="background:#f7f7f5;padding:20px 40px;border-top:1px solid #dddbd6;">
            <p style="margin:0;font-size:11px;color:#3a3f4b;text-align:center;line-height:1.6;">
              You're receiving this because you registered at schoolmasterpro.ng<br>
              © ${new Date().getFullYear()} SchoolMasterPro · Nigeria
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const res = await sendEmail({
    to: to_email,
    subject: `Welcome to SchoolMasterPro — ${school_name} is live!`,
    html,
  });

  return { channel: "email", to: to_email, resend_id: res?.id };
}


// ─────────────────────────────────────────────────────────────
// FEE REMINDER
// ─────────────────────────────────────────────────────────────
async function handleFeeReminder(body: {
  notifications: Array<{
    id: string;
    student_name: string;
    parent_phone?: string;
    parent_email?: string;
    school_name: string;
    amount_owed: number;
    term_name: string;
  }>;
  channels: string[];   // ["sms", "email"]
  school_id: string;
}) {
  const { notifications, channels } = body;
  const results = [];

  for (const n of notifications) {
    const amountStr = `₦${Number(n.amount_owed).toLocaleString("en-NG")}`;
    const smsText = `Dear Parent, ${n.student_name}'s school fees balance of ${amountStr} for ${n.term_name} is outstanding. Please pay promptly. — ${n.school_name}`;

    if (channels.includes("sms") && n.parent_phone) {
      const smsRes = await sendSMS({ to: n.parent_phone, sms: smsText });
      results.push({ id: n.id, channel: "sms", status: smsRes?.message_id ? "sent" : "failed" });
    }

    if (channels.includes("email") && n.parent_email) {
      const html = buildFeeReminderEmail(n, amountStr);
      const emailRes = await sendEmail({
        to: n.parent_email,
        subject: `School Fees Reminder — ${n.student_name} (${n.term_name})`,
        html,
      });
      results.push({ id: n.id, channel: "email", status: emailRes?.id ? "sent" : "failed" });
    }
  }

  return { results };
}

function buildFeeReminderEmail(n: any, amountStr: string): string {
  return `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f7f7f5;padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;margin:0 auto;overflow:hidden;">
  <tr><td style="background:#0f1117;padding:28px 36px;">
    <div style="color:white;font-size:18px;font-weight:700;">SchoolMasterPro</div>
    <div style="color:rgba(255,255,255,0.45);font-size:11px;letter-spacing:2px;text-transform:uppercase;">Fee Reminder</div>
  </td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="font-size:15px;color:#0f1117;">Dear Parent/Guardian,</p>
    <p style="font-size:14px;color:#3a3f4b;line-height:1.7;">
      This is a reminder that <strong>${n.student_name}</strong>'s school fees for
      <strong>${n.term_name}</strong> has an outstanding balance of
      <strong style="color:#c0392b;">${amountStr}</strong>.
    </p>
    <p style="font-size:14px;color:#3a3f4b;">Please make payment at your earliest convenience to avoid disruption to your child's education.</p>
    <p style="font-size:13px;color:#3a3f4b;margin-top:24px;">— ${n.school_name}</p>
  </td></tr>
  <tr><td style="background:#f7f7f5;padding:16px 36px;border-top:1px solid #dddbd6;">
    <p style="margin:0;font-size:11px;color:#3a3f4b;text-align:center;">© ${new Date().getFullYear()} SchoolMasterPro · Nigeria</p>
  </td></tr>
</table>
</body></html>`;
}


// ─────────────────────────────────────────────────────────────
// RESULTS ALERT
// ─────────────────────────────────────────────────────────────
async function handleResultsAlert(body: {
  notifications: Array<{
    id: string;
    student_name: string;
    parent_phone?: string;
    parent_email?: string;
    school_name: string;
    term_name: string;
    average?: number;
  }>;
  channels: string[];
}) {
  const { notifications, channels } = body;
  const results = [];

  for (const n of notifications) {
    const avg = n.average ? ` Average score: ${n.average.toFixed(1)}%.` : "";
    const smsText = `Dear Parent, ${n.student_name}'s results for ${n.term_name} are now available. Log in to SchoolMasterPro to view the report card.${avg} — ${n.school_name}`;

    if (channels.includes("sms") && n.parent_phone) {
      const smsRes = await sendSMS({ to: n.parent_phone, sms: smsText });
      results.push({ id: n.id, channel: "sms", status: smsRes?.message_id ? "sent" : "failed" });
    }

    if (channels.includes("email") && n.parent_email) {
      const html = buildResultsEmail(n);
      const emailRes = await sendEmail({
        to: n.parent_email,
        subject: `${n.student_name}'s Results — ${n.term_name}`,
        html,
      });
      results.push({ id: n.id, channel: "email", status: emailRes?.id ? "sent" : "failed" });
    }
  }

  return { results };
}

function buildResultsEmail(n: any): string {
  const avg = n.average ? `<p style="font-size:14px;color:#3a3f4b;">Overall average: <strong>${n.average.toFixed(1)}%</strong></p>` : "";
  return `
<!DOCTYPE html><html><body style="font-family:Arial,sans-serif;background:#f7f7f5;padding:40px 20px;">
<table width="560" cellpadding="0" cellspacing="0" style="background:#fff;border-radius:12px;margin:0 auto;overflow:hidden;">
  <tr><td style="background:#0f1117;padding:28px 36px;">
    <div style="color:white;font-size:18px;font-weight:700;">SchoolMasterPro</div>
    <div style="color:rgba(255,255,255,0.45);font-size:11px;letter-spacing:2px;text-transform:uppercase;">Results Notification</div>
  </td></tr>
  <tr><td style="padding:32px 36px;">
    <p style="font-size:15px;color:#0f1117;">Dear Parent/Guardian,</p>
    <p style="font-size:14px;color:#3a3f4b;line-height:1.7;">
      <strong>${n.student_name}</strong>'s academic results for <strong>${n.term_name}</strong> are now available on SchoolMasterPro.
    </p>
    ${avg}
    <p style="font-size:14px;color:#3a3f4b;">Log in to your school portal to view and download the full report card.</p>
    <p style="font-size:13px;color:#3a3f4b;margin-top:24px;">— ${n.school_name}</p>
  </td></tr>
  <tr><td style="background:#f7f7f5;padding:16px 36px;border-top:1px solid #dddbd6;">
    <p style="margin:0;font-size:11px;color:#3a3f4b;text-align:center;">© ${new Date().getFullYear()} SchoolMasterPro · Nigeria</p>
  </td></tr>
</table>
</body></html>`;
}


// ─────────────────────────────────────────────────────────────
// TRANSPORT HELPERS
// ─────────────────────────────────────────────────────────────
async function sendSMS({ to, sms }: { to: string; sms: string }) {
  if (!TERMII_API_KEY) throw new Error("TERMII_API_KEY not set");
  const res = await fetch("https://api.ng.termii.com/api/sms/send", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to,
      from: "SchoolPro",
      sms,
      type: "plain",
      channel: "generic",
      api_key: TERMII_API_KEY,
    }),
  });
  return res.json();
}

async function sendEmail({ to, subject, html }: { to: string; subject: string; html: string }) {
  if (!RESEND_API_KEY) throw new Error("RESEND_API_KEY not set");
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to,
      subject,
      html,
    }),
  });
  return res.json();
}
