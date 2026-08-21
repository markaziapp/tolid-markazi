// ===================================================================
// فرانت‌اند عمومی — همه داده‌ها از API خوانده می‌شود
// ===================================================================
function api(path) {
    return (window.API_BASE || '') + path;
}

async function apiGet(path) {
    const res = await fetch(api(path));
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'خطا در دریافت اطلاعات');
    return res.json();
}
async function apiPost(path, body) {
    const res = await fetch(api(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'خطا در ثبت اطلاعات');
    return data;
}

function showToast(msg, type = '') {
    const t = document.getElementById('toast');
    t.textContent = msg;
    t.className = 'toast show' + (type ? ' ' + type : '');
    setTimeout(() => t.classList.remove('show'), 3500);
}

function openModal(id) { document.getElementById(id).classList.add('open'); }
function closeModal(id) { document.getElementById(id).classList.remove('open'); }

function filePreview(input, labelId, icon) {
    const label = document.getElementById(labelId);
    if (input.files && input.files[0]) { label.textContent = '✅ ' + input.files[0].name; label.classList.add('has-file'); }
    else { label.textContent = icon + ' برای انتخاب تصویر کلیک کنید'; label.classList.remove('has-file'); }
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
function toggleAdMediaFields() {
    const type = document.getElementById('adType').value;
    document.getElementById('adImageGroup').style.display = type === 'image' ? 'block' : 'none';
    document.getElementById('adVideoGroup').style.display = type === 'video' ? 'block' : 'none';
}

// ------------------------------------------------------------------
// تب‌ها
// ------------------------------------------------------------------
function switchTab(tab) {
    document.querySelectorAll('.tab-page').forEach(el => el.style.display = 'none');
    document.getElementById('tab-' + tab).style.display = 'block';
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    trackView('/' + tab);
    if (tab === 'offers') loadOffers();
    if (tab === 'requests') loadRequests('requestsList');
    if (tab === 'services') loadServices('servicesList');
    if (tab === 'companies') loadCompanies('companiesList');
    if (tab === 'tools') loadFiles();
}

function trackView(path) {
    apiPost('/api/track', { path, ref: document.referrer || '' }).catch(() => {});
}

// ------------------------------------------------------------------
// بارگذاری استان/شهرستان/دسته‌بندی برای select ها
// ------------------------------------------------------------------
async function loadLookups() {
    try {
        const [counties, categories, companies] = await Promise.all([apiGet('/api/counties'), apiGet('/api/categories'), apiGet('/api/companies').catch(() => [])]);
        const countySelects = ['spCounty', 'prCounty', 'srCounty', 'offerCounty'];
        countySelects.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const keepFirst = el.id === 'offerCounty';
            el.innerHTML = (keepFirst ? '<option value="">همه شهرستان‌ها</option>' : '') +
                counties.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
        });
        const catSelects = ['spCategory', 'offerCategory'];
        catSelects.forEach(id => {
            const el = document.getElementById(id);
            if (!el) return;
            const keepFirst = el.id === 'offerCategory';
            el.innerHTML = (keepFirst ? '<option value="">همه دسته‌ها</option>' : '') +
                categories.map(c => `<option value="${c.name}">${c.name}</option>`).join('');
        });
        const dl = document.getElementById('companiesDatalist');
        if (dl) dl.innerHTML = companies.map(c => `<option value="${esc(c.name)}"></option>`).join('');
    } catch (e) { /* در صورت خطا، فرم‌ها همچنان قابل استفاده‌اند */ }
}

// ------------------------------------------------------------------
// کارت‌ها
// ------------------------------------------------------------------
function requestCard(req) {
    const responseNote = req.response_count > 0
        ? `<div class="badge badge-verified" style="display:block; margin-top:0.5rem;">✔ ${req.response_count} تأمین‌کننده اعلام آمادگی کرده‌اند</div>`
        : `<div class="badge badge-status" style="display:block; margin-top:0.5rem;">هنوز پاسخی ثبت نشده</div>`;
    return `
    <div class="card">
        <div class="card-header">
            <div><div class="card-title">${esc(req.product)}</div><div class="card-subtitle">${esc(req.company)} • ${esc(req.county||'')}</div></div>
            <span class="badge badge-urgent">${esc(req.status)}</span>
        </div>
        <div class="card-body">
            <ul class="spec-list">
                <li><span>مقدار</span><span>${esc(req.quantity)} ${esc(req.unit||'')}</span></li>
                <li><span>زمان تأمین</span><span>${esc(req.deadline||'-')}</span></li>
                ${req.price_range ? `<li><span>محدوده قیمت</span><span>${esc(req.price_range)}</span></li>` : ''}
            </ul>
            ${responseNote}
        </div>
        <div class="card-footer">
            <button class="btn btn-gold btn-sm" onclick="respondToRequest(${req.id})">من می‌توانم تأمین کنم</button>
            <button class="btn btn-outline btn-sm" onclick="showRequestDetails(${req.id})">جزئیات</button>
        </div>
    </div>`;
}

