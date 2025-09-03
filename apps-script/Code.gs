// Code.gs — Versión completa para Gmail+Drive+OpenAI Responses API + Backend Puppeteer
/****************************************************
 * FACTURACIÓN POR TICKET (Visión) + Gmail + Drive + Backend Render
 * LOGS DETALLADOS de cada paso + STRICT→LOOSE fallback.
 ****************************************************/

const LOG = {
  runId: Utilities.getUuid(),
  startedAt: new Date().toISOString(),
  timeline: [],
  meta: {}
};
function logEvent(level, stage, msg, data, ms) {
  const entry = { ts: new Date().toISOString(), level, stage, msg };
  if (data !== undefined) entry.data = data;
  if (ms !== undefined) entry.ms = ms;
  LOG.timeline.push(entry);
  Logger.log(`[${LOG.runId}] [${level}] [${stage}] ${msg}${ms!==undefined?` (${ms}ms)`:''}${data?` — `+JSON.stringify(data):''}`);
}
const logInfo  = (s,m,d,ms)=>logEvent('INFO',  s,m,d,ms);
const logWarn  = (s,m,d,ms)=>logEvent('WARN',  s,m,d,ms);
const logError = (s,m,d,ms)=>logEvent('ERROR', s,m,d,ms);

const CFG = (() => {
  const p = PropertiesService.getScriptProperties();
  const cfg = {
    OPENAI_API_KEY: p.getProperty('OPENAI_API_KEY'),
    ROOT_FOLDER_ID: p.getProperty('ROOT_FOLDER_ID'),
    TO_ADDRESS: p.getProperty('TO_ADDRESS') || 'daniel@mindandcreation.tech',
    SUBJECT_FILTER: p.getProperty('SUBJECT_FILTER') || 'FACTURAR',
    MODEL: p.getProperty('MODEL') || 'gpt-4o',
    PUPPETEER_WEBHOOK_URL: p.getProperty('PUPPETEER_WEBHOOK_URL') || '',
    RECEPTOR_RFC: p.getProperty('RECEPTOR_RFC') || '',
    RECEPTOR_RAZON: p.getProperty('RECEPTOR_RAZON') || '',
    RECEPTOR_CORREO: p.getProperty('RECEPTOR_CORREO') || '',
    EMISOR_RFC: p.getProperty('EMISOR_RFC') || '',
    RECEPTOR_CP: p.getProperty('RECEPTOR_CP') || '',
    RECEPTOR_CALLE: p.getProperty('RECEPTOR_CALLE') || '',
    RECEPTOR_NUMEXT: p.getProperty('RECEPTOR_NUMEXT') || '',
    RECEPTOR_COLONIA: p.getProperty('RECEPTOR_COLONIA') || '',
    RECEPTOR_MUNICIPIO: p.getProperty('RECEPTOR_MUNICIPIO') || '',
    RECEPTOR_ESTADO: p.getProperty('RECEPTOR_ESTADO') || '',
    MAX_THREADS: 10,
    ALLOWED_MIME: new Set(['image/jpeg','image/png','application/pdf']),
    ATTACH_ARTIFACTS_TO_EMAIL: true
  };
  logInfo('CFG','Config inicializada', {...cfg, OPENAI_API_KEY:'***'});
  return cfg;
})();

function instalarTrigger() {
  ScriptApp.getProjectTriggers().forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('tick').timeBased().everyMinutes(5).create();
  logInfo('TRIGGER','Trigger instalado cada 5m');
}

