/* ==========================================================================
   Cizi Code — Aktif Bağlantı Haritası
   Bağımlılık yok. Electron renderer'da doğrudan çalışır (node entegrasyonu
   gerekmez). CDP ile enjekte edilebilir: window.CiziBaglantiHaritasi

   Kullanım:
     const map = new CiziBaglantiHaritasi(document.querySelector('#harita'), {
       data, autoplay: true, speed: 1
     });
     map.replay();  map.settle();  map.destroy();
   ========================================================================== */

(function (global) {
  'use strict';

  var SVGNS = 'http://www.w3.org/2000/svg';

  /* ---------------------------------------------------------------- veri */
  var DEFAULT_DATA = {
    provider: { name: 'Cloud', status: 'Bağlı', icon: 'cloud' },
    models: [
      { name: 'Opus 5',    meta: '4 model' },
      { name: 'Sol 5.6',   meta: '3 model' },
      { name: 'Terra',     meta: '3 model' },
      { name: 'Laguna 2.1', meta: '2 model' }
    ],
    tools: [
      { name: 'Claude Code CLI', icon: 'cli' },
      { name: 'Claude Desktop',  icon: 'app' },
      { name: 'Codex CLI',       icon: 'cli' },
      { name: 'Codex Desktop',   icon: 'app' }
    ],
    /* model index -> araç index.
       Videodaki desen tam ters permütasyon: üstteki model en alttaki araca,
       alttaki model en üsttekine gidiyor. Ortada oluşan "kelebek" çaprazlaması
       haritanın imzası. Serbest biçimli: bir model birden fazla araca
       bağlanabilir, ör. [[0,0],[0,2],[1,1]]. */
    links: [[0, 3], [1, 2], [2, 1], [3, 0]]
  };

  /* ------------------------------------------------------------ zamanlama
     Videodan kare kare çıkarılan ms değerleri. speed ile ölçeklenir.      */
  var DEFAULT_TIMELINE = {
    providerIn: 260,
    providerDur: 620,
    sheen: 430,

    providerPins: 1780,
    providerPinsStagger: 55,

    wireA: 1950,          // provider -> model kabloları
    wireAStagger: 90,
    wireADur: 1000,

    modelIn: 2900,        // kablolar inerken model kartları girer
    modelStagger: 160,
    modelDur: 500,

    wireB: 3700,          // model -> araç kabloları
    wireBStagger: 110,
    wireBDur: 1100,

    toolFrame: 5250,      // önce boş araç çerçeveleri
    toolFrameStagger: 90,
    toolFrameDur: 380,

    toolFill: 6100,       // sonra ikon + etiket
    toolFillStagger: 120,
    toolFillDur: 440,

    settle: 7100          // sıcak kablolar sönüp sürekli enerji akışına geçer
  };

  var OPTS = {
    data: null,
    timeline: null,
    autoplay: true,
    speed: 1,
    pulseSpeed: 190,     // px/sn — enerji akış hızı
    pulseLength: 26,     // px — akan ışık parçasının boyu

    /* --- geometri: hepsi videodan ölçüldü --- */
    leadOut: 14,         // pinden çıkan düz pay
    leadIn: 26,          // hedefe giren düz pay (çıkıştan daha uzun)
    bendMin: 28,         // düz giden kablolarda minimum kıvrım
    bendRatio: 0.75,     // kıvrım genişliği = 0.75 × |dy|
    fanGap: 14,          // provider çıkışındaki pin aralığı

    perf: 'auto'         // 'auto' | 'low'
  };

  /* --------------------------------------------------------------- ikonlar */
  var ICONS = {
    cloud: '<svg class="cbh__icon cbh__icon--cloud" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"><path d="M6.6 18.4A4.1 4.1 0 0 1 6 10.5a5.6 5.6 0 0 1 10.7-1.4 3.9 3.9 0 0 1 1.2 9.3H6.6Z"/></svg>',
    model: '<svg class="cbh__icon cbh__icon--model" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><circle cx="12" cy="12" r="2.7" fill="currentColor" stroke="none"/><path d="M12 2.4v3.5M12 18.1v3.5M2.4 12h3.5M18.1 12h3.5M5.2 5.2l2.5 2.5M16.3 16.3l2.5 2.5M18.8 5.2l-2.5 2.5M7.7 16.3l-2.5 2.5"/></svg>',
    cli:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M5 7.5l4 4.5-4 4.5M12.6 16.5h6.2"/></svg>',
    app:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><rect x="3.4" y="4.8" width="17.2" height="14.4" rx="2.2"/><path d="M3.4 9.4h17.2M8.4 9.4v9.8"/></svg>'
  };

  /* --------------------------------------------------------------- yardımcı */
  function el(tag, cls, html) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (html != null) n.innerHTML = html;
    return n;
  }
  function svgEl(tag, attrs) {
    var n = document.createElementNS(SVGNS, tag);
    for (var k in attrs) if (attrs.hasOwnProperty(k)) n.setAttribute(k, attrs[k]);
    return n;
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function assign(a) {
    for (var i = 1; i < arguments.length; i++) {
      var s = arguments[i];
      if (!s) continue;
      for (var k in s) if (s.hasOwnProperty(k)) a[k] = s[k];
    }
    return a;
  }
  function reduceMotion() {
    return !!(global.matchMedia && global.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }
  function wireState(value) {
    return value === 'active' || value === 'installed' ? value : 'absent';
  }
  function strongerWireState(a, b) {
    var rank = { absent: 0, installed: 1, active: 2 };
    return rank[wireState(b)] > rank[wireState(a)] ? wireState(b) : wireState(a);
  }
  function linkParts(link, tools) {
    var model = Array.isArray(link) ? link[0] : link && link.model;
    var tool = Array.isArray(link) ? link[1] : link && link.tool;
    var explicitState = Array.isArray(link) ? link[2] : link && link.state;
    return {
      model: Number(model),
      tool: Number(tool),
      state: wireState(explicitState || (tools[tool] && tools[tool].state) || 'active')
    };
  }

  /* Kablo yolu: yatay çıkış -> S kıvrımı -> yatay giriş.
     Videodaki kablonun merkez hattı piksel piksel çıkarılıp bu formüle
     oturtuldu. Kritik nokta: kıvrımın genişliği YATAY mesafeyle değil,
     DİKEY mesafeyle (|dy|) ölçekleniyor. Yani düz giden kablo neredeyse
     hiç kıvrılmıyor, uzağa giden kablo pinden hemen ayrılıyor. Kıvrımı
     span'in yüzdesiyle kursanız videodaki demet görünümü kaybolur. */
  function wirePath(a, b, o) {
    var ax = a.x + o.leadOut, bx = b.x - o.leadIn;
    var span = bx - ax;
    var k = Math.min(Math.abs(span) * 0.5,
                     Math.max(o.bendMin, Math.abs(b.y - a.y) * o.bendRatio));
    function n(v) { return Math.round(v * 100) / 100; }
    return 'M ' + n(a.x) + ' ' + n(a.y) +
           ' L ' + n(ax) + ' ' + n(a.y) +
           ' C ' + n(ax + k) + ' ' + n(a.y) + ', ' + n(bx - k) + ' ' + n(b.y) +
                 ', ' + n(bx) + ' ' + n(b.y) +
           ' L ' + n(b.x) + ' ' + n(b.y);
  }

  /* ===================================================================== */
  function CiziBaglantiHaritasi(root, options) {
    if (!root) throw new Error('CiziBaglantiHaritasi: kök element gerekli.');
    this.root = root;
    this.o = assign({}, OPTS, options);
    this.data = assign({}, DEFAULT_DATA, this.o.data);
    this.t = assign({}, DEFAULT_TIMELINE, this.o.timeline);

    this._timers = [];
    this._anims = [];
    this._edges = [];
    this._pins = { provider: [], modelIn: [], modelOut: [], toolIn: [] };
    this._settled = false;

    this._build();
    this._observe();

    var self = this;
    requestAnimationFrame(function () {
      self.layout();
      if (self.o.autoplay) self.play();
    });
  }

  /* ------------------------------------------------------------ DOM kurulum */
  CiziBaglantiHaritasi.prototype._build = function () {
    var d = this.data, i;
    this.root.classList.add('cbh');
    this.root.setAttribute('data-energy', d.energyEnabled === false ? 'off' : 'on');
    if (this.o.perf === 'low') this.root.setAttribute('data-perf', 'low');
    this.root.innerHTML = '';

    // başlık
    var head = el('div', 'cbh__head');
    head.appendChild(el('h3', 'cbh__title', 'Aktif Bağlantı Haritası'));
    head.appendChild(el('span', 'cbh__help', '?'));
    this.root.appendChild(head);

    // sahne
    var stage = el('div', 'cbh__stage');
    this.stage = stage;

    this.wiresSvg = svgEl('svg', { class: 'cbh__wires', 'aria-hidden': 'true' });
    this.gGlow  = svgEl('g', {});
    this.gCore  = svgEl('g', {});
    this.gPulse = svgEl('g', {});
    this.wiresSvg.appendChild(this.gGlow);
    this.wiresSvg.appendChild(this.gCore);
    this.wiresSvg.appendChild(this.gPulse);

    this.pinsSvg = svgEl('svg', { class: 'cbh__pins', 'aria-hidden': 'true' });
    this.gPins = svgEl('g', {});
    this.pinsSvg.appendChild(this.gPins);

    this.bloom = el('div', 'cbh__bloom');

    stage.appendChild(this.wiresSvg);
    stage.appendChild(this.bloom);
    stage.appendChild(this.pinsSvg);

    stage.appendChild(el('span', 'cbh__coltitle cbh__coltitle--provider', 'Provider'));
    stage.appendChild(el('span', 'cbh__coltitle cbh__coltitle--models', 'Modeller'));
    stage.appendChild(el('span', 'cbh__coltitle cbh__coltitle--tools', 'Araçlar'));

    // provider kolonu
    var colP = el('div', 'cbh__col cbh__col--provider');
    this.providerCard = el('div', 'cbh__card cbh__card--provider');
    this.providerCard.innerHTML =
      (ICONS[d.provider.icon] || ICONS.cloud) +
      '<span class="cbh__pname">' + esc(d.provider.name) + '</span>' +
      '<span class="cbh__status"><i class="cbh__dot"></i>' + esc(d.provider.status) + '</span>' +
      '<span class="cbh__sheen"></span>';
    colP.appendChild(this.providerCard);
    stage.appendChild(colP);

    // model kolonu
    var colM = el('div', 'cbh__col cbh__col--models');
    this.ghostM = el('div', 'cbh__ghost');
    colM.appendChild(this.ghostM);
    this.modelCards = [];
    for (i = 0; i < d.models.length; i++) {
      var m = d.models[i];
      var mc = el('div', 'cbh__card cbh__card--model');
      mc.innerHTML =
        ICONS.model +
        '<span class="cbh__mname">' + esc(m.name) + '</span>' +
        '<span class="cbh__meta"><i class="cbh__dot"></i>' + esc(m.meta || '') + '</span>';
      colM.appendChild(mc);
      this.modelCards.push(mc);
    }
    stage.appendChild(colM);

    // araç kolonu
    var colT = el('div', 'cbh__col cbh__col--tools');
    this.ghostT = el('div', 'cbh__ghost');
    colT.appendChild(this.ghostT);
    this.toolCards = [];
    for (i = 0; i < d.tools.length; i++) {
      var t = d.tools[i];
      var tc = el('div', 'cbh__card cbh__card--tool is-tool-' + wireState(t.state || 'active'));
      tc.innerHTML =
        '<span class="cbh__ticon">' + (ICONS[t.icon] || ICONS.cli) + '</span>' +
        '<span class="cbh__tname">' + esc(t.name) + '</span>' +
        '<i class="cbh__dot"></i>';
      colT.appendChild(tc);
      this.toolCards.push(tc);
    }
    stage.appendChild(colT);

    this.root.appendChild(stage);
  };

  /* -------------------------------------------------- ölçüm + yol hesabı */
  CiziBaglantiHaritasi.prototype.layout = function () {
    var self = this, o = this.o, d = this.data;
    var sr = this.stage.getBoundingClientRect();
    if (!sr.width) return;

    // viewBox, stage'in CSS boyutuyla birebir olmalı: preserveAspectRatio="none"
    // ile en ufak fark bile kabloları dikeyde kaydırır.
    var W = Math.round(sr.width), H = Math.round(sr.height);
    ['wiresSvg', 'pinsSvg'].forEach(function (k) {
      self[k].setAttribute('viewBox', '0 0 ' + W + ' ' + H);
      self[k].setAttribute('preserveAspectRatio', 'none');
    });

    // Kartlar offset zinciriyle ölçülür, getBoundingClientRect ile DEĞİL.
    //
    // Bunun bedeli yaşanarak öğrenildi: kartlar giriş animasyonu boyunca
    // `translateX(-26px) scale(.93)` durumunda duruyor ve getBoundingClientRect
    // dönüştürülmüş kutuyu veriyor. layout() o sırada çağrıldığında kablolar
    // 300px'lik kartın değil 279px'lik hayaletin kenarına bağlanıyor, kart
    // yerine oturduğunda da orada kalıyordu — uçlar ancak sonradan bir relayout
    // tetiklendiğinde kartlara değiyordu. offsetLeft/offsetWidth dönüşümleri
    // yok sayar, yani kartın nihai yerleşim kutusunu verir.
    var stage = this.stage;
    function box(node) {
      var x = 0, y = 0, el = node;
      while (el && el !== stage) {
        x += el.offsetLeft;
        y += el.offsetTop;
        el = el.offsetParent;
      }
      // Zincir stage'e ulaşmadıysa (araya transform'lu bir ata girmişse)
      // ölçüm anlamsızdır; görsel kutuya düşülür.
      if (!el) {
        var r = node.getBoundingClientRect();
        return {
          left: r.left - sr.left, right: r.right - sr.left,
          top: r.top - sr.top, bottom: r.bottom - sr.top,
          cy: r.top - sr.top + r.height / 2
        };
      }
      var w = node.offsetWidth, h = node.offsetHeight;
      return { left: x, right: x + w, top: y, bottom: y + h, cy: y + h / 2 };
    }

    var pb = box(this.providerCard);
    var mb = this.modelCards.map(box);
    var tb = this.toolCards.map(box);

    // provider sağ kenarında dikey olarak sıkışık pin demeti (videodaki gibi)
    var n = mb.length;
    var outs = [];
    for (var i = 0; i < n; i++) {
      outs.push({ x: pb.right, y: pb.cy + (i - (n - 1) / 2) * o.fanGap });
    }

    this.bloom.style.left = pb.right + 'px';
    this.bloom.style.top  = pb.cy + 'px';

    // Araç durumu sağdaki model -> araç hattını belirler. Soldaki sağlayıcı ->
    // model hattı ise yerel uygulama olmasa da enerji taşır; bu durumda orta
    // parlaklıkta kalır.
    var edges = [];
    var normalizedLinks = (d.links || []).map(function (link) { return linkParts(link, d.tools || []); });
    var modelStates = [];
    for (i = 0; i < n; i++) modelStates.push('absent');
    normalizedLinks.forEach(function (link) {
      if (modelStates[link.model] != null) {
        modelStates[link.model] = strongerWireState(modelStates[link.model], link.state);
      }
    });
    var providerStates = modelStates.map(function (state) {
      return strongerWireState(state, 'installed');
    });
    for (i = 0; i < n; i++) {
      edges.push({
        stage: 'A', i: i, state: providerStates[i],
        a: outs[i], b: { x: mb[i].left, y: mb[i].cy }, target: i
      });
    }
    for (i = 0; i < normalizedLinks.length; i++) {
      var link = normalizedLinks[i], mi = link.model, ti = link.tool;
      if (!mb[mi] || !tb[ti]) continue;
      edges.push({
        stage: 'B', i: i, state: link.state,
        a: { x: mb[mi].right, y: mb[mi].cy },
        b: { x: tb[ti].left,  y: tb[ti].cy },
        source: mi, target: ti
      });
    }

    // DOM'u yeniden kurmak yerine mevcut path'leri güncelle
    var rebuild = this._edges.length !== edges.length;
    if (rebuild) {
      this.gGlow.innerHTML = this.gCore.innerHTML = this.gPulse.innerHTML = '';
      this.gPins.innerHTML = '';
      this._edges = [];
      this._pins = { provider: [], modelIn: [], modelOut: [], toolIn: [] };
    }

    edges.forEach(function (e, idx) {
      var dStr = wirePath(e.a, e.b, o);
      var rec = self._edges[idx];
      if (!rec) {
        rec = {
          glow:  svgEl('path', { class: 'cbh__wire-glow' }),
          core:  svgEl('path', { class: 'cbh__wire-core' }),
          pulse: svgEl('path', { class: 'cbh__wire-pulse' })
        };
        self.gGlow.appendChild(rec.glow);
        self.gCore.appendChild(rec.core);
        self.gPulse.appendChild(rec.pulse);
        self._edges[idx] = rec;
      }
      rec.stage = e.stage; rec.source = e.source; rec.target = e.target;
      rec.state = wireState(e.state);
      rec.energyActive = d.energyEnabled !== false && (rec.stage === 'A' || rec.state === 'active');
      [rec.glow, rec.core, rec.pulse].forEach(function (path) {
        path.classList.remove('is-wire-absent', 'is-wire-installed', 'is-wire-active');
        path.classList.add('is-wire-' + rec.state);
      });
      rec.pulse.classList.toggle('is-energy-active', rec.energyActive);
      rec.glow.setAttribute('d', dStr);
      rec.core.setAttribute('d', dStr);
      rec.pulse.setAttribute('d', dStr);
      rec.len = rec.core.getTotalLength();

      // büyüme için dash kurulumu
      [rec.glow, rec.core].forEach(function (p) {
        p.style.strokeDasharray = rec.len + ' ' + rec.len;
        if (!self._settled && !rec.grown) p.style.strokeDashoffset = rec.len;
      });
    });

    if (rebuild) {
      // pinler
      outs.forEach(function (p, k) { self._pins.provider.push(self._pin(p, providerStates[k])); });
      mb.forEach(function (b, k) {
        self._pins.modelIn.push(self._pin({ x: b.left, y: b.cy }, providerStates[k]));
        var used = normalizedLinks.some(function (l) { return l.model === k; });
        self._pins.modelOut.push(used ? self._pin({ x: b.right, y: b.cy }, modelStates[k]) : null);
      });
      tb.forEach(function (b, k) {
        self._pins.toolIn.push(self._pin({ x: b.left, y: b.cy }, wireState((d.tools[k] || {}).state || 'active')));
      });
    } else {
      this._pins.provider.forEach(function (c, k) { self._move(c, outs[k]); });
      mb.forEach(function (b, k) {
        self._move(self._pins.modelIn[k], { x: b.left, y: b.cy });
        if (self._pins.modelOut[k]) self._move(self._pins.modelOut[k], { x: b.right, y: b.cy });
      });
      tb.forEach(function (b, k) { self._move(self._pins.toolIn[k], { x: b.left, y: b.cy }); });
    }

    if (this._settled) this._startPulses();
    return this;
  };

  CiziBaglantiHaritasi.prototype._pin = function (p, state) {
    var c = svgEl('circle', { class: 'cbh__pin', cx: p.x, cy: p.y, r: 2.9 });
    if (state) c.classList.add('is-wire-' + wireState(state));
    if (this._settled) c.style.opacity = '1';
    this.gPins.appendChild(c);
    return c;
  };
  CiziBaglantiHaritasi.prototype._move = function (c, p) {
    if (!c) return;
    c.setAttribute('cx', p.x);
    c.setAttribute('cy', p.y);
  };

  /* ------------------------------------------------------------- timeline */
  CiziBaglantiHaritasi.prototype._at = function (ms, fn) {
    this._timers.push(setTimeout(fn, Math.max(0, ms / this.o.speed)));
  };
  CiziBaglantiHaritasi.prototype._clear = function () {
    this._timers.forEach(clearTimeout);
    this._timers = [];
    this._anims.forEach(function (a) { try { a.cancel(); } catch (e) {} });
    this._anims = [];
  };

  CiziBaglantiHaritasi.prototype.play = function () {
    var self = this, t = this.t, sp = this.o.speed;
    this._clear();
    this.reset();

    if (reduceMotion()) { this.settle(); return this; }

    var A = this._edges.filter(function (e) { return e.stage === 'A'; });
    var B = this._edges.filter(function (e) { return e.stage === 'B'; });

    /* 1) provider kartı ortadan büyüyerek gelir + ışık süpürmesi */
    this._at(t.providerIn, function () {
      self.providerCard.style.setProperty('--in-dur', (t.providerDur / sp) + 'ms');
      self.providerCard.classList.add('is-in');
    });
    this._at(t.providerIn + t.sheen, function () { self.providerCard.classList.add('is-sheen'); });

    /* 2) provider pinleri belirir */
    this._pins.provider.forEach(function (c, i) {
      self._at(t.providerPins + i * t.providerPinsStagger, function () { self._pop(c); });
    });

    /* 3) provider -> model kabloları uzar */
    A.forEach(function (e, i) {
      var start = t.wireA + i * t.wireAStagger;
      self._at(start, function () { self._grow(e, t.wireADur); });
      self._at(start + t.wireADur, function () {
        self._pop(self._pins.modelIn[e.target]);
        self._flash(self.modelCards[e.target]);
      });
    });
    this._at(t.wireA + 250, function () { self.ghostM.classList.add('is-out'); });

    /* 4) kablolar inerken model kartları kayarak girer */
    this.modelCards.forEach(function (c, i) {
      self._at(t.modelIn + i * t.modelStagger, function () {
        c.style.setProperty('--in-dur', (t.modelDur / sp) + 'ms');
        c.classList.add('is-in');
      });
    });

    /* 5) model -> araç kabloları (çaprazlamalar burada oluşur) */
    B.forEach(function (e, i) {
      var start = t.wireB + i * t.wireBStagger;
      self._at(start, function () {
        self._pop(self._pins.modelOut[e.source]);
        self._grow(e, t.wireBDur);
      });
      self._at(start + t.wireBDur, function () {
        self._pop(self._pins.toolIn[e.target]);
        self._flash(self.toolCards[e.target]);
      });
    });
    this._at(t.wireB + 250, function () { self.ghostT.classList.add('is-out'); });

    /* 6) araç kartları: önce boş çerçeve... */
    this.toolCards.forEach(function (c, i) {
      self._at(t.toolFrame + i * t.toolFrameStagger, function () {
        c.style.setProperty('--in-dur', (t.toolFrameDur / sp) + 'ms');
        c.classList.add('is-in');
      });
      /* 7) ...sonra ikon + etiket doluşur */
      self._at(t.toolFill + i * t.toolFillStagger, function () {
        c.style.setProperty('--fill-dur', (t.toolFillDur / sp) + 'ms');
        c.classList.add('is-filled');
      });
    });

    /* 8) yerleşme: sıcak kablolar sönüp sürekli enerji akışına geçer */
    this._at(t.settle, function () { self.settle(); });
    return this;
  };

  /* kabloyu uzat (dash offset) */
  CiziBaglantiHaritasi.prototype._grow = function (e, dur) {
    var self = this, d = dur / this.o.speed;
    e.grown = true;
    if (e.state === 'active') {
      e.core.classList.add('is-hot');
      e.glow.classList.add('is-hot');
    }
    [e.core, e.glow].forEach(function (p) {
      var a = p.animate(
        [{ strokeDashoffset: e.len }, { strokeDashoffset: 0 }],
        { duration: d, easing: 'cubic-bezier(.33,.05,.25,1)', fill: 'both' }
      );
      self._anims.push(a);
      a.finished.then(function () { p.style.strokeDashoffset = '0'; }).catch(function () {});
    });
  };

  CiziBaglantiHaritasi.prototype._pop = function (c) {
    if (!c) return;
    var a = c.animate(
      [{ opacity: 0, r: 0.5 }, { opacity: 1, r: 4.6, offset: .55 }, { opacity: 1, r: 2.9 }],
      { duration: 420 / this.o.speed, easing: 'cubic-bezier(.16,1,.3,1)', fill: 'both' }
    );
    this._anims.push(a);
  };

  CiziBaglantiHaritasi.prototype._flash = function (card) {
    if (!card) return;
    card.classList.add('is-flash');
    this._at(520 * this.o.speed, function () { card.classList.remove('is-flash'); });
  };

  /* -------------------------------------------------- sürekli enerji akışı */
  CiziBaglantiHaritasi.prototype._startPulses = function () {
    var self = this, o = this.o;
    this._edges.forEach(function (e, i) {
      if (!e.energyActive) {
        if (e._pulseAnim) {
          try { e._pulseAnim.cancel(); } catch (_) {}
          e._pulseAnim = null;
        }
        return;
      }
      // ResizeObserver ve son yerleşim ölçümü bu metodu tekrar çağırabilir.
      // Çalışan akışı iptal edip yeniden başlatmak parçayı geriye sıçratıyordu.
      if (e._pulseAnim) return;
      var dash = o.pulseLength;
      e.pulse.style.strokeDasharray = dash + ' ' + e.len;
      // Pozitif offset parçayı yolun tamamen soluna, görünmeyen bölgeye koyar.
      // Gecikme boyunca da bu ilk kare korunur; böylece kablonun ortasında bir
      // an görünüp geriye kaçmaz, kaynaktan doğal biçimde içeri girer.
      e.pulse.style.strokeDashoffset = dash;
      var dur = (e.len + dash) / o.pulseSpeed * 1000;
      var a = e.pulse.animate(
        [{ strokeDashoffset: dash }, { strokeDashoffset: -e.len }],
        {
          duration: dur,
          iterations: Infinity,
          easing: 'linear',
          fill: 'both',
          // Kayma POZİTİF: her parça kablonun başından doğar.
          //
          // Negatif gecikme animasyonu ortasından başlatıyordu; kablolar
          // bağlandığı anda ışık kabloların ortasında beliriyor, "enerji zaten
          // akıyordu da biz görmüyorduk" izlenimi veriyordu. Akış artık
          // kaynaktan başlar; A demeti önce, B demeti hemen arkasından.
          delay: (e.stage === 'A' ? 0 : 220) + i * 140
        }
      );
      e._pulseAnim = a;
      self._anims.push(a);
    });
  };

  /* ------------------------------------------------------------- durumlar */
  /** Animasyonu bitmiş hâle sabitler (reduced-motion veya "atla" için). */
  CiziBaglantiHaritasi.prototype.settle = function () {
    var self = this;
    this._settled = true;
    this.providerCard.classList.add('is-in');
    this.ghostM.classList.add('is-out');
    this.ghostT.classList.add('is-out');
    this.modelCards.forEach(function (c) { c.classList.add('is-in'); });
    this.toolCards.forEach(function (c) { c.classList.add('is-in', 'is-filled'); });

    this._edges.forEach(function (e) {
      e.grown = true;
      e.core.classList.remove('is-hot');
      e.glow.classList.remove('is-hot');
      e.core.style.strokeDashoffset = '0';
      e.glow.style.strokeDashoffset = '0';
    });
    ['provider', 'modelIn', 'modelOut', 'toolIn'].forEach(function (k) {
      self._pins[k].forEach(function (c) { if (c) c.style.opacity = '1'; });
    });

    // Pulse geometrisi görünürlük açılmadan hazırlanır. Aynı karede önce bütün
    // parçaların belirmesi, sonra başlangıca sıçraması böylece mümkün olmaz.
    this._startPulses();
    this.root.classList.add('cbh--settled');
    this.root.dispatchEvent(new CustomEvent('cbh:settled', { bubbles: true }));
    return this;
  };

  /** Devam eden giriş koreografisini kesip tek karede son duruma geçer. */
  CiziBaglantiHaritasi.prototype.finish = function () {
    if (this._settled) return this;
    this._clear();
    this._edges.forEach(function (e) { e._pulseAnim = null; });
    return this.settle();
  };

  /** Her şeyi başlangıç (boş) hâline döndürür. */
  CiziBaglantiHaritasi.prototype.reset = function () {
    var self = this;
    this._settled = false;
    this.root.classList.remove('cbh--settled');
    this.providerCard.classList.remove('is-in', 'is-sheen');
    this.ghostM.classList.remove('is-out');
    this.ghostT.classList.remove('is-out');
    this.modelCards.forEach(function (c) { c.classList.remove('is-in', 'is-flash'); });
    this.toolCards.forEach(function (c) { c.classList.remove('is-in', 'is-filled', 'is-flash'); });

    this._edges.forEach(function (e) {
      e.grown = false;
      e.core.classList.remove('is-hot');
      e.glow.classList.remove('is-hot');
      e.core.style.strokeDashoffset = e.len;
      e.glow.style.strokeDashoffset = e.len;
      if (e._pulseAnim) { try { e._pulseAnim.cancel(); } catch (err) {} e._pulseAnim = null; }
    });
    ['provider', 'modelIn', 'modelOut', 'toolIn'].forEach(function (k) {
      self._pins[k].forEach(function (c) { if (c) c.style.opacity = '0'; });
    });
    return this;
  };

  CiziBaglantiHaritasi.prototype.replay = function () {
    this._clear();
    this.layout();
    return this.play();
  };

  /** Canlı veri: setData çağrısı haritayı yeniden kurar. */
  CiziBaglantiHaritasi.prototype.setData = function (data, opts) {
    this.data = assign({}, DEFAULT_DATA, data);
    this._clear();
    this._edges = [];
    this._build();
    var self = this, replay = !opts || opts.replay !== false;
    requestAnimationFrame(function () {
      self.layout();
      if (replay) self.play(); else self.settle();
    });
    return this;
  };

  CiziBaglantiHaritasi.prototype._observe = function () {
    var self = this, raf = 0;
    if (typeof ResizeObserver === 'undefined') return;
    this._ro = new ResizeObserver(function () {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(function () { self.layout(); });
    });
    this._ro.observe(this.root);
  };

  CiziBaglantiHaritasi.prototype.destroy = function () {
    this._clear();
    if (this._ro) this._ro.disconnect();
    this.root.classList.remove('cbh', 'cbh--settled');
    this.root.innerHTML = '';
    return null;
  };

  CiziBaglantiHaritasi.DEFAULT_DATA = DEFAULT_DATA;
  CiziBaglantiHaritasi.DEFAULT_TIMELINE = DEFAULT_TIMELINE;

  global.CiziBaglantiHaritasi = CiziBaglantiHaritasi;
  if (typeof module !== 'undefined' && module.exports) module.exports = CiziBaglantiHaritasi;
})(typeof window !== 'undefined' ? window : this);
