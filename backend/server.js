// server.js — FeasyFactura backend (Express + Puppeteer)
// Rellena formularios de portales de facturación con heurística por etiquetas/ids/placeholders
// y devuelve evidencia + (si se puede) el PDF de la factura.

const express = require('express');
const puppeteer = require('puppeteer');
const crypto = require('crypto');

const PORT = process.env.PORT || 8080;
const app = express();
app.use(express.json({ limit: '10mb' }));

// CORS simple
app.use((req,res,next)=>{
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/healthz', (req, res) => res.status(200).send('ok'));
const sleep = (ms)=>new Promise(r=>setTimeout(r,ms));

// Encuentra inputs/selects por keywords en name/id/placeholder/aria-label/labels asociadas
async function findInputs(page, keywords) {
  const selector = `input, textarea, select`;
  const kws = keywords.map(k => k.toLowerCase());
  return await page.$$eval(selector, (nodes, kws) => {
    const matches = [];
    function score(node, kws) {
      let s = 0;
      const attrs = [
        node.name || '',
        node.id || '',
        node.placeholder || '',
        node.getAttribute('aria-label') || ''
      ].join(' ').toLowerCase();

      if (node.id) {
        const lbl = document.querySelector(`label[for="${node.id}"]`);
        if (lbl && lbl.textContent) {
          const t = lbl.textContent.toLowerCase();
          for (const kw of kws) if (t.includes(kw)) s += 4;
        }
      }
      let p = node.parentElement;
      while (p && p !== document.body) {
        if (p.tagName.toLowerCase() === 'label' && p.textContent) {
          const t = p.textContent.toLowerCase();
          for (const kw of kws) if (t.includes(kw)) s += 3;
        }
        p = p.parentElement;
      }

      for (const kw of kws) if (attrs.includes(kw)) s += 2;
      const type = (node.getAttribute('type') || '').toLowerCase();
      if (kws.some(k=>k.includes('correo')||k.includes('email')) && type === 'email') s += 2;
      if (kws.some(k=>k.includes('fecha')) && (type === 'date' || type === 'datetime-local')) s += 2;
      return s;
    }
    function getXPath(el) {
      if (el.id) return `//*[@id="${el.id}"]`;
      const parts = [];
      while (el && el.nodeType === Node.ELEMENT_NODE) {
        let nb = 0, idx = 0;
        const sibs = el.parentNode ? el.parentNode.childNodes : [];
        for (let i=0;i<sibs.length;i++) {
          const sib = sibs[i];
          if (sib.nodeType === Node.ELEMENT_NODE && sib.nodeName === el.nodeName) {
            nb++;
            if (sib === el) idx = nb;
          }
        }
        const tagName = el.nodeName.toLowerCase();
        const part = (nb > 1) ? `${tagName}[${idx}]` : tagName;
        parts.unshift(part);
        el = el.parentNode;
      }
      return '//' + parts.join('/');
    }
    for (const node of nodes) {
      const s = score(node, kws);
      if (s > 0) matches.push({ s, xpath: getXPath(node) });
    }
    matches.sort((a,b)=>b.s-a.s);
    return matches.slice(0, 4);
  }, kws);
}

async function fillByKeywords(page, keywords, value) {
  const candidates = await findInputs(page, keywords);
  for (const c of candidates) {
    try {
      const handle = await page.$x(c.xpath);
      if (!handle || !handle[0]) continue;
      const el = handle[0];
      const tag = await page.evaluate(e => e.tagName.toLowerCase(), el);
      if (tag === 'select') {
        await el.select(String(value));
        await el.dispose();
        return true;
      }
      await el.focus();
      await page.evaluate(e => { e.value=''; }, el);
      await el.type(String(value), { delay: 10 });
      await el.dispose();
      return true;
    } catch (err) {
      console.warn('[fillByKeywords] error', err);
    }
  }
  return false;
}

function synonymsFor(key) {
  const map = {
    rfc_receptor: ['rfc receptor','rfc del receptor','rfc cliente','rfc'],
    razon_social_receptor: ['razon social','razón social','nombre fiscal','rs'],
    correo_receptor: ['correo','email','e-mail','mail','correo electronico'],
    rfc_emisor: ['rfc emisor','rfc del emisor','rfc tienda','rfc proveedor'],
    ticket_numero: ['ticket','folio','no. ticket','numero de ticket','número de ticket','id ticket','id compra'],
    sucursal: ['sucursal','tienda','ubicacion','ubicación','no. sucursal','num sucursal'],
    total: ['total','importe','monto','total a pagar','total compra'],
    fecha: ['fecha','fecha de compra','fecha ticket'],
    hora: ['hora','hora de compra','hora ticket'],
    receptor_cp: ['cp','c.p.','codigo postal','código postal','postal'],
    receptor_calle: ['calle','domicilio','direccion','dirección'],
    receptor_numext: ['num ext','num. exterior','numero exterior','número exterior'],
    receptor_colonia: ['colonia','fracc','fraccionamiento'],
    receptor_municipio: ['municipio','delegacion','delegación'],
    receptor_estado: ['estado','entidad']
  };
  return map[key] || [key];
}

async function trySubmit(page) {
  const clickSelectors = ['button', 'input[type="submit"]', 'a[role="button"]', 'a.button', 'a.btn', '.btn', '.button'];
  const texts = ['factur', 'generar', 'continuar', 'siguiente', 'enviar', 'buscar'];
  for (const sel of clickSelectors) {
    const found = await page.$$(sel);
    for (const el of found) {
      const t = (await page.evaluate(e => (e.innerText || e.value || '').toLowerCase(), el)).trim();
      if (texts.some(x => t.includes(x))) { await el.click(); return true; }
    }
  }
  return false;
}

async function detectCaptcha(page) {
  const hasRecaptcha = await page.$('iframe[src*="recaptcha"]');
  const hasHCaptcha = await page.$('iframe[src*="hcaptcha"]');
  const textCaptcha = await page.$x("//*[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'no soy un robot')]");
  return !!(hasRecaptcha || hasHCaptcha || (textCaptcha && textCaptcha.length));
}

async function getPdfIfAny(page) {
  const pdfLink = await page.$('a[href$=".pdf"]');
  if (pdfLink) {
    const href = await page.evaluate(a => a.href, pdfLink);
    try {
      const base64 = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'include' });
        const b = await r.arrayBuffer();
        let binary = ''; const bytes = new Uint8Array(b);
        for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
      }, href);
      return { href, base64 };
    } catch (e) { return { href, error: String(e) }; }
  }
  const candidates = await page.$x("//a[contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'descargar') or contains(translate(text(),'ABCDEFGHIJKLMNOPQRSTUVWXYZ','abcdefghijklmnopqrstuvwxyz'),'factura')]");
  if (candidates && candidates.length) {
    try {
      await candidates[0].click();
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 10000 });
      const a2 = await page.$('a[href$=".pdf"]');
      if (a2) {
        const href = await page.evaluate(a => a.href, a2);
        const base64 = await page.evaluate(async (url) => {
          const r = await fetch(url, { credentials: 'include' });
          const b = await r.arrayBuffer();
          let binary = ''; const bytes = new Uint8Array(b);
          for (let i=0;i<bytes.length;i++) binary += String.fromCharCode(bytes[i]);
          return btoa(binary);
        }, href);
        return { href, base64 };
      }
    } catch (e) { return { error: String(e) }; }
  }
  return null;
}

