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
const decode = s => s.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(+d))
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');
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

// ---- date: accetta molti formati (dic 15 2026 | 15 dic 2026 | 15 dicembre 2026 | 15/12/2026 | 2026-12-15) ----
const MESI_ALL = { gennaio:1,gen:1,jan:1,january:1, febbraio:2,feb:2,february:2, marzo:3,mar:3,march:3, aprile:4,apr:4,april:4, maggio:5,mag:5,may:5,
  giugno:6,giu:6,jun:6,june:6, luglio:7,lug:7,jul:7,july:7, agosto:8,ago:8,aug:8,august:8, settembre:9,set:9,sett:9,sep:9,sept:9,september:9,
  ottobre:10,ott:10,oct:10,october:10, novembre:11,nov:11,november:11, dicembre:12,dic:12,dec:12,december:12 };
const MN = Object.keys(MESI_ALL).sort((a, b) => b.length - a.length).join('|');
function datesIn(seg) {
  const out = new Set(); let m;
  const add = (y, mo, d) => { y = +y; mo = +mo; d = +d; if (y >= 2024 && y <= 2035 && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) out.add(iso(y, mo, d)); };
  const A = new RegExp(`(?<![A-Za-zÀ-ÿ])(${MN})\\.?\\s*(\\d{1,2})(?:st|nd|rd|th)?,?\\s*(20\\d{2})(?!\\d)`, 'gi');
  const B = new RegExp(`(?<!\\d)(\\d{1,2})(?:st|nd|rd|th|°)?\\s*(${MN})\\.?,?\\s*(20\\d{2})(?!\\d)`, 'gi');
  const C = /(?<!\d)(\d{1,2})[\/.\-](\d{1,2})[\/.\-](20\d{2})(?!\d)/g;
  const D = /(20\d{2})-(\d{2})-(\d{2})/g;
  while ((m = A.exec(seg))) add(m[3], MESI_ALL[m[1].toLowerCase()], m[2]);
  while ((m = B.exec(seg))) add(m[3], MESI_ALL[m[2].toLowerCase()], m[1]);
  while ((m = C.exec(seg))) add(m[3], m[2], m[1]);
  while ((m = D.exec(seg))) add(m[1], m[2], m[3]);
  return out;
}
// 1) blocco "Info e biglietti" del testo visibile  2) dati strutturati (JSON-LD startDate / <time datetime>)  3) testo intero
function parseDates(text, html = '') {
  const start = text.search(/Info e biglietti|Info and tickets|Tickets? info/i);
  if (start >= 0) { const r = datesIn(text.slice(start, start + 3000)); if (r.size) return [...r].sort(); }
  const s = new Set();
  for (const m of html.matchAll(/"(?:startDate|endDate|datePublished)"\s*:\s*"(20\d{2}-\d{2}-\d{2})/g)) if (m[1]) s.add(m[1]);
  for (const m of html.matchAll(/<time\b[^>]*datetime\s*=\s*"(20\d{2}-\d{2}-\d{2})/gi)) s.add(m[1]);
  if (s.size) return [...s].sort();
  return [];
}

// Colore d'accento: conta i pixel VIVI (saturi e abbastanza luminosi), ignorando nero, bianco e grigi.
// (il "dominant" di sharp conta tutti i pixel e con sfondi scuri restituisce quasi nero)
async function accentFromBuffer(buf) {
  const N = 64;
  const { data } = await sharp(buf).removeAlpha().resize(N, N, { fit: 'cover' }).raw().toBuffer({ resolveWithObject: true });
  const BINS = 24, bin = Array.from({ length: BINS }, () => ({ w: 0, r: 0, g: 0, b: 0 }));
  let gw = 0, gr = 0, gg = 0, gb = 0;
  for (let i = 0; i < data.length; i += 3) {
    const r = data[i], g = data[i + 1], b = data[i + 2];
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, sat = mx ? (mx - mn) / mx : 0;
    if (v > 0.25) { gw++; gr += r; gg += g; gb += b; }                 // per immagini quasi in bianco e nero
    if (v < 0.22 || sat < 0.28) continue;                              // scarta scuri, spenti e grigi
    let h = mx === mn ? 0 : mx === r ? ((g - b) / (mx - mn) + 6) % 6 : mx === g ? (b - r) / (mx - mn) + 2 : (r - g) / (mx - mn) + 4;
    const k = bin[Math.min(BINS - 1, Math.floor(h / 6 * BINS))], w = sat * sat * v;   // piu' vivo = piu' peso
    k.w += w; k.r += r * w; k.g += g * w; k.b += b * w;
  }
  // somma anche i due gruppi di tinta vicini, cosi' una tinta spezzata tra due bin non perde
  let best = -1, bs = 0;
  for (let i = 0; i < BINS; i++) { const sc = bin[i].w + 0.5 * (bin[(i + 1) % BINS].w + bin[(i + BINS - 1) % BINS].w); if (sc > bs) { bs = sc; best = i; } }
  let r, g, b;
  if (best < 0 || bs < 3) {                                            // immagine senza colori vivi
    if (!gw) return '#8a8a8a';
    r = gr / gw; g = gg / gw; b = gb / gw;
  } else {
    const ks = [best, (best + 1) % BINS, (best + BINS - 1) % BINS].map(i => bin[i]); let W = 0; r = g = b = 0;
    ks.forEach(k => { W += k.w; r += k.r; g += k.g; b += k.b; }); r /= W; g /= W; b /= W;
  }
  // rende il colore ben visibile come cornice: luminosita' minima e saturazione minima
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 170) { const f = 170 / Math.max(mx, 1); r *= f; g *= f; b *= f; }
  const m2 = Math.max(r, g, b), n2 = Math.min(r, g, b);
  if (m2 - n2 < 70 && m2 > 0) { const c = (m2 + n2) / 2; const k = 70 / Math.max(m2 - n2, 1); r = c + (r - c) * k; g = c + (g - c) * k; b = c + (b - c) * k; }
  return '#' + [r, g, b].map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
async function dominantColor(url) {
  if (!sharp) return null;
  try { return await accentFromBuffer(Buffer.from(await (await fetch(url, { headers: { 'user-agent': UA } })).arrayBuffer())); }
  catch { return null; }
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
    const events = [], accents = {}, from = minDate(), pending = [];
    await pool(urls, 5, async url => {
      try {
        const html = await get(url);
        const og = meta(html, 'og:image');
        const title = cleanTitle(meta(html, 'og:title') || (html.match(/<title>([^<]*)/i) || [])[1] || '');
        let dates = parseDates(visibleText(html), html);
        if (!og) { st.warnings.push('senza immagine (og:image): ' + url); return; }
        if (!dates.length) { pending.push({ url, og, title, html }); return; }
        const live = dates.filter(d => d >= from);
        if (!live.length) return;                                   // evento passato
        const image = new URL(og, BASE).href.split('?')[0] + IMG_PARAMS;
        if (!(image in accents)) accents[image] = await dominantColor(image);
        live.forEach(date => events.push({ title, date, image, url, ...(accents[image] && { accent: accents[image] }) }));
      } catch (e) { st.warnings.push(`errore ${url}: ${e.message}`); }
    });
    // pagine senza date nell'HTML: le riapro con il browser (la data puo' essere scritta via JavaScript)
    if (pending.length) {
      let chromium; try { ({ chromium } = require('playwright')); } catch {}
      let browser; if (chromium) try { browser = await chromium.launch(); } catch (e) { st.warnings.push('browser non avviabile: ' + e.message); }
      for (const p of pending) {
        let dates = [], text = '';
        if (browser) try {
          const pg = await browser.newPage({ locale: 'it-IT' });
          await pg.goto(p.url, { waitUntil: 'networkidle', timeout: 60000 }); await pg.waitForTimeout(1500);
          text = (await pg.evaluate(() => document.body.innerText)).replace(/\s+/g, ' ');
          dates = parseDates(text, await pg.content()); await pg.close();
        } catch (e) { st.warnings.push(`errore browser ${p.url}: ${e.message}`); }
        if (!dates.length) {            // ultimo tentativo: tutte le date del testo, ma solo se ce ne sono poche (evita le date di altri eventi correlati)
          const all = [...datesIn(text || visibleText(p.html))].sort(); if (all.length && all.length <= 40) dates = all;
        }
        if (!dates.length) { const i = text.search(/Info e biglietti/i); st.warnings.push('senza date riconosciute: ' + p.url + ' | testo: ' + (text || visibleText(p.html)).slice(Math.max(0, i), Math.max(0, i) + 300)); continue; }
        const live = dates.filter(d => d >= from); if (!live.length) continue;
        const image = new URL(p.og, BASE).href.split('?')[0] + IMG_PARAMS;
        if (!(image in accents)) accents[image] = await dominantColor(image);
        live.forEach(date => events.push({ title: p.title, date, image, url: p.url, ...(accents[image] && { accent: accents[image] }) }));
      }
      if (browser) await browser.close();
    }
    if (!events.length && st.warnings.length) throw new Error('Nessun evento letto correttamente. Primo avviso: ' + st.warnings[0]);
    events.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
    st.ok = true; st.records = events.length; st.warnings = st.warnings.slice(0, 50); st.urls = urls;
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(path.join(out, 'events.json'), JSON.stringify(events, null, 1));
    fs.writeFileSync(path.join(out, 'status.json'), JSON.stringify(st, null, 1));
    console.log(`OK: pagine ${st.pages}, record ${events.length}, avvisi ${st.warnings.length}`);
  } catch (e) {
    console.error('ERRORE:', e.message, JSON.stringify(st));
    process.exit(1);          // il sito pubblicato resta com'e' (non viene sostituito con dati vuoti)
  }
})();
