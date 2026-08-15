const express = require('express');
const router = express.Router();
const { v4: uuidv4 } = require('uuid');
const { google } = require('googleapis');
const { db } = require('../db');
const { clientAuth } = require('../middleware/auth');
const { getValidToken, getHours } = require('./calendar');

const READ_TOOLS = new Set([
  'search_leads',
  'get_lead_details',
  'get_listing_details',
  'check_availability',
]);

const WRITE_TOOLS = new Set([
  'add_listing',
  'edit_listing',
  'block_calendar_time',
  'mark_lead_read',
  'cancel_booking',
  'update_listing_status',
]);

const LISTING_STATUSES = ['active', 'sold', 'under_offer', 'withdrawn'];

const SYSTEM_PROMPT =
  'You are an internal assistant for a real estate agent using the Kuja AI dashboard, helping them manage their listings, calendar, and leads through natural language.\n\n' +
  'You have read tools (search_leads, get_lead_details, get_listing_details, check_availability) that look up information — use these when the agent asks about leads, listings, or open calendar slots.\n\n' +
  'You have write tools that change data:\n' +
  '- add_listing / edit_listing — manage property listings\n' +
  '- block_calendar_time — block time on the calendar\n' +
  '- mark_lead_read — mark a lead as read\n' +
  '- cancel_booking — cancel an existing booking (and its Google Calendar event)\n' +
  '- update_listing_status — set a listing to active, sold, under_offer, or withdrawn\n\n' +
  'Always use the appropriate tool when the agent asks you to do something — don\'t just describe what you\'d do. ' +
  'If a request is ambiguous (missing a date, unclear which lead or listing, or multiple matches returned), ask a clarifying question instead of guessing — never pick a record at random. ' +
  'When tool results include multiple matches, present them clearly and ask which one the agent meant. ' +
  'Keep your text responses short and direct.';

const TOOLS = [
  {
    name: 'search_leads',
    description: 'Search the agent\'s leads by name, email, phone, or transcript text.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search term' },
      },
      required: ['query'],
    },
  },
  {
    name: 'get_lead_details',
    description: 'Get full details for a lead by name (partial match).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Lead name or partial name' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_listing_details',
    description: 'Get full details for a listing by address (partial match).',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Street address or partial address' },
      },
      required: ['address'],
    },
  },
  {
    name: 'check_availability',
    description: 'Check free booking slots on a given date.',
    input_schema: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'Date in YYYY-MM-DD format' },
      },
      required: ['date'],
    },
  },
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
  {
    name: 'cancel_booking',
    description: 'Cancel an existing booking by lead name and/or date.',
    input_schema: {
      type: 'object',
      properties: {
        lead_name: { type: 'string', description: 'Name on the booking (partial match)' },
        date: { type: 'string', description: 'Booking date in YYYY-MM-DD format' },
      },
    },
  },
  {
    name: 'update_listing_status',
    description: 'Update a listing\'s status (active, sold, under_offer, withdrawn).',
    input_schema: {
      type: 'object',
      properties: {
        address: { type: 'string', description: 'Listing address (partial match)' },
        status: { type: 'string', enum: LISTING_STATUSES, description: 'New status' },
      },
      required: ['address', 'status'],
    },
  },
];

function brisbaneIso(date, time) {
  return new Date(`${date}T${time}:00+10:00`).toISOString();
}

function likePattern(value) {
  return '%' + value + '%';
}

function searchLeads(clientId, input) {
  const query = (input.query || '').trim();
  if (!query) throw new Error('query is required');
  const pattern = likePattern(query);
  const leads = db.prepare(`
    SELECT id, name, phone, email, created_at, read_at
    FROM leads
    WHERE client_id = ?
      AND (
        name LIKE ? COLLATE NOCASE
        OR email LIKE ? COLLATE NOCASE
        OR phone LIKE ? COLLATE NOCASE
        OR transcript LIKE ? COLLATE NOCASE
      )
    ORDER BY created_at DESC
    LIMIT 10
  `).all(clientId, pattern, pattern, pattern, pattern);
  return { leads, count: leads.length };
}

function getLeadDetails(clientId, input) {
  const name = (input.name || '').trim();
  if (!name) throw new Error('name is required');
  const leads = db.prepare(`
    SELECT *
    FROM leads
    WHERE client_id = ?
      AND name LIKE ? COLLATE NOCASE
    ORDER BY created_at DESC
    LIMIT 10
  `).all(clientId, likePattern(name));
  if (!leads.length) return { found: false, leads: [] };
  return { found: true, count: leads.length, leads };
}

function getListingDetails(clientId, input) {
  const address = (input.address || '').trim();
  if (!address) throw new Error('address is required');
  const listings = db.prepare(`
    SELECT *
    FROM listings
    WHERE client_id = ?
      AND address LIKE ? COLLATE NOCASE
    ORDER BY created_at DESC
    LIMIT 10
  `).all(clientId, likePattern(address));
  if (!listings.length) return { found: false, listings: [] };
  return { found: true, count: listings.length, listings };
}