function offerCard(offer) {
    const featured = offer.featured_approved ? '<span class="badge badge-featured">⭐ ویژه</span>' : '';
    const verified = offer.company_verified ? '<span class="badge badge-verified">✔ تأیید شده</span>' : '';
    let specs = {};
    try { specs = JSON.parse(offer.specs_json || '{}'); } catch {}
    return `
    <div class="card ${offer.featured_approved ? 'featured' : ''}">
        <div class="card-header">
            <div><div class="card-title">${esc(offer.title)}</div><div class="card-subtitle">${esc(offer.company_name)} ${verified}</div></div>
            <div>${featured}${offer.category ? `<span class="badge badge-category">${esc(offer.category)}</span>` : ''}</div>
        </div>
        <div class="card-body">
            <ul class="spec-list">${Object.entries(specs).map(([k,v]) => `<li><span>${esc(k)}</span><span>${esc(v)}</span></li>`).join('')}</ul>
            <div class="price-tag">${esc(offer.price||'توافقی')} <small>${esc(offer.unit||'')}</small></div>
            ${offer.moq ? `<div style="font-size:0.8rem; color:var(--text-light);">حداقل سفارش: ${esc(offer.moq)}</div>` : ''}
            <div style="font-size:0.8rem; margin-top:0.3rem;">📍 ${esc(offer.county||'')}</div>
        </div>
        <div class="card-footer">
            <button class="btn btn-outline btn-sm" onclick="showOfferDetails(${offer.id})">جزئیات</button>
            <button class="btn btn-primary btn-sm" onclick="openRfq(${offer.id})">درخواست استعلام</button>
        </div>
    </div>`;
}

function companyCard(c) {
    return `
    <div class="card">
        <div class="card-header">
            <div><div class="card-title">${esc(c.name)}</div><div class="card-subtitle">${esc(c.county||'')} ${c.verified ? '<span class="badge badge-verified">✔ تأیید شده</span>' : ''}</div></div>
        </div>
        <div class="card-body">
            <div style="font-size:0.85rem; color:var(--text-light);">${esc(c.products||'')}</div>
            ${c.capacity ? `<div style="font-size:0.8rem; margin-top:0.4rem;">ظرفیت تولید: ${esc(c.capacity)}</div>` : ''}
        </div>
    </div>`;
}

function serviceCard(s) {
    return `
    <div class="card">
        <div class="card-header">
            <div><div class="card-title">${esc(s.role_title)}</div><div class="card-subtitle">${esc(s.company)} • ${esc(s.county||'')}</div></div>
            <span class="badge badge-urgent">${esc(s.urgency)}</span>
        </div>
        <div class="card-body">
            ${s.service_category ? `<span class="badge badge-category">${esc(s.service_category)}</span>` : ''}
            <p style="font-size:0.85rem; margin-top:0.5rem;">${esc(s.description||'')}</p>
        </div>
        <div class="card-footer"><a class="btn btn-outline btn-sm" href="tel:${esc(s.phone)}">📞 تماس با شرکت</a></div>
    </div>`;
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m])); }

// ------------------------------------------------------------------
// بارگذاری لیست‌ها
// ------------------------------------------------------------------
async function loadHome() {
    try {
        const [reqs, offers] = await Promise.all([apiGet('/api/requests'), apiGet('/api/offers?limit=6')]);
        document.getElementById('homeRequests').innerHTML = reqs.slice(0, 3).map(requestCard).join('') || emptyState('هنوز درخواستی ثبت نشده');
        document.getElementById('homeOffers').innerHTML = offers.slice(0, 3).map(offerCard).join('') || emptyState('هنوز عرضه‌ای ثبت نشده');
    } catch (e) { showToast('خطا در بارگذاری اطلاعات صفحه اصلی', 'error'); }
    loadCompanies('homeCompanies', 3);
    loadAds();
}

function emptyState(text) { return `<div class="empty-state">${text}</div>`; }

