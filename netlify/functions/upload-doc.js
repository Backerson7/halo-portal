const NOTION_TOKEN = process.env.NOTION_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VA_EMAIL = process.env.VA_EMAIL || 'bo@halo-hospitality.com';
const GDRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;
// Load service account from bundled file (avoids Lambda 4KB env var limit)
const SA = (() => {
  try {
    return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'service-account.json'), 'utf8'));
  } catch(e) {
    console.error('Failed to load service-account.json:', e.message);
    return {};
  }
})();
const SERVICE_EMAIL = SA.client_email;
const PRIVATE_KEY = SA.private_key;

const NOTION_FIELD_MAP = {
  'insurance':      'Insurance Upload',
  'county_license': 'County License Upload',
  'city_license':   'City License Upload',
  'str_permit':     'STR Permit Upload',
};

// ── Google JWT auth ──────────────────────────────────────────────────────────
async function getGoogleToken() {
  const crypto = require('crypto');
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    iss: SERVICE_EMAIL,
    scope: 'https://www.googleapis.com/auth/drive',
    aud: 'https://oauth2.googleapis.com/token',
    exp: now + 3600,
    iat: now
  })).toString('base64url');

  const sign = crypto.createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(PRIVATE_KEY, 'base64url');
  const jwt = `${header}.${payload}.${sig}`;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  if (!data.access_token) throw new Error('Token error: ' + JSON.stringify(data));
  return data.access_token;
}

// ── Upload file to Google Drive ──────────────────────────────────────────────
async function uploadToDrive(token, fileData, filename, mimeType, ownerName, label) {
  // Create subfolder structure: Halo Owner Documents / OwnerName / label
  const subfolderName = `${ownerName} — ${label}`;

  // Build multipart body for Drive upload
  const boundary = 'HaloDriveBoundary';
  const metadata = JSON.stringify({
    name: filename,
    parents: [GDRIVE_FOLDER_ID],
    description: `Uploaded via owner portal — ${label}`,
    writersCanShare: true
  });

  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n`),
    Buffer.from(`--${boundary}\r\nContent-Type: ${mimeType || 'application/octet-stream'}\r\n\r\n`),
    fileData,
    Buffer.from(`\r\n--${boundary}--`)
  ]);

  const resp = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink&supportsAllDrives=true', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body
  });
  const data = await resp.json();
  if (data.error) throw new Error('Drive upload error: ' + JSON.stringify(data.error));

  // Transfer ownership to Bo so file counts against his quota, not service account
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?transferOwnership=true&supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'owner', type: 'user', emailAddress: 'bo@halo-hospitality.com' })
  });

  // Also make publicly readable
  await fetch(`https://www.googleapis.com/drive/v3/files/${data.id}/permissions?supportsAllDrives=true`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ role: 'reader', type: 'anyone' })
  });

  return data.webViewLink || `https://drive.google.com/file/d/${data.id}/view`;
}

