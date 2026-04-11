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
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing fields', got: { field, pageId, hasFile: !!file } }) };
    }

    // ── Step 1: Upload to Cloudinary ─────────────────────────────────────
    const timestamp = Math.round(Date.now() / 1000);
    const folder = `halo-portal/${pageId.replace(/-/g, '').substring(0, 8)}`;
    const publicId = `${field}_${timestamp}`;

    // Generate signature
    const crypto = require('crypto');
    const sigStr = `access_mode=public&folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${CLOUDINARY_API_SECRET}`;
    const signature = crypto.createHash('sha1').update(sigStr).digest('hex');

    // Build multipart for Cloudinary upload
    const cldBoundary = '----CloudinaryBoundary' + Date.now();
    const parts_cld = [
      fieldPart(cldBoundary, 'file', file.data, file.filename, file.contentType),
      textPart(cldBoundary, 'folder', folder),
      textPart(cldBoundary, 'public_id', publicId),
      textPart(cldBoundary, 'access_mode', 'public'),
      textPart(cldBoundary, 'timestamp', String(timestamp)),
      textPart(cldBoundary, 'api_key', CLOUDINARY_API_KEY),
      textPart(cldBoundary, 'signature', signature),
      Buffer.from(`--${cldBoundary}--\r\n`)
    ];
    const cldBody = Buffer.concat(parts_cld);

    const cldResp = await fetch(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD}/raw/upload`, {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${cldBoundary}` },
      body: cldBody
    });
    const cldData = await cldResp.json();

    if (cldData.error) {
      console.error('Cloudinary error:', JSON.stringify(cldData.error));
      await sendEmail(ownerName, address, label, file, null);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'email_fallback', error: cldData.error.message }) };
    }

    // Add fl_attachment so the URL triggers a download instead of a broken page
    const rawUrl = cldData.secure_url;
    const fileUrl = rawUrl.replace('/raw/upload/', '/raw/upload/fl_attachment/');
    console.log('Cloudinary upload success:', fileUrl);

    // ── Step 2: Save URL to Notion ────────────────────────────────────────
    const notionField = NOTION_FIELD_MAP[field];
    const nh = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

    if (notionField) {
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
    }

    // Append note to Notes field
    const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh });
    const pageData = await getResp.json();
    const existing = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
    const note = `[${ts}] 📎 Owner uploaded: ${label} — ${file.filename}`;
    const updated = existing ? `${existing}\n${note}` : note;
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers: nh,
      body: JSON.stringify({ properties: { Notes: { rich_text: [{ type: 'text', text: { content: updated.substring(0, 2000) } }] } } })
    });

    // ── Step 3: Send email ────────────────────────────────────────────────
    await sendEmail(ownerName, address, label, file, fileUrl);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'cloudinary', url: fileUrl }) };

  } catch (err) {
    console.error('Upload error:', err.message, err.stack);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

function textPart(boundary, name, value) {
  return Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`);
}

function fieldPart(boundary, name, data, filename, contentType) {
  const header = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"; filename="${filename}"\r\nContent-Type: ${contentType || 'application/octet-stream'}\r\n\r\n`);
  const footer = Buffer.from('\r\n');
  return Buffer.concat([header, data, footer]);
}

async function sendEmail(ownerName, address, label, file, fileUrl) {
  try {
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' });
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
              <p style="margin:0 0 4px;color:#888;font-size:13px">File</p><p style="margin:0 0 ${fileUrl ? '16px' : '0'};">${file?.filename || 'N/A'}</p>
              ${fileUrl ? `<a href="${fileUrl}" style="display:inline-block;background:#1C1F26;color:#C9A96E;padding:10px 20px;border-radius:6px;text-decoration:none;font-size:13px;font-weight:500;margin-top:8px">View Document ↗</a>` : ''}
            </div>
          </div>`
      })
    });
  } catch(e) { console.error('Email error:', e.message); }
}

// Multipart parser
function parseMultipart(buffer, boundary) {
  const fields = {}, files = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  let pos = 0;
  while (pos < buffer.length) {
    const start = indexOf(buffer, boundaryBuf, pos);
    if (start === -1) break;
    pos = start + boundaryBuf.length;
    if (buffer[pos] === 45 && buffer[pos+1] === 45) break;
    if (buffer[pos] === 13) pos += 2;
    const headerEnd = indexOf(buffer, Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(pos, headerEnd).toString('utf8');
    pos = headerEnd + 4;
    const nextBoundary = indexOf(buffer, boundaryBuf, pos);
    const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2;
    const data = buffer.slice(pos, dataEnd);
    pos = nextBoundary !== -1 ? nextBoundary : buffer.length;
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);
    if (nameMatch) {
      if (filenameMatch) { files[nameMatch[1]] = { filename: filenameMatch[1], data, contentType: ctMatch?.[1]?.trim() }; }
      else { fields[nameMatch[1]] = data.toString('utf8'); }
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
