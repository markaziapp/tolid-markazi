function api(path) { return (window.API_BASE || '') + path; }
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => t.classList.remove('show'), 3500);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }
function getToken() { return sessionStorage.getItem('adminToken'); }
function setToken(t) { sessionStorage.setItem('adminToken', t); }
function clearToken() { sessionStorage.removeItem('adminToken'); }

async function apiGet(path) {
    const res = await fetch(api(path), { headers: { Authorization: 'Bearer ' + getToken() } });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا');
    return data;
}
async function apiSend(method, path, body) {
    const res = await fetch(api(path), {
        method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + getToken() }, body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا');
    return data;
}

// ------------------------------------------------------------------
// دروازه مخفی: ۵ کلیک پشت‌سرهم روی آرم
// ------------------------------------------------------------------
let clickCount = 0, clickTimer;
document.addEventListener('DOMContentLoaded', () => {
    const logo = document.getElementById('gateLogo');
    logo.addEventListener('click', () => {
        clickCount++;
        clearTimeout(clickTimer);
        clickTimer = setTimeout(() => (clickCount = 0), 1500);
        if (clickCount >= 5) {
            clickCount = 0;
            document.getElementById('gate').style.display = 'none';
            document.getElementById('loginWrap').style.display = 'block';
        }
    });
    if (getToken()) enterPanel();
});

async function adminLogin() {
    const username = document.getElementById('adminUsername').value.trim();
    const password = document.getElementById('adminPassword').value;
    if (!username || !password) { showToast('نام کاربری و رمز را وارد کنید', 'error'); return; }
    try {
        const data = await (await fetch(api('/api/admin/login'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password }),
        })).json();
        if (data.error) throw new Error(data.error);
        setToken(data.token);
        enterPanel();
    } catch (e) { showToast(e.message, 'error'); }
}
function adminLogout() { clearToken(); location.reload(); }

function enterPanel() {
    document.getElementById('gate').style.display = 'none';
    document.getElementById('loginWrap').style.display = 'none';
    document.getElementById('adminPanel').style.display = 'block';
    switchAdminTab('overview');
}

function switchAdminTab(tab) {
    document.querySelectorAll('.admin-tab-page').forEach(el => el.style.display = 'none');
    document.getElementById('admin-' + tab).style.display = 'block';
    document.querySelectorAll('#adminTabs .tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    const loaders = {
        overview: loadOverview, pending: loadPending, companies: loadCompanies, offers: loadOffers,
        requests: loadRequests, services: loadServices, ads: loadAds, files: loadFiles, lookups: loadLookups,
    };
    loaders[tab] && loaders[tab]();
}

// ------------------------------------------------------------------
// آمار کلی
// ------------------------------------------------------------------
let overviewChart;
async function loadOverview() {
    const el = document.getElementById('admin-overview');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const data = await apiGet('/api/admin/analytics');
        el.innerHTML = `
            <div class="stat-cards">
                <div class="stat-card"><div class="num">${data.totalViews}</div><div class="label">کل بازدید صفحات</div></div>
                <div class="stat-card"><div class="num">${data.totals.companies}</div><div class="label">واحد تولیدی</div></div>
                <div class="stat-card"><div class="num">${data.totals.offers}</div><div class="label">عرضه ثبت‌شده</div></div>
                <div class="stat-card"><div class="num">${data.totals.requests}</div><div class="label">درخواست خرید</div></div>
            </div>
            <canvas id="dailyViewsChart" height="120" style="margin-top:1rem;"></canvas>
            <h3 class="section-title" style="font-size:1rem;">پربازدیدترین صفحات</h3>
            <table class="admin-table"><tr><th>مسیر</th><th>بازدید</th></tr>
                ${data.topPaths.map(p => `<tr><td>${esc(p.path)}</td><td>${p.c}</td></tr>`).join('') || '<tr><td colspan="2">داده‌ای نیست</td></tr>'}
            </table>
        `;
        const labels = data.daily.map(d => d.day).reverse();
        const values = data.daily.map(d => d.c).reverse();
        if (overviewChart) overviewChart.destroy();
        overviewChart = new Chart(document.getElementById('dailyViewsChart'), {
            type: 'line',
            data: { labels: labels.length ? labels : ['بدون داده'], datasets: [{ label: 'بازدید روزانه', data: values.length ? values : [0], borderColor: '#0f3460', backgroundColor: 'rgba(15,52,96,0.1)', fill: true }] },
            options: { responsive: true, plugins: { legend: { display: false } } },
        });
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}

