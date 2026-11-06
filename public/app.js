// HyperFrames Live viewer: shows each saved version of a composition, and plays a cursor
// that "performs" the code changes between versions on the canvas and the timeline.
const params = new URLSearchParams(location.search);
const SPEED = Number(params.get('speed')) || 1;
const MAX_ACTIONS = 12;
const sleep = n => new Promise(r => setTimeout(r, n / SPEED));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const $ = s => document.querySelector(s);

const stage = $('#stage');
const frames = [$('#frameA'), $('#frameB')];
const infos = [null, null];
const state = { shown: null, latest: null, busy: false, t: 0, playing: false, scale: 1, live: 0, cx: null, cy: null };
const info = () => infos[state.live];

// ---------- composition frames ----------

const INJECT = '<base href="/comp/"><style>html,body{margin:0;overflow:hidden}' +
  '[data-hfl-hidden]{opacity:0!important}[data-hfl-off]{visibility:hidden!important}' +
  '[data-hfl-fade]{animation:hfl-fade .35s ease-out}@keyframes hfl-fade{from{opacity:0}}</style>';

function prepare(html) {
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, m => m + INJECT);
  if (/<!doctype[^>]*>/i.test(html)) return html.replace(/<!doctype[^>]*>/i, m => m + INJECT);
  return INJECT + html;
}

function loadFrame(frame, html) {
  return new Promise(resolve => {
    const done = () => { clearTimeout(timer); frame.onload = null; resolve(frame.contentWindow); };
    const timer = setTimeout(done, 6000);
    frame.onload = done;
    frame.srcdoc = prepare(html || '');
  });
}

// Reads the HyperFrames contract: root size, clips with data-start/data-duration, and GSAP timelines.
function readComp(win, html) {
  const doc = win.document;
  const root = doc.querySelector('[data-composition-id]');
  const num = v => (v == null || v === '' ? null : Number(v));
  const fallback = info();
  const width = num(root?.dataset.width) || fallback?.width || 1920;
  const height = num(root?.dataset.height) || fallback?.height || 1080;
  const timelines = Object.values(win.__timelines || {}).filter(tl => tl && typeof tl.seek === 'function');
  const clips = [...doc.querySelectorAll('[data-start]')].filter(el => el !== root).map(el => ({
    el, start: num(el.dataset.start) || 0, dur: num(el.dataset.duration), track: num(el.dataset.trackIndex) ?? 0,
  }));
  const tweens = [];
  const walk = (tl, offset) => {
    for (const child of tl.getChildren(false, true, true)) {
      const at = offset + child.startTime();
      if (child.getChildren) walk(child, at);
      else tweens.push({ targets: child.targets().filter(t => t?.nodeType === 1), start: at, end: at + child.duration() });
    }
  };
  for (const tl of timelines) {
    try {
      walk(tl, 0);
      // Render every tween once now, so GSAP records real start values before the viewer hides new elements.
      tl.seek(tl.duration(), true).seek(0, true);
    } catch { /* not a GSAP timeline */ }
  }
  let duration = num(root?.dataset.duration);
  if (!duration) duration = Math.max(0, ...clips.map(c => c.start + (c.dur ?? 0)), ...tweens.map(t => t.end));
  duration = clamp(duration || 5, 0.5, 120);
  return { win, doc, root, width, height, timelines, clips, tweens, duration, empty: !(html || '').trim() };
}

function seekFrame(fi, t) {
  if (!fi) return;
  for (const tl of fi.timelines) { try { tl.pause(); tl.seek(t, false); } catch { /* ignore */ } }
  for (const c of fi.clips) {
    const on = t >= c.start && (c.dur == null || t < c.start + c.dur);
    c.el.toggleAttribute('data-hfl-off', !on);
    if (on && c.el.tagName === 'VIDEO') { try { c.el.currentTime = t - c.start; } catch { /* ignore */ } }
  }
}

function seekAll(t) {
  state.t = t;
  infos.forEach(fi => seekFrame(fi, t));
  updatePlayhead();
}

function layout() {
  const fi = info();
  const w = fi?.width || 1920, h = fi?.height || 1080;
  const vp = $('#viewport').getBoundingClientRect();
  const s = Math.max(0.05, Math.min((vp.width - 48) / w, (vp.height - 56) / h));
  state.scale = s;
  stage.style.width = w * s + 'px';
  stage.style.height = h * s + 'px';
  frames.forEach((f, i) => {
    f.style.width = (infos[i]?.width || w) + 'px';
    f.style.height = (infos[i]?.height || h) + 'px';
    f.style.transform = `scale(${s})`;
  });
  stage.classList.toggle('is-empty', !fi || fi.empty);
  $('#size').textContent = `${w} × ${h} · ${Math.round(s * 100)}%`;
}

