const https = require('https');

async function sendLeadNotification({ clientEmail, agencyName, lead }) {
  const platformUrl = process.env.PLATFORM_URL || 'http://localhost:3000';
  
  const transcriptHtml = lead.transcript
    ? lead.transcript.split('\n').filter(l => l.trim()).map(line => {
        if (line.startsWith('Visitor:')) return `<p style="margin:4px 0"><strong style="color:#0d0d0d">${line}</strong></p>`;
        if (line.startsWith('Bot:')) return `<p style="margin:4px 0;color:#6b6560">${line}</p>`;
        return `<p style="margin:4px 0;color:#aaa;font-size:12px">${line}</p>`;
      }).join('')
    : '<p style="color:#aaa">No transcript available</p>';

  const html = `
    <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;background:#f5f0e8;padding:40px 20px">
      <div style="background:#0d0d0d;padding:24px 32px;margin-bottom:0">
        <h1 style="margin:0;color:#f5f0e8;font-size:20px;font-weight:700">New Lead Captured</h1>
        <p style="margin:6px 0 0;color:#c9a84c;font-size:13px;letter-spacing:2px;text-transform:uppercase">${agencyName}</p>
      </div>
      <div style="background:#ffffff;padding:28px 32px;border:1px solid rgba(201,168,76,0.2)">
        ${lead.name ? `<p style="margin:0 0 10px"><span style="color:#6b6560;font-size:12px;text-transform:uppercase;letter-spacing:1px">Name</span><br><strong style="font-size:16px">${lead.name}</strong></p>` : ''}
        ${lead.phone ? `<p style="margin:0 0 10px"><span style="color:#6b6560;font-size:12px;text-transform:uppercase;letter-spacing:1px">Phone</span><br><a href="tel:${lead.phone}" style="color:#c9a84c;font-size:15px">${lead.phone}</a></p>` : ''}
        ${lead.email ? `<p style="margin:0 0 10px"><span style="color:#6b6560;font-size:12px;text-transform:uppercase;letter-spacing:1px">Email</span><br><a href="mailto:${lead.email}" style="color:#c9a84c;font-size:15px">${lead.email}</a></p>` : ''}
        <p style="margin:0 0 20px"><span style="color:#6b6560;font-size:12px;text-transform:uppercase;letter-spacing:1px">Captured</span><br><span style="font-size:14px">${new Date(lead.created_at).toLocaleString('en-AU', { timeZone: 'Australia/Brisbane' })}</span></p>
        <div style="background:#f5f0e8;padding:16px;border-left:3px solid #c9a84c;font-size:13px;line-height:1.6">${transcriptHtml}</div>
        <div style="text-align:center;margin-top:24px">
          <a href="${platformUrl}/frontend/pages/dashboard.html" style="background:#0d0d0d;color:#f5f0e8;padding:12px 28px;text-decoration:none;font-size:14px;font-weight:500">View in Dashboard →</a>
        </div>
      </div>
      <p style="text-align:center;margin-top:16px;font-size:11px;color:#aaa">Powered by Kuja AI · Brisbane, Australia</p>
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

module.exports = { sendLeadNotification };
