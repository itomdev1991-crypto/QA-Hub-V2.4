// ═══════════════════════════════════════════════════════════════════
// QA Hub — Google Apps Script Backend  v3
// Deploy: Web App → Execute as Me → Access: Anyone (anonymous)
// All requests use GET (CORS-safe). Writes encoded as base64 payload.
// ═══════════════════════════════════════════════════════════════════

const SS_ID = '1aEs_ButDhhM-Om_4NjOd-Efeh_XRosjUfRxXhTfaEgs'; // ← ใส่ Spreadsheet ID

const SHEETS = {
  users:     'Users',
  teams:     'Teams',
  members:   'Members',
  projects:  'Projects',
  tasks:     'Tasks',
  testCases: 'TestCases',
  defects:   'Defects',
  logs:      'Logs',
  loginLogs: 'LoginLogs',
  pending:   'PendingMembers',
};

const COLS = {
  users:     ['id','name','email','password','color'],
  teams:     ['id','name','icon','color','inviteCode','createdBy','createdAt'],
  members:   ['id','teamId','userId','role','joinedAt'],
  projects:  ['id','teamId','name','description','status','priority','startDate','endDate','createdBy','createdAt'],
  tasks:     ['id','projectId','name','description','status','priority','assignee','startDate','endDate','createdBy','createdAt'],
  testCases: ['id','taskId','title','precondition','steps','expected','status','priority','detection','assignee','defectIds','comment','createdBy','createdAt','updatedAt'],
  defects:   ['id','teamId','title','description','severity','status','priority','stepsToReproduce','expected','actual','environment','relatedTcIds','assignee','comment','attachments','createdBy','createdAt','updatedAt'],
  logs:      ['id','userId','userName','action','detail','at'],
  loginLogs: ['id','userId','userName','ip','at','isNew'],
  pending:   ['id','teamId','teamName','userId','requestedAt','status'],
};

// ── Response ───────────────────────────────────────────────────────
function resp(data) {
  return ContentService
    .createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}
function ok(data) { return resp({ ok: true,  data: data }); }
function err(msg) { return resp({ ok: false, error: String(msg) }); }

// ── Base64 decode that handles Unicode correctly ───────────────────
// Browser encodes: btoa(unescape(encodeURIComponent(jsonString)))
// GAS decodes:     decodeURIComponent(atob(base64String))  ← V8 safe
function decodePayload(b64) {
  // URL-safe base64: replace - with + and _ with /
  var fixed = b64.replace(/-/g, '+').replace(/_/g, '/');
  var decoded = Utilities.base64Decode(fixed, Utilities.Charset.UTF_8);
  return Utilities.newBlob(decoded).getDataAsString();
}

// ── Sheet helpers ──────────────────────────────────────────────────
function getSheet(sheetKey) {
  var name = SHEETS[sheetKey];
  if (!name) throw new Error('Unknown sheet key: "' + sheetKey + '"');
  var sheet = SpreadsheetApp.openById(SS_ID).getSheetByName(name);
  if (!sheet) throw new Error('Sheet "' + name + '" not found — run initSheets() first');
  return sheet;
}

function ensureHeaders(sheet, cols) {
  if (sheet.getLastRow() === 0) {
    sheet.appendRow(cols);
    sheet.getRange(1, 1, 1, cols.length)
      .setBackground('#1e2535')
      .setFontColor('#8e9abb')
      .setFontWeight('bold');
    SpreadsheetApp.flush();
  }
}

function rowsToObjects(sheet, sheetKey) {
  var cols = COLS[sheetKey];
  if (sheet.getLastRow() < 2) return [];
  var numRows = sheet.getLastRow() - 1;
  var numCols = Math.min(cols.length, sheet.getLastColumn());
  var raw = sheet.getRange(2, 1, numRows, numCols).getValues();
  return raw
    .filter(function(r) { return r[0] !== '' && r[0] !== null && r[0] !== undefined; })
    .map(function(r) {
      var obj = {};
      cols.forEach(function(c, i) {
        var v = (i < r.length) ? r[i] : '';
        if (typeof v === 'string' && v.length > 0 && (v[0] === '[' || v[0] === '{')) {
          try { obj[c] = JSON.parse(v); } catch(e2) { obj[c] = v; }
        } else if (v === true  || v === 'TRUE')  { obj[c] = true;  }
        else if   (v === false || v === 'FALSE') { obj[c] = false; }
        else if   (v === '' || v === null)       { obj[c] = null;  }
        else                                     { obj[c] = v;     }
      });
      return obj;
    });
}

function objToRow(obj, cols) {
  return cols.map(function(c) {
    var v = obj[c];
    if (v === null || v === undefined) return '';
    if (Array.isArray(v) || (typeof v === 'object' && v !== null)) return JSON.stringify(v);
    return v;
  });
}

function findRowById(sheet, id) {
  if (sheet.getLastRow() < 2) return -1;
  var ids = sheet.getRange(2, 1, sheet.getLastRow() - 1, 1).getValues().flat();
  var idx = ids.findIndex(function(v) { return String(v) === String(id); });
  return idx === -1 ? -1 : idx + 2;
}

