/* =========================================================
   个人主页 · 交互脚本
   ---------------------------------------------------------
   音乐播放器：固定 3 首，改歌只需修改下面的 SONGS 数组。
   音频文件放在 ./music/ 文件夹里。
   ========================================================= */

// ===== 1. 歌曲配置（固定 3 首，改这里就行）=====
// file 只写"文件名"，不用带 music/ 前缀 —— 只要文件确实在 music/ 里。
// 中文、空格、全角括号都会自动转义，不用自己处理。
// 歌名 / 歌手随便写，只影响界面显示，不影响播放。
// 换歌：把新文件放进 ./music/，然后改下面 3 行的 file 即可。
const SONGS = [
  { name: "够爱（DJ版）",     artist: "阿泽",   file: "阿泽 - 够爱（DJ版）.mp3" },
  { name: "偏爱（咚鼓版）",   artist: "DJ阿轩", file: "DJ阿轩 - 偏爱 (咚鼓版).mp3" },
  { name: "嘉宾（DJ舒心版）", artist: "DJ舒心", file: "DJ舒心 - 嘉宾（DJ舒心版）.mp3" },
];

// ===== 2. 主题：自动跟随系统 + 记住手动选择 =====
(function () {
  const root = document.documentElement;
  const saved = localStorage.getItem("theme");
  if (saved === "light" || saved === "dark") root.setAttribute("data-theme", saved);

  // 手动循环切换：自动 -> 浅色 -> 深色 -> 自动
  window.cycleTheme = function () {
    const cur = root.getAttribute("data-theme");
    const next = cur === "dark" ? "light" : cur === "light" ? "" : "dark";
    if (next) { root.setAttribute("data-theme", next); localStorage.setItem("theme", next); }
    else { root.removeAttribute("data-theme"); localStorage.removeItem("theme"); }
  };
})();

// ===== 3. 音乐播放器 =====
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
  // （现在只有 3 首，用不上滚动；保留是为了以后加歌也不会看不到。）
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
    audio.src = srcOf(s);
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
    audio.play().then(() => {
      card.classList.add("playing");
      playBtn.setAttribute("aria-label", "暂停");
      cover.classList.add("spin");
      document.title = `${SONGS[current].name} - ${SONGS[current].artist}`;
      if ("mediaSession" in navigator) navigator.mediaSession.playbackState = "playing";
    }).catch((err) => {
      // 常见：文件不存在 / 浏览器自动播放限制
      nowArtist.textContent = "播放失败：" + (SONGS[current].file || "路径错误");
      console.warn("播放失败：", srcOf(SONGS[current]), err);
    });
  }

  function pause() {
    audio.pause();
    card.classList.remove("playing");
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

  audio.addEventListener("error", () => {
    card.classList.remove("loading");
    nowArtist.textContent = "音频加载失败：" + (SONGS[current].file || "路径错误");
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

  // 后台逐个读取每首歌的时长，写回列表（不改变当前播放状态）
  function scanDurations() {
    let i = 0;
    const probe = new Audio();
    probe.preload = "metadata";
    const tracks = playlist.querySelectorAll(".track");
    const step = () => {
      if (i >= SONGS.length) { probe.src = ""; return; }
      const idx = i++;
      probe.src = srcOf(SONGS[idx]);
      probe.onloadedmetadata = () => {
        if (isFinite(probe.duration) && tracks[idx]) {
          tracks[idx].querySelector(".dur").textContent = fmt(probe.duration);
        }
        step();
      };
      probe.onerror = step;   // 某一首读不到就跳过，不影响其他
    };
    step();
  }

  // ---- 启动 ----
  // 回到上次听到的那首（只选中，不自动播放 —— 浏览器禁止未经交互自动出声）
  const savedIdx = parseInt(store.get("index", "0"), 10);
  current = Number.isInteger(savedIdx) && savedIdx >= 0 && savedIdx < SONGS.length ? savedIdx : 0;

  renderPlaylist();
  load(current, false);
  booted = true;
  scanDurations();
})();
