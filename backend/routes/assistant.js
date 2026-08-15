const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { db } = require('../db');
const { clientAuth } = require('../middleware/auth');

const SYSTEM_PROMPT =
  'You are an internal assistant for a real estate agent using the Kuja AI dashboard, helping them manage their listings, calendar, and leads through natural language. You have tools to add/edit listings, block out calendar time, and mark leads as read. Always use the appropriate tool when the agent asks you to do something — don\'t just describe what you\'d do. If a request is ambiguous (e.g. missing a date, or unclear which listing they mean), ask a clarifying question instead of guessing. Keep your text responses short and direct.';

const TOOLS = [
  {
    name: 'add_listing',
    description: 'Add a new property listing for this agent.',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address of the property' },
        price: { type: 'string', description: 'Price or price guide' },
        bedrooms: { type: 'integer', description: 'Number of bedrooms' },
        bathrooms: { type: 'integer', description: 'Number of bathrooms' },
        property_type: { type: 'string', description: 'e.g. house, unit, townhouse' },
        description: { type: 'string', description: 'Listing description' },
        url: { type: 'string', description: 'External listing URL' },
      },
      required: ['address'],
    },
  },
  {
    name: 'edit_listing',
    description: 'Update an existing property listing.',
    input_schema: {
      type: 'object',
      properties: {
        listing_id: { type: 'string', description: 'ID of the listing to edit' },
        address: { type: 'string' },
        price: { type: 'string' },
        bedrooms: { type: 'integer' },
        bathrooms: { type: 'integer' },
        property_type: { type: 'string' },
        description: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['listing_id'],
    },
  },
  {
    name: 'block_calendar_time',
    description: 'Block out calendar time so it cannot be booked.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
        start_time: { type: 'string', description: 'Start time in HH:MM (24h, Brisbane time)' },
        end_time: { type: 'string', description: 'End time in HH:MM (24h, Brisbane time)' },
        reason: { type: 'string', description: 'Reason for blocking, e.g. inspection' },
      },
      required: ['date', 'start_time', 'end_time'],
    },
  },
  {
    name: 'mark_lead_read',
    description: 'Mark a lead as read in the dashboard.',
    input_schema: {
      type: 'object',
      properties: {
        lead_id: { type: 'string', description: 'ID of the lead to mark as read' },
      },
      required: ['lead_id'],
    },
  },
];

function brisbaneIso(date, time) {
  return new Date(`${date}T${time}:00+10:00`).toISOString();
}

function addListing(clientId, input) {
  if (!input.address) throw new Error('address is required');
  const id = uuidv4();
  db.prepare(`
    INSERT INTO listings (id, client_id, address, suburb, price, bedrooms, bathrooms, property_type, description, url, image_url)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    clientId,
    input.address,
    null,
    input.price || null,
    input.bedrooms ?? null,
    input.bathrooms ?? null,
    input.property_type || null,
    input.description || null,
    input.url || null,
    null
  );
  const listing = db.prepare('SELECT * FROM listings WHERE id = ?').get(id);
  return { summary: `Added listing: ${listing.address}`, listing };
}

function editListing(clientId, input) {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND client_id = ?').get(input.listing_id, clientId);
  if (!listing) throw new Error('Listing not found');
  db.prepare(`
    UPDATE listings SET address=?, suburb=?, price=?, bedrooms=?, bathrooms=?, property_type=?, description=?, url=?, status=?, image_url=?
    WHERE id=?
  `).run(
    input.address ?? listing.address,
    listing.suburb,
    input.price ?? listing.price,
    input.bedrooms ?? listing.bedrooms,
    input.bathrooms ?? listing.bathrooms,
    input.property_type ?? listing.property_type,
    input.description ?? listing.description,
    input.url ?? listing.url,
    listing.status,
    listing.image_url,
    input.listing_id
  );
  const updated = db.prepare('SELECT * FROM listings WHERE id = ?').get(input.listing_id);
  return { summary: `Updated listing: ${updated.address}`, listing: updated };
}

function blockCalendarTime(clientId, input) {
  const { date, start_time, end_time, reason } = input;
  if (!date || !start_time || !end_time) throw new Error('date, start_time and end_time are required');
  const startIso = brisbaneIso(date, start_time);
  const endIso = brisbaneIso(date, end_time);
  const id = uuidv4();
  db.prepare(`
    INSERT INTO bookings (id, client_id, lead_name, lead_email, lead_phone, start_time, end_time, google_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    clientId,
    'Blocked — ' + (reason || 'agent'),
    null,
    null,
    startIso,
    endIso,
    null
  );
  return { summary: `Blocked ${date} ${start_time}–${end_time}${reason ? ' for: ' + reason : ''}`, bookingId: id };
}

function markLeadRead(clientId, input) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ? AND client_id = ?').get(input.lead_id, clientId);
  if (!lead) throw new Error('Lead not found');
  db.prepare('UPDATE leads SET read_at = CURRENT_TIMESTAMP WHERE id = ?').run(input.lead_id);
  return { summary: `Marked lead as read: ${lead.name || lead.email || lead.phone || input.lead_id}` };
}

function executeTool(clientId, tool, input) {
  switch (tool) {
    case 'add_listing':
      return addListing(clientId, input);
    case 'edit_listing':
      return editListing(clientId, input);
    case 'block_calendar_time':
      return blockCalendarTime(clientId, input);
    case 'mark_lead_read':
      return markLeadRead(clientId, input);
    default:
      throw new Error('Unknown tool: ' + tool);
  }
}

router.get('/settings', clientAuth, (req, res) => {
  const client = db.prepare('SELECT assistant_auto_confirm FROM clients WHERE id = ?').get(req.clientId);
  res.json({ assistant_auto_confirm: !!client?.assistant_auto_confirm });
});

router.patch('/settings', clientAuth, (req, res) => {
  const enabled = req.body.assistant_auto_confirm ? 1 : 0;
  db.prepare('UPDATE clients SET assistant_auto_confirm = ? WHERE id = ?').run(enabled, req.clientId);
  res.json({ success: true, assistant_auto_confirm: !!enabled });
});

router.post('/chat', clientAuth, async (req, res) => {
  try {
    const { message, history } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'message is required' });
    }
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Assistant is not configured (missing API key)' });
    }

    const prior = Array.isArray(history)
      ? history.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
      : [];

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [...prior, { role: 'user', content: message }],
        tools: TOOLS,
      }),
    });

    const data = await response.json();
    if (!response.ok) {
      console.error('Anthropic API error:', data);
      return res.status(502).json({ error: data.error?.message || 'Assistant request failed' });
    }

    const blocks = data.content || [];
    const toolUse = blocks.find(b => b.type === 'tool_use');
    const textParts = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

    if (toolUse) {
      return res.json({
        type: 'proposal',
        tool: toolUse.name,
        input: toolUse.input,
        message: textParts || null,
      });
    }

    return res.json({
      type: 'text',
      message: textParts || "I couldn't generate a response — try rephrasing that.",
    });
  } catch (e) {
    console.error('❌ /assistant/chat failed:', e);
    res.status(500).json({ error: 'Something went wrong with the assistant.' });
  }
});

router.post('/execute', clientAuth, async (req, res) => {
  try {
    const { tool, input } = req.body;
    if (!tool || !input) return res.status(400).json({ error: 'tool and input are required' });
    const result = executeTool(req.clientId, tool, input);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('❌ /assistant/execute failed:', e);
    res.status(400).json({ error: e.message || 'Action failed' });
  }
});

module.exports = router;
