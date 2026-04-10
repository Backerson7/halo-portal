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

  const { pageId, ownerName, address, formData } = body;
  if (!pageId || !formData) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };

  const now = new Date().toISOString().split('T')[0];
  const nowDisplay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' });
  const nh = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  // Format the property details as organized text
  const formatted = `
PROPERTY DETAILS — Submitted ${nowDisplay}
─────────────────────────────────────────

PROPERTY INFORMATION
Property Address: ${formData.propertyAddress || '—'}
Property Type: ${formData.propertyType || '—'}
Year Built: ${formData.yearBuilt || '—'}
Square Footage: ${formData.squareFootage || '—'}
Bedrooms: ${formData.bedrooms || '—'}
Bathrooms: ${formData.bathrooms || '—'}
Max Occupancy: ${formData.maxOccupancy || '—'}
Parking Details: ${formData.parking || '—'}

ACCESS INFORMATION
Lockbox / Door Code: ${formData.accessCode || '—'}
Gate Code: ${formData.gateCode || '—'}
Parking Instructions: ${formData.parkingInstructions || '—'}
Trash / Recycling Notes: ${formData.trashNotes || '—'}

PRIMARY CONTACT
Name: ${formData.primaryContactName || '—'}
Phone: ${formData.primaryContactPhone || '—'}
Email: ${formData.primaryContactEmail || '—'}
Preferred Contact Method: ${formData.preferredContact || '—'}

EMERGENCY CONTACT
Name: ${formData.emergencyContactName || '—'}
Phone: ${formData.emergencyContactPhone || '—'}
Relationship: ${formData.emergencyRelationship || '—'}

OWNER INFORMATION
Owner Email(s): ${formData.ownerEmails || '—'}
Owner Mailing Address: ${formData.ownerMailingAddress || '—'}

UTILITIES & SERVICES
Electric Provider: ${formData.electricProvider || '—'}
Gas Provider: ${formData.gasProvider || '—'}
Water Provider: ${formData.waterProvider || '—'}
Internet / WiFi Provider: ${formData.wifiProvider || '—'}
WiFi Network Name: ${formData.wifiName || '—'}
WiFi Password: ${formData.wifiPassword || '—'}
Trash Pickup Day: ${formData.trashDay || '—'}
HOA (if applicable): ${formData.hoa || '—'}

APPLIANCES & SYSTEMS
HVAC / Thermostat Notes: ${formData.hvacNotes || '—'}
Washer / Dryer Notes: ${formData.laundryNotes || '—'}
Other Appliance Notes: ${formData.applianceNotes || '—'}

PETS & RESTRICTIONS
Pets Allowed: ${formData.petsAllowed || '—'}
Pet Policy Notes: ${formData.petNotes || '—'}
Smoking Policy: ${formData.smokingPolicy || '—'}
Any Other House Rules: ${formData.houseRules || '—'}

OTHER NOTES
${formData.otherNotes || '—'}
`.trim();

  const results = { notion: false, email: false };

  try {
    const updateResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers: nh,
      body: JSON.stringify({
        properties: {
          'Property Details': { rich_text: [{ type: 'text', text: { content: formatted.substring(0, 2000) } }] },
          'Property Details Submitted': { date: { start: now } }
        }
      })
    });
    if (updateResp.ok) results.notion = true;
  } catch (err) { console.error('Notion error:', err.message); }

  try {
    const emailResp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'Halo Owner Portal <portal@portal.halo-hospitality.com>',
        to: VA_EMAIL,
        subject: `📋 Property details submitted — ${ownerName}, ${address}`,
        html: `
          <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
            <div style="background:#1C1F26;padding:24px;border-radius:8px 8px 0 0">
              <p style="color:#C9A96E;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 8px">Halo Hospitality — Owner Portal</p>
              <h2 style="color:#fff;margin:0">📋 Property Details Submitted</h2>
            </div>
            <div style="background:#f9f9f7;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e8e6e0">
              <p style="margin:0 0 4px;color:#888;font-size:13px">Owner</p>
              <p style="margin:0 0 16px;font-weight:500">${ownerName}</p>
              <p style="margin:0 0 4px;color:#888;font-size:13px">Property</p>
              <p style="margin:0 0 16px;font-weight:500">${address}</p>
              <p style="margin:0 0 4px;color:#888;font-size:13px">Submitted</p>
              <p style="margin:0 0 24px">${nowDisplay}</p>
              <pre style="background:#f0ede6;border-radius:6px;padding:16px;font-size:12px;line-height:1.6;white-space:pre-wrap;overflow-x:auto">${formatted}</pre>
              <div style="margin-top:24px;padding-top:16px;border-top:1px solid #e8e6e0">
                <a href="https://www.notion.so/${pageId.replace(/-/g,'')}" style="background:#1C1F26;color:#C9A96E;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500">View in Notion →</a>
              </div>
            </div>
          </div>`
      })
    });
    if (emailResp.ok) results.email = true;
  } catch (err) { console.error('Email error:', err.message); }

  return { statusCode: 200, headers, body: JSON.stringify({ success: true, ...results }) };
};
