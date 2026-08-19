/*
 * pending-invoice-checker 阶段2 — 企微双 sheet 查重
 * 运行环境: dev-browser QuickJS 沙箱（复用命名页 wecom-doc 保持登录会话）
 *
 * 输入: ~/.dev-browser/tmp/dedup_input.json
 *       {"orders": [{"order_id": "9000000783104504"}]}  // 或 {"order_ids": [...]}
 * 输出: ~/.dev-browser/tmp/dedup_result.json
 *       [{"order_id": "...", "found": true/false, "sheets": {...}}]
 *
 * 核心策略: SpreadsheetApp 引擎 API 遍历（不用 Ctrl+F，canvas 键盘事件不响应）。
 *           两个 sheet 都查，任一命中即 found: true。
 *
 * ⚠️ 首次运行验证点（CONFIG 集中配置）：
 *   1. 文档 URL（默认取流程图中的开票历史记录表格链接）
 *   2. 两个 sheet 名称匹配关键词
 *   3. 订单ID列索引（默认 col 9，沿用 wecom-invoice-query 已验证值）
 */

// ===================== 配置 =====================
var CONFIG = {
  defaultDocUrl: 'https://doc.weixin.qq.com/sheet/e3_AWwAGAaLAFMCN4Gx1f3rFSpm5afm2?scode=ABcAIgfUAAg0Cm23k9AVsAGAaLAFM&tab=BB08J2',
  sheetNameKeywords: ['沐思和思坞开票', '新增兴趣岛开票登记2'],
  orderIdColumnIndex: 9  // 引擎列索引（0-based，col 9 = 第10列；沿用 wecom-invoice-query 已验证值）
};

function ts() { return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''); }
function log(stage, msg, extra) {
  var line = '[DEDUP][' + ts() + '] ' + stage + ': ' + msg;
  if (extra) { try { line += ' ' + JSON.stringify(extra); } catch (e) { line += ' ' + String(extra); } }
  console.log(line);
}

// ===================== 等待引擎就绪 =====================
async function waitForAppReady(page, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    var ok = await page.evaluate(function() {
      return typeof window.SpreadsheetApp !== 'undefined'
        && !!window.SpreadsheetApp.workbook
        && !!window.SpreadsheetApp.workbook.worksheetManager;
    });
    if (ok) return { ok: true, elapsed: Date.now() - start };
    await page.waitForTimeout(300);
  }
  return { ok: false, elapsed: timeoutMs };
}

// ===================== 等待 sheet 数据就绪 =====================
async function waitForSheetReady(page, timeoutMs) {
  var start = Date.now();
  while (Date.now() - start < timeoutMs) {
    var ok = await page.evaluate(function() {
      var app = window.SpreadsheetApp;
      if (!app || !app.workbook) return false;
      var wm = app.workbook.worksheetManager;
      if (!wm) return false;
      var sid = wm.activeSheetId;
      var sheet = wm.getSheetBySheetId(sid);
      return !!(sheet && typeof sheet.getRowCount === 'function');
    });
    if (ok) return { ok: true, elapsed: Date.now() - start };
    await page.waitForTimeout(300);
  }
  return { ok: false, elapsed: timeoutMs };
}

// ===================== 枚举所有 sheet（尝试多种 API，首次运行 dump 校准） =====================
async function enumerateSheets(page) {
  return await page.evaluate(function() {
    var app = window.SpreadsheetApp;
    var wm = app.workbook.worksheetManager;
    var list = [];

    // 尝试多种枚举方式
    var raw = null;
    if (typeof wm.getSheets === 'function') { try { raw = wm.getSheets(); } catch (e) {} }
    if (!raw && wm.sheets) raw = wm.sheets;
    if (!raw && app.workbook.sheets) raw = app.workbook.sheets;
    if (!raw && typeof app.workbook.getSheets === 'function') { try { raw = app.workbook.getSheets(); } catch (e) {} }

    function extractId(s) {
      return s.sheetId || s.id || s.sheetID || s.sheet_id || (s.getId && s.getId());
    }
    function extractName(s) {
      return s.name || s.sheetName || s.title || (s.getName && s.getName()) || '';
    }

    if (raw) {
      if (typeof raw.length === 'number') {
        for (var i = 0; i < raw.length; i++) {
          list.push({ id: extractId(raw[i]), name: extractName(raw[i]) });
        }
      } else if (typeof raw === 'object') {
        for (var k in raw) {
          list.push({ id: extractId(raw[k]), name: extractName(raw[k]) });
        }
      }
    }

    // 兜底：至少返回 activeSheetId
    var activeId = wm.activeSheetId;
    return { sheets: list, activeSheetId: activeId, rawKeys: raw && typeof raw === 'object' ? Object.keys(raw) : [] };
  });
}

