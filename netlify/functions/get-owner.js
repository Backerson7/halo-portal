const NOTION_TOKEN = process.env.NOTION_TOKEN;
const PAGE_ID = '33cbc97df85e804c80c2f1bd88f0d9de';

exports.handler = async (event) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing token' }) };

  const nh = { 'Authorization': `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' };

  try {
    const childResp = await fetch(`https://api.notion.com/v1/blocks/${PAGE_ID}/children`, { headers: nh });
    const childData = await childResp.json();
    const dbBlock = childData.results?.find(b => b.type === 'child_database');
    if (!dbBlock) return { statusCode: 500, headers, body: JSON.stringify({ error: 'Database not found' }) };

    const res = await fetch(`https://api.notion.com/v1/databases/${dbBlock.id}/query`, {
      method: 'POST', headers: nh,
      body: JSON.stringify({ filter: { property: 'Portal Token', rich_text: { equals: token } } })
    });
    const data = await res.json();
    if (data.object === 'error') return { statusCode: 500, headers, body: JSON.stringify({ error: data.message }) };
    if (!data.results?.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Owner not found' }) };

    const page = data.results[0];
    const p = page.properties;
    const txt  = (f) => f?.rich_text?.[0]?.plain_text || f?.title?.[0]?.plain_text || '';
    const sel  = (f) => f?.select?.name || '';
    const msel = (f) => f?.multi_select?.map(o => o.name) || [];
    const dt   = (f) => f?.date?.start || '';
    const url  = (f) => f?.url || '';
    const files= (f) => f?.files?.map(x => ({ name: x.name, url: x.file?.url || x.external?.url || '' })) || [];

    return { statusCode: 200, headers, body: JSON.stringify({
      // Core
      id: page.id,
      name: txt(p['Owner Name']),
      address: txt(p['Property Address']),
      onboardingType: sel(p['Onboarding Type']),
      status: sel(p['Status']),
      currentPhase: sel(p['Current Phase']),
      goLiveTarget: dt(p['Go-Live Target']),
      signedDate: dt(p['Signed Date']),
      ownerActionsPending: msel(p['Owner Actions Pending']),
      openFlags: txt(p['Open Flags']),
      portalToken: txt(p['Portal Token']),
      email: p['Owner Email']?.email || '',
      phone: p['Owner Phone']?.phone_number || '',
      progress: p['Progress %']?.number ?? null,
      notes: txt(p['Notes']),

      // Owner action — Management Agreement
      mgmtAgreementURL: url(p['Management Agreement URL']),
      mgmtAgreementSigned: dt(p['Management Agreement Signed']),

      // Owner action — Property Details
      propertyDetailsSubmitted: dt(p['Property Details Submitted']),

      // Owner action — W9
      w9URL: url(p['W9 URL']),
      w9Signed: dt(p['W9 Signed']),

      // Owner action — Insurance
      insuranceUpload: files(p['Insurance Upload']),
      insuranceUploaded: dt(p['Insurance Uploaded']),

      // Owner action — Compliance
      countyLicenseUpload: files(p['County License Upload']),
      cityLicenseUpload: files(p['City License Upload']),
      strPermitUpload: files(p['STR Permit Upload']),
      complianceUploaded: dt(p['Compliance Uploaded']),

      // Owner action — Work Order (existing)
      workOrderPDF: files(p['Work Order PDF']),
      workOrderApproved: dt(p['Work Order Approved']),

      // Manager progress
      inspectionReport: files(p['Inspection Report']),
      inspectionCompleted: dt(p['Inspection Completed']),
      purchaseOrderCompleted: dt(p['Purchase Order Completed']),
      onboardingWorkOrderCompleted: dt(p['Onboarding Work Order Completed']),
      photographyDropboxLink: url(p['Photography Dropbox Link']),
      photographyCompleted: dt(p['Photography Completed']),
      listingCreated: dt(p['Listing Created']),
      listingLaunched: dt(p['Listing Launched']),
      hostawayLoginURL: url(p['Hostaway Login URL']),
      vrplatformLoginURL: url(p['VRPlatform Login URL']),
      dashboardsCreated: dt(p['Dashboards Created']),
      review30PDF: files(p['Review 30 Day PDF']),
      review30Date: dt(p['Review 30 Day Date']),
      review90PDF: files(p['Review 90 Day PDF']),
      review90Date: dt(p['Review 90 Day Date'])
    })};
  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
