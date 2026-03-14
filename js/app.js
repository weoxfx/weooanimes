// ═══════════════════════════════════════════════════════
// CONFIG
// ═══════════════════════════════════════════════════════
const SUPABASE_URL = 'https://ujdunsnmmfkeqvdwpufd.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InVqZHVuc25tbWZrZXF2ZHdwdWZkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzMzOTQxNTIsImV4cCI6MjA4ODk3MDE1Mn0.ICwNLQLEW4shBogsFbDilHIC6zZTmxqGLtl6IyjqpB8';
const JIKAN = 'https://api.jikan.moe/v4';

// ─── YOUR PROXY SERVER ──────────────────────────────────────────────────────
// After deploying server.js, paste your URL here.
// Local dev:  http://localhost:3000
// Railway:    https://your-app.up.railway.app
// Render:     https://your-app.onrender.com
const PROXY_BASE = 'https://homely-better-slope--weac5.replit.app';

// ═══════════════════════════════════════════════════════
// SUPABASE
// ═══════════════════════════════════════════════════════
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ═══════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════
let currentUser = null;
let currentAnime = null;
let currentEp = 1;
let totalEps = 0;
let heroList = [], heroIdx = 0;
let watchlist = new Set();
let watchProgress = {};
let browseType = '', browseGenre = 0, browsePage = 1;
let isPlaying = false, playTimer = null, fakeProgress = 0;
// streaming
let hlsInstance = null;
let activeServerIdx = 0;    // which server we're currently using
let forcedServerIdx = null; // null = auto waterfall

// ═══════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function jikan(path, retry = 3) {
  for (let i = 0; i < retry; i++) {
    try {
      const r = await fetch(JIKAN + path);
      if (r.status === 429) { await sleep(1200 * (i + 1)); continue; }
      if (!r.ok) throw new Error(r.status);
      return await r.json();
    } catch(e) { if (i === retry - 1) throw e; await sleep(600); }
  }
}

// Call our own proxy server
async function proxyFetch(path, timeout = 14000) {
  const r = await fetch(PROXY_BASE + path, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error('Proxy HTTP ' + r.status);
  return r.json();
}

function slugify(str) {
  return (str || '').toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim().replace(/\s+/g, '-').replace(/-+/g, '-');
}

function fuzzyTitle(a, b) {
  const n = s => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const na = n(a), nb = n(b);
  if (!na || !nb) return false;
  return na.includes(nb.slice(0, 5)) || nb.includes(na.slice(0, 5));
}

function bestQuality(sources) {
  const pref = ['1080p','720p','480p','360p','default','auto','backup'];
  for (const q of pref) {
    const s = sources.find(x => (x.quality||'').toLowerCase() === q || (x.quality||'').toLowerCase().includes(q));
    if (s) return s;
  }
  return sources[0];
}

function showPage(name) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById('page-' + name).classList.add('active');
  window.scrollTo(0, 0);
  document.querySelectorAll('.nav-links a').forEach(a => a.classList.remove('active'));
  const map = { home: 'nav-home', browse: 'nav-browse', watchlist: 'nav-wl' };
  if (map[name]) document.getElementById(map[name])?.classList.add('active');
}

function showToast(msg, err = false) {
  document.getElementById('toast-msg').textContent = msg;
  document.getElementById('toast-dot').className = 'toast-dot' + (err ? ' err' : '');
  const t = document.getElementById('toast');
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2800);
}

function skels(n) {
  return Array.from({ length: n }, () =>
    '<div class="sk"><div class="sk-thumb"></div><div class="sk-line"></div><div class="sk-s"></div></div>'
  ).join('');
}

function card(a) {
  const img = a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '';
  const title = a.title_english || a.title || 'Unknown';
  const eps = a.episodes ? 'EP ' + a.episodes : 'Ongoing';
  const score = a.score ? a.score.toFixed(1) : 'N/A';
  const year = a.year || a.aired?.prop?.from?.year || '';
  const inWL = watchlist.has(String(a.mal_id));
  return '<div class="anime-card fade-in" onclick="openById(' + a.mal_id + ')">' +
    '<div class="card-thumb">' +
    '<img src="' + img + '" alt="" loading="lazy" onerror="this.src=\'https://picsum.photos/seed/' + a.mal_id + '/300/450\'">' +
    '<div class="card-overlay"><div class="play-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div></div>' +
    '<span class="card-ep-badge">' + eps + '</span>' +
    '<span class="card-type type-sub">SUB</span>' +
    '<div class="card-wl-dot' + (inWL ? ' show' : '') + '"></div>' +
    '</div>' +
    '<div class="card-info"><div class="card-title">' + title + '</div>' +
    '<div class="card-sub"><span><span class="star-icon">&#9733;</span> ' + score + '</span><span>' + year + '</span></div></div>' +
    '</div>';
}

// ═══════════════════════════════════════════════════════
// AUTH
// ═══════════════════════════════════════════════════════
async function initAuth() {
  const { data: { session } } = await sb.auth.getSession();
  if (session?.user) onLogin(session.user);
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_IN' && session?.user) onLogin(session.user);
    if (event === 'SIGNED_OUT') onLogout();
  });
}