async function loadOffers() {
    const el = document.getElementById('offersList');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    const county = document.getElementById('offerCounty')?.value || '';
    const category = document.getElementById('offerCategory')?.value || '';
    try {
        const offers = await apiGet(`/api/offers?county=${encodeURIComponent(county)}&category=${encodeURIComponent(category)}&limit=50`);
        el.innerHTML = offers.map(offerCard).join('') || emptyState('نتیجه‌ای یافت نشد');
    } catch { el.innerHTML = emptyState('خطا در بارگذاری'); }
}

async function loadRequests(targetId) {
    const el = document.getElementById(targetId);
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const reqs = await apiGet('/api/requests');
        el.innerHTML = reqs.map(requestCard).join('') || emptyState('هنوز درخواستی ثبت نشده');
    } catch { el.innerHTML = emptyState('خطا در بارگذاری'); }
}

async function loadServices(targetId) {
    const el = document.getElementById(targetId);
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/service-requests');
        el.innerHTML = items.map(serviceCard).join('') || emptyState('هنوز درخواست خدماتی ثبت نشده');
    } catch { el.innerHTML = emptyState('خطا در بارگذاری'); }
}

async function loadCompanies(targetId, limit) {
    const el = document.getElementById(targetId);
    if (!el) return;
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const items = await apiGet('/api/companies');
        const list = limit ? items.slice(0, limit) : items;
        el.innerHTML = list.map(companyCard).join('') || emptyState('هنوز واحدی ثبت نشده');
    } catch { el.innerHTML = emptyState('خطا در بارگذاری'); }
}

async function loadFiles() {
    const el = document.getElementById('filesList');
    el.innerHTML = '<div class="loading">در حال بارگذاری...</div>';
    try {
        const files = await apiGet('/api/admin-files');
        el.innerHTML = files.map(f => `
            <div class="card">
                <div class="card-header"><div class="card-title">${esc(f.title)}</div>${f.is_locked ? '<span class="badge badge-featured">🔒 نیازمند خرید</span>' : '<span class="badge badge-verified">رایگان</span>'}</div>
                <div class="card-body"><p style="font-size:0.85rem;">${esc(f.description||'')}</p></div>
                <div class="card-footer">
                    ${f.is_locked
                        ? `<a class="btn btn-outline btn-sm" href="tel:">برای خرید تماس بگیرید</a>`
                        : `<a class="btn btn-primary btn-sm" href="${esc(f.file_url)}" target="_blank">دانلود</a>`}
                </div>
            </div>`).join('') || emptyState('فعلاً فایلی ثبت نشده');
    } catch { el.innerHTML = emptyState('خطا در بارگذاری'); }
}

async function loadAds() {
    try {
        const ads = await apiGet('/api/ads/active');
        const el = document.getElementById('adSlotHome');
        if (!ads.length) { el.innerHTML = ''; return; }
        const ad = ads[0];
        let inner = '';
        if (ad.ad_type === 'image' && ad.image_url) inner = `<img src="${esc(ad.image_url)}" alt="${esc(ad.title||'تبلیغ')}">`;
        if (ad.ad_type === 'video' && ad.video_embed_url) inner = `<a href="${esc(ad.video_embed_url)}" target="_blank" class="btn btn-outline btn-sm">مشاهده ویدیو</a>`;
        el.innerHTML = `
            <div class="ad-slot">
                ${inner}
                <div>
                    <div class="ad-tag">تبلیغ</div>
                    <div style="font-weight:700;">${esc(ad.title||'')}</div>
                    <div style="font-size:0.82rem; color:var(--text-light);">${esc(ad.body_text||'')}</div>
                </div>
            </div>`;
    } catch { /* بی‌صدا رد می‌شویم؛ نبود تبلیغ مشکلی نیست */ }
}

// ------------------------------------------------------------------
// جستجو
// ------------------------------------------------------------------
let searchTimer;
function debouncedSearch(val) {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(async () => {
        if (!val) { loadHome(); return; }
        try {
            const offers = await apiGet('/api/offers?q=' + encodeURIComponent(val));
            document.getElementById('homeOffers').innerHTML = offers.slice(0, 6).map(offerCard).join('') || emptyState('نتیجه‌ای یافت نشد');
        } catch {}
    }, 400);
}

