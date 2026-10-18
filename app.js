/**
 * Despesas IA — leitor de recibos e notas em lote.
 *
 * Fluxo: o membro arrasta fotos/PDFs de comprovantes → cada arquivo é preparado
 * no navegador (canvas / pdf.js) → um modelo com visão (OpenRouter, chave do
 * próprio membro) lê CADA comprovante com o mesmo esquema e a mesma lista de
 * categorias → o membro confere os lançamentos lado a lado com a imagem → o
 * código (nunca a IA) soma, detecta duplicados e gera .xlsx, .csv e o PDF.
 *
 * Tudo fica neste navegador (IndexedDB + localStorage). Nada passa pelos nossos
 * servidores: as imagens vão direto do navegador para o provedor da chave.
 */
const App = (function () {
  'use strict';

  // ── slot names (COR-025: never `*KEY = '<hyphenated literal>'`) ──
  var DB_NAME = 'despesas_ia_db';
  var DB_STORE = 'lotes';
  var INDEX_SLOT = 'despesas_index';
  var CURRENT_SLOT = 'despesas_current';

  var MAX_FILES = 60;
  var MAX_PDF_PAGES = 2;
  var CONCURRENCY = 3;
  var IMG_EDGE = 1600;
  var THUMB_EDGE = 420;
  var LOW_CONFIDENCE = 0.75;

  var CATEGORIES = [
    'Alimentação',
    'Transporte e combustível',
    'Hospedagem e viagem',
    'Material de escritório',
    'Software e assinaturas',
    'Marketing e anúncios',
    'Serviços de terceiros',
    'Equipamentos',
    'Contas de consumo',
    'Aluguel',
    'Impostos e taxas',
    'Saúde',
    'Educação e cursos',
    'Outros'
  ];
  var CAT_HINTS = {
    'Alimentação': 'restaurante, lanchonete, café, padaria, mercado, delivery de comida',
    'Transporte e combustível': 'posto, combustível, estacionamento, pedágio, táxi, app de corrida, ônibus, metrô',
    'Hospedagem e viagem': 'hotel, pousada, passagem aérea/rodoviária, aluguel de carro',
    'Material de escritório': 'papelaria, impressão, cartuchos, material de escritório',
    'Software e assinaturas': 'SaaS, apps, assinaturas digitais, hospedagem de site, domínio',
    'Marketing e anúncios': 'anúncios, impulsionamento, brindes, gráfica de divulgação',
    'Serviços de terceiros': 'freelancer, prestador de serviço, consultoria, contador',
    'Equipamentos': 'eletrônicos, computador, celular, móveis, ferramentas',
    'Contas de consumo': 'luz, água, gás, internet, telefone',
    'Aluguel': 'aluguel de imóvel/sala, condomínio, coworking',
    'Impostos e taxas': 'DAS, guias, tarifas bancárias, taxas de cartório',
    'Saúde': 'farmácia, consulta, exames, plano de saúde',
    'Educação e cursos': 'cursos, livros, eventos, treinamentos',
    'Outros': 'qualquer coisa que não se encaixe acima'
  };
  var PAYMENTS = [
    { id: 'pix', label: 'Pix' },
    { id: 'credito', label: 'Cartão de crédito' },
    { id: 'debito', label: 'Cartão de débito' },
    { id: 'dinheiro', label: 'Dinheiro' },
    { id: 'boleto', label: 'Boleto' },
    { id: 'transferencia', label: 'Transferência' },
    { id: 'outro', label: 'Outro' },
    { id: 'nao_informado', label: 'Não informado' }
  ];
  var FINALIDADES = {
    controle: 'Controle das minhas despesas',
    reembolso: 'Pedido de reembolso',
    cliente: 'Prestação de contas a um cliente',
    contador: 'Enviar para o contador'
  };
  var DOC_TYPES = {
    cupom_fiscal: 'Cupom fiscal', nota_fiscal: 'Nota fiscal (DANFE)', nfse: 'Nota de serviço (NFS-e)',
    recibo: 'Recibo', comprovante_pix: 'Comprovante de Pix', comprovante_cartao: 'Comprovante de cartão',
    fatura: 'Fatura / conta', boleto: 'Boleto', outro: 'Outro documento'
  };
  var FIELD_LABEL = { date: 'data', merchant: 'estabelecimento', taxId: 'CNPJ/CPF', total: 'valor', category: 'categoria', payment: 'forma de pagamento', desc: 'descrição' };

  var state = { lote: null, db: null, dbFailed: false, running: false, stopReq: false, controllers: [], filter: 'todos', catFilter: '', wired: false, pdfjs: null, justPrinted: {} };

  // ── utils ─────────────────────────────────────────────────────────────────
  function $(id) { return document.getElementById(id); }
  function toast(msg) {
    var t = $('toast'); if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(t._tm); t._tm = setTimeout(function () { t.classList.remove('show'); }, 3200);
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  // COR-015: the model may return the STRING "null"/"n/a"/"-" for absent fields
  function clean(v) {
    if (v == null) return '';
    var s = String(v).trim();
    return /^(null|undefined|n\/?a|none|nenhum|não informado|nao informado|-+|—|desconhecido)$/i.test(s) ? '' : s;
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function fold(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim(); }
  function pad2(n) { return ('0' + n).slice(-2); }
  function num3(n) { return ('00' + n).slice(-3); }
  function money(v) {
    if (v == null || isNaN(v)) return '—';
    return 'R$ ' + Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function moneyPlain(v) {
    if (v == null || isNaN(v)) return '';
    return Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function parseMoney(s) {
    if (typeof s === 'number') return isFinite(s) ? Math.round(s * 100) / 100 : null;
    s = clean(s); if (!s) return null;
    s = s.replace(/[R$\s]/g, '').replace(/[^\d,.\-]/g, '');
    if (!s) return null;
    var lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
    if (lc > ld) s = s.replace(/\./g, '').replace(',', '.');
    else if (ld > lc && lc !== -1) s = s.replace(/,/g, '');
    else if (lc === -1 && ld !== -1 && s.length - ld - 1 === 3 && s.split('.').length > 1 && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
    var n = parseFloat(s);
    return isFinite(n) ? Math.round(n * 100) / 100 : null;
  }
  function brDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}$/.test(iso)) return '';
    var p = iso.split('-'); return p[2] + '/' + p[1] + '/' + p[0];
  }
  function normDate(v) {
    var s = clean(v); if (!s) return '';
    var m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
    var y, mo, d;
    if (m) { y = +m[1]; mo = +m[2]; d = +m[3]; }
    else {
      m = s.match(/^(\d{1,2})[\/.\-](\d{1,2})[\/.\-](\d{2,4})/);
      if (!m) return '';
      d = +m[1]; mo = +m[2]; y = +m[3]; if (y < 100) y += 2000;
    }
    var now = new Date().getFullYear();
    if (y < 2000 || y > now + 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return '';
    var dt = new Date(Date.UTC(y, mo - 1, d));
    if (dt.getUTCMonth() !== mo - 1) return '';
    return y + '-' + pad2(mo) + '-' + pad2(d);
  }
  function monthKey(iso) { return iso ? iso.slice(0, 7) : ''; }
  var MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
  function monthLabel(k) { if (!k) return 'Sem data'; var p = k.split('-'); return MONTHS[+p[1] - 1] + '/' + p[0]; }
  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function fmtTaxId(s) {
    var d = digits(s);
    if (d.length === 14) return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    if (d.length === 11) return d.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
    return clean(s);
  }
  function nowStamp() { var d = new Date(); return pad2(d.getDate()) + '/' + pad2(d.getMonth() + 1) + '/' + d.getFullYear() + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()); }
  function fileSlug(s) { return (fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'despesas').slice(0, 50); }
  function payLabel(id) { var p = PAYMENTS.filter(function (x) { return x.id === id; })[0]; return p ? p.label : 'Não informado'; }
  function download(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }

  // ── storage: IndexedDB for lotes (images included), localStorage index ────
  function openDB() {
    return new Promise(function (resolve, reject) {
      if (!window.indexedDB) { reject(new Error('no-idb')); return; }
      var req;
      try { req = indexedDB.open(DB_NAME, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = function () { var db = req.result; if (!db.objectStoreNames.contains(DB_STORE)) db.createObjectStore(DB_STORE, { keyPath: 'id' }); };
      req.onsuccess = function () {
        var db = req.result;
        // COR-061: a database created elsewhere without our store → bump the version once
        if (!db.objectStoreNames.contains(DB_STORE)) {
          var v = db.version + 1; db.close();
          var r2 = indexedDB.open(DB_NAME, v);
          r2.onupgradeneeded = function () { r2.result.createObjectStore(DB_STORE, { keyPath: 'id' }); };
          r2.onsuccess = function () { resolve(r2.result); };
          r2.onerror = function () { reject(r2.error); };
          return;
        }
        resolve(db);
      };
      req.onerror = function () { reject(req.error); };
      req.onblocked = function () { reject(new Error('blocked')); };
    });
  }
  function idb(mode, fn) {
    if (!state.db) return Promise.reject(new Error('no-db'));
    return new Promise(function (resolve, reject) {
      var tx = state.db.transaction(DB_STORE, mode);
      var store = tx.objectStore(DB_STORE);
      var out = fn(store);
      tx.oncomplete = function () { resolve(out && out.result !== undefined ? out.result : undefined); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error('abort')); };
    });
  }
  function getLote(id) { return idb('readonly', function (s) { return s.get(id); }); }
  function putLote(l) { return idb('readwrite', function (s) { s.put(l); }); }
  function delLote(id) { return idb('readwrite', function (s) { s.delete(id); }); }
  function loadIndex() { try { return JSON.parse(localStorage.getItem(INDEX_SLOT) || '[]'); } catch (e) { return []; } }
  function storeIndex(list) { try { localStorage.setItem(INDEX_SLOT, JSON.stringify(list)); } catch (e) {} }
  function indexEntry(l) {
    var inc = included(l);
    return { id: l.id, name: l.name || 'Lote sem nome', resp: l.resp || '', final: l.final, count: l.items.length, total: sum(inc), updated: Date.now(), created: l.created };
  }
  var saveTimer = null;
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(saveNow, 400); }
  function saveNow() {
    clearTimeout(saveTimer);
    var l = state.lote; if (!l) return Promise.resolve();
    var list = loadIndex().filter(function (x) { return x.id !== l.id; });
    list.unshift(indexEntry(l)); storeIndex(list.slice(0, 80));
    try { localStorage.setItem(CURRENT_SLOT, l.id); } catch (e) {}
    if (!state.db) return Promise.resolve();
    return putLote(l).catch(function (e) {
      if (!state._quotaWarned) { state._quotaWarned = true; toast('Não consegui salvar o lote neste navegador (espaço cheio?). Exporte a planilha para não perder.'); }
    });
  }
  function newLote() {
    var d = new Date();
    return { id: uid(), name: 'Despesas de ' + MONTHS[d.getMonth()] + '/' + d.getFullYear(), resp: '', final: 'controle', cliente: '', created: Date.now(), seq: 0, items: [] };
  }

  // ── lote math (deterministic — the model never adds anything up) ──────────
  function isEntry(it) { return it.status === 'done' || it.kind === 'manual'; }
  function included(l) { return (l || state.lote).items.filter(function (it) { return isEntry(it) && !it.excluded; }); }
  function sum(list) { return Math.round(list.reduce(function (a, it) { return a + (it.data.total || 0); }, 0) * 100) / 100; }
  function needsCheck(it) {
    if (!isEntry(it) || it.checked) return false;
    var d = it.data;
    return !d.date || d.total == null || !d.merchant || (it.review && it.review.length > 0) || (it.confidence != null && it.confidence < LOW_CONFIDENCE);
  }
  function reviewFields(it) {
    var f = (it.review || []).slice();
    if (!it.data.date && f.indexOf('date') === -1) f.push('date');
    if (it.data.total == null && f.indexOf('total') === -1) f.push('total');
    if (!it.data.merchant && f.indexOf('merchant') === -1) f.push('merchant');
    return f;
  }
  function computeDups() {
    var seen = {};
    state.lote.items.forEach(function (it) { it.dupOf = null; });
    state.lote.items.forEach(function (it) {
      if (!isEntry(it) || it.excluded || it.dupOk || it.data.total == null || !it.data.date) return;
      var cents = Math.round(it.data.total * 100);
      var keys = [];
      var tax = digits(it.data.taxId);
      if (tax.length >= 11) keys.push('t|' + cents + '|' + it.data.date + '|' + tax);
      var m = fold(it.data.merchant).replace(/[^a-z0-9]/g, '').slice(0, 10);
      if (m.length >= 3) keys.push('m|' + cents + '|' + it.data.date + '|' + m);
      var doc = digits(it.data.docNumber);
      if (doc.length >= 4 && tax.length >= 11) keys.push('d|' + tax + '|' + doc);
      var hit = null;
      keys.forEach(function (k) { if (!hit && seen[k]) hit = seen[k]; });
      if (hit) it.dupOf = hit.n;
      else keys.forEach(function (k) { seen[k] = it; });
    });
  }

  // ── file preparation (canvas / pdf.js) ────────────────────────────────────
  function canvasJPEG(source, w, h, edge, q) {
    var s = Math.min(1, edge / Math.max(w, h));
    var cw = Math.max(1, Math.round(w * s)), ch = Math.max(1, Math.round(h * s));
    var c = document.createElement('canvas'); c.width = cw; c.height = ch;
    var ctx = c.getContext('2d');
    ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(source, 0, 0, cw, ch);
    return c.toDataURL('image/jpeg', q); // COR-064: synchronous encode (toBlob idles in background tabs)
  }
  function loadImage(url) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () { resolve(img); };
      img.onerror = function () { reject(new Error('decode')); };
      img.src = url;
    });
  }
  function prepImage(file) {
    var url = URL.createObjectURL(file);
    return loadImage(url).then(function (img) {
      var w = img.naturalWidth, h = img.naturalHeight;
      if (!w || !h) throw new Error('decode');
      var out = { images: [canvasJPEG(img, w, h, IMG_EDGE, 0.85)], thumb: canvasJPEG(img, w, h, THUMB_EDGE, 0.72), pages: 1 };
      URL.revokeObjectURL(url);
      return out;
    }, function (e) { URL.revokeObjectURL(url); throw e; });
  }
  function loadPdfjs() {
    if (state.pdfjs) return Promise.resolve(state.pdfjs);
    return import('./vendor/pdf.min.mjs').then(function (mod) {
      mod.GlobalWorkerOptions.workerSrc = new URL('vendor/pdf.worker.min.mjs', location.href).href;
      state.pdfjs = mod; return mod;
    });
  }
  function prepPdf(file) {
    var task = null;
    return Promise.all([loadPdfjs(), file.arrayBuffer()]).then(function (r) {
      task = r[0].getDocument({ data: new Uint8Array(r[1]), isEvalSupported: false, enableXfa: false });
      return task.promise;
    }).then(function (pdf) {
      var n = Math.min(pdf.numPages, MAX_PDF_PAGES), images = [], thumb = null;
      var chain = Promise.resolve();
      for (var p = 1; p <= n; p++) {
        (function (pn) {
          chain = chain.then(function () { return pdf.getPage(pn); }).then(function (page) {
            var vp1 = page.getViewport({ scale: 1 });
            var scale = Math.min(2.5, IMG_EDGE / Math.max(vp1.width, vp1.height));
            var vp = page.getViewport({ scale: scale });
            var c = document.createElement('canvas'); c.width = Math.round(vp.width); c.height = Math.round(vp.height);
            var ctx = c.getContext('2d'); ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, c.width, c.height);
            return page.render({ canvasContext: ctx, viewport: vp }).promise.then(function () {
              images.push(c.toDataURL('image/jpeg', 0.85));
              if (!thumb) thumb = canvasJPEG(c, c.width, c.height, THUMB_EDGE, 0.72);
            });
          });
        })(p);
      }
      return chain.then(function () { var pages = pdf.numPages; try { task.destroy(); } catch (e) {} return { images: images, thumb: thumb, pages: pages }; });
    });
  }
  function isHeic(file) { return /hei[cf]$/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || ''); }
  function isPdf(file) { return file.type === 'application/pdf' || /\.pdf$/i.test(file.name || ''); }

  function showDzNote(msg) { var n = $('dz-note'); n.textContent = msg || ''; n.hidden = !msg; }
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    if (!files.length) return Promise.resolve();
    var l = state.lote, notes = [];
    var room = MAX_FILES - l.items.filter(function (it) { return it.kind !== 'manual'; }).length;
    var sig = {}; l.items.forEach(function (it) { if (it.sig) sig[it.sig] = true; });
    var accepted = [];
    files.forEach(function (f) {
      var s = f.name + '|' + f.size + '|' + f.lastModified;
      if (sig[s]) { notes.push('“' + f.name + '” já está no lote.'); return; }
      if (!isPdf(f) && !/^image\//.test(f.type || '') && !isHeic(f)) { notes.push('“' + f.name + '” não é imagem nem PDF.'); return; }
      if (f.size > 25 * 1024 * 1024) { notes.push('“' + f.name + '” passa de 25 MB.'); return; }
      if (accepted.length >= room) { notes.push('Limite de ' + MAX_FILES + ' comprovantes por lote — comece outro lote para o restante.'); room = -1; return; }
      sig[s] = true; accepted.push({ f: f, s: s });
    });
    notes = notes.filter(function (x, i) { return notes.indexOf(x) === i; });
    if (!accepted.length) { showDzNote(notes.join(' ')); return Promise.resolve(); }
    showDzNote('Preparando ' + accepted.length + (accepted.length === 1 ? ' arquivo…' : ' arquivos…'));
    var chain = Promise.resolve(), added = 0;
    accepted.forEach(function (a) {
      chain = chain.then(function () {
        var f = a.f;
        var p = isPdf(f) ? prepPdf(f) : prepImage(f);
        return p.then(function (r) {
          if (!r.images.length) throw new Error('empty');
          l.seq += 1;
          l.items.push({ id: uid(), n: l.seq, sig: a.s, fileName: f.name || ('comprovante-' + l.seq), kind: isPdf(f) ? 'pdf' : 'image', pages: r.pages, images: r.images, thumb: r.thumb, status: 'queue', error: '', data: emptyData(), review: [], confidence: null, checked: false });
          added++;
          renderFiles(); renderCounts();
        }).catch(function (e) {
          if (isHeic(f)) notes.push('“' + f.name + '” está em HEIC, formato que este navegador não abre. No iPhone: Ajustes › Câmera › Formatos › “Mais compatível”, ou envie como JPG.');
          else if (isPdf(f) && e && /password/i.test(e.name + ' ' + e.message)) notes.push('“' + f.name + '” é um PDF protegido por senha.');
          else notes.push('Não consegui abrir “' + f.name + '”.');
        });
      });
    });
    return chain.then(function () {
      save();
      var msg = (added ? (added === 1 ? '1 comprovante entrou no espeto.' : added + ' comprovantes entraram no espeto.') : '') + (notes.length ? ' ' + notes.join(' ') : '');
      showDzNote(msg.trim());
      if (added && !notes.length) setTimeout(function () { if ($('dz-note').textContent === msg.trim()) showDzNote(''); }, 3500);
      renderAll();
    });
  }
  function emptyData() { return { date: '', merchant: '', taxId: '', desc: '', category: 'Outros', payment: 'nao_informado', total: null, reimb: false, docNumber: '', docType: '' }; }

  function loadSamples() {
    if (state.running) return;
    var names = ['amostra-posto.jpg', 'amostra-cafe.jpg', 'amostra-nfse.jpg'];
    var btn = $('sample-btn'); btn.disabled = true;
    Promise.all(names.map(function (n) {
      return fetch('samples/' + n).then(function (r) { if (!r.ok) throw new Error('x'); return r.blob(); })
        .then(function (b) { return new File([b], n, { type: 'image/jpeg', lastModified: 1760000000000 }); });
    })).then(function (files) { return addFiles(files); })
      .catch(function () { toast('Não consegui carregar os exemplos agora.'); })
      .then(function () { btn.disabled = false; });
  }

  // ── LLM (OpenRouter BYOK, vision) ─────────────────────────────────────────
  function activeKey() {
    var k = window.ApiKeyManager && ApiKeyManager.getActiveKey ? ApiKeyManager.getActiveKey() : null;
    return k && k.key ? k : null;
  }
  function fetchContent(messages, temperature, signal) {
    var key = activeKey();
    if (!key) return Promise.reject(new Error('Conecte sua chave de IA (ícone de chave no topo) para ler os comprovantes.'));
    var model = (window.ApiKeyManager && ApiKeyManager.getModel) ? ApiKeyManager.getModel() : 'google/gemini-3.8-flash';
    var isDeepSeek = model.indexOf('deepseek/') === 0;
    var body = { model: model, messages: messages, temperature: (temperature == null ? 0.1 : temperature), max_tokens: 16000 }; // COR-053
    if (!isDeepSeek) body.reasoning = { effort: 'low' }; // COR-034; never for deepseek/* (COR-035)

    var doFetch = function () {
      return fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        signal: signal,
        headers: {
          'Authorization': 'Bearer ' + key.key,
          'Content-Type': 'application/json',
          'HTTP-Referer': location.origin,
          'X-Title': 'Despesas IA - Maestros da IA' // ASCII-only header value
        },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (txt) {
          if (!r.ok) {
            var msg = 'Erro ' + r.status + ' do provedor de IA.';
            try { var j = JSON.parse(txt); msg = (j.error && (j.error.message || j.error)) || msg; } catch (e) {}
            if (r.status === 401) msg = 'Chave inválida ou sem permissão. Confira sua chave da OpenRouter.';
            else if (r.status === 402) msg = 'Créditos insuficientes na sua conta OpenRouter.';
            else if (r.status === 429) msg = 'Muitas requisições ao provedor. Aguarde alguns segundos e tente de novo.';
            else if (/image|vision|modalit/i.test(String(msg))) msg = 'Este modelo não aceita imagens agora. Escolha outro modelo na lista e tente de novo.';
            else if (r.status === 413) msg = 'O comprovante ficou grande demais para este modelo. Tente outro modelo.';
            var e = new Error(String(msg)); e.httpStatus = r.status; throw e;
          }
          var data; try { data = JSON.parse(txt); } catch (e2) { throw new Error('Resposta inválida do provedor de IA.'); }
          if (data && data.error) throw new Error(String(data.error.message || 'Erro do provedor de IA.'));
          var choice = (data.choices && data.choices[0]) || {};
          var content = (choice.message && choice.message.content) || '';
          if (Array.isArray(content)) content = content.map(function (p) { return p && p.text ? p.text : ''; }).join('');
          if (!content || !String(content).trim()) { var em = new Error('Resposta vazia do modelo.'); em.emptyContent = true; throw em; }
          return String(content);
        });
      });
    };
    var run = function () {
      return doFetch().catch(function (e) {
        if (e && e.emptyContent && body.reasoning) { delete body.reasoning; return doFetch(); } // COR-035 net
        throw e;
      });
    };
    var limited = (window.RateLimiter && RateLimiter.executeWithLimit) ? RateLimiter.executeWithLimit('openrouter', run) : run();
    return Promise.resolve(limited).then(function (res) {
      if (res == null) throw new Error('Limite de uso por minuto atingido. Aguarde um pouco e continue.');
      return res;
    });
  }
  function stripToObject(s) {
    s = String(s).replace(/```json/gi, '').replace(/```/g, '').trim();
    var a = s.indexOf('{'), b = s.lastIndexOf('}');
    if (a !== -1 && b !== -1 && b > a) s = s.slice(a, b + 1);
    return s;
  }
  function tryParse(s) { try { return JSON.parse(s); } catch (e) { return null; } }
  function parseJSONLadder(raw) {
    var s = stripToObject(raw);
    var o = tryParse(s); if (o) return o;
    var s2 = s.replace(/,\s*([}\]])/g, '$1'); o = tryParse(s2); if (o) return o;
    var s3 = s2.replace(/[\x00-\x1f]+/g, ' '); o = tryParse(s3); if (o) return o;
    var s4 = s3.replace(/[“”]/g, '"').replace(/[‘’]/g, "'"); o = tryParse(s4); if (o) return o;
    return null;
  }
  function callJSON(messages, signal) {
    return fetchContent(messages, 0.1, signal).then(function (txt) {
      var obj = parseJSONLadder(txt);
      if (obj && typeof obj === 'object') return obj;
      var strict = messages.concat([{ role: 'user', content: 'Sua resposta anterior NÃO era um JSON válido. Responda novamente APENAS com o objeto JSON pedido, com aspas retas ("), sem markdown, sem comentários, sem texto antes ou depois.' }]);
      return fetchContent(strict, 0, signal).then(function (txt2) {
        var obj2 = parseJSONLadder(txt2);
        if (obj2 && typeof obj2 === 'object') return obj2;
        throw new Error('O modelo não devolveu os dados no formato certo. Clique em “Ler de novo” (ou troque de modelo).');
      });
    });
  }

  function systemPrompt() {
    var year = new Date().getFullYear();
    return [
      'Você é um assistente de contabilidade brasileiro que LÊ comprovantes de despesa (cupom fiscal, nota fiscal/DANFE, NFS-e, recibo, comprovante de Pix ou de cartão, fatura, boleto) a partir da IMAGEM e devolve os dados em JSON.',
      'Regras:',
      '1) Leia SOMENTE o que está na imagem. Nunca invente valores, datas, nomes ou CNPJ. Se um campo não estiver legível, use null e coloque o nome do campo em "revisar".',
      '2) "total" é o valor efetivamente pago (depois de descontos; inclua taxa de serviço/gorjeta e frete se estiverem no total). Número com ponto decimal, sem "R$" (ex.: 1234.56). Se houver troco, o total NÃO é o valor entregue em dinheiro.',
      '3) "data" é a data da compra/emissão no formato AAAA-MM-DD. Datas brasileiras vêm como DD/MM/AAAA ou DD/MM/AA (anos de 2 dígitos são 20AA). Estamos em ' + year + '.',
      '4) "estabelecimento" é o nome fantasia de quem recebeu o pagamento (se só houver razão social, use a razão social). Em comprovante de Pix, é o recebedor.',
      '5) "cnpj_cpf" é o CNPJ (ou CPF) do estabelecimento/recebedor, não o do cliente. Copie os dígitos exatamente.',
      '6) "categoria" deve ser EXATAMENTE uma destas: ' + CATEGORIES.map(function (c) { return '"' + c + '" (' + CAT_HINTS[c] + ')'; }).join('; ') + '.',
      '7) "forma_pagamento" deve ser exatamente uma destas: "pix", "credito", "debito", "dinheiro", "boleto", "transferencia", "outro", "nao_informado".',
      '8) "tipo_documento": "cupom_fiscal", "nota_fiscal", "nfse", "recibo", "comprovante_pix", "comprovante_cartao", "fatura", "boleto" ou "outro".',
      '9) "descricao": até 80 caracteres, em português, dizendo O QUE foi comprado (ex.: "Gasolina comum 38,5 L", "Almoço executivo para 2 pessoas", "Assinatura mensal do plano Pro").',
      '10) "confianca": de 0 a 1, o quanto você tem certeza da leitura do total e da data juntos (foto borrada, cortada ou amassada = baixa).',
      '11) Se a imagem NÃO for um comprovante de despesa (selfie, paisagem, print de conversa sem valor pago, documento sem valor), devolva "e_comprovante": false e explique em "observacao".',
      '12) Se houver mais de um comprovante na mesma imagem, leia o principal (o maior/mais legível) e avise em "observacao".',
      'Responda APENAS com um objeto JSON, sem markdown, exatamente com estas chaves:',
      '{"e_comprovante": true, "tipo_documento": "", "data": "AAAA-MM-DD", "estabelecimento": "", "cnpj_cpf": "", "numero_documento": "", "descricao": "", "categoria": "", "forma_pagamento": "", "total": 0, "confianca": 0.0, "revisar": ["data","total","estabelecimento","cnpj_cpf","categoria","forma_pagamento"], "observacao": ""}',
      'A lista "revisar" deve conter só os campos com dúvida real (pode ser vazia []). "observacao": uma frase curta em português ou "".'
    ].join('\n');
  }
  function userContent(it) {
    var parts = [{ type: 'text', text: 'Leia este comprovante (arquivo "' + it.fileName.slice(0, 80) + '"' + (it.images.length > 1 ? ', ' + it.images.length + ' páginas' : '') + ') e devolva o JSON.' }];
    it.images.forEach(function (u) { parts.push({ type: 'image_url', image_url: { url: u } }); });
    return parts;
  }
  function pickCategory(v) {
    var f = fold(v); if (!f) return '';
    for (var i = 0; i < CATEGORIES.length; i++) if (fold(CATEGORIES[i]) === f) return CATEGORIES[i];
    for (var j = 0; j < CATEGORIES.length; j++) { var w = fold(CATEGORIES[j]).split(' ')[0]; if (w.length > 4 && f.indexOf(w) !== -1) return CATEGORIES[j]; }
    return '';
  }
  function pickPayment(v) {
    var f = fold(v).replace(/[\s-]+/g, '_');
    if (!f) return 'nao_informado';
    if (/pix/.test(f)) return 'pix';
    if (/credit/.test(f)) return 'credito';
    if (/debit/.test(f)) return 'debito';
    if (/dinheir|especie|cash/.test(f)) return 'dinheiro';
    if (/boleto/.test(f)) return 'boleto';
    if (/transf|ted|doc/.test(f)) return 'transferencia';
    if (/cart/.test(f)) return 'outro';
    if (/nao_inform|desconhec/.test(f)) return 'nao_informado';
    return PAYMENTS.some(function (p) { return p.id === f; }) ? f : 'outro';
  }
  var REVIEW_MAP = { data: 'date', date: 'date', total: 'total', valor: 'total', estabelecimento: 'merchant', merchant: 'merchant', cnpj_cpf: 'taxId', cnpj: 'taxId', cpf: 'taxId', categoria: 'category', category: 'category', forma_pagamento: 'payment', pagamento: 'payment', descricao: 'desc' };
  function applyReading(it, o) {
    it.ai = o;
    if (o.e_comprovante === false || String(o.e_comprovante).toLowerCase() === 'false') {
      it.status = 'skip'; it.notes = clean(o.observacao) || 'A IA não reconheceu um comprovante de despesa nesta imagem.';
      return;
    }
    var d = it.data, review = [];
    d.date = normDate(o.data);
    d.merchant = clean(o.estabelecimento).slice(0, 90);
    d.taxId = fmtTaxId(o.cnpj_cpf).slice(0, 24);
    d.docNumber = clean(o.numero_documento).slice(0, 40);
    d.desc = clean(o.descricao).slice(0, 120);
    var cat = pickCategory(o.categoria); d.category = cat || 'Outros'; if (!cat) review.push('category');
    d.payment = pickPayment(o.forma_pagamento);
    d.total = parseMoney(o.total);
    if (d.total != null && d.total <= 0) { d.total = null; }
    d.docType = DOC_TYPES[clean(o.tipo_documento)] ? clean(o.tipo_documento) : 'outro';
    var conf = parseFloat(o.confianca); it.confidence = isFinite(conf) ? Math.max(0, Math.min(1, conf)) : null;
    (Array.isArray(o.revisar) ? o.revisar : []).forEach(function (k) { var m = REVIEW_MAP[fold(k)]; if (m && review.indexOf(m) === -1) review.push(m); });
    it.review = review;
    it.notes = clean(o.observacao).slice(0, 220);
    if (it.pages > MAX_PDF_PAGES) it.notes = ((it.notes ? it.notes + ' ' : '') + 'PDF com ' + it.pages + ' páginas — li as ' + MAX_PDF_PAGES + ' primeiras.').trim();
    if (state.lote.final === 'reembolso' || state.lote.final === 'cliente') d.reimb = true;
    it.status = 'done'; it.checked = false;
  }
  function readOne(it, signal) {
    it.status = 'reading'; it.error = '';
    var msgs = [{ role: 'system', content: systemPrompt() }, { role: 'user', content: userContent(it) }];
    return callJSON(msgs, signal).then(function (o) { applyReading(it, o); state.justPrinted[it.id] = true; });
  }

  function showProcessError(msg) { var e = $('process-error'); e.textContent = msg || ''; e.hidden = !msg; }
  function runProcessing() {
    if (state.running) return;
    if (!activeKey()) { showProcessError('Conecte sua chave da OpenRouter antes de ler os comprovantes — toque no ícone de chave no topo da tela.'); return; }
    var todo = state.lote.items.filter(function (it) { return it.kind !== 'manual' && (it.status === 'queue' || it.status === 'error'); });
    if (!todo.length) { toast('Todos os comprovantes já foram lidos.'); return; }
    showProcessError('');
    state.running = true; state.stopReq = false; state.controllers = [];
    setRunningUI(true);
    var total = todo.length, done = 0, errs = 0, lastErr = '', fatal = false;
    todo.forEach(function (it) { it.status = 'queue'; });
    updateProgress(0, total);
    var q = todo.slice();
    function worker() {
      var it = q.shift();
      if (!it || state.stopReq || fatal) return Promise.resolve();
      var ctl = new AbortController(); state.controllers.push(ctl);
      var timer = setTimeout(function () { try { ctl.abort(); } catch (e) {} }, 120000);
      paintTicket(it);
      return readOne(it, ctl.signal).catch(function (e) {
        if (state.stopReq) { it.status = 'queue'; return; }
        it.status = 'error';
        it.error = (e && e.name === 'AbortError') ? 'O modelo demorou demais para responder. Clique em “Ler de novo”.' : ((e && e.message) || 'Falha na leitura.');
        lastErr = it.error; errs++;
        if (e && (e.httpStatus === 401 || e.httpStatus === 402)) fatal = true;
      }).then(function () {
        clearTimeout(timer);
        done++; updateProgress(done, total);
        computeDups(); paintTicket(it); renderCounts(); save();
        return worker();
      });
    }
    var ws = []; for (var i = 0; i < CONCURRENCY; i++) ws.push(worker());
    Promise.all(ws).then(function () {
      state.running = false; setRunningUI(false);
      state.lote.items.forEach(function (it) { if (it.status === 'reading') it.status = 'queue'; });
      computeDups(); saveNow(); renderAll();
      var ok = state.lote.items.filter(isEntry).length;
      if (state.stopReq) { toast('Leitura pausada. Clique em “Ler comprovantes” para continuar.'); return; }
      if (fatal) { showProcessError(lastErr); return; }
      if (errs) showProcessError(errs + (errs === 1 ? ' comprovante não foi lido: ' : ' comprovantes não foram lidos: ') + lastErr);
      var chk = state.lote.items.filter(needsCheck).length;
      toast(ok + ' lançamento' + (ok === 1 ? '' : 's') + ' no lote' + (chk ? ' · ' + chk + ' para conferir' : '') + '.');
    });
  }
  function stopProcessing() {
    if (!state.running) return;
    state.stopReq = true;
    state.controllers.forEach(function (c) { try { c.abort(); } catch (e) {} });
  }
  function setRunningUI(on) {
    $('process-btn').hidden = on; $('stop-btn').hidden = !on;
    $('sample-btn').disabled = on; $('file-input').disabled = on; $('clear-files').disabled = on;
    $('dropzone').classList.toggle('is-disabled', on);
    $('printer-led').classList.toggle('on', on);
    $('progress').hidden = !on && !$('progress-fill').style.width;
    if (!on) setTimeout(function () { if (!state.running) $('progress').hidden = true; }, 2500);
  }
  function updateProgress(done, total) {
    $('progress').hidden = false;
    $('progress-fill').style.width = (total ? Math.round(done * 100 / total) : 0) + '%';
    $('progress-text').textContent = done < total ? 'Imprimindo ' + done + ' de ' + total + '…' : 'Pronto: ' + total + ' de ' + total + ' lidos.';
  }

  // ── render: tab 1 (spike) ─────────────────────────────────────────────────
  function stampFor(it) {
    if (it.status === 'queue') return '<span class="stamp s-queue">Na fila</span>';
    if (it.status === 'reading') return '<span class="stamp s-reading">Lendo…</span>';
    if (it.status === 'error') return '<span class="stamp s-error">Erro</span>';
    if (it.status === 'skip') return '<span class="stamp s-skip">Não é cupom</span>';
    if (it.dupOf) return '<span class="stamp s-dup">Duplicado?</span>';
    if (needsCheck(it)) return '<span class="stamp s-check">Conferir</span>';
    return '<span class="stamp s-done">Lido</span>';
  }
  function ticketHTML(it) {
    var d = it.data, body;
    if (it.status === 'done') {
      body = '<p class="ticket-name">' + esc(d.merchant || 'Estabelecimento ?') + '</p>' +
        '<div class="ticket-line"><span>' + esc(brDate(d.date) || 'data ?') + '</span><span>' + esc(payLabel(d.payment)) + '</span></div>' +
        '<div class="ticket-line"><span>' + esc(d.category) + '</span></div>' +
        '<div class="ticket-line ticket-total"><span>TOTAL</span><span>' + esc(d.total == null ? '?' : moneyPlain(d.total)) + '</span></div>';
    } else if (it.status === 'skip') {
      body = '<p class="ticket-name">' + esc(it.fileName) + '</p><p class="ticket-err">' + esc(it.notes || 'Não parece um comprovante.') + '</p>';
    } else if (it.status === 'error') {
      body = '<p class="ticket-name">' + esc(it.fileName) + '</p><p class="ticket-err">' + esc(it.error) + '</p>';
    } else {
      body = '<p class="ticket-name">' + esc(it.fileName) + '</p><div class="ticket-line"><span>' + (it.kind === 'pdf' ? 'PDF · ' + it.pages + (it.pages === 1 ? ' página' : ' páginas') : 'Imagem') + '</span></div>';
    }
    var acts = '';
    if (!state.running) {
      if (it.status === 'done') acts = '<button type="button" data-act="edit">Conferir</button>';
      else if (it.status === 'error') acts = '<button type="button" data-act="reread">Ler de novo</button>';
      else if (it.status === 'skip') acts = '<button type="button" data-act="force">É comprovante</button>';
      acts += '<button type="button" data-act="del" aria-label="Tirar ' + esc(it.fileName) + ' do lote">Tirar</button>';
    }
    return '<article class="ticket' + (it.status === 'reading' ? ' is-reading' : '') + (state.justPrinted[it.id] ? ' just-printed' : '') + '" data-id="' + it.id + '">' +
      '<button type="button" class="ticket-thumb" data-act="zoom" aria-label="Ampliar ' + esc(it.fileName) + '"><img src="' + it.thumb + '" alt="">' + (it.kind === 'pdf' ? '<span class="pdf-badge">PDF</span>' : '') + '</button>' +
      stampFor(it) +
      '<div class="ticket-body"><span class="ticket-no">Nº ' + num3(it.n) + '</span>' + body + '</div>' +
      (acts ? '<div class="ticket-actions">' + acts + '</div>' : '') + '</article>';
  }
  function renderFiles() {
    var list = $('file-list');
    var files = state.lote.items.filter(function (it) { return it.kind !== 'manual'; });
    list.innerHTML = files.map(ticketHTML).join('');
    state.justPrinted = {};
    $('files-empty').hidden = files.length > 0;
    $('clear-files').hidden = files.length === 0;
    $('printer-count').textContent = files.length + ' / ' + MAX_FILES;
    var pending = files.filter(function (it) { return it.status === 'queue' || it.status === 'error'; }).length;
    var pb = $('process-btn');
    pb.disabled = pending === 0;
    pb.textContent = pending ? 'Ler ' + pending + (pending === 1 ? ' comprovante' : ' comprovantes') : 'Ler comprovantes';
  }
  function paintTicket(it) {
    var el = document.querySelector('.ticket[data-id="' + it.id + '"]');
    if (!el) { renderFiles(); return; }
    var tmp = document.createElement('div'); tmp.innerHTML = ticketHTML(it);
    el.replaceWith(tmp.firstChild);
    delete state.justPrinted[it.id];
  }
  function onSpikeClick(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var card = b.closest('.ticket'); if (!card) return;
    var it = findItem(card.getAttribute('data-id')); if (!it) return;
    var act = b.getAttribute('data-act');
    if (act === 'zoom') openZoom(it);
    else if (act === 'edit') { gotoTab('lancamentos'); setTimeout(function () { var el = document.querySelector('.entry[data-id="' + it.id + '"]'); if (el) { el.scrollIntoView({ block: 'center' }); var f = el.querySelector('input'); if (f) f.focus({ preventScroll: true }); } }, 60); }
    else if (act === 'reread') { it.status = 'queue'; it.error = ''; renderFiles(); runProcessing(); }
    else if (act === 'force') { it.status = 'done'; it.review = ['date', 'total', 'merchant']; it.checked = false; save(); renderAll(); toast('Lançamento criado — preencha os dados na etapa 2.'); }
    else if (act === 'del') removeItem(it);
  }
  function removeItem(it) {
    if (state.running) return;
    state.lote.items = state.lote.items.filter(function (x) { return x !== it; });
    computeDups(); save(); renderAll();
    toast('Nº ' + num3(it.n) + ' saiu do lote.');
  }
  function findItem(id) { return state.lote.items.filter(function (x) { return x.id === id; })[0]; }

  // ── zoom ──────────────────────────────────────────────────────────────────
  var zoomReturn = null;
  function openZoom(it) {
    if (!it.images || !it.images.length) return;
    zoomReturn = document.activeElement;
    $('zoom-title').textContent = 'Nº ' + num3(it.n) + ' · ' + it.fileName;
    $('zoom-body').innerHTML = it.images.map(function (u, i) { return '<img src="' + u + '" alt="Comprovante ' + num3(it.n) + (it.images.length > 1 ? ', página ' + (i + 1) : '') + '">'; }).join('');
    $('zoom-modal').hidden = false;
    var c = document.querySelector('#zoom-modal .btn-icon'); if (c) c.focus();
  }
  function closeZoom() { $('zoom-modal').hidden = true; $('zoom-body').innerHTML = ''; if (zoomReturn && zoomReturn.focus) zoomReturn.focus(); }

  // ── render: tab 2 (ledger) ────────────────────────────────────────────────
  function catOptions(sel) { return CATEGORIES.map(function (c) { return '<option' + (c === sel ? ' selected' : '') + '>' + esc(c) + '</option>'; }).join(''); }
  function payOptions(sel) { return PAYMENTS.map(function (p) { return '<option value="' + p.id + '"' + (p.id === sel ? ' selected' : '') + '>' + esc(p.label) + '</option>'; }).join(''); }
  function flagsHTML(it) {
    var out = [];
    if (it.dupOf) out.push('<span class="flag flag-dup">Possível duplicado do Nº ' + num3(it.dupOf) + '</span>');
    if (needsCheck(it)) {
      var rf = reviewFields(it).map(function (k) { return FIELD_LABEL[k]; }).filter(Boolean);
      out.push('<span class="flag flag-check">Conferir' + (rf.length ? ': ' + esc(rf.join(', ')) : '') + '</span>');
    }
    if (it.checked) out.push('<span class="flag flag-ok">Conferido</span>');
    if (it.confidence != null && !it.checked && it.confidence < LOW_CONFIDENCE) out.push('<span class="flag flag-low">Leitura ' + Math.round(it.confidence * 100) + '%</span>');
    return out.join('');
  }
  function entryClass(it) { return 'entry' + (it.dupOf ? ' is-dup' : needsCheck(it) ? ' needs-check' : it.checked ? ' is-checked' : ''); }
  function entryHTML(it) {
    var d = it.data, id = it.id, rv = it.checked ? [] : reviewFields(it);
    function cls(k) { return rv.indexOf(k) !== -1 ? ' is-review' : ''; }
    var thumb = it.thumb
      ? '<button type="button" class="entry-thumb" data-act="zoom" aria-label="Ampliar comprovante Nº ' + num3(it.n) + '"><img src="' + it.thumb + '" alt=""></button>'
      : '<div class="entry-thumb no-img">Sem comprovante</div>';
    return '<article class="' + entryClass(it) + '" data-id="' + id + '">' + thumb +
      '<div class="entry-main">' +
        '<div class="entry-top"><span class="entry-no">Nº ' + num3(it.n) + '</span><span class="entry-file">' + esc(it.kind === 'manual' ? 'lançamento manual' : (DOC_TYPES[d.docType] || 'Comprovante') + ' · ' + it.fileName) + '</span><span class="entry-flags">' + flagsHTML(it) + '</span></div>' +
        '<div class="entry-grid">' +
          '<div class="f"><label for="d-' + id + '">Data</label><input type="date" id="d-' + id + '" data-k="date" class="' + cls('date') + '" value="' + esc(d.date) + '"></div>' +
          '<div class="f wide"><label for="m-' + id + '">Estabelecimento</label><input type="text" id="m-' + id + '" data-k="merchant" maxlength="90" class="' + cls('merchant') + '" value="' + esc(d.merchant) + '"></div>' +
          '<div class="f"><label for="v-' + id + '">Valor (R$)</label><input type="text" inputmode="decimal" id="v-' + id + '" data-k="total" class="money' + cls('total') + '" value="' + esc(moneyPlain(d.total)) + '" placeholder="0,00"></div>' +
          '<div class="f wide"><label for="s-' + id + '">Descrição</label><input type="text" id="s-' + id + '" data-k="desc" maxlength="120" class="' + cls('desc') + '" value="' + esc(d.desc) + '"></div>' +
          '<div class="f"><label for="c-' + id + '">Categoria</label><select id="c-' + id + '" data-k="category" class="' + cls('category') + '">' + catOptions(d.category) + '</select></div>' +
          '<div class="f"><label for="p-' + id + '">Pagamento</label><select id="p-' + id + '" data-k="payment" class="' + cls('payment') + '">' + payOptions(d.payment) + '</select></div>' +
          '<div class="f wide full-sm"><label for="t-' + id + '">CNPJ / CPF</label><input type="text" id="t-' + id + '" data-k="taxId" maxlength="24" class="' + cls('taxId') + '" value="' + esc(d.taxId) + '"></div>' +
        '</div>' +
        (it.notes ? '<p class="entry-note">' + esc(it.notes) + '</p>' : '') +
        '<div class="entry-actions">' +
          '<label class="check"><input type="checkbox" data-k="reimb"' + (d.reimb ? ' checked' : '') + '> <span>Reembolsável</span></label>' +
          '<label class="check"><input type="checkbox" data-k="checked"' + (it.checked ? ' checked' : '') + '> <span>Conferido</span></label>' +
          '<span class="spacer"></span>' +
          (it.dupOf ? '<button type="button" class="btn-ghost" data-act="dupok">Não é duplicado</button>' : '') +
          (it.kind !== 'manual' ? '<button type="button" class="btn-ghost" data-act="reread">Ler de novo</button>' : '') +
          '<button type="button" class="btn-ghost" data-act="del">Excluir</button>' +
        '</div>' +
      '</div></article>';
  }
  function visibleEntries() {
    return state.lote.items.filter(function (it) {
      if (!isEntry(it)) return false;
      if (state.filter === 'conferir' && !needsCheck(it)) return false;
      if (state.filter === 'duplicados' && !it.dupOf) return false;
      if (state.catFilter && it.data.category !== state.catFilter) return false;
      return true;
    });
  }
  function renderLedger() {
    computeDups();
    var all = state.lote.items.filter(isEntry);
    var vis = visibleEntries();
    $('ledger').innerHTML = vis.map(entryHTML).join('');
    var empty = $('ledger-empty');
    empty.hidden = vis.length > 0;
    empty.textContent = all.length ? 'Nenhum lançamento neste filtro.' : 'Ainda não há lançamentos. Arraste comprovantes na etapa 1 e clique em “Ler comprovantes”.';
    renderLedgerFoot();
  }
  function renderLedgerFoot() {
    var inc = included();
    $('ledger-foot').hidden = inc.length === 0;
    $('ledger-total').textContent = inc.length + (inc.length === 1 ? ' lançamento · ' : ' lançamentos · ') + 'TOTAL ' + money(sum(inc));
  }
  function refreshFlags() {
    computeDups();
    document.querySelectorAll('#ledger .entry').forEach(function (el) {
      var it = findItem(el.getAttribute('data-id')); if (!it) return;
      el.className = entryClass(it);
      var fl = el.querySelector('.entry-flags'); if (fl) fl.innerHTML = flagsHTML(it);
      var rv = it.checked ? [] : reviewFields(it);
      el.querySelectorAll('[data-k]').forEach(function (inp) {
        var k = inp.getAttribute('data-k'); if (k === 'reimb' || k === 'checked') return;
        inp.classList.toggle('is-review', rv.indexOf(k) !== -1);
      });
      var dupBtn = el.querySelector('[data-act="dupok"]');
      if (!it.dupOf && dupBtn) dupBtn.remove();
      if (it.dupOf && !dupBtn) {
        var b = document.createElement('button'); b.type = 'button'; b.className = 'btn-ghost'; b.setAttribute('data-act', 'dupok'); b.textContent = 'Não é duplicado';
        var sp = el.querySelector('.entry-actions .spacer'); if (sp) sp.after(b);
      }
    });
    renderLedgerFoot(); renderCounts();
  }
  function onLedgerInput(e) {
    var inp = e.target; var k = inp.getAttribute && inp.getAttribute('data-k'); if (!k) return;
    var el = inp.closest('.entry'); var it = el && findItem(el.getAttribute('data-id')); if (!it) return;
    var d = it.data;
    if (k === 'reimb') d.reimb = inp.checked;
    else if (k === 'checked') it.checked = inp.checked;
    else if (k === 'total') { if (e.type === 'change') { d.total = parseMoney(inp.value); inp.value = moneyPlain(d.total); } else return; }
    else if (k === 'date') d.date = normDate(inp.value);
    else if (k === 'taxId') { d.taxId = e.type === 'change' ? fmtTaxId(inp.value) : inp.value.trim(); if (e.type === 'change') inp.value = d.taxId; }
    else d[k] = inp.value.trim();
    if (e.type === 'change' && it.review && k !== 'reimb' && k !== 'checked') it.review = it.review.filter(function (x) { return x !== k; });
    save();
    if (e.type === 'change') { refreshFlags(); var t = document.querySelector('.ticket[data-id="' + it.id + '"]'); if (t) paintTicket(it); }
  }
  function onLedgerClick(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var el = b.closest('.entry'); var it = el && findItem(el.getAttribute('data-id')); if (!it) return;
    var act = b.getAttribute('data-act');
    if (act === 'zoom') openZoom(it);
    else if (act === 'dupok') { it.dupOk = true; save(); refreshFlags(); toast('Ok — Nº ' + num3(it.n) + ' fica como lançamento próprio.'); }
    else if (act === 'del') {
      if (!confirm('Excluir o lançamento Nº ' + num3(it.n) + (it.data.merchant ? ' (' + it.data.merchant + ')' : '') + '?')) return;
      removeItem(it);
    }
    else if (act === 'reread') {
      if (state.running) { toast('Aguarde a leitura em andamento terminar.'); return; }
      if (!activeKey()) { toast('Conecte sua chave de IA para ler de novo.'); return; }
      b.disabled = true; b.textContent = 'Lendo…'; el.classList.add('is-busy');
      var ctl = new AbortController(); var tm = setTimeout(function () { ctl.abort(); }, 120000);
      var keepReimb = it.data.reimb;
      readOne(it, ctl.signal).then(function () { it.data.reimb = keepReimb || it.data.reimb; computeDups(); save(); renderAll(); toast('Nº ' + num3(it.n) + ' lido de novo.'); })
        .catch(function (err) { it.status = 'done'; toast((err && err.name === 'AbortError') ? 'O modelo demorou demais. Tente de novo.' : ((err && err.message) || 'Falha na leitura.')); b.disabled = false; b.textContent = 'Ler de novo'; el.classList.remove('is-busy'); })
        .then(function () { clearTimeout(tm); });
    }
  }
  function addManual() {
    var l = state.lote; l.seq += 1;
    var d = emptyData(); d.date = new Date().toISOString().slice(0, 10);
    if (l.final === 'reembolso' || l.final === 'cliente') d.reimb = true;
    var it = { id: uid(), n: l.seq, fileName: '', kind: 'manual', pages: 0, images: [], thumb: '', status: 'done', error: '', data: d, review: ['merchant', 'total'], confidence: null, checked: false };
    l.items.push(it);
    state.filter = 'todos'; state.catFilter = ''; syncFilterUI();
    save(); renderAll();
    var el = document.querySelector('.entry[data-id="' + it.id + '"]');
    if (el) { el.scrollIntoView({ block: 'center' }); var m = el.querySelector('[data-k="merchant"]'); if (m) m.focus({ preventScroll: true }); }
  }
  function syncFilterUI() {
    document.querySelectorAll('.filter').forEach(function (x) { var on = x.getAttribute('data-filter') === state.filter; x.classList.toggle('on', on); x.setAttribute('aria-pressed', on ? 'true' : 'false'); });
    $('cat-filter').value = state.catFilter;
  }

  // ── render: tab 3 (Relatório Z) ───────────────────────────────────────────
  function groupBy(list, fn) {
    var m = {}; list.forEach(function (it) { var k = fn(it); if (!m[k]) m[k] = { k: k, total: 0, n: 0 }; m[k].total += it.data.total || 0; m[k].n++; });
    return Object.keys(m).map(function (k) { m[k].total = Math.round(m[k].total * 100) / 100; return m[k]; });
  }
  function period(list) {
    var ds = list.map(function (it) { return it.data.date; }).filter(Boolean).sort();
    return ds.length ? { from: ds[0], to: ds[ds.length - 1] } : null;
  }
  function summary() {
    var inc = included();
    var tot = sum(inc);
    var reimb = sum(inc.filter(function (it) { return it.data.reimb; }));
    return {
      inc: inc, total: tot, reimb: reimb, notReimb: Math.round((tot - reimb) * 100) / 100,
      files: state.lote.items.filter(function (it) { return it.kind !== 'manual'; }).length,
      manual: inc.filter(function (it) { return it.kind === 'manual'; }).length,
      check: inc.filter(needsCheck).length,
      dups: inc.filter(function (it) { return it.dupOf; }).length,
      noValue: inc.filter(function (it) { return it.data.total == null; }).length,
      skipped: state.lote.items.filter(function (it) { return it.status === 'skip'; }).length,
      pending: state.lote.items.filter(function (it) { return it.status === 'queue' || it.status === 'error'; }).length,
      byCat: groupBy(inc, function (it) { return it.data.category; }).sort(function (a, b) { return b.total - a.total; }),
      byMonth: groupBy(inc, function (it) { return monthKey(it.data.date); }).sort(function (a, b) { return a.k < b.k ? -1 : 1; }),
      byPay: groupBy(inc, function (it) { return it.data.payment; }).sort(function (a, b) { return b.total - a.total; }),
      period: period(inc)
    };
  }
  function zrow(k, v, extra) { return '<div class="z-row' + (extra || '') + '"><span class="z-k">' + esc(k) + '</span><span class="z-v">' + esc(v) + '</span></div>'; }
  function renderResumo() {
    computeDups();
    var s = summary(), l = state.lote;
    var h = '<p class="z-center z-big">DESPESAS IA</p><p class="z-center z-small">RELATÓRIO Z · FECHAMENTO DO LOTE</p><div class="r-rule"></div>';
    h += '<p><strong>' + esc(l.name || 'Lote sem nome') + '</strong></p>';
    if (l.resp) h += zrow('Responsável', l.resp);
    h += zrow('Finalidade', FINALIDADES[l.final] || FINALIDADES.controle);
    if (l.cliente) h += zrow('Cliente / projeto', l.cliente);
    h += zrow('Período', s.period ? brDate(s.period.from) + ' a ' + brDate(s.period.to) : '—');
    h += zrow('Emitido em', nowStamp());
    h += '<div class="r-rule"></div>';
    h += zrow('Comprovantes no lote', String(s.files));
    h += zrow('Lançamentos somados', String(s.inc.length) + (s.manual ? ' (' + s.manual + ' manual' + (s.manual > 1 ? 's' : '') + ')' : ''));
    h += zrow('A conferir', String(s.check), s.check ? ' z-hl' : '');
    h += zrow('Possíveis duplicados', String(s.dups), s.dups ? ' z-hl' : '');
    if (s.skipped) h += zrow('Fora do total (não são cupons)', String(s.skipped));
    if (s.pending) h += zrow('Ainda não lidos', String(s.pending), ' z-hl');
    if (!s.inc.length) {
      h += '<div class="r-rule"></div><p class="z-center">Nenhum lançamento ainda.</p><p class="z-center z-small">Leia os comprovantes na etapa 1.</p><div class="z-end"></div>';
      $('ztape').innerHTML = h; renderExportState(s); return;
    }
    var max = s.byCat.length ? s.byCat[0].total : 0;
    h += '<div class="r-rule"></div><p class="z-sec">POR CATEGORIA</p>';
    s.byCat.forEach(function (g) {
      h += zrow(g.k + ' (' + g.n + ')', moneyPlain(g.total));
      h += '<div class="z-bar" aria-hidden="true"><i data-w="' + (max ? Math.max(2, Math.round(g.total * 100 / max)) : 0) + '"></i></div>';
    });
    h += '<div class="r-rule"></div><p class="z-sec">POR MÊS</p>';
    s.byMonth.forEach(function (g) { h += zrow(monthLabel(g.k) + ' (' + g.n + ')', moneyPlain(g.total)); });
    h += '<div class="r-rule"></div><p class="z-sec">POR FORMA DE PAGAMENTO</p>';
    s.byPay.forEach(function (g) { h += zrow(payLabel(g.k) + ' (' + g.n + ')', moneyPlain(g.total)); });
    h += '<div class="r-rule"></div>';
    h += zrow('Reembolsável', moneyPlain(s.reimb));
    h += zrow('Não reembolsável', moneyPlain(s.notReimb));
    h += '<div class="r-rule"></div>';
    h += zrow('TOTAL', money(s.total), ' z-total');
    if (s.noValue) h += '<p class="z-small">' + s.noValue + ' lançamento(s) sem valor não entraram na soma.</p>';
    h += '<div class="z-end"></div>';
    $('ztape').innerHTML = h;
    // widths via CSSOM (strict CSP: no style="" attributes)
    $('ztape').querySelectorAll('.z-bar i').forEach(function (i) { i.style.width = i.getAttribute('data-w') + '%'; });
    renderExportState(s);
  }
  function renderExportState(s) {
    var has = s.inc.length > 0;
    ['dl-xlsx', 'dl-pdf', 'dl-csv'].forEach(function (id) { $(id).disabled = !has; });
    var w = [];
    if (s.check) w.push(s.check + ' lançamento(s) a conferir');
    if (s.dups) w.push(s.dups + ' possível(is) duplicado(s) ainda somado(s) no total');
    if (s.pending) w.push(s.pending + ' comprovante(s) ainda não lido(s)');
    var el = $('export-warn');
    el.hidden = !has || !w.length;
    el.textContent = w.length ? 'Atenção: ' + w.join(', ') + '. As exportações saem mesmo assim, com a situação de cada lançamento marcada.' : '';
  }

  // ── exports ───────────────────────────────────────────────────────────────
  function situacao(it) { return it.dupOf ? 'Possível duplicado do Nº ' + num3(it.dupOf) : needsCheck(it) ? 'A conferir' : it.checked ? 'Conferido' : 'Lido pela IA'; }
  function exportRows(onlyReimb) {
    return included().filter(function (it) { return !onlyReimb || it.data.reimb; }).slice().sort(function (a, b) {
      var x = a.data.date || '9999', y = b.data.date || '9999'; return x < y ? -1 : x > y ? 1 : a.n - b.n;
    });
  }
  function baseName() { var s = fileSlug(state.lote.name); return s.indexOf('despesas') === 0 ? s : 'despesas-' + s; }

  function exportCSV() {
    var rows = exportRows(false);
    var q = function (v) { v = String(v == null ? '' : v); return /[";\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    var out = [['Nº', 'Data', 'Estabelecimento', 'CNPJ/CPF', 'Descrição', 'Categoria', 'Forma de pagamento', 'Valor (R$)', 'Reembolsável', 'Situação', 'Arquivo'].join(';')];
    rows.forEach(function (it) {
      var d = it.data;
      out.push([num3(it.n), brDate(d.date), d.merchant, d.taxId, d.desc, d.category, payLabel(d.payment), d.total == null ? '' : moneyPlain(d.total).replace(/\./g, ''), d.reimb ? 'Sim' : 'Não', situacao(it), it.kind === 'manual' ? '(manual)' : it.fileName].map(q).join(';'));
    });
    download(new Blob(['﻿' + out.join('\r\n')], { type: 'text/csv;charset=utf-8' }), baseName() + '.csv');
    toast('CSV baixado.');
  }

  function xlsxSerial(iso) { var p = iso.split('-'); return (Date.UTC(+p[0], +p[1] - 1, +p[2]) - Date.UTC(1899, 11, 30)) / 86400000; }
  function exportXLSX() {
    if (!window.XLSX) { toast('A biblioteca da planilha ainda está carregando — tente de novo em instantes.'); return; }
    var X = window.XLSX, rows = exportRows(false), s = summary(), l = state.lote;
    var BRL = '"R$" #,##0.00';
    var head = { font: { bold: true, color: { rgb: 'FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: '23262B' } }, alignment: { vertical: 'center' } };
    var bold = { font: { bold: true } };
    var warn = { fill: { patternType: 'solid', fgColor: { rgb: 'FFF2B3' } } };
    function cell(v, t, z, st) { var c = { v: v, t: t || (typeof v === 'number' ? 'n' : 's') }; if (z) c.z = z; if (st) c.s = st; return c; }
    function sheet(aoa, widths) {
      var ws = {}, maxC = 0;
      aoa.forEach(function (row, r) { row.forEach(function (c, ci) { if (c == null) return; ws[X.utils.encode_cell({ r: r, c: ci })] = (typeof c === 'object' && 'v' in c) ? c : cell(c); maxC = Math.max(maxC, ci); }); });
      ws['!ref'] = X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: Math.max(0, aoa.length - 1), c: maxC } });
      if (widths) ws['!cols'] = widths.map(function (w) { return { wch: w }; });
      return ws;
    }
    // Lançamentos
    var L = [['Nº', 'Data', 'Mês', 'Estabelecimento', 'CNPJ/CPF', 'Descrição', 'Categoria', 'Forma de pagamento', 'Valor (R$)', 'Reembolsável', 'Situação', 'Arquivo'].map(function (h) { return cell(h, 's', null, head); })];
    rows.forEach(function (it) {
      var d = it.data, st = (needsCheck(it) || it.dupOf) ? warn : null;
      L.push([
        cell(it.n, 'n', null, st),
        d.date ? cell(xlsxSerial(d.date), 'n', 'dd/mm/yyyy', st) : cell('', 's', null, st),
        cell(d.date ? monthKey(d.date) : 'sem data', 's', null, st),
        cell(d.merchant, 's', null, st), cell(d.taxId, 's', null, st), cell(d.desc, 's', null, st),
        cell(d.category, 's', null, st), cell(payLabel(d.payment), 's', null, st),
        d.total == null ? cell('', 's', null, st) : cell(d.total, 'n', BRL, st),
        cell(d.reimb ? 'Sim' : 'Não', 's', null, st), cell(situacao(it), 's', null, st),
        cell(it.kind === 'manual' ? '(manual)' : it.fileName, 's', null, st)
      ]);
    });
    var last = rows.length + 1;
    L.push([]);
    L.push([null, null, null, null, null, null, null, cell('TOTAL', 's', null, bold), { t: 'n', f: 'SUM(I2:I' + last + ')', v: s.total, z: BRL, s: bold }]);
    L.push([null, null, null, null, null, null, null, cell('Reembolsável', 's', null, bold), { t: 'n', f: 'SUMIF(J2:J' + last + ',"Sim",I2:I' + last + ')', v: s.reimb, z: BRL, s: bold }]);
    var wsL = sheet(L, [6, 12, 9, 30, 20, 38, 24, 20, 14, 13, 30, 30]);
    wsL['!autofilter'] = { ref: 'A1:L' + last };
    wsL['!freeze'] = { xSplit: 0, ySplit: 1 };
    // Por categoria
    var REF = "'Lançamentos'!";
    var C = [[cell('Categoria', 's', null, head), cell('Lançamentos', 's', null, head), cell('Total (R$)', 's', null, head), cell('% do total', 's', null, head)]];
    s.byCat.forEach(function (g, i) {
      var r = i + 2;
      C.push([g.k, { t: 'n', f: 'COUNTIF(' + REF + 'G2:G' + last + ',A' + r + ')', v: g.n }, { t: 'n', f: 'SUMIF(' + REF + 'G2:G' + last + ',A' + r + ',' + REF + 'I2:I' + last + ')', v: g.total, z: BRL }, { t: 'n', f: 'IF($C$' + (s.byCat.length + 2) + '=0,0,C' + r + '/$C$' + (s.byCat.length + 2) + ')', v: s.total ? g.total / s.total : 0, z: '0.0%' }]);
    });
    var cr = s.byCat.length + 2;
    C.push([cell('TOTAL', 's', null, bold), { t: 'n', f: 'SUM(B2:B' + (cr - 1) + ')', v: s.inc.length, s: bold }, { t: 'n', f: 'SUM(C2:C' + (cr - 1) + ')', v: s.total, z: BRL, s: bold }, null]);
    var wsC = sheet(C, [28, 13, 16, 12]);
    // Por mês
    var M = [[cell('Mês', 's', null, head), cell('Lançamentos', 's', null, head), cell('Total (R$)', 's', null, head)]];
    s.byMonth.forEach(function (g, i) {
      var r = i + 2, k = g.k || 'sem data';
      M.push([k, { t: 'n', f: 'COUNTIF(' + REF + 'C2:C' + last + ',A' + r + ')', v: g.n }, { t: 'n', f: 'SUMIF(' + REF + 'C2:C' + last + ',A' + r + ',' + REF + 'I2:I' + last + ')', v: g.total, z: BRL }]);
    });
    var mr = s.byMonth.length + 2;
    M.push([cell('TOTAL', 's', null, bold), { t: 'n', f: 'SUM(B2:B' + (mr - 1) + ')', v: s.inc.length, s: bold }, { t: 'n', f: 'SUM(C2:C' + (mr - 1) + ')', v: s.total, z: BRL, s: bold }]);
    var wsM = sheet(M, [14, 13, 16]);
    // Lote
    var I = [[cell('Lote', 's', null, head), cell(l.name || 'Lote sem nome', 's', null, head)],
      ['Responsável', l.resp || '—'], ['Finalidade', FINALIDADES[l.final] || FINALIDADES.controle], ['Cliente / projeto', l.cliente || '—'],
      ['Período', s.period ? brDate(s.period.from) + ' a ' + brDate(s.period.to) : '—'], ['Gerado em', nowStamp()],
      ['Lançamentos', s.inc.length], ['A conferir', s.check], ['Possíveis duplicados', s.dups],
      ['Total', cell(s.total, 'n', BRL)], ['Reembolsável', cell(s.reimb, 'n', BRL)],
      [], ['Gerado com Despesas IA — Comunidade Maestros da IA (despesas.maestrosdaia.com). Os valores foram lidos por IA e conferidos pelo usuário.']];
    var wsI = sheet(I, [22, 60]);
    var wb = X.utils.book_new();
    X.utils.book_append_sheet(wb, wsL, 'Lançamentos');
    X.utils.book_append_sheet(wb, wsC, 'Por categoria');
    X.utils.book_append_sheet(wb, wsM, 'Por mês');
    X.utils.book_append_sheet(wb, wsI, 'Lote');
    try {
      var out = X.write(wb, { bookType: 'xlsx', type: 'array' });
      download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), baseName() + '.xlsx');
      toast('Planilha baixada.');
    } catch (e) { toast('Não consegui gerar a planilha: ' + (e && e.message ? e.message : 'erro')); }
  }

  function exportPDF() {
    if (!window.jspdf || !window.jspdf.jsPDF) { toast('O gerador de PDF ainda está carregando — tente de novo em instantes.'); return; }
    var onlyReimb = $('pdf-so-reemb').checked, withAnnex = $('pdf-anexos').checked;
    var rows = exportRows(onlyReimb);
    if (!rows.length) { toast(onlyReimb ? 'Nenhum lançamento marcado como reembolsável.' : 'Nenhum lançamento para o relatório.'); return; }
    var btn = $('dl-pdf'); btn.disabled = true; var old = btn.textContent; btn.textContent = 'Gerando PDF…';
    setTimeout(function () {
      try { buildPDF(rows, onlyReimb, withAnnex); toast('Relatório em PDF baixado.'); }
      catch (e) { toast('Não consegui gerar o PDF: ' + (e && e.message ? e.message : 'erro')); }
      btn.disabled = false; btn.textContent = old;
    }, 30);
  }
  function buildPDF(rows, onlyReimb, withAnnex) {
    var doc = new window.jspdf.jsPDF({ unit: 'mm', format: 'a4', compress: true });
    var W = 210, H = 297, M = 16, l = state.lote;
    var total = Math.round(rows.reduce(function (a, it) { return a + (it.data.total || 0); }, 0) * 100) / 100;
    var reimb = Math.round(rows.filter(function (it) { return it.data.reimb; }).reduce(function (a, it) { return a + (it.data.total || 0); }, 0) * 100) / 100;
    var per = period(rows);
    var INK = [35, 38, 43], MUTED = [85, 89, 96], ACC = [196, 29, 85], PAPER = [247, 245, 239], HL = [244, 211, 94];
    function fit(t, w) { t = String(t || ''); if (doc.getTextWidth(t) <= w) return t; while (t.length > 1 && doc.getTextWidth(t + '…') > w) t = t.slice(0, -1); return t + '…'; }
    var y;
    function header(first) {
      doc.setFillColor(INK[0], INK[1], INK[2]); doc.rect(0, 0, W, first ? 34 : 14, 'F');
      doc.setFillColor(ACC[0], ACC[1], ACC[2]); doc.rect(0, first ? 34 : 14, W, 1.6, 'F');
      doc.setTextColor(255, 255, 255);
      if (first) {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(18); doc.text('RELATÓRIO DE DESPESAS', M, 15);
        doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.text(fit(l.name || 'Lote sem nome', W - 2 * M), M, 23);
        doc.setFontSize(8.5); doc.text((FINALIDADES[l.final] || FINALIDADES.controle) + (onlyReimb ? ' · somente reembolsáveis' : ''), M, 29.5);
        y = 46;
      } else {
        doc.setFont('helvetica', 'bold'); doc.setFontSize(9); doc.text(fit('RELATÓRIO DE DESPESAS · ' + (l.name || ''), W - 2 * M), M, 9);
        y = 24;
      }
      doc.setTextColor(INK[0], INK[1], INK[2]);
    }
    function ensure(h) { if (y + h > H - 18) { doc.addPage(); header(false); return true; } return false; }
    header(true);
    // meta block
    doc.setFontSize(9.5);
    var meta = [];
    if (l.resp) meta.push(['Responsável', l.resp]);
    if (l.cliente) meta.push(['Cliente / projeto', l.cliente]);
    meta.push(['Período', per ? brDate(per.from) + ' a ' + brDate(per.to) : '—']);
    meta.push(['Emitido em', nowStamp()]);
    meta.forEach(function (m) { doc.setFont('helvetica', 'bold'); doc.text(m[0] + ':', M, y); doc.setFont('helvetica', 'normal'); doc.text(fit(m[1], 120), M + 32, y); y += 5.4; });
    // totals box
    y += 3;
    doc.setFillColor(PAPER[0], PAPER[1], PAPER[2]); doc.setDrawColor(INK[0], INK[1], INK[2]); doc.setLineWidth(0.4);
    doc.rect(M, y, W - 2 * M, 22, 'FD');
    var col = (W - 2 * M) / 3;
    [['TOTAL', money(total)], ['REEMBOLSÁVEL', money(reimb)], ['LANÇAMENTOS', String(rows.length)]].forEach(function (b, i) {
      var x = M + 5 + i * col;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]); doc.text(b[0], x, y + 8);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(INK[0], INK[1], INK[2]); doc.text(b[1], x, y + 16.5);
    });
    y += 32;
    // by category
    var cats = {}; rows.forEach(function (it) { var k = it.data.category; cats[k] = (cats[k] || 0) + (it.data.total || 0); });
    var catList = Object.keys(cats).map(function (k) { return { k: k, v: Math.round(cats[k] * 100) / 100 }; }).sort(function (a, b) { return b.v - a.v; });
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('Resumo por categoria', M, y); y += 6;
    var maxv = catList.length ? catList[0].v : 0;
    catList.forEach(function (c) {
      ensure(8);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9.5); doc.text(fit(c.k, 70), M, y);
      var bw = maxv ? (70 * c.v / maxv) : 0;
      doc.setFillColor(INK[0], INK[1], INK[2]); doc.rect(M + 74, y - 3, Math.max(0.8, bw), 3.2, 'F');
      doc.text(money(c.v) + '  (' + (total ? Math.round(c.v * 1000 / total) / 10 : 0).toString().replace('.', ',') + '%)', W - M, y, { align: 'right' });
      y += 6.4;
    });
    // ledger table
    y += 4; ensure(20);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11); doc.text('Lançamentos', M, y); y += 4;
    var cols = [{ t: 'Nº', w: 9 }, { t: 'Data', w: 18 }, { t: 'Estabelecimento / descrição', w: 62 }, { t: 'Categoria', w: 38 }, { t: 'Pagamento', w: 28 }, { t: 'Valor', w: 23, r: true }];
    function tableHead() {
      doc.setFillColor(INK[0], INK[1], INK[2]); doc.rect(M, y, W - 2 * M, 7, 'F');
      doc.setTextColor(255, 255, 255); doc.setFont('helvetica', 'bold'); doc.setFontSize(8.2);
      var x = M + 1.5; cols.forEach(function (c) { doc.text(c.t, c.r ? x + c.w - 3 : x, y + 4.8, c.r ? { align: 'right' } : undefined); x += c.w; });
      doc.setTextColor(INK[0], INK[1], INK[2]); y += 7;
    }
    tableHead();
    rows.forEach(function (it, i) {
      var d = it.data, rh = d.desc ? 10 : 6.6;
      if (ensure(rh + 2)) tableHead();
      var flagged = needsCheck(it) || it.dupOf;
      if (flagged) { doc.setFillColor(HL[0], HL[1], HL[2]); doc.rect(M, y, W - 2 * M, rh, 'F'); }
      else if (i % 2) { doc.setFillColor(PAPER[0], PAPER[1], PAPER[2]); doc.rect(M, y, W - 2 * M, rh, 'F'); }
      var x = M + 1.5;
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.4);
      doc.text(num3(it.n), x, y + 4.4); x += cols[0].w;
      doc.text(brDate(d.date) || '—', x, y + 4.4); x += cols[1].w;
      doc.setFont('helvetica', 'bold'); doc.text(fit(d.merchant || '—', cols[2].w - 3), x, y + 4.4);
      if (d.desc) { doc.setFont('helvetica', 'normal'); doc.setFontSize(7.4); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]); doc.text(fit(d.desc, cols[2].w - 3), x, y + 8.2); doc.setTextColor(INK[0], INK[1], INK[2]); doc.setFontSize(8.4); }
      x += cols[2].w;
      doc.setFont('helvetica', 'normal'); doc.text(fit(d.category, cols[3].w - 2), x, y + 4.4); x += cols[3].w;
      doc.text(fit(payLabel(d.payment), cols[4].w - 2), x, y + 4.4); x += cols[4].w;
      doc.setFont('helvetica', 'bold'); doc.text(d.total == null ? '—' : moneyPlain(d.total), x + cols[5].w - 3, y + 4.4, { align: 'right' });
      y += rh;
      doc.setDrawColor(215, 211, 199); doc.setLineWidth(0.2); doc.line(M, y, W - M, y);
    });
    ensure(14);
    y += 2;
    doc.setFont('helvetica', 'bold'); doc.setFontSize(11);
    doc.text('TOTAL', M + 1.5, y + 5); doc.text(money(total), W - M - 1.5, y + 5, { align: 'right' });
    y += 9;
    if (rows.some(function (it) { return needsCheck(it) || it.dupOf; })) {
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text('Linhas destacadas em amarelo estão marcadas como “a conferir” ou “possível duplicado”.', M, y + 2); y += 6;
      doc.setTextColor(INK[0], INK[1], INK[2]);
    }
    if (l.final === 'reembolso' || l.final === 'cliente') {
      if (ensure(34)) {}
      y += 18;
      doc.setDrawColor(INK[0], INK[1], INK[2]); doc.setLineWidth(0.3);
      doc.line(M, y, M + 75, y); doc.line(W - M - 75, y, W - M, y);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8.5);
      doc.text(fit(l.resp || 'Responsável', 75), M, y + 4.5); doc.text('Aprovado por', W - M - 75, y + 4.5);
      y += 10;
    }
    // annex
    if (withAnnex) {
      var withImg = rows.filter(function (it) { return it.images && it.images.length; });
      withImg.forEach(function (it) {
        it.images.forEach(function (src, pi) {
          doc.addPage(); header(false);
          doc.setFont('helvetica', 'bold'); doc.setFontSize(10.5);
          doc.text(fit('Anexo · Nº ' + num3(it.n) + ' · ' + (brDate(it.data.date) || 'sem data') + ' · ' + (it.data.merchant || it.fileName) + ' · ' + (it.data.total == null ? '—' : money(it.data.total)) + (it.images.length > 1 ? ' · pág. ' + (pi + 1) : ''), W - 2 * M), M, y);
          var props = doc.getImageProperties(src);
          var maxW = W - 2 * M, maxH = H - y - 22;
          var s = Math.min(maxW / props.width, maxH / props.height);
          var iw = props.width * s, ih = props.height * s;
          doc.setDrawColor(215, 211, 199); doc.setLineWidth(0.3);
          doc.addImage(src, 'JPEG', M + (maxW - iw) / 2, y + 4, iw, ih, undefined, 'FAST');
          doc.rect(M + (maxW - iw) / 2, y + 4, iw, ih);
        });
      });
    }
    var n = doc.getNumberOfPages();
    for (var p = 1; p <= n; p++) {
      doc.setPage(p);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(7.5); doc.setTextColor(MUTED[0], MUTED[1], MUTED[2]);
      doc.text('Gerado com Despesas IA — Comunidade Maestros da IA · valores lidos por IA e conferidos pelo usuário', M, H - 8);
      doc.text('Página ' + p + ' de ' + n, W - M, H - 8, { align: 'right' });
    }
    doc.save(baseName() + (onlyReimb ? '-reembolsaveis' : '') + '.pdf');
  }

  // ── lotes ─────────────────────────────────────────────────────────────────
  function renderLotes() {
    var list = loadIndex();
    var cur = state.lote ? state.lote.id : null;
    if (state.lote) { list = list.filter(function (x) { return x.id !== cur; }); list.unshift(indexEntry(state.lote)); }
    $('lotes-list').innerHTML = list.map(function (x) {
      var on = x.id === cur;
      return '<article class="lote-card' + (on ? ' on' : '') + '" data-id="' + esc(x.id) + '"><h3>' + esc(x.name) + '</h3>' +
        '<p class="lote-meta">' + esc(FINALIDADES[x.final] || FINALIDADES.controle) + (x.resp ? ' · ' + esc(x.resp) : '') + '</p>' +
        '<p class="lote-meta">' + x.count + (x.count === 1 ? ' item' : ' itens') + ' · criado em ' + esc(new Date(x.created || x.updated).toLocaleDateString('pt-BR')) + '</p>' +
        '<p class="lote-total">' + esc(money(x.total)) + '</p>' +
        '<div class="lote-btns">' + (on ? '<span class="stamp s-done">Aberto</span>' : '<button type="button" class="btn-primary" data-act="open">Abrir</button>') +
        '<button type="button" class="btn-ghost" data-act="del">Excluir</button></div></article>';
    }).join('') || '<p class="empty-note">Nenhum lote salvo ainda.</p>';
  }
  function onLotesClick(e) {
    var b = e.target.closest('[data-act]'); if (!b) return;
    var card = b.closest('.lote-card'); var id = card && card.getAttribute('data-id'); if (!id) return;
    if (state.running) { toast('Aguarde a leitura terminar.'); return; }
    if (b.getAttribute('data-act') === 'open') {
      saveNow().then(function () { return getLote(id); }).then(function (l) {
        if (!l) { toast('Esse lote não está mais neste navegador.'); storeIndex(loadIndex().filter(function (x) { return x.id !== id; })); renderLotes(); return; }
        setLote(l); gotoTab(l.items.some(isEntry) ? 'lancamentos' : 'comprovantes'); toast('Lote “' + (l.name || '') + '” aberto.');
      }).catch(function () { toast('Não consegui abrir o lote.'); });
    } else {
      var entry = loadIndex().filter(function (x) { return x.id === id; })[0];
      var name = (state.lote && state.lote.id === id) ? state.lote.name : (entry && entry.name);
      if (!confirm('Excluir o lote “' + (name || '') + '” e as imagens dele deste navegador?')) return;
      storeIndex(loadIndex().filter(function (x) { return x.id !== id; }));
      var p = state.db ? delLote(id) : Promise.resolve();
      p.catch(function () {}).then(function () {
        if (state.lote && state.lote.id === id) { setLote(newLote()); saveNow(); }
        renderLotes(); toast('Lote excluído.');
      });
    }
  }
  function startNewLote() {
    if (state.running) { toast('Aguarde a leitura terminar.'); return; }
    saveNow().then(function () { setLote(newLote()); saveNow(); gotoTab('comprovantes'); $('in-nome').focus(); $('in-nome').select(); toast('Lote novo aberto.'); });
  }
  function setLote(l) {
    l.items = l.items || []; l.seq = l.seq || l.items.reduce(function (a, it) { return Math.max(a, it.n || 0); }, 0);
    l.items.forEach(function (it) { if (it.status === 'reading') it.status = 'queue'; it.data = it.data || emptyData(); });
    state.lote = l; state.filter = 'todos'; state.catFilter = '';
    syncFilterUI(); fillLoteForm(); computeDups(); renderAll();
  }

  // ── chrome ────────────────────────────────────────────────────────────────
  function gotoTab(name) {
    document.querySelectorAll('.tab').forEach(function (b) {
      var on = b.getAttribute('data-tab') === name;
      b.classList.toggle('on', on); b.setAttribute('aria-selected', on ? 'true' : 'false'); b.tabIndex = on ? 0 : -1;
    });
    document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('on', p.id === 'pane-' + name); });
    if (name === 'lancamentos') renderLedger();
    if (name === 'resumo') renderResumo();
    if (name === 'lotes') renderLotes();
    var tabs = document.querySelector('.tabs');
    if (tabs && tabs.getBoundingClientRect().top < 0) tabs.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  function currentTab() { var t = document.querySelector('.tab.on'); return t ? t.getAttribute('data-tab') : 'comprovantes'; }
  function renderCounts() {
    var files = state.lote.items.filter(function (it) { return it.kind !== 'manual'; }).length;
    $('count-files').textContent = files;
    var chk = state.lote.items.filter(function (it) { return needsCheck(it) || it.dupOf; }).length;
    var c = $('count-review'); c.textContent = chk; c.hidden = chk === 0;
    c.setAttribute('aria-label', chk + ' a conferir');
    $('lote-pill').textContent = state.lote.name || '';
  }
  function fillLoteForm() {
    var l = state.lote;
    $('in-nome').value = l.name || ''; $('in-resp').value = l.resp || ''; $('in-final').value = l.final || 'controle'; $('in-cliente').value = l.cliente || '';
  }
  function renderAll() {
    renderFiles(); renderCounts();
    var t = currentTab();
    if (t === 'lancamentos') renderLedger();
    if (t === 'resumo') renderResumo();
    if (t === 'lotes') renderLotes();
  }
  function fillCatFilter() {
    $('cat-filter').innerHTML = '<option value="">Todas as categorias</option>' + CATEGORIES.map(function (c) { return '<option>' + esc(c) + '</option>'; }).join('');
  }

  function init() {
    if (state.wired) { if (window.ApiKeyManager) { var s = $('model-select'); if (s && !s.options.length) ApiKeyManager.renderModelPicker('model-select'); } return; }
    state.wired = true;
    if (window.ApiKeyManager) ApiKeyManager.renderModelPicker('model-select'); // COR-041/047
    fillCatFilter();

    document.querySelectorAll('.tab').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-tab')); }); });
    var tabsEl = document.querySelector('.tabs');
    tabsEl.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      var tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
      var i = tabs.indexOf(document.activeElement); if (i === -1) return;
      var n = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      n.focus(); gotoTab(n.getAttribute('data-tab')); e.preventDefault();
    });
    document.querySelectorAll('[data-goto]').forEach(function (b) { b.addEventListener('click', function () { gotoTab(b.getAttribute('data-goto')); }); });

    function bindLote(id, k) {
      $(id).addEventListener(id === 'in-final' ? 'change' : 'input', function () {
        state.lote[k] = this.value.trim ? this.value.trim() : this.value;
        if (k === 'name') renderCounts();
        save();
      });
    }
    bindLote('in-nome', 'name'); bindLote('in-resp', 'resp'); bindLote('in-final', 'final'); bindLote('in-cliente', 'cliente');

    var dz = $('dropzone'), fi = $('file-input');
    fi.addEventListener('change', function () { var f = fi.files; addFiles(f).then(function () { fi.value = ''; }); });
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); if (!state.running) dz.classList.add('drag'); }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.classList.remove('drag'); }); });
    dz.addEventListener('drop', function (e) { if (state.running) { toast('Aguarde a leitura terminar para adicionar mais.'); return; } if (e.dataTransfer && e.dataTransfer.files.length) addFiles(e.dataTransfer.files); });
    window.addEventListener('dragover', function (e) { e.preventDefault(); });
    window.addEventListener('drop', function (e) { e.preventDefault(); });

    $('process-btn').addEventListener('click', runProcessing);
    $('stop-btn').addEventListener('click', stopProcessing);
    $('sample-btn').addEventListener('click', loadSamples);
    $('clear-files').addEventListener('click', function () {
      if (state.running) return;
      var n = state.lote.items.length; if (!n) return;
      if (!confirm('Tirar todos os ' + n + ' itens deste lote (comprovantes e lançamentos)?')) return;
      state.lote.items = []; state.lote.seq = 0; showProcessError(''); showDzNote(''); save(); renderAll(); toast('Lote esvaziado.');
    });
    $('file-list').addEventListener('click', onSpikeClick);

    $('ledger').addEventListener('input', onLedgerInput);
    $('ledger').addEventListener('change', onLedgerInput);
    $('ledger').addEventListener('click', onLedgerClick);
    document.querySelectorAll('.filter').forEach(function (f) {
      f.addEventListener('click', function () { state.filter = f.getAttribute('data-filter'); syncFilterUI(); renderLedger(); });
    });
    syncFilterUI();
    $('cat-filter').addEventListener('change', function () { state.catFilter = this.value; renderLedger(); });
    $('add-manual').addEventListener('click', addManual);

    $('dl-xlsx').addEventListener('click', exportXLSX);
    $('dl-csv').addEventListener('click', exportCSV);
    $('dl-pdf').addEventListener('click', exportPDF);

    $('lotes-list').addEventListener('click', onLotesClick);
    $('new-lote').addEventListener('click', startNewLote);

    document.querySelectorAll('[data-close-zoom]').forEach(function (b) { b.addEventListener('click', closeZoom); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('zoom-modal').hidden) closeZoom(); });

    // COR-062: logout must leave the login form empty for the next person
    var lo = $('logout-btn');
    if (lo) lo.addEventListener('click', function () {
      var em = $('gate-email'), ph = $('gate-phone'), er = $('gate-error');
      if (em) em.value = ''; if (ph) ph.value = ''; if (er) { er.textContent = ''; er.style.display = 'none'; }
    });
    $('wipe-local').addEventListener('click', function () {
      if (state.running) { toast('Aguarde a leitura terminar.'); return; }
      if (!confirm('Apagar deste navegador todos os lotes, comprovantes, a sua chave de IA e a sua sessão? Isso não pode ser desfeito.')) return;
      state.wiping = true;
      try {
        var drop = [];
        for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); if (/^(despesas|maestria_)/.test(k)) drop.push(k); }
        drop.forEach(function (k) { localStorage.removeItem(k); });
      } catch (e) {}
      try { if (state.db) state.db.close(); } catch (e) {}
      var done = function () { location.reload(); };
      try { var r = indexedDB.deleteDatabase(DB_NAME); r.onsuccess = done; r.onerror = done; r.onblocked = done; setTimeout(done, 1500); } catch (e) { done(); }
    });
    window.addEventListener('beforeunload', function () { if (!state.wiping) saveNow(); });

    // load the current lote
    setLote(newLote());
    openDB().then(function (db) {
      state.db = db;
      var cur = null; try { cur = localStorage.getItem(CURRENT_SLOT); } catch (e) {}
      var idx = loadIndex();
      var id = cur || (idx[0] && idx[0].id);
      return id ? getLote(id) : null;
    }).then(function (l) {
      if (l) { setLote(l); if (l.items.some(isEntry)) gotoTab('lancamentos'); }
      else saveNow();
    }).catch(function () {
      state.dbFailed = true;
      toast('Este navegador não deixa salvar lotes (modo privado?). Você pode usar normalmente, mas exporte antes de sair.');
    });
  }

  return { init: init };
})();

// ── App init triggers: event + DOMContentLoaded + MutationObserver (COR-044) ──
(function () {
  var started = false;
  function go() { if (started) { App.init(); return; } started = true; App.init(); }
  document.addEventListener('maestria:app-ready', go);
  document.addEventListener('DOMContentLoaded', function () {
    var app = document.getElementById('app-screen');
    if (app && app.classList.contains('active')) { setTimeout(go, 100); }
    if (app) {
      var mo = new MutationObserver(function () { if (app.classList.contains('active')) go(); });
      mo.observe(app, { attributes: true, attributeFilter: ['class'] });
    }
  });
})();

// Key inputs live in <form>s (no "password field outside a form" note); Enter must not reload the page.
document.addEventListener('submit', function (e) {
  var id = e.target && e.target.id;
  if (id === 'key-inputs' || id === 'modal-key-inputs') e.preventDefault();
}, true);