function onLogin(user) {
  currentUser = user;
  const initial = (user.user_metadata?.username || user.email || '?')[0].toUpperCase();
  const uname = user.user_metadata?.username || 'Anime Fan';
  document.getElementById('auth-area').innerHTML =
    '<div class="user-avatar" id="user-avatar" onclick="toggleUserMenu()">' + initial +
    '<div class="user-menu" id="user-menu">' +
    '<div class="um-header"><div class="um-name">' + uname + '</div><div class="um-email">' + user.email + '</div></div>' +
    '<div class="um-item" onclick="goWatchlist()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg> My Watchlist</div>' +
    '<div class="um-item danger" onclick="doLogout()"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16,17 21,12 16,7"/><line x1="21" y1="12" x2="9" y2="12"/></svg> Sign Out</div>' +
    '</div></div>';
  document.getElementById('nav-wl').style.display = '';
  closeAuthModal();
  loadUserData();
  showToast('Welcome back, ' + uname + '!');
}

function onLogout() {
  currentUser = null;
  watchlist = new Set();
  watchProgress = {};
  document.getElementById('auth-area').innerHTML = '<button class="btn-sign" onclick="openAuthModal(\'login\')">Sign In</button>';
  document.getElementById('nav-wl').style.display = 'none';
  document.getElementById('cw-section').style.display = 'none';
  showToast('Signed out.');
}

async function doLogin() {
  const email = document.getElementById('login-email').value.trim();
  const pwd = document.getElementById('login-password').value;
  if (!email || !pwd) return showFormError('Please fill all fields.');
  setBtn('login-btn', true, 'Signing in...');
  const { error } = await sb.auth.signInWithPassword({ email, password: pwd });
  setBtn('login-btn', false, 'Sign In');
  if (error) showFormError(error.message);
}

async function doSignup() {
  const username = document.getElementById('signup-username').value.trim();
  const email = document.getElementById('signup-email').value.trim();
  const pwd = document.getElementById('signup-password').value;
  if (!username || !email || !pwd) return showFormError('Please fill all fields.');
  if (pwd.length < 6) return showFormError('Password must be at least 6 characters.');
  setBtn('signup-btn', true, 'Creating account...');
  const { data, error } = await sb.auth.signUp({
    email, password: pwd,
    options: { data: { username } }
  });
  setBtn('signup-btn', false, 'Create Account');
  if (error) { showFormError(error.message); return; }
  // If email confirmation is disabled (recommended), session is available immediately
  if (data?.session) {
    onLogin(data.user);
    showToast('Welcome, ' + username + '! 🎉');
  } else {
    // Try logging in directly anyway in case confirm is disabled but session not returned
    const { error: e2 } = await sb.auth.signInWithPassword({ email, password: pwd });
    if (!e2) { /* onAuthStateChange fires onLogin */ }
    else showFormSuccess('Account created! Check your email to confirm, then sign in.');
  }
}

async function doLogout() { await sb.auth.signOut(); }

function setBtn(id, disabled, text) {
  const b = document.getElementById(id);
  b.disabled = disabled; b.textContent = text;
}
function showFormError(msg) {
  const el = document.getElementById('form-error');
  el.textContent = msg; el.style.display = 'block';
  document.getElementById('form-success').style.display = 'none';
}
function showFormSuccess(msg) {
  const el = document.getElementById('form-success');
  el.textContent = msg; el.style.display = 'block';
  document.getElementById('form-error').style.display = 'none';
}
function openAuthModal(tab) {
  document.getElementById('auth-modal').classList.add('open');
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('form-success').style.display = 'none';
  switchTab(tab || 'login');
}
function closeAuthModal() { document.getElementById('auth-modal').classList.remove('open'); }
function switchTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-signup').classList.toggle('active', tab === 'signup');
  document.getElementById('login-form').style.display = tab === 'login' ? '' : 'none';
  document.getElementById('signup-form').style.display = tab === 'signup' ? '' : 'none';
  document.getElementById('form-error').style.display = 'none';
  document.getElementById('form-success').style.display = 'none';
}
function toggleUserMenu() { document.getElementById('user-menu')?.classList.toggle('open'); }
document.getElementById('auth-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('auth-modal')) closeAuthModal();
});
document.addEventListener('click', e => {
  if (!e.target.closest('#user-avatar')) document.getElementById('user-menu')?.classList.remove('open');
  if (!e.target.closest('.nav-right')) document.getElementById('search-dd').classList.remove('open');
});

// ═══════════════════════════════════════════════════════
// SUPABASE DATA
// ═══════════════════════════════════════════════════════
async function loadUserData() {
  if (!currentUser) return;
  const [wlRes, pgRes] = await Promise.all([
    sb.from('watchlist').select('mal_id,anime_title,anime_image').eq('user_id', currentUser.id),
    sb.from('watch_progress').select('mal_id,episode,progress_pct,anime_title,anime_image,updated_at').eq('user_id', currentUser.id)
  ]);
  if (wlRes.data) wlRes.data.forEach(r => watchlist.add(String(r.mal_id)));
  if (pgRes.data) pgRes.data.forEach(r => {
    watchProgress[String(r.mal_id)] = { ep: r.episode, progress: r.progress_pct, title: r.anime_title, img: r.anime_image, updated_at: r.updated_at };
  });
  renderContinueWatching(pgRes.data || []);
  refreshDetailButtons();
}