function tick() {
  logInfo('TICK_START', 'Inicio ciclo', { now: new Date().toISOString(), to: CFG.TO_ADDRESS, subjectFilter: CFG.SUBJECT_FILTER });

  const base = `subject:"${CFG.SUBJECT_FILTER}" has:attachment -in:chats`;
  const strictQ = `to:${CFG.TO_ADDRESS} ${base} is:unread`;
  const looseQ  = `${base} newer_than:30d`;

  logInfo('SEARCH_STRICT','Buscando hilos', {query: strictQ});
  let t0 = Date.now();
  let threads = GmailApp.search(strictQ, 0, CFG.MAX_THREADS);
  logInfo('SEARCH_STRICT','Resultados', {count: threads.length, sample: snapshotThreads_(threads)}, Date.now()-t0);

  if (threads.length === 0) {
    logWarn('SEARCH_LOOSE','STRICT sin resultados; probando LOOSE', {fallbackQuery: looseQ});
    t0 = Date.now();
    threads = GmailApp.search(looseQ, 0, CFG.MAX_THREADS);
    logInfo('SEARCH_LOOSE','Resultados', {count: threads.length, sample: snapshotThreads_(threads)}, Date.now()-t0);
    if (threads.length === 0) {
      logWarn('SEARCH_END','No se encontraron hilos');
      return;
    }
  }

  threads.forEach((th, i) => {
    logInfo('THREAD_OPEN', 'Abriendo hilo', { index: i, threadId: th.getId() });
    procesarHilo(th);
  });

  logInfo('TICK_END', 'Ciclo terminado');
}

function snapshotThreads_(threads) {
  return threads.slice(0, 5).map(th => {
    const msgs = th.getMessages();
    const last = msgs[msgs.length-1];
    return {
      threadId: th.getId(),
      msgs: msgs.length,
      lastSubj: (last && last.getSubject()) || '',
      lastFrom: (last && parseEmail_(last.getFrom())) || '',
      lastDate: (last && last.getDate()) || '',
      unread: th.isUnread()
    };
  });
}

