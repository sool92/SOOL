/* =========================================================
   下雨效果 · Canvas
   ---------------------------------------------------------
   真实感来自四层叠加：

   1. 天空雨丝
      远层细而慢、近层粗而快，带横向风偏；
      落到页面底部会溅起一小簇水花。
      **打中卡片后不停下、也不消失，继续往下落** —— 所以雨是整屏均匀的，
      每一块模块都会有自己的雨从空中落到它身上（详见下面"注意"）。

   2. 卡片专属雨
      天空雨丝虽然满屏都在下，但落到某一小块模块上的密度是随机的、
      可能一段时间一滴都没有。所以每张可见模块再单独配一小股正上方的雨
      （卡片越宽给得越多），从卡片上方很高处——常常还在屏幕外——垂直落下。
      这样"雨从空中落到这块模块上"是能明确看见的。

   3. 雨滴打在卡片上（不再涂"水渍"色块）
      一滴雨打中卡片，就在那个位置溅水花，并让水从那儿开始流。
      · 打中上边缘：当场溅水花，水沿上沿向两边铺开
      · 打中正面：溅水花，并在落点凝一颗水珠
      · 打中左右边 / 底边附近：额外补水，顺着边淌
      内部仍维护 wet 网格（水珠滑过湿处会被拖慢），但**不画出来** ——
      低透明度色块在深色卡片上会显成一片脏灰，只能靠水珠本身表达"湿"。

   4. 水珠沿卡片正面往下流（打哪流哪，不是只走边框！）
      每颗水珠盯住卡片上一个固定的"卡片内坐标 (lx, ly)"，
      页面滚动时它仍旧长在卡片的同一处，不会漂。
      下滑像真水珠：起步黏滞 → 逐渐加速 → 被水渍绊住减速 →
      轻微摆动 → 速度把它拉长 → 快时甩下更小的水珠，
      身后留一条由粗到细的拖尾；滑到底边就滴落并溅水花。

   5. 水花
      受重力的细小水点，向两侧抛洒、迅速消失。

   性能：全程单 canvas，无外部依赖；页面切到后台时浏览器
   自动暂停 requestAnimationFrame。纯静态，直接传 GitHub Pages 即可。

   ⚠️ 两条不能改回去的注意事项（都踩过）：
   · 天空雨丝**不要**在打中卡片时回收重生。以前写的是
     `Object.assign(s, newStreak(true))`，雨滴一碰到最上面那张卡片就消失、
     重生到屏幕顶部，于是整个页面只有最顶上那块模块有雨。
   · 每根雨丝/每滴雨**不要**各画各的，要按桶攒成一条路径一次描边
     （详见 1c 和卡片专属雨那段）。手机上每帧的 stroke 次数直接决定流畅度：
     分桶后本效果只要约 360 次/帧，不分组则要 1085 次/帧。
   ========================================================= */
