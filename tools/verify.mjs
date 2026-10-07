/**
 * Проверка книги в реальном браузере (headless Chrome через CDP).
 * Запуск: node tools/verify.mjs [url]
 * Требует запущенного Chrome с --remote-debugging-port=9222.
 */
import { writeFileSync } from 'node:fs';

const PORT = Number(process.env.CDP_PORT || 9222);
const URL_UNDER_TEST = process.argv[2] || 'http://127.0.0.1:8123/';
const OUT = process.env.SHOT_DIR || '.';

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const pages = list.filter(t => t.type === 'page' && t.webSocketDebuggerUrl);
      const page = pages.find(t => t.url.startsWith('http')) || pages[0];
      if (page?.webSocketDebuggerUrl) return page;
    } catch { /* браузер ещё поднимается */ }
    await sleep(250);
  }
  throw new Error('не дождался цели CDP');
}

const problems = [];
let id = 0;
const pending = new Map();

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

ws.onmessage = ev => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    return;
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    problems.push(`EXCEPTION: ${d.exception?.description || d.text}`);
  }
  if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
    problems.push(`CONSOLE ${msg.params.type}: ${msg.params.args.map(a => a.value ?? a.description).join(' ')}`);
  }
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') {
    problems.push(`LOG: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
  }
};

const send = (method, params = {}) => new Promise((resolve, reject) => {
  const mid = ++id;
  pending.set(mid, { resolve, reject });
  ws.send(JSON.stringify({ id: mid, method, params }));
});

const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'ошибка вычисления');
  return res.result.value;
};

const report = {};

const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' });
  writeFileSync(`${OUT}/${name}`, Buffer.from(data, 'base64'));
  return `${OUT}/${name}`;
};

/* настоящие события мыши: клик по странице и перетаскивание уголка */
async function mouseClick(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await sleep(60);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await sleep(1300);
}

async function mouseDrag(x0, y0, x1, y1, steps = 14) {
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: x0, y: y0, button: 'left', clickCount: 1 });
  for (let i = 1; i <= steps; i++) {
    const k = i / steps;
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x0 + (x1 - x0) * k, y: y0 + (y1 - y0) * k, button: 'left' });
    await sleep(30);
  }
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: x1, y: y1, button: 'left', clickCount: 1 });
  await sleep(1400);
}

await send('Runtime.enable');
await send('Page.enable');
await send('Log.enable');

await send('Page.navigate', { url: URL_UNDER_TEST });
await sleep(1500);

// ждём, пока книга инициализируется и первые страницы догрузятся
const probe = `(() => {
  const visible = [...document.querySelectorAll('.page')].filter(p => getComputedStyle(p).display !== 'none');
  const sheets = [...document.querySelectorAll('.page .sheet')];
  const br = document.querySelector('.stf__block')?.getBoundingClientRect();
  return JSON.stringify({
    pages: document.querySelectorAll('.stf__item').length,
    lqip: document.querySelectorAll('.lqip').length,
    loaderGone: !document.querySelector('#loader'),
    label: document.querySelector('#page-label')?.textContent,
    hash: location.hash,
    orientation: document.querySelector('.stf__wrapper')?.className.match(/--(portrait|landscape)/)?.[1],
    block: br && { x: Math.round(br.x), y: Math.round(br.y), w: Math.round(br.width), h: Math.round(br.height) },
    visibleDisplayed: visible.length,
    visibleRects: visible.slice(0, 4).map(p => { const r = p.getBoundingClientRect(); return { x: Math.round(r.x), w: Math.round(r.width), alt: p.querySelector('img')?.alt }; }),
    sheetsLoaded: sheets.filter(i => i.complete && i.naturalWidth > 0).length,
    thumbsInPanel: document.querySelectorAll('#thumbs-list .thumb').length,
    portraitFit: document.documentElement.scrollWidth <= window.innerWidth + 1 && document.documentElement.scrollHeight <= window.innerHeight + 1
  });
})()`;

let state = null;
for (let i = 0; i < 30; i++) {
  state = JSON.parse(await evaluate(probe));
  if (state.loaderGone && state.pages === 41) break;
  await sleep(500);
}

console.log('СОСТОЯНИЕ ПОСЛЕ ЗАГРУЗКИ:', JSON.stringify(state, null, 2));
report.cover = state;
await shot('shot-01-cover.png');

// листаем вперёд тремя разными способами
await evaluate(`document.querySelector('#nav-next').click()`);
await sleep(1400);
const afterClick = JSON.parse(await evaluate(probe));
console.log('ПОСЛЕ КЛИКА «ВПЕРЁД»:', afterClick.label, '| hash', afterClick.hash, '| развёрнуто страниц:', afterClick.visibleDisplayed);
report.spread = afterClick;
await shot('shot-02-spread.png');

await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })), window.dispatchEvent(new KeyboardEvent('keydown', { key: 'End' }))`);
await sleep(1500);
const afterEnd = JSON.parse(await evaluate(probe));
console.log('ПОСЛЕ КЛАВИШИ End:', afterEnd.label, '| hash', afterEnd.hash);
report.end = afterEnd;
await shot('shot-03-end.png');

