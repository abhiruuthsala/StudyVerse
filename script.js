// ════════════════════════════════════════════════════════════════
//  StudyVerse — script.js (Supabase Integration)
//  Handles: Auth · File Upload · Resource Load · Gemini Backend
// ════════════════════════════════════════════════════════════════

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

// ── Supabase Config ───────────────────────────────────────────
const SUPABASE_URL = 'https://ftingspmkdrdkddsdgtv.supabase.co';
const SUPABASE_KEY = 'sb_publishable_05OdVMx0I5A-AICIHdDN4g_U_cpzVm3';
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
window.supabase = supabase;   // expose globally for inline scripts

// ════════════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════════════

/** Sign up a new user — stores display name in user_metadata & profiles table */
window._sbSignUp = async (email, password, name) => {
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { name } }
  });
  if (error) throw error;
  // Profile row is also auto-created by the DB trigger (handle_new_user)
  return data;
};

/** Sign in an existing user */
window._sbSignIn = async (email, password) => {
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
};

/** Sign out */
window._sbSignOut = async () => {
  const { error } = await supabase.auth.signOut();
  if (error) throw error;
};

/** Get the active session (null if not logged in) */
window._sbGetSession = async () => {
  const { data: { session } } = await supabase.auth.getSession();
  return session;
};

/** Fetch the profile row for a user id */
window._sbGetProfile = async (userId) => {
  const { data, error } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', userId)
    .maybeSingle();
  if (error) { console.warn('Profile fetch error:', error.message); return null; }
  return data;
};

/** Update profile fields (e.g. name, avatar_url) */
window._sbUpdateProfile = async (userId, updates) => {
  const { error } = await supabase
    .from('profiles')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('id', userId);
  if (error) throw error;
};

// ── Auth state listener ───────────────────────────────────────
supabase.auth.onAuthStateChange(async (event, session) => {
  if ((event === 'SIGNED_IN' || event === 'INITIAL_SESSION') && session) {
    const profile = await window._sbGetProfile(session.user.id);
    const userData = {
      id      : session.user.id,
      email   : session.user.email,
      name    : profile?.name
              || session.user.user_metadata?.name
              || session.user.email.split('@')[0],
      isAdmin : profile?.is_admin === true,
      session,
    };
    if (window._onSupabaseAuth) window._onSupabaseAuth('signin', userData);
  } else if (event === 'SIGNED_OUT') {
    if (window._onSupabaseAuth) window._onSupabaseAuth('signout', null);
  }
});

// ════════════════════════════════════════════════════════════════
//  FILE UPLOAD
// ════════════════════════════════════════════════════════════════

/**
 * Upload a file to Supabase Storage and insert a metadata row.
 * @param {{ file, title, subject, topic, desc, uploaderEmail, uploaderName, type, onProgress }} opts
 * @returns {string} public file URL
 */
window._sbUpload = async ({ file, title, subject, topic, desc, uploaderEmail, uploaderName, type, onProgress }) => {
  // 1 — get current user
  const { data: { user } } = await supabase.auth.getUser();
  const userId = user?.id ?? null;

  // 2 — unique storage path
  const ext      = file.name.split('.').pop().toLowerCase();
  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const storagePath = `${subject}/${userId ?? 'anon'}/${Date.now()}_${safeName}`;

  // 3 — upload file
  const { error: uploadErr } = await supabase.storage
    .from('resources')
    .upload(storagePath, file, { cacheControl: '3600', upsert: false });
  if (uploadErr) throw uploadErr;

  if (onProgress) onProgress(70);

  // 4 — public URL
  const { data: urlData } = supabase.storage
    .from('resources')
    .getPublicUrl(storagePath);
  const publicUrl = urlData.publicUrl;

  // 5 — insert metadata row
  const { error: dbErr } = await supabase
    .from('resources')
    .insert([{
      title,
      subject,
      topic       : topic || 'General',
      description : desc  || '',
      file_url    : publicUrl,
      file_name   : file.name,
      file_size   : file.size,
      type        : type || 'article',
      source_type : 'file',
      uploaded_by : userId,
      uploader_email: uploaderEmail,
      uploader_name : uploaderName,
    }]);
  if (dbErr) throw dbErr;

  if (onProgress) onProgress(100);
  return publicUrl;
};

