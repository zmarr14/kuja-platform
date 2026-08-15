const https = require('https');

async function sendLeadNotification({ clientEmail, agencyName, lead }) {
  const platformUrl = process.env.PLATFORM_URL || 'http://localhost:3000';

  const transcriptHtml = lead.transcript
    ? lead.transcript.split('\n').filter(l => l.trim()).map(line => {
        if (line.startsWith('Visitor:')) return `<p style="margin:5px 0;font-family:Arial,sans-serif"><strong style="color:#131218">${line}</strong></p>`;
        if (line.startsWith('Bot:')) return `<p style="margin:5px 0;font-family:Arial,sans-serif;color:#6b6560">${line}</p>`;
        return `<p style="margin:5px 0;font-family:Arial,sans-serif;color:#a39d90;font-size:12px">${line}</p>`;
      }).join('')
    : '<p style="color:#a39d90;font-family:Arial,sans-serif">No transcript available</p>';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#F3EFE6;padding:40px 20px">

      <!-- header -->
      <div style="background:#131218;padding:26px 32px;border-radius:14px 14px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:12px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="background:#F3EFE6;border-radius:8px;">
                <tr><td align="center" style="font-family:Arial,sans-serif;font-weight:900;font-size:18px;color:#131218;">
                  K<span style="color:#FF5A1F;">·</span>
                </td></tr>
              </table>
            </td>
            <td>
              <h1 style="margin:0;color:#F3EFE6;font-size:19px;font-weight:700;letter-spacing:-0.01em;">New Lead Captured</h1>
              <p style="margin:5px 0 0;color:#FF5A1F;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-family:'Courier New',monospace;">${agencyName}</p>
            </td>
          </tr>
        </table>
      </div>

      <!-- body -->
      <div style="background:#ffffff;padding:28px 32px;border:1px solid rgba(19,18,24,0.08);border-top:none;border-radius:0 0 14px 14px;">

        ${lead.name ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Name</span><br><strong style="font-size:17px;color:#131218;font-family:Arial,sans-serif;">${lead.name}</strong></p>` : ''}
        ${lead.phone ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Phone</span><br><a href="tel:${lead.phone}" style="color:#FF5A1F;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;">${lead.phone}</a></p>` : ''}
        ${lead.email ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Email</span><br><a href="mailto:${lead.email}" style="color:#FF5A1F;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;">${lead.email}</a></p>` : ''}
        <p style="margin:0 0 22px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Captured</span><br><span style="font-size:14px;color:#131218;font-family:Arial,sans-serif;">${new Date(lead.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}</span></p>

        <div style="background:#F3EFE6;padding:16px 18px;border-left:3px solid #FF5A1F;border-radius:0 8px 8px 0;font-size:13px;line-height:1.6;">${transcriptHtml}</div>

        <div style="text-align:center;margin-top:26px">
          <a href="${platformUrl}/frontend/pages/dashboard.html" style="background:#131218;color:#F3EFE6;padding:13px 30px;text-decoration:none;font-size:14px;font-weight:600;border-radius:9px;display:inline-block;font-family:Arial,sans-serif;">View in Dashboard →</a>
        </div>
      </div>

      <p style="text-align:center;margin-top:18px;font-size:11px;color:#a39d90;font-family:Arial,sans-serif;letter-spacing:0.3px;">Powered by Kuja · Brisbane, Australia</p>
    </div>`;

  const payload = JSON.stringify({
    from: 'Kuja AI <info@kujaai.com>',
    to: [clientEmail],
    subject: `New Lead: ${lead.name || lead.email || 'Unknown'} — ${agencyName}`,
    html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SMTP_PASS}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ Email sent to ${clientEmail} via Resend API`);
          resolve(data);
        } else {
          console.error(`❌ Resend API error ${res.statusCode}:`, data);
          reject(new Error(`Resend API error: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ Email request failed:', e.message);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}

async function sendBookingConfirmation({ clientEmail, agencyName, name, email, phone, startTime }) {
  const timeStr = new Date(startTime).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane', dateStyle: 'full', timeStyle: 'short' });

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#F3EFE6;padding:40px 20px">

      <div style="background:#131218;padding:26px 32px;border-radius:14px 14px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:12px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="background:#F3EFE6;border-radius:8px;">
                <tr><td align="center" style="font-family:Arial,sans-serif;font-weight:900;font-size:18px;color:#131218;">
                  K<span style="color:#FF5A1F;">·</span>
                </td></tr>
              </table>
            </td>
            <td>
              <h1 style="margin:0;color:#F3EFE6;font-size:19px;font-weight:700;letter-spacing:-0.01em;">New Booking Confirmed</h1>
              <p style="margin:5px 0 0;color:#FF5A1F;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-family:'Courier New',monospace;">${agencyName}</p>
            </td>
          </tr>
        </table>
      </div>

      <div style="background:#ffffff;padding:28px 32px;border:1px solid rgba(19,18,24,0.08);border-top:none;border-radius:0 0 14px 14px;">

        <p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Booked with</span><br><strong style="font-size:17px;color:#131218;font-family:Arial,sans-serif;">${name}</strong></p>
        ${phone ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Phone</span><br><a href="tel:${phone}" style="color:#FF5A1F;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;">${phone}</a></p>` : ''}
        ${email ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Email</span><br><a href="mailto:${email}" style="color:#FF5A1F;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;">${email}</a></p>` : ''}

        <div style="background:#F3EFE6;padding:16px 18px;border-left:3px solid #FF5A1F;border-radius:0 8px 8px 0;margin-top:18px;">
          <span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">When</span><br>
          <strong style="font-size:16px;color:#131218;font-family:Arial,sans-serif;">${timeStr}</strong>
        </div>

        <p style="margin-top:22px;font-size:13px;color:#6b6560;font-family:Arial,sans-serif;">This has already been added to your Google Calendar automatically.</p>
      </div>

      <p style="text-align:center;margin-top:18px;font-size:11px;color:#a39d90;font-family:Arial,sans-serif;letter-spacing:0.3px;">Powered by Kuja · Brisbane, Australia</p>
    </div>`;

  const payload = JSON.stringify({
    from: 'Kuja AI <info@kujaai.com>',
    to: [clientEmail],
    subject: `New Booking: ${name} — ${timeStr}`,
    html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SMTP_PASS}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ Booking confirmation sent to ${clientEmail}`);
          resolve(data);
        } else {
          console.error(`❌ Resend API error ${res.statusCode}:`, data);
          reject(new Error(`Resend API error: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ Email request failed:', e.message);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}

function transcriptExcerpt(transcript) {
  if (!transcript) return null;
  const cleaned = transcript.replace(/\s+/g, ' ').trim();
  if (!cleaned) return null;
  if (cleaned.length <= 150) return cleaned;
  return cleaned.slice(0, 147) + '...';
}

async function sendLeadFollowup({ leadEmail, leadName, agencyName }) {
  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#F3EFE6;padding:40px 20px">

      <div style="background:#131218;padding:26px 32px;border-radius:14px 14px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:12px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="background:#F3EFE6;border-radius:8px;">
                <tr><td align="center" style="font-family:Arial,sans-serif;font-weight:900;font-size:18px;color:#131218;">
                  K<span style="color:#FF5A1F;">·</span>
                </td></tr>
              </table>
            </td>
            <td>
              <h1 style="margin:0;color:#F3EFE6;font-size:19px;font-weight:700;letter-spacing:-0.01em;">Still thinking about it?</h1>
              <p style="margin:5px 0 0;color:#FF5A1F;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-family:'Courier New',monospace;">${agencyName}</p>
            </td>
          </tr>
        </table>
      </div>

      <div style="background:#ffffff;padding:28px 32px;border:1px solid rgba(19,18,24,0.08);border-top:none;border-radius:0 0 14px 14px;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#131218;font-family:Arial,sans-serif;">Hi ${leadName},</p>
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#131218;font-family:Arial,sans-serif;">Just following up on your chat with ${agencyName} — happy to help if you've still got questions or want to book a time.</p>
        <p style="margin:0;font-size:15px;line-height:1.6;color:#131218;font-family:Arial,sans-serif;">Just reply to this email or head back to our website to chat again.</p>
      </div>

      <p style="text-align:center;margin-top:18px;font-size:11px;color:#a39d90;font-family:Arial,sans-serif;letter-spacing:0.3px;">Powered by Kuja · Brisbane, Australia</p>
    </div>`;

  const payload = JSON.stringify({
    from: 'Kuja AI <info@kujaai.com>',
    to: [leadEmail],
    subject: 'Still thinking about it?',
    html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SMTP_PASS}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ Lead follow-up sent to ${leadEmail}`);
          resolve(data);
        } else {
          console.error(`❌ Resend API error ${res.statusCode}:`, data);
          reject(new Error(`Resend API error: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ Email request failed:', e.message);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}

async function sendAgentReminder({ agentEmail, leadName, leadPhone, leadEmail, transcript, agencyName }) {
  const excerpt = transcriptExcerpt(transcript);

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#F3EFE6;padding:40px 20px">

      <div style="background:#131218;padding:26px 32px;border-radius:14px 14px 0 0;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0">
          <tr>
            <td style="padding-right:12px;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="36" height="36" style="background:#F3EFE6;border-radius:8px;">
                <tr><td align="center" style="font-family:Arial,sans-serif;font-weight:900;font-size:18px;color:#131218;">
                  K<span style="color:#FF5A1F;">·</span>
                </td></tr>
              </table>
            </td>
            <td>
              <h1 style="margin:0;color:#F3EFE6;font-size:19px;font-weight:700;letter-spacing:-0.01em;">Follow up needed</h1>
              <p style="margin:5px 0 0;color:#FF5A1F;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;font-family:'Courier New',monospace;">${agencyName}</p>
            </td>
          </tr>
        </table>
      </div>

      <div style="background:#ffffff;padding:28px 32px;border:1px solid rgba(19,18,24,0.08);border-top:none;border-radius:0 0 14px 14px;">
        <p style="margin:0 0 16px;font-size:15px;line-height:1.6;color:#131218;font-family:Arial,sans-serif;">It has been about 24 hours since <strong>${leadName}</strong> chatted with your Kuja AI assistant, and they haven't booked anything yet.</p>

        <p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Lead</span><br><strong style="font-size:17px;color:#131218;font-family:Arial,sans-serif;">${leadName}</strong></p>
        ${leadPhone ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Phone</span><br><a href="tel:${leadPhone}" style="color:#FF5A1F;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;">${leadPhone}</a></p>` : ''}
        ${leadEmail ? `<p style="margin:0 0 14px"><span style="color:#8c8578;font-size:11px;text-transform:uppercase;letter-spacing:1.2px;font-family:'Courier New',monospace;">Email</span><br><a href="mailto:${leadEmail}" style="color:#FF5A1F;font-size:15px;text-decoration:none;font-family:Arial,sans-serif;">${leadEmail}</a></p>` : ''}
        ${excerpt ? `<div style="background:#F3EFE6;padding:16px 18px;border-left:3px solid #FF5A1F;border-radius:0 8px 8px 0;margin-top:18px;font-size:13px;line-height:1.6;color:#131218;font-family:Arial,sans-serif;">${excerpt}</div>` : ''}

        <div style="text-align:center;margin-top:26px">
          <a href="${process.env.PLATFORM_URL || 'http://localhost:3000'}/frontend/pages/dashboard.html" style="background:#131218;color:#F3EFE6;padding:13px 30px;text-decoration:none;font-size:14px;font-weight:600;border-radius:9px;display:inline-block;font-family:Arial,sans-serif;">View in Dashboard →</a>
        </div>
      </div>

      <p style="text-align:center;margin-top:18px;font-size:11px;color:#a39d90;font-family:Arial,sans-serif;letter-spacing:0.3px;">Powered by Kuja · Brisbane, Australia</p>
    </div>`;

  const payload = JSON.stringify({
    from: 'Kuja AI <info@kujaai.com>',
    to: [agentEmail],
    subject: `Follow up with ${leadName} — no response yet`,
    html
  });

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: 'api.resend.com',
      path: '/emails',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.SMTP_PASS}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          console.log(`✅ Agent reminder sent to ${agentEmail} for ${leadName}`);
          resolve(data);
        } else {
          console.error(`❌ Resend API error ${res.statusCode}:`, data);
          reject(new Error(`Resend API error: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', (e) => {
      console.error('❌ Email request failed:', e.message);
      reject(e);
    });
    req.write(payload);
    req.end();
  });
}

module.exports = { sendLeadNotification, sendBookingConfirmation, sendLeadFollowup, sendAgentReminder };