// ------------------------------------------------------------------
// فرم‌های چندمرحله‌ای
// ------------------------------------------------------------------
function spGoStep(step) {
    if (step === 2 && (!document.getElementById('spTitle').value.trim() || !document.getElementById('spCompany').value.trim() || !document.getElementById('spPhone').value.trim())) {
        showToast('عنوان محصول، نام شرکت و شماره تماس را وارد کنید', 'error'); return;
    }
    ['spStep1','spStep2'].forEach((id,i) => document.getElementById(id).classList.toggle('active', i === step-1));
    ['spDot1','spDot2'].forEach((id,i) => document.getElementById(id).classList.toggle('active', i === step-1));
    document.getElementById('spStepLabel').textContent = step === 1 ? 'مرحله ۱ از ۲ — مشخصات محصول' : 'مرحله ۲ از ۲ — قیمت و شرایط';
}
function prGoStep(step) {
    if (step === 2 && (!document.getElementById('prProduct').value.trim() || !document.getElementById('prQuantity').value.trim())) {
        showToast('نام محصول و مقدار موردنیاز را وارد کنید', 'error'); return;
    }
    ['prStep1','prStep2'].forEach((id,i) => document.getElementById(id).classList.toggle('active', i === step-1));
    ['prDot1','prDot2'].forEach((id,i) => document.getElementById(id).classList.toggle('active', i === step-1));
    document.getElementById('prStepLabel').textContent = step === 1 ? 'مرحله ۱ از ۲ — مشخصات محصول' : 'مرحله ۲ از ۲ — اطلاعات تماس';
}

// ------------------------------------------------------------------
// ارسال فرم‌ها
// ------------------------------------------------------------------
async function submitSupply() {
    const company = document.getElementById('spCompany').value.trim();
    const phone = document.getElementById('spPhone').value.trim();
    if (!company || !phone) { showToast('نام شرکت و شماره تماس الزامی است', 'error'); return; }
    try {
        await apiPost('/api/offers', {
            title: document.getElementById('spTitle').value.trim(),
            companyName: company, phone,
            county: document.getElementById('spCounty').value,
            category: document.getElementById('spCategory').value,
            price: document.getElementById('spPrice').value,
            moq: document.getElementById('spMOQ').value,
            payment: document.getElementById('spPayment').value,
            description: document.getElementById('spDescription').value,
        });
        showToast('عرضه شما ثبت شد', 'success');
        closeModal('supplyModal'); spGoStep(1);
        ['spTitle','spCompany','spPhone','spPrice','spMOQ','spDescription'].forEach(id => document.getElementById(id).value = '');
        loadHome();
    } catch (e) { showToast(e.message, 'error'); }
}

async function submitPurchaseRequest() {
    const company = document.getElementById('prCompany').value.trim();
    const phone = document.getElementById('prPhone').value.trim();
    if (!company || !phone) { showToast('نام شرکت و شماره تماس الزامی است', 'error'); return; }
    try {
        await apiPost('/api/requests', {
            product: document.getElementById('prProduct').value.trim(),
            specs: document.getElementById('prSpecs').value,
            quantity: document.getElementById('prQuantity').value,
            unit: document.getElementById('prUnit').value,
            county: document.getElementById('prCounty').value,
            deadline: document.getElementById('prDeadline').value,
            priceRange: document.getElementById('prPriceRange').value,
            payment: document.getElementById('prPayment').value,
            description: document.getElementById('prDescription').value,
            company, contactPerson: document.getElementById('prContactPerson').value, phone,
        });
        showToast('درخواست خرید ثبت شد', 'success');
        closeModal('purchaseRequestModal'); prGoStep(1);
        ['prProduct','prSpecs','prQuantity','prDeadline','prPriceRange','prDescription','prCompany','prContactPerson','prPhone'].forEach(id => document.getElementById(id).value = '');
        loadHome();
    } catch (e) { showToast(e.message, 'error'); }
}

async function respondToRequest(id) {
    try {
        await apiPost(`/api/requests/${id}/respond`, { companyName: 'یک تأمین‌کننده' });
        showToast('اعلام آمادگی شما ثبت شد', 'success');
        loadHome(); loadRequests('requestsList');
    } catch (e) { showToast(e.message, 'error'); }
}

async function submitServiceRequest() {
    const company = document.getElementById('srCompany').value.trim();
    const phone = document.getElementById('srPhone').value.trim();
    if (!company || !phone) { showToast('نام شرکت و شماره تماس الزامی است', 'error'); return; }
    try {
        await apiPost('/api/service-requests', {
            roleTitle: document.getElementById('srRole').value.trim(),
            serviceCategory: document.getElementById('srCategory').value,
            description: document.getElementById('srDescription').value,
            county: document.getElementById('srCounty').value,
            company, contactPerson: '', phone,
        });
        showToast('درخواست خدمات ثبت شد', 'success');
        closeModal('serviceRequestModal');
        ['srRole','srDescription','srCompany','srPhone'].forEach(id => document.getElementById(id).value = '');
        loadServices('servicesList');
    } catch (e) { showToast(e.message, 'error'); }
}