function swapTo(idx) {
  state.live = idx;
  frames.forEach((f, i) => f.classList.toggle('front', i === idx));
  layout();
  renderTimeline();
  seekAll(Math.min(state.t, info().duration - 0.01));
}

// ---------- diff between two versions ----------

const parser = new DOMParser();
const parse = html => parser.parseFromString(html || '', 'text/html');
const SKIP = new Set(['SCRIPT', 'STYLE', 'LINK', 'META', 'TITLE', 'BASE', 'NOSCRIPT', 'TEMPLATE']);

function keyOf(el) {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const p = el.parentElement;
  if (!p || tag === 'body' || tag === 'html') return tag;
  return `${keyOf(p)}>${tag}:${[...p.children].filter(c => c.tagName === el.tagName).indexOf(el)}`;
}

// Elements that can be targets. An <svg> is one unit; its inner shapes are not tracked.
function elements(doc) {
  const map = new Map();
  for (const el of doc.body?.querySelectorAll('*') || []) {
    if (SKIP.has(el.tagName) || el.parentElement.closest('svg')) continue;
    map.set(keyOf(el), el);
  }
  return map;
}

const ownText = el => (el.tagName.toLowerCase() === 'svg' ? el.outerHTML
  : [...el.childNodes].filter(n => n.nodeType === 3).map(n => n.data).join(' ').replace(/\s+/g, ' ').trim());
const snip = (s, n = 26) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function nameOf(el) {
  if (!el) return 'element';
  if (el.hasAttribute('data-composition-id')) return 'stage';
  if (el.id) return '#' + el.id;
  const text = el.textContent.replace(/\s+/g, ' ').trim();
  if (text && text.length < 40) return `“${snip(text, 22)}”`;
  const cls = el.classList[0];
  return el.tagName.toLowerCase() + (cls ? '.' + cls : '');
}