app.post('/fill', async (req, res) => {
  const uuid = crypto.randomUUID();
  const startedAt = new Date().toISOString();
  const plan = req.body || {};
  const log = [];
  const logAdd = (stage, msg, data) => {
    const entry = { ts: new Date().toISOString(), stage, msg };
    if (data !== undefined) entry.data = data;
    log.push(entry);
    console.log(`[${uuid}] [${stage}] ${msg} ${data?JSON.stringify(data):''}`);
  };
  logAdd('FILL_START', 'Nueva solicitud', { uuid, planKeys: Object.keys(plan||{}) });

  try {
    if (!plan || plan.mode !== 'AUTO_FORM') {
      logAdd('PLAN_INVALID', 'Plan ausente o modo != AUTO_FORM');
      return res.status(400).json({ ok: false, reason: 'bad-plan', log });
    }
    if (!/^https?:\/\//i.test(plan.portal_url || '')) {
      logAdd('PORTAL_INVALID', 'portal_url inválida');
      return res.status(400).json({ ok: false, reason: 'bad-portal', log });
    }

    const launchArgs = ['--no-sandbox','--disable-setuid-sandbox','--disable-dev-shm-usage'];
    const browser = await puppeteer.launch({ headless: 'new', args: launchArgs });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60000);
    page.setDefaultTimeout(60000);

    try {
      logAdd('NAV_GOTO', 'Abriendo portal', { url: plan.portal_url });
      await page.goto(plan.portal_url, { waitUntil: 'domcontentloaded' });
      await page.waitForNetworkIdle({ idleTime: 1000, timeout: 15000 }).catch(()=>{});

      if (await detectCaptcha(page)) {
        const evidence_png_base64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
        await browser.close();
        logAdd('CAPTCHA', 'Captcha detectado');
        return res.json({
          ok: false,
          reason: 'captcha-detected',
          pageTitle: await page.title(),
          finalUrl: page.url(),
          evidence_png_base64,
          log
        });
      }

      const payload = plan.payload || {};
      const keys = Object.keys(payload);
      const fillReport = {};
      for (const key of keys) {
        const value = payload[key];
        const syns = synonymsFor(key);
        const ok = await fillByKeywords(page, syns, value);
        fillReport[key] = { ok, value, syns };
        logAdd('FILL', `Campo ${key}`, { ok, value, syns });
        await sleep(200);
      }

      const clicked = await trySubmit(page);
      logAdd('SUBMIT', 'Intento de submit', { clicked });
      if (clicked) {
        await page.waitForNetworkIdle({ idleTime: 1000, timeout: 20000 }).catch(()=>{});
      }

      const evidence_png_base64 = await page.screenshot({ fullPage: true, encoding: 'base64' });
      const pdf = await getPdfIfAny(page);
      const response = {
        ok: true,
        uuid,
        startedAt,
        finishedAt: new Date().toISOString(),
        pageTitle: await page.title(),
        finalUrl: page.url(),
        fillReport,
        pdfHref: pdf && pdf.href ? pdf.href : null,
        invoice_pdf_base64: pdf && pdf.base64 ? pdf.base64 : null,
        evidence_png_base64,
        log
      };

      await browser.close();
      logAdd('DONE', 'Proceso completado');
      return res.json(response);

    } catch (err) {
      const evidence_png_base64 = await page.screenshot({ fullPage: true, encoding: 'base64' }).catch(()=>null);
      await browser.close();
      logAdd('ERROR', 'Excepción dentro de navegador', { err: String(err) });
      return res.status(500).json({
        ok: false,
        reason: 'exception',
        error: String(err),
        evidence_png_base64,
        log
      });
    }

  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, reason: 'server-error', error: String(err) });
  }
});

app.listen(PORT, () => {
  console.log(`[startup] listening on :${PORT}`);
});
