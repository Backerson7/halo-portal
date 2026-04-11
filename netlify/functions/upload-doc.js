const NOTION_TOKEN = process.env.NOTION_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VA_EMAIL = process.env.VA_EMAIL || 'bo@halo-hospitality.com';
const CLOUDINARY_CLOUD = process.env.CLOUDINARY_CLOUD_NAME || 'dn6yvnwwu';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY;
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET;

const NOTION_FIELD_MAP = {
  'insurance':      'Insurance Upload',
  'county_license': 'County License Upload',
  'city_license':   'City License Upload',
  'str_permit':     'STR Permit Upload',
};

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
    const ownerName = parts.fields?.ownerName || '';
    const address   = parts.fields?.address || '';
    const label     = parts.fields?.label || field;
    const file      = parts.files?.file;

    if (!field || !pageId || !file) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields' }) };
    }

    const nh = {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    };
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
    const notionField = NOTION_FIELD_MAP[field];
    let fileUrl = null;
    let method = 'notion_only';

    // ── Step 1: Try Cloudinary upload ─────────────────────────────────────
    try {
      const crypto = require('crypto');
      const timestamp = Math.round(Date.now() / 1000);
      const folder = `halo-portal/${pageId.replace(/-/g,'').substring(0,8)}`;
      const publicId = `${field}_${timestamp}`;

      // Signature — params must be alphabetically sorted
      const sigParams = { folder, public_id: publicId, timestamp };
      const sigStr = Object.keys(sigParams).sort().map(k => `${k}=${sigParams[k]}`).join('&') + CLOUDINARY_API_SECRET;
      const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

      // Build multipart body for Cloudinary
      const cldBoundary = 'HaloCldBoundary' + Date.now();
      const cldParts = [
        filePart(cldBoundary, 'file', file.data, file.filename, file.contentType),
        textPart(cldBoundary, 'folder', folder),
        textPart(cldBoundary, 'public_id', publicId),
        textPart(cldBoundary, 'timestamp', String(timestamp)),
        textPart(cldBoundary, 'api_key', CLOUDINARY_API_KEY),
        textPart(cldBoundary, 'signature', signature),
        Buffer.from(`--${cldBoundary}--\r\n`)
      ];

      const cldResp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${cldBoundary}` },
        body: Buffer.concat(cldParts)
      });
      const cldData = await cldResp.json();

      if (cldData.secure_url) {
        fileUrl = cldData.secure_url;
        method = 'cloudinary';
        console.log('Cloudinary upload success:', fileUrl);
      } else {
        console.error('Cloudinary failed:', JSON.stringify(cldData.error || cldData));
      }
    } catch (cldErr) {
      console.error('Cloudinary exception:', cldErr.message);
    }

    // ── Step 2: Always update Notion ──────────────────────────────────────
    // Update the files field with external URL if we have one
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
      } catch(e) { console.error('Notion field update error:', e.message); }
    }

    // Always append to Notes
    try {
      const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh });
      const pageData = await getResp.json();
      const existing = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
      const note = fileUrl
        ? `[${ts}] 📎 Owner uploaded: ${label} — ${file.filename} → ${fileUrl}`
        : `[${ts}] 📎 Owner uploaded: ${label} — ${file.filename} (file upload pending)`;
      const updated = existing ? `${existing}\n${note}` : note;
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nh,
        body: JSON.stringify({ properties: { Notes: { rich_text: [{ type: 'text', text: { content: updated.substring(0, 2000) } }] } } })
      });
    } catch(e) { console.error('Notion notes error:', e.message); }

    // ── Step 3: Send email ────────────────────────────────────────────────
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
                ${fileUrl ? `<a href="${fileUrl}" style="display:inline-block;background:#1C1F26;color:#C9A96E;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;margin-top:8px">View Document ↗</a>` : '<p style="margin:8px 0 0;color:#888;font-size:12px">File available in owner record</p>'}
              </div>
            </div>`
        })
      });
    } catch(e) { console.error('Email error:', e.message); }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, method, url: fileUrl }) };

  } catch (err) {
    console.error('Handler error:', err.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function textPart(boundary, name, value) {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function filePart(boundary, name, data, filename, contentType) {
  return Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`),
    data,
    Buffer.from('\r\n')
  ]);
}

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
