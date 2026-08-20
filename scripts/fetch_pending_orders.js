/*
 * pending-invoice-checker 阶段1 — 采集待确认订单 + 详情提取（Vue 直驱版 v2）
 * 运行环境: dev-browser QuickJS 沙箱（复用命名页 interest-island 保持登录会话）
 *
 * 输入: ~/.dev-browser/tmp/pending_check_input.json（可选）
 *       {"order_ids": ["9000000783104504"]}  // 缺省/空数组 → 自动遍历全部待确认
 * 输出: ~/.dev-browser/tmp/pending_orders.json
 *       { "status": "ok", "count": N, "orders": [{order_id, status, title_type, invoice_title, tax_id}] }
 *
 * 核心策略（已实测校准，见下方「已验证字段」）:
 *   1. 数据直接读 Vue 组件 $data.list（每行含 orderId/titleType/title/status），不做 DOM 表格抓取
 *   2. 待确认订单 = 内部状态码 status === 'P'（不依赖页面下拉框筛选）
 *   3. 自动翻页遍历全部（listQuery.page 递增 + fetchData），收集所有 status='P'
 *   4. 仅企业订单点「查看详情」读税号；个人订单无需税号（业务规则）
 *
 * 已验证字段（2026-08-18 实测）:
 *   - 状态码: status 'P'=待确认, 'W'=开票中, 'Y'=已开票
 *   - 抬头类型: titleType 'PERSONAL'=个人 / 'ENTERPRISE'=企业（映射为中文输出）
 *   - 发票抬头: title（列表直接含）
 *   - 企业税号: 详情抽屉「企业税号： xxx」（仅企业订单有）
 *   - 详情按钮文本: 「查看详情」（非「详情」）
 *   - 分页字段: listQuery.page / listQuery.size（size=20），不是 limit
 *   - 表格 6 个 <table> 是固定列复制，切勿按 table 遍历（已改为读 Vue 数据）
 */

// ===================== 配置 =====================
var CONFIG = {
  invoiceReviewUrl: 'https://edu-admin.qlchat.com/finance/invoice',
  detailButtonText: '查看详情',          // 详情按钮文本（实测）
  pageSize: 20,                           // 每页条数（与页面一致）
  maxPages: 200,                          // 翻页安全上限
  pendingStatus: 'P',                     // 待确认状态码（实测）
  pageWaitMs: 2000,                       // fetchData 后等待列表刷新
  detailWaitMs: 2000,                     // 点详情后等待抽屉渲染
  taxIdKeywords: ['企业税号', '税号', '统一社会信用代码', '纳税人识别号']
};

// ===================== 工具 =====================
function ts() { return new Date().toISOString().replace(/T/, ' ').replace(/\..+/, ''); }
function log(stage, msg, extra) {
  var line = '[PENDING][' + ts() + '] ' + stage + ': ' + msg;
  if (extra) { try { line += ' ' + JSON.stringify(extra); } catch (e) { line += ' ' + String(extra); } }
  console.log(line);
}

// ===================== 登录检测（URL 判断） =====================
async function checkLogin(page) {
  await page.goto(CONFIG.invoiceReviewUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  var url = page.url();
  var ok = url.indexOf('/login') < 0;
  log('LOGIN', ok ? 'session valid' : 'redirected to login', { url: url });
  return ok;
}

// ===================== 翻页：设置页码并触发查询 =====================
async function gotoPage(page, pageNum) {
  return await page.evaluate(function(p) {
    function search(node, depth) {
      if (!node || depth > 30) return null;
      if (node.listQuery && typeof node.fetchData === 'function') return node;
      var kids = node.$children || [];
      for (var i = 0; i < kids.length; i++) { var hit = search(kids[i], depth + 1); if (hit) return hit; }
      return null;
    }
    var app = document.querySelector('#app');
    var target = app && app.__vue__ ? search(app.__vue__, 0) : null;
    if (!target) return { ok: false, error: 'listQuery component not found' };
    target.$set(target.listQuery, 'page', p);
    target.fetchData();
    return { ok: true };
  }, pageNum);
}

// ===================== 读当前页 list 数据（Vue 直驱） =====================
async function readPageList(page) {
  return await page.evaluate(function() {
    function search(node, depth) {
      if (!node || depth > 30) return null;
      if (node.listQuery && typeof node.fetchData === 'function') return node;
      var kids = node.$children || [];
      for (var i = 0; i < kids.length; i++) { var hit = search(kids[i], depth + 1); if (hit) return hit; }
      return null;
    }
    var app = document.querySelector('#app');
    var target = app && app.__vue__ ? search(app.__vue__, 0) : null;
    if (!target) return { ok: false, error: 'listQuery component not found' };
    var list = target.list || (target.$data && target.$data.list) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var it = list[i];
      var tt = it.titleType === 'ENTERPRISE' ? '企业' : (it.titleType === 'PERSONAL' ? '个人' : String(it.titleType || ''));
      out.push({
        order_id: String(it.orderId == null ? '' : it.orderId),
        status: String(it.status == null ? '' : it.status),
        title_type: tt,
        invoice_title: String(it.title == null ? '' : it.title)
      });
    }
    return { ok: true, list: out };
  });
}