async function toggleWatchlist() {
  if (!currentUser) { openAuthModal('login'); showToast('Sign in to use your watchlist', true); return; }
  const id = String(currentAnime.mal_id);
  if (watchlist.has(id)) {
    const { error } = await sb.from('watchlist').delete().eq('user_id', currentUser.id).eq('mal_id', id);
    if (!error) { watchlist.delete(id); showToast('Removed from watchlist'); refreshDetailButtons(); }
    else showToast('Error removing', true);
  } else {
    const img = currentAnime.images?.jpg?.image_url || '';
    const title = currentAnime.title_english || currentAnime.title || '';
    const { error } = await sb.from('watchlist').upsert({ user_id: currentUser.id, mal_id: parseInt(id), anime_title: title, anime_image: img });
    if (!error) { watchlist.add(id); showToast('Added to watchlist!'); refreshDetailButtons(); }
    else showToast('Error adding', true);
  }
}

async function saveProgress(malId, ep, pct) {
  if (!currentUser) return;
  const title = currentAnime?.title_english || currentAnime?.title || '';
  const img = currentAnime?.images?.jpg?.image_url || '';
  await sb.from('watch_progress').upsert({
    user_id: currentUser.id, mal_id: parseInt(malId),
    episode: ep, progress_pct: Math.round(pct),
    anime_title: title, anime_image: img,
    updated_at: new Date().toISOString()
  });
  watchProgress[String(malId)] = { ep, progress: Math.round(pct), title, img };
}

function refreshDetailButtons() {
  if (!currentAnime) return;
  const id = String(currentAnime.mal_id);
  const inList = watchlist.has(id);
  const btn = document.getElementById('wl-btn');
  const txt = document.getElementById('wl-btn-text');
  const icon = document.getElementById('wl-icon');
  if (inList) {
    btn.className = 'btn-add in-list';
    txt.textContent = 'In My List';
    icon.innerHTML = '<polyline points="20,6 9,17 4,12" stroke="currentColor" stroke-width="2" fill="none"/>';
  } else {
    btn.className = 'btn-add';
    txt.textContent = 'Add to List';
    icon.innerHTML = '<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>';
  }
  const prog = watchProgress[id];
  document.getElementById('watch-btn-text').textContent = prog ? 'Resume EP ' + prog.ep : 'Watch EP 1';
  const maxEp = Math.min(totalEps || 24, 100);
  for (let i = 1; i <= maxEp; i++) {
    const b = document.getElementById('ep-btn-' + i);
    if (!b) continue;
    if (prog && i < prog.ep) b.className = 'ep-btn watched';
    else if (prog && i === prog.ep) b.className = 'ep-btn watching';
    else b.className = 'ep-btn';
  }
}

function renderContinueWatching(progData) {
  if (!progData.length) { document.getElementById('cw-section').style.display = 'none'; return; }
  document.getElementById('cw-section').style.display = '';
  const sorted = [...progData].sort((a, b) => (b.updated_at || '') > (a.updated_at || '') ? 1 : -1).slice(0, 6);
  document.getElementById('cw-grid').innerHTML = sorted.map(r => {
    const pct = r.progress_pct || 0;
    return '<div class="cw-card" onclick="openById(' + r.mal_id + ')">' +
      '<div class="cw-thumb">' +
      '<img src="' + (r.anime_image || '') + '" onerror="this.src=\'https://picsum.photos/seed/' + r.mal_id + '/400/225\'" alt="">' +
      '<div class="cw-progress"><div class="cw-progress-fill" style="width:' + pct + '%"></div></div>' +
      '<span class="cw-ep-badge">EP ' + r.episode + '</span>' +
      '<div class="cw-play-overlay"><div class="play-icon" style="transform:scale(1)"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div></div>' +
      '</div>' +
      '<div class="cw-info"><div class="cw-title">' + (r.anime_title || 'Unknown') + '</div>' +
      '<div class="cw-meta">Episode ' + r.episode + ' &middot; ' + pct + '% watched</div></div>' +
      '</div>';
  }).join('');
}

// ═══════════════════════════════════════════════════════
// WATCHLIST PAGE
// ═══════════════════════════════════════════════════════
async function goWatchlist() {
  if (!currentUser) { openAuthModal('login'); return; }
  showPage('watchlist');
  document.getElementById('wl-grid').innerHTML = skels(8);
  const { data, error } = await sb.from('watchlist').select('*').eq('user_id', currentUser.id).order('created_at', { ascending: false });
  if (error || !data?.length) {
    document.getElementById('wl-grid').innerHTML =
      '<div class="wl-empty"><svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" style="margin-bottom:16px;opacity:.3"><path d="M19 21l-7-5-7 5V5a2 2 0 012-2h10a2 2 0 012 2z"/></svg>' +
      '<p style="font-size:15px;margin-bottom:8px">Your watchlist is empty</p>' +
      '<span style="font-size:13px">Browse anime and click Add to List to save them here.</span></div>';
    document.getElementById('wl-sub').textContent = '0 anime saved';
    return;
  }
  document.getElementById('wl-sub').textContent = data.length + ' anime saved';
  document.getElementById('wl-grid').innerHTML = data.map(r => {
    const prog = watchProgress[String(r.mal_id)];
    return '<div class="anime-card fade-in" onclick="openById(' + r.mal_id + ')">' +
      '<div class="card-thumb">' +
      '<img src="' + (r.anime_image || '') + '" loading="lazy" onerror="this.src=\'https://picsum.photos/seed/' + r.mal_id + '/300/450\'" alt="">' +
      '<div class="card-overlay"><div class="play-icon"><svg width="18" height="18" viewBox="0 0 24 24" fill="white"><polygon points="5,3 19,12 5,21"/></svg></div></div>' +
      (prog ? '<span class="card-ep-badge">EP ' + prog.ep + '</span>' : '') +
      '<div class="card-wl-dot show"></div>' +
      '</div>' +
      '<div class="card-info"><div class="card-title">' + (r.anime_title || 'Unknown') + '</div>' +
      '<div class="card-sub"><span>' + (prog ? prog.progress + '% watched' : 'Not started') + '</span></div></div>' +
      '</div>';
  }).join('');
}

