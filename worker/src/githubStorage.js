// ===================================================================
// ذخیره فایل با GitHub به‌جای R2 (چون R2 در ایران در دسترس نیست)
// فایل‌ها با GitHub Contents API در یک ریپازیتوری جدا ذخیره می‌شوند
// و از طریق jsDelivr (که یک CDN رایگان و جهانی است) سرو می‌شوند.
// ===================================================================

function bufToBase64(buf) {
  const bytes = new Uint8Array(buf);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export async function uploadToGithub(env, path, arrayBuffer, contentType) {
  const owner = env.GITHUB_OWNER;
  const repo = env.GITHUB_UPLOADS_REPO;
  const branch = env.GITHUB_BRANCH || 'main';
  const token = env.GITHUB_TOKEN;
  if (!owner || !repo || !token) {
    throw new Error('تنظیمات GitHub برای آپلود فایل کامل نیست (GITHUB_OWNER / GITHUB_UPLOADS_REPO / GITHUB_TOKEN)');
  }

  const base64Content = bufToBase64(arrayBuffer);
  const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

  const res = await fetch(apiUrl, {
    method: 'PUT',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'tolid-markazi-worker',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      message: `آپلود فایل: ${path}`,
      content: base64Content,
      branch,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`آپلود به GitHub ناموفق بود (${res.status}): ${errText.slice(0, 200)}`);
  }

  // آدرس عمومی سریع از طریق jsDelivr (CDN رایگان و جهانی، معمولاً از ایران هم در دسترس است)
  const jsdelivrUrl = `https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${path}`;
  // آدرس پشتیبان (fallback) مستقیم از GitHub، اگر jsDelivr در دسترس نبود
  const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;

  return { url: jsdelivrUrl, fallbackUrl: rawUrl, path };
}