// ── doGet — single entry point for ALL requests ────────────────────
function doGet(e) {
  try {
    Logger.log('doGet params: ' + JSON.stringify(e.parameter));

    // ── WRITE path: payload=base64encodedJSON ──
    if (e.parameter.payload) {
      var jsonStr = decodePayload(e.parameter.payload);
      Logger.log('decoded payload: ' + jsonStr);
      var body = JSON.parse(jsonStr);
      return handleWrite(body);
    }

    // ── READ path ──
    var action   = e.parameter.action || '';
    var sheetKey = e.parameter.sheet  || '';

    if (action === 'getAll') {
      if (!sheetKey) return err('getAll requires ?sheet=sheetKey');
      var sheet = getSheet(sheetKey);
      ensureHeaders(sheet, COLS[sheetKey]);
      return ok(rowsToObjects(sheet, sheetKey));
    }

    if (action === 'init') {
      initSheets();
      return ok('Sheets initialized');
    }

    // ── Health check ──
    if (action === 'ping') {
      return ok({ pong: true, time: new Date().toISOString() });
    }

    return err('Unknown action: "' + action + '". Use ?action=getAll&sheet=users or ?payload=BASE64');

  } catch(ex) {
    Logger.log('doGet error: ' + ex.message + '\n' + ex.stack);
    return err(ex.message);
  }
}

// ── Write handler ──────────────────────────────────────────────────
function handleWrite(body) {
  var action   = body.action;
  var sheetKey = body.sheet;
  var data     = body.data;
  var id       = body.id;

  Logger.log('handleWrite body: ' + JSON.stringify(body));
  Logger.log('handleWrite: action=' + action + ' sheet=' + sheetKey + ' id=' + id);

  if (!action)   return err('Missing action in payload');
  if (!sheetKey) return err('Missing sheet in payload — got: ' + JSON.stringify(body));

  if (!sheetKey || !SHEETS[sheetKey]) return err('Invalid sheet: "' + sheetKey + '"');

  var sheet = getSheet(sheetKey);
  var cols  = COLS[sheetKey];
  ensureHeaders(sheet, cols);

  // INSERT (or upsert if ID exists)
  if (action === 'insert') {
    if (!data || !data.id) return err('insert: missing data.id');
    var existing = findRowById(sheet, data.id);
    if (existing !== -1) {
      sheet.getRange(existing, 1, 1, cols.length).setValues([objToRow(data, cols)]);
      Logger.log('upserted row ' + existing + ' for id=' + data.id);
    } else {
      sheet.appendRow(objToRow(data, cols));
      Logger.log('inserted new row for id=' + data.id);
    }
    SpreadsheetApp.flush();
    return ok(data);
  }

  // UPDATE (upsert if not found)
  if (action === 'update') {
    var targetId = id || (data && data.id);
    if (!targetId) return err('update: missing id');
    var rowIdx = findRowById(sheet, targetId);
    if (rowIdx === -1) {
      sheet.appendRow(objToRow(data, cols));
      Logger.log('upserted (not found) id=' + targetId);
    } else {
      sheet.getRange(rowIdx, 1, 1, cols.length).setValues([objToRow(data, cols)]);
      Logger.log('updated row ' + rowIdx + ' id=' + targetId);
    }
    SpreadsheetApp.flush();
    return ok(data);
  }

  // DELETE
  if (action === 'delete') {
    var delId = id || (data && data.id);
    if (!delId) return err('delete: missing id');
    var delRow = findRowById(sheet, delId);
    if (delRow !== -1) {
      sheet.deleteRow(delRow);
      Logger.log('deleted row ' + delRow + ' id=' + delId);
      SpreadsheetApp.flush();
    } else {
      Logger.log('delete: id not found, skip. id=' + delId);
    }
    return ok({ deleted: delId });
  }

  // BULK INSERT (replace all)
  if (action === 'bulkInsert') {
    if (sheet.getLastRow() > 1) sheet.deleteRows(2, sheet.getLastRow() - 1);
    if (Array.isArray(data) && data.length > 0) {
      var rows = data.map(function(o) { return objToRow(o, cols); });
      sheet.getRange(2, 1, rows.length, cols.length).setValues(rows);
      Logger.log('bulkInserted ' + rows.length + ' rows into ' + sheetKey);
    }
    SpreadsheetApp.flush();
    return ok({ inserted: Array.isArray(data) ? data.length : 0 });
  }

  return err('Unknown action: "' + action + '"');
}

// ── Run once from Editor to create all sheets ──────────────────────
function initSheets() {
  var ss = SpreadsheetApp.openById(SS_ID);
  Object.entries(SHEETS).forEach(function(entry) {
    var key  = entry[0];
    var name = entry[1];
    var sheet = ss.getSheetByName(name);
    if (!sheet) sheet = ss.insertSheet(name);
    ensureHeaders(sheet, COLS[key]);
  });
  var def = ss.getSheetByName('Sheet1');
  if (def && ss.getSheets().length > 1) ss.deleteSheet(def);
  Logger.log('initSheets done — ' + Object.keys(SHEETS).length + ' sheets ready');
}

// ── Test function: run from Editor to verify encode/decode ──────────
function testPayload() {
  var payload = { action: 'insert', sheet: 'users', data: { id: 'test1', name: 'ทดสอบ', email: 'test@test.com', password: '1234', color: '#fff' } };
  var jsonStr = JSON.stringify(payload);
  Logger.log('Original: ' + jsonStr);

  // Simulate browser encoding: btoa(unescape(encodeURIComponent(str)))
  var b64 = Utilities.base64Encode(jsonStr, Utilities.Charset.UTF_8);
  Logger.log('Encoded:  ' + b64);

  // Simulate GAS decode
  var decoded = decodePayload(b64);
  Logger.log('Decoded:  ' + decoded);

  var parsed = JSON.parse(decoded);
  Logger.log('action=' + parsed.action + ' sheet=' + parsed.sheet);
  Logger.log('Test PASSED: ' + (parsed.action === 'insert' && parsed.sheet === 'users'));
}