// ------------------------------------------------------------------
// ویرایش‌های در انتظار تایید
// ------------------------------------------------------------------
async function loadPending() {
    const el = document.getElementById('admin-pending');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/pending-edits');
        el.innerHTML = `<h2 class="section-title">✏️ ویرایش‌های در انتظار تایید</h2>` + (items.map(it => {
            const changes = JSON.parse(it.changes_json || '{}');
            return `<div class="card" style="padding:1rem; margin-bottom:0.8rem;">
                <div style="font-size:0.85rem; color:var(--text-light);">نوع: ${it.entity_type === 'company' ? 'پروفایل شرکت' : 'آگهی محصول'} • شناسه: ${it.entity_id}</div>
                <ul class="spec-list">${Object.entries(changes).map(([k,v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('')}</ul>
                <div style="display:flex; gap:0.5rem; margin-top:0.6rem;">
                    <button class="btn btn-primary btn-sm" onclick="decidePending(${it.id},'approved')">تایید و اعمال</button>
                    <button class="btn btn-danger btn-sm" onclick="decidePending(${it.id},'rejected')">رد</button>
                </div>
            </div>`;
        }).join('') || '<div class="empty-state">چیزی در انتظار تایید نیست</div>');
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function decidePending(id, decision) {
    try { await apiSend('PUT', `/api/admin/pending-edits/${id}`, { decision }); showToast('ثبت شد', 'success'); loadPending(); }
    catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// واحدهای تولیدی
// ------------------------------------------------------------------
async function loadCompanies() {
    const el = document.getElementById('admin-companies');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/companies');
        el.innerHTML = `<h2 class="section-title">🏭 واحدهای تولیدی</h2><div class="table-wrap"><table class="admin-table">
            <tr><th>نام</th><th>شهرستان</th><th>وضعیت</th><th>پرزنت</th><th>عملیات</th></tr>
            ${items.map(c => `<tr>
                <td>${esc(c.name)}<br><small style="color:var(--text-light)">${esc(c.phone)}</small></td>
                <td>${esc(c.county||'-')}</td>
                <td>${c.verified ? '✔ تأیید شده' : 'در انتظار'} / ${c.active ? 'فعال' : 'غیرفعال'}</td>
                <td>${c.presentation_status === 'pending' ? `<button class="btn btn-sm btn-outline" onclick="decidePresentation(${c.id},'approved')">تایید پرزنت</button> <button class="btn btn-sm btn-danger" onclick="decidePresentation(${c.id},'rejected')">رد</button>` : (c.presentation_status||'-')}</td>
                <td style="white-space:nowrap;">
                    <button class="btn btn-sm ${c.verified?'btn-outline':'btn-primary'}" onclick="toggleCompany(${c.id},'verified',${c.verified?0:1})">${c.verified?'لغو تأیید':'تأیید'}</button>
                    <button class="btn btn-sm ${c.active?'btn-danger':'btn-outline'}" onclick="toggleCompany(${c.id},'active',${c.active?0:1})">${c.active?'غیرفعال':'فعال'}</button>
                </td>
            </tr>`).join('')}
        </table></div>`;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function toggleCompany(id, field, value) {
    try { await apiSend('PUT', `/api/admin/companies/${id}`, { [field]: value }); loadCompanies(); }
    catch (e) { showToast(e.message, 'error'); }
}
async function decidePresentation(id, status) {
    try { await apiSend('PUT', `/api/admin/companies/${id}`, { presentation_status: status }); showToast('ثبت شد', 'success'); loadCompanies(); }
    catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// عرضه‌ها
// ------------------------------------------------------------------
async function loadOffers() {
    const el = document.getElementById('admin-offers');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/offers');
        el.innerHTML = `<h2 class="section-title">📦 عرضه‌ها</h2><div class="table-wrap"><table class="admin-table">
            <tr><th>عنوان</th><th>شرکت</th><th>قیمت</th><th>وضعیت</th><th>عملیات</th></tr>
            ${items.map(o => `<tr>
                <td>${esc(o.title)}</td><td>${esc(o.company_name)}</td><td>${esc(o.price||'-')}</td>
                <td>${o.verified?'✔ تأیید':'در انتظار'} / ${o.active?'فعال':'غیرفعال'} ${o.featured?'/ ⭐ ستاره‌خواسته':''} ${o.featured_approved?'/ ⭐تاییدشده':''}</td>
                <td style="white-space:nowrap;">
                    <button class="btn btn-sm ${o.verified?'btn-outline':'btn-primary'}" onclick="toggleOffer(${o.id},'verified',${o.verified?0:1})">${o.verified?'لغو تأیید':'تأیید'}</button>
                    <button class="btn btn-sm ${o.featured_approved?'btn-outline':'btn-gold'}" onclick="toggleOffer(${o.id},'featured_approved',${o.featured_approved?0:1})">${o.featured_approved?'حذف ستاره':'ستاره‌دار کن'}</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteOffer(${o.id})">حذف</button>
                </td>
            </tr>`).join('')}
        </table></div>`;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function toggleOffer(id, field, value) {
    try { await apiSend('PUT', `/api/admin/offers/${id}`, { [field]: value }); loadOffers(); }
    catch (e) { showToast(e.message, 'error'); }
}
async function deleteOffer(id) {
    if (!confirm('حذف شود؟')) return;
    try { await apiSend('DELETE', `/api/admin/offers/${id}`); loadOffers(); } catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// درخواست‌های خرید
// ------------------------------------------------------------------
async function loadRequests() {
    const el = document.getElementById('admin-requests');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/requests');
        el.innerHTML = `<h2 class="section-title">📋 درخواست‌های خرید</h2><div class="table-wrap"><table class="admin-table">
            <tr><th>محصول</th><th>شرکت</th><th>مقدار</th><th>عملیات</th></tr>
            ${items.map(r => `<tr><td>${esc(r.product)}</td><td>${esc(r.company)}</td><td>${esc(r.quantity)} ${esc(r.unit||'')}</td>
                <td><button class="btn btn-sm btn-danger" onclick="deleteRequest(${r.id})">حذف</button></td></tr>`).join('')}
        </table></div>`;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function deleteRequest(id) {
    if (!confirm('حذف شود؟')) return;
    try { await apiSend('DELETE', `/api/admin/requests/${id}`); loadRequests(); } catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// درخواست خدمات
// ------------------------------------------------------------------
async function loadServices() {
    const el = document.getElementById('admin-services');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/service-requests');
        el.innerHTML = `<h2 class="section-title">🧑‍💼 درخواست خدمات</h2><div class="table-wrap"><table class="admin-table">
            <tr><th>عنوان</th><th>شرکت</th><th>وضعیت</th><th>عملیات</th></tr>
            ${items.map(s => `<tr><td>${esc(s.role_title)}</td><td>${esc(s.company)}</td><td>${esc(s.status)}</td>
                <td>
                    <button class="btn btn-sm btn-outline" onclick="setServiceStatus(${s.id},'در حال بررسی')">در حال بررسی</button>
                    <button class="btn btn-sm btn-primary" onclick="setServiceStatus(${s.id},'بسته شد')">بسته شد</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteService(${s.id})">حذف</button>
                </td></tr>`).join('')}
        </table></div>`;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function setServiceStatus(id, status) {
    try { await apiSend('PUT', `/api/admin/service-requests/${id}`, { status }); loadServices(); } catch (e) { showToast(e.message, 'error'); }
}
async function deleteService(id) {
    if (!confirm('حذف شود؟')) return;
    try { await apiSend('DELETE', `/api/admin/service-requests/${id}`); loadServices(); } catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// تبلیغات
// ------------------------------------------------------------------
async function loadAds() {
    const el = document.getElementById('admin-ads');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/ads');
        el.innerHTML = `<h2 class="section-title">📢 تبلیغات</h2><div class="table-wrap"><table class="admin-table">
            <tr><th>نوع</th><th>عنوان</th><th>آگهی‌دهنده</th><th>وضعیت</th><th>عملیات</th></tr>
            ${items.map(a => `<tr>
                <td>${esc(a.ad_type)}</td><td>${esc(a.title||'-')}</td><td>${esc(a.advertiser_name)}<br><small>${esc(a.advertiser_phone)}</small></td>
                <td>${esc(a.status)}</td>
                <td>
                    <button class="btn btn-sm btn-primary" onclick="setAdStatus(${a.id},'approved')">تایید</button>
                    <button class="btn btn-sm btn-outline" onclick="setAdStatus(${a.id},'rejected')">رد</button>
                    <button class="btn btn-sm btn-danger" onclick="deleteAd(${a.id})">حذف</button>
                </td>
            </tr>`).join('')}
        </table></div>
        <h3 class="section-title" style="font-size:1rem;">ثبت تبلیغ مستقیم توسط مدیر</h3>
        <div class="card" style="padding:1rem; max-width:480px;">
            <div class="form-group"><label>نوع</label><select id="newAdType"><option value="text">متن</option><option value="image">عکس</option><option value="video">ویدیو</option></select></div>
            <div class="form-group"><label>عنوان</label><input type="text" id="newAdTitle"></div>
            <div class="form-group"><label>متن</label><textarea id="newAdBody" rows="2"></textarea></div>
            <div class="form-group"><label>عکس</label><input type="file" id="newAdImage" accept="image/*"></div>
            <div class="form-group"><label>لینک ویدیو</label><input type="text" id="newAdVideo" placeholder="لینک آپارات/یوتیوب"></div>
            <button class="btn btn-gold" style="width:100%;" onclick="createAdDirect()">ثبت و تایید فوری</button>
        </div>`;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function setAdStatus(id, status) {
    try { await apiSend('PUT', `/api/admin/ads/${id}`, { status }); loadAds(); } catch (e) { showToast(e.message, 'error'); }
}
async function deleteAd(id) {
    if (!confirm('حذف شود؟')) return;
    try { await apiSend('DELETE', `/api/admin/ads/${id}`); loadAds(); } catch (e) { showToast(e.message, 'error'); }
}
async function createAdDirect() {
    try {
        let imageUrl = '';
        const fileInput = document.getElementById('newAdImage');
        if (fileInput.files && fileInput.files[0]) {
            const fd = new FormData(); fd.append('file', fileInput.files[0]);
            const res = await fetch(api('/api/upload'), { method: 'POST', headers: { Authorization: 'Bearer ' + getToken() }, body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            imageUrl = data.url;
        }
        // ثبت به‌عنوان درخواست عمومی سپس تایید فوری
        const created = await (await fetch(api('/api/ads'), {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ adType: document.getElementById('newAdType').value, title: document.getElementById('newAdTitle').value,
                bodyText: document.getElementById('newAdBody').value, advertiserName: 'مدیر سایت', advertiserPhone: '-' }),
        })).json();
        await apiSend('PUT', `/api/admin/ads/${created.id}`, { status: 'approved', image_url: imageUrl, video_embed_url: document.getElementById('newAdVideo').value });
        showToast('تبلیغ ثبت و فعال شد', 'success');
        loadAds();
    } catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// فایل‌های مفید
// ------------------------------------------------------------------
async function loadFiles() {
    const el = document.getElementById('admin-files');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/admin/admin-files');
        el.innerHTML = `<h2 class="section-title">📁 فایل‌های مفید</h2><div class="table-wrap"><table class="admin-table">
            <tr><th>عنوان</th><th>نوع</th><th>وضعیت</th><th>عملیات</th></tr>
            ${items.map(f => `<tr><td>${esc(f.title)}</td><td>${esc(f.file_type||'-')}</td><td>${f.is_locked?'قفل (فروشی)':'رایگان'}</td>
                <td><button class="btn btn-sm ${f.is_locked?'btn-outline':'btn-gold'}" onclick="toggleFileLock(${f.id},${f.is_locked?0:1})">${f.is_locked?'رایگان کن':'قفل/فروشی کن'}</button>
                <button class="btn btn-sm btn-danger" onclick="deleteFile(${f.id})">حذف</button></td></tr>`).join('')}
        </table></div>
        <h3 class="section-title" style="font-size:1rem;">افزودن فایل جدید</h3>
        <div class="card" style="padding:1rem; max-width:480px;">
            <div class="form-group"><label>عنوان *</label><input type="text" id="newFileTitle"></div>
            <div class="form-group"><label>توضیحات</label><textarea id="newFileDesc" rows="2"></textarea></div>
            <div class="form-group"><label>فایل</label><input type="file" id="newFileUpload"></div>
            <div class="form-group"><label>یا لینک خارجی (اختیاری به‌جای فایل)</label><input type="text" id="newFileLink"></div>
            <button class="btn btn-primary" style="width:100%;" onclick="createFile()">افزودن</button>
        </div>`;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function toggleFileLock(id, value) {
    try { await apiSend('PUT', `/api/admin/admin-files/${id}`, { is_locked: value }); loadFiles(); } catch (e) { showToast(e.message, 'error'); }
}
async function deleteFile(id) {
    if (!confirm('حذف شود؟')) return;
    try { await apiSend('DELETE', `/api/admin/admin-files/${id}`); loadFiles(); } catch (e) { showToast(e.message, 'error'); }
}
async function createFile() {
    const title = document.getElementById('newFileTitle').value.trim();
    if (!title) { showToast('عنوان الزامی است', 'error'); return; }
    try {
        let fileUrl = document.getElementById('newFileLink').value.trim();
        let fileType = fileUrl ? 'link' : '';
        const fileInput = document.getElementById('newFileUpload');
        if (fileInput.files && fileInput.files[0]) {
            const fd = new FormData(); fd.append('file', fileInput.files[0]);
            const res = await fetch(api('/api/upload'), { method: 'POST', headers: { Authorization: 'Bearer ' + getToken() }, body: fd });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error);
            fileUrl = data.url;
            fileType = fileInput.files[0].name.split('.').pop();
        }
        await apiSend('POST', '/api/admin/admin-files', { title, description: document.getElementById('newFileDesc').value, file_url: fileUrl, file_type: fileType, is_locked: 0, price: 0 });
        showToast('افزوده شد', 'success');
        loadFiles();
    } catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// دسته‌بندی و شهرستان
// ------------------------------------------------------------------
async function loadLookups() {
    const el = document.getElementById('admin-lookups');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const [cats, counties] = await Promise.all([apiGet('/api/admin/categories'), apiGet('/api/admin/counties')]);
        el.innerHTML = `
        <h2 class="section-title">🏷 دسته‌بندی‌ها</h2>
        <div style="display:flex; gap:0.5rem; margin-bottom:0.8rem;"><input type="text" id="newCatName" placeholder="نام دسته جدید" style="flex:1; padding:0.5rem; border-radius:8px; border:1px solid var(--border);"><button class="btn btn-primary btn-sm" onclick="addCategory()">افزودن</button></div>
        <table class="admin-table">${cats.map(c => `<tr><td>${esc(c.name)}</td><td><button class="btn btn-sm btn-danger" onclick="delCategory(${c.id})">حذف</button></td></tr>`).join('')}</table>

        <h2 class="section-title">📍 شهرستان‌ها</h2>
        <div style="display:flex; gap:0.5rem; margin-bottom:0.8rem;"><input type="text" id="newCountyName" placeholder="نام شهرستان جدید" style="flex:1; padding:0.5rem; border-radius:8px; border:1px solid var(--border);"><button class="btn btn-primary btn-sm" onclick="addCounty()">افزودن</button></div>
        <table class="admin-table">${counties.map(c => `<tr><td>${esc(c.name)}</td><td><button class="btn btn-sm btn-danger" onclick="delCounty(${c.id})">حذف</button></td></tr>`).join('')}</table>
        `;
    } catch (e) { el.innerHTML = `<div class="empty-state">${esc(e.message)}</div>`; }
}
async function addCategory() {
    const name = document.getElementById('newCatName').value.trim();
    if (!name) return;
    try { await apiSend('POST', '/api/admin/categories', { name, active: 1 }); loadLookups(); } catch (e) { showToast(e.message, 'error'); }
}
async function delCategory(id) {
    try { await apiSend('DELETE', `/api/admin/categories/${id}`); loadLookups(); } catch (e) { showToast(e.message, 'error'); }
}
async function addCounty() {
    const name = document.getElementById('newCountyName').value.trim();
    if (!name) return;
    try { await apiSend('POST', '/api/admin/counties', { name, province_id: 1 }); loadLookups(); } catch (e) { showToast(e.message, 'error'); }
}
async function delCounty(id) {
    try { await apiSend('DELETE', `/api/admin/counties/${id}`); loadLookups(); } catch (e) { showToast(e.message, 'error'); }
}