function procesarHilo(thread) {
  const t0 = Date.now();
  try {
    LOG.meta.threadId = thread.getId();

    const messages = thread.getMessages();
    logInfo('THREAD', 'Mensajes en hilo', {count: messages.length});

    for (let idx=0; idx<messages.length; idx++) {
      const msg = messages[idx];
      LOG.meta.messageId = msg.getId();
      LOG.meta.subject   = msg.getSubject();
      LOG.meta.date      = msg.getDate();
      LOG.meta.from      = parseEmail_(msg.getFrom());
      logInfo('MSG_OPEN','Procesando mensaje', { idx, ...LOG.meta });

      if (yaProcesado_(msg)) {
        logWarn('MSG_SKIP','Ya procesado', {messageId: msg.getId()});
        continue;
      }

      const subj = (msg.getSubject() || '').toUpperCase();
      if (!subj.includes(CFG.SUBJECT_FILTER.toUpperCase())) {
        logWarn('MSG_SKIP','Subject no coincide con SUBJECT_FILTER', {subject: subj, filter: CFG.SUBJECT_FILTER});
        marcarProcesado_(msg, {skipped:true, reason:'subject-mismatch'});
        continue;
      }
      const toList = (msg.getTo() || '').toLowerCase();
      if (!toList.includes(CFG.TO_ADDRESS.toLowerCase())) {
        logWarn('MSG_NOTE','TO no contiene TO_ADDRESS (alias/reenviado?)', {toList, toAddress: CFG.TO_ADDRESS});
      }

      const threadFolder = ensureThreadFolder_(thread.getId());
      logInfo('DRIVE','Carpeta hilo lista', {folderUrl: getUrl_(threadFolder)});

      const atts = msg.getAttachments({includeInlineImages:true});
      logInfo('ATTACH_GET','Adjuntos recibidos', {total: atts.length, types: atts.map(a=>a.getContentType()), names: atts.map(a=>a.getName())});
      const savedFiles = saveValidAttachments_(atts, threadFolder);
      logInfo('ATTACH_SAVE','Adjuntos válidos guardados', {count: savedFiles.length, files: savedFiles.map(f=>({name:f.getName(), url:getUrl_(f)}))});
      if (!savedFiles.length) { marcarProcesado_(msg, {error:'no-valid-attachments'}); continue; }

      const schema = buildJsonSchema_();
      const inputItems = buildVisionInput_(msg, savedFiles);
      let extraction;
      try {
        logInfo('OPENAI_REQ','Llamando a OpenAI', {items: inputItems.length, model: CFG.MODEL});
        extraction = callOpenAIExtract_(inputItems, schema);
        logInfo('OPENAI_RES','Extracción OK', {
          portal: extraction?.instrucciones?.portal_url || null,
          ticket: extraction?.ticket?.numero || null, total: extraction?.ticket?.total || null
        });
      } catch (e) {
        logError('OPENAI_ERR','Fallo extracción', {err:String(e)});
        marcarProcesado_(msg, {error:'openai-failed', err:String(e)});
        continue;
      }
      extraction.__sender = LOG.meta.from;

      const plan = decidePlan_(extraction);
      logInfo('PLAN','Plan decidido', {mode:plan.mode, portal:plan.portal_url, payloadKeys:Object.keys(plan.payload||{})});

      let planResult = null;
      if (plan.mode === 'AUTO_FORM' && CFG.PUPPETEER_WEBHOOK_URL) {
        logInfo('BACKEND_POST','POST al backend', {url: CFG.PUPPETEER_WEBHOOK_URL, portal: plan.portal_url});
        planResult = runPuppeteerPlan_(plan);
        logInfo('BACKEND_RES','Respuesta backend', {
          ok: !!(planResult && planResult.ok),
          code: planResult && planResult.code,
          error: planResult && planResult.error,
          uuid: planResult && planResult.uuid,
          finalUrl: planResult && planResult.finalUrl
        });

        if (!planResult || !planResult.ok) {
          plan.mode = 'MANUAL_LINK';
          plan.fallbackReason = (planResult && (planResult.error || planResult.reason)) || 'backend-failed';
          logWarn('PLAN','Fallback a MANUAL_LINK', {reason: plan.fallbackReason});
        }
      } else {
        logWarn('PLAN','MANUAL_LINK forzado', {why: !CFG.PUPPETEER_WEBHOOK_URL ? 'no-webhook' : 'captcha/notas'});
      }

      const artifacts = persistArtifacts_(threadFolder, { extraction, plan, planResult }, savedFiles);
      logInfo('DRIVE','Artefactos escritos', artifacts.links);

      const attachments = buildEmailAttachments_(savedFiles, artifacts, planResult);
      logInfo('EMAIL','Adjuntos de salida', {count: attachments.length});

      const html = buildHtmlConfirmation_(extraction, plan, artifacts.links, savedFiles, planResult);
      GmailApp.sendEmail(LOG.meta.from, buildSubject_(extraction), 'Tu solicitud fue procesada.', {
        htmlBody: html, replyTo: LOG.meta.from, attachments
      });
      logInfo('EMAIL_SEND','Correo de confirmación enviado', {to: LOG.meta.from});

      marcarProcesado_(msg, {ok:true, mode:plan.mode, artifacts:artifacts.links});
      logInfo('MSG_DONE','Mensaje marcado como procesado', {messageId: msg.getId()});
    }

    thread.markRead();
    logInfo('THREAD_END','Hilo marcado leído', {threadId: thread.getId(), ms: Date.now()-t0});

  } catch (err) {
    logError('THREAD_ERR','Error general', {err:String(err), stack:(err && err.stack)||''});
  }
}