async function checkAvailability(clientId, input) {
  const date = (input.date || '').trim();
  if (!date) throw new Error('date is required');
  const client = db.prepare('SELECT * FROM clients WHERE id = ?').get(clientId);
  if (!client) throw new Error('Client not found');

  const hours = getHours(client);
  const day = new Date(date + 'T00:00:00');
  if (!hours.days.includes(day.getDay())) {
    return { date, slots: [], slotMinutes: hours.slotMinutes, message: 'Not a working day for bookings' };
  }

  const oauth2 = await getValidToken(clientId);
  if (!oauth2) throw new Error('Google Calendar is not connected');

  const dayStart = new Date(date + 'T' + hours.start + ':00+10:00');
  const dayEnd = new Date(date + 'T' + hours.end + ':00+10:00');
  const calendar = google.calendar({ version: 'v3', auth: oauth2 });
  const fb = await calendar.freebusy.query({
    requestBody: { timeMin: dayStart.toISOString(), timeMax: dayEnd.toISOString(), items: [{ id: 'primary' }] },
  });
  const busy = (fb.data.calendars.primary.busy || []).map(b => ({ start: new Date(b.start), end: new Date(b.end) }));

  const slots = [];
  let cursor = new Date(dayStart);
  while (cursor < dayEnd) {
    const slotEnd = new Date(cursor.getTime() + hours.slotMinutes * 60000);
    const overlapsBusy = busy.some(b => cursor < b.end && slotEnd > b.start);
    const isPast = cursor < new Date();
    if (!overlapsBusy && !isPast) slots.push(cursor.toISOString());
    cursor = slotEnd;
  }
  return { date, slots, slotMinutes: hours.slotMinutes };
}

function findMatchingBookings(clientId, input) {
  const leadName = (input.lead_name || '').trim();
  const date = (input.date || '').trim();
  if (!leadName && !date) throw new Error('At least one of lead_name or date is required');

  let sql = 'SELECT id, lead_name, lead_email, lead_phone, start_time, end_time, google_event_id FROM bookings WHERE client_id = ?';
  const params = [clientId];

  if (leadName && date) {
    sql += ' AND lead_name LIKE ? COLLATE NOCASE AND date(start_time) = date(?)';
    params.push(likePattern(leadName), date);
  } else if (leadName) {
    sql += ' AND lead_name LIKE ? COLLATE NOCASE';
    params.push(likePattern(leadName));
  } else {
    sql += ' AND date(start_time) = date(?)';
    params.push(date);
  }

  sql += ' ORDER BY start_time ASC LIMIT 10';
  return db.prepare(sql).all(...params);
}

function findMatchingListingsByAddress(clientId, address) {
  return db.prepare(`
    SELECT id, address, suburb, price, status, bedrooms, bathrooms, property_type
    FROM listings
    WHERE client_id = ?
      AND address LIKE ? COLLATE NOCASE
    ORDER BY created_at DESC
    LIMIT 10
  `).all(clientId, likePattern(address));
}

function prepareCancelBookingProposal(clientId, input) {
  const matches = findMatchingBookings(clientId, input);
  if (!matches.length) {
    return { status: 'not_found', message: 'No matching bookings found', matches: [] };
  }
  if (matches.length > 1) {
    return { status: 'multiple', message: 'Multiple bookings match — ask the agent which one to cancel', matches };
  }
  const booking = matches[0];
  return {
    status: 'ready',
    proposalInput: {
      booking_id: booking.id,
      lead_name: booking.lead_name,
      start_time: booking.start_time,
      end_time: booking.end_time,
    },
    booking,
  };
}

function prepareUpdateListingStatusProposal(clientId, input) {
  const address = (input.address || '').trim();
  const status = (input.status || '').trim();
  if (!address) throw new Error('address is required');
  if (!LISTING_STATUSES.includes(status)) throw new Error('status must be one of: ' + LISTING_STATUSES.join(', '));

  const matches = findMatchingListingsByAddress(clientId, address);
  if (!matches.length) {
    return { status: 'not_found', message: 'No matching listings found', listings: [] };
  }
  if (matches.length > 1) {
    return { status: 'multiple', message: 'Multiple listings match — ask the agent which one to update', listings: matches };
  }
  const listing = matches[0];
  return {
    status: 'ready',
    proposalInput: {
      listing_id: listing.id,
      address: listing.address,
      status,
      previous_status: listing.status,
    },
    listing,
  };
}

async function runReadTool(clientId, tool, input) {
  switch (tool) {
    case 'search_leads':
      return searchLeads(clientId, input);
    case 'get_lead_details':
      return getLeadDetails(clientId, input);
    case 'get_listing_details':
      return getListingDetails(clientId, input);
    case 'check_availability':
      return await checkAvailability(clientId, input);
    default:
      throw new Error('Unknown read tool: ' + tool);
  }
}