// прыжок по ссылке на страницу 12 + зум
await evaluate(`location.hash = 'p=12'`);
await sleep(200);
const viaHash = await evaluate(`(async () => { location.reload(); return true; })()`);
await sleep(2500);
const afterHash = JSON.parse(await evaluate(probe));
console.log('ПОСЛЕ ОТКРЫТИЯ #p=12:', afterHash.label, '| hash', afterHash.hash, '| загрузка:', afterHash.loaderGone);
report.page12 = afterHash;

await evaluate(`document.querySelector('#btn-zoom-in').click(); document.querySelector('#btn-zoom-in').click();`);
await sleep(500);
const zoomState = JSON.parse(await evaluate(`JSON.stringify({
  transform: document.querySelector('#book-scale').style.transform,
  shield: !document.querySelector('#zoom-shield').hidden
})`));
console.log('ПОСЛЕ ЗУМА:', JSON.stringify(zoomState));
await shot('shot-04-zoom.png');

await evaluate(`document.querySelector('#btn-zoom-out').click(); document.querySelector('#btn-zoom-out').click(); document.querySelector('#btn-thumbs').click();`);
await sleep(700);
const thumbsState = JSON.parse(await evaluate(`JSON.stringify({
  open: document.querySelector('#thumbs').classList.contains('open'),
  width: document.querySelector('#thumbs').getBoundingClientRect().width,
  active: document.querySelector('.thumb.active')?.dataset.page,
  fits: document.documentElement.scrollWidth <= window.innerWidth + 1
})`));
console.log('ПАНЕЛЬ МИНИАТЮР:', JSON.stringify(thumbsState));
await shot('shot-05-thumbs.png');
await evaluate(`document.querySelector('#thumbs-close').click()`);
await sleep(500);

/* мышь: клик по странице и перетаскивание уголка (это обработчики библиотеки) */
await evaluate(`location.hash = 'p=10'`);
await sleep(300);
await send('Page.navigate', { url: `${URL_UNDER_TEST}?mouse=1#p=10` });
await sleep(4200);

const beforeMouse = JSON.parse(await evaluate(probe));
const blocks = beforeMouse.visibleRects;
const rightPage = blocks[blocks.length - 1];
const my = beforeMouse.block.y + beforeMouse.block.h / 2;
const num = s => Number(s.label.split('/')[0].trim());

/* клик по правой половине разворота — библиотека листает вперёд целый разворот */
await mouseClick(rightPage.x + rightPage.w * 0.85, my);
const afterMouseClick = JSON.parse(await evaluate(probe));
const forward = num(afterMouseClick) > num(beforeMouse);
console.log('МЫШЬ, клик по правой странице:', beforeMouse.label, '→', afterMouseClick.label,
  forward ? 'OK (вперёд)' : 'НЕ РАБОТАЕТ');
report.mouseClick = { from: beforeMouse.label, to: afterMouseClick.label };

/* перетаскивание уголка: тянем страницу через середину книги */
await mouseDrag(rightPage.x + rightPage.w - 8, my, beforeMouse.block.x + 20, my);
const afterMouseDrag = JSON.parse(await evaluate(probe));
const dragged = num(afterMouseDrag) > num(afterMouseClick);
console.log('МЫШЬ, перетаскивание страницы через середину:', afterMouseClick.label, '→', afterMouseDrag.label,
  dragged ? 'OK (вперёд)' : 'НЕ ПЕРЕЛИСТНУЛ');
report.mouseDrag = { from: afterMouseClick.label, to: afterMouseDrag.label };
await shot('shot-07-mouse-drag.png');

// узкий экран — портретный режим
await send('Emulation.setDeviceMetricsOverride', { width: 420, height: 860, deviceScaleFactor: 2, mobile: true });
await sleep(1200);
const mobile = JSON.parse(await evaluate(probe));
console.log('МОБИЛЬНЫЙ 420×860:', mobile.orientation, '| видимых страниц:', mobile.visibleDisplayed, '| влезает без прокрутки:', mobile.portraitFit);
report.mobile = mobile;
await shot('shot-06-mobile.png');

console.log('\nОШИБКИ В КОНСОЛИ:', problems.length ? problems : 'нет');
writeFileSync(`${OUT}/state.json`, JSON.stringify({ report, problems }, null, 2));
ws.close();
