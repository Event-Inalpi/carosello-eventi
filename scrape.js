// Legge SOLO inalpiarena.it e scrive public/events.json (+ public/status.json). Lanciato da GitHub Actions ogni 30 minuti.
const fs = require('fs'), path = require('path');
const BASE = (process.env.SITE_BASE || 'https://www.inalpiarena.it').replace(/\/$/, '');
const IMG_PARAMS = '?format=webp&width=1920&quality=75';   // stessi parametri degli URL indicati
const UA = 'Mozilla/5.0 (compatible; CaroselloEventi/1.0)';
const MESI = { gen:1, feb:2, mar:3, apr:4, mag:5, giu:6, lug:7, ago:8, set:9, ott:10, nov:11, dic:12 };
let sharp = null; try { sharp = require('sharp'); } catch {}
const pad = n => String(n).padStart(2, '0');
const iso = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;
// ieri, per non togliere troppo presto gli eventi di oggi (il filtro preciso lo fa il browser)
const minDate = () => { const t = new Date(Date.now() - 864e5); return iso(t.getFullYear(), t.getMonth() + 1, t.getDate()); };
async function get(url) {
  const r = await fetch(url, { headers: { 'user-agent': UA, 'accept-language': 'it-IT,it;q=0.9' }, redirect: 'follow' });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
  return r.text();
}

// ---- scoperta delle pagine evento ----
const EVENT_RE = /\/eventi\/([^\/?#]+-ae\d+)\/?(?:[?#]|$)/;
const canon = u => { const m = u.match(EVENT_RE); return m ? `${BASE}/eventi/${m[1]}` : null; };   // /en/eventi/x -> /eventi/x

async function fromSitemaps() {
  const found = new Set(), seen = new Set(), queue = [BASE + '/sitemap.xml'];
  try { for (const m of (await get(BASE + '/robots.txt')).matchAll(/^\s*Sitemap:\s*(\S+)/gim)) queue.push(m[1]); } catch {}
  while (queue.length && seen.size < 40) {
    const u = queue.shift(); if (seen.has(u)) continue; seen.add(u);
    let xml; try { xml = await get(u); } catch { continue; }
    for (const m of xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)) {
      const loc = m[1].replace(/&amp;/g, '&');
      if (/\.xml(\?|$)/i.test(loc)) queue.push(loc); else { const c = canon(loc); if (c) found.add(c); }
    }
  }
  return found;
}

async function fromListing() {
  let chromium; try { ({ chromium } = require('playwright')); } catch { return { urls: new Set(), note: 'playwright non installato' }; }
  const urls = new Set(); let browser;
  try {
    browser = await chromium.launch();
    const page = await browser.newPage({ locale: 'it-IT' });
    await page.goto(`${BASE}/eventi`, { waitUntil: 'networkidle', timeout: 60000 });
    let prev = -1;
    for (let i = 0; i < 40; i++) {
      const hrefs = await page.$$eval('a[href]', as => as.map(a => a.href));
      hrefs.forEach(h => { const c = canon(h); if (c) urls.add(c); });
      if (urls.size === prev) break; prev = urls.size;
      await page.mouse.wheel(0, 6000);
      const more = page.getByRole('button', { name: /carica|mostra|altri|more/i });
      if (await more.count()) await more.first().click().catch(() => {});
      await page.waitForTimeout(1200);
    }
    return { urls };
  } catch (e) { return { urls, note: 'errore elenco: ' + e.message }; }
  finally { if (browser) await browser.close(); }
}

// ---- lettura pagina evento ----
const decode = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
function meta(html, prop) {
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const t = m[0];
    if (new RegExp(`(?:property|name)\\s*=\\s*["']${prop}["']`, 'i').test(t)) {
      const c = t.match(/content\s*=\s*"([^"]*)"/i) || t.match(/content\s*=\s*'([^']*)'/i);
      if (c) return decode(c[1]);
    }
  }
  return '';
}
const visibleText = html => decode(html.replace(/<!--[\s\S]*?-->/g, ' ').replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');
const cleanTitle = t => t.replace(/\s*[–-]\s*www\.inalpiarena\.it.*$/i, '').replace(/\s*Tickets,? Tour and Concert Dates.*$/i, '').replace(/\s*Tickets.*$/i, '').replace(/\s+/g, ' ').trim();

// blocco data della pagina evento: "dic 15 2026" (una o piu' date)
function parseDates(text) {
  const start = text.search(/Info e biglietti/i);
  const seg = text.slice(start < 0 ? 0 : start, (start < 0 ? 0 : start) + 3000);
  const re = /(?<![A-Za-zÀ-ÿ])(gen|feb|mar|apr|mag|giu|lug|ago|set|ott|nov|dic)\.?\s*(\d{1,2})\s*(20\d{2})(?!\d)/gi;
  const out = new Set(); let m;
  while ((m = re.exec(seg))) out.add(iso(m[3], MESI[m[1].toLowerCase()], +m[2]));
  return [...out].sort();
}

async function dominantColor(url) {
  if (!sharp) return null;
  try {
    const buf = Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer());
    const { dominant: d } = await sharp(buf).resize(200).stats();
    return '#' + [d.r, d.g, d.b].map(v => v.toString(16).padStart(2, '0')).join('');
  } catch { return null; }
}

async function pool(items, n, fn) { const q = [...items]; await Promise.all(Array.from({ length: n }, async () => { while (q.length) await fn(q.shift()); })); }


(async () => {
  const out = __dirname;
  const st = { ok: false, lastRun: new Date().toISOString(), sources: {}, pages: 0, records: 0, warnings: [] };
  try {
    const [sm, li] = await Promise.all([fromSitemaps(), fromListing()]);
    st.sources = { sitemap: sm.size, elenco: li.urls.size, ...(li.note && { nota: li.note }) };
    const urls = [...new Set([...sm, ...li.urls])];
    if (!urls.length) throw new Error("Nessuna pagina evento trovata ne' da sitemap ne' da elenco " + BASE + '/eventi');
    st.pages = urls.length;
    const events = [], accents = {}, from = minDate();
    await pool(urls, 5, async url => {
      try {
        const html = await get(url);
        const og = meta(html, 'og:image');
        const title = cleanTitle(meta(html, 'og:title') || (html.match(/<title>([^<]*)/i) || [])[1] || '');
        const dates = parseDates(visibleText(html));
        if (!og) { st.warnings.push('senza immagine (og:image): ' + url); return; }
        if (!dates.length) { st.warnings.push('senza date riconosciute: ' + url); return; }
        const live = dates.filter(d => d >= from);
        if (!live.length) return;                                   // evento passato
        const image = new URL(og, BASE).href.split('?')[0] + IMG_PARAMS;
        if (!(image in accents)) accents[image] = await dominantColor(image);
        live.forEach(date => events.push({ title, date, image, url, ...(accents[image] && { accent: accents[image] }) }));
      } catch (e) { st.warnings.push(`errore ${url}: ${e.message}`); }
    });
    if (!events.length && st.warnings.length) throw new Error('Nessun evento letto correttamente. Primo avviso: ' + st.warnings[0]);
    events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    st.ok = true; st.records = events.length; st.warnings = st.warnings.slice(0, 50);
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 1));
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(st, null, 1));
    console.log(`OK: pagine ${st.pages}, record ${events.length}, avvisi ${st.warnings.length}`);
  } catch (e) {
    console.error('ERRORE:', e.message, JSON.stringify(st));
    process.exit(1);          // il sito pubblicato resta com'e' (non viene sostituito con dati vuoti)
  }
})();
