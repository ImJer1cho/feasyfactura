const express = require('express');
const bodyParser = require('body-parser');
const puppeteer = require('puppeteer');

const app = express();
app.use(bodyParser.json({ limit: '10mb' }));

// Endpoint health
app.get('/healthz', (req, res) => res.send('ok'));

// Endpoint principal
app.post('/fill', async (req, res) => {
  const plan = req.body;
  let browser;
  try {
    browser = await puppeteer.launch({
      args: ["--no-sandbox", "--disable-setuid-sandbox"]
    });
    const page = await browser.newPage();
    if (plan.portal_url) {
      await page.goto(plan.portal_url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }
    // Aquí va la lógica de llenado de formularios (placeholder)
    const result = {
      ok: true,
      pageTitle: await page.title(),
      finalUrl: page.url(),
      receivedPayload: plan.payload
    };
    res.json(result);
  } catch (err) {
    console.error(err);
    res.status(500).json({ ok: false, error: err.message });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
