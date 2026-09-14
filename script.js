/* =========================================================
   个人主页 · 交互脚本
   ---------------------------------------------------------
   音乐播放器：默认 3 首，改歌只需修改下面的 SONGS 数组。
   不用配置、不用构建，直接上传 GitHub Pages 即可。
   ========================================================= */

// ===== 1. 歌曲配置（固定 3 首，改这里就行）=====
// file 只写"文件名"，不用带 music/ 前缀 —— 只要文件确实在 music/ 里。
// 中文、空格、全角括号都会自动转义，不用自己处理。
// 歌名 / 歌手随便写，只影响界面显示，不影响播放。
// 换歌：把新文件放进 ./music/，然后改下面 3 行的 file 即可。
const SONGS = [
  { name: "够爱（DJ版）",     artist: "阿泽",   file: "azhe-gou-ai.mp3" },
  { name: "偏爱（咚鼓版）",   artist: "DJ阿轩", file: "djaxuan-pian-ai.mp3" },
  { name: "嘉宾（DJ舒心版）", artist: "DJ舒心", file: "djshuxin-jia-bin.mp3" },
];

// ===== 2. 主题：自动跟随系统 + 记住手动选择 =====
(function () {
  const root = document.documentElement;
  try {
    const saved = localStorage.getItem("theme");
    if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);
  } catch (e) { /* 隐私模式忽略 */ }

  // 手动循环切换：自动 -> 浅色 -> 深色 -> 自动
  window.cycleTheme = function () {
    const cur = root.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
    if (next) {
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("theme", next); } catch (e) {}
    } else {
      root.removeAttribute("data-theme");
      try { localStorage.removeItem("theme"); } catch (e) {}
    }
  };
})();

// ===== 3. 加载诊断：资源加载失败时在页面顶部给出可读提示 =====
// 手机上不方便开控制台，所以把关键错误直接显示出来。
(function () {
  const diag = document.getElementById("diag");
  if (!diag) return;

  const items = [];
  function report(msg) {
    if (items.indexOf(msg) !== -1) return;
    items.push(msg);
    diag.innerHTML = items
      .map((t) => `<div class="diag-line">${t}</div>`)
      .join("");
    diag.hidden = false;
  }
  window.__diagReport = report;

  // 检测当前是否运行在 file:// 下 —— 这种协议下浏览器会拦截音频加载
  if (location.protocol === "file:") {
    report("⚠️ 当前是 file:// 直接打开，浏览器会拦截音频。请用本地服务器或部署到 GitHub Pages 访问。");
  }

  // 音频 / 图片加载失败都会触发 error（捕获阶段才能拿到）
  window.addEventListener("error", (e) => {
    const el = e.target;
    if (!el || !el.tagName) return;
    const tag = el.tagName.toLowerCase();
    if (tag === "audio" || tag === "img") {
      const src = el.currentSrc || el.getAttribute("src") || "(空)";
      report(`❌ ${tag === "audio" ? "音频" : "图片"}加载失败：<code>${decodeURIComponent(src)}</code>`);
    }
  }, true);

  // 支持 Range 的服务器才适合流式播放音频，顺便探一下
  window.addEventListener("load", () => {
    if (location.protocol === "file:") return;
    const probeUrl = "avatar.jpg";
    fetch(probeUrl, { method: "HEAD" })
      .then((r) => {
        if (r.headers.get("accept-ranges") === "none") {
          report("⚠️ 当前服务器不支持分片传输（Range），音频可能加载很慢或无法拖动进度。");
        }
      })
      .catch(() => {});
  });
})();