// ═══════════════════════════════════════════════════════
// HOME
// ═══════════════════════════════════════════════════════
async function goHome() {
  showPage('home');
  if (heroList.length) return;
  jikan('/top/anime?filter=airing&limit=5').then(d => {
    if (!d?.data?.length) return;
    heroList = d.data;
    renderHero(0);
    document.getElementById('hero-inds').innerHTML = heroList.map((_, i) =>
      '<div class="ind ' + (i === 0 ? 'active' : '') + '" onclick="renderHero(' + i + ')"></div>'
    ).join('');
    setInterval(() => renderHero((heroIdx + 1) % heroList.length), 6000);
  });
  document.getElementById('grid-recent').innerHTML = skels(6);
  jikan('/seasons/now?limit=12').then(d => {
    if (!d?.data) return;
    document.getElementById('grid-recent').innerHTML = d.data.slice(0, 6).map(card).join('');
  }).catch(() => {});
  document.getElementById('list-trending').innerHTML = skels(5);
  jikan('/top/anime?limit=5').then(d => {
    if (!d?.data) return;
    document.getElementById('list-trending').innerHTML = d.data.map((a, i) => {
      const img = a.images?.jpg?.image_url || '';
      const title = a.title_english || a.title || '';
      const score = a.score ? a.score.toFixed(1) : 'N/A';
      return '<div class="trend-item" onclick="openById(' + a.mal_id + ')">' +
        '<span class="trend-num">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<img src="' + img + '" class="trend-thumb" loading="lazy" onerror="this.src=\'https://picsum.photos/seed/' + a.mal_id + '/100/140\'">' +
        '<div class="trend-info"><div class="trend-title">' + title + '</div>' +
        '<div class="trend-meta"><span>&#9733; ' + score + '</span><span>' + (a.episodes || '?') + ' eps</span></div></div>' +
        '</div>';
    }).join('');
  }).catch(() => {});
  document.getElementById('grid-toprated').innerHTML = skels(6);
  jikan('/top/anime?limit=6').then(d => {
    if (!d?.data) return;
    document.getElementById('grid-toprated').innerHTML = d.data.map(card).join('');
  }).catch(() => {});
}

function renderHero(idx) {
  heroIdx = idx;
  const a = heroList[idx];
  if (!a) return;
  currentAnime = a;
  const img = a.images?.jpg?.large_image_url || '';
  document.getElementById('hero-bg').style.cssText = 'background:linear-gradient(to right,rgba(8,11,17,.95) 35%,rgba(8,11,17,.3) 70%,transparent 100%),linear-gradient(to top,rgba(8,11,17,1) 0%,transparent 50%),url(\'' + img + '\') center/cover no-repeat;';
  const words = (a.title_english || a.title || '').toUpperCase().split(' ');
  const half = Math.ceil(words.length / 2);
  document.getElementById('hero-title').innerHTML = words.slice(0, half).join(' ') + '<br><span>' + words.slice(half).join(' ') + '</span>';
  document.getElementById('hero-desc').textContent = (a.synopsis || '').slice(0, 180) + '...';
  const genres = (a.genres || []).slice(0, 3).map(g => g.name).join(' · ');
  document.getElementById('hero-meta').innerHTML =
    '<span class="badge-ep">' + (a.episodes ? 'EP ' + a.episodes : 'Ongoing') + '</span>' +
    '<span class="badge-sub">SUB</span>' +
    (a.score ? '<span class="dot"></span><span>&#9733; ' + a.score.toFixed(1) + '</span>' : '') +
    (a.year ? '<span class="dot"></span><span>' + a.year + '</span>' : '') +
    (genres ? '<span class="dot"></span><span>' + genres + '</span>' : '');
  document.querySelectorAll('.ind').forEach((el, i) => el.classList.toggle('active', i === idx));
}
function openHeroDetail() { if (currentAnime) openById(currentAnime.mal_id); }

