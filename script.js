// ════════════════════════════════════════════════════════════════
//  StudyVerse — script.js (Supabase Integration)
//  Handles: Auth · File Upload · Resource Load · AB Ai Backend
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

/** Upload a new avatar image to Storage and return its public URL. Does NOT update the profile row. */
window._sbUploadAvatar = async (userId, file) => {
  const ext = (file.name.split('.').pop() || 'png').toLowerCase();
  const path = `${userId}/${Date.now()}.${ext}`;
  const { error: upErr } = await supabase.storage
    .from('avatars')
    .upload(path, file, { cacheControl: '3600', upsert: true });
  if (upErr) throw upErr;
  const { data } = supabase.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
};

/** Count total registered users from the profiles table */
window._sbCountUsers = async () => {
  const { count, error } = await supabase
    .from('profiles')
    .select('*', { count: 'exact', head: true });
  if (error) { console.warn('User count error:', error.message); return 0; }
  return count || 0;
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
      avatarUrl: profile?.avatar_url || null,
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

/** Update a resource row's editable fields (title, topic, description, body) */
window._sbUpdateResource = async (id, updates) => {
  const { error } = await supabase
    .from('resources')
    .update(updates)
    .eq('id', id);
  if (error) throw error;
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
//  AI CHAT — "AB Ai"  (calls Supabase Edge Function — claude-proxy or llama-proxy)
//  The API key is NEVER exposed to the browser.
//
//  To enable Claude AI:
//    1. Deploy supabase/functions/claude-proxy  (see README)
//    2. supabase secrets set ANTHROPIC_API_KEY=sk-ant-...
//
//  To use AB Ai's default backend (Llama 3.1 via Groq) instead:
//    supabase secrets set GROQ_API_KEY=gsk_...
// ════════════════════════════════════════════════════════════════

/**
 * Send a message to AB Ai via the backend Edge Function.
 * Tries claude-proxy first, falls back to llama-proxy (Llama 3.1).
 *
 * @param {Array}  history  – previous [{role, parts}] turns
 * @param {string} message  – latest user message
 * @returns {string} AI reply text
 */
window._abAiChat = async (history, message) => {
  const { data: { session } } = await supabase.auth.getSession();
  // Use JWT access_token when available; anon key as fallback
  const authToken = session?.access_token ?? SUPABASE_KEY;

  const headers = {
    'Content-Type' : 'application/json',
    'Authorization': `Bearer ${authToken}`,
    'apikey'       : SUPABASE_KEY,
  };
  const body = JSON.stringify({ history, message });

  // Try endpoints in order — claude-proxy first, llama-proxy (Llama 3.1) as fallback
const endpoints = [
  `${SUPABASE_URL}/functions/v1/gemini-proxy`,
];

  let lastErr;
  for (const url of endpoints) {
    try {
      const res = await fetch(url, { method: 'POST', headers, body });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        lastErr = new Error(data?.message || data?.error || `Proxy error (${res.status})`);
        continue;   // try next endpoint
      }
      if (!data.reply) {
        lastErr = new Error('Empty response from AI backend');
        continue;
      }
      return data.reply;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('All AI proxies failed');
};

// ════════════════════════════════════════════════════════════════
//  PERSISTENT CHAT  (community chat room — stored in DB + Realtime)
//  Messages are stored in the `chat_messages` table so every visitor
//  sees the full history (not just people currently online), and new
//  messages are pushed live via Supabase Realtime (postgres_changes).
// ════════════════════════════════════════════════════════════════

let chatChannel = null;

/** Load the most recent chat messages from the database. */
window._sbLoadChatMessages = async (limit = 50) => {
  const { data, error } = await supabase
    .from('chat_messages')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) { console.warn('Chat load error:', error.message); return []; }
  return data
    .map(m => ({
      id    : m.id,
      author: m.author_name || 'Unknown',
      text  : m.text,
      time  : m.created_at
              ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
              : '',
      userId: m.user_id,
    }))
    .reverse();
};

/** Subscribe to new chat messages in real time. onMessage receives the same shape as _sbLoadChatMessages rows. */
window._sbInitChat = (onMessage) => {
  if (chatChannel) supabase.removeChannel(chatChannel);

  chatChannel = supabase
    .channel('studyverse-chat')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, (payload) => {
      const m = payload.new;
      if (onMessage) onMessage({
        id    : m.id,
        author: m.author_name || 'Unknown',
        text  : m.text,
        time  : m.created_at
                ? new Date(m.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
                : new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        userId: m.user_id,
      });
    })
    .subscribe();
};

/** Send a chat message — persisted to the DB so every user sees it. */
window._sbSendChatMsg = async (sender, text) => {
  const { data: { user } } = await supabase.auth.getUser();
  const { error } = await supabase.from('chat_messages').insert([{
    author_name: sender,
    text,
    user_id: user?.id ?? null,
  }]);
  if (error) throw error;
};
