import { createSearchIndex, searchRecipes, normalizeText } from './lib/search.mjs';
import { createUserStore } from './lib/storage.mjs';

const $ = (id) => document.getElementById(id);
const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
const icon = (name) => '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
const PAGE_SIZE = 24;
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
let book, searchIndex, userStore, recipesById, categoriesById;
let activeView = 'search';
let searchState = { query: '', categoryId: '', subcategoryId: '', mode: 'all', sort: 'relevance' };
let savedTab = 'favorites';
let resultLimit = PAGE_SIZE;
let currentRecipeId = null;
let previousHash = '';
let lastBaseHash = '#/search';
let canCloseWithBack = false;
let searchTimer, noteTimer, toastTimer;
let pendingNote = null;
let deferredInstall = null;
let serviceWorkerRegistration = null;
let offlineReady = false;
let offlineError = '';
let sourcePdfCached = false;
let reloadForUpdate = false;
let dataLoading = false;

function toast(message, duration = 3600) {
  clearTimeout(toastTimer);
  $('toast').textContent = message;
  $('toast').hidden = false;
  // Toasts belong inside an open dialog's top layer so they remain visible.
  const host = $('recipeDialog').open ? $('recipeDialog') : document.body;
  host.appendChild($('toast'));
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, duration);
}

function reportPersistence(result) {
  if (result && result.persisted === false) toast('Trình duyệt chưa lưu được lâu dài. Bạn có thể xuất bản sao để giữ dữ liệu.', 6000);
}