// ═══════════════════════════════════════════════════════
// BROWSE
// ═══════════════════════════════════════════════════════
function goBrowse(type, label) {
  browseType = type; browseGenre = 0; browsePage = 1;
  document.getElementById('browse-title').textContent = label || 'All Anime';
  document.querySelectorAll('#type-filters .filter-btn').forEach(b => b.classList.remove('active'));
  showPage('browse'); loadBrowse(true);
}
function goBrowseGenre(gid, label) {
  browseGenre = gid; browseType = ''; browsePage = 1;
  document.getElementById('browse-title').textContent = label + ' Anime';
  document.querySelectorAll('.genre-tag').forEach(t => t.classList.toggle('active', t.textContent.trim() === label));
  showPage('browse'); loadBrowse(true);
}
function setType(type) { browseType = type; browsePage = 1; loadBrowse(true); }
function setGenre(gid, label) {
  browseGenre = gid; browsePage = 1;
  document.querySelectorAll('.genre-tag').forEach(t => t.classList.toggle('active', t.textContent.trim() === label));
  document.getElementById('browse-title').textContent = (label === 'All Genres' ? 'All' : label) + ' Anime';
  loadBrowse(true);
}
async function loadBrowse(reset = false) {
  const grid = document.getElementById('browse-grid');
  if (reset) grid.innerHTML = skels(12);
  const path = browseGenre ? '/anime?genres=' + browseGenre + '&order_by=score&sort=desc&limit=20&page=' + browsePage
    : browseType ? '/anime?type=' + browseType + '&order_by=score&sort=desc&limit=20&page=' + browsePage
      : '/top/anime?limit=20&page=' + browsePage;
  try {
    const d = await jikan(path);
    if (reset) grid.innerHTML = '';
    else grid.querySelectorAll('.sk').forEach(s => s.remove());
    if (!d?.data?.length) { if (reset) grid.innerHTML = '<p style="color:var(--muted);padding:20px">No results.</p>'; return; }
    grid.innerHTML += d.data.map(card).join('');
    document.getElementById('load-more-btn').style.display = d.pagination?.has_next_page !== false ? '' : 'none';
  } catch(e) { if (reset) grid.innerHTML = '<p style="color:var(--muted);padding:20px">Failed to load.</p>'; }
}
async function loadMore() {
  browsePage++;
  const grid = document.getElementById('browse-grid');
  grid.innerHTML += skels(8);
  const path = browseGenre ? '/anime?genres=' + browseGenre + '&order_by=score&sort=desc&limit=20&page=' + browsePage
    : browseType ? '/anime?type=' + browseType + '&order_by=score&sort=desc&limit=20&page=' + browsePage
      : '/top/anime?limit=20&page=' + browsePage;
  try {
    const d = await jikan(path);
    grid.querySelectorAll('.sk').forEach(s => s.remove());
    if (d?.data) grid.innerHTML += d.data.map(card).join('');
    if (!d?.pagination?.has_next_page) document.getElementById('load-more-btn').style.display = 'none';
  } catch(e) { grid.querySelectorAll('.sk').forEach(s => s.remove()); }
}

// ═══════════════════════════════════════════════════════
// DETAIL
// ═══════════════════════════════════════════════════════
async function openById(id) {
  showPage('detail');
  document.getElementById('detail-title').textContent = 'Loading...';
  document.getElementById('detail-desc').textContent = '';
  document.getElementById('detail-genres').innerHTML = '';
  document.getElementById('detail-stats').innerHTML = '';
  document.getElementById('ep-grid').innerHTML = skels(12);
  try {
    const d = await jikan('/anime/' + id + '/full');
    if (d?.data) { currentAnime = d.data; loadDetail(d.data); }
  } catch(e) { showToast('Failed to load details', true); }
}

function loadDetail(a) {
  currentAnime = a;
  const img = a.images?.jpg?.large_image_url || a.images?.jpg?.image_url || '';
  document.getElementById('detail-img').src = img;
  document.getElementById('detail-bg').style.cssText = 'background:linear-gradient(to right,rgba(8,11,17,1) 40%,rgba(8,11,17,.5) 80%),linear-gradient(to top,rgba(8,11,17,1) 0%,transparent 40%),url(\'' + img + '\') center/cover no-repeat;';
  document.getElementById('detail-title').textContent = a.title_english || a.title || '-';
  document.getElementById('detail-alt').textContent = a.title_japanese || '';
  document.getElementById('detail-genres').innerHTML = (a.genres || []).slice(0, 5).map(g => '<span class="genre-pill">' + g.name + '</span>').join('');
  const score = a.score ? a.score.toFixed(1) : 'N/A';
  const eps = a.episodes || '?';
  const year = a.year || a.aired?.prop?.from?.year || '-';
  document.getElementById('detail-stats').innerHTML =
    '<div class="stat-item"><div class="detail-score">&#9733; ' + score + '</div><div class="stat-label">Score</div></div>' +
    '<div class="stat-item"><div class="stat-val">' + eps + '</div><div class="stat-label">Episodes</div></div>' +
    '<div class="stat-item"><div class="stat-val">' + year + '</div><div class="stat-label">Year</div></div>' +
    '<div class="stat-item"><div class="stat-val">' + (a.type || 'TV') + '</div><div class="stat-label">Type</div></div>' +
    '<div class="stat-item"><div class="stat-val">' + (a.status === 'Currently Airing' ? 'Airing' : 'Done') + '</div><div class="stat-label">Status</div></div>';
  const syn = a.synopsis || 'No synopsis available.';
  document.getElementById('detail-desc').textContent = syn.length > 420 ? syn.slice(0, 420) + '...' : syn;
  totalEps = typeof eps === 'number' ? eps : 24;
  const count = Math.min(totalEps, 100);
  document.getElementById('ep-grid').innerHTML = Array.from({ length: count }, (_, i) =>
    '<div class="ep-btn" id="ep-btn-' + (i + 1) + '" onclick="goPlayerEp(' + (i + 1) + ')">' + String(i + 1).padStart(2, '0') + '</div>'
  ).join('');
  document.getElementById('player-ep-list').innerHTML = Array.from({ length: count }, (_, i) =>
    '<div class="ep-item" id="pep-' + (i + 1) + '" onclick="goPlayerEp(' + (i + 1) + ')">' +
    '<span class="ep-num">' + String(i + 1).padStart(2, '0') + '</span>' +
    '<div class="ep-item-thumb">EP ' + (i + 1) + '</div>' +
    '<div class="ep-item-info"><div class="ep-item-title">Episode ' + (i + 1) + '</div><div class="ep-item-dur">~24 min</div></div>' +
    '</div>'
  ).join('');
  refreshDetailButtons();
}