function stepsOf(doc) {
  const out = [];
  const walker = doc.createTreeWalker(doc, NodeFilter.SHOW_COMMENT);
  while (walker.nextNode()) {
    const m = walker.currentNode.data.match(/^\s*step\s*:\s*([\s\S]+?)\s*$/i);
    if (m) out.push(m[1]);
  }
  for (const s of doc.querySelectorAll('script:not([src]), style')) {
    for (const m of s.textContent.matchAll(/\/[/*]\s*step\s*:\s*(.+?)\s*(?:\*\/)?\s*$/gim)) out.push(m[1]);
  }
  return out;
}

const codeOf = (doc, sel) => [...doc.querySelectorAll(sel)].map(s => s.textContent).join('\n');
const lines = s => s.split('\n').map(l => l.trim()).filter(Boolean);

function cssRules(css) {
  const map = new Map();
  for (const chunk of css.replace(/\/\*[\s\S]*?\*\//g, '').split('}')) {
    const i = chunk.indexOf('{');
    if (i < 0) continue;
    const sel = chunk.slice(0, i).trim();
    if (sel && !sel.startsWith('@')) map.set(sel, chunk.slice(i + 1).replace(/\s+/g, ' ').trim());
  }
  return map;
}

function diff(a, b) {
  const A = elements(a), B = elements(b);
  const root = b.querySelector('[data-composition-id]');
  const acts = new Map();
  const act = (key, el) => {
    if (!acts.has(key)) acts.set(key, { key, name: nameOf(el), text: '', kinds: new Set() });
    return acts.get(key);
  };
  // Map any element (also inside an <svg>, or <body>) to the nearest tracked element.
  const host = el => {
    if (!el || el === b.body || el === b.documentElement) return root;
    let found = null;
    for (let x = el; x; x = x.parentElement) {
      const key = B.has(keyOf(x)) && keyOf(x);
      if (!key) continue;
      found ||= x;
      // Work inside a new element belongs to the "Adding" action of that element.
      if (acts.get(key)?.kinds.has('add') && x !== root) return x;
    }
    return found || root;
  };

  for (const [key, el] of B) {
    const old = A.get(key);
    if (!old) {
      // Report meaningful additions; plain children of a new element come with their parent.
      const pk = keyOf(el.parentElement);
      const parentIsNew = B.has(pk) && !A.has(pk);
      const meaningful = el.id || el.hasAttribute('data-start') || el.parentElement === root;
      if (!parentIsNew || meaningful) act(key, el).kinds.add('add');
      continue;
    }
    const before = Object.fromEntries([...old.attributes].map(x => [x.name, x.value]));
    const after = Object.fromEntries([...el.attributes].map(x => [x.name, x.value]));
    const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(n => before[n] !== after[n]);
    const textChanged = ownText(old) !== ownText(el);
    if (!changed.length && !textChanged) continue;
    const a = act(key, el);
    if (textChanged) { a.kinds.add(el.tagName.toLowerCase() === 'svg' ? 'style' : 'text'); a.text = ownText(el); }
    for (const n of changed) {
      if (['data-start', 'data-duration', 'data-track-index'].includes(n)) a.kinds.add('retime');
      else if (n === 'src') a.kinds.add('media');
      else a.kinds.add('style');
    }
  }

  const removed = [];
  for (const [key, el] of A) {
    if (B.has(key)) continue;
    const pk = keyOf(el.parentElement);
    if (A.has(pk) && !B.has(pk)) continue;
    removed.push({ key, name: nameOf(el), text: '', kinds: new Set(['remove']) });
  }

  // Script changes: new lines that name a selector are animation work on that element.
  const oldScript = new Set(lines(codeOf(a, 'script:not([src])')));
  for (const line of lines(codeOf(b, 'script:not([src])'))) {
    if (oldScript.has(line)) continue;
    for (const m of line.matchAll(/["'`]([#.][^"'`]*)["'`]/g)) {
      let found = [];
      try { found = [...b.querySelectorAll(m[1])].slice(0, 2); } catch { /* not a selector */ }
      for (const el of found) { const h = host(el); if (h) act(keyOf(h), h).kinds.add('animate'); }
    }
  }

  // Stylesheet changes: added or changed rules style the elements they match.
  const oldRules = cssRules(codeOf(a, 'style'));
  for (const [sel, body] of cssRules(codeOf(b, 'style'))) {
    if (oldRules.get(sel) === body) continue;
    for (const part of sel.split(',')) {
      let found = [];
      try { found = [...b.querySelectorAll(part.trim())].slice(0, 2); } catch { /* not a selector */ }
      for (const el of found) { const h = host(el); if (h) act(keyOf(h), h).kinds.add('style'); }
    }
  }

  const oldSteps = new Set(stepsOf(a));
  const order = [...B.keys()];
  const rest = [...acts.values()].sort((x, y) => order.indexOf(x.key) - order.indexOf(y.key));
  return { actions: [...removed, ...rest], steps: stepsOf(b).filter(s => !oldSteps.has(s)) };
}

function label(a) {
  const k = a.kinds;
  if (k.has('remove')) return `Removing ${a.name}`;
  if (k.has('add')) return a.name === 'stage' ? 'Setting up the stage' : k.has('animate') ? `Adding + animating ${a.name}` : `Adding ${a.name}`;
  if (k.has('text')) return `Typing “${snip(a.text, 30)}”`;
  if (k.has('retime')) return `Retiming ${a.name}`;
  if (k.has('media')) return `Swapping media on ${a.name}`;
  if (k.has('animate') && k.has('style')) return `Editing ${a.name}`;
  if (k.has('animate')) return `Animating ${a.name}`;
  return `Styling ${a.name}`;
}

// ---------- cursor, selection, feed ----------

const cursor = $('#cursor');
let idleTimer; // hides the cursor when the agent has been quiet for a while
const selection = $('#selection');

function stageRect() { return stage.getBoundingClientRect(); }

function canvasRect(el) {
  const st = stageRect();
  const center = { x: st.left + st.width / 2 - 30, y: st.top + st.height / 2 - 30, w: 60, h: 60 };
  if (!el) return { x: st.left, y: st.top, w: st.width, h: st.height };
  const r = el.getBoundingClientRect();
  const s = state.scale;
  const x1 = Math.max(st.left, st.left + r.left * s), y1 = Math.max(st.top, st.top + r.top * s);
  const x2 = Math.min(st.right, st.left + r.right * s), y2 = Math.min(st.bottom, st.top + r.bottom * s);
  if (x2 - x1 < 4 || y2 - y1 < 4) return center;
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

function rowRect(key) {
  const row = document.querySelector(`.row[data-key="${CSS.escape(key)}"] .bar`);
  if (!row) return null;
  const r = row.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

function showSelection(rect, text) {
  Object.assign(selection.style, { left: rect.x + 'px', top: rect.y + 'px', width: rect.w + 'px', height: rect.h + 'px' });
  selection.firstElementChild.textContent = text;
  selection.classList.add('on');
}

$('#cursorName').textContent = params.get('agent') || 'Agent';

function placeCursor(x, y) {
  // Lean the pointer a little into horizontal motion, like a hand moving a mouse.
  const vx = state.cx == null ? 0 : x - state.cx;
  cursor.style.setProperty('--lean', `${clamp(vx * 0.9, -14, 14).toFixed(1)}deg`);
  state.cx = x; state.cy = y;
  cursor.style.transform = `translate(${x - 4}px, ${y - 4}px)`;
}

// Changes the action text; the pill grows or shrinks to fit it.
function setCursorText(text) {
  const box = cursor.querySelector('.what');
  const span = document.createElement('span');
  span.id = 'cursorText';
  span.textContent = text;
  box.replaceChildren(...(text ? [span] : []));
  box.style.width = (text ? span.offsetWidth + 8 : 0) + 'px';
}

// Moves along a slight curve with ease-in-out, so it reads as a hand, not a tween.
function moveCursor(x, y) {
  if (state.cx == null) { const st = stageRect(); placeCursor(st.right - 40, st.bottom - 30); }
  cursor.classList.add('on');
  const x0 = state.cx, y0 = state.cy;
  const dist = Math.hypot(x - x0, y - y0);
  const dur = clamp(dist * 1.1, 380, 950) / SPEED;
  const bend = clamp(dist * 0.18, 0, 90);
  const cxp = (x0 + x) / 2 + ((y - y0) / (dist || 1)) * bend, cyp = (y0 + y) / 2 - ((x - x0) / (dist || 1)) * bend;
  return new Promise(resolve => {
    const t0 = performance.now();
    const step = now => {
      const p = clamp((now - t0) / dur, 0, 1);
      const e = p < 0.5 ? 4 * p * p * p : 1 - Math.pow(-2 * p + 2, 3) / 2;
      const u = 1 - e;
      placeCursor(u * u * x0 + 2 * u * e * cxp + e * e * x, u * u * y0 + 2 * u * e * cyp + e * e * y);
      if (p < 1) requestAnimationFrame(step); else { cursor.style.setProperty('--lean', '0deg'); resolve(); }
    };
    requestAnimationFrame(step);
  });
}

async function click() {
  cursor.classList.add('press');
  const ripple = document.createElement('div');
  ripple.className = 'ripple';
  Object.assign(ripple.style, { left: state.cx + 'px', top: state.cy + 'px' });
  $('#overlay').append(ripple);
  setTimeout(() => ripple.remove(), 600);
  await sleep(130);
  cursor.classList.remove('press');
}

function scrubTo(t) {
  const t0 = state.t, start = performance.now(), dur = 280 / SPEED;
  if (Math.abs(t - t0) < 0.01) return Promise.resolve();
  return new Promise(resolve => {
    const step = now => {
      const p = clamp((now - start) / dur, 0, 1);
      seekAll(t0 + (t - t0) * (1 - Math.pow(1 - p, 3)));
      if (p < 1) requestAnimationFrame(step); else resolve();
    };
    requestAnimationFrame(step);
  });
}

function feed(text, cls = '') {
  const li = document.createElement('li');
  li.textContent = text;
  if (cls) li.className = cls;
  $('#feed').append(li);
  li.scrollIntoView({ block: 'nearest' });
}

function setStatus(text, busy) {
  $('#statusText').textContent = text;
  $('#status').classList.toggle('busy', !!busy);
}

// Time where the element looks "finished": the end of its own animations, inside its clip.
function focusTime(fi, el) {
  if (!fi || !el) return state.t;
  const host = el.closest('[data-start]:not([data-composition-id])');
  const clip = fi.clips.find(c => c.el === host);
  const ends = fi.tweens.filter(tw => tw.targets.some(t => t === el || el.contains(t))).map(tw => tw.end);
  let t = ends.length ? Math.max(...ends) : clip ? clip.start + Math.min(0.5, (clip.dur ?? 1) / 2) : state.t;
  if (clip) t = clamp(t, clip.start, (clip.dur != null ? clip.start + clip.dur : fi.duration) - 0.05);
  return clamp(t, 0, fi.duration - 0.01);
}

// ---------- applying a new version ----------

async function apply(html, animate) {
  const backIdx = 1 - state.live;
  const front = info();
  const win = await loadFrame(frames[backIdx], html);
  const next = infos[backIdx] = readComp(win, html);
  if (!animate || next.empty) { swapTo(backIdx); return; }

  const { actions, steps } = diff(parse(state.shown), parse(html));
  for (const s of steps) feed(s, 'step');
  setStatus(steps.at(-1) || 'Agent is editing…', true);
  cursor.classList.add('busy');
  clearTimeout(idleTimer);
  const wasPlaying = state.playing;
  setPlaying(false);

  const resolve = (fi, key) => (fi ? elements(fi.doc).get(key) : null);
  const added = actions.filter(a => a.kinds.has('add')).map(a => resolve(next, a.key)).filter(Boolean);
  added.forEach(el => el.setAttribute('data-hfl-hidden', ''));

  let swapped = false;
  const swap = () => { if (!swapped) { swapped = true; swapTo(backIdx); } };
  if (!front || front.empty || front.width !== next.width || front.height !== next.height) swap();
  else layout();

  const todo = actions.length ? actions.slice(0, MAX_ACTIONS) : [{ key: '', name: 'stage', kinds: new Set(['animate']), text: '' }];
  for (const a of todo) {
    const removing = a.kinds.has('remove');
    const fi = removing ? front : next;
    const el = a.key ? resolve(fi, a.key) : null;
    const text = a.key ? label(a) : 'Updating the animation';
    await scrubTo(focusTime(fi, el));
    const onTimeline = a.kinds.has('retime') && !a.kinds.has('add') && rowRect(a.key);
    const rect = onTimeline || canvasRect(el);
    setCursorText(text);
    showSelection(rect, a.name);
    await moveCursor(rect.x + Math.min(rect.w * 0.4, 160), rect.y + Math.min(rect.h * 0.45, 90));
    await click();
    if (!removing) swap();
    if (a.kinds.has('add') && el) {
      el.removeAttribute('data-hfl-hidden');
      el.setAttribute('data-hfl-fade', '');
    }
    flashRow(a.key);
    feed(text);
    await sleep(380);
  }
  swap();
  added.forEach(el => el.removeAttribute('data-hfl-hidden'));
  document.querySelectorAll('.row.pending').forEach(r => r.classList.replace('pending', 'new'));
  if (actions.length > todo.length) feed(`+${actions.length - todo.length} more changes`, 'muted');
  selection.classList.remove('on');
  setCursorText('');
  cursor.classList.remove('busy');
  idleTimer = setTimeout(() => { if (!state.busy) cursor.classList.remove('on'); }, 5000 / SPEED);
  setStatus(steps.at(-1) ? `Done: ${steps.at(-1)}` : 'Watching for changes', false);
  if (wasPlaying) setPlaying(true);
}

// Every version seen in this session, so "Replay build" can play the steps in their real order.
const history = [];
let replayQueue = [];

async function pump() {
  if (state.busy) return;
  state.busy = true;
  for (;;) {
    const html = replayQueue.length ? replayQueue.shift() : state.latest;
    if (html === state.shown) { if (replayQueue.length) continue; break; }
    try { await apply(html, state.shown !== null); } catch (e) { console.error(e); }
    state.shown = html;
    if (replayQueue.length) await sleep(700);
  }
  state.busy = false;
}

// ---------- timeline ----------

function renderTimeline() {
  const fi = info();
  const oldKeys = new Set([...document.querySelectorAll('.row')].map(r => r.dataset.key));
  const rowsEl = $('#rows'), ruler = $('#ruler');
  rowsEl.innerHTML = ''; ruler.innerHTML = '';
  if (!fi || fi.empty) return;
  const D = fi.duration;
  const every = D <= 8 ? 1 : D <= 30 ? 5 : 10;
  for (let s = 0; s <= D + 1e-6; s += every) {
    const tick = document.createElement('span');
    tick.style.left = (s / D) * 100 + '%';
    tick.textContent = s + 's';
    ruler.append(tick);
  }
  const rows = new Map();
  for (const c of [...fi.clips].sort((x, y) => x.track - y.track || x.start - y.start)) {
    rows.set(c.el, { el: c.el, start: c.start, end: c.dur != null ? c.start + c.dur : D, tweens: [], loose: false });
  }
  for (const tw of fi.tweens) {
    for (const target of tw.targets) {
      const host = target.closest('[data-start]:not([data-composition-id])') || target.closest('[id]') || target;
      if (!rows.has(host)) rows.set(host, { el: host, start: 0, end: D, tweens: [], loose: true });
      rows.get(host).tweens.push(tw);
    }
  }
  const pct = t => (clamp(t, 0, D) / D) * 100 + '%';
  for (const r of rows.values()) {
    const key = keyOf(r.el);
    const row = document.createElement('div');
    const pending = !!r.el.closest('[data-hfl-hidden]');
    row.className = 'row' + (r.loose ? ' loose' : '') + (pending ? ' pending' : oldKeys.size && !oldKeys.has(key) ? ' new' : '');
    row.dataset.key = key;
    row.innerHTML = '<div class="name"></div><div class="lane"><div class="bar"></div></div>';
    row.firstChild.textContent = nameOf(r.el);
    const lane = row.lastChild;
    Object.assign(lane.firstChild.style, { left: pct(r.start), width: `calc(${pct(r.end)} - ${pct(r.start)})` });
    const seen = new Set();
    for (const tw of r.tweens) {
      const line = document.createElement('div');
      line.className = 'tw';
      Object.assign(line.style, { left: pct(tw.start), width: `calc(${pct(tw.end)} - ${pct(tw.start)})` });
      lane.append(line);
      for (const t of [tw.start, tw.end]) {
        if (seen.has(t.toFixed(2))) continue;
        seen.add(t.toFixed(2));
        const kf = document.createElement('i');
        kf.className = 'kf';
        kf.style.left = pct(t);
        lane.append(kf);
      }
    }
    rowsEl.append(row);
  }
}

function flashRow(key) {
  const row = document.querySelector(`.row[data-key="${CSS.escape(key)}"]`);
  if (!row) return;
  if (row.classList.contains('pending')) row.classList.replace('pending', 'new');
  row.classList.add('flash');
  row.scrollIntoView({ block: 'nearest' });
  setTimeout(() => row.classList.remove('flash'), 900);
}

function updatePlayhead() {
  const D = info()?.duration || 1;
  $('#playhead').style.setProperty('--p', clamp(state.t / D, 0, 1));
  $('#time').textContent = `${state.t.toFixed(2)}s / ${D.toFixed(2)}s`;
}

function setPlaying(on) {
  state.playing = on;
  $('#play').textContent = on ? '❚❚' : '▶';
}

let last = performance.now();
function tick(now) {
  const dt = (now - last) / 1000;
  last = now;
  const fi = info();
  if (state.playing && fi && !fi.empty) seekAll((state.t + dt) % fi.duration);
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

const tracks = $('#tracks');
function scrubFromPointer(e) {
  const r = tracks.getBoundingClientRect();
  const labelW = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--label'));
  const D = info()?.duration || 1;
  seekAll(clamp(((e.clientX - r.left - labelW) / (r.width - labelW)) * D, 0, D - 0.01));
}
tracks.addEventListener('pointerdown', e => {
  tracks.setPointerCapture(e.pointerId);
  setPlaying(false);
  scrubFromPointer(e);
});
tracks.addEventListener('pointermove', e => { if (tracks.hasPointerCapture(e.pointerId)) scrubFromPointer(e); });
$('#play').addEventListener('click', () => setPlaying(!state.playing));
addEventListener('keydown', e => {
  if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); setPlaying(!state.playing); }
});
addEventListener('resize', layout);

$('#replay').addEventListener('click', async () => {
  if (state.busy || !state.latest) return;
  state.busy = true;
  const idx = state.live;
  infos[idx] = readComp(await loadFrame(frames[idx], ''), '');
  swapTo(idx);
  state.shown = '';
  $('#feed').innerHTML = '';
  seekAll(0);
  replayQueue = history.includes(state.latest) ? history.slice(0, history.lastIndexOf(state.latest) + 1) : [state.latest];
  state.busy = false;
  pump();
});

// ---------- live updates ----------

const events = new EventSource('/events');
events.addEventListener('comp', e => {
  const { file, html } = JSON.parse(e.data);
  $('#file').textContent = file;
  if (!state.busy) setStatus(`Watching ${file.split('/').pop()}`, false);
  state.latest = html ?? '';
  if (!state.latest.trim()) history.length = 0; // the agent started over
  else if (history.at(-1) !== state.latest) history.push(state.latest);
  pump();
});
events.onerror = () => setStatus('Reconnecting…', false);
layout();