// ---------- IA ----------
function buildJsonSchema_() {
  return {
    type: "object",
    properties: {
      comercio: { type:"object", properties:{
        nombre:{type:"string"}, rfc:{type:"string"}, sucursal:{type:"string"}, direccion:{type:"string"}
      }},
      ticket: { type:"object", properties:{
        numero:{type:"string"}, orden:{type:"string"},
        fecha:{type:"string", description:"YYYY-MM-DD"},
        hora:{type:"string", description:"HH:MM:SS"},
        subtotal:{type:"number"}, iva:{type:"number"}, total:{type:"number"},
        moneda:{type:"string"}
      }},
      instrucciones: { type:"object", properties:{
        portal_url:{type:"string"}, plazo:{type:"string"},
        campos_requeridos:{type:"array", items:{type:"string"}}, notas:{type:"string"}
      }},
      receptor: { type:"object", properties:{
        rfc:{type:"string"}, razon_social:{type:"string"}, correo:{type:"string"}
      }},
      conceptos: { type:"array", items:{ type:"object", properties:{
        descripcion:{type:"string"}, cantidad:{type:"number"}, precio_unitario:{type:"number"}, iva:{type:"number"}
      }}}
    },
    required: ["ticket","instrucciones"]
  };
}
function buildVisionInput_(msg, files) {
  const parts = [];
  parts.push({ role:"system",
    content:"Eres un agente de facturación en México. Lee uno o dos lados del ticket; extrae datos de compra y DETECTA las instrucciones para facturar (portal, plazo, campos requeridos). Devuelve JSON estricto al schema."
  });
  parts.push({ role:"user", content:`Correo: ${msg.getFrom()} | Asunto: ${msg.getSubject()} | Fecha: ${msg.getDate()}` });
  for (const f of files) {
    const blob = f.getBlob(); const mime = blob.getContentType(); const b64 = Utilities.base64Encode(blob.getBytes());
    parts.push({ role:"user", content:[
      { type:"input_text",  text:`Adjunto: ${f.getName()} (${mime}). Analiza texto de instrucciones y datos del ticket.` },
      { type:"input_image", image_data:{ data:b64, mime_type:mime } }
    ]});
  }
  logInfo('OPENAI_PROMPT','Prompt visión preparado', {items: parts.length});
  return parts;
}
function callOpenAIExtract_(inputItems, jsonSchema) {
  const url = 'https://api.openai.com/v1/responses';
  const body = {
    model: CFG.MODEL,
    input: inputItems,
    text: {
      format: {
        type: "json_schema",
        json_schema: {
          name: "ticket_facturacion_schema",
          schema: jsonSchema,
          strict: true
        }
      }
    }
  };
  const t0 = Date.now();
  const res = UrlFetchApp.fetch(url, {
    method:'post',
    contentType:'application/json',
    headers:{ Authorization:`Bearer ${CFG.OPENAI_API_KEY}` },
    payload: JSON.stringify(body),
    muteHttpExceptions:true
  });
  const ms = Date.now()-t0;
  logInfo('OPENAI_HTTP','Respuesta', {code: res.getResponseCode(), bytes: res.getContent().length}, ms);
  const txt = res.getContentText();
  if (res.getResponseCode() >= 300) throw new Error('OpenAI error '+res.getResponseCode()+': '+txt);
  const obj = JSON.parse(txt);
  if (obj.output_parsed) return obj.output_parsed;
  if (obj.output_text)  { try { return JSON.parse(obj.output_text); } catch(e){} }
  if (Array.isArray(obj.content)) {
    const t = obj.content.map(c => c.text || '').join('\n');
    try { return JSON.parse(t); } catch(e){}
  }
  throw new Error('No se pudo obtener JSON estructurado de la API.');
}

