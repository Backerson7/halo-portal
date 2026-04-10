const NOTION_TOKEN = process.env.NOTION_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VA_EMAIL = process.env.VA_EMAIL || 'bo@halo-hospitality.com';

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); }
  catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { pageId, ownerName, address, approvalType } = body;
  if (!pageId || !approvalType) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };

  const now = new Date().toISOString().split('T')[0];
  const nowDisplay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' });
  const nh = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  const fieldMap = {
    'work_order':        { field: 'Work Order Approved',           label: 'Onboarding Work Order' },
    'mgmt_agreement':    { field: 'Management Agreement Signed',   label: 'Management Agreement' },
    'insurance':         { field: 'Insurance Uploaded',            label: 'Insurance Certificate' },
    'compliance':        { field: 'Compliance Uploaded',           label: 'Compliance Documents' },
  };

  const mapping = fieldMap[approvalType];
  if (!mapping) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown approval type' }) };

  const results = { notion: false, email: false };

  try {
    // Update the approval date field
    const updateResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers: nh,
      body: JSON.stringify({ properties: { [mapping.field]: { date: { start: now } } } })
    });

    if (updateResp.ok) {
      results.notion = true;
      // Append to Notes
      const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh });
      const pageData = await getResp.json();
      const existing = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
      const note = `[${nowDisplay}] ✅ ${mapping.label} — completed by owner via portal`;
      const updated = existing ? `${existing}\n${note}` : note;
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nh,
        body: JSON.stringify({ properties: { Notes: { rich_text: [{ type: 'text', text: { content: updated.substring(0, 2000) } }] } } })
      });
    }
  } catch (err) { console.error('Notion error:', err.message); }

  try {
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Halo Owner Portal <portal@portal.halo-hospitality.com>',
        to: VA_EMAIL,
        subject: `✅ ${mapping.label} completed — ${ownerName}, ${address}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1C1F26;padding:24px;border-radius:8px 8px 0 0">
              <p style="color:#C9A96E;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 8px">Halo Hospitality — Owner Portal</p>
              <h2 style="color:#fff;margin:0">✅ ${mapping.label} Completed</h2>
            </div>
            <div style="background:#f9f9f7;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e8e6e0">
              <p style="margin:0 0 4px;color:#888;font-size:13px">Owner</p><p style="margin:0 0 16px;font-weight:500">${ownerName}</p>
              <p style="margin:0 0 4px;color:#888;font-size:13px">Property</p><p style="margin:0 0 16px;font-weight:500">${address}</p>
              <p style="margin:0 0 4px;color:#888;font-size:13px">Completed</p><p style="margin:0 0 24px">${nowDisplay} · Via owner portal</p>
              <a href="https://www.notion.so/${pageId.replace(/-/g,'')}" style="background:#1C1F26;color:#C9A96E;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500">View in Notion →</a>
            </div>
          </div>`
      })
    });
    if (emailResp.ok) results.email = true;
  } catch (err) { console.error('Email error:', err.message); }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...results }) };
};
