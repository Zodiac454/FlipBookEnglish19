/**
 * Регрессии по код-ревью: каждая находка получает проверку.
 * Запуск: node tools/verify-regressions.mjs <url>
 * Требует Chrome с --remote-debugging-port=9222 (см. tools/run-checks.ps1).
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:8123/';
const OUT = process.env.SHOT_DIR || '.';
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── соединение ──────────────────────────────────────────────────────────── */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const target = list.filter(t => t.type === 'page')[0];
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

let id = 0;
const pending = new Map();
let problems = [];

ws.onmessage = ev => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
    return;
  }
  if (m.method === 'Runtime.exceptionThrown') {
    problems.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
  }
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    problems.push(`${m.params.type}: ${m.params.args.map(a => a.value ?? a.description).join(' ')}`);
  }
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') {
    problems.push(`LOG: ${m.params.entry.text}`);
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

await send('Runtime.enable');
await send('Page.enable');
await send('Network.enable');
await send('Log.enable');

/* ── мини-раннер ─────────────────────────────────────────────────────────── */
const results = [];
let failures = 0;

function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  if (!ok) failures++;
  console.log(`${ok ? '  OK  ' : ' СБОЙ '} ${name}${detail ? ' — ' + detail : ''}`);
}

async function open(url, wait = 4200) {
  problems = [];
  await send('Page.navigate', { url });
  await sleep(wait);
  return problems.slice();
}

async function device(w, h, dpr, touch) {
  await send('Emulation.setDeviceMetricsOverride', {
    width: w, height: h, deviceScaleFactor: dpr, mobile: touch, screenWidth: w, screenHeight: h,
  });
  await send('Emulation.setTouchEmulationEnabled', { enabled: touch, maxTouchPoints: touch ? 5 : 1 });
}

/* ── жесты ───────────────────────────────────────────────────────────────── */
const touch = (type, points) => send('Input.dispatchTouchEvent', {
  type,
  touchPoints: points.map(p => ({ x: p.x, y: p.y, id: p.id ?? 1, radiusX: 12, radiusY: 12, force: 1 })),
});

async function drag(x0, y0, x1, y1, steps = 8, pause = 15) {
  await touch('touchStart', [{ x: x0, y: y0, id: 21 }]);
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await touch('touchMove', [{ x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, id: 21 }]);
    await sleep(pause);
  }
  await touch('touchEnd', []);
  await sleep(1200);
}

async function pinch(cx, cy, from, to, pause = 26) {
  const ids = [31, 32];
  await touch('touchStart', [{ x: cx - from, y: cy, id: ids[0] }, { x: cx + from, y: cy, id: ids[1] }]);
  for (let i = 1; i <= 10; i++) {
    const r = from + (to - from) * (i / 10);
    await touch('touchMove', [{ x: cx - r, y: cy, id: ids[0] }, { x: cx + r, y: cy, id: ids[1] }]);
    await sleep(pause);
  }
  await touch('touchEnd', []);
  await sleep(500);
}

const state = () => evaluate(`JSON.stringify({
  label: document.querySelector('#page-label').textContent,
  hash: location.hash,
  zoom: (document.querySelector('#book-scale').style.transform.match(/scale\\(([\\d.]+)\\)/) || [0,'1'])[1],
  loaded: [...document.querySelectorAll('.page .sheet')].filter(i => i.getAttribute('src')).length,
  failed: [...document.querySelectorAll('.page.is-failed')].length,
  noteVisible: [...document.querySelectorAll('.page.is-failed .page-note')]
      .filter(n => getComputedStyle(n).opacity !== '0').length,
  sheet1: !!document.querySelectorAll('.page .sheet')[0].getAttribute('src'),
  thumbsOpen: document.querySelector('#thumbs').classList.contains('open'),
  block: (() => { const r = document.querySelector('.stf__block').getBoundingClientRect();
                  return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) }; })()
})`);

console.log('\nРЕГРЕССИИ ПО РЕВЬЮ\n');

/* ── 1. Окно подкачки: страницы не копятся в памяти ──────────────────────── */
await device(1440, 900, 1, false);
await open(`${URL_UNDER_TEST}?reg=1#p=1`, 5000);
let s = JSON.parse(await state());
check('подкачка ограничена окном вокруг текущей страницы', s.loaded > 0 && s.loaded <= 10,
  `страниц с картинкой: ${s.loaded} (ожидание 1..10, было бы 41)`);

await evaluate(`location.hash = 'p=41'`);
await send('Page.navigate', { url: `${URL_UNDER_TEST}?reg=1b#p=41` });
await sleep(5200);
s = JSON.parse(await state());
check('дальняя страница освобождается при переходе в конец', s.loaded <= 11 && !s.sheet1,
  `страниц с картинкой: ${s.loaded}, первая страница отпущена: ${!s.sheet1}`);
check('на последней странице нет ошибок', problems.length === 0, problems.slice(0, 2).join(' | '));