// ---------- Plan & Backend ----------
function decidePlan_(extraction) {
  const portal = (extraction.instrucciones && extraction.instrucciones.portal_url || '').trim();
  const required = extraction.instrucciones?.campos_requeridos || [];
  const notas = (extraction.instrucciones?.notas || '').toLowerCase();
  const captchaish = /captcha|recaptcha|qr|app|humano|no soy/i.test(notas);

  let rfcReceptor   = extraction.receptor?.rfc || '';
  let razonReceptor = extraction.receptor?.razon_social || '';
  let correoReceptor= extraction.receptor?.correo || '';
  if (!rfcReceptor   && CFG.RECEPTOR_RFC)   rfcReceptor   = CFG.RECEPTOR_RFC;
  if (!razonReceptor && CFG.RECEPTOR_RAZON) razonReceptor = CFG.RECEPTOR_RAZON;
  if (!correoReceptor&& CFG.RECEPTOR_CORREO)correoReceptor= CFG.RECEPTOR_CORREO;

  let rfcEmisor = extraction.comercio?.rfc || '';
  if (!rfcEmisor && CFG.EMISOR_RFC) rfcEmisor = CFG.EMISOR_RFC;

  const mode = (CFG.PUPPETEER_WEBHOOK_URL && portal && !captchaish) ? 'AUTO_FORM' : 'MANUAL_LINK';

  return {
    mode,
    portal_url: portal,
    required_fields: required,
    payload: {
      ticket_numero: extraction.ticket?.numero || '',
      fecha: extraction.ticket?.fecha || '',
      hora: extraction.ticket?.hora || '',
      total: extraction.ticket?.total || '',
      sucursal: extraction.comercio?.sucursal || '',
      rfc_emisor: rfcEmisor,
      rfc_receptor: rfcReceptor,
      razon_social_receptor: razonReceptor,
      correo_receptor: correoReceptor,
      receptor_cp: CFG.RECEPTOR_CP || '',
      receptor_calle: CFG.RECEPTOR_CALLE || '',
      receptor_numext: CFG.RECEPTOR_NUMEXT || '',
      receptor_colonia: CFG.RECEPTOR_COLONIA || '',
      receptor_municipio: CFG.RECEPTOR_MUNICIPIO || '',
      receptor_estado: CFG.RECEPTOR_ESTADO || ''
    },
    notes: notas
  };
}
function runPuppeteerPlan_(plan) {
  try {
    const url = CFG.PUPPETEER_WEBHOOK_URL;
    const res = UrlFetchApp.fetch(url, {
      method:'post', contentType:'application/json',
      payload: JSON.stringify(plan), muteHttpExceptions:true
    });
    const code = res.getResponseCode();
    const text = res.getContentText();
    logInfo('BACKEND_HTTP','Respuesta', {code, bytes: res.getContent().length});
    let json = null; try { json = JSON.parse(text); } catch(e){}
    return (code < 300 && json) ? json : { ok:false, code, error: text || ('HTTP '+code) };
  } catch (e) {
    logError('BACKEND_ERR','Excepción llamando backend', {err:String(e)});
    return { ok:false, error:String(e) };
  }
}

