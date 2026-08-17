const { db } = require('./db');
const {
  sendLeadFollowup,
  sendLeadFollowupDay3,
  sendLeadFollowupDay7,
  sendAgentReminder,
} = require('./email');

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

const getEligibleLeads = db.prepare(`
  SELECT l.*, c.email AS agent_email, c.agency_name
  FROM leads l
  JOIN clients c ON l.client_id = c.id
  WHERE l.created_at <= datetime('now', '-24 hours')
    AND (
      COALESCE(l.followup_stage, 0) IN (0, 1, 2)
      OR COALESCE(l.agent_reminder_sent, 0) = 0
    )
`);

const findLeadBooking = db.prepare(`
  SELECT id FROM bookings
  WHERE client_id = ?
    AND (
      (? IS NOT NULL AND ? != '' AND lead_email = ?)
      OR (? IS NOT NULL AND ? != '' AND lead_phone = ?)
    )
  LIMIT 1
`);

const markFollowupStage = db.prepare('UPDATE leads SET followup_stage = ? WHERE id = ?');
const markFollowupStageWithLegacySent = db.prepare('UPDATE leads SET followup_stage = ?, followup_sent = 1 WHERE id = ?');
const markAgentReminderSent = db.prepare('UPDATE leads SET agent_reminder_sent = 1 WHERE id = ?');
const markBothFollowupsSent = db.prepare('UPDATE leads SET followup_sent = 1, agent_reminder_sent = 1, followup_stage = 4 WHERE id = ?');

function getLeadAgeMs(createdAt) {
  if (!createdAt) return 0;
  const normalized = createdAt.includes('T') ? createdAt : createdAt.replace(' ', 'T');
  const d = new Date(normalized.endsWith('Z') ? normalized : `${normalized}Z`);
  if (isNaN(d.getTime())) return 0;
  return Date.now() - d.getTime();
}

function getLeadBooking(lead) {
  const leadEmail = lead.email?.trim() || null;
  const leadPhone = lead.phone?.trim() || null;
  return findLeadBooking.get(
    lead.client_id,
    leadEmail, leadEmail, leadEmail,
    leadPhone, leadPhone, leadPhone
  );
}

async function processLeadSequence(lead) {
  const stage = lead.followup_stage ?? 0;
  if (stage >= 3) return;

  const ageMs = getLeadAgeMs(lead.created_at);
  const ageHours = ageMs / HOUR_MS;
  const ageDays = ageMs / DAY_MS;
  const leadEmail = lead.email?.trim() || null;
  const leadName = lead.name || 'there';
  const agencyName = lead.agency_name;

  if (stage === 0) {
    if (ageHours < 24) return;
    if (ageDays >= 3) {
      markFollowupStageWithLegacySent.run(1, lead.id);
      console.log(`Follow-up Day 1 skipped — age window passed for lead ${lead.id}`);
      return;
    }
    if (!leadEmail) {
      markFollowupStageWithLegacySent.run(1, lead.id);
      return;
    }
    try {
      await sendLeadFollowup({ leadEmail, leadName, agencyName });
      markFollowupStageWithLegacySent.run(1, lead.id);
      console.log(`Follow-up Day 1 sent for lead ${lead.id}`);
    } catch (e) {
      console.error(`Follow-up Day 1 failed for lead ${lead.id}:`, e.message);
    }
    return;
  }

  if (stage === 1) {
    if (ageDays < 3) return;
    if (ageDays >= 7) {
      markFollowupStage.run(2, lead.id);
      console.log(`Follow-up Day 3 skipped — age window passed for lead ${lead.id}`);
      return;
    }
    if (!leadEmail) {
      markFollowupStage.run(2, lead.id);
      return;
    }
    try {
      await sendLeadFollowupDay3({ leadEmail, leadName, agencyName });
      markFollowupStage.run(2, lead.id);
      console.log(`Follow-up Day 3 sent for lead ${lead.id}`);
    } catch (e) {
      console.error(`Follow-up Day 3 failed for lead ${lead.id}:`, e.message);
    }
    return;
  }

  if (stage === 2) {
    if (ageDays < 7) return;
    if (!leadEmail) {
      markFollowupStage.run(3, lead.id);
      return;
    }
    try {
      await sendLeadFollowupDay7({ leadEmail, leadName, agencyName });
      markFollowupStage.run(3, lead.id);
      console.log(`Follow-up Day 7 sent for lead ${lead.id}`);
    } catch (e) {
      console.error(`Follow-up Day 7 failed for lead ${lead.id}:`, e.message);
    }
  }
}

async function processLeadFollowup(lead) {
  const booking = getLeadBooking(lead);
  if (booking) {
    markBothFollowupsSent.run(lead.id);
    console.log(`Follow-up sequence stopped — lead booked: ${lead.id}`);
    return;
  }

  await processLeadSequence(lead);

  if (!lead.agent_reminder_sent) {
    const agentEmail = lead.agent_email?.trim() || null;
    const leadEmail = lead.email?.trim() || null;
    const leadPhone = lead.phone?.trim() || null;
    if (agentEmail) {
      try {
        await sendAgentReminder({
          agentEmail,
          leadName: lead.name || 'Unknown lead',
          leadPhone,
          leadEmail,
          transcript: lead.transcript,
          agencyName: lead.agency_name,
        });
        markAgentReminderSent.run(lead.id);
      } catch (e) {
        console.error(`❌ Agent reminder failed for lead ${lead.id}:`, e.message);
      }
    } else {
      markAgentReminderSent.run(lead.id);
    }
  }
}

async function checkFollowups() {
  try {
    const leads = getEligibleLeads.all();
    for (const lead of leads) {
      try {
        await processLeadFollowup(lead);
      } catch (e) {
        console.error(`❌ Follow-up processing failed for lead ${lead.id}:`, e.message);
      }
    }
  } catch (e) {
    console.error('❌ checkFollowups failed:', e);
  }
}

module.exports = {
  checkFollowups,
  processLeadFollowup,
  processLeadSequence,
  getLeadAgeMs,
  getEligibleLeads,
  markFollowupStage,
  markFollowupStageWithLegacySent,
  markBothFollowupsSent,
  getLeadBooking,
};
