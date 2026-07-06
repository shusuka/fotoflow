// FotoFlow — upload terjadwal ke Facebook Page via Graph API
// Butuh: Page ID + Page Access Token (izin pages_manage_posts, pages_read_engagement)
// Jadwal harus 10 menit s/d 75 hari ke depan (aturan Facebook).

const GRAPH = 'https://graph.facebook.com/v21.0';

export async function fbCheckToken(pageId, token) {
  const res = await fetch(`${GRAPH}/${pageId}?fields=name,id&access_token=${encodeURIComponent(token)}`);
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j; // { name, id }
}

export async function fbSchedulePhoto({ pageId, token, file, caption, publishAt }) {
  const ts = Math.floor(publishAt.getTime() / 1000);
  const min = Math.floor(Date.now() / 1000) + 10 * 60;
  if (ts < min) throw new Error('Jadwal minimal 10 menit dari sekarang (aturan Facebook).');
  const form = new FormData();
  form.append('source', file, file.name);
  form.append('caption', caption || '');
  form.append('published', 'false');
  form.append('scheduled_publish_time', String(ts));
  form.append('access_token', token);
  const res = await fetch(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: form });
  const j = await res.json();
  if (j.error) throw new Error(j.error.message);
  return j; // { id, post_id }
}
