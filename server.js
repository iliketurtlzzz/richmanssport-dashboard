require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const { google } = require('googleapis');
const path = require('path');

const app = express();
app.use(cookieParser());
app.use(express.json());

// Serve the dashboard
app.use(express.static(path.join(__dirname)));

// ═══════════════════════════════════════
// Google OAuth 2.0
// ═══════════════════════════════════════
const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  'http://localhost:3001/api/auth/google/callback'
);

// Store tokens in memory (for production, use encrypted database)
let googleTokens = null;

// Step 1: Redirect user to Google login
app.get('/api/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/analytics.readonly',
    ],
  });
  res.redirect(url);
});

// Step 2: Google sends user back with a code
app.get('/api/auth/google/callback', async (req, res) => {
  try {
    const { code } = req.query;
    const { tokens } = await oauth2Client.getToken(code);
    googleTokens = tokens;
    oauth2Client.setCredentials(tokens);
    // Set a cookie so the dashboard knows we're connected
    res.cookie('ga_connected', 'true', { maxAge: 30 * 24 * 60 * 60 * 1000 });
    res.redirect('/?ga=connected');
  } catch (err) {
    console.error('Google auth error:', err.message);
    res.redirect('/?ga=error');
  }
});

// Check connection status
app.get('/api/auth/google/status', (req, res) => {
  res.json({ connected: !!googleTokens });
});

// Disconnect
app.get('/api/auth/google/disconnect', (req, res) => {
  googleTokens = null;
  res.clearCookie('ga_connected');
  res.json({ disconnected: true });
});

// ═══════════════════════════════════════
// GA4 Data Endpoints
// ═══════════════════════════════════════
async function getGA4Client() {
  if (!googleTokens) throw new Error('Not authenticated');
  oauth2Client.setCredentials(googleTokens);
  // Auto-refresh if expired
  if (googleTokens.expiry_date && googleTokens.expiry_date < Date.now()) {
    const { credentials } = await oauth2Client.refreshAccessToken();
    googleTokens = credentials;
    oauth2Client.setCredentials(credentials);
  }
  return google.analyticsdata({ version: 'v1beta', auth: oauth2Client });
}

// List available GA4 accounts/properties
app.get('/api/ga4/accounts', async (req, res) => {
  try {
    if (!googleTokens) return res.status(401).json({ error: 'Not authenticated' });
    oauth2Client.setCredentials(googleTokens);
    const admin = google.analyticsadmin({ version: 'v1beta', auth: oauth2Client });
    const accts = await admin.accountSummaries.list();
    const result = [];
    (accts.data.accountSummaries || []).forEach(a => {
      (a.propertySummaries || []).forEach(p => {
        result.push({ account: a.displayName, property: p.displayName, propertyId: p.property.replace('properties/', '') });
      });
    });
    res.json(result);
  } catch (err) {
    console.error('GA4 accounts error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Total sessions + traffic sources for current month
app.get('/api/ga4/traffic', async (req, res) => {
  try {
    const analytics = await getGA4Client();
    const propertyId = process.env.GA4_PROPERTY_ID;

    // Get current month date range
    const now = new Date();
    const startDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-01`;
    const endDate = 'today';

    // Total sessions
    const sessionsReport = await analytics.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        metrics: [
          { name: 'sessions' },
          { name: 'totalUsers' },
          { name: 'screenPageViews' },
          { name: 'averageSessionDuration' },
          { name: 'bounceRate' },
        ],
      },
    });

    // Traffic sources
    const sourcesReport = await analytics.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate, endDate }],
        dimensions: [{ name: 'sessionDefaultChannelGroup' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ metric: { metricName: 'sessions' }, desc: true }],
        limit: 10,
      },
    });

    // Parse totals
    const totals = sessionsReport.data.rows?.[0]?.metricValues || [];
    const sessions = parseInt(totals[0]?.value || 0);
    const users = parseInt(totals[1]?.value || 0);
    const pageViews = parseInt(totals[2]?.value || 0);
    const avgDuration = parseFloat(totals[3]?.value || 0);
    const bounceRate = parseFloat(totals[4]?.value || 0);

    // Parse sources
    const sources = (sourcesReport.data.rows || []).map(row => ({
      channel: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
    }));

    // Calculate percentages
    const totalSessions = sources.reduce((a, b) => a + b.sessions, 0) || 1;
    sources.forEach(s => {
      s.percent = Math.round((s.sessions / totalSessions) * 100);
    });

    res.json({
      sessions,
      users,
      pageViews,
      avgDuration: Math.round(avgDuration),
      bounceRate: Math.round(bounceRate * 100) / 100,
      sources,
      period: `${startDate} to today`,
    });
  } catch (err) {
    console.error('GA4 error:', err.message);
    res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message });
  }
});

// Daily sessions for the last 30 days (for charts)
app.get('/api/ga4/daily', async (req, res) => {
  try {
    const analytics = await getGA4Client();
    const propertyId = process.env.GA4_PROPERTY_ID;

    const report = await analytics.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'date' }],
        metrics: [{ name: 'sessions' }, { name: 'totalUsers' }],
        orderBys: [{ dimension: { dimensionName: 'date' } }],
      },
    });

    const days = (report.data.rows || []).map(row => ({
      date: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
      users: parseInt(row.metricValues[1].value),
    }));

    res.json({ days });
  } catch (err) {
    console.error('GA4 daily error:', err.message);
    res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message });
  }
});

// Top pages
app.get('/api/ga4/pages', async (req, res) => {
  try {
    const analytics = await getGA4Client();
    const propertyId = process.env.GA4_PROPERTY_ID;

    const report = await analytics.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: '30daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'pagePath' }],
        metrics: [{ name: 'screenPageViews' }],
        orderBys: [{ metric: { metricName: 'screenPageViews' }, desc: true }],
        limit: 10,
      },
    });

    const pages = (report.data.rows || []).map(row => ({
      path: row.dimensionValues[0].value,
      views: parseInt(row.metricValues[0].value),
    }));

    res.json({ pages });
  } catch (err) {
    console.error('GA4 pages error:', err.message);
    res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message });
  }
});

// Monthly sessions for the past 12 months (for bar chart)
app.get('/api/ga4/monthly', async (req, res) => {
  try {
    const analytics = await getGA4Client();
    const propertyId = process.env.GA4_PROPERTY_ID;

    const report = await analytics.properties.runReport({
      property: `properties/${propertyId}`,
      requestBody: {
        dateRanges: [{ startDate: '365daysAgo', endDate: 'today' }],
        dimensions: [{ name: 'yearMonth' }],
        metrics: [{ name: 'sessions' }],
        orderBys: [{ dimension: { dimensionName: 'yearMonth' } }],
      },
    });

    const months = (report.data.rows || []).map(row => ({
      month: row.dimensionValues[0].value,
      sessions: parseInt(row.metricValues[0].value),
    }));

    // Format month labels (202603 → Mar 2026)
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    months.forEach(m => {
      const yr = m.month.substring(0, 4);
      const mo = parseInt(m.month.substring(4)) - 1;
      m.label = monthNames[mo] + ' ' + yr;
    });

    res.json({ months });
  } catch (err) {
    console.error('GA4 monthly error:', err.message);
    res.status(err.message === 'Not authenticated' ? 401 : 500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════
// Start server
// ═══════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n  Dashboard running at http://localhost:${PORT}\n`);
});