// ═══════════════════════════════════════════════════════
// PLAYER — Navigation
// ═══════════════════════════════════════════════════════
function goPlayer() {
  const prog = watchProgress[String(currentAnime?.mal_id)];
  goPlayerEp(prog ? prog.ep : 1);
}

function goPlayerEp(ep) {
  currentEp = ep;
  isPlaying = false;
  if (playTimer) { clearInterval(playTimer); playTimer = null; }
  fakeProgress = 0;
  const title = currentAnime ? (currentAnime.title_english || currentAnime.title) : 'Anime';
  document.getElementById('player-title').innerHTML = title + ' <span>· Episode ' + ep + '</span>';
  document.querySelectorAll('.ep-item').forEach(el => el.classList.remove('current'));
  const cur = document.getElementById('pep-' + ep);
  if (cur) { cur.classList.add('current'); cur.scrollIntoView({ block: 'nearest' }); }
  showPage('player');
  streamLoad(ep);
}

function prevEp() { if (currentEp > 1) goPlayerEp(currentEp - 1); }
function nextEp() { if (currentEp < Math.min(totalEps || 24, 100)) goPlayerEp(currentEp + 1); }

// ═══════════════════════════════════════════════════════
// PLAYER — Streaming engine
// ═══════════════════════════════════════════════════════

// UI helpers
function streamSetLoading(msg) {
  document.getElementById('stream-loading').style.display = 'flex';
  document.getElementById('loading-label').textContent = msg || 'Finding stream...';
  document.getElementById('real-video').style.display = 'none';
  document.getElementById('stream-iframe').style.display = 'none';
  document.getElementById('no-stream').style.display = 'none';
  document.getElementById('stream-status').textContent = '';
  document.getElementById('download-btn').style.display = 'none';
}

function streamShowVideo(url, quality) {
  destroyHLS();
  document.getElementById('stream-loading').style.display = 'none';
  document.getElementById('no-stream').style.display = 'none';
  document.getElementById('stream-iframe').style.display = 'none';
  const v = document.getElementById('real-video');
  v.style.display = 'block';
  v.src = url;
  v.play().catch(() => {});
  streamSetStatus('● ' + (quality || 'Live'), 'var(--green)');
  streamSetDownload(url);
  streamTrackProgress();
}

function streamShowIframe(url) {
  destroyHLS();
  document.getElementById('stream-loading').style.display = 'none';
  document.getElementById('no-stream').style.display = 'none';
  document.getElementById('real-video').style.display = 'none';
  const f = document.getElementById('stream-iframe');
  f.src = url;
  f.style.display = 'block';
  streamSetStatus('● Embedded', 'var(--blue)');
}

function streamShowError(msg) {
  destroyHLS();
  document.getElementById('stream-loading').style.display = 'none';
  document.getElementById('real-video').style.display = 'none';
  document.getElementById('stream-iframe').style.display = 'none';
  document.getElementById('no-stream').style.display = 'flex';
  document.getElementById('no-stream-msg').textContent = msg || 'Stream unavailable.';
  streamSetStatus('● Offline', 'var(--accent)');
}

function streamSetStatus(text, color) {
  const el = document.getElementById('stream-status');
  el.textContent = text;
  el.style.color = color;
}

function streamSetDownload(url) {
  if (!url) return;
  const btn = document.getElementById('download-btn');
  btn.style.display = 'flex';
  btn.href = url;
  const title = (currentAnime?.title_english || currentAnime?.title || 'anime').replace(/[^a-z0-9]/gi, '_');
  btn.download = title + '_ep' + currentEp + '.mp4';
}

function streamTrackProgress() {
  const v = document.getElementById('real-video');
  // Clone to remove old listeners
  const nv = v.cloneNode(true);
  v.parentNode.replaceChild(nv, v);
  nv.addEventListener('timeupdate', () => {
    if (!nv.duration || !currentAnime) return;
    const pct = Math.round((nv.currentTime / nv.duration) * 100);
    if (pct % 5 === 0) saveProgress(currentAnime.mal_id, currentEp, pct);
  });
  nv.addEventListener('ended', () => {
    if (currentAnime) saveProgress(currentAnime.mal_id, currentEp, 100);
    showToast('Episode ' + currentEp + ' complete! ✓');
    setTimeout(() => { if (currentEp < Math.min(totalEps || 24, 100)) nextEp(); }, 2000);
  });
}