// ===================== 在指定 sheet 上查单个订单号 =====================
async function searchInSheet(page, sheetId, orderNum) {
  // 沙箱限制：page.evaluate 只允许 1 个参数，多参数必须包成对象
  var arg = { sid: sheetId, num: orderNum, colIdx: CONFIG.orderIdColumnIndex };
  return await page.evaluate(function(a) {
    var app = window.SpreadsheetApp;
    var wm = app.workbook.worksheetManager;
    var sheet = wm.getSheetBySheetId(a.sid);
    if (!sheet || typeof sheet.getRowCount !== 'function') return { error: 'sheet not ready', sheetId: a.sid };

    var total = sheet.getRowCount();
    for (var r = 1; r < total; r++) {
      var cell = sheet.getCellDataAtPosition(r, a.colIdx);
      var val = cell && cell.formattedValue ? cell.formattedValue.value : '';
      if (val && String(val).indexOf(a.num) >= 0) {
        return {
          found: true, row: r, scanned_rows: r,
          order_field: String(val),
          date: readCell(sheet, r, 2),
          invoice_number: readCell(sheet, r, 4),
          name: readCell(sheet, r, 6),
          amount: readCell(sheet, r, 8)
        };
      }
    }
    return { found: false, scanned_rows: total };

    function readCell(sheet, row, col) {
      try {
        var c = sheet.getCellDataAtPosition(row, col);
        return c && c.formattedValue ? c.formattedValue.value : '';
      } catch (e) { return ''; }
    }
  }, arg);
}

// ===================== 主流程 =====================
async function main() {
  log('START', 'dedup query');

  // 1) 读取输入
  var input;
  try {
    var raw = await readFile('dedup_input.json');
    input = JSON.parse(raw);
  } catch (e) {
    log('ERROR', 'read input failed', { error: String(e) });
    await writeFile('dedup_result.json', JSON.stringify({ error: 'input_read_failed', detail: String(e) }));
    return;
  }

  var orderIds = [];
  if (input.orders && input.orders.length) {
    for (var i = 0; i < input.orders.length; i++) orderIds.push(String(input.orders[i].order_id || input.orders[i].orderId));
  } else if (input.order_ids && input.order_ids.length) {
    for (var j = 0; j < input.order_ids.length; j++) orderIds.push(String(input.order_ids[j]));
  }
  if (orderIds.length === 0) {
    await writeFile('dedup_result.json', JSON.stringify({ error: 'no_orders' }));
    return;
  }
  var docUrl = input.doc_url || CONFIG.defaultDocUrl;
  log('INPUT', 'orders', { count: orderIds.length, ids: orderIds });

  // 2) 打开文档
  var page = await browser.getPage('wecom-doc');
  await page.goto(docUrl, { waitUntil: 'domcontentloaded' });
  log('PAGE', 'opened doc');

  var appReady = await waitForAppReady(page, 20000);
  if (!appReady.ok) {
    await writeFile('dedup_result.json', JSON.stringify({ error: 'app_not_ready', elapsed_ms: appReady.elapsed }));
    return;
  }
  log('APP', 'engine ready', { elapsed: appReady.elapsed });

  var sheetReady = await waitForSheetReady(page, 15000);
  if (!sheetReady.ok) {
    await writeFile('dedup_result.json', JSON.stringify({ error: 'sheet_not_ready', elapsed_ms: sheetReady.elapsed }));
    return;
  }
  log('SHEET', 'sheet ready', { elapsed: sheetReady.elapsed });

  // 3) 枚举 sheet，按名称匹配两个目标 sheet
  var enumRes = await enumerateSheets(page);
  log('SHEETS', 'enumerated', enumRes);

  var targetSheets = [];
  for (var s = 0; s < enumRes.sheets.length; s++) {
    var name = enumRes.sheets[s].name;
    for (var k = 0; k < CONFIG.sheetNameKeywords.length; k++) {
      if (name.indexOf(CONFIG.sheetNameKeywords[k]) >= 0) {
        targetSheets.push({ id: enumRes.sheets[s].id, name: name });
        break;
      }
    }
  }

  // 兜底：若按名称没匹配到，用 activeSheetId 作为唯一 sheet
  if (targetSheets.length === 0 && enumRes.activeSheetId) {
    targetSheets.push({ id: enumRes.activeSheetId, name: '(active)' });
  }
  log('TARGET', 'target sheets', { sheets: targetSheets });

  // 4) 对每个订单号，遍历目标 sheet 查重
  var results = [];
  for (var o = 0; o < orderIds.length; o++) {
    var oid = orderIds[o];
    var hit = null;
    var sheetResults = {};
    for (var t = 0; t < targetSheets.length; t++) {
      var r = await searchInSheet(page, targetSheets[t].id, oid);
      sheetResults[targetSheets[t].name] = r;
      if (r.found && !hit) hit = { sheet: targetSheets[t].name, detail: r };
    }
    results.push({
      order_id: oid,
      found: !!hit,
      sheet: hit ? hit.sheet : null,
      detail: hit ? hit.detail : null,
      sheets: sheetResults
    });
    log('RESULT', oid, { found: !!hit, sheet: hit ? hit.sheet : null });
  }

  await writeFile('dedup_result.json', JSON.stringify(results));
  log('OUTPUT', 'done', { count: results.length });
  return results;
}

try {
  var r = await main();
  log('DONE', 'script complete', { count: r && r.length });
} catch (e) {
  log('FATAL', 'unhandled error', { message: String(e), stack: e && e.stack ? String(e.stack) : 'none' });
}
