const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
app.use(bodyParser.json({limit: '10mb'}));

app.get('/healthz', (req, res) => res.json({ok: true}));

app.post('/fill', async (req, res) => {
  const plan = req.body;
  let browser, page;
  try {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    page = await browser.newPage();
    if (plan.portal_url) {
      await page.goto(plan.portal_url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    // demo: screenshot evidencia
    const screenshot = await page.screenshot({ encoding: 'base64' });
    res.json({
      ok: true,
      uuid: Date.now().toString(),
      pageTitle: await page.title(),
      finalUrl: page.url(),
      evidence_png_base64: screenshot
    });
  } catch (err) {
    res.status(500).json({ok: false, error: err.message});
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Backend listening on ' + PORT));