(function () {
  "use strict";
  // 说明：不跟随系统"减少动态效果"设置自动关闭 ——
  // Windows 关闭动画特效时浏览器会上报 prefers-reduced-motion: reduce，
  // 之前因此导致很多用户明明要下雨却看不到。现在始终下雨。

  const canvas = document.getElementById("rain");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;

  // ---- 画布尺寸（跟随窗口，最多 2 倍像素密度，省性能）----
  let W = 0, H = 0;
  function resize() {
    const DPR = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width = Math.round(W * DPR);
    canvas.height = Math.round(H * DPR);
    ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  }
  resize();
  window.addEventListener("resize", resize, { passive: true });

  const rand = (a, b) => a + Math.random() * (b - a);
  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  // ---- 主题色：深色模式下雨丝更亮才看得见 ----
  const darkQuery = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return !!(darkQuery && darkQuery.matches);
  }

  // ---- 卡片 / 圆角参数 ----
  const R = 16;          // 卡片圆角，和 styles.css 里的 --radius 保持一致
  const WET_CELL = 7;    // "湿润度"网格大小（逻辑像素）——只做物理，不绘制
  const WET_MAX = 150;   // 单张卡片最多记多少格（防止内存失控）

  // 判断某点是否落在（带圆角的）卡片可见区域内。
  // 用圆角矩形而不是外接矩形，雨滴才不会打在卡片外面的圆角空白上。
  function insideCard(r, x, y) {
    if (x < r.left || x > r.right || y < r.top || y > r.bottom) return false;
    const rad = Math.min(R, (r.right - r.left) / 2, (r.bottom - r.top) / 2);
    if (rad <= 0) return true;
    let cx, cy;
    if (x < r.left + rad) cx = r.left + rad;
    else if (x > r.right - rad) cx = r.right - rad;
    else return true;
    if (y < r.top + rad) cy = r.top + rad;
    else if (y > r.bottom - rad) cy = r.bottom - rad;
    else return true;
    const dx = x - cx, dy = y - cy;
    return dx * dx + dy * dy <= rad * rad;
  }

  // ---- 一次雨滴的落点命中判定（返回卡片上被击中的位置）----
  // 判据是"这一帧的移动线段有没有穿过卡片"，所以雨再快也不会漏掉。
  function segmentHit(r, x0, y0, x1, y1) {
    if (Math.max(y0, y1) < r.top || Math.min(y0, y1) > r.bottom) return null;
    if (Math.max(x0, x1) < r.left - 1 || Math.min(x0, x1) > r.right + 1) return null;
    let fallback = null;
    for (let t = 0; t <= 1.0001; t += 0.1) {
      const px = x0 + (x1 - x0) * t;
      const py = y0 + (y1 - y0) * t;
      if (insideCard(r, px, py)) {
        const ix = x0 + (x1 - x0) * Math.max(0, t - 0.1);
        const iy = y0 + (y1 - y0) * Math.max(0, t - 0.1);
        // 打中卡片上边缘 —— 最"响"的一击：溅得大、沿上沿铺开
        const top = py < r.top + Math.max(10, r.height * 0.10);
        return { x: px, y: py, ix, iy, top };
      }
      if (!fallback) fallback = { x: px, y: py };
    }
    // 完全落进圆角空白里：退化成"擦着边缘过"，只溅一点点
    if (fallback) {
      return {
        x: fallback.x, y: fallback.y,
        ix: x0 + (x1 - x0) * 0.5, iy: y0 + (y1 - y0) * 0.5,
        top: false,
      };
    }
    return null;
  }

  // ---- 卡片状态：每张卡片记录"有多湿" ----
  const cards = new Map();   // el -> { wet: Map }

  // 卡片离开视野时清掉脏状态，别把水渍算到滚回来的卡片上
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((es) => {
        for (const e of es) {
          const st = cards.get(e.target);
          if (st && !e.isIntersecting) st.wet.clear();
        }
      })
    : null;

  function stateOf(el) {
    let st = cards.get(el);
    if (!st) {
      st = { wet: new Map() };
      cards.set(el, st);
      if (io) io.observe(el);
    }
    return st;
  }

  const wetKey = (gx, gy) => gx + ":" + gy;

  // 在卡片局部坐标处加一块水渍（0~1）。这是"雨滴打在哪、哪就湿"的核心。
  function wetAdd(st, lx, ly, amt) {
    const gx = Math.floor(lx / WET_CELL), gy = Math.floor(ly / WET_CELL);
    const key = wetKey(gx, gy);
    const cur = st.wet.get(key);
    // 水渍块封顶：满了就只刷新已有的块，不再开新块，防内存/绘制爆炸
    if (cur === undefined && st.wet.size >= WET_MAX) return;
    st.wet.set(key, clamp((cur === undefined ? 0 : cur) + amt, 0, 1));
  }

  // 水渍风干。跑得比"下雨"慢，才能看见卡片被打湿的过程；
  // 但也足够快，不至于糊成一片白色。
  function wetDecay(st, dt) {
    for (const [key, v] of st.wet) {
      const nv = v - dt;
      if (nv <= 0.05) st.wet.delete(key);
      else st.wet.set(key, nv);
    }
  }

  // 取落点周围的水渍均值 —— 太湿的地方水珠阻力大、更透明
  function wetnessAround(st, lx, ly) {
    const gx = Math.floor(lx / WET_CELL), gy = Math.floor(ly / WET_CELL);
    let sum = 0;
    for (let i = -1; i <= 1; i++) {
      for (let j = -1; j <= 1; j++) {
        const v = st.wet.get(wetKey(gx + i, gy + j));
        if (v !== undefined) sum += v;
      }
    }
    return sum / 9;
  }

  // 判定雨滴这一帧有没有打中卡片；打中就在落点留水渍。
  // cardsNow 是本帧已经算好的可见卡片数组，避免每滴雨都去查一次 DOM。
  function hitCards(cardsNow, x0, y0, x1, y1) {
    for (const c of cardsNow) {
      const r = c.r;
      const hit = segmentHit(r, x0, y0, x1, y1);
      if (!hit) continue;
      wetAdd(c.st, hit.ix - r.left, hit.iy - r.top, 0.65);
      return { hit, r, el: c.el, st: c.st };
    }
    return null;
  }

  // ---- 天空雨丝 ----
  const streaks = [];
  const STREAK_N = clamp(Math.round(window.innerWidth / 9), 70, 170);
  // 雨丝按"层 + 亮度档"分 4 桶。整桶攒成一条路径、一次 stroke 画完 ——
  // 以前每根雨丝要 2 次 stroke（本体 + 亮头），70 根就是 140 次；
  // 分桶后整屏只要 8 次。这不是省小钱：手机上每帧的 stroke 次数直接决定流畅度。
  const SKY_LVL = [
    { w: 1.1, a: 0.22 },   // 远层 · 暗
    { w: 1.1, a: 0.29 },   // 远层 · 亮
    { w: 1.6, a: 0.41 },   // 近层 · 暗
    { w: 1.6, a: 0.49 },   // 近层 · 亮
  ];
  function newStreak(fromTop) {
    const near = Math.random() < 0.45;   // 近景层更粗、更快、更亮
    const aLo = near ? 0.34 : 0.18, aHi = near ? 0.52 : 0.30;
    const a = rand(aLo, aHi);
    return {
      x: rand(-80, W + 40),
      y: fromTop ? rand(-H * 0.5, -10) : rand(-H, H),
      len: near ? rand(16, 30) : rand(9, 18),
      vy: near ? rand(14, 20) : rand(8, 12),
      vx: rand(-0.2, 0.2),
      lvl: (near ? 2 : 0) + (a > (aLo + aHi) / 2 ? 1 : 0),
      hitEl: null,          // 这一趟已经碰过的卡片（用来避免同一张卡重复触发）
    };
  }
  for (let i = 0; i < STREAK_N; i++) streaks.push(newStreak(false));

  // ---- 水珠：slide = 正在卡片正面往下流；pending = 刚落下的水膜；falling = 已滴落 ----
  const drops = [];
  const MAX_DROPS = 54;
  let DROP_SEQ = 0;

  function newSlideDrop(el, st, lx, ly, power) {
    if (el._rainIdx == null) el._rainIdx = ++DROP_SEQ;   // 给每张卡片一个固定序号
    return {
      kind: "slide", el, st,
      lx, ly,
      r: clamp(0.42 + power * 0.36, 0.50, 1.30),
      len: 2.0 + power * 3,
      vy: 0.20 + power * 0.42,
      phase: Math.random() * Math.PI * 2,
      wob: 0.10 + Math.random() * 0.20,
      stuck: 0,
      alive: 1,
      life: rand(340, 620),
    };
  }

  function newPendingDrop(el, st, lx, ly, life) {
    return { kind: "pending", el, st, lx, ly, r: rand(0.38, 0.78), life, alive: 1 };
  }

  // 卡片上沿被打中：水沿上沿朝溅开的方向散开，随后各自往下淌。
  // 注意：**不要**沿着上沿横向刷一连串水渍格 —— 那些格子会连成一整条
  // 贴着卡片顶边的横带（手机滚动时看得出移位）。改成散几滴"待流水珠"，
  // 让水以"一颗颗往下淌"的方式表现，而不是画一条边。
  function spreadOnTop(el, st, r, hitLx, power) {
    const dir = hitLx < r.width / 2 ? -1 : 1;   // 朝较近的那侧散开
    const n = 2 + ((power * 3) | 0);
    for (let i = 0; i < n; i++) {
      if (drops.length >= MAX_DROPS) break;
      const lx = clamp(hitLx + dir * (i + 1) * rand(9, 22), 3, r.width - 3);
      // 纵向起点错开一点，避免几颗水珠横着排成一条线
      drops.push(newPendingDrop(el, st, lx, rand(1.5, 8), 0.35 + Math.random() * 0.4));
    }
    // 落点附近留一点水渍（只围绕落点，不铺满整个上沿）
    for (let i = 0; i < 3; i++) {
      wetAdd(st, clamp(hitLx + dir * i * WET_CELL, 0, r.width), rand(1, 7), 0.28);
    }
  }

  // ---- 水花：受重力的细水点 ----
  const splashes = [];
  const SPLASH_MAX = 100;        // 总量封顶，低端机 / 手机上也扛得住
  function newSplash(x, y, n, spread, power) {
    for (let i = 0; i < n && splashes.length < SPLASH_MAX; i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      splashes.push({
        x, y,
        vx: dir * rand(0.3, 1.6) * spread,
        vy: rand(-2.9, -0.7) * (0.6 + power),
        r: rand(0.35, 0.9) * (0.7 + power * 0.4),
        life: 1,
        decay: rand(0.075, 0.13),   // 水花很短命，眨眼就没了
      });
    }
  }

  const noise = (x, y) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };

  // ---- 卡片上方的"局部雨"----
  // 天空里的雨丝会到处飘，但落到页面下半部分的卡片上时，往往已经"用掉"了。
  // 所以每张可见卡片自己再维护一股正上方的雨，保证**每张卡片**都有雨打在上面，
  // 而不是只有最顶上那张。这就是"雨滴打到所有卡片模块"的关键。
  const cardRain = [];   // { card, x, y, vy, len }
  // 每张卡片允许的"专属雨滴"数量：要够密，才看得出"雨是从空中落到这块模块上的"。
  // 卡片越宽给得越多。
  function quotaFor(r) {
    return clamp(Math.round(r.width / 110) + 2, 2, 7);
  }
  function countCardRain(card) {
    let n = 0;
    for (const cr of cardRain) if (cr.card === card) n++;
    return n;
  }
  // 在卡片正上方撒一滴雨，让它垂直落到这张卡片上
  function seedCardRain(c, count) {
    const r = c.r;
    for (let i = 0; i < count; i++) {
      cardRain.push({
        card: c,
        x: r.left + rand(4, Math.max(5, r.width - 4)),
        // 从卡片上方**很高**的地方落下（常常还在屏幕外），
        // 这样看着是"雨从空中落到这块模块上"，而不是贴着卡片凭空冒出来
        y: r.top - rand(70, Math.min(H * 0.75, 430)),
        vy: rand(6, 11),
        len: rand(7, 14),
      });
    }
  }

  // 卡片被打中后统一在这里处理（天空雨丝、专属雨都用它）
  function onCardHit(res, power) {
    const { hit, r, el, st } = res;
    if (hit.top) {
      // 打中上沿：溅一大簇，水沿上沿向两边铺开，再从边缘往下淌
      newSplash(hit.x, r.top, 4 + ((power * 3) | 0), 1.35, power);
      spreadOnTop(el, st, r, hit.x - r.left, power);
    } else {
      // 打中正面：溅开 + 在落点凝一颗水珠往下流（打哪流哪）
      newSplash(hit.x, hit.y, 3 + ((power * 3) | 0), 1.15, power);
      if (drops.length < MAX_DROPS) {
        drops.push(newSlideDrop(el, st, hit.x - r.left, hit.y - r.top, power));
      }
    }
    // 打中边缘附近（左右边 / 底边）：额外补一点水，让它沿边淌下去
    const lx = hit.x - r.left, ly = hit.y - r.top;
    const nearL = lx < 10, nearR = lx > r.width - 10;
    const nearB = ly > r.height - 10;
    if ((nearL || nearR || nearB) && drops.length < MAX_DROPS && Math.random() < 0.7) {
      drops.push(newPendingDrop(
        el, st,
        nearL ? rand(0.5, 2.5) : nearR ? r.width - rand(0.5, 2.5) : clamp(lx, 1, r.width - 1),
        nearB ? r.height - rand(0.5, 2.5) : clamp(ly, 0.5, r.height - 0.5),
        0.5 + Math.random() * 0.5
      ));
    }
  }

  let frame = 0;

  function tick() {
    frame++;
    const dark = isDark();
    const sky  = dark ? "170,200,235" : "110,140,170";  // 天空雨丝色
    const edge = dark ? "190,215,245" : "118,148,182";  // 水珠 / 水花 / 水痕色

    ctx.clearRect(0, 0, W, H);

    // 每帧刷新一次卡片几何，滚动 / 缩放都不会错位
    const cardList = [];
    for (const el of document.querySelectorAll(".card")) {
      const r = el.getBoundingClientRect();
      if (r.width < 30 || r.height < 30) continue;
      if (r.bottom < -60 || r.top > H + 60) continue;
      cardList.push({ el, r, st: stateOf(el) });
    }

    // ===== 1. 天空雨丝 =====
    // 先跑物理 + 命中判定，把要画的线段按桶攒进 skyDraw，
    // 循环结束后整桶一次描边（见下面 1c）。每根雨丝 8 个数字：
    // 本体 (x0,y0,x1,y1) + 亮头 (x0,y0,x1,y1)
    ctx.lineCap = "round";
    const skyDraw = [[], [], [], []];
    for (const s of streaks) {
      const x0 = s.x, y0 = s.y - s.len;
      s.vx = clamp(s.vx * 0.94 + 0.012, -0.6, 1.1);   // 风慢慢起来，封顶
      s.x += s.vx;
      s.y += s.vy;

      // 这一帧的移动轨迹有没有打中卡片？打中就照着落点做反应。
      // 关键：打中之后**继续往下落**，不要在这里把雨丝回收。
      // 以前这里是 Object.assign(s, newStreak(true))，等于一滴雨一碰到最上面那张卡片
      // 就消失并重生到屏幕顶部 —— 结果整个页面只有最顶那个模块有雨，
      // 下面的模块只剩"流水"，看不到雨从空中落到它们身上。
      const res = hitCards(cardList, x0, y0, s.x, s.y);
      if (res && s.hitEl !== res.el) {
        s.hitEl = res.el;                              // 同一张卡只触发一次
        onCardHit(res, clamp(s.len / 22, 0.35, 1));
      }

      // 落到页面底部：溅水花、重生
      if (s.y >= H - 3) {
        if (Math.random() < 0.4) newSplash(s.x, H - rand(0, 5), 3, 0.9, 0.35);
        Object.assign(s, newStreak(true));
        continue;
      }

      skyDraw[s.lvl].push(
        s.x - s.vx * (s.len / s.vy) - 0.5, s.y - s.len, s.x, s.y,
        s.x - s.vx * 1.2, s.y - s.len * 0.35, s.x, s.y
      );
    }

    // ===== 1c. 天空雨丝：分桶成路径，一次画完 =====
    for (let lvl = 0; lvl < 4; lvl++) {
      const arr = skyDraw[lvl];
      if (!arr.length) continue;
      const meta = SKY_LVL[lvl];
      // 本体
      ctx.strokeStyle = `rgba(${sky},${meta.a})`;
      ctx.lineWidth = meta.w;
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 8) {
        ctx.moveTo(arr[i], arr[i + 1]);
        ctx.lineTo(arr[i + 2], arr[i + 3]);
      }
      ctx.stroke();
      // 亮头：更短更亮的一小段，模拟反光
      ctx.strokeStyle = `rgba(${sky},${meta.a * 0.9})`;
      ctx.lineWidth = meta.w * 0.7;
      ctx.beginPath();
      for (let i = 0; i < arr.length; i += 8) {
        ctx.moveTo(arr[i + 4], arr[i + 5]);
        ctx.lineTo(arr[i + 6], arr[i + 7]);
      }
      ctx.stroke();
    }

    // ===== 1b. 卡片专属的雨（保证每张卡片都被雨打到）=====
    // 先补齐配额：每张可见卡片都要有几滴雨正在朝它落
    for (const c of cardList) {
      const have = countCardRain(c);
      const q = quotaFor(c.r);
      if (have < q && cardRain.length < 120) seedCardRain(c, q - have);
    }
    // 卡片滚出视野就当它的雨掉没了
    for (let i = cardRain.length - 1; i >= 0; i--) {
      const r = cardRain[i].card.r;
      if (r.bottom < -30 || r.top > H + 30) cardRain.splice(i, 1);
    }
    // 同样攒进一条路径一次画完（每滴 4 个数字：x, y-top, x, y）
    const crDraw = [];
    for (let i = cardRain.length - 1; i >= 0; i--) {
      const cr = cardRain[i];
      const r = cr.card.r;
      const y0 = cr.y - cr.len;
      cr.y += cr.vy;
      const x0 = cr.x;

      // 打中这张卡片了吗（只判它自己的卡片）
      const hit = segmentHit(r, x0, y0, cr.x, cr.y);
      if (hit) {
        const power = clamp(cr.len / 16, 0.4, 1);
        wetAdd(cr.card.st, hit.ix - r.left, hit.iy - r.top, 0.65);
        onCardHit({ hit, r, el: cr.card.el, st: cr.card.st }, power);
        cardRain.splice(i, 1);
        continue;
      }
      // 落过头了（卡片已被打湿 / 计数对不上）就回收
      if (cr.y > r.top + r.height + 20 || cr.y > H + 20) {
        cardRain.splice(i, 1);
        continue;
      }
      crDraw.push(cr.x, cr.y - cr.len, cr.x, cr.y);
    }
    if (crDraw.length) {
      ctx.strokeStyle = `rgba(${sky},0.32)`;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      for (let i = 0; i < crDraw.length; i += 4) {
        ctx.moveTo(crDraw[i], crDraw[i + 1]);
        ctx.lineTo(crDraw[i + 2], crDraw[i + 3]);
      }
      ctx.stroke();
    }

    // ===== 2. 卡片上的水渍：只参与物理，**不绘制任何像素** =====
    // ⚠️ 这一层以前是画出来的，现在故意什么都不画。原因记在这里，别再改回去：
    //   · 水渍是一层低透明度的浅色斑。深色模式下卡片底色很暗，
    //     浅色低透明度叠加后就是灰的 —— 在手机窄屏上看着就是
    //     "卡片上一片片断断续续的灰色横线"。
    //   · 画成按行合并的 fillRect（高 4.9px / 宽最多 42px / 行距 7px）时最明显，
    //     是一道道虚线；改成圆斑后不成为直线了，但整块灰斑依然在，
    //     在深色底上照样显脏。
    //   · 结论：卡片"湿不湿"不该靠一层平的色块表达。
    //     真正的水珠 + 拖尾 + 水花已经足够，雨滴直接打在卡片上更干净也更真实。
    // wet 网格**保留**，因为水珠滑过湿处会被拖慢（真实流动感靠它），
    // 它只是不再产生任何画面。
    for (const c of cardList) {
      if (c.st.wet.size) wetDecay(c.st, 0.0075);   // 慢慢风干，顺带回收格子
    }
    // 注意：也**不要**再给卡片顶端画一条"积水面"。那是一条贴着卡片上沿的
    // 横向细线；canvas 是 fixed 浮层，手机滚动时和卡片不同帧上屏，
    // 看起来就是这条线在卡片上滑动。

    // ===== 3a. 滴落到卡片下方、还没落地的小水点 =====
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      if (d.kind !== "falling") continue;
      d.vy += 0.16;
      d.x += d.vx;
      d.y += d.vy;
      d.life -= 0.028;
      if (d.life <= 0 || d.y > H) { drops.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(${edge},${0.55 * d.life})`;
      ctx.beginPath();
      ctx.ellipse(d.x, d.y, d.r * 0.8, d.r * 1.3, 0, 0, Math.PI * 2);
      ctx.fill();
    }

    // ===== 3b. 挂在卡片上 / 正沿卡片正面往下流的水珠 =====
    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      if (d.kind === "falling") continue;
      const el = d.el;

      // 元素被删掉 / 卡片滚出屏幕：水珠直接消失
      if (!el || !el.isConnected) { drops.splice(i, 1); continue; }
      const r = el.getBoundingClientRect();
      if (r.width < 10 || r.height < 10) { drops.splice(i, 1); continue; }
      if (r.bottom < -20 || r.top > H + 20) { drops.splice(i, 1); continue; }

      const sx = r.left + clamp(d.lx, 0, r.width);
      const sy = r.top + clamp(d.ly, 0, r.height);

      if (d.kind === "pending") {
        // 刚落下的水膜：扁扁一小片，停一会儿再变成会流动的水珠
        d.life -= 0.012;
        if (d.life <= 0) { drops.splice(i, 1); continue; }
        ctx.fillStyle = `rgba(${edge},${0.42 * d.alive})`;
        ctx.beginPath();
        ctx.ellipse(sx, sy, d.r * 1.2, d.r * 0.8, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = `rgba(${sky},${0.30 * d.alive})`;
        ctx.lineWidth = 0.6;
        ctx.beginPath();
        ctx.ellipse(sx, sy, d.r * 1.2, d.r * 0.8, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.fillStyle = `rgba(255,255,255,${0.6 * d.alive})`;
        ctx.beginPath();
        ctx.arc(sx - d.r * 0.32, sy - d.r * 0.26, d.r * 0.32, 0, Math.PI * 2);
        ctx.fill();
        // 攒够水了就开流
        if (Math.random() < 0.05) {
          drops[i] = newSlideDrop(el, d.st, d.lx, d.ly, clamp(d.r / 1.5, 0.25, 0.75));
        }
        continue;
      }

      // ---- 正在往下流 ----
      d.life -= 0.55 + d.r * 0.5;                 // 一路会风干，太小就没了
      if (d.life <= 0) { drops.splice(i, 1); continue; }

      const rad = Math.min(R, r.width / 2, r.height / 2);
      // 圆角处：沿弧面滑走，别贴着圆角外的空白往下流
      if (d.ly > r.height - rad && d.lx < rad) {
        const dx = d.lx - rad, dy = d.ly - (r.height - rad);
        const dist = Math.hypot(dx, dy) || 1;
        if (dist > rad * 0.99) {
          d.lx = rad + (dx / dist) * rad * 0.99;
          d.ly = (r.height - rad) + (dy / dist) * rad * 0.99;
        }
      }

      // 水渍太厚 -> 阻力大，滑得慢（看着像被水膜绊住）
      const wetness = wetnessAround(d.st, d.lx, d.ly);
      const drag = clamp(1 - wetness * 0.65, 0.3, 1);
      // 真实的水在玻璃上是"先黏着、再一点点加速"：
      // 加速度随速度衰减，所以起步慢（挂住感）、后段快（滑下来）
      const accel = 0.034 * drag * clamp(1 - d.vy / 2.2, 0.18, 1);
      d.vy = clamp(d.vy + accel, 0, 2.2);
      d.phase += 0.040 + d.vy * 0.018;
      d.stuck = Math.max(0, d.stuck - 1);

      // 不均匀的粘连：偶尔停一下再走，水珠才像真在玻璃上爬
      if (d.stuck === 0) {
        const n = noise(d.lx * 0.12, d.ly * 0.12);
        if (n > 0.962 && d.vy < 1.0) d.stuck = 5 + ((n * 24) | 0);
      }

      const moved = d.stuck ? 0 : d.vy * drag;
      d.ly += moved;
      d.alive = clamp(1 - wetness * 0.42, 0.3, 1); // 水膜里的小珠更透明

      // 左右摆动（贴着表面流时的轻微摇晃）—— 滑得越快摆得越小
      const wobScale = clamp(1 - d.vy / 2.4, 0.25, 1);
      d.lx += Math.sin(d.phase) * d.wob * wobScale * (moved > 0 ? 1 : 0.25);
      d.lx = clamp(d.lx, 0.5, r.width - 0.5);

      // 水珠会被拉长（速度越快越细长），也会长大一点，都有上限
      d.r = clamp(d.r + moved * 0.003, 0.40, 1.45);
      d.len = clamp(d.len + moved * 0.045, 2.0, 7);

      const x = r.left + d.lx;
      const y = r.top + d.ly;

      // ---- 水痕：身后一条拖尾 ----
      // 真实感来自"越靠近水珠越粗越亮，越往上越细越淡"，
      // 所以用几段递减的描边叠出来，而不是一条均匀的线。
      const trail = d.len;
      const segs = 4;
      for (let k = 0; k < segs; k++) {
        const f0 = k / segs, f1 = (k + 1) / segs;
        ctx.strokeStyle = `rgba(${edge},${(0.06 + f1 * 0.16) * d.alive})`;
        ctx.lineWidth = 0.3 + f1 * 0.72;
        ctx.beginPath();
        ctx.moveTo(x, y - trail * (1 - f0));
        ctx.lineTo(x, y - trail * (1 - f1));
        ctx.stroke();
      }

      // 水珠本体：被速度拉长的水滴形。
      // 白色卡片上需要一点深色轮廓，否则水珠会"糊"进背景里看不见。
      const stretch = 1.15 + Math.min(0.85, d.vy * 0.28);   // 越快越细长
      const rx = d.r * (1 / Math.sqrt(stretch));            // 体积守恒：拉长就变细
      const ry = d.r * stretch;
      ctx.fillStyle = `rgba(${edge},${0.50 * d.alive})`;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      // 外圈：一点点更深的边，把水珠从卡片底色里"抠"出来
      ctx.strokeStyle = `rgba(${sky},${0.42 * d.alive})`;
      ctx.lineWidth = 0.6;
      ctx.beginPath();
      ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      // 高光点：让水珠有体积感（偏左上）
      ctx.fillStyle = `rgba(255,255,255,${0.85 * d.alive})`;
      ctx.beginPath();
      ctx.arc(x - rx * 0.34, y - ry * 0.42, Math.max(0.22, d.r * 0.24), 0, Math.PI * 2);
      ctx.fill();
      // 水珠底部若积了一点水，画一个小小的下垂鼓起（"要滴不滴"的样子）
      if (d.vy > 1.5 && d.r > 0.75) {
        ctx.fillStyle = `rgba(${edge},${0.34 * d.alive})`;
        ctx.beginPath();
        ctx.ellipse(x, y + ry * 0.95, rx * 0.6, rx * 0.9, 0, 0, Math.PI * 2);
        ctx.fill();
      }

      // 滑得快时，会在身后"甩"下更小的水珠（真实玻璃上的水就是这样一串串的）
      if (d.vy > 1.4 && d.r > 0.85 && Math.random() < 0.04 && drops.length < MAX_DROPS) {
        drops.push({
          kind: "slide", el, st: d.st,
          lx: clamp(d.lx + rand(-1.2, 1.2), 0.5, r.width - 0.5),
          ly: clamp(d.ly - rand(6, 20), 0.5, r.height - 0.5),
          r: d.r * rand(0.35, 0.55),
          len: 2,
          vy: rand(0.1, 0.35),
          phase: Math.random() * Math.PI * 2,
          wob: 0.08 + Math.random() * 0.14,
          stuck: 0,
          alive: 1,
          life: rand(120, 260),
        });
      }

      // 滑到卡片底边：滴落 + 水花
      if (d.ly >= r.height - 1) {
        const fx = r.left + d.lx;
        const fy = Math.min(r.bottom, H - 2);
        newSplash(fx, fy, 2 + ((d.r * 1.6) | 0), 0.9, clamp(d.r / 2.6, 0.3, 1));
        // 掉下去的水还能再落一小段，形成"滴落"的尾巴
        if (drops.length < MAX_DROPS) {
          drops.push({
            kind: "falling", x: fx, y: fy,
            vx: Math.sin(d.phase) * 0.28, vy: 0.4 + d.vy * 0.5,
            r: d.r * 0.85, life: 1, alive: 1,
          });
        }
        drops.splice(i, 1);
      }
    }

    // 让卡片上"一直有水在流"：在还没湿透的地方稀疏地凝出水珠
    if (frame % 12 === 0 && drops.length < MAX_DROPS - 8 && cardList.length) {
      const c = cardList[(Math.random() * cardList.length) | 0];
      const r = c.r;
      if (Math.random() < 0.75) {
        // 落在卡片正面（上半部分居多），打哪流哪
        drops.push(newSlideDrop(
          c.el, c.st,
          rand(6, Math.max(7, r.width - 6)),
          rand(3, Math.max(4, r.height * 0.35)),
          rand(0.3, 0.85)
        ));
      } else {
        // 或者从卡片上沿凝出，沿边缘往下淌
        drops.push(newPendingDrop(
          c.el, c.st,
          rand(4, Math.max(5, r.width - 4)),
          rand(0.5, 3),
          rand(0.4, 0.9)
        ));
      }
    }

    // ===== 4. 水花 =====
    // 一次性把同透明度的水花攒进一条路径里画，省掉大量 fill 调用
    if (splashes.length) {
      ctx.fillStyle = `rgba(${edge},0.5)`;
      ctx.beginPath();
      for (let i = splashes.length - 1; i >= 0; i--) {
        const p = splashes[i];
        p.vy += 0.13;                     // 水花也受重力
        p.x += p.vx;
        p.y += p.vy;
        p.life -= p.decay;
        if (p.life <= 0) { splashes.splice(i, 1); continue; }
        ctx.moveTo(p.x + p.r, p.y);
        ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      }
      ctx.fill();
    }
    requestAnimationFrame(tick);
  }

  requestAnimationFrame(tick);
})();
