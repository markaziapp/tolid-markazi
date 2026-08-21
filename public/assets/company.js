function api(path) { return (window.API_BASE || '') + path; }
function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg; t.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => t.classList.remove('show'), 3500);
}
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

function getToken() { return localStorage.getItem('companyToken'); }
function setToken(t) { localStorage.setItem('companyToken', t); }
function clearToken() { localStorage.removeItem('companyToken'); }

async function apiGet(path, auth) {
    const headers = auth ? { Authorization: 'Bearer ' + getToken() } : {};
    const res = await fetch(api(path), { headers });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا');
    return data;
}
async function apiSend(method, path, body, auth) {
    const headers = { 'Content-Type': 'application/json' };
    if (auth) headers.Authorization = 'Bearer ' + getToken();
    const res = await fetch(api(path), { method, headers, body: JSON.stringify(body || {}) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا');
    return data;
}

function showAuthForm(which) {
    document.getElementById('loginForm').style.display = which === 'login' ? 'block' : 'none';
    document.getElementById('registerForm').style.display = which === 'register' ? 'block' : 'none';
    document.getElementById('loginTabBtn').classList.toggle('active', which === 'login');
    document.getElementById('registerTabBtn').classList.toggle('active', which === 'register');
}

async function loadLookups() {
    try {
        const [counties, categories] = await Promise.all([apiGet('/api/counties'), apiGet('/api/categories')]);
        document.getElementById('regCounty').innerHTML = counties.map(c => `<option>${esc(c.name)}</option>`).join('');
        document.getElementById('regCategory').innerHTML = categories.map(c => `<option>${esc(c.name)}</option>`).join('');
    } catch {}
}

function uploadPreview(input, labelId, icon) {
    const label = document.getElementById(labelId);
    if (input.files && input.files[0]) { label.textContent = '✅ ' + input.files[0].name; label.classList.add('has-file'); }
}
async function uploadFile(inputEl) {
    if (!inputEl.files || !inputEl.files[0]) return '';
    const fd = new FormData();
    fd.append('file', inputEl.files[0]);
    const res = await fetch(api('/api/upload'), { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا در آپلود فایل');
    return data.url;
}

async function doRegister() {
    const name = document.getElementById('regName').value.trim();
    const phone = document.getElementById('regPhone').value.trim();
    const password = document.getElementById('regPassword').value;
    if (!name || !phone || !password) { showToast('نام، شماره تماس و رمز عبور الزامی است', 'error'); return; }
    try {
        let logoUrl = '', licenseUrl = '';
        try { logoUrl = await uploadFile(document.getElementById('regLogo')); }
        catch (e) { showToast('آپلود لوگو ناموفق بود: ' + e.message, 'error'); return; }
        try { licenseUrl = await uploadFile(document.getElementById('regLicense')); }
        catch (e) { showToast('آپلود مجوز ناموفق بود: ' + e.message, 'error'); return; }
        await apiSend('POST', '/api/company/register', {
            name, phone, password,
            county: document.getElementById('regCounty').value,
            category: document.getElementById('regCategory').value,
            products: document.getElementById('regProducts').value,
            capacity: document.getElementById('regCapacity').value,
            logoUrl, licenseUrl,
        });
        showToast('ثبت‌نام شد؛ می‌توانید وارد شوید (تأیید مدیر لازم است)', 'success');
        showAuthForm('login');
    } catch (e) { showToast(e.message, 'error'); }
}

async function doLogin() {
    const phone = document.getElementById('loginPhone').value.trim();
    const password = document.getElementById('loginPassword').value;
    if (!phone || !password) { showToast('شماره و رمز عبور را وارد کنید', 'error'); return; }
    try {
        const data = await apiSend('POST', '/api/company/login', { phone, password });
        setToken(data.token);
        showToast('خوش آمدید', 'success');
        loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
}

function logout() { clearToken(); location.reload(); }

let chartInstance;
async function loadDashboard() {
    try {
        const data = await apiGet('/api/company/dashboard', true);
        document.getElementById('authBox').style.display = 'none';
        document.getElementById('dashboardBox').style.display = 'block';
        document.getElementById('dashCompanyName').textContent = data.company.name;
        document.getElementById('verifyNotice').innerHTML = data.company.verified
            ? '<div class="badge badge-verified">✔ واحد شما تأیید شده است</div>'
            : '<div class="badge badge-urgent">در انتظار تأیید مدیر</div>';
        document.getElementById('statCards').innerHTML = `
            <div class="stat-card"><div class="num">${data.stats.offers}</div><div class="label">تعداد آگهی</div></div>
            <div class="stat-card"><div class="num">${data.stats.rfqs}</div><div class="label">استعلام دریافتی</div></div>
            <div class="stat-card"><div class="num">${data.stats.responses}</div><div class="label">پاسخ به درخواست‌ها</div></div>
            <div class="stat-card"><div class="num">${data.stats.profileViews}</div><div class="label">بازدید پروفایل</div></div>
        `;
        document.getElementById('editName').value = data.company.name || '';
        document.getElementById('presentationStatus').textContent =
            'وضعیت پرزنت: ' + ({ none: 'ثبت نشده', pending: 'در انتظار تایید', approved: 'تأیید شده', rejected: 'رد شده' }[data.company.presentation_status] || '-');

        const labels = (data.monthlyViews || []).map(m => m.month).reverse();
        const values = (data.monthlyViews || []).map(m => m.c).reverse();
        if (chartInstance) chartInstance.destroy();
        const ctx = document.getElementById('viewsChart');
        chartInstance = new Chart(ctx, {
            type: 'bar',
            data: { labels: labels.length ? labels : ['بدون داده'], datasets: [{ label: 'بازدید ماهانه پروفایل', data: values.length ? values : [0], backgroundColor: '#d4a94e' }] },
            options: { responsive: true, plugins: { legend: { display: false } } },
        });
    } catch (e) {
        clearToken();
        showToast('نشست شما منقضی شده؛ دوباره وارد شوید', 'error');
    }
}

async function saveProfileEdit() {
    try {
        await apiSend('PUT', '/api/company/profile', {
            name: document.getElementById('editName').value,
            products: document.getElementById('editProducts').value,
            capacity: document.getElementById('editCapacity').value,
        }, true);
        showToast('تغییرات برای تایید مدیر ارسال شد', 'success');
    } catch (e) { showToast(e.message, 'error'); }
}

async function submitPresentation() {
    try {
        await apiSend('POST', '/api/company/presentation', {
            url: document.getElementById('presentationUrl').value,
            type: document.getElementById('presentationType').value,
        }, true);
        showToast('برای تایید مدیر ارسال شد', 'success');
        loadDashboard();
    } catch (e) { showToast(e.message, 'error'); }
}

window.addEventListener('DOMContentLoaded', () => {
    loadLookups();
    if (getToken()) loadDashboard();
    if (location.hash === '#register') showAuthForm('register');
});
