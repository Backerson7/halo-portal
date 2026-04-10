const NOTION_TOKEN = process.env.NOTION_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VA_EMAIL = process.env.VA_EMAIL || 'bo@halo-hospitality.com';

// Field mapping from upload key to Notion property name
const FIELD_MAP = {
  'insurance':     'Insurance Upload',
  'county_license':'County License Upload',
  'city_license':  'City License Upload',
  'str_permit':    'STR Permit Upload',
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
    // Parse multipart form data
    const contentType = event.headers['content-type'] || '';
    if (!contentType.includes('multipart/form-data')) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Expected multipart/form-data' }) };
    }

    // Extract boundary
    const boundary = contentType.split('boundary=')[1];
    if (!boundary) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No boundary' }) };

    // Parse the body
    const bodyBuffer = event.isBase64Encoded
      ? Buffer.from(event.body, 'base64')
      : Buffer.from(event.body);

    const parts = parseMultipart(bodyBuffer, boundary);
    const field     = parts.fields?.field;
    const pageId    = parts.fields?.pageId;
    const ownerName = parts.fields?.ownerName || '';
    const address   = parts.fields?.address || '';
    const label     = parts.fields?.label || field;
    const file      = parts.files?.file;

    if (!field || !pageId || !file) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields' }) };
    }

    const notionField = FIELD_MAP[field];
    if (!notionField) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown field: ' + field }) };

    const nh = {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
      'Content-Type': 'application/json'
    };

    // Step 1: Create an upload URL in Notion
    const uploadResp = await fetch('https://api.notion.com/v1/file-uploads', {
      method: 'POST',
      headers: nh,
      body: JSON.stringify({ mode: 'single-part' })
    });
    const uploadData = await uploadResp.json();

    if (uploadData.object === 'error') {
      // Fallback: store as external URL note if file upload API not available
      // Just log the upload intent in Notes
      const nowDisplay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
      const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh });
      const pageData = await getResp.json();
      const existing = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
      const note = `[${nowDisplay}] 📎 Owner uploaded: ${label} (${file.filename}) — file pending manual attachment`;
      const updated = existing ? `${existing}\n${note}` : note;
      await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
        method: 'PATCH', headers: nh,
        body: JSON.stringify({ properties: { Notes: { rich_text: [{ type: 'text', text: { content: updated.substring(0, 2000) } }] } } })
      });

      // Send email with file attached
      await sendEmailNotification(ownerName, address, label, file, pageId);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'email' }) };
    }

    // Step 2: Upload the file to Notion's storage
    const { upload_url, id: fileId } = uploadData;
    const formData = new FormData();
    const blob = new Blob([file.data], { type: file.contentType || 'application/octet-stream' });
    formData.append('file', blob, file.filename);

    await fetch(upload_url, { method: 'POST', body: formData });

    // Step 3: Attach the uploaded file to the Notion page property
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH', headers: nh,
      body: JSON.stringify({
        properties: {
          [notionField]: {
            files: [{ type: 'file', name: file.filename, file: { id: fileId } }]
          }
        }
      })
    });

    // Also send email notification
    await sendEmailNotification(ownerName, address, label, file, pageId);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'notion' }) };

  } catch (err) {
    console.error('Upload error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

async function sendEmailNotification(ownerName, address, label, file, pageId) {
  const nowDisplay = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'long', timeStyle: 'short' });
  try {
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
              <p style="margin:0 0 4px;color:#888;font-size:13px">Filename</p><p style="margin:0 0 16px">${file?.filename || 'N/A'}</p>
              <p style="margin:0 0 4px;color:#888;font-size:13px">Uploaded</p><p style="margin:0 0 24px">${nowDisplay}</p>
              <p style="margin:0;font-size:13px;color:#888">Check the owner's property record to find the attached document.</p>
            </div>
          </div>`
      })
    });
  } catch(e) { console.error('Email error:', e.message); }
}

// Simple multipart parser
function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = {};
  const boundaryBuf = Buffer.from('--' + boundary);
  let pos = 0;

  while (pos < buffer.length) {
    const start = indexOf(buffer, boundaryBuf, pos);
    if (start === -1) break;
    pos = start + boundaryBuf.length;
    if (buffer[pos] === 45 && buffer[pos+1] === 45) break; // --
    if (buffer[pos] === 13) pos += 2; // \r\n

    // Find header end
    const headerEnd = indexOf(buffer, Buffer.from('\r\n\r\n'), pos);
    if (headerEnd === -1) break;
    const headerStr = buffer.slice(pos, headerEnd).toString();
    pos = headerEnd + 4;

    // Find next boundary
    const nextBoundary = indexOf(buffer, boundaryBuf, pos);
    const dataEnd = nextBoundary === -1 ? buffer.length : nextBoundary - 2;
    const data = buffer.slice(pos, dataEnd);

    // Parse header
    const nameMatch = headerStr.match(/name="([^"]+)"/);
    const filenameMatch = headerStr.match(/filename="([^"]+)"/);
    const ctMatch = headerStr.match(/Content-Type:\s*([^\r\n]+)/i);

    if (nameMatch) {
      const name = nameMatch[1];
      if (filenameMatch) {
        files[name] = { filename: filenameMatch[1], data, contentType: ctMatch?.[1]?.trim() };
      } else {
        fields[name] = data.toString();
      }
    }
    pos = nextBoundary !== -1 ? nextBoundary : buffer.length;
  }
  return { fields, files };
}

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let found = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i+j] !== search[j]) { found = false; break; }
    }
    if (found) return i;
  }
  return -1;
}
