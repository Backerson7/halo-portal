const NOTION_TOKEN = process.env.NOTION_TOKEN;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token' }) };

  try {
    const res = await fetch('https://api.notion.com/v1/search', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: token, filter: { value: 'page', property: 'object' } })
    });
    const data = await res.json();
    if (data.object === 'error') return { statusCode: 500, headers, body: JSON.stringify({ error: data.message }) };

    const page = data.results?.find(p => p.properties?.['Portal Token']?.rich_text?.[0]?.plain_text === token);
    if (!page) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Owner not found', results: data.results?.length || 0 }) };

    const props = page.properties;
    const getText = (p) => p?.rich_text?.[0]?.plain_text || p?.title?.[0]?.plain_text || '';
    const getSelect = (p) => p?.select?.name || '';
    const getMultiSelect = (p) => p?.multi_select?.map(o => o.name) || [];
    const getDate = (p) => p?.date?.start || '';

    return { statusCode: 200, headers, body: JSON.stringify({
      id: page.id,
      name: getText(props['Owner Name']),
      address: getText(props['Property Address']),
      onboardingType: getSelect(props['Onboarding Type']),
      status: getSelect(props['Status']),
      currentPhase: getSelect(props['Current Phase']),
      goLiveTarget: getDate(props['Go-Live Target']),
      signedDate: getDate(props['Signed Date']),
      ownerActionsPending: getMultiSelect(props['Owner Actions Pending']),
      openFlags: getText(props['Open Flags']),
      portalToken: getText(props['Portal Token']),
      email: props['Owner Email']?.email || '',
      phone: props['Owner Phone']?.phone_number || '',
      progress: props['Progress %']?.number ?? null,
      notes: getText(props['Notes'])
    })};
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
