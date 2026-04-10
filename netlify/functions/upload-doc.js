const NOTION_TOKEN = process.env.NOTION_TOKEN;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const VA_EMAIL = process.env.VA_EMAIL || 'bo@halo-hospitality.com';

const FIELD_MAP = {
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
    if (!boundary) return { statusCode: 400, headers, body: JSON.stringify({ error: 'No boundary found in content-type: ' + contentType }) };

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

    const notionField = FIELD_MAP[field];
    if (!notionField) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown field: ' + field }) };

    const nh = {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2022-06-28',
    };
    // File upload API requires a newer version header
    const nhUpload = {
      'Authorization': `Bearer ${NOTION_TOKEN}`,
      'Notion-Version': '2024-05-13',
    };

    // ── Step 1: Create file upload object in Notion ───────────────────────
    const createResp = await fetch('https://api.notion.com/v1/file-uploads', {
      method: 'POST',
      headers: { ...nhUpload, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'single_part',
        filename: file.filename,
        content_type: file.contentType || 'application/octet-stream'
      })
    });
    const createData = await createResp.json();

    if (createData.object === 'error') {
      // Log the actual error for debugging, fall back to email
      console.error('Notion file-uploads create error:', JSON.stringify(createData));
      await logToNotes(pageId, label, file.filename, nh);
      await sendEmail(ownerName, address, label, file);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'email_fallback', notionError: createData.message }) };
    }

    // ── Step 2: Send the file binary to Notion's upload URL ───────────────
    const { upload_url, id: fileUploadId } = createData;

    // Build multipart body for the send-file call
    const fileBoundary = '----HaloUploadBoundary' + Date.now();
    const fileHeader = `--${fileBoundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType || 'application/octet-stream'}\r\n\r\n`;
    const fileFooter = `\r\n--${fileBoundary}--\r\n`;

    const headerBuf = Buffer.from(fileHeader);
    const footerBuf = Buffer.from(fileFooter);
    const combined = Buffer.concat([headerBuf, file.data, footerBuf]);

    const sendResp = await fetch(upload_url, {
      method: 'POST',
      headers: {
        ...nhUpload,
        'Content-Type': `multipart/form-data; boundary=${fileBoundary}`,
      },
      body: combined
    });
    const sendData = await sendResp.json();

    if (sendData.object === 'error' || sendData.status !== 'uploaded') {
      console.error('Notion send-file error:', JSON.stringify(sendData));
      await logToNotes(pageId, label, file.filename, nh);
      await sendEmail(ownerName, address, label, file);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'email_fallback', sendError: sendData.message }) };
    }

    // ── Step 3: Attach the uploaded file to the Notion page property ──────
    const attachResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { ...nh, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        properties: {
          [notionField]: {
            files: [{
              type: 'file',
              name: file.filename,
              file: { id: fileUploadId }
            }]
          }
        }
      })
    });
    const attachData = await attachResp.json();

    if (attachData.object === 'error') {
      console.error('Notion attach error:', JSON.stringify(attachData));
      await logToNotes(pageId, label, file.filename, nh);
      await sendEmail(ownerName, address, label, file);
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'email_fallback', attachError: attachData.message }) };
    }

    // ── Success: also send email notification ─────────────────────────────
    await sendEmail(ownerName, address, label, file);
    return { statusCode: 200, headers, body: JSON.stringify({ success: true, method: 'notion' }) };

  } catch (err) {
    console.error('Upload handler error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};

// ── Append note to Notion Notes field ────────────────────────────────────────
async function logToNotes(pageId, label, filename, nh) {
  try {
    const getResp = await fetch(`https://api.notion.com/v1/pages/${pageId}`, { headers: nh });
    const pageData = await getResp.json();
    const existing = pageData.properties?.Notes?.rich_text?.[0]?.plain_text || '';
    const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York', dateStyle: 'short', timeStyle: 'short' });
    const note = `[${ts}] 📎 Owner uploaded: ${label} — ${filename}`;
    const updated = existing ? `${existing}\n${note}` : note;
    await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
      method: 'PATCH',
      headers: { ...nh, 'Content-Type': 'application/json' },
      body: JSON.stringify({ properties: { Notes: { rich_text: [{ type: 'text', text: { content: updated.substring(0, 2000) } }] } } })
    });
  } catch(e) { console.error('logToNotes error:', e.message); }
}

// ── Send email notification ───────────────────────────────────────────────────
async function sendEmail(ownerName, address, label, file) {
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
              <p style="margin:0 0 4px;color:#888;font-size:13px">File</p><p style="margin:0 0 24px">${file?.filename || 'N/A'}</p>
              <p style="margin:0 0 4px;color:#888;font-size:13px">Uploaded</p><p style="margin:0">${ts}</p>
            </div>
          </div>`
      })
    });
  } catch(e) { console.error('sendEmail error:', e.message); }
}

// ── Multipart parser ──────────────────────────────────────────────────────────
function parseMultipart(buffer, boundary) {
  const fields = {};
  const files = {};
  const boundaryBuf = Buffer.from('--' + boundary);

  let pos = 0;
  while (pos < buffer.length) {
    const start = indexOf(buffer, boundaryBuf, pos);
    if (start === -1) break;
    pos = start + boundaryBuf.length;
    if (buffer[pos] === 45 && buffer[pos+1] === 45) break; // final --
    if (buffer[pos] === 13) pos += 2; // skip \r\n

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
      if (filenameMatch) {
        files[nameMatch[1]] = {
          filename: filenameMatch[1],
          data,
          contentType: ctMatch?.[1]?.trim() || 'application/octet-stream'
        };
      } else {
        fields[nameMatch[1]] = data.toString('utf8');
      }
    }
  }
  return { fields, files };
}

function indexOf(buf, search, start = 0) {
  for (let i = start; i <= buf.length - search.length; i++) {
    let match = true;
    for (let j = 0; j < search.length; j++) {
      if (buf[i+j] !== search[j]) { match = false; break; }
    }
    if (match) return i;
  }
  return -1;
}
