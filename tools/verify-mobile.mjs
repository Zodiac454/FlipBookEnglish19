/**
 * Мобильная приёмка книги: телефонные профили + настоящие тач-жесты.
 * Запуск: node tools/verify-mobile.mjs <url>
 * Требует Chrome с --remote-debugging-port=9222 (см. tools/run-checks.ps1).
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:8123/';
const OUT = process.env.SHOT_DIR || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

const DEVICES = [
  { name: 'pc-1440x900',      w: 1440, h: 900, dpr: 1,     mobile: false, touch: false },
  { name: 'iphone-portrait',  w: 390,  h: 844, dpr: 3,     mobile: true,  touch: true },
  { name: 'pixel-portrait',   w: 412,  h: 915, dpr: 2.625, mobile: true,  touch: true },
  { name: 'iphone-landscape', w: 844,  h: 390, dpr: 3,     mobile: true,  touch: true },
  { name: 'small-phone',      w: 320,  h: 568, dpr: 2,     mobile: true,  touch: true },
];

/* ── соединение ──────────────────────────────────────────────────────────── */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.filter(t => t.type === 'page')[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
const problems = [];

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    const d = m.params.exceptionDetails;
    problems.push(`${d.exception?.description || d.text}`);
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    problems.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const evaluate = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'ошибка вычисления');
  return r.result.value;
};

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'));
};

await send('Runtime.enable');
await send('Page.enable');

/* ── снимок состояния страницы ───────────────────────────────────────────── */
const PROBE = `(() => {
  const vis = [...document.querySelectorAll('.page')].filter(p => getComputedStyle(p).display !== 'none');
  const box = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; };
  const sizes = sel => [...document.querySelectorAll(sel)].filter(e => e.offsetParent !== null).map(e => Math.min(e.getBoundingClientRect().width, e.getBoundingClientRect().height));
  const wrapper = document.querySelector('.stf__wrapper');
  const block = document.querySelector('.stf__block');
  const scale = document.querySelector('#book-scale');
  const stage = document.querySelector('#stage');
  const st = stage.getBoundingClientRect();
  const vis2 = [...document.querySelectorAll('.page')].filter(p => getComputedStyle(p).display !== 'none');
  const pr = vis2.map(p => p.getBoundingClientRect());
  const fitsStage = pr.length ? pr.every(r => r.top >= st.top - 2 && r.bottom <= st.bottom + 2 && r.left >= st.left - 2 && r.right <= st.right + 2) : null;
  const hud = document.querySelector('#hud').getBoundingClientRect();
  const hudOverlap = pr.some(r => r.right > hud.left && r.left < hud.right && r.bottom > hud.top && r.top < hud.bottom);
  return JSON.stringify({
    view: [window.innerWidth, window.innerHeight],
    scroll: [document.documentElement.scrollWidth, document.documentElement.scrollHeight],
    overflowX: document.documentElement.scrollWidth > window.innerWidth + 1,
    overflowY: document.documentElement.scrollHeight > window.innerHeight + 1,
    mode: wrapper ? (wrapper.className.match(/--(portrait|landscape)/) || [])[1] : null,
    fitsStage,
    hudOverlap,
    stageBox: [Math.round(st.top), Math.round(st.height)],
    label: document.querySelector('#page-label').textContent,
    hash: location.hash,
    chrome: document.querySelector('#app').dataset.chrome,
    loaderGone: !document.querySelector('#loader'),
    block: block ? box(block) : null,
    pages: vis.map(p => ({ alt: p.querySelector('img').alt, ...box(p) })),
    pageCount: document.querySelectorAll('.stf__item').length,
    sheetsLoaded: [...document.querySelectorAll('.page .sheet')].filter(i => i.complete && i.naturalWidth > 0).length,
    zoom: (scale.style.transform.match(/scale\\(([\\d.]+)\\)/) || [0, '1'])[1],
    zoomChip: !document.querySelector('#zoom-chip').hidden,
    tools: sizes('.tool:not([hidden])'),
    hudSteps: sizes('.hud-step'),
    navVisible: [...document.querySelectorAll('.nav')].some(n => n.offsetParent !== null),
    hitIsTouch: (navigator.maxTouchPoints || 0) > 0
  });
})()`;

/* ── жесты ───────────────────────────────────────────────────────────────── */
async function touch(type, points) {
  await send('Input.dispatchTouchEvent', {
    type,
    touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id ?? 1, radiusX: 12, radiusY: 12, force: 1 })),
  });
}