// HLS loader
async function streamLoadHLS(m3u8url, fallbackSources, downloadUrl) {
  const v = document.getElementById('real-video');

  // iOS Safari — native HLS but our proxy URLs need special handling
  // Use a blob URL trick to feed the m3u8 to native player
  if (v.canPlayType('application/vnd.apple.mpegurl')) {
    // On iOS, fetch the proxied m3u8 and create a blob URL
    // This makes iOS native HLS treat it as a local resource
    try {
      const resp = await fetch(m3u8url);
      const text = await resp.text();
      const blob = new Blob([text], { type: 'application/vnd.apple.mpegurl' });
      const blobUrl = URL.createObjectURL(blob);
      streamShowVideo(blobUrl, 'HLS');
    } catch(e) {
      // Fallback — try direct
      streamShowVideo(m3u8url, 'HLS');
    }
    if (downloadUrl) streamSetDownload(downloadUrl);
    return;
  }
  // Load hls.js lazily
  if (!window.Hls) {
    await new Promise((res, rej) => {
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.7/dist/hls.min.js';
      s.onload = res; s.onerror = rej;
      document.head.appendChild(s);
    });
  }
  if (!Hls.isSupported()) {
    const mp4 = fallbackSources?.find(s => !s.url?.includes('.m3u8'));
    if (mp4) streamShowVideo(mp4.url, mp4.quality);
    else throw new Error('HLS not supported');
    return;
  }
  destroyHLS();
  document.getElementById('stream-loading').style.display = 'none';
  document.getElementById('no-stream').style.display = 'none';
  document.getElementById('stream-iframe').style.display = 'none';
  const nv = document.getElementById('real-video');
  nv.style.display = 'block';
  hlsInstance = new Hls({ maxBufferLength: 30, enableWorker: true });
  hlsInstance.loadSource(m3u8url);
  hlsInstance.attachMedia(nv);
  hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
    nv.play().catch(() => {});
    streamSetStatus('● HLS Live', 'var(--green)');
  });
  hlsInstance.on(Hls.Events.ERROR, (_, d) => {
    if (d.fatal) {
      const mp4 = fallbackSources?.find(s => !s.url?.includes('.m3u8'));
      if (mp4) streamShowVideo(mp4.url, mp4.quality);
      else streamShowError('HLS stream error. Try another server.');
    }
  });
  streamSetDownload(downloadUrl || fallbackSources?.find(s => !s.url?.includes('.m3u8'))?.url);
  streamTrackProgress();
}

function destroyHLS() {
  if (hlsInstance) { try { hlsInstance.destroy(); } catch(e) {} hlsInstance = null; }
}

// ─── Proxy result handler ──────────────────────────────────────
// Detect iOS — use iframe player instead of native video
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;

async function handleProxyResult(data, ep) {
  if (!data) throw new Error('No response from proxy');
  if (data.error) throw new Error(data.error);

  // iOS — Miruro blocks iframes, open in new tab instead
  if (isIOS && currentAnime?.mal_id) {
    const malId = currentAnime.mal_id;
    const url = `https://www.miruro.tv/watch?id=${malId}&ep=${ep}`;
    streamShowError('Tap below to watch on iOS');
    document.getElementById('no-stream-msg').innerHTML =
      `<a href="${url}" target="_blank" style="color:#4cc9f0;font-size:15px;font-weight:700;padding:12px 24px;background:rgba(76,201,240,.15);border:1px solid rgba(76,201,240,.4);border-radius:8px;display:inline-block;margin-top:8px;">▶ Open Player</a>`;
    if (currentAnime) saveProgress(malId, ep, 0);
    return;
  }

  if (data.isEmbed && data.embedUrl) {
    streamShowIframe(data.embedUrl);
    if (currentAnime) saveProgress(currentAnime.mal_id, ep, 0);
    showToast('Streaming via ' + (data.provider || 'Embed'));
    return;
  }
  const sources = data.sources || [];
  if (!sources.length) throw new Error('No video sources');
  const best = bestQuality(sources);
  if (!best?.url) throw new Error('No valid URL');
  streamSetLoading((data.provider || 'Loading') + ' · Starting...');
  if (best.isM3U8 || (best.url||'').includes('.m3u8')) {
    await streamLoadHLS(best.url, sources, null);
  } else {
    streamShowVideo(best.url, best.quality || '720p');
  }
  if (currentAnime) saveProgress(currentAnime.mal_id, ep, 0);
  showToast('Streaming via ' + data.provider);
}