// ===================== 点击某行的「查看详情」按钮 =====================
// 优先按 rowIndex 定位，失败则按 orderId 文本兜底匹配
async function clickDetailByRow(page, rowIndex, orderId) {
  var arg = { idx: rowIndex, btnText: CONFIG.detailButtonText, orderId: String(orderId) };
  return await page.evaluate(function(a) {
    var table = document.querySelector('.el-table__body-wrapper table');
    var rows = table ? table.querySelectorAll('tbody tr') : [];
    var targetRow = rows[a.idx];
    // 兜底：rowIndex 不对或该行不含目标订单号 → 按文本匹配
    if (!targetRow || (targetRow.textContent || '').indexOf(a.orderId) < 0) {
      for (var r = 0; r < rows.length; r++) {
        if ((rows[r].textContent || '').indexOf(a.orderId) >= 0) { targetRow = rows[r]; break; }
      }
    }
    if (!targetRow) return { ok: false, error: 'row not found for ' + a.orderId };
    var btns = targetRow.querySelectorAll('button');
    for (var j = 0; j < btns.length; j++) {
      if ((btns[j].textContent || '').trim() === a.btnText) {
        btns[j].click();
        return { ok: true };
      }
    }
    return { ok: false, error: 'detail button not found for ' + a.orderId };
  }, arg);
}

// ===================== 读详情抽屉里的企业税号 =====================
// 修复(2026-08-19): 税号可能含空格(人工录入常带空格, 如 "9151 1902 MAEH XQHU 27")。
//   旧正则 [0-9A-Za-z]{8,30} 要求连续字母数字, 遇空格匹配失败返回空字符串,
//   导致后续被误判为"税号缺失"。改为按行提取冒号后内容, 保留内部空格,
//   交给 validate.py 判断"含空格"并给出准确备注。
async function readDetailTaxId(page) {
  return await page.evaluate(function(kw) {
    var body = document.body.innerText || '';
    var lines = body.split('\n');
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      for (var k = 0; k < kw.length; k++) {
        if (line.indexOf(kw[k]) < 0) continue;
        var idx = line.indexOf('：');
        if (idx < 0) idx = line.indexOf(':');
        if (idx < 0) continue;
        var rest = line.slice(idx + 1).trim();
        // 只保留字母数字与空格, 去掉行尾可能混入的其他字段
        var cleaned = rest.replace(/[^0-9A-Za-z ]/g, '').replace(/^ +| +$/g, '');
        // 去掉空格后至少 15 位(标准税号 18 位), 否则视为无效继续找
        if (cleaned.replace(/ /g, '').length >= 15) return cleaned;
      }
    }
    return '';
  }, CONFIG.taxIdKeywords);
}

// ===================== 关闭详情抽屉 =====================
async function closeDetail(page) {
  await page.evaluate(function() {
    var btn = document.querySelector('.el-drawer__close-btn');
    if (btn) btn.click();
    else {
      var mask = document.querySelector('.el-drawer__wrapper');
      if (mask) mask.click();
    }
  });
  await page.waitForTimeout(600);
}