// ---------- Persistencia & Email ----------
function saveValidAttachments_(atts, folder) {
  const out = [];
  for (const a of atts) {
    const ct = a.getContentType();
    if (!CFG.ALLOWED_MIME.has(ct)) { logWarn('ATTACH_IGN','Ignorado por MIME', {mime:ct, name:a.getName()}); continue; }
    const f = folder.createFile(a.copyBlob()); f.setName(a.getName()); out.push(f);
  }
  return out;
}
function ensureThreadFolder_(threadId) {
  const root = DriveApp.getFolderById(CFG.ROOT_FOLDER_ID);
  const tz = Session.getScriptTimeZone();
  const today = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd');
  const f1 = getOrCreateChild_(root, today);
  return getOrCreateChild_(f1, threadId);
}
function getOrCreateChild_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : parent.createFolder(name);
}
function persistArtifacts_(folder, data, savedFiles) {
  const out = getOrCreateChild_(folder, 'salidas');
  const fullLog = {
    runId: LOG.runId,
    startedAt: LOG.startedAt,
    finishedAt: new Date().toISOString(),
    meta: LOG.meta,
    timeline: LOG.timeline
  };
  const logFile = out.createFile(Utilities.newBlob(JSON.stringify(fullLog, null, 2), 'application/json', 'LOG.json'));
  const artifactsFile = out.createFile(Utilities.newBlob(JSON.stringify(data, null, 2), 'application/json', 'artifacts.json'));
  let evidenceFile = null, pdfFile = null;
  if (data.planResult && data.planResult.evidence_png_base64) {
    const png = Utilities.base64Decode(data.planResult.evidence_png_base64);
    evidenceFile = out.createFile(Utilities.newBlob(png, 'image/png', 'evidencia.png'));
  }
  if (data.planResult && data.planResult.invoice_pdf_base64) {
    const pdf = Utilities.base64Decode(data.planResult.invoice_pdf_base64);
    pdfFile = out.createFile(Utilities.newBlob(pdf, 'application/pdf', 'factura.pdf'));
  }
  return {
    links: {
      folder: getUrl_(out),
      artifacts: getUrl_(artifactsFile),
      log: getUrl_(logFile),
      evidence: evidenceFile ? getUrl_(evidenceFile) : null,
      pdf: pdfFile ? getUrl_(pdfFile) : null
    },
    fileIds: {
      artifacts: artifactsFile.getId(),
      log: logFile.getId(),
      evidence: evidenceFile ? evidenceFile.getId() : null,
      pdf: pdfFile ? pdfFile.getId() : null
    }
  };
}
function buildEmailAttachments_(savedFiles, artifacts) {
  if (!CFG.ATTACH_ARTIFACTS_TO_EMAIL) return [];
  const blobs = [];
  for (const f of savedFiles) try { blobs.push(f.getBlob().setName(f.getName())); } catch(e){}
  try { if (artifacts.fileIds.artifacts) blobs.push(DriveApp.getFileById(artifacts.fileIds.artifacts).getBlob().setName('artifacts.json')); } catch(e){}
  try { if (artifacts.fileIds.log)       blobs.push(DriveApp.getFileById(artifacts.fileIds.log).getBlob().setName('LOG.json')); } catch(e){}
  try { if (artifacts.fileIds.evidence)  blobs.push(DriveApp.getFileById(artifacts.fileIds.evidence).getBlob().setName('evidencia.png')); } catch(e){}
  try { if (artifacts.fileIds.pdf)       blobs.push(DriveApp.getFileById(artifacts.fileIds.pdf).getBlob().setName('factura.pdf')); } catch(e){}
  return blobs;
}
function buildSubject_(ex) {
  const num = ex.ticket?.numero ? ` ${ex.ticket.numero}` : '';
  return `Confirmación de facturación${num}`;
}
function buildHtmlConfirmation_(ex, plan, links, files, planResult) {
  const conceptos = (ex.conceptos || []).map(c => `
    <tr><td>${esc_(c.descripcion||'')}</td><td>${esc_(c.cantidad||'')}</td><td>${esc_(c.precio_unitario||'')}</td><td>${esc_(c.iva||'')}</td></tr>
  `).join('');
  const fileLinks = files.map(f => `<li><a href="${getUrl_(f)}" target="_blank">${esc_(f.getName())}</a></li>`).join('');
  const manualBlock = `
    <h3>Portal e Instrucciones (según el ticket)</h3>
    <p><b>Portal:</b> ${plan.portal_url ? `<a href="${esc_(plan.portal_url)}" target="_blank">${esc_(plan.portal_url)}</a>` : '—'}</p>
    <p><b>Campos requeridos:</b> ${esc_((plan.required_fields||[]).join(', ') || '—')}</p>
    <p><b>Plazo:</b> ${esc_(ex.instrucciones?.plazo || '—')}</p>
    <p><b>Datos prellenados:</b></p>
    <ul>
      <li>Ticket: ${esc_(plan.payload.ticket_numero||'')}</li>
      <li>Fecha/Hora: ${esc_(plan.payload.fecha||'')} ${esc_(plan.payload.hora||'')}</li>
      <li>Total: ${esc_(plan.payload.total||'')}</li>
      <li>Sucursal: ${esc_(plan.payload.sucursal||'')}</li>
      <li>RFC Emisor: ${esc_(plan.payload.rfc_emisor||'')}</li>
      <li>RFC Receptor: ${esc_(plan.payload.rfc_receptor||'')}</li>
      <li>Razón Social Receptor: ${esc_(plan.payload.razon_social_receptor||'')}</li>
      <li>Correo Receptor: ${esc_(plan.payload.correo_receptor||'')}</li>
    </ul>`;
  let modeBlock = '';
  if (plan.mode === 'AUTO_FORM') {
    modeBlock = (planResult && planResult.ok)
      ? `<p>Modo: <b>AUTO_FORM</b> ✅</p>
         <ul>
           <li>Título: ${esc_(planResult.pageTitle||'—')}</li>
           <li>URL final: ${esc_(planResult.finalUrl||'—')}</li>
           <li>UUID: ${esc_(planResult.uuid||'—')}</li>
           <li>PDF: ${planResult.invoice_pdf_base64 ? '✅ adjunto' : '—'}</li>
           <li>Evidencia: ${links.evidence ? `<a href="${links.evidence}" target="_blank">evidencia.png</a>` : '—'}</li>
         </ul>`
      : `<p>Modo: <b>AUTO_FORM</b> ❌ (fallback)</p>
         <p>Motivo: ${esc_((planResult && (planResult.error || planResult.reason)) || 'desconocido')}</p>
         ${manualBlock}`;
  } else {
    modeBlock = `<p>Modo: <b>MANUAL_LINK</b></p>${manualBlock}`;
  }
  return `
  <div style="font-family:Inter,Arial,sans-serif">
    <h2>Confirmación de proceso de facturación</h2>
    <p><b>Comercio:</b> ${esc_(ex.comercio?.nombre || '—')} · RFC: ${esc_(ex.comercio?.rfc || '—')} · Sucursal: ${esc_(ex.comercio?.sucursal || '—')}</p>
    <p><b>Ticket #:</b> ${esc_(ex.ticket?.numero || '—')} · <b>Fecha:</b> ${esc_(ex.ticket?.fecha || '—')} · <b>Hora:</b> ${esc_(ex.ticket?.hora || '—')}</p>
    <p><b>Subtotal:</b> ${esc_(ex.ticket?.subtotal || '—')} · <b>IVA:</b> ${esc_(ex.ticket?.iva || '—')} · <b>Total:</b> ${esc_(ex.ticket?.total || '—')}</p>
    ${modeBlock}
    ${conceptos ? `<h3>Conceptos</h3>
      <table border="1" cellpadding="6" cellspacing="0">
        <thead><tr><th>Descripción</th><th>Cantidad</th><th>PU</th><th>IVA</th></tr></thead>
        <tbody>${conceptos}</tbody>
      </table>` : ''}
    <h3>Adjuntos originales</h3><ul>${fileLinks}</ul>
    <h3>Artefactos</h3>
    <ul>
      <li>artifacts.json: <a href="${links.artifacts}" target="_blank">abrir</a></li>
      <li>LOG.json: <a href="${links.log}" target="_blank">abrir</a></li>
      ${links.pdf ? `<li>Factura PDF: <a href="${links.pdf}" target="_blank">descargar</a></li>` : ''}
      ${links.evidence ? `<li>Evidencia: <a href="${links.evidence}" target="_blank">ver</a></li>` : ''}
      <li>Carpeta: <a href="${links.folder}" target="_blank">abrir</a></li>
    </ul>
  </div>`;
}