// ─── Stream sources ────────────────────────────────────────────
const STREAM_SOURCES = [
  {
    label: 'Auto',
    fn: async (title, ep) => {
      streamSetLoading('Finding stream...');
      const malId = currentAnime?.mal_id || '';
      const searchTitle = currentAnime?.title_english || currentAnime?.title || title;
      const data = await proxyFetch(`/api/sources?title=${encodeURIComponent(searchTitle)}&ep=${ep}&malId=${malId}`);
      await handleProxyResult(data, ep);
    }
  },
  {
    label: 'AnimePahe',
    fn: async (title, ep) => {
      streamSetLoading('AnimePahe · Searching...');
      const malId = currentAnime?.mal_id || '';
      const searchTitle = currentAnime?.title_english || currentAnime?.title || title;
      const data = await proxyFetch(`/api/sources?title=${encodeURIComponent(searchTitle)}&ep=${ep}&malId=${malId}`);
      await handleProxyResult(data, ep);
    }
  },
  {
    label: 'AnimeKai',
    fn: async (title, ep) => {
      streamSetLoading('AnimeKai · Searching...');
      const malId = currentAnime?.mal_id || '';
      const searchTitle = currentAnime?.title_english || currentAnime?.title || title;
      const data = await proxyFetch(`/api/sources?title=${encodeURIComponent(searchTitle)}&ep=${ep}&malId=${malId}`);
      await handleProxyResult(data, ep);
    }
  },
  {
    label: 'Miruro',
    fn: async (title, ep) => {
      streamSetLoading('Miruro · Loading...');
      if (!currentAnime?.mal_id) throw new Error('No mal_id');
      streamShowIframe(`https://www.miruro.tv/watch?id=${currentAnime.mal_id}&ep=${ep}`);
      if (currentAnime) saveProgress(currentAnime.mal_id, ep, 0);
    }
  },
]
// ─── Waterfall loader ─────────────────────────────────────────────────────
async function streamLoad(ep) {
  streamSetLoading('Finding stream...');

  // If user picked a specific server manually
  if (forcedServerIdx !== null) {
    const src = STREAM_SOURCES[forcedServerIdx] || STREAM_SOURCES[0];
    try {
      await src.fn(currentAnime?.title_english || currentAnime?.title, ep);
    } catch(e) {
      console.warn('[' + src.label + '] failed:', e.message);
      streamShowError(src.label + ' failed. Try another server.');
    }
    return;
  }

  // Auto: try each source in order
  const title = currentAnime?.title_english || currentAnime?.title;
  if (!title) { streamShowError('No anime title found.'); return; }

  for (let i = 0; i < STREAM_SOURCES.length; i++) {
    activeServerIdx = i;
    const src = STREAM_SOURCES[i];
    // Highlight active button
    document.querySelectorAll('.server-btn').forEach((b, bi) => b.classList.toggle('active', bi === 0)); // keep Auto highlighted
    try {
      await src.fn(title, ep);
      showToast('Streaming via ' + src.label);
      return; // success — stop
    } catch(e) {
      console.warn('[' + src.label + '] failed:', e.message);
      if (i < STREAM_SOURCES.length - 1) {
        streamSetLoading(src.label + ' unavailable · Trying ' + STREAM_SOURCES[i + 1].label + '...');
        await sleep(300);
      }
    }
  }
  streamShowError('All sources failed for this episode. It may not be available yet, or try a different server.');
}

// Server button click handler
function switchServer(idx, btn) {
  forcedServerIdx = idx === 0 ? null : (idx - 1); // btn 0 = Auto, btn 1 = source[0], etc.
  document.querySelectorAll('.server-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  destroyHLS();
  const v = document.getElementById('real-video');
  v.pause(); v.src = '';
  document.getElementById('stream-iframe').src = 'about:blank';
  streamLoad(currentEp);
}

function tryNextServer() {
  const next = (activeServerIdx + 1) % STREAM_SOURCES.length;
  forcedServerIdx = next;
  activeServerIdx = next;
  destroyHLS();
  document.getElementById('stream-iframe').src = 'about:blank';
  // Highlight the right btn (offset by 1 because btn[0]=Auto)
  document.querySelectorAll('.server-btn').forEach((b, i) => b.classList.toggle('active', i === next + 1));
  streamLoad(currentEp);
}

// ═══════════════════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════════════════
let searchTimer;
const sinput = document.getElementById('search-input');
const sdd = document.getElementById('search-dd');
sinput.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = sinput.value.trim();
  if (!q) { sdd.classList.remove('open'); return; }
  sdd.classList.add('open');
  sdd.innerHTML = '<div class="search-msg">Searching...</div>';
  searchTimer = setTimeout(() => doSearch(q), 500);
});
sinput.addEventListener('keydown', e => { if (e.key === 'Escape') { sdd.classList.remove('open'); sinput.blur(); } });
async function doSearch(q) {
  try {
    const d = await jikan('/anime?q=' + encodeURIComponent(q) + '&limit=7&sfw=true');
    if (!d?.data?.length) { sdd.innerHTML = '<div class="search-msg">No results.</div>'; return; }
    sdd.innerHTML = d.data.map(a => {
      const img = a.images?.jpg?.image_url || '';
      const title = a.title_english || a.title || '';
      const meta = [a.score ? '&#9733; ' + a.score.toFixed(1) : '', a.year || '', a.type || ''].filter(Boolean).join(' · ');
      return '<div class="sri" onclick="sdd.classList.remove(\'open\');openById(' + a.mal_id + ')">' +
        '<img src="' + img + '" onerror="this.style.background=\'var(--bg3)\'">' +
        '<div><div class="sri-title">' + title + '</div><div class="sri-meta">' + meta + '</div></div>' +
        '</div>';
    }).join('');
  } catch(e) { sdd.innerHTML = '<div class="search-msg">Search failed.</div>'; }
}

// ═══════════════════════════════════════════════════════
// MISC
// ═══════════════════════════════════════════════════════
function activateTab(el) {
  el.closest('.sidebar-tabs').querySelectorAll('.sidebar-tab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
}
document.addEventListener('click', e => {
  if (e.target.classList.contains('filter-btn') && e.target.closest('#type-filters')) {
    document.querySelectorAll('#type-filters .filter-btn').forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
  }
});

// ═══════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════
initAuth();
goHome();