/** Insert a URL-type resource */
window._sbUploadUrl = async ({ url, title, subject, topic, desc, type, uploaderEmail, uploaderName }) => {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('resources').insert([{
    title, subject, topic: topic || 'General',
    description: desc || '', url, type: type || 'link',
    source_type: 'url',
    uploaded_by: user?.id, uploader_email: uploaderEmail, uploader_name: uploaderName,
  }]);
  if (error) throw error;
};

/** Insert a text/notes resource */
window._sbUploadText = async ({ body, title, subject, topic, desc, type, uploaderEmail, uploaderName }) => {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('resources').insert([{
    title, subject, topic: topic || 'General',
    description: desc || '', body, type: type || 'article',
    source_type: 'text',
    uploaded_by: user?.id, uploader_email: uploaderEmail, uploader_name: uploaderName,
  }]);
  if (error) throw error;
};

// ════════════════════════════════════════════════════════════════
//  LOAD RESOURCES
// ════════════════════════════════════════════════════════════════

/**
 * Load all resources from Supabase.
 * Returns an array in the same shape the front-end content array expects,
 * so existing render functions work without changes.
 */
window._sbLoadResources = async () => {
  const { data, error } = await supabase
    .from('resources')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.warn('Resource load error:', error.message);
    return null;
  }

  // Map Supabase columns → front-end item shape
  return data.map(r => ({
    id           : r.id,
    title        : r.title,
    subject      : r.subject,
    topic        : r.topic || 'General',
    desc         : r.description || '',
    type         : r.type || 'article',
    sourceType   : r.source_type || 'file',
    fileUrl      : r.file_url,
    fileName     : r.file_name,
    fileSize     : r.file_size,
    url          : r.url,
    body         : r.body,
    uploader     : r.uploader_name || r.uploader_email || 'Unknown',
    uploaderEmail: r.uploader_email || '',
    uploadedBy   : r.uploaded_by,
    date         : r.created_at
                   ? new Date(r.created_at).toLocaleDateString('en-GB', { day:'numeric', month:'short', year:'numeric' })
                   : '',
  }));
};

/** Delete a resource row (and its storage file if it has one) */
window._sbDeleteResource = async (id) => {
  // First fetch the row to get the storage path
  const { data: row } = await supabase.from('resources').select('file_url').eq('id', id).maybeSingle();

  if (row?.file_url) {
    // Extract path from URL: everything after /storage/v1/object/public/resources/
    const match = row.file_url.match(/\/resources\/(.+)$/);
    if (match) {
      await supabase.storage.from('resources').remove([match[1]]);
    }
  }

  const { error } = await supabase.from('resources').delete().eq('id', id);
  if (error) throw error;
};

// ════════════════════════════════════════════════════════════════
//  GEMINI CHAT  (calls the secure Supabase Edge Function)
// ════════════════════════════════════════════════════════════════

/**
 * Send a message to Gemini via the backend Edge Function.
 * The API key is NEVER exposed to the browser.
 *
 * @param {Array}  history  – previous [{role, parts}] turns
 * @param {string} message  – latest user message
 * @returns {string} AI reply text
 */
window._geminiChat = async (history, message) => {
  // Attach the user's JWT so the edge function can verify auth
  const { data: { session } } = await supabase.auth.getSession();
  const authToken = session?.access_token ?? SUPABASE_KEY;

  const res = await fetch(`${SUPABASE_URL}/functions/v1/gemini-proxy`, {
    method : 'POST',
    headers: {
      'Content-Type' : 'application/json',
      'Authorization': `Bearer ${authToken}`,
      'apikey'       : SUPABASE_KEY,
    },
    body: JSON.stringify({ history, message }),
  });

  const data = await res.json().catch(() => ({}));

  if (!res.ok) {
    throw new Error(data?.message || data?.error || `Gemini proxy error (${res.status})`);
  }
  if (!data.reply) {
    throw new Error('Empty response from Gemini backend');
  }
  return data.reply;
};

// ════════════════════════════════════════════════════════════════
//  REALTIME CHAT  (community chat room via Supabase Realtime)
// ════════════════════════════════════════════════════════════════

let chatChannel = null;

window._sbInitChat = (onMessage) => {
  if (chatChannel) supabase.removeChannel(chatChannel);

  chatChannel = supabase
    .channel('studyverse-chat')
    .on('broadcast', { event: 'message' }, ({ payload }) => {
      if (onMessage) onMessage(payload);
    })
    .subscribe();
};

window._sbSendChatMsg = async (sender, text) => {
  if (!chatChannel) return;
  await chatChannel.send({
    type : 'broadcast',
    event: 'message',
    payload: { sender, text, ts: Date.now() },
  });
};