/* ── 2. Неудачная загрузка: повтор, пометка, книга жива ──────────────────── */
await send('Network.setBlockedURLs', { urls: ['*pages/p005.webp'] });
await open(`${URL_UNDER_TEST}?reg=2#p=4`, 6500);
s = JSON.parse(await state());
check('после трёх попыток страница помечена как незагруженная', s.failed === 1, `помечено страниц: ${s.failed}`);
check('пометка видна пользователю', s.noteVisible === 1, `видимых пометок: ${s.noteVisible}`);
check('книга при этом остаётся рабочей', s.loaded > 0 && !problems.length, `страниц загружено: ${s.loaded}`);

await send('Network.setBlockedURLs', { urls: [] });
await evaluate(`document.querySelector('#nav-next').click()`);
await sleep(1600);
const afterFailure = JSON.parse(await state());
check('листание после сбоя работает', Number(afterFailure.label.split('/')[0]) > 4, `открыта ${afterFailure.label}`);
await shot('reg-01-failed-page.png');

/* ── 3. Доступность: закрытые панели не ловят фокус ──────────────────────── */
await device(1440, 900, 1, false);
await open(`${URL_UNDER_TEST}?reg=3#p=3`, 4500);
const focusProbe = await evaluate(`JSON.stringify((() => {
  const thumb = document.querySelector('#thumbs-list .thumb');
  thumb.focus();
  const closedPanelTakesFocus = document.activeElement === thumb;
  document.querySelector('#btn-thumbs').click();
  return { closedPanelTakesFocus };
})())`);
await sleep(600);
const afterOpenProbe = await evaluate(`JSON.stringify((() => {
  const thumb = document.querySelector('#thumbs-list .thumb');
  thumb.focus();
  return { openPanelTakesFocus: document.activeElement === thumb };
})())`);
check('закрытый список страниц не принимает фокус',
  JSON.parse(focusProbe).closedPanelTakesFocus === false, 'inert на закрытой панели');
check('открытый список страниц фокус принимает',
  JSON.parse(afterOpenProbe).openPanelTakesFocus === true, 'inert снимается при открытии');

await evaluate(`document.querySelector('#thumbs-close').click()`);
await sleep(500);
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }))`);
await sleep(400);
const hiddenFocus = await evaluate(`JSON.stringify((() => {
  const btn = document.querySelector('#btn-share');
  btn.focus();
  return { takes: document.activeElement === btn, chrome: document.querySelector('#app').dataset.chrome };
})())`);
check('скрытый интерфейс не принимает фокус',
  JSON.parse(hiddenFocus).takes === false && JSON.parse(hiddenFocus).chrome === 'hidden',
  'inert на верхней и нижней панелях');
await evaluate(`window.dispatchEvent(new KeyboardEvent('keydown', { key: 'h' }))`);
await sleep(400);

/* ── 4. Свайп по пустому полю (альбомный телефон) ────────────────────────── */
await device(844, 390, 3, true);
await open(`${URL_UNDER_TEST}?reg=4#p=5`, 4600);
const beforeBg = JSON.parse(await state());
const bgY = beforeBg.block.y + beforeBg.block.h / 2;
const bgStart = beforeBg.block.x + beforeBg.block.w + 70;
await drag(bgStart, bgY, bgStart - 190, bgY);
const afterBg = JSON.parse(await state());
check('свайп по пустому полю тоже листает',
  Number(afterBg.label.split('/')[0]) > Number(beforeBg.label.split('/')[0]),
  `${beforeBg.label} → ${afterBg.label} (жест начат вне книги, x=${bgStart})`);

/* ── 5. Ползунок по-прежнему слушается пальца ────────────────────────────── */
const sliderBox = JSON.parse(await evaluate(`JSON.stringify((() => {
  const r = document.querySelector('#slider').getBoundingClientRect();
  return { x: Math.round(r.x), y: Math.round(r.y + r.height / 2), w: Math.round(r.width) };
})())`));
const beforeSlider = JSON.parse(await state()).label;
await drag(sliderBox.x + 6, sliderBox.y, sliderBox.x + sliderBox.w * 0.8, sliderBox.y, 8, 30);
const afterSlider = JSON.parse(await state()).label;
check('ползунок страниц работает касанием', afterSlider !== beforeSlider,
  `${beforeSlider} → ${afterSlider}`);

/* ── 6. Отмена доводки страницы новым жестом ─────────────────────────────── */
await open(`${URL_UNDER_TEST}?reg=6#p=8`, 4600);
const beforeGlide = JSON.parse(await state());
await touch('touchStart', [{ x: 280, y: bgY, id: 41 }]);
for (let i = 1; i <= 8; i++) {
  await touch('touchMove', [{ x: 280 - i * 24, y: bgY, id: 41 }]);
  await sleep(12);
}
await touch('touchEnd', []);                       // пошла доводка страницы (150 мс)
const mid = { x: 195, y: bgY };
await touch('touchStart', [{ x: mid.x - 30, y: mid.y, id: 51 }, { x: mid.x + 30, y: mid.y, id: 52 }]);
for (let i = 1; i <= 10; i++) {
  const r = 30 + i * 9;
  await touch('touchMove', [{ x: mid.x - r, y: mid.y, id: 51 }, { x: mid.x + r, y: mid.y, id: 52 }]);
  await sleep(26);
}
await touch('touchEnd', []);
await sleep(700);
const afterGlide = JSON.parse(await state());
check('щипок поверх доводки страницы не теряется',
  Number(afterGlide.zoom) > 1.05 && problems.length === 0,
  `масштаб ${afterGlide.zoom}, ошибок ${problems.length}, страница ${beforeGlide.label} → ${afterGlide.label}`);

