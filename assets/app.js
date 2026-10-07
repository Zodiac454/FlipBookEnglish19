/* The Cake of English Tenses — вьюер книги.
   Перелистывание: StPageFlip 2.0.7 (MIT), assets/vendor/page-flip.browser.js

   Разделение труда с библиотекой:
   • мышь с точным указателем — жесты отданы библиотеке (перетаскивание уголка страницы);
   • сенсорный экран — жесты наши (свайп с оттягиванием, щипок, панорамирование),
     потому что собственные обработчики библиотеки конфликтуют с pinch-zoom.
*/
(() => {
  'use strict';

  /* ── Данные книги ─────────────────────────────────────────────────────── */
  const TOTAL = 41;                 // страниц в PDF (см. tools/build-assets.py)
  const PAGE_W = 700;               // логические размеры страницы — пропорции как в PDF
  const PAGE_H = 1005;
  const ASSET_W = 1400;             // фактические размеры файлов pages/*.webp
  const ASSET_H = 2010;             // 1400 * 1005 / 700 — точно пропорции страницы
  const RATIO = PAGE_W / PAGE_H;

  const MIN_SPREAD_PAGE = 300;      // ниже этого библиотека сама уйдёт в одностраничный режим
  const MAX_PAGE_W = 820;           // предел ширины страницы (не путать с NARROW_QUERY)
  const PORTRAIT_MAX_PAGE = 560;    // держим меньше 600, чтобы библиотека осталась в портрете
  const MAX_ZOOM = 4;
  const BOOT_PAGES = 6;             // сколько страниц готовим до показа книги

  /* Окно подкачки: держим в памяти только окружение текущей страницы.
     Все 41 страница разом — это ~460 МБ декодированных картинок 1400x2009,
     на планшете вкладка от такого падает. */
  const LOAD_AHEAD = 4;
  const LOAD_BEHIND = 1;
  const KEEP_AHEAD = 6;             // за этими границами освобождаем память
  const KEEP_BEHIND = 3;
  const MAX_TRIES = 3;              // попытки загрузки одной страницы

  /* Порог «узкого» экрана. Обязан совпадать с @media (max-width: 820px) в style.css:
     от него зависит, закрывать ли список страниц после выбора миниатюры. */
  const NARROW_QUERY = '(max-width: 820px)';

  const pad = n => String(n).padStart(3, '0');
  const pageSrc = n => `pages/p${pad(n)}.webp`;
  const thumbSrc = n => `thumbs/p${pad(n)}.webp`;
  const $ = sel => document.querySelector(sel);

  /* ── Окружение ────────────────────────────────────────────────────────── */
  /* Один источник правды для «это сенсорный экран» — и для жестов, и для CSS:
     media query учитывает основной указатель (тачскрин-ноутбук с мышью → мышь). */
  const touchMode = window.matchMedia('(hover: none) and (pointer: coarse)').matches;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const FLIP_TIME = reduceMotion ? 260 : 820;
  const canFullscreen = Boolean(
    document.fullscreenEnabled ?? document.webkitFullscreenEnabled
    ?? ('requestFullscreen' in document.documentElement)
  );   // именно так: на iOS Safari 'webkitRequestFullscreen' есть, а режима нет

  /* ── Элементы ─────────────────────────────────────────────────────────── */
  const app = $('#app');
  const stage = $('#stage');
  const topbar = $('.topbar');
  const hud = $('#hud');
  const bookEl = $('#book');
  const holder = $('#book-holder');
  const scaleEl = $('#book-scale');
  const shield = $('#zoom-shield');
  const chart = { zoomChip: $('#zoom-chip'), zoomValue: $('#zoom-value') };
  const loader = $('#loader');
  const loaderFill = $('#loader-fill');
  const label = $('#page-label');
  const slider = $('#slider');
  const thumbsPanel = $('#thumbs');
  const thumbsList = $('#thumbs-list');
  const btnPrev = $('#nav-prev');
  const btnNext = $('#nav-next');
  const toastEl = $('#toast');
  const hintEl = $('#hint');

  let flip = null;
  let blockEl = null;
  let bookReady = false;    // до конца инициализации служебные события библиотеки игнорируем
  let current = 1;
  let zoom = 1;
  let tx = 0;
  let ty = 0;

  /* ── Страницы в DOM ───────────────────────────────────────────────────── */
  const pageEls = [];

  for (let n = 1; n <= TOTAL; n++) {
    const page = document.createElement('div');
    page.className = 'page';
    if (n === 1 || n === TOTAL) page.dataset.density = 'hard';

    const inner = document.createElement('div');
    inner.className = 'page-inner';

    const lqip = document.createElement('div');
    lqip.className = 'lqip';
    lqip.style.backgroundImage = `url("${thumbSrc(n)}")`;

    const img = document.createElement('img');
    img.className = 'sheet';
    img.alt = `Страница ${n}`;
    img.width = ASSET_W;
    img.height = ASSET_H;
    img.decoding = 'async';
    img.dataset.src = pageSrc(n);

    const note = document.createElement('div');
    note.className = 'page-note';
    note.textContent = 'Страница не загрузилась';

    inner.append(lqip, img, note);
    page.append(inner);
    bookEl.append(page);
    pageEls.push(page);
  }

  /* ── Подгонка книги под экран ─────────────────────────────────────────── */
  /* Проблема, которую решаем: библиотека сама переключает «разворот ↔ одна
     страница» по ширине блока (порог 2 × minWidth = 600 px). Поэтому размер
     считаем так, чтобы решение библиотеки совпало с нашим: разворот — только
     когда каждая страница получается не меньше 300 px.                     */
  function fitBook() {
    const box = stage.getBoundingClientRect();
    const cs = getComputedStyle(stage);
    const padX = parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    const padY = parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom);

    const availW = Math.max(200, box.width - padX);
    const availH = Math.max(200, box.height - padY);

    const spreadPage = Math.min(availW / 2, availH * RATIO, MAX_PAGE_W);
    const portrait = spreadPage < MIN_SPREAD_PAGE;

    const pageW = Math.max(
      120,
      Math.round(portrait
        ? Math.min(availW, availH * RATIO, PORTRAIT_MAX_PAGE)
        : spreadPage)
    );
    const width = pageW * (portrait ? 1 : 2);

    if (holder.dataset.width === String(width)) return false;
    holder.dataset.width = String(width);
    holder.style.width = `${width}px`;
    return true;
  }

  /* ── Библиотека ───────────────────────────────────────────────────────── */
  function initBook(startPage) {
    fitBook();

    flip = new St.PageFlip(bookEl, {
      width: PAGE_W,
      height: PAGE_H,
      size: 'stretch',
      minWidth: 300,
      maxWidth: MAX_PAGE_W,
      minHeight: 420,
      maxHeight: 1180,
      drawShadow: true,
      flippingTime: FLIP_TIME,
      usePortrait: true,
      startPage: startPage - 1,
      startZIndex: 0,
      autoSize: true,
      maxShadowOpacity: 0.4,
      showCover: true,
      mobileScrollSupport: true,
      swipeDistance: 24,
      clickEventForward: true,
      useMouseEvents: !touchMode,    // на сенсоре жесты наши — см. шапку файла
      showPageCorners: !touchMode,
      disableFlipByClick: false,
    });

    flip.on('flip', e => {
      current = Number(e.data) + 1;
      /* При инициализации библиотека сама вызывает pages.show() без аргумента
         и генерирует flip с нулевой страницей — это не листание пользователя. */
      if (!bookReady) return;

      syncUI();
      applyCoverShift(reduceMotion ? 0 : 460);
      // страница, которая раньше не загрузилась, при новом визите получает ещё шанс
      if (failed.delete(current)) attempts.delete(current);
      releaseFar();                 // освобождаем память от дальних страниц
      pump();                       // догружаем окружение новой страницы
    });

    /* уходим с одиночной обложки — сдвигаем книгу к центру вместе с анимацией */
    flip.on('changeState', e => {
      if (e.data === 'flipping' && current === 1) applyCoverShift(FLIP_TIME);
    });

    flip.on('changeOrientation', () => {
      if (fitBook()) flip.update();
      applyCoverShift(0);
    });

    flip.loadFromHTML(pageEls);   // именно loadFromHTML: так метод назван в сборке 2.0.7

    /* Библиотека ставит книге inline min-width = minWidth. На низких экранах
       (телефон в альбомной ориентации) из-за этого книга не может стать уже
       300 px и вылезает за высоту — снимаем ограничение. */
    bookEl.style.minWidth = '0px';
    bookEl.style.minHeight = '0px';

    blockEl = bookEl.querySelector('.stf__block');

    current = startPage;
    syncUI();
    applyCoverShift(0);
    bookReady = true;         // с этого момента события flip — настоящие
  }

  /* Одиночная страница в ландшафтном режиме рисуется в правой половине
     разворота — сдвигаем блок на полстраницы, чтобы она встала по центру. */
  function applyCoverShift(duration) {
    if (!blockEl || !flip) return;
    const single = flip.getOrientation() === 'landscape' && current === 1;
    const x = single ? -flip.getBoundsRect().pageWidth / 2 : 0;
    blockEl.style.transition = duration
      ? `transform ${duration}ms cubic-bezier(.23, 1, .32, 1)`
      : 'none';
    blockEl.style.transform = `translateX(${x}px)`;
  }

  /* ── Интерфейс ────────────────────────────────────────────────────────── */
  function syncUI() {
    label.textContent = `${current} / ${TOTAL}`;
    if (Number(slider.value) !== current) slider.value = String(current);
    slider.style.setProperty('--progress', `${((current - 1) / (TOTAL - 1)) * 100}%`);

    btnPrev.disabled = current <= 1;
    btnNext.disabled = current >= TOTAL;
    $('#hud-prev').disabled = current <= 1;
    $('#hud-next').disabled = current >= TOTAL;

    for (const el of thumbsList.children) {
      const active = el.dataset.pages.split(',').includes(String(current));
      el.classList.toggle('active', active);
      if (active && thumbsPanel.classList.contains('open')) {
        el.scrollIntoView({ block: 'nearest' });
      }
    }

    const url = new URL(location.href);
    url.hash = `p=${current}`;
    try { history.replaceState(null, '', url.href); } catch (_) { /* бывает на file:// */ }
  }

  function go(delta) {
    if (!flip) return;
    const target = current + delta;
    if (target < 1 || target > TOTAL) return;
    if (zoom > 1.001) resetZoom();
    if (delta > 0) flip.flipNext('bottom');
    else flip.flipPrev('bottom');
  }

  function jumpTo(n) {
    if (!flip) return;
    n = Math.min(TOTAL, Math.max(1, Math.trunc(n)));
    if (n === current) return;
    if (zoom > 1.001) resetZoom();
    flip.flip(n - 1);
  }

  /* ── Список страниц: показываем книгу так же, как она листается ───────── */
  /* Развороты совпадают с группировкой библиотеки: обложка отдельно,
     дальше парами — 1 | 2–3 | 4–5 | … | 40–41. */
  const SPREADS = [[1]];
  for (let n = 2; n <= TOTAL; n += 2) {
    SPREADS.push(n + 1 <= TOTAL ? [n, n + 1] : [n]);
  }

  SPREADS.forEach((pages, index) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = pages.length === 1 ? 'thumb thumb-single' : 'thumb';
    btn.dataset.pages = pages.join(',');
    btn.title = pages.length === 1
      ? `Страница ${pages[0]}`
      : `Разворот: страницы ${pages[0]} и ${pages[1]}`;
    btn.style.animationDelay = `${Math.min(index, 12) * 26}ms`;

    const pair = document.createElement('span');
    pair.className = 'thumb-pair';
    for (const n of pages) {
      const img = document.createElement('img');
      img.src = thumbSrc(n);
      img.alt = `Страница ${n}`;
      img.width = 300;          // размеры файла миниатюры: без них карточки
      img.height = 431;         // успевают схлопнуться до загрузки картинок
      img.loading = 'lazy';
      img.decoding = 'async';
      pair.append(img);
    }

    const num = document.createElement('span');
    num.className = 'thumb-label';
    num.textContent = pages.length === 1 ? String(pages[0]) : `${pages[0]}–${pages[1]}`;

    btn.append(pair, num);
    btn.addEventListener('click', () => {
      jumpTo(pages[0]);
      if (window.matchMedia(NARROW_QUERY).matches) toggleThumbs(false);
    });
    thumbsList.append(btn);
  });

  function toggleThumbs(force) {
    const open = force !== undefined ? force : !thumbsPanel.classList.contains('open');
    thumbsPanel.classList.toggle('open', open);
    thumbsPanel.setAttribute('aria-hidden', String(!open));
    thumbsPanel.inert = !open;              // закрытая панель не должна ловить фокус
    $('#btn-thumbs').setAttribute('aria-pressed', String(open));
    requestAnimationFrame(() => {
      if (fitBook() && flip) flip.update();
      applyCoverShift(0);
    });
  }

  /* ── Масштаб ──────────────────────────────────────────────────────────── */
  function render() {
    scaleEl.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${zoom})`;
    const zoomed = zoom > 1.001;

    shield.hidden = !zoomed;
    chart.zoomChip.hidden = !zoomed;
    chart.zoomValue.textContent = `${Math.round(zoom * 100)} %`;

    $('#btn-zoom-in').disabled = zoom >= MAX_ZOOM;
    $('#btn-zoom-out').disabled = zoom <= 1;
  }

  function clampPan() {
    const box = stage.getBoundingClientRect();
    const cs = getComputedStyle(stage);
    const stageW = box.width - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    const stageH = box.height - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);

    const contentW = holder.offsetWidth * zoom;
    const contentH = holder.offsetHeight * zoom;

    const maxX = Math.max(0, (contentW - stageW) / 2 + 28);
    const maxY = Math.max(0, (contentH - stageH) / 2 + 28);
    tx = Math.min(maxX, Math.max(-maxX, tx));
    ty = Math.min(maxY, Math.max(-maxY, ty));
  }

  function setZoom(next) {
    zoom = Math.min(MAX_ZOOM, Math.max(1, next));
    if (zoom <= 1.001) { zoom = 1; tx = 0; ty = 0; }
    clampPan();
    render();
  }

  function resetZoom() { setZoom(1); }

  /** центр нетрансформированного #book-scale в координатах окна */
  function untransformedCenter() {
    const r = scaleEl.getBoundingClientRect();
    return { x: r.left + r.width / 2 - tx, y: r.top + r.height / 2 - ty };
  }

  /* ── Мышь: панорамирование при увеличении ─────────────────────────────── */
  let mouseDrag = null;

  shield.addEventListener('pointerdown', e => {
    if (e.pointerType !== 'mouse') return;
    mouseDrag = { x: e.clientX, y: e.clientY, tx, ty };
    scaleEl.classList.add('dragging');
    shield.classList.add('dragging');
    shield.setPointerCapture(e.pointerId);
  });

  shield.addEventListener('pointermove', e => {
    if (!mouseDrag) return;
    tx = mouseDrag.tx + (e.clientX - mouseDrag.x);
    ty = mouseDrag.ty + (e.clientY - mouseDrag.y);
    clampPan();
    render();
  });

  const endMouseDrag = () => {
    if (!mouseDrag) return;
    mouseDrag = null;
    scaleEl.classList.remove('dragging');
    shield.classList.remove('dragging');
  };
  shield.addEventListener('pointerup', endMouseDrag);
  shield.addEventListener('pointercancel', endMouseDrag);

  /* ── Сенсор: свайп с оттягиванием страницы, щипок, тап ────────────────── */
  /* Жесты ловим на всей сцене — свайп по пустому полю тоже листает.
     Отпускание пальца слушаем на window: палец может подняться за пределами
     книги, и тогда в наборе осталась бы «мёртвая» точка — книга перестала бы
     слушаться до перезагрузки. */
  const GESTURE_SURFACE = stage;

  const pts = new Map();
  let gesture = null;      // 'tap' | 'fold' | 'pan' | 'pinch'
  let start = null;
  let pinch = null;
  let foldPoint = null;
  let firstFold = false;   // первая точка перегиба в этом жесте
  let glide = 0;           // поколение доводки страницы до края
  let glideRaf = 0;

  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const isChromeTarget = t => !!(t && t.closest && t.closest('#hud, .topbar, #thumbs, #zoom-chip, button, input'));

  function gestureDown(e) {
    if (!touchMode) return;
    if (isChromeTarget(e.target)) return;      // касания по интерфейсу — не наши
    if (pts.size >= 3) resetGesture();         // страховка от застрявших точек
    cancelGlide();                             // новый жест отменяет догоняющую анимацию

    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    scaleEl.setPointerCapture?.(e.pointerId);  // держим каждый палец, а не только первый

    if (pts.size === 2) {
      const [a, b] = [...pts.values()];
      gesture = 'pinch';
      pinch = {
        d0: Math.max(24, dist(a, b)),
        z0: zoom,
        t0: { x: tx, y: ty },
        m0: mid(a, b),
        c: untransformedCenter(),
      };
      scaleEl.classList.add('dragging');
      stopFold();
      return;
    }

    if (pts.size !== 1) return;

    start = { x: e.clientX, y: e.clientY, t: performance.now(), tx0: tx, ty0: ty };
    gesture = zoom > 1.001 ? 'pan' : 'tap';
  }

  function gestureMove(e) {
    if (!touchMode || !pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (gesture === 'pinch' && pts.size >= 2) {
      e.preventDefault();
      const [a, b] = [...pts.values()];
      const z1 = Math.min(MAX_ZOOM, Math.max(1, pinch.z0 * dist(a, b) / pinch.d0));
      const m1 = mid(a, b);
      const k = z1 / pinch.z0;
      zoom = z1;
      tx = m1.x - pinch.c.x - (pinch.m0.x - pinch.c.x - pinch.t0.x) * k;
      ty = m1.y - pinch.c.y - (pinch.m0.y - pinch.c.y - pinch.t0.y) * k;
      if (zoom <= 1.001) { zoom = 1; tx = 0; ty = 0; }
      clampPan();
      render();
      return;
    }

    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;

    if (gesture === 'pan') {
      e.preventDefault();
      tx = start.tx0 + dx;
      ty = start.ty0 + dy;
      clampPan();
      render();
      return;
    }

    if (gesture === 'tap') {
      if (Math.hypot(dx, dy) < 9) return;
      if (Math.abs(dx) < Math.abs(dy)) { gesture = 'none'; return; }   // вертикальный — не наш
      gesture = 'fold';
      firstFold = true;                       // первую точку заводим внутрь страницы
      scaleEl.classList.add('dragging');
    }

    if (gesture === 'fold') {
      e.preventDefault();
      foldAt(e.clientX, e.clientY, firstFold);
      firstFold = false;
    }
  }

  function gestureUp(e, cancelled) {
    if (!touchMode) return;
    const wasPinch = gesture === 'pinch';
    pts.delete(e.pointerId);

    if (pts.size > 0) return;     // ждём, пока отпустят все пальцы

    if (cancelled) {              // жест отменила система — откатываем, не перелистываем
      if (gesture === 'fold') stopFold();
      resetGesture();
      return;
    }

    if (gesture === 'fold' && start) {
      finishFold(e.clientX, e.clientY, performance.now() - start.t);
    }

    if (gesture === 'tap' && start) {
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y);
      const quick = performance.now() - start.t < 600;
      if (moved < 12 && quick) handleTap(e.clientX, e.clientY);
    }

    if (wasPinch) setZoom(zoom);   // прилипание к 100 % и включение/выключение щита
    else if (zoom <= 1.001) resetZoom();

    resetGesture();
  }

  function resetGesture() {
    scaleEl.classList.remove('dragging');
    gesture = null;
    start = null;
    pinch = null;
    pts.clear();
    firstFold = false;
  }

  function handleTap(clientX, clientY) {
    const rect = blockEl ? blockEl.getBoundingClientRect() : stage.getBoundingClientRect();
    const where = (clientX - rect.left) / rect.width;

    // Границы те же, что у библиотеки для мыши (половина разворота),
    // только узкая полоса у корешка отдана переключению интерфейса.
    if (where < 0.42) go(-1);
    else if (where > 0.58) go(1);
    else toggleChrome();
  }

  /** оттянуть страницу пальцем (физику считает библиотека)
   *  clampToPage — только для первой точки жеста: она обязана лежать внутри страницы.
   *  Дальше точки не ограничиваем, иначе страница никогда не дойдёт до края
   *  и библиотека не завершит перелистывание. */
  function foldAt(clientX, clientY, clampToPage = false) {
    if (!flip || !blockEl) return;
    const rect = blockEl.getBoundingClientRect();
    const x = clampToPage ? Math.min(Math.max(clientX, rect.left + 2), rect.right - 2) : clientX;
    const y = clampToPage ? Math.min(Math.max(clientY, rect.top + 2), rect.bottom - 2) : clientY;
    foldPoint = { x: clientX, y: clientY };
    try {
      flip.getFlipController().fold({ x: x - rect.left, y: y - rect.top });
    } catch (_) { /* уголок не за что тянуть — не страшно */ }
  }

  /* Библиотека завершает перелистывание только когда страницу довели до самого
     края. Для свайпа это слишком строго: решаем сами — по пути и по скорости —
     и, если жест решителен, доводим страницу до края за 150 мс. */
  function finishFold(clientX, clientY, elapsed) {
    if (!flip || !blockEl) return;
    const rect = blockEl.getBoundingClientRect();
    const travelled = clientX - start.x;
    const velocity = Math.abs(travelled) / Math.max(1, elapsed);
    const decisive = Math.abs(travelled) > Math.max(56, rect.width * 0.22) || velocity > 0.45;

    if (!decisive) { stopFold(); return; }     // не дотянули — страница возвращается

    const from = foldPoint || { x: clientX, y: clientY };
    const edgeX = travelled < 0 ? rect.left - 24 : rect.left + rect.width + 24;
    const t0 = performance.now();
    const generation = ++glide;                // доводку можно отменить новым жестом

    const step = () => {
      if (generation !== glide) return;        // отменено — молча выходим
      const k = Math.min(1, (performance.now() - t0) / 150);
      const eased = 1 - Math.pow(1 - k, 3);
      foldAt(from.x + (edgeX - from.x) * eased, clientY);   // без ограничения: доводим до края
      if (k < 1) glideRaf = requestAnimationFrame(step);
      else { glideRaf = 0; stopFold(); }
    };
    glideRaf = requestAnimationFrame(step);
  }

  function cancelGlide() {
    glide++;
    if (glideRaf) { cancelAnimationFrame(glideRaf); glideRaf = 0; }
  }

  function stopFold() {
    cancelGlide();
    if (!flip) return;
    try { flip.getFlipController().stopMove(); } catch (_) {}
  }

  GESTURE_SURFACE.addEventListener('pointerdown', gestureDown);
  GESTURE_SURFACE.addEventListener('pointermove', gestureMove, { passive: false });
  window.addEventListener('pointerup', e => gestureUp(e, false));
  window.addEventListener('pointercancel', e => gestureUp(e, true));
  window.addEventListener('blur', resetGesture);

  /* Гасим системный жест прокрутки на сцене: без этого браузер трактует
     перетаскивание, начатое в пустом поле, как прокрутку и отменяет его
     событием pointercancel. Панели не трогаем — ползунок должен работать. */
  stage.addEventListener('touchstart', e => {
    if (!touchMode || isChromeTarget(e.target)) return;
    if (e.cancelable) e.preventDefault();
  }, { passive: false });

  /* ── Режим чтения: скрыть панели ──────────────────────────────────────── */
  function toggleChrome(force) {
    const hidden = force !== undefined ? force : app.dataset.chrome !== 'hidden';
    app.dataset.chrome = hidden ? 'hidden' : 'shown';
    // невидимое не должно быть достижимо клавишей Tab
    for (const el of [topbar, hud, btnPrev, btnNext]) el.inert = hidden;
  }

  /* ── Кнопки и ползунок ────────────────────────────────────────────────── */
  btnPrev.addEventListener('click', () => go(-1));
  btnNext.addEventListener('click', () => go(1));
  $('#hud-prev').addEventListener('click', () => go(-1));
  $('#hud-next').addEventListener('click', () => go(1));
  $('#btn-zoom-in').addEventListener('click', () => setZoom(zoom * 1.3));
  $('#btn-zoom-out').addEventListener('click', () => setZoom(zoom / 1.3));
  chart.zoomChip.addEventListener('click', resetZoom);
  $('#btn-thumbs').addEventListener('click', () => toggleThumbs());
  $('#thumbs-close').addEventListener('click', () => toggleThumbs(false));
  $('#btn-share').addEventListener('click', share);
  $('#btn-full').addEventListener('click', toggleFullscreen);

  if (!canFullscreen) $('#btn-full').hidden = true;
  thumbsPanel.inert = true;            // список страниц закрыт с самого начала

  slider.addEventListener('input', () => {
    label.textContent = `${slider.value} / ${TOTAL}`;
    slider.style.setProperty('--progress', `${((Number(slider.value) - 1) / (TOTAL - 1)) * 100}%`);
  });
  slider.addEventListener('change', () => jumpTo(Number(slider.value)));

  /* ── Колесо: листание (масштаб браузера не перехватываем) ─────────────── */
  let wheelLock = 0;
  stage.addEventListener('wheel', e => {
    if (zoom > 1.001) return;
    e.preventDefault();
    const now = Date.now();
    if (now - wheelLock < 420) return;
    wheelLock = now;
    go(e.deltaY > 0 ? 1 : -1);
  }, { passive: false });

  /* ── Клавиатура ───────────────────────────────────────────────────────── */
  window.addEventListener('keydown', e => {
    // Пробел на сфокусированной кнопке должен нажимать кнопку, а не листать
    const focused = document.activeElement;
    const onControl = focused && ['BUTTON', 'A'].includes(focused.tagName);

    switch (e.key) {
      case 'ArrowRight': case 'PageDown': e.preventDefault(); go(1); break;
      case ' ':
        if (onControl) return;               // пусть сработает кнопка
        e.preventDefault(); go(1);
        break;
      case 'ArrowLeft': case 'PageUp': e.preventDefault(); go(-1); break;
      case 'Home': e.preventDefault(); jumpTo(1); break;
      case 'End': e.preventDefault(); jumpTo(TOTAL); break;
      case '+': case '=': e.preventDefault(); setZoom(zoom * 1.3); break;
      case '-': case '_': e.preventDefault(); setZoom(zoom / 1.3); break;
      case '0': e.preventDefault(); resetZoom(); break;
      case 'f': case 'F': case 'а': case 'А': e.preventDefault(); toggleFullscreen(); break;
      case 't': case 'T': case 'е': case 'Е': e.preventDefault(); toggleThumbs(); break;
      case 'h': case 'H': case 'р': case 'Р': e.preventDefault(); toggleChrome(); break;
      case 'Escape':
        if (thumbsPanel.classList.contains('open')) toggleThumbs(false);
        else if (zoom > 1.001) resetZoom();
        break;
      default: break;
    }
  });

  /* ── Полный экран ─────────────────────────────────────────────────────── */
  function toggleFullscreen() {
    const isFull = document.fullscreenElement || document.webkitFullscreenElement;
    if (isFull) {
      (document.exitFullscreen || document.webkitExitFullscreen || (() => {})).call(document);
    } else {
      const el = document.documentElement;
      (el.requestFullscreen || el.webkitRequestFullscreen || (() => {})).call(el);
    }
  }

  document.addEventListener('fullscreenchange', () => {
    setTimeout(() => { if (fitBook() && flip) flip.update(); applyCoverShift(0); }, 60);
  });

  /* ── Уведомления и ссылка ─────────────────────────────────────────────── */
  let toastTimer = 0;
  function toast(text) {
    toastEl.textContent = text;
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl.classList.remove('show'), 2600);
  }

  async function share() {
    const url = location.href;
    try {
      await navigator.clipboard.writeText(url);
      toast(`Ссылка на страницу ${current} скопирована`);
    } catch (_) {
      window.prompt('Ссылка на эту страницу — скопируйте её:', url);
    }
  }

  /* ── Пересчёт при изменении окна ─────────────────────────────────────── */
  let resizeTimer = 0;
  function refit() {
    if (fitBook() && flip) flip.update();
    applyCoverShift(0);
    clampPan();
    render();
  }

  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, 120);
  });

  window.addEventListener('orientationchange', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(refit, 260);
  });

  /* Если ссылку на страницу вставили в уже открытую книгу (меняется только хэш,
     документ не перезагружается) — переходим на нужную страницу сами.
     replaceState в syncUI события hashchange не вызывает, петли нет. */
  window.addEventListener('hashchange', () => {
    const n = startPageFromUrl();
    if (n !== current) jumpTo(n);
  });

  /* Надёжнее, чем событие resize: ловит любые изменения размеров сцены —
     поворот телефона, скрытие адресной строки, открытие панели страниц. */
  if ('ResizeObserver' in window) {
    let raf = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => { if (fitBook() && flip) flip.update(); applyCoverShift(0); });
    }).observe(stage);
  }

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { resetGesture(); cancelGlide(); return; }
    applyCoverShift(0);
    render();
  });

  /* ── Загрузка страниц ─────────────────────────────────────────────────── */
  const loaded = new Set();       // загружены и держатся в памяти
  const active = new Set();       // грузятся прямо сейчас
  const failed = new Set();       // испробовали все попытки
  const attempts = new Map();
  let pumping = false;

  const wait = ms => new Promise(r => setTimeout(r, ms));

  function loadImage(src) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => resolve(true);
      img.onerror = () => resolve(false);
      img.src = src;
    });
  }

  function inLoadWindow(n) {
    return n >= current - LOAD_BEHIND && n <= current + LOAD_AHEAD;
  }

  function priorityOrder() {
    const order = [current, current + 1, current + 2, current - 1];
    for (let d = 3; d <= Math.max(LOAD_AHEAD, LOAD_BEHIND); d++) order.push(current + d, current - d);
    const seen = new Set();
    return order.filter(n => n >= 1 && n <= TOTAL && inLoadWindow(n) && !seen.has(n) && seen.add(n));
  }

  function nextNeeded() {
    for (const n of priorityOrder()) {
      if (!loaded.has(n) && !active.has(n) && !failed.has(n)) return n;
    }
    return null;
  }

  async function loadPage(n) {
    const el = pageEls[n - 1];
    const img = el.querySelector('.sheet');
    if (img.getAttribute('src')) return true;

    const tries = (attempts.get(n) || 0) + 1;
    attempts.set(n, tries);
    const ok = await loadImage(pageSrc(n));

    if (ok) {
      img.src = pageSrc(n);
      el.classList.add('is-loaded');
      el.classList.remove('is-failed');
      attempts.delete(n);                      // успех обнуляет счётчик попыток
      return true;
    }
    if (tries < MAX_TRIES) {                  // ещё попытка с нарастающей паузой
      await wait(500 * tries);
      return loadPage(n);
    }
    el.classList.add('is-failed');            // показываем пометку на странице
    return false;
  }

  /** освобождает память от страниц, ушедших далеко от текущей */
  function releaseFar() {
    for (let n = 1; n <= TOTAL; n++) {
      if (n >= current - KEEP_BEHIND && n <= current + KEEP_AHEAD) continue;
      if (!loaded.has(n)) continue;
      const el = pageEls[n - 1];
      el.querySelector('.sheet').removeAttribute('src');
      el.classList.remove('is-loaded');       // останется лёгкая подложка
      loaded.delete(n);
    }
  }

  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      for (;;) {
        const n = nextNeeded();
        if (n === null) break;
        active.add(n);
        try {
          const ok = await loadPage(n);
          if (ok) loaded.add(n);
          else failed.add(n);
        } catch (err) {
          failed.add(n);
          console.error('Страница не загрузилась:', n, err);
        } finally {
          active.delete(n);
        }
      }
    } finally {
      pumping = false;
    }
  }

  /* ── Старт ────────────────────────────────────────────────────────────── */
  function startPageFromUrl() {
    const fromHash = /(?:^|[#&?])p=(\d+)/.exec(location.hash);
    const fromQuery = new URLSearchParams(location.search).get('page');
    const n = Number(fromHash?.[1] ?? fromQuery ?? 1);
    if (!Number.isFinite(n)) return 1;
    return Math.min(TOTAL, Math.max(1, Math.trunc(n)));
  }

  function showHint() {
    const key = 'cake-hint-seen';
    try {
      if (sessionStorage.getItem(key)) return;
      sessionStorage.setItem(key, '1');
    } catch (_) { /* приватный режим — покажем один раз за загрузку */ }

    hintEl.textContent = touchMode
      ? 'Листайте: свайп, касание у края страницы или щипок для увеличения'
      : 'Листайте: клик по краю страницы, стрелки ← → или колесо мыши';
    hintEl.hidden = false;
    setTimeout(() => { hintEl.hidden = true; }, 7200);
  }

  async function boot() {
    const start = startPageFromUrl();
    slider.max = String(TOTAL);

    const warm = [];
    for (let i = 0; i < BOOT_PAGES; i++) {
      const n = start + i;
      if (n >= 1 && n <= TOTAL) warm.push(n);
    }
    if (start > 1) warm.push(start - 1);

    let done = 0;
    const total = warm.length * 2;
    const tick = () => {
      done++;
      loaderFill.style.width = `${Math.round((done / total) * 100)}%`;
    };

    // ждём миниатюры (они лёгкие) и страницу, с которой открываемся
    await Promise.race([
      Promise.all([
        ...warm.map(n => loadImage(thumbSrc(n)).then(tick).catch(tick)),
        loadImage(pageSrc(start)).then(tick).catch(tick),
      ]),
      new Promise(r => setTimeout(r, 8000)),
    ]);

    try {
      initBook(start);
    } catch (err) {
      showBootError(err);           // экран загрузки не должен висеть вечно
      return;
    }
    loaderFill.style.width = '100%';
    render();

    loader.classList.add('done');
    setTimeout(() => loader.remove(), 460);

    pump();                       // остальные страницы — в фоне, начиная с текущей
    showHint();
  }

  /** Понятное сообщение вместо вечного экрана загрузки. */
  function showBootError(err) {
    console.error('Книга не открылась:', err);
    if (loader.isConnected) {
      const card = loader.querySelector('.loader-card');
      if (card) {
        card.textContent = '';
        const title = document.createElement('div');
        title.className = 'loader-title';
        title.textContent = 'Книга не открылась';
        const sub = document.createElement('div');
        sub.className = 'loader-sub';
        sub.textContent = 'Обновите страницу. Если не помогает — проверьте, что рядом лежат папки pages и assets.';
        card.append(title, sub);
      }
    } else {
      toast('Что-то пошло не так. Обновите страницу.');
    }
  }

  boot().catch(showBootError);
})();
