// Halo Hospitality — Owner Portal API
// Netlify serverless function: secure proxy between Squarespace and Notion
// Deploy to Netlify. Set NOTION_TOKEN and NOTION_DB_ID as environment variables.

const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_ID = process.env.NOTION_DB_ID;

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  const token = event.queryStringParameters?.token;
  if (!token) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'Missing owner token' })
    };
  }

  try {
    // Query Notion database for matching portal token
    const res = await fetch(`https://api.notion.com/v1/databases/${NOTION_DB_ID}/query`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${NOTION_TOKEN}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        filter: {
          property: 'Portal Token',
          rich_text: { equals: token }
        }
      })
    });

    const data = await res.json();

    if (!data.results || data.results.length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Owner not found' })
      };
    }

    const page = data.results[0];
    const props = page.properties;

    // Helper to safely extract property values
    const getText = (p) => p?.rich_text?.[0]?.plain_text || p?.title?.[0]?.plain_text || '';
    const getSelect = (p) => p?.select?.name || '';
    const getMultiSelect = (p) => p?.multi_select?.map(o => o.name) || [];
    const getDate = (p) => p?.date?.start || '';
    const getNumber = (p) => p?.number ?? null;
    const getEmail = (p) => p?.email || '';
    const getPhone = (p) => p?.phone_number || '';

    const owner = {
      id: page.id,
      name: getText(props['Owner Name']),
      address: getText(props['Property Address']),
      onboardingType: getSelect(props['Onboarding Type']),
      status: getSelect(props['Status']),
      currentPhase: getSelect(props['Current Phase']),
      goLiveTarget: getDate(props['Go-Live Target']),
      signedDate: getDate(props['Signed Date']),
      lastOwnerContact: getDate(props['Last Owner Contact']),
      ownerActionsPending: getMultiSelect(props['Owner Actions Pending']),
      openFlags: getText(props['Open Flags']),
      portalToken: getText(props['Portal Token']),
      email: getEmail(props['Owner Email']),
      phone: getPhone(props['Owner Phone']),
      progress: getNumber(props['Progress %']),
      notes: getText(props['Notes'])
    };

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(owner)
    };

  } catch (err) {
    console.error('Notion API error:', err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};