/* ── 7. Порог 820: поведение JS и CSS совпадают ──────────────────────────── */
await device(1440, 900, 1, false);
await open(`${URL_UNDER_TEST}?reg=7#p=2`, 4200);
await evaluate(`document.querySelector('#btn-thumbs').click()`);
await sleep(500);
await evaluate(`document.querySelectorAll('#thumbs-list .thumb')[4].click()`);
await sleep(1400);
const widePanel = JSON.parse(await state()).thumbsOpen;

await device(320, 568, 2, true);
await open(`${URL_UNDER_TEST}?reg=7b#p=2`, 4600);
await evaluate(`document.querySelector('#btn-thumbs').click()`);
await sleep(600);
await evaluate(`document.querySelectorAll('#thumbs-list .thumb')[4].click()`);
await sleep(1400);
const narrowPanel = JSON.parse(await state()).thumbsOpen;
check('порог 820 одинаков в JS и CSS', widePanel === true && narrowPanel === false,
  `широкий экран: панель осталась (${widePanel}), узкий: закрылась (${!narrowPanel})`);

/* ── 8. Список страниц показывает развороты, а не отдельные листы ────────── */
await device(1440, 900, 1, false);
await open(`${URL_UNDER_TEST}?reg=8#p=3`, 4200);
const cardCount = await evaluate(`document.querySelectorAll('#thumbs-list .thumb').length`);
await evaluate(`document.querySelector('#btn-thumbs').click()`);   // меряем открытую панель
await sleep(600);
const firstCard = await evaluate(`document.querySelector('#thumbs-list .thumb').dataset.pages`);
const secondCard = await evaluate(`document.querySelectorAll('#thumbs-list .thumb')[1].dataset.pages`);
const lastCard = await evaluate(`[...document.querySelectorAll('#thumbs-list .thumb')].pop().dataset.pages`);
const coverBox = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelector('#thumbs-list .thumb').getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })())`));
const spreadBox = JSON.parse(await evaluate(`JSON.stringify((() => { const r = document.querySelectorAll('#thumbs-list .thumb')[1].getBoundingClientRect(); return [Math.round(r.width), Math.round(r.height)]; })())`));
const pagesCovered = await evaluate(`new Set([...document.querySelectorAll('#thumbs-list .thumb')].flatMap(c => c.dataset.pages.split(','))).size`);

check('список страниц сгруппирован по разворотам',
  cardCount === 21 && firstCard === '1' && secondCard === '2,3' && lastCard === '40,41' && pagesCovered === 41,
  `карточек ${cardCount}, первая «${firstCard}», вторая «${secondCard}», последняя «${lastCard}», покрыто страниц ${pagesCovered}`);
check('разворот шире обложки, карточки не схлопнуты',
  spreadBox[0] > coverBox[0] && spreadBox[1] > 60,
  `обложка ${coverBox[0]}×${coverBox[1]}px, разворот ${spreadBox[0]}×${spreadBox[1]}px`);

await evaluate(`document.querySelector('#btn-thumbs').click()`);
await sleep(500);
const clicked = await evaluate(`(() => { const c = [...document.querySelectorAll('#thumbs-list .thumb')].find(x => x.dataset.pages === '10,11'); c.click(); return c.dataset.pages; })()`);
await sleep(1500);
const jumped = await evaluate(`document.querySelector('#page-label').textContent`);
check('клик по развороту открывает его первую страницу', jumped.startsWith('10 '),
  `клик по карточке «${clicked}» → открыто ${jumped}`);
await evaluate(`document.querySelector('#thumbs-close')?.click()`);

/* ── 9. Ссылка на страницу, вставленная в открытую книгу ───────────────── */
await device(1440, 900, 1, false);
await open(`${URL_UNDER_TEST}?reg=9#p=2`, 4200);
await evaluate(`location.hash = 'p=20'`);
await sleep(1500);
const afterHashJump = await evaluate(`document.querySelector('#page-label').textContent`);
check('смена хэша в открытой книге перелистывает', afterHashJump.startsWith('20 '), `открыто ${afterHashJump}`);

/* ── итог ────────────────────────────────────────────────────────────────── */
writeFileSync(`${OUT}/regression-report.json`, JSON.stringify({ results, failures }, null, 2));
console.log(`\nПроверок: ${results.length}, провалено: ${failures}`);
ws.close();
process.exit(failures ? 1 : 0);

/* локальный снимок экрана */
async function shot(name) {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'));
}