// ===== 4. 音乐播放器 =====
(function () {
  const audio      = document.getElementById("audio");
  const playlist   = document.getElementById("playlist");
  const playBtn    = document.getElementById("playBtn");
  const prevBtn    = document.getElementById("prevBtn");
  const nextBtn    = document.getElementById("nextBtn");
  const loopBtn    = document.getElementById("loopBtn");
  const shuffleBtn = document.getElementById("shuffleBtn");
  const muteBtn    = document.getElementById("muteBtn");
  const vol        = document.getElementById("vol");
  const nowName    = document.getElementById("nowName");
  const nowArtist  = document.getElementById("nowArtist");
  const cover      = document.getElementById("cover");
  const seek       = document.getElementById("seek");
  const tCur       = document.getElementById("tCur");
  const tDur       = document.getElementById("tDur");
  const card       = document.querySelector(".music-card");

  // 这些元素缺一个就说明 HTML 被改坏了，直接报出来，免得后面莫名其妙卡住
  const required = { audio, playlist, playBtn, prevBtn, nextBtn, loopBtn, shuffleBtn,
                     muteBtn, vol, nowName, nowArtist, cover, seek, tCur, tDur, card };
  for (const k of Object.keys(required)) {
    if (!required[k]) { console.error("[player] 缺少 DOM 元素：", k); return; }
  }

  const SITE_TITLE = document.title;   // 暂停时把标签页标题还原成站点名

  let current = 0;
  let shuffle = false;   // 随机播放
  let loop    = false;   // 单曲循环
  let lastVol = 0.8;

  // ---- 本地记忆（音量、上次听到哪首）----
  const store = {
    get(k, d) {
      try { const v = localStorage.getItem("player." + k); return v === null ? d : v; }
      catch (e) { return d; }              // 隐私模式下 localStorage 会抛错
    },
    set(k, v) {
      try { localStorage.setItem("player." + k, v); } catch (e) { /* 忽略 */ }
    },
  };

  // 时长格式化 秒 -> m:ss
  const fmt = (s) => {
    if (!isFinite(s) || s <= 0) return "0:00";
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return `${m}:${ss < 10 ? "0" : ""}${ss}`;
  };

  // 文件名 -> 浏览器可用的 URL。
  // 中文、空格、括号必须转义，否则部分浏览器 / 服务器会 404。
  const esc = (s) => encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

  const srcOf = (s) => s.src
    ? s.src.split("/").map(esc).join("/")     // 文件不在 music/ 时用 src 写完整相对路径
    : "music/" + esc(s.file);

  // 错误提示：直接写在界面上，手机上没控制台也能看到原因
  function fail(msg) {
    nowName.textContent = "播放失败";
    nowArtist.textContent = msg;
  }

  // ---- 列表渲染 ----
  function renderPlaylist() {
    playlist.innerHTML = SONGS.map((s, i) => `
      <li class="track${i === current ? " active" : ""}" data-index="${i}">
        <span class="idx">${i + 1}</span>
        <span class="track-info">
          <span class="track-name">${s.name}</span>
          <span class="track-artist">${s.artist}</span>
        </span>
        <span class="dur">--:--</span>
      </li>`).join("");
  }

  // 高亮当前曲目。booted 为 false 时不滚动页面，免得一进站就跳走。
  let booted = false;
  function highlight(i) {
    playlist.querySelectorAll(".track").forEach((el, idx) => {
      const on = idx === i;
      el.classList.toggle("active", on);
      if (on && booted && el.scrollIntoView) {
        el.scrollIntoView({ block: "nearest", inline: "nearest" });
      }
    });
  }

  // ---- 系统媒体控制：手机锁屏 / 通知栏显示歌名，支持耳机线控 ----
  function updateMediaSession(s) {
    if (!("mediaSession" in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: s.name,
        artist: s.artist,
        album: "个人主页",
        artwork: [{ src: "avatar.jpg", sizes: "96x96", type: "image/jpeg" }],
      });
    } catch (e) { /* 老浏览器不支持 MediaMetadata，忽略 */ }
  }

  // ---- 播放控制 ----
  // 随机挑一首（不重复当前），列表只有一首时返回当前
  function randomIndex() {
    if (SONGS.length < 2) return current;
    let n;
    do { n = Math.floor(Math.random() * SONGS.length); } while (n === current);
    return n;
  }

  // 加载指定曲目（不自动播放）
  function load(i, autoplay) {
    current = (i + SONGS.length) % SONGS.length;
    const s = SONGS[current];
    const url = srcOf(s);

    // 同一个 src 反复赋值，有些浏览器不会重新加载，先清空更稳
    if (audio.getAttribute("src") === url) audio.removeAttribute("src");

    audio.src = url;
    nowName.textContent = s.name;
    nowArtist.textContent = s.artist;
    cover.textContent = "♪";
    highlight(current);
    store.set("index", current);
    updateMediaSession(s);
    if (autoplay) play();
  }

  function next(auto) {
    if (auto && loop) {                 // 单曲循环：重播当前
      audio.currentTime = 0;
      play();
      return;
    }
    load(shuffle ? randomIndex() : current + 1, true);
  }

  function prev() {
    load(shuffle ? randomIndex() : current - 1, true);
  }

  function play() {
    card.classList.add("loading");      // 先转圈，慢网下不至于以为点了没反应
    const p = audio.play();
    if (!p || !p.then) return;
    p.then(() => {
      card.classList.remove("loading");
      card.classList.add("playing");
      playBtn.setAttribute("aria-label", "暂停");
      cover.classList.add("spin");
      document.title = `${SONGS[current].name} - ${SONGS[current].artist}`;
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    }).catch((err) => {
      card.classList.remove("loading");
      // 常见：文件不存在 / 浏览器自动播放限制
      console.warn("播放失败：", srcOf(SONGS[current]), err);
      fail("无法播放：" + (SONGS[current].file || "路径错误"));
    });
  }

  function pause() {
    audio.pause();
    card.classList.remove("playing");
    card.classList.remove("loading");
    playBtn.setAttribute("aria-label", "播放");
    cover.classList.remove("spin");
    document.title = SITE_TITLE;
    if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "paused";
  }

  function toggle() { audio.paused ? play() : pause(); }

  // ---- 事件绑定 ----
  playBtn.addEventListener("click", toggle);
  prevBtn.addEventListener("click", prev);
  nextBtn.addEventListener("click", () => next(false));

  // 单曲循环开关
  loopBtn.addEventListener("click", () => {
    loop = !loop;
    loopBtn.classList.toggle("on", loop);
    loopBtn.setAttribute("aria-label", loop ? "关闭循环" : "循环播放");
    loopBtn.title = loop ? "单曲循环：开" : "单曲循环：关";
  });

  // 随机播放开关
  shuffleBtn.addEventListener("click", () => {
    shuffle = !shuffle;
    shuffleBtn.classList.toggle("on", shuffle);
    shuffleBtn.setAttribute("aria-label", shuffle ? "关闭随机" : "随机播放");
    shuffleBtn.title = shuffle ? "随机播放：开" : "随机播放：关";
  });

  // 音量：优先用上次记住的值
  const savedVol = parseFloat(store.get("volume", ""));
  audio.volume = isFinite(savedVol) ? Math.min(1, Math.max(0, savedVol)) : +vol.value;
  vol.value = audio.volume;

  vol.addEventListener("input", () => {
    audio.volume = +vol.value;
    audio.muted = false;
    muteBtn.classList.remove("muted");
    if (audio.volume === 0) muteBtn.classList.add("muted");
    store.set("volume", audio.volume);
  });

  // 静音切换
  muteBtn.addEventListener("click", () => {
    if (audio.muted || audio.volume === 0) {
      audio.muted = false;
      audio.volume = lastVol || 0.8;
      vol.value = audio.volume;
      muteBtn.classList.remove("muted");
      store.set("volume", audio.volume);
    } else {
      lastVol = audio.volume;
      audio.muted = true;
      muteBtn.classList.add("muted");
    }
  });

  // 音量滑块松手时记住非零音量，供取消静音时恢复
  vol.addEventListener("change", () => {
    if (audio.volume > 0) { lastVol = audio.volume; store.set("volume", audio.volume); }
  });

  // 点击列表切歌
  playlist.addEventListener("click", (e) => {
    const li = e.target.closest(".track");
    if (li) load(Number(li.dataset.index), true);
  });

  // 进度更新
  audio.addEventListener("timeupdate", () => {
    if (!audio.duration) return;
    seek.value = (audio.currentTime / audio.duration) * 100;
    tCur.textContent = fmt(audio.currentTime);
    if ("mediaSession" in navigator && navigator.mediaSession.setPositionState) {
      try {
        navigator.mediaSession.setPositionState({
          duration: audio.duration,
          position: audio.currentTime,
          playbackRate: audio.playbackRate,
        });
      } catch (e) { /* 部分浏览器对参数校验很严，忽略 */ }
    }
  });

  audio.addEventListener("loadedmetadata", () => {
    tDur.textContent = fmt(audio.duration);
    const li = playlist.querySelectorAll(".track")[current];
    if (li) li.querySelector(".dur").textContent = fmt(audio.duration);
  });

  audio.addEventListener("ended", () => next(true));   // 自动下一首 / 单曲循环

  // 缓冲时给播放按钮显示转圈，慢网下不至于以为点了没反应
  audio.addEventListener("waiting", () => card.classList.add("loading"));
  audio.addEventListener("playing", () => card.classList.remove("loading"));
  audio.addEventListener("canplay", () => card.classList.remove("loading"));
  audio.addEventListener("canplaythrough", () => card.classList.remove("loading"));
  audio.addEventListener("stalled", () => card.classList.remove("loading"));

  audio.addEventListener("error", () => {
    card.classList.remove("loading");
    const code = audio.error && audio.error.code;
    // 1=中止 2=网络 3=解码 4=格式不支持
    const why = code === 4 ? "格式不支持或文件损坏"
              : code === 3 ? "音频解码失败"
              : code === 2 ? "网络中断，文件可能没上传完整"
              : "文件不存在（路径或文件名对不上）";
    fail("加载失败：" + why);
    console.warn("音频错误 code =", code, "URL =", audio.currentSrc || audio.src, audio.error);
    pause();
  });

  // 拖动进度条
  seek.addEventListener("input", () => {
    if (audio.duration) audio.currentTime = (seek.value / 100) * audio.duration;
  });

  // 空格键 = 播放 / 暂停。
  // 输入框、滑块、按钮本身都不拦截，交给它们自己的默认行为，
  // 否则「点了播放按钮后按空格」会触发两次、互相抵消。
  document.addEventListener("keydown", (e) => {
    if (e.code !== "Space") return;
    const t = e.target;
    if (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/.test(t.tagName)) return;
    e.preventDefault();
    toggle();
  });

  // 系统媒体控制（耳机线控 / 锁屏按钮）
  if ("mediaSession" in navigator) {
    const setHandler = (action, fn) => {
      try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* 不支持则忽略 */ }
    };
    setHandler("play", play);
    setHandler("pause", pause);
    setHandler("previoustrack", prev);
    setHandler("nexttrack", () => next(false));
  }

  // ---- 后台逐个读取每首歌的时长，写回列表（不改变当前播放状态）----
  //
  // 这段是最容易把页面拖住的地方，做了三重保险：
  //   1. 同一时刻只加载一首，读完再读下一首，不并发抢带宽
  //   2. 每次探测都带超时，读不到就跳过，不会永远停在第一首
  //   3. 整个流程有总时限，超时直接收工，不影响页面其他功能
  function scanDurations() {
    const TIMEOUT  = 12000;               // 单首超时
    const DEADLINE = Date.now() + 90000;  // 整体上限
    const tracks   = playlist.querySelectorAll(".track");
    const probe    = new Audio();
    probe.preload  = "metadata";
    probe.muted    = true;

    let i = 0;
    let timer = null;
    let done = false;

    function finish() {
      if (done) return;
      done = true;
      clearTimeout(timer);
      probe.onloadedmetadata = null;
      probe.onerror = null;
      probe.removeAttribute("src");
      try { probe.load(); } catch (e) {}
    }

    function step() {
      if (done) return;
      if (i >= SONGS.length || Date.now() > DEADLINE) { finish(); return; }

      const idx = i++;
      clearTimeout(timer);
      timer = setTimeout(() => {
        console.warn("[player] 读取时长超时，跳过：", SONGS[idx].file);
        step();
      }, TIMEOUT);

      probe.onloadedmetadata = () => {
        if (isFinite(probe.duration) && probe.duration > 0 && tracks[idx]) {
          tracks[idx].querySelector(".dur").textContent = fmt(probe.duration);
        }
        step();
      };
      probe.onerror = () => step();   // 某一首读不到就跳过，不影响其他

      probe.src = srcOf(SONGS[idx]);
      try { probe.load(); } catch (e) {}
    }

    step();
  }

  // ---- 启动 ----
  // 回到上次听到的那首（只选中，不自动播放 —— 浏览器禁止未经交互自动出声）
  const savedIdx = parseInt(store.get("index", "0"), 10);
  current = Number.isInteger(savedIdx) && savedIdx >= 0 && savedIdx < SONGS.length ? savedIdx : 0;

  renderPlaylist();
  load(current, false);
  booted = true;

  // 等页面本身加载完再扫描时长，避免和首屏资源抢带宽
  if (document.readyState === "complete") scanDurations();
  else window.addEventListener("load", scanDurations);
})();