// ── Main handler ─────────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const contentType = event.headers['content-type'] || '';
    const boundary = contentType.split('boundary=')[1]?.split(';')[0]?.trim();
    if (!boundary) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No boundary' }) };

    const bodyBuffer = Buffer.from(event.body, event.isBase64Encoded ? 'base64' : 'binary');
    const parts = parseMultipart(bodyBuffer, boundary);

    const field     = parts.fields?.field;
    const pageId    = parts.fields?.pageId;
    const ownerName = parts.fields?.ownerName || 'Owner';
    const address   = parts.fields?.address || '';
    const label     = parts.fields?.label || field;
    const file      = parts.files?.file;

    if (!field || !pageId || !file) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const nh = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
    const notionField = NOTION_FIELD_MAP[field];
    let fileUrl = null;

    // ── Upload to Google Drive ───────────────────────────────────────────────
    try {
      const token = await getGoogleToken();
      fileUrl = await uploadToDrive(token, file.data, file.filename, file.contentType, ownerName, label);
      console.log('Drive upload success:', fileUrl);
    } catch(e) {
      console.error('Drive upload error:', e.message);
    }

    // ── Update Notion ────────────────────────────────────────────────────────
    if (notionField && fileUrl) {
      try {
        await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
          method: 'PATCH', headers: nh,
          body: JSON.stringify({
            properties: {
              [notionField]: {
                files: [{ type: 'external', name: file.filename, external: { url: fileUrl } }]
              }
            }
          })
        });
      } catch(e) { console.error('Notion field error:', e.message); }
    }

    // Always log to Notes
    try {
      const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh });
      const pageData = await getResp.json();
      const existing = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
      const note = fileUrl
        ? `[${ts}] 📎 Owner uploaded: ${label} — ${file.filename}`
        : `[${ts}] 📎 Owner upload attempt: ${label} — ${file.filename} (failed)`;
      const updated = existing ? `${existing}\n${note}` : note;
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nh,
        body: JSON.stringify({ properties: { Notes: { rich_text: [{ type: 'text', text: { content: updated.substring(0, 2000) } }] } } })
      });
    } catch(e) { console.error('Notes error:', e.message); }

    // ── Send email ───────────────────────────────────────────────────────────
    try {
      const nowDisplay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' });
      await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: 'Halo Owner Portal <portal@portal.halo-hospitality.com>',
          to: VA_EMAIL,
          subject: `📎 Document uploaded — ${label} | ${ownerName}, ${address}`,
          html: `
            <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
              <div style="background:#1C1F26;padding:24px;border-radius:8px 8px 0 0">
                <p style="color:#C9A96E;font-size:12px;letter-spacing:0.1em;text-transform:uppercase;margin:0 0 8px">Halo Hospitality — Owner Portal</p>
                <h2 style="color:#fff;margin:0">📎 Document Uploaded</h2>
              </div>
              <div style="background:#f9f9f7;padding:24px;border-radius:0 0 8px 8px;border:1px solid #e8e6e0">
                <p style="margin:0 0 4px;color:#888;font-size:13px">Owner</p><p style="margin:0 0 16px;font-weight:500">${ownerName}</p>
                <p style="margin:0 0 4px;color:#888;font-size:13px">Property</p><p style="margin:0 0 16px;font-weight:500">${address}</p>
                <p style="margin:0 0 4px;color:#888;font-size:13px">Document</p><p style="margin:0 0 16px;font-weight:500">${label}</p>
                <p style="margin:0 0 4px;color:#888;font-size:13px">File</p><p style="margin:0 0 ${fileUrl?'16px':'0'}">${file.filename}</p>
                ${fileUrl ? `<a href="${fileUrl}" style="display:inline-block;background:#1C1F26;color:#C9A96E;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;margin-top:8px">View in Google Drive ↗</a>` : ''}
              </div>
            </div>`
        })
      });
    } catch(e) { console.error('Email error:', e.message); }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: fileUrl ? 'google_drive' : 'notion_only', url: fileUrl }) };

  } catch(err) {
    console.error('Handler error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Multipart parser ─────────────────────────────────────────────────────────
function parseMultipart(buffer, boundary) {
  const fields = {}, files = {};
  const sep = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buffer.length) {
    const start = indexOf(buffer, sep, pos);
    if (start === -1) break;
    pos = start + sep.length;
    if (buffer[pos] === 45 && buffer[pos+1] === 45) break;
    if (buffer[pos] === 13) pos += 2;
    const hEnd = indexOf(buffer, Buffer.from('\r\n\r\n'), pos);
    if (hEnd === -1) break;
    const hStr = buffer.slice(pos, hEnd).toString('utf8');
    pos = hEnd + 4;
    const nextSep = indexOf(buffer, sep, pos);
    const dataEnd = nextSep === -1 ? buffer.length : nextSep - 2;
    const data = buffer.slice(pos, dataEnd);
    pos = nextSep !== -1 ? nextSep : buffer.length;
    const nm = hStr.match(/name="([^"]+)"/);
    const fn = hStr.match(/filename="([^"]+)"/);
    const ct = hStr.match(/Content-Type:\s*([^\r\n]+)/i);
    if (nm) {
      if (fn) files[nm[1]] = { filename: fn[1], data, contentType: ct?.[1]?.trim() };
      else fields[nm[1]] = data.toString('utf8');
    }
  }
  return { fields, files };
}
function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let m = true;
    for (let j = 0; j < search.length; j++) { if (buf[i+j] !== search[j]) { m = false; break; } }
    if (m) return i;
  }
  return -1;
}