function openRfq(offerId) { document.getElementById('rfqOfferId').value = offerId; openModal('rfqModal'); }
async function submitRfq() {
    const phone = document.getElementById('rfqPhone').value.trim();
    if (!phone) { showToast('شماره تماس الزامی است', 'error'); return; }
    try {
        await apiPost('/api/rfqs', {
            offerId: document.getElementById('rfqOfferId').value,
            companyName: document.getElementById('rfqCompany').value,
            personName: document.getElementById('rfqPerson').value,
            phone, quantity: document.getElementById('rfqQuantity').value,
            message: document.getElementById('rfqMessage').value,
        });
        showToast('استعلام شما ارسال شد', 'success');
        closeModal('rfqModal');
    } catch (e) { showToast(e.message, 'error'); }
}

async function submitAdRequest() {
    const advertiser = document.getElementById('adAdvertiser').value.trim();
    const phone = document.getElementById('adPhone').value.trim();
    if (!advertiser || !phone) { showToast('نام و شماره تماس الزامی است', 'error'); return; }
    try {
        const adType = document.getElementById('adType').value;
        let imageUrl = '', videoEmbedUrl = '';
        if (adType === 'image') {
            try { imageUrl = await uploadFile(document.getElementById('adImage')); }
            catch (e) { showToast('آپلود تصویر ناموفق بود: ' + e.message, 'error'); return; }
        }
        if (adType === 'video') videoEmbedUrl = document.getElementById('adVideoUrl').value.trim();
        await apiPost('/api/ads', {
            adType,
            title: document.getElementById('adTitle').value,
            bodyText: document.getElementById('adBody').value,
            imageUrl, videoEmbedUrl,
            advertiserName: advertiser, advertiserPhone: phone,
        });
        showToast('درخواست تبلیغ شما ثبت شد؛ به‌زودی با شما تماس گرفته می‌شود', 'success');
        closeModal('adRequestModal');
    } catch (e) { showToast(e.message, 'error'); }
}

// ------------------------------------------------------------------
// جزئیات
// ------------------------------------------------------------------
async function showOfferDetails(id) {
    try {
        const o = await apiGet('/api/offers/' + id);
        document.getElementById('detailsTitle').textContent = o.title;
        document.getElementById('detailsBody').innerHTML = `
            <p><b>شرکت:</b> ${esc(o.company_name)}</p>
            <p><b>قیمت:</b> ${esc(o.price||'توافقی')} ${esc(o.unit||'')}</p>
            <p><b>شهرستان:</b> ${esc(o.county||'')}</p>
            <p><b>شرایط پرداخت:</b> ${esc(o.payment||'')}</p>
            <p style="margin-top:0.5rem;">${esc(o.description||'')}</p>
            <button class="btn btn-primary" style="width:100%; margin-top:1rem;" onclick="closeModal('detailsModal'); openRfq(${o.id})">درخواست استعلام قیمت</button>
        `;
        openModal('detailsModal');
    } catch (e) { showToast(e.message, 'error'); }
}
function showRequestDetails(id) {
    apiGet('/api/requests').then(list => {
        const r = list.find(x => x.id === id);
        if (!r) return;
        document.getElementById('detailsTitle').textContent = r.product;
        document.getElementById('detailsBody').innerHTML = `
            <p><b>شرکت درخواست‌دهنده:</b> ${esc(r.company)}</p>
            <p><b>مقدار:</b> ${esc(r.quantity)} ${esc(r.unit||'')}</p>
            <p><b>مشخصات:</b> ${esc(r.specs||'-')}</p>
            <p><b>زمان تأمین:</b> ${esc(r.deadline||'-')}</p>
            <p style="margin-top:0.5rem;">${esc(r.description||'')}</p>
            <button class="btn btn-gold" style="width:100%; margin-top:1rem;" onclick="closeModal('detailsModal'); respondToRequest(${r.id})">من می‌توانم تأمین کنم</button>
        `;
        openModal('detailsModal');
    });
}

// ------------------------------------------------------------------
// شروع
// ------------------------------------------------------------------
window.addEventListener('DOMContentLoaded', () => {
    loadLookups(); loadHome(); trackView('/home');
});
