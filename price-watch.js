// Weekly price check for the baby list Google Sheet.
// Reads each list tab (CSV export), looks up current Amazon prices from the URL column (Q),
// writes changed prices into Price (F) and today's date into Price checked (O) by editing the
// link-shared sheet in a headless browser, then sends a ntfy push for drops of 10% or more.
// Runs from systemd (baby-price-watch.timer); needs no Claude usage.
const { chromium } = require('/home/korbin/.local/lib/pw/node_modules/playwright-core');
const fs = require('fs');
const { execSync } = require('child_process');

const DIR = '/home/korbin/baby-list';
const SHEET = fs.readFileSync(`${DIR}/.sheet-url`, 'utf8').trim();
const ID = SHEET.match(/\/d\/([^/]+)/)[1];
const GIDS = JSON.parse(fs.readFileSync(`${DIR}/.sheet-gids.json`, 'utf8'));
const TABS = ['Before birth', 'First weeks', 'Later', 'Optional'];
const HISTORY = `${DIR}/price-history.json`;
const DROP = 0.10;
const DRY = process.argv.includes('--dry-run');

const log = (...a) => console.log(new Date().toISOString().slice(0, 19), ...a);
const money = (s) => { const n = parseFloat(String(s).replace(/[^0-9.]/g, '')); return isNaN(n) ? null : n; };

function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

function notify(title, msg) {
  const topic = execSync("sudo grep -oP '^NTFY_TOPIC=\\K.*' /etc/pi-health.conf").toString().trim();
  if (!topic || DRY) return log('NOTIFY', title, msg);
  execSync(`curl -s -m 15 -H ${JSON.stringify('Title: ' + title)} -d @- https://ntfy.sh/${topic}`, { input: msg });
}

(async () => {
  // 1. Read the sheet.
  const items = [];
  for (const tab of TABS) {
    const res = await fetch(`https://docs.google.com/spreadsheets/d/${ID}/export?format=csv&gid=${GIDS[tab]}`);
    if (!res.ok) throw new Error(`read ${tab}: HTTP ${res.status}`);
    parseCsv(await res.text()).forEach((r, i) => {
      const asin = (r[16] || '').match(/\/dp\/([A-Z0-9]{10})/)?.[1];
      if (i === 0 || !r[1] || !asin || /^(Got|Skip)$/.test(r[12])) return;
      items.push({ tab, row: i + 1, name: r[1], price: money(r[5]), asin });
    });
  }
  log(`checking ${items.length} items`);

  const browser = await chromium.launch({ headless: true, executablePath: '/usr/bin/chromium' });
  try {
    // 2. Look up Amazon prices.
    const amz = await (await browser.newContext({ locale: 'en-US', timezoneId: 'America/Phoenix' })).newPage();
    await amz.goto('https://www.amazon.com/', { timeout: 45000 }).catch(() => {});
    const cont = amz.getByRole('button', { name: /continue shopping/i });
    if (await cont.count()) { await cont.first().click().catch(() => {}); await amz.waitForTimeout(2000); }
    let failed = 0;
    for (const it of items) {
      try {
        await amz.goto('https://www.amazon.com/dp/' + it.asin, { timeout: 45000 });
        await amz.waitForSelector('#productTitle', { timeout: 15000 });
        it.now = money(await amz.evaluate(() => {
          const t = s => document.querySelector(s)?.textContent?.trim() || null;
          return t('#corePrice_feature_div .a-price .a-offscreen') || t('#corePriceDisplay_desktop_feature_div .a-price .a-offscreen') || t('.a-price .a-offscreen');
        }));
      } catch { it.now = null; }
      if (it.now == null) failed++;
      await amz.waitForTimeout(2000 + Math.random() * 2000);
    }
    log(`prices found for ${items.length - failed}/${items.length}`);
    if (items.length && failed / items.length > 0.5) {
      notify('Baby list price check failed', `Amazon only returned ${items.length - failed} of ${items.length} prices. Ask Claude to look at ~/baby-list/price-watch.log.`);
      return;
    }

    // 3. Record history and work out changes.
    const hist = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY, 'utf8')) : {};
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Phoenix' });
    for (const it of items) if (it.now != null) (hist[it.asin] ||= []).push([new Date().toISOString().slice(0, 10), it.now]);
    fs.writeFileSync(HISTORY, JSON.stringify(hist));
    const changed = items.filter(it => it.now != null && it.now !== it.price);
    const drops = changed.filter(it => it.price && it.now <= it.price * (1 - DROP));

    // 4. Write changes into the sheet.
    const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 }, locale: 'en-US' });
    const p = await ctx.newPage();
    await p.goto(SHEET, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await p.waitForSelector('#t-name-box', { timeout: 30000 }); await p.waitForTimeout(5000);
    const go = async (ref) => { await p.keyboard.press('Escape'); await p.click('#t-name-box', { force: true, timeout: 10000 }); await p.keyboard.press('Control+A'); await p.keyboard.type(ref); await p.keyboard.press('Enter'); await p.waitForTimeout(500); };
    const set = async (ref, v) => { await go(ref); await p.keyboard.type(String(v)); await p.keyboard.press('Enter'); await p.waitForTimeout(500); };
    for (const tab of TABS) {
      const mine = items.filter(it => it.tab === tab && it.now != null);
      if (!mine.length || DRY) continue;
      await p.locator('.docs-sheet-tab', { hasText: tab }).first().click(); await p.waitForTimeout(2000);
      for (const it of mine) {
        if (it.now !== it.price) await set(`F${it.row}`, it.now.toFixed(2));
        await set(`O${it.row}`, today);
      }
    }
    await p.waitForTimeout(3000);
    log(`updated ${changed.length} prices` + (DRY ? ' (dry run)' : ''));
    changed.forEach(it => log(`  ${it.tab} / ${it.name}: ${it.price} -> ${it.now}`));

    // 5. Tell the user about real drops.
    if (drops.length) {
      notify(`Baby list: ${drops.length} price drop${drops.length > 1 ? 's' : ''}`,
        drops.map(it => `${it.name}: $${it.price.toFixed(2)} → $${it.now.toFixed(2)} (${Math.round((1 - it.now / it.price) * 100)}% off)`).join('\n'));
    }
  } finally {
    await browser.close();
  }
})().catch(e => { log('ERROR', e.message); notify('Baby list price check failed', e.message.slice(0, 200)); process.exit(1); });