function applyPreferences() {
  if (!userStore) return;
  const settings = userStore.state.settings;
  const dark = settings.theme === 'dark' || (settings.theme === 'system' && systemTheme.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.documentElement.style.setProperty('--reading-size', settings.fontSize + 'px');
  $('themeSelect').value = settings.theme;
  $('fontValue').textContent = settings.fontSize;
  $('fontSmaller').disabled = settings.fontSize <= 16;
  $('fontLarger').disabled = settings.fontSize >= 26;
  document.querySelector('meta[name="theme-color"]').content = dark ? '#1c2822' : '#145644';
}

function buildSearchHash(options = searchState) {
  const p = new URLSearchParams();
  if (options.query) p.set('q', options.query);
  if (options.categoryId) p.set('nhom', options.categoryId);
  if (options.subcategoryId) p.set('muc', options.subcategoryId);
  if (options.mode && options.mode !== 'all') p.set('tim', options.mode);
  if (options.sort === 'book') p.set('sapxep', 'book');
  return '#/search' + (p.size ? '?' + p.toString() : '');
}

function rememberSearchURL() {
  if (activeView !== 'search' || currentRecipeId) return;
  const hash = buildSearchHash();
  history.replaceState(null, '', hash);
  previousHash = hash;
  lastBaseHash = hash;
}

function pageLabel(recipe) {
  return recipe.startPage === recipe.endPage ? 'Trang ' + recipe.startPage : 'Trang ' + recipe.startPage + '–' + recipe.endPage;
}

function recipeCard(recipe, notes = false) {
  const saved = userStore.state.favorites.includes(recipe.id);
  const q = normalizeText(searchState.query.replace(/["“”]/g, ''));
  let names = recipe.ingredients.map((x) => x.name);
  if (q && activeView === 'search') names = [...names].sort((a,b) => Number(normalizeText(b).includes(q)) - Number(normalizeText(a).includes(q)));
  const first = names.slice(0,3);
  let ingredients = first.map((n) => '<span>' + escapeHTML(n) + '</span>').join('');
  if (names.length > 3) ingredients += '<span>+' + (names.length - 3) + ' vị</span>';
  const note = notes ? userStore.state.notes[recipe.id] : '';
  const href = '#/recipe/' + encodeURIComponent(recipe.id);
  return '<article class="recipe-card">' +
    '<button type="button" class="icon-button card-save" data-save="' + escapeHTML(recipe.id) + '" aria-pressed="' + saved + '" aria-label="' + (saved ? 'Bỏ đánh dấu ' : 'Đánh dấu ') + escapeHTML(recipe.title + ', ' + recipe.categoryName + ', trang ' + recipe.startPage) + '">' + icon('save') + '</button>' +
    '<a class="recipe-card-link" href="' + href + '">' +
    '<div class="card-meta"><span class="category-pill">' + escapeHTML(recipe.categoryName) + '</span><span class="page-ref">' + escapeHTML(pageLabel(recipe)) + '</span></div>' +
    '<h3>' + escapeHTML(recipe.title) + '</h3>' +
    '<span class="usage-label">Công dụng ghi trong sách</span>' +
    '<p class="card-usage">' + escapeHTML(recipe.usageSummary || 'Sách không ghi riêng mục công dụng cho bài này.') + '</p>' +
    (ingredients ? '<div class="ingredient-preview">' + ingredients + '</div>' : '') +
    (note ? '<p class="card-note">' + escapeHTML(note.slice(0,180)) + '</p>' : '') +
    '</a></article>';
}

function emptyState(title, message, buttonText, href) {
  return '<div class="empty-state">' + icon('book') + '<h3>' + escapeHTML(title) + '</h3><p>' + escapeHTML(message) + '</p>' +
    (buttonText ? '<a class="button button-primary" href="' + href + '">' + escapeHTML(buttonText) + '</a>' : '') + '</div>';
}

function refreshSaveButtons() {
  const favorites = new Set(userStore.state.favorites);
  $('savedBadge').textContent = favorites.size;
  $('savedBadge').hidden = !favorites.size;
  document.querySelectorAll('[data-save]').forEach((button) => {
    const saved = favorites.has(button.dataset.save);
    const recipe = recipesById.get(button.dataset.save);
    button.setAttribute('aria-pressed', String(saved));
    if (recipe) button.setAttribute('aria-label', (saved ? 'Bỏ đánh dấu ' : 'Đánh dấu ') + recipe.title + ', ' + recipe.categoryName + ', trang ' + recipe.startPage);
  });
  if (currentRecipeId) {
    const saved = favorites.has(currentRecipeId);
    $('detailSave').setAttribute('aria-pressed', String(saved));
    $('detailSave').setAttribute('aria-label', saved ? 'Bỏ đánh dấu bài này' : 'Đánh dấu bài này');
  }
}

function refreshFilters() {
  $('categoryFilter').value = searchState.categoryId;
  const subsections = book.subcategories.filter((s) => s.categoryId === searchState.categoryId);
  $('subcategoryWrap').hidden = !subsections.length;
  $('subcategoryFilter').innerHTML = '<option value="">Tất cả mục</option>' + subsections.map((s) => '<option value="' + escapeHTML(s.id) + '">' + escapeHTML(s.name) + '</option>').join('');
  if (!subsections.some((s) => s.id === searchState.subcategoryId)) searchState.subcategoryId = '';
  $('subcategoryFilter').value = searchState.subcategoryId;
  $('sortFilter').value = searchState.sort;
  document.querySelectorAll('[data-mode]').forEach((button) => {
    const active = button.dataset.mode === searchState.mode;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $('clearSearch').hidden = !searchState.query;
  $('examples').hidden = !!searchState.query;
  $('resetFilters').hidden = !(searchState.query || searchState.categoryId || searchState.subcategoryId || searchState.mode !== 'all');
}

function renderSearch(resetLimit = true) {
  if (!book) return;
  if (resetLimit) resultLimit = PAGE_SIZE;
  refreshFilters();
  const results = searchRecipes(searchIndex, searchState);
  const querySuffix = searchState.query ? ' cho “' + searchState.query + '”' : '';
  $('resultCount').textContent = results.length + ' bài thuốc' + querySuffix;
  $('results').innerHTML = results.length
    ? results.slice(0,resultLimit).map((r) => recipeCard(r)).join('')
    : emptyState('Chưa tìm thấy nội dung phù hợp', 'Thử một từ ngắn hơn, đổi phạm vi tìm hoặc bỏ bộ lọc nhóm bệnh. Tên gọi trong sách có thể khác cách gọi hiện nay.', 'Xem toàn bộ thư viện', '#/search');
  $('loadMore').hidden = resultLimit >= results.length;
  $('loadMore').textContent = 'Xem thêm ' + Math.min(PAGE_SIZE, Math.max(0,results.length-resultLimit)) + ' bài';
  refreshSaveButtons();
}

function renderCategories() {
  $('categoriesGrid').innerHTML = book.categories.map((category) =>
    '<a class="category-card" href="' + buildSearchHash({categoryId:category.id}) + '">' +
    '<span class="category-icon">' + icon('leaf') + '</span><div><h2>' + escapeHTML(category.name) + '</h2><p>' +
    category.recipeCount + ' bài thuốc · Trang ' + category.startPage + '–' + category.endPage +
    '</p><p class="part-title">' + escapeHTML(category.partTitle) +
    (category.subcategoryIds.length ? ' · ' + category.subcategoryIds.length + ' mục' : '') + '</p></div></a>'
  ).join('');
}

function renderSaved() {
  let recipes;
  const state = userStore.state;
  if (savedTab === 'recent') recipes = state.recent.map((id) => recipesById.get(id)).filter(Boolean);
  else if (savedTab === 'notes') recipes = book.recipes.filter((r) => state.notes[r.id]?.trim());
  else recipes = book.recipes.filter((r) => state.favorites.includes(r.id));
  document.querySelectorAll('[data-saved-tab]').forEach((button) => {
    const active = button.dataset.savedTab === savedTab;
    button.classList.toggle('active',active);
    button.setAttribute('aria-pressed',String(active));
  });
  $('savedCount').textContent = recipes.length + ' bài ' + (savedTab === 'recent' ? 'vừa xem' : savedTab === 'notes' ? 'có ghi chú' : 'đã đánh dấu');
  $('savedResults').innerHTML = recipes.length ? recipes.map((r) => recipeCard(r,savedTab === 'notes')).join('') :
    emptyState(savedTab === 'favorites' ? 'Chưa có bài đã đánh dấu' : savedTab === 'notes' ? 'Chưa có ghi chú' : 'Chưa có bài vừa xem',
      savedTab === 'favorites' ? 'Chạm biểu tượng đánh dấu trên một bài để tìm lại ở đây.' : savedTab === 'notes' ? 'Mở một bài và viết vào ô Ghi chú riêng ở cuối trang.' : 'Những bài đã mở gần đây sẽ xuất hiện ở đây.', 'Mở thư viện', '#/search');
  refreshSaveButtons();
}

function showView(view) {
  activeView = view;
  for (const section of document.querySelectorAll('.view')) section.hidden = section.id !== 'view-' + view;
  document.querySelectorAll('.nav-item').forEach((link) => {
    const active = link.dataset.view === view;
    link.classList.toggle('active',active);
    if (active) link.setAttribute('aria-current','page');
    else link.removeAttribute('aria-current');
  });
  if (view === 'search') { $('searchInput').value = searchState.query; renderSearch(); }
  if (view === 'categories') renderCategories();
  if (view === 'saved') renderSaved();
  if (view === 'settings') { applyPreferences(); refreshOfflineStatus(); }
  document.title = (view === 'settings' ? 'Tùy chọn' : view === 'saved' ? 'Đã lưu' : view === 'categories' ? 'Nhóm bệnh' : 'Tra cứu') + ' · Bài thuốc quý';
}

function flushNote() {
  clearTimeout(noteTimer);
  if (!pendingNote || !userStore) return;
  const note = pendingNote;
  pendingNote = null;
  try {
    const result = userStore.setNote(note.id,note.text);
    if (currentRecipeId === note.id) $('noteStatus').textContent = result.persisted ? 'Đã lưu' : 'Tạm lưu trong phiên này';
    reportPersistence(result);
  } catch (error) {
    pendingNote = note;
    $('noteStatus').textContent = 'Chưa lưu được';
    toast(error.message || 'Chưa lưu được ghi chú. Hãy giữ lại nội dung trước khi đóng.',6000);
  }
}

function openDetail(recipe) {
  if (currentRecipeId !== recipe.id) flushNote();
  if (pendingNote) return false;
  currentRecipeId = recipe.id;
  const category = categoriesById.get(recipe.categoryId);
  const sourceLinks = recipe.sourcePages.map((page) => '<a href="/source/book.pdf#page=' + page + '" target="_blank" rel="noopener" aria-label="Mở PDF gốc tại trang ' + page + '">Trang ' + page + '</a>').join('');
  const ingredientRows = recipe.ingredients.map((ing) => '<tr><td><button type="button" class="ingredient-link" data-ingredient="' + escapeHTML(ing.name) + '" title="Tra vị thuốc này trong sách">' + escapeHTML(ing.name) + '</button></td><td>' + escapeHTML(ing.quantity || 'Không ghi') + '</td></tr>').join('');
  const sections = recipe.sections.map((section) => {
    const label = section.kind === 'uses' ? 'Công dụng ghi trong sách' : section.kind === 'dosage' ? 'Liều dùng ghi trong sách' : section.label;
    return '<section class="' + (section.kind === 'uses' ? 'section-uses' : 'book-section') + '"><h2>' + escapeHTML(label) + '</h2><p>' + escapeHTML(section.text) + '</p></section>';
  }).join('');
  const sourceNotes = recipe.sourceNotes?.length ? '<div class="source-notes"><strong>Lưu ý khi đối chiếu tài liệu</strong>' + recipe.sourceNotes.map((n) => '<p>' + escapeHTML(n) + '</p>').join('') + '</div>' : '';
  $('detailContent').innerHTML =
    '<a class="detail-category" href="' + buildSearchHash({categoryId:recipe.categoryId}) + '">' + escapeHTML(category.name) + '</a>' +
    '<h1 id="detailTitle">' + escapeHTML(recipe.title) + '</h1>' +
    (recipe.subcategory ? '<p class="detail-subcategory">' + escapeHTML(recipe.subcategory) + '</p>' : '') +
    '<div class="detail-reference"><span>Đối chiếu PDF gốc:</span>' + sourceLinks + '</div>' +
    '<p class="source-purpose">Trích nội dung cuốn sách để tham khảo. Chưa được thẩm định y khoa trong ứng dụng; không dùng thay cho hướng dẫn của người hành nghề y.</p>' +
    '<div class="reading-body">' +
    (ingredientRows ? '<h2>Thành phần theo sách</h2><table class="ingredients-table"><thead><tr><th scope="col">Vị thuốc</th><th scope="col">Số lượng</th></tr></thead><tbody>' + ingredientRows + '</tbody></table>' : '') +
    (recipe.ingredientNotes ? '<p>' + escapeHTML(recipe.ingredientNotes) + '</p>' : '') +
    sections +
    (!recipe.sections.some((s) => s.kind === 'dosage') ? '<p class="muted small">Nguồn không ghi riêng mục liều dùng cho bài này.</p>' : '') +
    '</div>' + sourceNotes +
    '<details class="original-text"><summary>Xem nguyên văn nội dung đã chuyển từ sách</summary><div class="original-lines">' + escapeHTML(recipe.sourceText) + '</div></details>';
  $('recipeNote').value = userStore.state.notes[recipe.id] || '';
  $('noteStatus').textContent = $('recipeNote').value ? (userStore.persistent ? 'Đã lưu trên thiết bị' : 'Tạm lưu trong phiên này') : '';
  $('previousRecipe').disabled = recipe.ordinal <= 1;
  $('nextRecipe').disabled = recipe.ordinal >= book.recipes.length;
  if (!$('recipeDialog').open) $('recipeDialog').showModal();
  $('recipeDialog').scrollTop = 0;
  document.body.style.overflow = 'hidden';
  document.title = recipe.title + ' · ' + recipe.categoryName + ' · Bài thuốc quý';
  userStore.addRecent(recipe.id);
  refreshSaveButtons();
  return true;
}

function closeDetail() {
  flushNote();
  if (pendingNote) return;
  if (canCloseWithBack) history.back();
  else location.replace(lastBaseHash || '#/search');
}

function route() {
  if (!book) return;
  clearTimeout(searchTimer);
  flushNote();
  if (pendingNote) {
    // Preserve both the visible draft and its route if validation rejects a save.
    history.replaceState(null, '', previousHash || '#/recipe/' + currentRecipeId);
    canCloseWithBack = false;
    return;
  }
  const hash = location.hash || '#/search';
  const [path,qs = ''] = hash.replace(/^#\/?/,'').split('?');
  const params = new URLSearchParams(qs);
  const parts = path.split('/');
  if (parts[0] === 'recipe') {
    let id;
    try { id = decodeURIComponent(parts[1] || ''); } catch { id = ''; }
    const recipe = recipesById.get(id);
    if (!recipe) { toast('Không tìm thấy bài này trong phiên bản sách hiện tại.'); location.replace('#/search'); return; }
    if (!previousHash) { showView('search'); canCloseWithBack = false; }
    else if (!previousHash.startsWith('#/recipe/')) { lastBaseHash = previousHash; canCloseWithBack = true; }
    openDetail(recipe);
  } else {
    flushNote();
    currentRecipeId = null;
    if ($('recipeDialog').open) $('recipeDialog').close();
    document.body.style.overflow = '';
    document.body.appendChild($('toast'));
    const view = ['search','categories','saved','settings'].includes(parts[0]) ? parts[0] : 'search';
    if (view === 'search') {
      const categoryId = params.get('nhom') || '';
      const category = categoriesById.has(categoryId) ? categoryId : '';
      const mode = params.get('tim') || 'all';
      searchState = {query:(params.get('q') || '').slice(0,180),categoryId:category,
        subcategoryId:params.get('muc') || '',mode:['all','uses','ingredients'].includes(mode) ? mode : 'all',
        sort:params.get('sapxep') === 'book' ? 'book' : 'relevance'};
    }
    showView(view);
    lastBaseHash = hash;
    canCloseWithBack = false;
    if (!previousHash.startsWith('#/recipe/')) window.scrollTo({top:0,behavior:'instant'});
  }
  previousHash = hash;
}

function setSearch(update) {
  Object.assign(searchState,update);
  $('searchInput').value = searchState.query;
  renderSearch();
  rememberSearchURL();
}

function showInstallHelp() {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  $('installHelp').innerHTML = standalone ?
    '<p>Ứng dụng đang mở từ màn hình chính. Bạn có thể dùng lại biểu tượng này để tra cứu nhanh.</p>' : ios ?
    '<p>Mở đường dẫn bằng <strong>Safari</strong>, chạm <strong>Chia sẻ</strong>, chọn <strong>Thêm vào Màn hình chính</strong> rồi <strong>Thêm</strong>.</p><p>Nếu có lựa chọn “Mở dưới dạng ứng dụng web”, hãy bật lựa chọn đó.</p>' :
    '<p>Trong <strong>Chrome</strong>, mở menu <strong>⋮</strong>, chọn <strong>Cài đặt và tạo lối tắt → Cài đặt</strong>. Tên mục có thể là “Cài ứng dụng” hoặc “Thêm vào màn hình chính”.</p><p>Nếu đang mở từ ứng dụng nhắn tin, hãy mở đường dẫn bằng Chrome trước.</p>';
  $('installDialog').showModal();
}

async function installApp() {
  if (!deferredInstall) { showInstallHelp(); return; }
  try {
    await deferredInstall.prompt();
    const result = await deferredInstall.userChoice;
    deferredInstall = null;
    $('installTop').hidden = true;
    if (result.outcome === 'accepted') toast('Đã gửi yêu cầu cài ứng dụng.');
  } catch { showInstallHelp(); }
}

function updateNetworkUI() {
  const badge = $('networkBadge');
  badge.classList.toggle('ready',offlineReady && navigator.onLine);
  badge.classList.toggle('offline',!navigator.onLine);
  if (!navigator.onLine) badge.textContent = offlineReady ? 'Đang dùng offline' : 'Không có mạng';
  else badge.textContent = offlineReady ? 'Sẵn sàng offline' : book ? 'Thư viện đã mở' : 'Đang tải thư viện';
  $('offlineStatus').textContent = offlineError || (offlineReady ?
    'Nội dung chữ đã lưu xong. Bạn có thể tìm kiếm và mở bài khi không có mạng.' :
    ('serviceWorker' in navigator ? 'Chờ tải hoàn tất ở lần mở đầu để dùng ngoại tuyến.' : 'Trình duyệt này chưa hỗ trợ lưu ngoại tuyến. Vui lòng dùng Chrome hoặc Safari mới.'));
  $('sourceCacheStatus').textContent = sourcePdfCached ? 'PDF gốc đã có bản lưu ngoại tuyến trên thiết bị.' : 'PDF gốc khoảng 6 MB; thao tác này cần có mạng.';
  $('cacheSource').textContent = sourcePdfCached ? 'Tải lại PDF gốc' : 'Lưu PDF gốc để đọc offline';
}

async function refreshOfflineStatus() {
  if (!('serviceWorker' in navigator)) { updateNetworkUI(); return; }
  const worker = navigator.serviceWorker.controller || serviceWorkerRegistration?.active;
  if (!worker) { updateNetworkUI(); return; }
  try {
    const status = await new Promise((resolve) => {
      const channel = new MessageChannel();
      const timeout = setTimeout(() => { channel.port1.close(); resolve(null); },2000);
      channel.port1.onmessage = (event) => { clearTimeout(timeout); channel.port1.close(); resolve(event.data); };
      worker.postMessage({type:'GET_CACHE_STATUS',requestId:Date.now()},[channel.port2]);
    });
    if (status?.type === 'CACHE_STATUS') {
      offlineReady = !!status.offlineReady;
      sourcePdfCached = !!status.sourcePdfCached;
      if (offlineReady) offlineError = '';
    }
  } catch { /* A changing worker may not have a message port yet. */ }
  updateNetworkUI();
}

function updateAvailable() {
  if (serviceWorkerRegistration?.waiting) $('updateBar').hidden = false;
}

async function setupOffline() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) { updateNetworkUI(); return; }
  try {
    offlineError = '';
    serviceWorkerRegistration = await navigator.serviceWorker.register('/sw.js',{scope:'/'});
    updateAvailable();
    serviceWorkerRegistration.addEventListener('updatefound',() => {
      const worker = serviceWorkerRegistration.installing;
      worker?.addEventListener('statechange',() => {
        if (worker.state === 'installed') {
          if (navigator.serviceWorker.controller) updateAvailable();
          refreshOfflineStatus();
        }
      });
    });
    navigator.serviceWorker.addEventListener('controllerchange',() => {
      if (reloadForUpdate) { reloadForUpdate = false; location.reload(); }
      else refreshOfflineStatus();
    });
    navigator.serviceWorker.addEventListener('message',(event) => {
      if (event.data?.type === 'CACHE_READY') refreshOfflineStatus();
    });
    await navigator.serviceWorker.ready;
    await refreshOfflineStatus();
  } catch {
    offlineError = 'Chưa lưu được chế độ ngoại tuyến. Giữ kết nối mạng và mở lại ứng dụng để thử lại.';
    updateNetworkUI();
  }
}

async function cacheSourcePDF() {
  const button = $('cacheSource');
  if (!navigator.onLine && !sourcePdfCached) { toast('Cần có mạng ở lần tải PDF đầu tiên.'); return; }
  if (!navigator.serviceWorker?.controller) { toast('Chờ thư viện sẵn sàng offline, sau đó mở lại ứng dụng để tải PDF.'); return; }
  button.disabled = true;
  button.textContent = 'Đang tải PDF…';
  try {
    const response = await fetch('/source/book.pdf');
    if (!response.ok) throw new Error('Chưa tải được tài liệu gốc.');
    await response.blob();
    await refreshOfflineStatus();
    toast(sourcePdfCached ? 'Đã lưu PDF gốc để đối chiếu ngoại tuyến.' : 'PDF đã tải. Đang hoàn tất lưu trên thiết bị.');
  } catch (error) { toast(error.message || 'Tải PDF chưa hoàn tất. Hãy kiểm tra kết nối.'); }
  finally { button.disabled = false; updateNetworkUI(); }
}

async function shareRecipe() {
  const recipe = recipesById.get(currentRecipeId);
  if (!recipe) return;
  const url = location.origin + location.pathname + '#/recipe/' + recipe.id;
  const title = recipe.title + ' · ' + recipe.categoryName;
  try {
    if (navigator.share) { await navigator.share({title,text:'Nội dung tham khảo từ sách Những bài thuốc quý trong dân gian.',url}); return; }
    await navigator.clipboard.writeText(url);
    toast('Đã sao chép liên kết bài.');
  } catch (error) {
    if (error.name === 'AbortError') return;
    toast('Có thể sao chép liên kết đang hiển thị trên thanh địa chỉ.',5000);
  }
}

function downloadBackup() {
  flushNote();
  if (pendingNote) return;
  try {
    const contents = userStore.exportBackup();
    const url = URL.createObjectURL(new Blob([contents],{type:'application/json;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url;
    const now = new Date();
    const date = now.getFullYear() + '-' + String(now.getMonth()+1).padStart(2,'0') + '-' + String(now.getDate()).padStart(2,'0');
    a.download = 'Bai_Thuoc_Quy_Sao_Luu_' + date + '.json';
    document.body.appendChild(a);a.click();a.remove();
    setTimeout(() => URL.revokeObjectURL(url),30000);
    toast('Đã tạo tệp sao lưu dấu trang và ghi chú.');
  } catch (error) { toast(error.message || 'Chưa xuất được bản sao lưu.',5500); }
}

async function importBackup(file) {
  if (!file) return;
  if (file.size > 1024*1024) { toast('Tệp sao lưu lớn hơn 1 MB. Hãy chọn bản sao do ứng dụng xuất.'); return; }
  try {
    const result = userStore.importBackup(await file.text());
    refreshSaveButtons();
    if (activeView === 'saved') renderSaved();
    toast('Đã gộp bản sao: thêm ' + result.favoritesAdded + ' dấu trang, ' + result.notesAdded + ' ghi chú; gộp ' + result.notesMerged + ' ghi chú đang có.',5500);
    reportPersistence(result);
  } catch (error) { toast(error.message || 'Tệp không phải bản sao lưu phù hợp.',6000); }
}

function bindEvents() {
  document.querySelector('.skip-link').addEventListener('click',(event) => {
    event.preventDefault();
    $('main').focus();
    $('main').scrollIntoView({block:'start'});
  });
  $('searchInput').addEventListener('input',(event) => {
    clearTimeout(searchTimer);
    searchState.query = event.target.value;
    $('clearSearch').hidden = !searchState.query;
    searchTimer = setTimeout(() => { renderSearch(); rememberSearchURL(); },130);
  });
  $('searchForm').addEventListener('submit',(event) => { event.preventDefault();clearTimeout(searchTimer);renderSearch();rememberSearchURL();$('searchInput').blur(); });
  $('clearSearch').addEventListener('click',() => { setSearch({query:''});$('searchInput').focus(); });
  $('categoryFilter').addEventListener('change',(event) => setSearch({categoryId:event.target.value,subcategoryId:''}));
  $('subcategoryFilter').addEventListener('change',(event) => setSearch({subcategoryId:event.target.value}));
  $('sortFilter').addEventListener('change',(event) => setSearch({sort:event.target.value}));
  $('resetFilters').addEventListener('click',() => setSearch({query:'',categoryId:'',subcategoryId:'',mode:'all',sort:'relevance'}));
  $('loadMore').addEventListener('click',() => { resultLimit += PAGE_SIZE;renderSearch(false); });
  document.addEventListener('click',(event) => {
    const button = event.target.closest('button');
    if (!button || !userStore) return;
    if (button.dataset.save) {
      event.preventDefault();
      const result = userStore.toggleFavorite(button.dataset.save);
      refreshSaveButtons();
      if (activeView === 'saved' && savedTab === 'favorites') renderSaved();
      toast(result.saved ? 'Đã thêm vào mục Đã lưu.' : 'Đã bỏ đánh dấu.');
      reportPersistence(result);
    }
    if (button.dataset.mode) setSearch({mode:button.dataset.mode});
    if (button.dataset.query) setSearch({query:button.dataset.query,mode:'all'});
    if (button.dataset.savedTab) { savedTab = button.dataset.savedTab;renderSaved(); }
    if (button.dataset.ingredient) {
      flushNote();
      if (pendingNote) return;
      const ingredient = button.dataset.ingredient.replace(/["“”]/g,'');
      location.hash = buildSearchHash({query:'"' + ingredient + '"',mode:'ingredients'});
    }
  });
  $('closeDetail').addEventListener('click',closeDetail);
  $('recipeDialog').addEventListener('cancel',(event) => { event.preventDefault();closeDetail(); });
  $('recipeDialog').addEventListener('click',(event) => {
    if (event.target !== $('recipeDialog')) return;
    const box = $('recipeDialog').getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeDetail();
  });
  $('detailSave').addEventListener('click',() => {
    if (!currentRecipeId) return;
    const result = userStore.toggleFavorite(currentRecipeId);
    refreshSaveButtons();reportPersistence(result);
    toast(result.saved ? 'Đã thêm vào mục Đã lưu.' : 'Đã bỏ đánh dấu.');
  });
  $('detailShare').addEventListener('click',shareRecipe);
  $('detailPrint').addEventListener('click',() => window.print());
  $('recipeNote').addEventListener('input',(event) => {
    pendingNote = {id:currentRecipeId,text:event.target.value};
    $('noteStatus').textContent = 'Đang lưu…';
    clearTimeout(noteTimer);noteTimer = setTimeout(flushNote,450);
  });
  for (const [id,direction] of [['previousRecipe',-1],['nextRecipe',1]]) {
    $(id).addEventListener('click',() => {
      const current = recipesById.get(currentRecipeId);
      const next = book.recipes.find((r) => r.ordinal === current.ordinal + direction);
      if (!next) return;
      flushNote();
      if (pendingNote) return;
      location.replace('#/recipe/' + next.id);
    });
  }
  $('themeSelect').addEventListener('change',(event) => { reportPersistence(userStore.setSetting('theme',event.target.value));applyPreferences(); });
  for (const [id,amount] of [['fontSmaller',-1],['fontLarger',1]]) {
    $(id).addEventListener('click',() => { const size = Math.min(26,Math.max(16,userStore.state.settings.fontSize+amount));reportPersistence(userStore.setSetting('fontSize',size));applyPreferences(); });
  }
  systemTheme.addEventListener?.('change',applyPreferences);
  $('installTop').addEventListener('click',installApp);
  $('installSettings').addEventListener('click',installApp);
  $('closeInstall').addEventListener('click',() => $('installDialog').close());
  $('installDone').addEventListener('click',() => $('installDialog').close());
  $('exportBackup').addEventListener('click',downloadBackup);
  $('importBackup').addEventListener('click',() => $('backupFile').click());
  $('backupFile').addEventListener('change',async (event) => { await importBackup(event.target.files[0]);event.target.value = ''; });
  $('cacheSource').addEventListener('click',cacheSourcePDF);
  $('checkUpdate').addEventListener('click',async () => {
    if (!navigator.onLine) { toast('Cần có mạng để kiểm tra bản cập nhật.');return; }
    if (!serviceWorkerRegistration) { await setupOffline(); }
    if (!serviceWorkerRegistration) { toast('Trình duyệt chưa bật được cập nhật ngoại tuyến.');return; }
    try { await serviceWorkerRegistration.update();updateAvailable();await refreshOfflineStatus();toast(serviceWorkerRegistration.waiting ? 'Có bản cập nhật mới.' : 'Đã kiểm tra. Khi có bản mới, ứng dụng sẽ hiện nút Cập nhật.'); }
    catch { toast('Chưa kiểm tra được phiên bản. Hãy thử lại khi có mạng.'); }
  });
  $('applyUpdate').addEventListener('click',() => {
    flushNote();
    if (pendingNote) return;
    if (serviceWorkerRegistration?.waiting) {
      reloadForUpdate = true;
      $('applyUpdate').disabled = true;
      $('applyUpdate').textContent = 'Đang cập nhật…';
      serviceWorkerRegistration.waiting.postMessage({type:'SKIP_WAITING'});
    }
  });
  $('dismissUpdate').addEventListener('click',() => { $('updateBar').hidden = true; });
  window.addEventListener('hashchange',route);
  window.addEventListener('online',refreshOfflineStatus);
  window.addEventListener('offline',updateNetworkUI);
  window.addEventListener('pagehide',flushNote);
  document.addEventListener('visibilitychange',() => { if (document.visibilityState === 'hidden') flushNote(); });
}

async function loadBook() {
  if (dataLoading) return;
  dataLoading = true;
  $('loadError').hidden = true;
  $('loading').hidden = false;
  try {
    const response = await fetch('/data/book.json');
    if (!response.ok) throw new Error('Không tải được dữ liệu thư viện (mã ' + response.status + ').');
    const data = await response.json();
    if (!Array.isArray(data.recipes) || !data.recipes.length || !Array.isArray(data.categories)) throw new Error('Dữ liệu sách chưa đúng định dạng.');
    book = data;
    recipesById = new Map(book.recipes.map((r) => [r.id,r]));
    categoriesById = new Map(book.categories.map((c) => [c.id,c]));
    searchIndex = createSearchIndex(book);
    userStore = createUserStore(new Set(recipesById.keys()));
    applyPreferences();
    $('bookStats').innerHTML = '<span><strong>' + book.recipes.length + '</strong> bài thuốc</span><span><strong>' + book.categories.length + '</strong> nhóm</span><span><strong>' + book.meta.sourcePages + '</strong> trang gốc</span>';
    $('categoryFilter').innerHTML = '<option value="">Tất cả nhóm</option>' + book.categories.map((c) => '<option value="' + escapeHTML(c.id) + '">' + escapeHTML(c.name) + ' (' + c.recipeCount + ')</option>').join('');
    $('versionInfo').textContent = 'Ứng dụng 1.0 · Nội dung ' + book.meta.contentVersion + ' · ' + book.recipes.length + ' bài · Tiếng Việt';
    bindEvents();
    $('loading').hidden = true;
    if (!location.hash) history.replaceState(null,'','#/search');
    route();
    refreshSaveButtons();
    updateNetworkUI();
    if (userStore.error) toast(userStore.error,8500);
    setupOffline();
  } catch (error) {
    $('loading').hidden = true;
    $('loadError').hidden = false;
    $('loadErrorMessage').textContent = error.message || 'Hãy kiểm tra kết nối rồi thử lại.';
    $('networkBadge').textContent = 'Chưa mở được thư viện';
  } finally { dataLoading = false; }
}

window.addEventListener('beforeinstallprompt',(event) => {
  event.preventDefault();deferredInstall = event;$('installTop').hidden = false;
});
window.addEventListener('appinstalled',() => {
  deferredInstall = null;$('installTop').hidden = true;toast('Ứng dụng đã được thêm vào thiết bị.');
});
$('retryLoad').addEventListener('click',loadBook);
loadBook();