async function resolveWriteTool(clientId, tool, input) {
  if (tool === 'cancel_booking') {
    return prepareCancelBookingProposal(clientId, input);
  }
  if (tool === 'update_listing_status') {
    return prepareUpdateListingStatusProposal(clientId, input);
  }
  return { status: 'ready', proposalInput: input };
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

async function cancelBooking(clientId, input) {
  const booking = db.prepare('SELECT * FROM bookings WHERE id = ? AND client_id = ?').get(input.booking_id, clientId);
  if (!booking) throw new Error('Booking not found');

  if (booking.google_event_id) {
    const oauth2 = await getValidToken(clientId);
    if (!oauth2) throw new Error('Google Calendar is not connected — cannot cancel the calendar event');
    const calendar = google.calendar({ version: 'v3', auth: oauth2 });
    try {
      await calendar.events.delete({ calendarId: 'primary', eventId: booking.google_event_id });
    } catch (e) {
      if (e.code !== 404 && e.response?.status !== 404) throw e;
    }
  }

  db.prepare('DELETE FROM bookings WHERE id = ?').run(booking.id);
  return {
    summary: `Cancelled booking: ${booking.lead_name} (${booking.start_time})`,
    bookingId: booking.id,
  };
}

function updateListingStatus(clientId, input) {
  const listing = db.prepare('SELECT * FROM listings WHERE id = ? AND client_id = ?').get(input.listing_id, clientId);
  if (!listing) throw new Error('Listing not found');
  if (!LISTING_STATUSES.includes(input.status)) {
    throw new Error('status must be one of: ' + LISTING_STATUSES.join(', '));
  }
  db.prepare('UPDATE listings SET status = ? WHERE id = ?').run(input.status, input.listing_id);
  return { summary: `Updated ${listing.address} to ${input.status}`, listing: { ...listing, status: input.status } };
}

async function executeTool(clientId, tool, input) {
  switch (tool) {
    case 'add_listing':
      return addListing(clientId, input);
    case 'edit_listing':
      return editListing(clientId, input);
    case 'block_calendar_time':
      return blockCalendarTime(clientId, input);
    case 'mark_lead_read':
      return markLeadRead(clientId, input);
    case 'cancel_booking':
      return await cancelBooking(clientId, input);
    case 'update_listing_status':
      return updateListingStatus(clientId, input);
    default:
      throw new Error('Unknown tool: ' + tool);
  }
}

async function callAnthropic(messages) {
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
      messages,
      tools: TOOLS,
    }),
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error?.message || 'Assistant request failed');
  }
  return data;
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

    let messages = [...prior.map(m => ({ role: m.role, content: m.content })), { role: 'user', content: message }];

    for (let step = 0; step < 8; step++) {
      const data = await callAnthropic(messages);
      const blocks = data.content || [];
      const toolUse = blocks.find(b => b.type === 'tool_use');
      const textParts = blocks.filter(b => b.type === 'text').map(b => b.text).join('\n').trim();

      if (!toolUse) {
        return res.json({
          type: 'text',
          message: textParts || "I couldn't generate a response — try rephrasing that.",
        });
      }

      const toolName = toolUse.name;
      const toolInput = toolUse.input || {};

      if (READ_TOOLS.has(toolName)) {
        let result;
        try {
          result = await runReadTool(req.clientId, toolName, toolInput);
        } catch (e) {
          result = { error: e.message };
        }
        messages.push({ role: 'assistant', content: blocks });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(result) }],
        });
        continue;
      }

      if (WRITE_TOOLS.has(toolName)) {
        let resolved;
        try {
          resolved = await resolveWriteTool(req.clientId, toolName, toolInput);
        } catch (e) {
          messages.push({ role: 'assistant', content: blocks });
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify({ error: e.message }) }],
          });
          continue;
        }

        if (resolved.status === 'multiple' || resolved.status === 'not_found') {
          messages.push({ role: 'assistant', content: blocks });
          messages.push({
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: JSON.stringify(resolved) }],
          });
          continue;
        }

        return res.json({
          type: 'proposal',
          tool: toolName,
          input: resolved.proposalInput,
          message: textParts || null,
        });
      }

      return res.status(400).json({ error: 'Unknown tool: ' + toolName });
    }

    return res.status(502).json({ error: 'Assistant took too many steps — try a simpler request.' });
  } catch (e) {
    console.error('❌ /assistant/chat failed:', e);
    res.status(500).json({ error: e.message || 'Something went wrong with the assistant.' });
  }
});

router.post('/execute', clientAuth, async (req, res) => {
  try {
    const { tool, input } = req.body;
    if (!tool || !input) return res.status(400).json({ error: 'tool and input are required' });
    if (!WRITE_TOOLS.has(tool)) return res.status(400).json({ error: 'Tool cannot be executed: ' + tool });
    const result = await executeTool(req.clientId, tool, input);
    res.json({ success: true, ...result });
  } catch (e) {
    console.error('❌ /assistant/execute failed:', e);
    res.status(400).json({ error: e.message || 'Action failed' });
  }
});

module.exports = router;
