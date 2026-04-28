/**
 * FPS Marketing Dashboard -> Google Ads Sync (Google Ads Scripts)
 *
 * Purpose
 * - Pull THIS_MONTH performance for a single Google Ads campaign ("Lead Campaign")
 * - Write Ad Group rollups into the "AdGroups" tab in the dashboard Sheet
 * - Update a few KPI metrics in the "KPIs" tab (Ads Spend This Month, Cost per Lead)
 *
 * Where this runs
 * - Inside Google Ads -> Tools -> Bulk actions -> Scripts
 * - NOT inside Google Apps Script (different runtime)
 */

// Dashboard spreadsheet (the one your GitHub Pages dashboard reads)
const SPREADSHEET_URL = 'https://docs.google.com/spreadsheets/d/1t4lS0Ca0m4h4fYO_zEX0IjHUyiRTezxnmtDKhjwITYg/edit';

// Only sync this active campaign (user requirement)
// IMPORTANT: Google Ads queries require an exact campaign name match (case-sensitive).
// Your account shows this campaign as "LEAD CAMPAIGN" (all caps).
const CAMPAIGN_NAME = 'LEAD CAMPAIGN';

// Keep dashboard consistent with "this month" requirements
const DATE_RANGE = 'THIS_MONTH';

const SHEET_ADGROUPS = 'AdGroups';
const SHEET_KPIS = 'KPIs';

// Expected AdGroups headers (Dashboard expects these exact column names)
const ADGROUP_HEADERS = ['Group', 'Status', 'Leads/Month', 'Cost per Lead', 'Budget %'];

function main() {
  const ss = SpreadsheetApp.openByUrl(SPREADSHEET_URL);
  const adSheet = ensureSheet_(ss, SHEET_ADGROUPS, ADGROUP_HEADERS);
  const kpiSheet = ensureSheet_(ss, SHEET_KPIS, ['Metric', 'Value']);

  const rows = fetchCurrentAdGroupRows_(CAMPAIGN_NAME);
  writeAdGroups_(adSheet, rows);

  // KPI rollups from ad groups
  const totalCost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const totalLeads = rows.reduce((s, r) => s + (r.leads || 0), 0);
  const cpl = totalLeads > 0 ? (totalCost / totalLeads) : 0;

  setKpi_(kpiSheet, 'Ads Spend This Month', round2_(totalCost));
  setKpi_(kpiSheet, 'Cost per Lead', round2_(cpl));

  Logger.log(`Synced ${rows.length} current ad groups for "${CAMPAIGN_NAME}" (${DATE_RANGE}). Cost=$${round2_(totalCost)} Leads=${totalLeads} CPL=$${round2_(cpl)}`);
}

function fetchCurrentAdGroupRows_(campaignName) {
  const metricsByGroup = fetchAdGroupMetricsThisMonth_(campaignName);
  const currentGroups = fetchCurrentAdGroups_(campaignName);

  const rows = currentGroups.map(groupInfo => {
    const metrics = metricsByGroup[groupInfo.group] || { cost: 0, leads: 0 };
    const leads = Math.round(metrics.leads || 0);
    const cost = metrics.cost || 0;
    const cpl = leads > 0 ? (cost / leads) : null;

    return {
      group: groupInfo.group,
      status: groupInfo.status,
      leads: leads,
      cost: cost,
      cpl: cpl
    };
  });

  const totalCost = rows.reduce((sum, row) => sum + (row.cost || 0), 0);
  rows.forEach(row => {
    row.budgetPct = totalCost > 0 ? (row.cost / totalCost) : 0;
  });

  rows.sort(function(a, b) {
    const aActive = a.status === 'Active' ? 1 : 0;
    const bActive = b.status === 'Active' ? 1 : 0;
    if (bActive !== aActive) return bActive - aActive;
    return (b.cost || 0) - (a.cost || 0);
  });

  return rows;
}

function fetchCurrentAdGroups_(campaignName) {
  const groups = [];
  const seen = {};
  const selector = AdsApp
    .adGroups()
    .withCondition("CampaignName = '" + escSelector_(campaignName) + "'")
    .withCondition("Status IN [ENABLED, PAUSED]");
  const it = selector.get();

  while (it.hasNext()) {
    const adGroup = it.next();
    const name = adGroup.getName();
    if (!name || seen[name]) continue;

    seen[name] = true;
    groups.push({
      group: name,
      status: normalizeStatus_(adGroup.isPaused() ? 'PAUSED' : 'ENABLED')
    });
  }

  return groups;
}

function fetchAdGroupMetricsThisMonth_(campaignName) {
  const query =
    "SELECT " +
      "campaign.name, " +
      "ad_group.name, " +
      "ad_group.status, " +
      "metrics.cost_micros, " +
      "metrics.conversions " +
    "FROM ad_group " +
    "WHERE " +
      "campaign.name = '" + escGaql_(campaignName) + "' " +
      "AND segments.date DURING " + DATE_RANGE;

  const it = AdsApp.search(query);
  const agg = {}; // key -> { cost, leads }

  while (it.hasNext()) {
    const r = it.next();
    const group = r.adGroup && r.adGroup.name ? r.adGroup.name : '';
    if (!group) continue;

    const cost = (r.metrics && r.metrics.costMicros) ? (Number(r.metrics.costMicros) / 1e6) : 0;
    const leads = (r.metrics && r.metrics.conversions) ? Number(r.metrics.conversions) : 0;

    if (!agg[group]) agg[group] = { cost: 0, leads: 0 };
    agg[group].cost += cost;
    agg[group].leads += leads;
  }

  return agg;
}

function writeAdGroups_(sheet, rows) {
  // Clear previous data (keep header)
  if (sheet.getLastRow() > 1) {
    sheet.getRange(2, 1, sheet.getLastRow() - 1, sheet.getLastColumn()).clearContent();
  }

  if (!rows.length) {
    // Keep it empty but valid (dashboard will show "No ad group data yet")
    return;
  }

  const values = rows.map(r => ([
    r.group,
    r.status,
    r.leads,
    r.cpl == null ? '' : round2_(r.cpl),
    r.budgetPct
  ]));

  sheet.getRange(2, 1, values.length, ADGROUP_HEADERS.length).setValues(values);

  // Formats for readability
  sheet.getRange(2, 3, values.length, 1).setNumberFormat('0');        // Leads/Month
  sheet.getRange(2, 4, values.length, 1).setNumberFormat('$0.00');    // Cost per Lead
  sheet.getRange(2, 5, values.length, 1).setNumberFormat('0%');       // Budget %
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);

  // Ensure headers exist
  const range = sh.getRange(1, 1, 1, headers.length);
  const current = range.getValues()[0];
  const ok = headers.every((h, i) => String(current[i] || '').trim() === h);
  if (!ok) {
    sh.clear();
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

function setKpi_(kpiSheet, metric, value) {
  const last = Math.max(1, kpiSheet.getLastRow());
  const values = kpiSheet.getRange(1, 1, last, 2).getValues();

  // Find metric row, else append
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][0]).trim() === metric) {
      kpiSheet.getRange(i + 1, 2).setValue(value);
      return;
    }
  }
  kpiSheet.appendRow([metric, value]);
}

function normalizeStatus_(raw) {
  const s = String(raw || '').toLowerCase();
  if (s.indexOf('pause') >= 0) return 'Paused';
  if (s.indexOf('remove') >= 0) return 'Paused';
  return 'Active';
}

function escGaql_(s) {
  return String(s || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function escSelector_(s) {
  return String(s || '').replace(/'/g, "\\'");
}

function round2_(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}
