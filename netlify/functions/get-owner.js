const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = '33cbc97df85e804c80c2f1bd88f0d9de';

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token' }) };

  const notionHeaders = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  try {
    // Step 1: Get children of the page to find the database block ID
    const childResp = await fetch(`https://api.notion.com/v1/blocks/${PAGE_ID}/children`, { headers: notionHeaders });
    const childData = await childResp.json();
    
    // Find the child_database block
    const dbBlock = childData.results?.find(b => b.type === 'child_database');
    if (!dbBlock) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not found in page', page_children: childData.results?.map(b => b.type), api_error: childData.message }) };
    
    const dbId = dbBlock.id;

    // Step 2: Query the database
    const res = await fetch(`https://api.notion.com/v1/databases/${dbId}/query`, {
      method: 'POST',
      headers: notionHeaders,
      body: JSON.stringify({ filter: { property: 'Portal Token', rich_text: { equals: token } } })
    });
    const data = await res.json();
    if (data.object === 'error') return { statusCode: 500, headers, body: JSON.stringify({ error: data.message, db_id: dbId }) };
    if (!data.results?.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Owner not found', db_id: dbId }) };

    const page = data.results[0];
    const props = page.properties;
    const getText = (p) => p?.rich_text?.[0]?.plain_text || p?.title?.[0]?.plain_text || '';
    const getSelect = (p) => p?.select?.name || '';
    const getMultiSelect = (p) => p?.multi_select?.map(o => o.name) || [];
    const getDate = (p) => p?.date?.start || '';

    return { statusCode: 200, headers, body: JSON.stringify({
      id: page.id, name: getText(props['Owner Name']), address: getText(props['Property Address']),
      onboardingType: getSelect(props['Onboarding Type']), status: getSelect(props['Status']),
      currentPhase: getSelect(props['Current Phase']), goLiveTarget: getDate(props['Go-Live Target']),
      signedDate: getDate(props['Signed Date']), ownerActionsPending: getMultiSelect(props['Owner Actions Pending']),
      openFlags: getText(props['Open Flags']), portalToken: getText(props['Portal Token']),
      email: props['Owner Email']?.email || '', phone: props['Owner Phone']?.phone_number || '',
      progress: props['Progress %']?.number ?? null, notes: getText(props['Notes'])
    })};
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
