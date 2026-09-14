/* =========================================================
   下雨效果 · Canvas
   ---------------------------------------------------------
   真实感来自三层叠加：
   1. 天空雨丝：远层细而慢、近层粗而快，带横向风偏，
      落到页面底部溅起小水花
   2. 雨滴打在卡片顶边会"挂"住，变成水珠顺着卡片
      左右边框往下滑（越滑越快、轻微摆动、身后留水痕）
   3. 水珠滑到卡片底边滴落，也溅水花
   - prefers-reduced-motion 用户自动关闭
   - 页面切到后台时浏览器自动暂停 rAF，不耗电
   ========================================================= */
(function () {
  "use strict";
  // 说明：不再跟随系统"减少动态效果"设置自动关闭 ——
  // Windows 关闭动画特效时浏览器会上报 prefers-reduced-motion: reduce，
  // 之前因此导致很多用户明明要下雨却看不到。现在始终下雨。

  const canvas = document.getElementById("rain");
  if (!canvas || !canvas.getContext) return;
  const ctx = canvas.getContext("2d");

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
  window.addEventListener("resize", resize);

  // ---- 主题色：深色模式下雨丝更亮才看得见 ----
  const darkQuery = window.matchMedia
    ? window.matchMedia("(prefers-color-scheme: dark)") : null;
  function isDark() {
    const t = document.documentElement.getAttribute("data-theme");
    if (t === "dark") return true;
    if (t === "light") return false;
    return !!(darkQuery && darkQuery.matches);
  }

  const rand = (a, b) => a + Math.random() * (b - a);

  // ---- 天空雨丝 ----
  const streaks = [];
  const STREAK_N = Math.round(Math.min(150, Math.max(70, window.innerWidth / 9)));
  function newStreak(fromTop) {
    const near = Math.random() < 0.45;   // 近景层更粗、更快、更亮
    return {
      x: rand(-80, W + 40),
      y: fromTop ? rand(-H * 0.5, -10) : rand(-H, H),
      len: near ? rand(14, 26) : rand(8, 16),
      vy: near ? rand(13, 19) : rand(7, 11),
      vx: rand(-0.2, 0.2),
      w: near ? 1.6 : 1.1,
      a: near ? rand(0.30, 0.48) : rand(0.16, 0.28),
      landable: Math.random() < 0.30,    // 这滴雨有机会挂在卡片边上
    };
  }
  for (let i = 0; i < STREAK_N; i++) streaks.push(newStreak(false));

  // ---- 卡片边缘滑落的水珠 ----
  // el: 卡片元素；side: 1 贴左边框 / -1 贴右边框
  const drops = [];
  function newEdgeDrop(el, side, y) {
    return {
      el, side,
      y: y,
      vy: rand(0.35, 0.9),
      r: rand(1.6, 3.0),
      phase: rand(0, Math.PI * 2),
      wob: rand(0.15, 0.45),
      a: rand(0.6, 0.9),
    };
  }

  // ---- 水花 ----
  const splashes = [];
  function newSplash(x, y, n) {
    for (let i = 0; i < n && splashes.length < 60; i++) {
      splashes.push({
        x, y,
        vx: rand(-1.3, 1.3),
        vy: rand(-2.6, -0.8),
        r: rand(0.6, 1.4),
        life: 1,
      });
    }
  }

  // ---- 可见卡片（每帧取 viewport 坐标，滚动/缩放都不会错位）----
  function visibleCards() {
    const out = [];
    const els = document.querySelectorAll(".card");
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.bottom < -40 || r.top > H + 40) continue;
      if (r.width < 30 || r.height < 30) continue;
      out.push({ el, r });
    }
    return out;
  }

  let frame = 0;

  function tick() {
    frame++;
    const sky  = isDark() ? "170,200,235" : "110,140,170"; // 天空雨丝色
    const edge = isDark() ? "190,215,245" : "120,150,185"; // 边缘水珠色

    ctx.clearRect(0, 0, W, H);
    const cards = visibleCards();

    // ===== 1. 天空雨丝 =====
    ctx.lineCap = "round";
    for (const s of streaks) {
      s.vx = Math.min(s.vx * 0.92 + 0.02, 1.2);  // 风慢慢起来，封顶
      s.x += s.vx;
      s.y += s.vy;

      // 打中卡片顶边：挂住，变成边缘水珠
      if (s.landable) {
        for (const c of cards) {
          const r = c.r;
          if (s.y >= r.top && s.y <= r.top + 14 &&
              s.x > r.left + 6 && s.x < r.right - 6) {
            if (drops.length < 40) {
              drops.push(newEdgeDrop(
                c.el,
                s.x - r.left < r.right - s.x ? 1 : -1,
                r.top + 2
              ));
            }
            s.y = rand(-H * 0.5, -10);          // 重生
            s.x = rand(-60, W + 40);
            break;
          }
        }
      }

      // 落到页面底部：溅水花、重生
      if (s.y >= H - 3) {
        if (Math.random() < 0.5) newSplash(s.x, H - rand(0, 6), 2);
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

    // ===== 2. 卡片边缘水珠 =====
    // 稀疏补充：直接在可见卡片边框上"凝"出水珠，保证边缘一直有水在流
    if (frame % 14 === 0 && drops.length < 40 && cards.length) {
      const c = cards[(Math.random() * cards.length) | 0];
      const r = c.r;
      drops.push(newEdgeDrop(
        c.el,
        Math.random() < 0.5 ? 1 : -1,
        r.top + rand(0, (r.bottom - r.top) * 0.4)
      ));
    }

    for (let i = drops.length - 1; i >= 0; i--) {
      const d = drops[i];
      const r = d.el.getBoundingClientRect();

      // 卡片滚出屏幕：水珠直接消失
      if (r.bottom < -10 || r.top > H + 10) { drops.splice(i, 1); continue; }

      d.vy = Math.min(d.vy + 0.035, 2.6);        // 重力：越滑越快
      d.y += d.vy;
      d.phase += 0.05;

      // 滑到卡片底边：滴落 + 水花
      if (d.y >= r.bottom - 3) {
        newSplash(
          d.side === 1 ? r.left + 1.5 : r.right - 1.5,
          Math.min(d.y, H - 4), 2
        );
        drops.splice(i, 1);
        continue;
      }

      const edgeX = (d.side === 1 ? r.left : r.right) + d.side * 1.5;
      const x = edgeX + Math.sin(d.phase) * d.wob; // 轻微左右摆动

      // 水痕：身后一条淡淡的水迹
      ctx.strokeStyle = `rgba(${edge},${d.a * 0.25})`;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x, d.y - Math.min(18, d.vy * 14));
      ctx.lineTo(x, d.y);
      ctx.stroke();

      // 水珠本体：小椭圆
      ctx.fillStyle = `rgba(${edge},${d.a * 0.55})`;
      ctx.beginPath();
      ctx.ellipse(x, d.y, d.r * 0.7, d.r * 1.35, 0, 0, Math.PI * 2);
      ctx.fill();
      // 高光点
      ctx.fillStyle = `rgba(255,255,255,${d.a * 0.5})`;
      ctx.beginPath();
      ctx.arc(x - d.r * 0.25, d.y - d.r * 0.5, d.r * 0.32, 0, Math.PI * 2);
      ctx.fill();
    }

    // ===== 3. 水花 =====
    for (let i = splashes.length - 1; i >= 0; i--) {
      const p = splashes[i];
      p.vy += 0.12;                              // 水花也受重力
      p.x += p.vx;
      p.y += p.vy;
      p.life -= 0.045;
      if (p.life <= 0) { splashes.splice(i, 1); continue; }
      ctx.fillStyle = `rgba(${edge},${p.life * 0.5})`;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }

    requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
})();