// ===================== 主流程 =====================
async function main() {
  log('START', 'fetch pending orders (vue-direct)');

  // 1) 读可选输入（手动指定订单号）
  var targetIds = null;
  try {
    var raw = await readFile('pending_check_input.json');
    var input = JSON.parse(raw);
    if (input.order_ids && input.order_ids.length > 0) {
      targetIds = [];
      for (var x = 0; x < input.order_ids.length; x++) targetIds.push(String(input.order_ids[x]));
    }
  } catch (e) { /* 无输入文件，走自动遍历 */ }

  // 2) 获取命名页 + 登录检查
  var page = await browser.getPage('interest-island');
  log('PAGE', 'got page');
  var isLoggedIn = await checkLogin(page);
  if (!isLoggedIn) {
    var buf = await page.screenshot();
    var ssPath = await saveScreenshot(buf, 'pending_login_required_' + Date.now() + '.png');
    await writeFile('pending_orders.json', JSON.stringify({ status: 'login_required', screenshot: ssPath, orders: [] }));
    log('OUTPUT', 'login required', { screenshot: ssPath });
    return { status: 'login_required' };
  }

  // 3) 翻页遍历，收集目标订单（自动=status P，手动=指定 order_id）
  var collected = [];
  var pageNum = 1;
  var structureError = null;
  while (pageNum <= CONFIG.maxPages) {
    var g = await gotoPage(page, pageNum);
    if (!g.ok) { structureError = g.error; break; }
    await page.waitForTimeout(CONFIG.pageWaitMs);
    var pd = await readPageList(page);
    if (!pd.ok) { structureError = pd.error; break; }
    if (pd.list.length === 0) break; // 越界空页
    log('PAGE', 'page ' + pageNum, { count: pd.list.length, firstOrder: pd.list[0].order_id });

    for (var i = 0; i < pd.list.length; i++) {
      var it = pd.list[i];
      var isTarget = targetIds ? (targetIds.indexOf(it.order_id) >= 0) : (it.status === CONFIG.pendingStatus);
      if (isTarget) {
        collected.push({
          order_id: it.order_id,
          title_type: it.title_type,
          invoice_title: it.invoice_title,
          page: pageNum,
          rowIndex: i
        });
      }
    }

    if (pd.list.length < CONFIG.pageSize) break; // 最后一页
    pageNum++;
  }

  if (structureError) {
    await writeFile('pending_orders.json', JSON.stringify({ status: 'page_structure_change', error: structureError, orders: [] }));
    log('OUTPUT', 'structure error', { error: structureError });
    return { status: 'page_structure_change', error: structureError };
  }
  log('COLLECT', 'collected', { count: collected.length, pagesScanned: pageNum });

  if (collected.length === 0) {
    await writeFile('pending_orders.json', JSON.stringify({ status: 'empty', count: 0, orders: [], note: '待确认列表为空' }));
    log('OUTPUT', 'empty');
    return { status: 'empty' };
  }

  // 4) 逐个点详情读税号（仅企业订单）
  var orders = [];
  for (var k = 0; k < collected.length; k++) {
    var c = collected[k];
    var taxId = '';
    var ok = true;
    if (c.title_type === '企业') {
      await gotoPage(page, c.page); // 跳回该订单所在页
      await page.waitForTimeout(CONFIG.pageWaitMs);
      var cr = await clickDetailByRow(page, c.rowIndex, c.order_id);
      if (cr.ok) {
        await page.waitForTimeout(CONFIG.detailWaitMs);
        taxId = await readDetailTaxId(page);
        await closeDetail(page);
      } else {
        ok = false;
      }
    }
    orders.push({
      order_id: c.order_id,
      status: ok ? 'ok' : 'detail_failed',
      title_type: c.title_type,
      invoice_title: c.invoice_title,
      tax_id: taxId
    });
    log('DETAIL', (k + 1) + '/' + collected.length, { orderId: c.order_id, titleType: c.title_type, taxId: taxId, ok: ok });
  }

  var result = { status: 'ok', count: orders.length, orders: orders };
  await writeFile('pending_orders.json', JSON.stringify(result));
  log('OUTPUT', 'done', { count: orders.length });
  return result;
}

// 运行（⚠️ QuickJS 沙箱必须用顶层 await，main().then() 会被截断）
try {
  var r = await main();
  log('DONE', 'script complete', { status: r && r.status });
} catch (e) {
  log('FATAL', 'unhandled error', { message: String(e), stack: e && e.stack ? String(e.stack) : 'none' });
}