async function tap(x, y) {
  await touch('touchStart', [{ x, y, id: 11 }]);
  await sleep(60);
  await touch('touchEnd', []);
  await sleep(650);
}

async function drag(x0, y0, x1, y1, steps = 8, pause = 15) {
  await touch('touchStart', [{ x: x0, y: y0, id: 21 }]);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await touch('touchMove', [{ x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, id: 21 }]);
    await sleep(pause);
  }
  await touch('touchEnd', []);
  await sleep(1100);
}

async function pinch(cx, cy, from, to) {
  const ids = [31, 32];
  await touch('touchStart', [{ x: cx - from, y: cy, id: ids[0] }, { x: cx + from, y: cy, id: ids[1] }]);
  for (let i = 1; i <= 10; i++) {
    const r = from + (to - from) * (i / 10);
    await touch('touchMove', [{ x: cx - r, y: cy, id: ids[0] }, { x: cx + r, y: cy, id: ids[1] }]);
    await sleep(28);
  }
  await touch('touchEnd', []);
  await sleep(400);
}

/* ── прогон ──────────────────────────────────────────────────────────────── */
const report = {};

for (const d of DEVICES) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: d.w, height: d.h, deviceScaleFactor: d.dpr, mobile: d.mobile,
    screenWidth: d.w, screenHeight: d.h,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: d.touch, maxTouchPoints: d.touch ? 5 : 1 });

  problems.length = 0;
  // обязательна настоящая перезагрузка: смена только хэша документ не пересоздаёт,
  // и профиль унаследовал бы чужой размер окна и чужое определение сенсора
  await send('Page.navigate', { url: `${URL_UNDER_TEST}?dev=${d.name}&t=${Date.now()}#p=1` });
  await sleep(4200);

  const state = JSON.parse(await evaluate(PROBE));
  state.errors = [...problems];
  report[d.name] = state;

  console.log(`\n── ${d.name}  ${d.w}×${d.h} @${d.dpr}x ─────────────────────────`);
  console.log(`  режим: ${state.mode} | страниц: ${state.pageCount} | видно: ${state.pages.length}`);
  console.log(`  полоса прокрутки: ${state.overflowX ? 'ЕСТЬ ГОРИЗОНТАЛЬНАЯ' : 'нет'} / ${state.overflowY ? 'ЕСТЬ ВЕРТИКАЛЬНАЯ' : 'нет'}`);
  console.log(`  книга помещается в сцену: ${state.fitsStage ? 'да' : 'НЕТ — ОБРЕЗАЕТСЯ'} (сцена сверху ${state.stageBox[0]}, высота ${state.stageBox[1]})`);
  console.log(`  панель управления перекрывает страницу: ${state.hudOverlap ? 'ДА — ПЛОХО' : 'нет'}`);
  console.log(`  книга: ${state.block?.w}×${state.block?.h} | страница: ${state.pages[0]?.w}×${state.pages[0]?.h}`);
  console.log(`  кнопки: тулбар ${state.tools.join('/')} | шаги ${state.hudSteps.join('/')} | боковые стрелки: ${state.navVisible ? 'да' : 'нет'}`);
  console.log(`  сенсор определён: ${state.hitIsTouch} | ошибок: ${state.errors.length}`);

  await shot(`mob-${d.name}.png`);

  /* жесты проверяем на iPhone: там и сенсор, и портрет */
  if (d.name === 'iphone-portrait') {
    const before = JSON.parse(await evaluate(PROBE));

    await tap(Math.round(d.w * 0.86), Math.round(before.pages[0].y + before.pages[0].h / 2));
    const afterTap = JSON.parse(await evaluate(PROBE));
    console.log(`  тап по правому краю: ${before.label} → ${afterTap.label} ${afterTap.label !== before.label ? 'OK' : 'НЕ СРАБОТАЛ'}`);
    report.gestures = report.gestures || {};
    report.gestures.tapRight = { from: before.label, to: afterTap.label };

    await tap(Math.round(d.w * 0.5), Math.round(afterTap.pages[0].y + afterTap.pages[0].h / 2));
    const afterCenter = JSON.parse(await evaluate(PROBE));
    console.log(`  тап по центру: интерфейс = ${afterCenter.chrome} ${afterCenter.chrome === 'hidden' ? 'OK (скрылся)' : 'НЕ СКРЫЛСЯ'}`);
    report.gestures.tapCenter = afterCenter.chrome;
    await tap(Math.round(d.w * 0.5), Math.round(afterCenter.pages[0].y + afterCenter.pages[0].h / 2));

    const beforeSwipe = JSON.parse(await evaluate(PROBE));
    const pageOf = s => Number(s.label.split('/')[0].trim());
    const flickY = beforeSwipe.pages[0].y + beforeSwipe.pages[0].h / 2;

    await drag(Math.round(d.w * 0.82), flickY, Math.round(d.w * 0.34), flickY);
    const afterSwipe = JSON.parse(await evaluate(PROBE));
    const delta = pageOf(afterSwipe) - pageOf(beforeSwipe);
    console.log(`  свайп с оттягиванием: ${beforeSwipe.label} → ${afterSwipe.label} ` +
      (delta === 1 ? 'OK (ровно +1)' : `СБОЙ: сдвиг на ${delta}`));
    report.gestures.swipe = { from: beforeSwipe.label, to: afterSwipe.label, delta };
    await shot('mob-gesture-swipe.png');

    /* короткое движение не должно перелистывать */
    const beforeShort = JSON.parse(await evaluate(PROBE));
    await drag(Math.round(d.w * 0.70), flickY, Math.round(d.w * 0.62), flickY, 5, 26);
    const afterShort = JSON.parse(await evaluate(PROBE));
    const shortDelta = pageOf(afterShort) - pageOf(beforeShort);
    console.log(`  короткое движение (8% ширины): ${beforeShort.label} → ${afterShort.label} ` +
      (shortDelta === 0 ? 'OK (страница вернулась)' : `СБОЙ: перелистнуло на ${shortDelta}`));
    report.gestures.shortDrag = { delta: shortDelta };

    await pinch(Math.round(d.w * 0.5), Math.round(afterSwipe.pages[0].y + afterSwipe.pages[0].h / 2), 30, 120);
    const afterPinch = JSON.parse(await evaluate(PROBE));
    const zoomed = Number(afterPinch.zoom) > 1.05;
    console.log(`  щипок двумя пальцами: масштаб ${afterPinch.zoom} ${zoomed ? 'OK' : 'НЕ РАБОТАЕТ'}, чип ${afterPinch.zoomChip ? 'виден' : 'нет'}`);
    report.gestures.pinch = { zoom: afterPinch.zoom, chip: afterPinch.zoomChip };
    await shot('mob-gesture-pinch.png');

    if (zoomed) {
      await evaluate(`document.querySelector('#zoom-chip').click()`);
      await sleep(500);
      const afterReset = JSON.parse(await evaluate(PROBE));
      console.log(`  сброс масштаба кнопкой: ${afterReset.zoom} ${Number(afterReset.zoom) === 1 ? 'OK' : 'НЕ СБРОСИЛСЯ'}`);
      report.gestures.reset = afterReset.zoom;
    }

    /* список страниц: на телефоне — лист во весь экран */
    await evaluate(`document.querySelector('#btn-thumbs').click()`);
    await sleep(600);
    const sheet = JSON.parse(await evaluate(`JSON.stringify((() => {
      const p = document.querySelector('#thumbs');
      const r = p.getBoundingClientRect();
      const list = document.querySelector('#thumbs-list');
      const lr = list.getBoundingClientRect();
      return {
        visible: getComputedStyle(p).opacity !== '0' && r.top < window.innerHeight,
        covers: Math.round(r.width) >= window.innerWidth - 1 && Math.round(r.height) >= window.innerHeight - 1,
        scrollable: list.scrollHeight > list.clientHeight + 2,
        listBox: [Math.round(lr.width), Math.round(lr.height)],
        listScroll: [list.scrollHeight, list.clientHeight],
        columns: (() => { const kids = [...list.children]; const top = kids[0].offsetTop; return kids.filter(k => k.offsetTop === top).length; })(),
        thumbCount: list.children.length
      };
    })())`));
    console.log(`  список страниц: открыт=${sheet.visible} во весь экран=${sheet.covers} колонок=${sheet.columns} ` +
      `прокрутка=${sheet.scrollable} (${sheet.listScroll.join('/')}) миниатюр=${sheet.thumbCount}`);
    report.gestures.thumbsSheet = sheet;
    await shot('mob-thumbs-sheet.png');
    await evaluate(`document.querySelector('#thumbs-close').click()`);
    await sleep(500);

    report.gestures.errors = [...problems];
    if (problems.length) console.log('  ОШИБКИ ВО ВРЕМЯ ЖЕСТОВ:', problems);
  }
}

writeFileSync(`${OUT}/mobile-report.json`, JSON.stringify(report, null, 2));
console.log('\nотчёт: mobile-report.json');
ws.close();
