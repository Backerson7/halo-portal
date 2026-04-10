const NOTION_TOKEN = process.env.NOTION_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VA_EMAIL = process.env.VA_EMAIL || 'bo@halo-hospitality.com';

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } 
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pageId, ownerName, address, portalToken, message } = body;
  if (!pageId || !message) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };

  const results = { notion: false, email: false };

  // ── STEP 1: Write message to Notion Notes field ──────────────────────────
  try {
    const timestamp = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
    const newNote = `[${timestamp}] Owner message: ${message}`;

    // First get current notes
    const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28' }
    });
    const pageData = await getResp.json();
    const existingNotes = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
    const updatedNotes = existingNotes ? `${existingNotes}\n${newNote}` : newNote;

    // Update the Notes field
    const updateResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          Notes: { rich_text: [{ type: 'text', text: { content: updatedNotes.substring(0, 2000) } }] }
        }
      })
    });
    if (updateResp.ok) results.notion = true;
  } catch (err) {
    console.error('Notion error:', err.message);
  }

  // ── STEP 2: Send email via Resend ────────────────────────────────────────
  try {
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Halo Owner Portal <portal@portal.halo-hospitality.com>',
        to: VA_EMAIL,
        subject: `Portal message from ${ownerName} — ${address}`,
        html: `
          <div style="font-family: sans-serif; max-width: 600px; margin: 0 auto;">
            <div style="background: #1C1F26; padding: 24px; border-radius: 8px 8px 0 0;">
              <p style="color: #C9A96E; font-size: 12px; letter-spacing: 0.1em; text-transform: uppercase; margin: 0 0 8px;">Halo Hospitality — Owner Portal</p>
              <h2 style="color: #ffffff; margin: 0;">New message from ${ownerName}</h2>
            </div>
            <div style="background: #f9f9f7; padding: 24px; border-radius: 0 0 8px 8px; border: 1px solid #e8e6e0;">
              <p style="margin: 0 0 8px; color: #888; font-size: 13px;">Property</p>
              <p style="margin: 0 0 20px; font-weight: 500;">${address}</p>
              <p style="margin: 0 0 8px; color: #888; font-size: 13px;">Message</p>
              <div style="background: white; border: 1px solid #e0ddd8; border-radius: 6px; padding: 16px;">
                <p style="margin: 0; line-height: 1.6;">${message}</p>
              </div>
              <div style="margin-top: 24px; padding-top: 16px; border-top: 1px solid #e8e6e0;">
                <a href="https://www.notion.so/${pageId.replace(/-/g, '')}" style="background: #1C1F26; color: #C9A96E; padding: 10px 20px; border-radius: 6px; text-decoration: none; font-size: 13px; font-weight: 500;">View in Notion →</a>
              </div>
            </div>
          </div>
        `
      })
    });
    if (emailResp.ok) results.email = true;
  } catch (err) {
    console.error('Email error:', err.message);
  }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...results }) };
};