// ---------- Utils & Estado ----------
function getUrl_(fileOrFolder) { return 'https://drive.google.com/open?id=' + fileOrFolder.getId(); }
function esc_(s) { return String(s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function parseEmail_(from) { const m = /<([^>]+)>/.exec(from || ''); return (m && m[1]) || (from || '').trim(); }

function yaProcesado_(msg) {
  const force = (PropertiesService.getScriptProperties().getProperty('FORCE_REPROCESS') || '').toLowerCase() === 'true';
  if (force) { logWarn('STATE','FORCE_REPROCESS activo: ignorando marca', {messageId: msg.getId()}); return false; }
  const done = PropertiesService.getUserProperties().getProperty('processed_' + msg.getId()) === '1';
  if (done) logInfo('STATE','yaProcesado = true', {messageId: msg.getId()});
  return done;
}
function ensureLabel_(name){ return GmailApp.getUserLabelByName(name) || GmailApp.createLabel(name); }
function marcarProcesado_(msg, extra) {
  const sp = PropertiesService.getScriptProperties();
  const markErrors = (sp.getProperty('MARK_ERRORS_AS_PROCESSED') || 'true').toLowerCase() === 'true';
  if (extra && extra.error && !markErrors) {
    logWarn('STATE','No se marca como procesado por error (policy)', {messageId: msg.getId(), error: extra.error});
    return;
  }
  const up = PropertiesService.getUserProperties();
  up.setProperty('processed_' + msg.getId(), '1');
  if (extra) up.setProperty('log_' + msg.getId(), JSON.stringify(extra));
  try {
    const label = ensureLabel_('feasyfactura/processed');
    const th = GmailApp.getThreadById(LOG.meta.threadId);
    if (th) th.addLabel(label);
  } catch(e) {
    logWarn('GMAIL','No se pudo etiquetar el hilo', {err:String(e), threadId: LOG.meta.threadId});
  }
  logInfo('STATE','Marcado procesado', {messageId: msg.getId(), extra});
}

// ---------- Debug Helpers ----------
function whoRuns() {
  try { Logger.log('Effective user: ' + Session.getEffectiveUser().getEmail()); }
  catch(e){ Logger.log('No fue posible obtener el usuario: ' + e); }
}
function debugSearch() {
  const q1 = `to:${CFG.TO_ADDRESS} subject:"${CFG.SUBJECT_FILTER}" is:unread`;
  const q2 = `subject:"${CFG.SUBJECT_FILTER}" has:attachment newer_than:30d`;
  const q3 = `subject:${CFG.SUBJECT_FILTER} newer_than:30d`;
  [q1,q2,q3].forEach((q,i)=>{
    const th = GmailApp.search(q,0,10);
    Logger.log(`Q${i+1}: ${q} -> threads=${th.length}`);
    th.forEach(t=>{
      const m=t.getMessages().slice(-1)[0];
      Logger.log(`  - subj="${m.getSubject()}", to="${m.getTo()}", from="${m.getFrom()}", unread=${t.isUnread()}`);
    });
  });
}
function listProcessed() {
  const all = PropertiesService.getUserProperties().getProperties();
  Logger.log(JSON.stringify(Object.keys(all).filter(k => k.startsWith('processed_'))));
}
function clearProcessedAll() {
  const up = PropertiesService.getUserProperties();
  Object.keys(up.getProperties()).forEach(k => { if (k.startsWith('processed_')) up.deleteProperty(k); });
  Logger.log('Todas las marcas processed_* eliminadas');
}
function clearProcessedByMessageId(messageId) {
  PropertiesService.getUserProperties().deleteProperty('processed_' + messageId);
  Logger.log('Eliminada processed_' + messageId);
}
function reprocessThread(threadId) {
  const th = GmailApp.getThreadById(threadId);
  if (!th) { Logger.log('No existe ' + threadId); return; }
  th.getMessages().forEach(m => clearProcessedByMessageId(m.getId()));
  Logger.log('Marcas borradas para threadId=' + threadId + '. Reprocesando…');
  procesarHilo(th);
}
function pingBackend() {
  const base = (CFG.PUPPETEER_WEBHOOK_URL || '').replace(/\/fill\/?$/,'');
  const url = base + '/healthz';
  const res = UrlFetchApp.fetch(url, { muteHttpExceptions:true });
  Logger.log('healthz -> ' + res.getResponseCode() + ' ' + res.getContentText());
}
function smokeTestFill() {
  const plan = {
    mode: "AUTO_FORM",
    portal_url: "https://www.facturacionmcdonalds.com.mx",
    required_fields: [],
    payload: {
      ticket_numero: "000010872",
      fecha: "2025-08-20",
      hora: "18:03:51",
      total: 1110.00,
      sucursal: "855 TORRES LINDAVISTA",
      rfc_emisor: "RAD161031RK1",
      rfc_receptor: CFG.RECEPTOR_RFC,
      razon_social_receptor: CFG.RECEPTOR_RAZON,
      correo_receptor: CFG.RECEPTOR_CORREO
    },
    notes: ""
  };
  const res = UrlFetchApp.fetch(CFG.PUPPETEER_WEBHOOK_URL, {
    method:'post', contentType:'application/json',
    payload: JSON.stringify(plan), muteHttpExceptions:true
  });
  Logger.log('fill -> ' + res.getResponseCode() + ' ' + res.getContentText().slice(0,500));
}
function testOnce() { tick(); }
