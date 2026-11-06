// cPRA-MEX interface. The calculation runs on the cPRA-MEX server (see
// ../api): this page sends the list of antigens and receives only results.
// The haplotype frequencies are never downloaded to the browser.

(function () {
  'use strict';

  const MAX_TOKENS = 600;
  const MAX_BATCH_ROWS = 5000;
  const BATCH_CHUNK = 500;
  const POOL_LABELS = {
    NACIONAL: 'Nacional', CENTER: 'Centro', CTRGULF: 'Centro-Golfo', MAYA: 'Maya', NORTH: 'Norte', OCCIDENTE: 'Occidente'
  };
  const SCOPE_LABELS = {
    Global: 'Global', ClaseI: 'HLA clase I', ClaseII: 'HLA clase II', A: 'HLA-A', B: 'HLA-B', C: 'HLA-C',
    DRB1: 'HLA-DRB1', DRB345: 'HLA-DRB3/4/5', DQA1: 'HLA-DQA1', DQB1: 'HLA-DQB1', DPA1: 'HLA-DPA1', DPB1: 'HLA-DPB1'
  };
  const STATUS_LABELS = {
    ok: 'Incluido', sin_frecuencia: 'Sin frecuencia: aporta 0', no_reconocido: 'No reconocido: no incluido'
  };
  const EXAMPLE = ['A2', 'B35', 'Cw7', 'DR51', 'DQ7', 'DRB1*04:07'];

  // The page and the API share the origin when served by tests/dev_server.R.
  const API_BASE = /^(localhost|127\.0\.0\.1)$/.test(location.hostname)
    ? '' : String(document.querySelector('meta[name="cpra-api"]').content || '').replace(/\/+$/, '');

  let options = null;
  let choices = [];
  let entries = [];
  let lastCalc = null;
  let batchRows = null;
  let activeSuggestion = -1;
  let busy = false;
  const statusCache = new Map();

  const byId = function (id) { return document.getElementById(id); };
  const box = byId('ua-caja');
  const input = byId('ua-texto');
  const suggestions = byId('ua-sugerencias');

  // Elements are built with text nodes only, so user input is never parsed as HTML.
  function h(tag, attrs) {
    const node = document.createElement(tag);
    Object.keys(attrs || {}).forEach(function (name) {
      if (attrs[name] !== null && attrs[name] !== undefined) node.setAttribute(name, attrs[name]);
    });
    for (let i = 2; i < arguments.length; i++) append(node, arguments[i]);
    return node;
  }
  function append(node, child) {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) { child.forEach(function (item) { append(node, item); }); return; }
    node.appendChild(typeof child === 'object' ? child : document.createTextNode(String(child)));
  }
  function replace(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    for (let i = 1; i < arguments.length; i++) append(node, arguments[i]);
  }

  function splitTokens(text) {
    return String(text == null ? '' : text).split(/[,;|\s]+/).filter(function (token) { return token.length > 0; });
  }
  function displayToken(value) {
    return value.replace(/^CW(?=[0-9])/, 'Cw').replace(/^BW(?=[46]$)/, 'Bw');
  }

  // ---- Servidor ----------------------------------------------------------------
  async function apiRequest(method, path, body) {
    const controller = new AbortController();
    // The first request after a quiet period starts a new server instance.
    const timer = setTimeout(function () { controller.abort(); }, 60000);
    let response;
    try {
      response = await fetch(API_BASE + path, {
        method: method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store'
      });
    } catch (error) {
      throw new Error('No se pudo conectar con el servidor de cálculo. Revise su conexión e intente de nuevo.');
    } finally {
      clearTimeout(timer);
    }
    let data = null;
    try { data = await response.json(); } catch (error) { data = null; }
    if (!response.ok) {
      throw new Error((data && data.error) || ('El servidor respondió con un error (' + response.status + ').'));
    }
    return data;
  }

  // ---- Formato ---------------------------------------------------------------
  function fmtPct(p) {
    if (p <= 0) return '0%';
    if (p >= 1) return '100%';
    const pct = 100 * p;
    const out = pct.toFixed(pct >= 99 || pct < 1 ? 4 : 2);
    if (Number(out) >= 100) return '>99.9999%';
    if (Number(out) <= 0) return '<0.0001%';
    return out + '%';
  }
  function fmtDetail(p) { return p.toFixed(6); }
  function fmtCount(x) { return Math.round(x).toLocaleString('en-US'); }
  function perHundred(share) {
    if (share <= 0) return 'ninguno';
    if (share >= 1) return 'los 100';
    const n = Math.round(100 * share);
    if (n < 1) return 'menos de 1';
    if (n > 99) return 'más de 99';
    return String(n);
  }
  // Categories used in the study (unrounded value): <20, 20-<50, 50-<80,
  // 80-<95, 95-<98, 98-<99, >=99.
  function category(p) {
    const pct = 100 * p;
    if (pct <= 0) return { label: 'Sin sensibilización frente a los antígenos indicados', level: 'bajo' };
    if (pct < 20) return { label: 'cPRA < 20%', level: 'bajo' };
    if (pct < 50) return { label: 'cPRA 20% a < 50%', level: 'medio' };
    if (pct < 80) return { label: 'cPRA 50% a < 80%', level: 'medio' };
    if (pct < 95) return { label: 'cPRA 80% a < 95%', level: 'alto' };
    if (pct < 98) return { label: 'cPRA 95% a < 98%', level: 'alto' };
    if (pct < 99) return { label: 'cPRA 98% a < 99%', level: 'muy-alto' };
    return { label: 'cPRA ≥ 99%', level: 'muy-alto' };
  }
  function table(header, rows, extraClass) {
    return h('div', { class: 'tabla-marco' }, h('table', { class: 'tabla' + (extraClass ? ' ' + extraClass : '') },
      h('thead', null, h('tr', null, header.map(function (cell) {
        return h('th', { scope: 'col', class: cell.num ? 'num' : null }, cell.text || cell);
      }))),
      h('tbody', null, rows)));
  }
  const num = function (text) { return { text: text, num: true }; };
  function regionWeight(id) {
    const region = options.referencia.regiones.filter(function (item) { return item.id === id; })[0];
    return region ? (100 * region.peso).toFixed(1) + '%' : '100%';
  }

  // ---- Selector de antígenos ---------------------------------------------------
  function entryKey(text) { return text.replace(/\s+/g, '').toUpperCase(); }

  function addEntries(text) {
    splitTokens(text).forEach(function (token) {
      if (entries.length >= MAX_TOKENS) return;
      const key = entryKey(token);
      if (entries.some(function (entry) { return entryKey(entry) === key; })) return;
      entries.push(token);
    });
    renderEntries();
    scheduleStatusRefresh();
  }

  function renderEntries() {
    Array.from(box.querySelectorAll('.ficha')).forEach(function (chip) { chip.remove(); });
    entries.forEach(function (entry, i) {
      const status = statusCache.get(entryKey(entry));
      const label = status ? status.etiqueta : entry;
      const remove = h('button', { type: 'button', 'aria-label': 'Quitar ' + label }, '×');
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        entries.splice(i, 1);
        renderEntries();
        input.focus();
      });
      const chip = h('span', {
        class: 'ficha' + (status && status.estado !== 'ok' ? ' ficha-' + status.estado : ''),
        title: status ? (status.nota || STATUS_LABELS[status.estado]) : null
      }, label, remove);
      box.insertBefore(chip, input);
    });
    input.placeholder = entries.length ? '' : 'Ej.: A2, B35, Cw7, DR51, DQ7, DRB1*04:07';
  }

  // Chip colours come from the server; a failure here only leaves them uncoloured.
  let statusTimer = null;
  function scheduleStatusRefresh() {
    clearTimeout(statusTimer);
    statusTimer = setTimeout(function () {
      const pending = entries.filter(function (entry) { return !statusCache.has(entryKey(entry)); });
      if (!pending.length || !options) return;
      apiRequest('POST', '/api/interpretar', { entradas: pending }).then(function (data) {
        data.entradas.forEach(function (item) { statusCache.set(entryKey(item.entrada), item); });
        renderEntries();
      }).catch(function () { /* colours are optional */ });
    }, 250);
  }

  function hideSuggestions() {
    suggestions.hidden = true;
    activeSuggestion = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function showSuggestions() {
    const query = entryKey(input.value).replace(/^HLA-/, '').replace(/^C(?=[0-9])/, 'CW');
    if (!query || !choices.length) { hideSuggestions(); return; }
    const chosen = new Set(entries.map(entryKey));
    const matches = [];
    for (let i = 0; i < choices.length && matches.length < 300; i++) {
      if (choices[i].key.startsWith(query) && !chosen.has(choices[i].key)) matches.push(choices[i]);
    }
    if (!matches.length) { hideSuggestions(); return; }
    replace(suggestions, matches.map(function (choice, i) {
      const item = h('li', { role: 'option', id: 'sugerencia-' + i, 'aria-selected': 'false' },
        h('span', null, choice.value), h('span', { class: 'grupo' }, choice.group));
      // mousedown keeps the focus on the text field, so blur does not commit the partial text first.
      item.addEventListener('mousedown', function (event) {
        event.preventDefault();
        input.value = '';
        addEntries(choice.value);
        hideSuggestions();
      });
      return item;
    }));
    suggestions.hidden = false;
    activeSuggestion = -1;
    input.setAttribute('aria-expanded', 'true');
  }

  function moveSuggestion(step) {
    const items = suggestions.children;
    if (suggestions.hidden || !items.length) return;
    if (activeSuggestion >= 0) items[activeSuggestion].setAttribute('aria-selected', 'false');
    activeSuggestion = (activeSuggestion + step + items.length + (activeSuggestion < 0 && step < 0 ? 1 : 0)) % items.length;
    items[activeSuggestion].setAttribute('aria-selected', 'true');
    items[activeSuggestion].scrollIntoView({ block: 'nearest' });
    input.setAttribute('aria-activedescendant', items[activeSuggestion].id);
  }

  function commitInput() {
    const text = input.value;
    input.value = '';
    hideSuggestions();
    if (text.trim()) addEntries(text);
  }

  box.addEventListener('click', function () { input.focus(); });
  input.addEventListener('input', function () {
    if (/[,;|\s]/.test(input.value)) commitInput(); else showSuggestions();
  });
  input.addEventListener('paste', function (event) {
    const text = (event.clipboardData || window.clipboardData).getData('text');
    event.preventDefault();
    addEntries(input.value + ' ' + text);
    input.value = '';
    hideSuggestions();
  });
  input.addEventListener('blur', commitInput);
  input.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); moveSuggestion(1); return; }
    if (event.key === 'ArrowUp') { event.preventDefault(); moveSuggestion(-1); return; }
    if (event.key === 'Escape') { hideSuggestions(); return; }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (activeSuggestion >= 0) {
        const value = suggestions.children[activeSuggestion].firstChild.textContent;
        input.value = '';
        addEntries(value);
        hideSuggestions();
      } else if (input.value.trim()) {
        commitInput();
      } else {
        calculate();
      }
      return;
    }
    if (event.key === 'Backspace' && !input.value && entries.length) {
      entries.pop();
      renderEntries();
    }
  });

  // ---- Resultado ---------------------------------------------------------------
  function pictogram(p) {
    const incompatible = Math.round(100 * p);
    const node = h('div', {
      class: 'pictograma', role: 'img',
      'aria-label': 'De 100 donantes, ' + incompatible + ' incompatibles y ' + (100 - incompatible) + ' compatibles'
    });
    const namespace = 'http://www.w3.org/2000/svg';
    for (let i = 0; i < 100; i++) {
      const svg = document.createElementNS(namespace, 'svg');
      svg.setAttribute('class', 'persona ' + (i < incompatible ? 'inc' : 'comp'));
      svg.setAttribute('viewBox', '0 0 20 44');
      svg.setAttribute('aria-hidden', 'true');
      const use = document.createElementNS(namespace, 'use');
      use.setAttribute('href', '#persona');
      svg.appendChild(use);
      node.appendChild(svg);
    }
    return node;
  }

  function renderResult() {
    const target = byId('resultado');
    if (!lastCalc) return;
    const pool = byId('pool').value;
    const tokens = lastCalc.tokens;
    const cpra = lastCalc.result.cpra;
    const p = cpra.Global[pool];
    const compatible = 1 - p;
    const unknown = tokens.filter(function (token) { return token.estado === 'no_reconocido'; });
    const zero = tokens.filter(function (token) { return token.estado === 'sin_frecuencia'; });
    const info = category(p);
    const parts = [];

    if (unknown.length) {
      parts.push(h('div', { class: 'aviso aviso-error', role: 'alert' },
        h('strong', null, unknown.length === 1 ? '1 entrada no se reconoció y no entró al cálculo: '
          : unknown.length + ' entradas no se reconocieron y no entraron al cálculo: '),
        unknown.map(function (token) { return token.entrada; }).join(', ') +
        '. El cPRA mostrado puede estar subestimado; corrija la entrada y calcule de nuevo.'));
    }
    if (zero.length) {
      parts.push(h('div', { class: 'aviso aviso-alerta', role: 'alert' },
        h('strong', null, zero.length === 1 ? '1 especificidad sin frecuencia en la referencia mexicana y aporta 0 al cPRA: '
          : zero.length + ' especificidades sin frecuencia en la referencia mexicana y aportan 0 al cPRA: '),
        zero.map(function (token) { return displayToken(token.normalizado); }).join(', ') +
        '. Esto refleja la cobertura de la referencia, no la ausencia del alelo en la población. Revise el detalle por entrada al final.'));
    }
    if (!tokens.length) {
      parts.push(h('div', { class: 'aviso aviso-info' }, 'No se indicaron antígenos inaceptables; el cPRA es 0%.'));
    }

    const sentence = p <= 0
      ? ['Sin antígenos inaceptables con frecuencia en la referencia, no se espera incompatibilidad HLA con ningún donante por este motivo.']
      : ['Con los antígenos inaceptables indicados, se espera que el candidato sea incompatible con aproximadamente ',
        h('strong', null, perHundred(p) + ' de cada 100 donantes'),
        ' de la población de referencia, y que pueda recibir un órgano, sin los antígenos señalados, de aproximadamente ',
        h('strong', null, perHundred(compatible) + ' de cada 100'), '.',
        p >= 0.5 && compatible > 0
          ? [' Esto equivale a cerca de ', h('strong', null, '1 donante compatible por cada ' + fmtCount(1 / compatible)), '.']
          : null];

    parts.push(h('section', { class: 'resultado' },
      h('div', { class: 'resultado-cifras' },
        h('div', null, h('span', { class: 'rotulo' }, 'cPRA-MEX'), h('span', { class: 'valor' }, fmtPct(p))),
        h('div', null, h('span', { class: 'rotulo' }, 'cPRA detallado'), h('span', { class: 'valor-detalle' }, fmtDetail(p))),
        h('div', null, h('span', { class: 'rotulo' }, 'Población de referencia'), h('span', { class: 'valor-detalle' }, POOL_LABELS[pool]))),
      h('p', { class: 'frase' }, sentence),
      h('p', null, h('span', { class: 'categoria categoria-' + info.level }, info.label)),
      pictogram(p),
      h('p', { class: 'leyenda' },
        h('span', { class: 'muestra inc' }), 'Donante incompatible',
        h('span', { class: 'muestra comp' }), 'Donante compatible',
        h('span', { class: 'leyenda-nota' }, 'Cada figura representa 1 de cada 100 donantes; las cifras están redondeadas.'))));

    const scopeRows = Object.keys(SCOPE_LABELS).map(function (scope) {
      const value = cpra[scope][pool];
      return h('tr', { class: scope === 'Global' || scope === 'ClaseI' || scope === 'ClaseII' ? 'fila-resumen' : null },
        h('th', { scope: 'row' }, SCOPE_LABELS[scope]),
        h('td', { class: 'num' }, fmtPct(value)), h('td', { class: 'num' }, fmtDetail(value)));
    });
    const poolRows = lastCalc.pools.map(function (name) {
      const value = cpra.Global[name];
      return h('tr', { class: name === pool ? 'fila-activa' : null },
        h('th', { scope: 'row' }, POOL_LABELS[name], name === pool ? h('span', { class: 'etiqueta' }, 'seleccionada') : null),
        h('td', { class: 'num' }, fmtPct(value)),
        h('td', { class: 'num' }, perHundred(1 - value)),
        h('td', { class: 'num' }, regionWeight(name)));
    });
    parts.push(h('div', { class: 'par' },
      h('div', { class: 'tarjeta' }, h('h2', { class: 'tarjeta-titulo' }, 'cPRA por clase y locus'),
        h('div', { class: 'tarjeta-cuerpo' },
          table(['Categoría', num('cPRA'), num('Detallado')], scopeRows),
          h('p', { class: 'pie' }, 'Cada valor se calcula solo con los antígenos de ese locus o clase. No se suman entre sí.'))),
      h('div', { class: 'tarjeta' }, h('h2', { class: 'tarjeta-titulo' }, 'Comparación por región'),
        h('div', { class: 'tarjeta-cuerpo' },
          table(['Población', num('cPRA'), num('Compatibles por cada 100'), num('Peso en el pool nacional')], poolRows),
          h('p', { class: 'pie' }, 'El pool nacional pondera las cinco regiones por su tamaño efectivo. Use una región solo si representa mejor el origen de los donantes del programa.')))));

    if (tokens.length) {
      const tokenRows = tokens.map(function (token, i) {
        const alleles = token.alelos;
        const allelesCell = !alleles.length ? '—' : (alleles.length <= 3 ? alleles.join(', ')
          : h('details', null, h('summary', null, alleles.length + ' alelos'), alleles.join(', ')));
        const hatsNote = hatsDifference(token, i, pool);
        return h('tr', null,
          h('th', { scope: 'row' }, token.entrada),
          h('td', null, token.tipo || '—'),
          h('td', null, token.locus ? SCOPE_LABELS[token.locus] : '—'),
          h('td', null, assignmentCell(token)),
          h('td', null, allelesCell),
          h('td', { class: 'num' }, token.estado === 'no_reconocido' ? '—' : fmtPct(lastCalc.result.target[i][pool])),
          h('td', null, h('span', { class: 'estado estado-' + token.estado }, STATUS_LABELS[token.estado]),
            token.nota ? h('div', { class: 'nota' }, token.nota) : null,
            hatsNote ? h('div', { class: hatsNote.aviso ? 'nota nota-aviso' : 'nota' }, hatsNote.texto) : null));
      });
      parts.push(h('div', { class: 'tarjeta' }, h('h2', { class: 'tarjeta-titulo' }, 'Cómo se interpretó cada entrada'),
        h('div', { class: 'tarjeta-cuerpo' },
          table(['Entrada', 'Tipo', 'Locus', 'Equivalencia serológica (OMS)', 'Alelos de la referencia', num('cPRA individual'), 'Estado'], tokenRows),
          h('p', { class: 'pie' },
            'La equivalencia serológica es la asignada por la OMS en IPD-IMGT/HLA 3.65.0: antígeno amplio, su split cuando existe, y la designación asociada a nivel alélico (por ejemplo A0201). El cálculo usa esa asignación; cuando la tabla HATS abarca más alelos se indica en la columna «Estado». Bw4 y Bw6 siempre se evalúan con HATS, solo en HLA-B.'))));
    }
    replace(target, parts);
  }

  async function calculate() {
    if (!options || busy) return;
    commitInput();
    busy = true;
    const button = byId('calcular');
    button.disabled = true;
    button.textContent = 'Calculando…';
    try {
      const data = await apiRequest('POST', '/api/calcular', { antigenos: entries.join(' ') });
      lastCalc = {
        tokens: data.entradas, pools: data.poblaciones,
        result: { cpra: data.cpra, target: data.individual, targetHats: data.individualHats }
      };
      data.entradas.forEach(function (token) {
        statusCache.set(entryKey(token.entrada), { entrada: token.entrada, estado: token.estado, nota: token.nota, etiqueta: token.etiqueta });
      });
      renderEntries();
      renderResult();
    } catch (error) {
      replace(byId('resultado'), h('div', { class: 'aviso aviso-error', role: 'alert' }, error.message));
    } finally {
      busy = false;
      button.disabled = false;
      button.textContent = 'Calcular cPRA';
    }
  }

  byId('calcular').addEventListener('click', calculate);
  byId('pool').addEventListener('change', renderResult);
  byId('limpiar').addEventListener('click', function () {
    entries = [];
    input.value = '';
    lastCalc = null;
    renderEntries();
    replace(byId('resultado'), h('div', { class: 'vacio' }, 'Indique los antígenos inaceptables y presione «Calcular cPRA».'));
    input.focus();
  });
  byId('ejemplo').addEventListener('click', function () {
    entries = EXAMPLE.slice();
    input.value = '';
    renderEntries();
    scheduleStatusRefresh();
  });

  // ---- Varios pacientes ----------------------------------------------------------
  function parseCsv(text) {
    text = text.replace(/^﻿/, '');
    const firstLine = text.split(/\r?\n/, 1)[0];
    let separator = ',';
    [';', '\t'].forEach(function (candidate) {
      if (firstLine.split(candidate).length > firstLine.split(separator).length) separator = candidate;
    });
    const rows = [];
    let row = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < text.length; i++) {
      const char = text[i];
      if (quoted) {
        if (char === '"' && text[i + 1] === '"') { field += '"'; i++; }
        else if (char === '"') quoted = false;
        else field += char;
      } else if (char === '"' && field === '') {
        quoted = true;
      } else if (char === separator) {
        row.push(field); field = '';
      } else if (char === '\n' || char === '\r') {
        if (char === '\r' && text[i + 1] === '\n') i++;
        row.push(field); field = '';
        rows.push(row); row = [];
      } else {
        field += char;
      }
    }
    if (field !== '' || row.length) { row.push(field); rows.push(row); }
    return rows.filter(function (cells) { return cells.some(function (cell) { return cell.trim() !== ''; }); });
  }

  const ROLE_LABELS = { broad: 'antígeno amplio', split: 'split', associated: 'designación a nivel alélico' };

  // WHO assignment of an entry: broad antigen, split and allele-level designation.
  function assignmentCell(token) {
    const eq = token.equivalencia;
    if (!eq || (!eq.amplio.length && !eq.split.length && !eq.asociado.length)) return '—';
    const line = function (label, values) {
      if (!values.length) return null;
      const text = values.length <= 4 ? values.join(', ')
        : values.slice(0, 4).join(', ') + ' y ' + fmtCount(values.length - 4) + ' más';
      return h('div', null, h('span', { class: 'rotulo-eq' }, label + ': '), text);
    };
    return h('div', { class: 'equivalencia' },
      token.rol ? h('div', { class: 'nota' }, 'La entrada es ' + (ROLE_LABELS[token.rol] || token.rol) + '.') : null,
      line('Amplio', eq.amplio), line('Split', eq.split), line('Alélica', eq.asociado));
  }

  // The HATS table assigns antigens to alleles the WHO table leaves unassigned.
  // Shown for information: the calculation keeps the WHO assignment.
  function hatsDifference(token, i, pool) {
    if (!token.nAlelosHats || !lastCalc.result.targetHats) return null;
    const hats = lastCalc.result.targetHats[i];
    if (!hats) return null;
    const diff = 100 * (hats[pool] - lastCalc.result.target[i][pool]);
    const extra = token.nAlelosHats - token.alelos.length;
    const base = 'Con la tabla HATS abarcaría ' + fmtCount(token.nAlelosHats) + ' alelos (' +
      fmtCount(extra) + ' más) y su cPRA individual sería ' + fmtPct(hats[pool]) + '.';
    if (diff < 0.5) return { texto: base + ' La diferencia es menor a 0.5 puntos.', aviso: false };
    return { texto: base + ' Son ' + diff.toFixed(1) + ' puntos más: verifique si el reporte se refiere a ese alelo o a todo el grupo serológico.', aviso: true };
  }

  function csvField(value) {
    let text = String(value);
    // Prevent spreadsheet formula injection from identifiers typed by users.
    if (/^[=+\-@]/.test(text)) text = "'" + text;
    return '"' + text.replace(/"/g, '""') + '"';
  }

  const BATCH_COLUMNS = ['ID', 'Antigenos_inaceptables', 'Poblacion', 'cPRA_MEX_pct', 'cPRA_MEX_detallado', 'Compatibles_por_100']
    .concat(Object.keys(SCOPE_LABELS).filter(function (scope) { return scope !== 'Global'; }).map(function (scope) { return 'cPRA_' + scope; }))
    .concat(['No_reconocidos', 'Sin_frecuencia']);

  function batchRow(result, ua, pool) {
    const row = {
      ID: result.id, Antigenos_inaceptables: ua, Poblacion: POOL_LABELS[pool],
      cPRA_MEX_pct: (100 * result.cpra.Global).toFixed(4),
      cPRA_MEX_detallado: fmtDetail(result.cpra.Global),
      Compatibles_por_100: (100 * (1 - result.cpra.Global)).toFixed(2)
    };
    Object.keys(SCOPE_LABELS).forEach(function (scope) {
      if (scope !== 'Global') row['cPRA_' + scope] = fmtDetail(result.cpra[scope]);
    });
    row.No_reconocidos = result.noReconocidos.join(' ');
    row.Sin_frecuencia = result.sinFrecuencia.join(' ');
    return row;
  }

  function batchMessage(kind, text) {
    replace(byId('lote'), h('div', { class: kind === 'error' ? 'aviso aviso-error' : 'vacio', role: kind === 'error' ? 'alert' : null }, text));
  }

  function renderBatch() {
    const flagged = batchRows.filter(function (row) { return row.No_reconocidos !== ''; }).length;
    const shown = batchRows.slice(0, 100);
    replace(byId('lote'),
      flagged ? h('div', { class: 'aviso aviso-error', role: 'alert' },
        flagged + ' de ' + batchRows.length + ' pacientes tienen entradas no reconocidas; su cPRA puede estar subestimado. Revise la columna «No_reconocidos».') : null,
      h('p', { class: 'ayuda' }, fmtCount(batchRows.length) + ' pacientes procesados. Se muestran los primeros ' + shown.length + '; la descarga incluye todos los loci.'),
      table(['ID', num('cPRA-MEX (%)'), num('Compatibles por cada 100'), num('Clase I'), num('Clase II'), 'No reconocidos', 'Sin frecuencia'],
        shown.map(function (row) {
          return h('tr', null, h('th', { scope: 'row' }, row.ID),
            h('td', { class: 'num' }, Number(row.cPRA_MEX_pct).toFixed(2)), h('td', { class: 'num' }, row.Compatibles_por_100),
            h('td', { class: 'num' }, row.cPRA_ClaseI), h('td', { class: 'num' }, row.cPRA_ClaseII),
            h('td', null, row.No_reconocidos), h('td', null, row.Sin_frecuencia));
        })));
  }

  async function runBatch(data, pool) {
    const results = [];
    for (let start = 0; start < data.length; start += BATCH_CHUNK) {
      batchMessage('info', 'Calculando… ' + start + ' de ' + data.length);
      const chunk = data.slice(start, start + BATCH_CHUNK).map(function (cells) {
        // Antigens may be spread over several columns when the list is comma-separated
        // without quotes; every column after the identifier is read.
        return { id: cells[0] || '', antigenos: cells.slice(1).join(' ') };
      });
      const response = await apiRequest('POST', '/api/lote', { poblacion: pool, filas: chunk });
      response.filas.forEach(function (result, k) { results.push(batchRow(result, chunk[k].antigenos, pool)); });
    }
    return results;
  }

  function processBatch() {
    const file = byId('archivo').files[0];
    batchRows = null;
    byId('descargar').disabled = true;
    if (!file) { batchMessage('error', 'Seleccione un archivo.'); return; }
    const reader = new FileReader();
    reader.onerror = function () { batchMessage('error', 'No se pudo leer el archivo.'); };
    reader.onload = function () {
      const rows = parseCsv(String(reader.result));
      if (rows.length < 2 || rows[0].length < 2) {
        batchMessage('error', 'El archivo debe ser CSV con encabezados y al menos dos columnas: identificador y antígenos inaceptables.');
        return;
      }
      const data = rows.slice(1);
      if (data.length > MAX_BATCH_ROWS) {
        batchMessage('error', 'El archivo excede ' + fmtCount(MAX_BATCH_ROWS) + ' filas.');
        return;
      }
      byId('procesar').disabled = true;
      runBatch(data, byId('pool-lote').value).then(function (results) {
        batchRows = results;
        byId('descargar').disabled = false;
        renderBatch();
      }).catch(function (error) {
        batchMessage('error', error.message);
      }).finally(function () {
        byId('procesar').disabled = false;
      });
    };
    reader.readAsText(file);
  }

  byId('procesar').addEventListener('click', processBatch);
  byId('descargar').addEventListener('click', function () {
    if (!batchRows) return;
    const lines = [BATCH_COLUMNS.map(csvField).join(',')].concat(batchRows.map(function (row) {
      return BATCH_COLUMNS.map(function (column) { return csvField(row[column]); }).join(',');
    }));
    const url = URL.createObjectURL(new Blob(['﻿' + lines.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }));
    const link = h('a', { href: url, download: 'cPRA-MEX_' + new Date().toISOString().slice(0, 10) + '.csv' });
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  });

  // ---- Pestañas ------------------------------------------------------------------
  const tabs = Array.from(document.querySelectorAll('.pestanas [role="tab"]'));
  function selectTab(tab, focus) {
    tabs.forEach(function (item) {
      const selected = item === tab;
      item.setAttribute('aria-selected', String(selected));
      item.tabIndex = selected ? 0 : -1;
      byId(item.getAttribute('aria-controls')).hidden = !selected;
    });
    if (focus) tab.focus();
  }
  tabs.forEach(function (tab, i) {
    tab.addEventListener('click', function () { selectTab(tab, false); });
    tab.addEventListener('keydown', function (event) {
      if (event.key === 'ArrowRight') selectTab(tabs[(i + 1) % tabs.length], true);
      if (event.key === 'ArrowLeft') selectTab(tabs[(i - 1 + tabs.length) % tabs.length], true);
    });
  });

  // ---- Inicio --------------------------------------------------------------------
  apiRequest('GET', '/api/opciones').then(function (data) {
    options = data;
    choices = data.opciones.map(function (choice) {
      return { value: choice.value, group: choice.group, key: choice.value.toUpperCase() };
    });
    byId('carga').hidden = true;
    byId('calcular').disabled = false;
    byId('procesar').disabled = false;
    renderEntries();
    scheduleStatusRefresh();
    replace(byId('tabla-regiones'), table(
      ['Región', num('Haplotipos distintos'), num('Copias haplotípicas efectivas'), num('Peso en el pool nacional')],
      data.referencia.regiones.map(function (region) {
        return h('tr', null, h('th', { scope: 'row' }, POOL_LABELS[region.id]),
          h('td', { class: 'num' }, fmtCount(region.haplotipos)), h('td', { class: 'num' }, fmtCount(region.copiasEfectivas)),
          h('td', { class: 'num' }, (100 * region.peso).toFixed(1) + '%'));
      })));
    byId('version').textContent = 'Referencia generada el ' + data.referencia.generada + '. Mapeo de antígenos: ' + data.referencia.mapeoAntigenos + '.';
  }).catch(function (error) {
    const status = byId('carga');
    status.className = 'aviso aviso-error';
    status.setAttribute('role', 'alert');
    status.textContent = error.message + ' Recargue la página en unos segundos.';
  });
})();
