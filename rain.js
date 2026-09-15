/* =========================================================
   下雨效果 · Canvas
   ---------------------------------------------------------
   真实感来自四层叠加：

   1. 天空雨丝
      远层细而慢、近层粗而快，带横向风偏；
      落到页面底部会溅起一小簇水花。

   2. 雨滴打在页面卡片上
      卡片会"变湿"——一滴雨打中卡片，就在那个位置形成一小块
      水渍（wet 值升高、慢慢风干）。所以雨滴打在哪，哪儿就湿。
      · 打中卡片上边缘：当场溅起水花，并沿着上沿向两边铺开
      · 打中卡片正面：溅起水花，并在落点凝成一颗水珠

   3. 水珠沿着卡片正面往下流（不是只走边框！）
      每颗水珠盯住卡片上一个固定的"卡片内坐标 (lx, ly)"，
      这样页面滚动时它仍旧长在卡片的同一处，不会漂。
      下滑过程有重力加速、偶尔被水渍"绊住"减速、轻微左右摆动，
      身后留一条水痕；滑到底边就滴落并溅水花。

   4. 水花
      受重力的细小水点，向两侧抛洒、迅速消失。

   性能：全程单 canvas，无外部依赖；页面切到后台时浏览器
   自动暂停 requestAnimationFrame。纯静态，直接传 GitHub Pages 即可。
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
  const WET_CELL = 7;    // 水渍网格大小（逻辑像素）
  const WET_MAX = 150;   // 单张卡片最多记多少块水渍（防止绘制/内存失控）

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

  // ---- 卡片状态：每张卡片记录"有多湿"和"上沿积了多少水" ----
  const cards = new Map();   // el -> { wet: Map, edge: number }

  // 卡片离开视野时清掉脏状态，别把水渍算到滚回来的卡片上
  const io = typeof IntersectionObserver === "function"
    ? new IntersectionObserver((es) => {
        for (const e of es) {
          const st = cards.get(e.target);
          if (st && !e.isIntersecting) { st.wet.clear(); st.edge = 0; }
        }
      })
    : null;

  function stateOf(el) {
    let st = cards.get(el);
    if (!st) {
      st = { wet: new Map(), edge: 0 };
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
  function newStreak(fromTop) {
    const near = Math.random() < 0.45;   // 近景层更粗、更快、更亮
    return {
      x: rand(-80, W + 40),
      y: fromTop ? rand(-H * 0.5, -10) : rand(-H, H),
      len: near ? rand(16, 30) : rand(9, 18),
      vy: near ? rand(14, 20) : rand(8, 12),
      vx: rand(-0.2, 0.2),
      w: near ? 1.6 : 1.1,
      a: near ? rand(0.34, 0.52) : rand(0.18, 0.30),
    };
  }
  for (let i = 0; i < STREAK_N; i++) streaks.push(newStreak(false));

  // ---- 水珠：slide = 正在卡片正面往下流；pending = 刚落下的水膜；falling = 已滴落 ----
  const drops = [];
  const MAX_DROPS = 46;
  let DROP_SEQ = 0;

  function newSlideDrop(el, st, lx, ly, power) {
    if (el._rainIdx == null) el._rainIdx = ++DROP_SEQ;   // 给每张卡片一个固定序号
    return {
      kind: "slide", el, st,
      lx, ly,
      r: clamp(1.1 + power * 1.0, 1.3, 3.6),
      len: 4 + power * 7,
      vy: 0.20 + power * 0.42,
      phase: Math.random() * Math.PI * 2,
      wob: 0.10 + Math.random() * 0.20,
      stuck: 0,
      alive: 1,
      life: rand(340, 620),
    };
  }

  function newPendingDrop(el, st, lx, ly, life) {
    return { kind: "pending", el, st, lx, ly, r: rand(0.9, 1.9), life, alive: 1 };
  }

  // 卡片上沿被打中：沿上沿朝溅开的方向铺一层水膜，随后各自往下淌
  function spreadOnTop(el, st, r, hitLx, power) {
    const dir = hitLx < r.width / 2 ? -1 : 1;   // 朝较近的那侧铺开
    const n = 2 + ((power * 3) | 0);
    for (let i = 0; i < n; i++) {
      if (drops.length >= MAX_DROPS) break;
      const lx = clamp(hitLx + dir * Math.random() * r.width * 0.28, 3, r.width - 3);
      drops.push(newPendingDrop(el, st, lx, rand(0.5, 3.5), 0.35 + Math.random() * 0.4));
    }
    // 沿上沿补几格水渍，让"被打湿"看得出来
    for (let i = 0; i < 5; i++) {
      wetAdd(st, clamp(hitLx + dir * i * WET_CELL * 1.4, 0, r.width), rand(0, 3), 0.30);
    }
  }

  // ---- 水花：受重力的细水点 ----
  const splashes = [];
  const SPLASH_MAX = 90;         // 总量封顶，低端机 / 手机上也扛得住
  function newSplash(x, y, n, spread, power) {
    for (let i = 0; i < n && splashes.length < SPLASH_MAX; i++) {
      const dir = Math.random() < 0.5 ? -1 : 1;
      splashes.push({
        x, y,
        vx: dir * rand(0.3, 1.6) * spread,
        vy: rand(-2.9, -0.7) * (0.6 + power),
        r: rand(0.5, 1.3) * (0.8 + power * 0.5),
        life: 1,
        decay: rand(0.075, 0.13),   // 水花很短命，眨眼就没了
      });
    }
  }

  const noise = (x, y) => {
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
    return s - Math.floor(s);
  };

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
    ctx.lineCap = "round";
    for (const s of streaks) {
      const x0 = s.x, y0 = s.y - s.len;
      s.vx = clamp(s.vx * 0.94 + 0.012, -0.6, 1.1);   // 风慢慢起来，封顶
      s.x += s.vx;
      s.y += s.vy;

      // 这一帧的移动轨迹有没有打中卡片？打中就照着落点做反应
      const res = hitCards(cardList, x0, y0, s.x, s.y);
      if (res) {
        const { hit, r, el, st } = res;
        const power = clamp(s.len / 22, 0.35, 1);
        if (hit.top) {
          // 打中卡片上沿：溅一大簇，水还会沿上沿往两边铺开
          newSplash(hit.x, r.top, 5 + ((power * 4) | 0), 1.35, power);
          spreadOnTop(el, st, r, hit.x - r.left, power);
          st.edge = 1;
        } else {
          // 打中卡片正面：溅开 + 在落点凝一颗水珠往下流
          newSplash(hit.x, hit.y, 4 + ((power * 3) | 0), 1.15, power);
          if (drops.length < MAX_DROPS) {
            drops.push(newSlideDrop(el, st, hit.x - r.left, hit.y - r.top, power));
          }
        }
        Object.assign(s, newStreak(true));   // 雨滴"用掉"了，换个新的
        continue;
      }

      // 落到页面底部：溅水花、重生
      if (s.y >= H - 3) {
        if (Math.random() < 0.4) newSplash(s.x, H - rand(0, 5), 3, 0.9, 0.35);
        Object.assign(s, newStreak(true));
        continue;
      }

      // 雨丝本体：一条带渐隐尾的短线
      ctx.strokeStyle = `rgba(${sky},${s.a})`;
      ctx.lineWidth = s.w;
      ctx.beginPath();
      ctx.moveTo(s.x - s.vx * (s.len / s.vy) - 0.5, s.y - s.len);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
      // 亮头：更短更亮的一小段，模拟反光
      ctx.strokeStyle = `rgba(${sky},${s.a * 0.9})`;
      ctx.lineWidth = s.w * 0.7;
      ctx.beginPath();
      ctx.moveTo(s.x - s.vx * 1.2, s.y - s.len * 0.35);
      ctx.lineTo(s.x, s.y);
      ctx.stroke();
    }

    // ===== 2. 卡片上的水渍（雨滴打在哪，哪就湿）=====
    for (const c of cardList) {
      const { r, st } = c;
      if (st.wet.size) {
        wetDecay(st, 0.0075);                       // 慢慢风干
        const rad = Math.min(R, r.width / 2, r.height / 2);
        // 把同一行相邻的水渍格合并成一条，一次 fillRect 画完 —— 省掉大量绘制调用
        const rows = new Map();                     // gy -> [gx...]
        for (const key of st.wet.keys()) {
          const sep = key.indexOf(":");
          const gx = +key.slice(0, sep), gy = +key.slice(sep + 1);
          // 跳过落在卡片圆角外的格
          const lx = gx * WET_CELL + WET_CELL / 2;
          const ly = gy * WET_CELL + WET_CELL / 2;
          if (lx < rad && ly < rad) {
            const dx = lx - rad, dy = ly - rad;
            if (dx * dx + dy * dy > rad * rad) continue;
          }
          let arr = rows.get(gy);
          if (!arr) { arr = []; rows.set(gy, arr); }
          arr.push(gx);
        }
        for (const [gy, xs] of rows) {
          xs.sort((a, b) => a - b);
          let runStart = xs[0], prev = xs[0], sum = 0, n = 0;
          const flush = () => {
            const avg = sum / n;
            if (avg <= 0.06) return;
            const x0 = runStart * WET_CELL;
            const w = (prev - runStart + 1) * WET_CELL;
            ctx.fillStyle = `rgba(255,255,255,${avg * 0.085})`;
            ctx.fillRect(r.left + x0 + WET_CELL * 0.15,
                         r.top + gy * WET_CELL + WET_CELL * 0.15,
                         w - WET_CELL * 0.3, WET_CELL * 0.7);
          };
          for (const gx of xs) {
            const v = st.wet.get(wetKey(gx, gy));
            if (gx === prev + 1) { prev = gx; sum += v; n++; }
            else { flush(); runStart = prev = gx; sum = v; n = 1; }
          }
          flush();
        }
      }
      st.edge = Math.max(0, st.edge - 0.006);       // 上沿积水慢慢渗掉
      // 上沿积水：卡片顶端一条淡淡的水膜，表示"上沿被打湿了"
      if (st.edge > 0.03) {
        const rad = Math.min(R, r.width / 2, r.height / 2);
        ctx.fillStyle = `rgba(${edge},${st.edge * 0.16})`;
        ctx.fillRect(r.left + rad * 0.5, r.top, r.width - rad, 1.5 + st.edge * 3);
      }
    }

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
          drops[i] = newSlideDrop(el, d.st, d.lx, d.ly, clamp(d.r / 2.2, 0.3, 0.9));
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
      d.vy = clamp(d.vy + 0.030 * drag, 0, 2.5);
      d.phase += 0.045 + d.vy * 0.02;
      d.stuck = Math.max(0, d.stuck - 1);

      // 不均匀的粘连：偶尔停一下再走，水珠才像真在玻璃上爬
      if (d.stuck === 0) {
        const n = noise(d.lx * 0.12, d.ly * 0.12);
        if (n > 0.965 && d.vy < 1.3) d.stuck = 4 + ((n * 20) | 0);
      }

      const moved = d.stuck ? 0 : d.vy * drag;
      d.ly += moved;
      d.alive = clamp(1 - wetness * 0.42, 0.3, 1); // 水膜里的小珠更透明

      // 左右摆动（贴着表面流时的轻微摇晃）
      d.lx += Math.sin(d.phase) * d.wob * (moved > 0 ? 1 : 0.25);
      d.lx = clamp(d.lx, 0.5, r.width - 0.5);

      // 水珠长大一点（一路汇入小水），有上限
      d.r = clamp(d.r + moved * 0.006, 0.8, 3.6);
      d.len = clamp(d.len + moved * 0.05, 3, 13);

      const x = r.left + d.lx;
      const y = r.top + d.ly;

      // 水痕：身后一条淡淡的水迹，越往上越细越淡（用两段渐隐模拟）
      const trail = d.len;
      ctx.strokeStyle = `rgba(${edge},${0.14 * d.alive})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, y - trail);
      ctx.lineTo(x, y);
      ctx.stroke();
      if (trail > 6) {
        ctx.strokeStyle = `rgba(${edge},${0.20 * d.alive})`;
        ctx.beginPath();
        ctx.moveTo(x, y - trail * 0.45);
        ctx.lineTo(x, y);
        ctx.stroke();
      }

      // 水珠本体：拖着尾巴的小椭圆。
      // 白色卡片上需要一点深色轮廓，否则水珠会"糊"进背景里看不见。
      const ry = d.r * (1.25 + Math.min(0.5, d.vy * 0.12));
      ctx.fillStyle = `rgba(${edge},${0.52 * d.alive})`;
      ctx.beginPath();
      ctx.ellipse(x, y, d.r * 0.85, ry, 0, 0, Math.PI * 2);
      ctx.fill();
      // 外圈：一点点更深的边，把水珠从卡片底色里"抠"出来
      ctx.strokeStyle = `rgba(${sky},${0.40 * d.alive})`;
      ctx.lineWidth = 0.7;
      ctx.beginPath();
      ctx.ellipse(x, y, d.r * 0.85, ry, 0, 0, Math.PI * 2);
      ctx.stroke();
      // 高光点：让水珠有体积感（偏左上）
      ctx.fillStyle = `rgba(255,255,255,${0.75 * d.alive})`;
      ctx.beginPath();
      ctx.arc(x - d.r * 0.30, y - d.r * 0.52, d.r * 0.32, 0, Math.PI * 2);
      ctx.fill();
      // 底部一点点暗边，更像水的折射
      ctx.fillStyle = `rgba(${sky},${0.26 * d.alive})`;
      ctx.beginPath();
      ctx.arc(x + d.r * 0.2, y + d.r * 0.5, d.r * 0.24, 0, Math.PI * 2);
      ctx.fill();

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
