// app.js (komplett)
// - Innehåller ALLA funktioner (inga placeholders borttagna)
// - Har “Reject-modul”: adminRejectProduct + moderation-logg + notis + statusflöde
// - Non-admin: ny annons -> pending + visible=false (ej publik)
// - Rejected: visible=false, syns bara för säljaren i profilen + resubmit-knapp
// - Admin: historik-tab (“history”) med filter/sök + visar rejected-metadata
// - Reports: 100% i DB (ingen lokal reports-array)
// - Admin badges: pending från products-array + reports från DB
//
// OBS: För reject-modulen används tabeller/kolumner:
// products: status, visible, rejected_reason, rejected_at, rejected_by, resubmitted_at, updated_at
// notifications: user_id, type, title, body, product_id, is_read, created_at
// product_moderation_events: product_id, action, reason, actor_id, created_at
//
// Om du saknar någon av dessa i Supabase: säg till så skickar jag SQL-migration.

import { sb } from './supabaseClient.js';
import { CONFIG, ENV } from './config.js';

let currentUser = null;
let currentProduct = null;
let currentChat = null;
let msgChannel = null;
let currentChatId = null;

let tempImages = [];
let products = [];
let currentProfileTab = 'active';
let localFavorites = new Set();
let selectedCats = new Set();
let __modalZ = 3000;

// === Scroll lock (förhindrar hopp när modaler öppnas/stängs) ===
let __scrollY = 0;

function lockBodyScroll() {
  __scrollY = window.scrollY || document.documentElement.scrollTop || 0;
  unlockBodyScroll._pageId = document.querySelector('.page.active')?.id || '';
  document.body.style.overflow = 'hidden';
  document.body.style.paddingRight =
    (window.innerWidth - document.documentElement.clientWidth) + 'px';
}

function unlockBodyScroll() {
  document.body.style.overflow = '';
  document.body.style.paddingRight = '';

  const activePage = document.querySelector('.page.active')?.id || '';
  if (unlockBodyScroll._pageId && unlockBodyScroll._pageId === activePage) {
    window.scrollTo(0, __scrollY);
  }
  unlockBodyScroll._pageId = null;
}

// === Bilder ===
let currentImageIndex = 0;
const cardImageIndex = {};
const DEFAULT_IMAGE = 'https://placehold.co/600x400?text=Ingen+bild';

// ===========================
// ✅ STATUS / VISIBILITY RULES
// ===========================
function isPublicProduct(p) {
  // Home ska bara visa publika annonser
  return p && p.status === 'active' && p.visible !== false;
}

function normalizeProductFromDb(p) {
  const uniqueImages = [
    ...new Map(
      (p.product_images || [])
        .sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0))
        .map((img) => [img.url, img])
    ).values(),
  ];

  const imgs = uniqueImages.map((img) => img.url);

  return {
    id: p.id,
    title: p.title,
    price: p.price,
    category: p.category,
    location: p.location,
    description: p.description,
    seller: p.seller || 'Anonym',
    sellerId: p.seller_id,
    status: p.status || 'active',
    visible: p.visible !== false,
    createdAt: p.created_at,
    updatedAt: p.updated_at || null,
    date: p.created_at ? new Date(p.created_at).toLocaleDateString('sv-SE') : '',
    images: imgs.length ? imgs : [DEFAULT_IMAGE],

    // reject-flow (om finns)
    rejected_reason: p.rejected_reason ?? null,
    rejected_at: p.rejected_at ?? null,
    rejected_by: p.rejected_by ?? null,
    resubmitted_at: p.resubmitted_at ?? null,
  };
}

// =====================
// ✅ ADMIN “REJECT MODULE”
// =====================
async function adminNotifyUser({ userId, type, title, body, productId }) {
  if (!sb) return;
  const { error } = await sb.from('notifications').insert([
    {
      user_id: userId,
      type,
      title,
      body,
      product_id: productId ?? null,
      is_read: false,
    },
  ]);
  if (error) throw error;
}

let __rejectProductId = null;

function openRejectModal(productId) {
  __rejectProductId = String(productId);
  const input = document.getElementById('rejectReasonInput');
  if (input) input.value = '';
  showModal('rejectModal');

  // focus efter animation
  setTimeout(() => input?.focus(), 150);
}

function closeRejectModal() {
  __rejectProductId = null;
  closeModal('rejectModal');
}

async function confirmRejectModal() {
  const reason = (document.getElementById('rejectReasonInput')?.value || '').trim();
  if (!reason) {
    showToast('Skriv en anledning');
    return;
  }
  if (!__rejectProductId) {
    showToast('Fel: saknar produkt-id');
    return;
  }

  try {
    await adminRejectProduct(__rejectProductId, reason);
    await loadProducts();
    renderProducts();
    await updateAdminBadgesDb();
    renderAdminContent('pending');
    closeRejectModal();
    showToast('Annons avvisad + notis skickad');
  } catch (e) {
    console.error('confirmRejectModal error:', e);
    showToast('Kunde inte avvisa: ' + (e.message || 'okänt fel'));
  }
}


async function adminLogModeration({ productId, action, reason = null }) {
  if (!sb) return;
  // Om tabellen inte finns: detta kan kasta. Vill du “soft-faila” så säg till.
  const { error } = await sb.from('product_moderation_events').insert([
    {
      product_id: Number(productId),
      action,
      reason,
      actor_id: currentUser?.id || null,
      created_at: new Date().toISOString(),
    },
  ]);
  if (error) throw error;
}

async function adminApproveProduct(productId) {
  if (!currentUser?.isAdmin) throw new Error('Endast admin');

  // 1) Hämta produkt för notis
  const { data: prod, error: pErr } = await sb
    .from('products')
    .select('id, seller_id, title')
    .eq('id', productId)
    .single();

  if (pErr) throw pErr;

  // 2) approve => active + visible=true
  const { error } = await sb
    .from('products')
    .update({
      status: 'active',
      visible: true,
      updated_at: new Date().toISOString(),
    })
    .eq('id', productId);

  if (error) throw error;

  // 3) logg
  await adminLogModeration({ productId, action: 'approve', reason: null });

  // 4) notis (valfri men rekommenderad)
  if (prod?.seller_id) {
    try {
      await adminNotifyUser({
        userId: prod.seller_id,
        type: 'product_approved',
        title: 'Din annons är godkänd',
        body: `Annons: ${prod.title}\nStatus: Godkänd och publicerad.`,
        productId: prod.id,
      });
    } catch (e) {
      console.warn('approve notify failed:', e);
    }
  }

  return true;
}

async function adminRejectProduct(productId, reason) {
  if (!currentUser?.isAdmin) throw new Error('Inte behörig');

  const cleanReason = (reason || '').trim();
  if (!cleanReason) throw new Error('Orsak saknas');

  // 1) Hämta produkt
  const { data: prod, error: pErr } = await sb
    .from('products')
    .select('id, seller_id, title')
    .eq('id', productId)
    .single();

  if (pErr) throw pErr;

  const rejectedAt = new Date().toISOString();

  // 2) Uppdatera produkt
  const { error: uErr } = await sb
    .from('products')
    .update({
      status: 'rejected',
      visible: false,
      rejected_reason: cleanReason,
      rejected_at: rejectedAt,
      rejected_by: currentUser.id,
      updated_at: rejectedAt,
    })
    .eq('id', productId);

  if (uErr) throw uErr;

  // 3) Moderation-logg
  await adminLogModeration({
    productId: prod.id,
    action: 'reject',
    reason: cleanReason,
  });

  // 4) Notis till säljaren
  await adminNotifyUser({
    userId: prod.seller_id,
    type: 'product_rejected',
    title: 'Din annons blev avvisad',
    body: `Annons: ${prod.title}\nAnledning: ${cleanReason}`,
    productId: prod.id,
  });

  return true;
}

function formatDateTimeSv(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('sv-SE');
  } catch {
    return '—';
  }
}

function adminStatusLabel(status) {
  if (status === 'active')
    return `<span class="status-badge-small status-active">AKTIV</span>`;
  if (status === 'pending')
    return `<span class="status-badge-small status-pending">PENDING</span>`;
  if (status === 'rejected')
    return `<span class="status-badge-small" style="background:#fee2e2;color:#991b1b;">REJECTED</span>`;
  if (status === 'sold') return `<span class="badge-sold">SÅLD</span>`;
  return `<span class="status-badge-small" style="background:#e2e8f0;color:#0f172a;">${escapeHtml(
    status || '—'
  )}</span>`;
}

// ===========================
// INIT
// ===========================
window.onload = async function () {
  try {
    console.log('Initialiserar applikationen...');

    renderSkeletons();
    await loadProducts();
    await checkSupabaseSession();
    renderProducts();

    // Delegation: chat-list click
    const chatList = document.getElementById('chatList');
    if (chatList) {
      chatList.addEventListener('click', (e) => {
        const row = e.target.closest('.chat-conv');
        if (!row) return;
        if (e.target.closest('.delete-conv')) return;

        const id = row.getAttribute('data-id');
        if (!id || id === 'null' || id === 'undefined') {
          showToast('Fel: Konversationen har inget ID');
          return;
        }
        openConversationDb(id);
      });
    }

    const chatOverlay = document.getElementById('chatOverlay');
    const chatPanel = document.getElementById('chatPanel');

    if (chatOverlay) chatOverlay.addEventListener('click', () => closeChat());
    if (chatPanel) chatPanel.addEventListener('click', (e) => e.stopPropagation());

    // Escape + arrows in product modal + Enter send
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        closeAllModals();
        const panelOpen = document
          .getElementById('chatPanel')
          ?.classList.contains('show');
        if (panelOpen) {
          if (
            !document.getElementById('chatConversation').classList.contains('hidden')
          )
            backToChatList();
          else closeChat();
        }
      }

      const modal = document.getElementById('productModal');
      if (modal && modal.classList.contains('show')) {
        const tag = (document.activeElement?.tagName || '').toLowerCase();
        if (tag !== 'input' && tag !== 'textarea') {
          if (e.key === 'ArrowRight') nextImage();
          if (e.key === 'ArrowLeft') prevImage();
        }
      }

      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        const chatPanel = document.getElementById('chatPanel');
        const chatConv = document.getElementById('chatConversation');
        const msgInput = document.getElementById('msgInput');

        if (
          chatPanel?.classList.contains('show') &&
          !chatConv?.classList.contains('hidden') &&
          document.activeElement === msgInput
        ) {
          e.preventDefault();
          sendMessage();
        }
      }
    });

    // close user menu if click outside
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#userAvatar') && !e.target.closest('#userMenu')) {
        document.getElementById('userMenu')?.classList.add('hidden');
      }
    });

    // Auth state change
    if (sb) {
      sb.auth.onAuthStateChange(async (event, session) => {
        console.log('Auth state change:', event, session?.user?.id);

        if (event === 'PASSWORD_RECOVERY') {
          showToast('Välj ett nytt lösenord');
          setTimeout(() => {
            const newPass = prompt('Ange ditt nya lösenord (minst 6 tecken):');
            if (newPass && newPass.length >= 6) {
              sb.auth.updateUser({ password: newPass }).then(({ error }) => {
                if (error) showToast('Kunde inte uppdatera: ' + error.message);
                else {
                  showToast('Lösenord uppdaterat! Vänligen logga in igen.');
                  sb.auth.signOut();
                }
              });
            }
          }, 1000);
          return;
        }

        if (session?.user) await loginFromAuth(session.user);
        else applyLoggedOutUI();

        // notifications: toast + mark as read
        if (session?.user) {
          const notifs = await fetchUnreadNotifications();
          if (notifs.length) {
            showToast(notifs[0].title);
            await markNotificationsRead(notifs.map((n) => n.id));
          }
        }
      });
    }

    setInterval(async () => {
      if (currentUser) await updateChatBadge();
    }, 10000);

    updateCatUI();
    initCatMultiSelect();

    console.log('Applikation initialiserad');
  } catch (err) {
    console.error('Init error:', err);
    showToast('Fel vid uppstart: ' + err.message);
  }
};

function initCatMultiSelect() {
  const root = document.getElementById('catMulti');
  const menu = document.getElementById('catMultiMenu');
  if (!root || !menu) return;

  root.addEventListener('pointerdown', (e) => e.stopPropagation());
  menu.addEventListener('pointerdown', (e) => e.stopPropagation());

  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!root.contains(e.target)) menu.classList.add('hidden');
    },
    true
  );
}

// ===========================
// DATA
// ===========================
async function loadProducts() {
  try {
    products = await fetchProductsFromSupabase();
    console.log('Loaded products:', products.length);
  } catch (e) {
    console.error('Kunde inte ladda produkter:', e);
    products = [];
  }
}

async function fetchProductsFromSupabase() {
  const { data, error } = await sb
    .from('products')
    .select(`*, product_images ( url, sort_order )`)
    .order('created_at', { ascending: false });

  if (error) throw error;
  return (data || []).map(normalizeProductFromDb);
}

async function createProductInSupabase(product, imageUrls) {
  const payload = {
    title: product.title,
    price: product.price,
    category: product.category,
    location: product.location,
    description: product.description,
    seller: product.seller,
    seller_id: product.sellerId,
    status: product.status,
    visible: product.visible,
    updated_at: new Date().toISOString(),
  };

  const { data: created, error: pErr } = await sb
    .from('products')
    .insert([payload])
    .select()
    .single();

  if (pErr) throw pErr;

  if (imageUrls && imageUrls.length) {
    const rows = imageUrls.map((url, i) => ({
      product_id: created.id,
      url: url,
      sort_order: i,
    }));
    const { error } = await sb.from('product_images').insert(rows);
    if (error) throw error;
  }
  return created;
}

async function updateProductInSupabase(productId, updates, imageUrls) {
  const { error: pErr } = await sb
    .from('products')
    .update({
      title: updates.title,
      price: updates.price,
      category: updates.category,
      location: updates.location,
      description: updates.description,
      updated_at: new Date().toISOString(),
    })
    .eq('id', productId);

  if (pErr) throw pErr;

  if (imageUrls) {
    await sb.from('product_images').delete().eq('product_id', productId);
    if (imageUrls.length > 0) {
      const rows = imageUrls.map((url, i) => ({
        product_id: productId,
        url: url,
        sort_order: i,
      }));
      const { error } = await sb.from('product_images').insert(rows);
      if (error) throw error;
    }
  }
  return true;
}

async function deleteProductFromSupabase(productId) {
  const { error } = await sb.from('products').delete().eq('id', productId);
  if (error) throw error;
  return true;
}

async function updateProductStatus(productId, status) {
  const { error } = await sb
    .from('products')
    .update({ status: status, updated_at: new Date().toISOString() })
    .eq('id', productId);

  if (error) {
    // fallback (om updated_at saknas i schema)
    const { error: err2 } = await sb
      .from('products')
      .update({ status: status })
      .eq('id', productId);
    if (err2) throw err2;
  }
}

async function checkSupabaseSession() {
  if (!sb) return;
  const { data, error } = await sb.auth.getSession();
  if (error) {
    console.error('Session error:', error);
    return;
  }
  if (data?.session?.user) await loginFromAuth(data.session.user);
}

async function getMyProfile(userId) {
  const { data, error } = await sb
    .from('profiles')
    .select('id, name, email, is_admin')
    .eq('id', userId)
    .maybeSingle();

  if (error) {
    console.error('getMyProfile error:', error);
    return null;
  }
  return data;
}

// ===========================
// AUTH
// ===========================
let authMode = 'login';

function openAuth() {
  authMode = 'login';
  updateAuthUI();
  document.getElementById('forgotPasswordLink')?.classList.remove('hidden');
  showModal('authModal');
}

function toggleAuthMode() {
  authMode = authMode === 'login' ? 'signup' : 'login';
  updateAuthUI();
  const forgotLink = document.getElementById('forgotPasswordLink');
  if (forgotLink) forgotLink.classList.toggle('hidden', authMode === 'signup');
}

function updateAuthUI() {
  document.getElementById('authTitle').textContent =
    authMode === 'login' ? 'Logga in' : 'Skapa konto';
  document.getElementById('authActionBtn').textContent =
    authMode === 'login' ? 'Logga in' : 'Registrera dig';
  document.getElementById('authToggleBtn').textContent =
    authMode === 'login' ? 'Skapa konto istället' : 'Har du redan konto?';
  document.getElementById('authNameField').classList.toggle('hidden', authMode === 'login');
}

async function handleAuth() {
  if (!sb) {
    showToast('Databasen är inte ansluten');
    return;
  }
  const email = document.getElementById('authEmail').value.trim().toLowerCase();
  const pass = document.getElementById('authPass').value;
  if (!email || !pass) {
    showToast('Fyll i e-post och lösenord');
    return;
  }

  try {
    if (authMode === 'signup') {
      const name = document.getElementById('authName').value.trim();
      if (!name) {
        showToast('Fyll i namn');
        return;
      }

      const { data, error } = await sb.auth.signUp({
        email,
        password: pass,
        options: { data: { name } },
      });
      if (error) {
        showToast(error.message || 'Kunde inte skapa konto');
        return;
      }

      if (!data?.session) {
        showToast('Konto skapat! Bekräfta e-post innan du kan logga in.');
        closeModal('authModal');
        return;
      }
      closeModal('authModal');
      await loginFromAuth(data.session.user);
    } else {
      const { data, error } = await sb.auth.signInWithPassword({ email, password: pass });
      if (error) {
        showToast('Fel e-post eller lösenord');
        return;
      }
      closeModal('authModal');
      if (data?.user) await loginFromAuth(data.user);
    }
  } catch (e) {
    showToast('Något gick fel: ' + e.message);
  }
}

async function loginFromAuth(authUser) {
  console.log('Loggar in användare:', authUser.id);
  let profile = await getMyProfile(authUser.id);

  if (!profile) {
    const { data: newProfile } = await sb
      .from('profiles')
      .insert([
        {
          id: authUser.id,
          name:
            authUser.user_metadata?.name ||
            authUser.email?.split('@')[0] ||
            'Användare',
          email: authUser.email,
          is_admin: false,
        },
      ])
      .select()
      .single();
    if (newProfile) profile = newProfile;
  }

  currentUser = {
    id: authUser.id,
    email: authUser.email,
    name:
      profile?.name ||
      authUser.user_metadata?.name ||
      authUser.email?.split('@')[0] ||
      'Användare',
    isAdmin: !!profile?.is_admin,
  };

  await refreshFavoritesCache();
  applyLoggedInUI(currentUser);
  updateChatBadge();
  showToast('Välkommen ' + currentUser.name + '!');

  if (currentUser.isAdmin) {
    await updateAdminBadgesDb();
  }
}

function applyLoggedInUI(user) {
  document.getElementById('authBtn').classList.add('hidden');
  document.getElementById('userAvatar').classList.remove('hidden');
  document.getElementById('sellBtn').classList.remove('hidden');
  document.getElementById('chatBtn').classList.remove('hidden');

  const initials = (user.name || '??').substring(0, 2).toUpperCase();
  document.getElementById('userAvatar').textContent = initials;
  document.getElementById('pName').textContent = user.name;
  document.getElementById('pEmail').textContent = user.email;
  document.getElementById('pAvatar').textContent = initials;

  if (user.isAdmin) document.getElementById('adminMenuItem').classList.remove('hidden');
  else document.getElementById('adminMenuItem').classList.add('hidden');
}

function applyLoggedOutUI() {
  currentUser = null;
  localFavorites.clear();
  document.getElementById('authBtn').classList.remove('hidden');
  document.getElementById('userAvatar').classList.add('hidden');
  document.getElementById('sellBtn').classList.add('hidden');
  document.getElementById('chatBtn').classList.add('hidden');
  document.getElementById('adminMenuItem').classList.add('hidden');
  closeChat();
}

async function logout() {
  if (!sb) return;
  await sb.auth.signOut();
  applyLoggedOutUI();
  showToast('Du är utloggad');
  showHome();
}

function toggleMenu(e) {
  e.stopPropagation();
  document.getElementById('userMenu')?.classList.toggle('hidden');
}

// ===========================
// NAV / PAGES
// ===========================
function hideAllPages() {
  document.querySelectorAll('.page').forEach((p) => p.classList.remove('active'));
}

function showHome() {
  hideAllPages();
  document.getElementById('pageHome').classList.add('active');
  renderProducts();
  document.getElementById('userMenu')?.classList.add('hidden');
  window.scrollTo(0, 0);
}

function showProfile() {
  if (!currentUser) return;
  hideAllPages();
  document.getElementById('pageProfile').classList.add('active');
  switchTab('active', document.querySelector('#pageProfile .tab-btn'));
  document.getElementById('userMenu')?.classList.add('hidden');
  updateChatBadge();
  refreshNotifications();
  window.scrollTo(0, 0);
}

function showAdmin() {
  if (!currentUser?.isAdmin) {
    showToast('Endast för administratörer');
    return;
  }
  hideAllPages();
  document.getElementById('pageAdmin').classList.add('active');
  setAdminTab('overview', document.querySelector('.admin-nav-item'));
  document.getElementById('userMenu')?.classList.add('hidden');
  window.scrollTo(0, 0);
}

// ===========================
// FAVORITES
// ===========================
async function refreshFavoritesCache() {
  if (!currentUser || !sb) return;
  const { data, error } = await sb
    .from('favorites')
    .select('product_id')
    .eq('user_id', currentUser.id);

  if (!error && data) {
    localFavorites = new Set(data.map((f) => String(f.product_id)));
  }
}

async function toggleFav(id, event) {
  if (event) event.stopPropagation();
   if (!currentUser) {
    showToast('Logga in för att spara favoriter');
    openAuth();                 // ✅ öppna login-modalen
    return;
  }

  const productId = String(id);
  const isCurrentlyFav = localFavorites.has(productId);

  if (isCurrentlyFav) {
    localFavorites.delete(productId);
    showToast('Borttagen från favoriter');
  } else {
    localFavorites.add(productId);
    showToast('Sparad som favorit');
  }

  renderProducts();
  updateChatBadge();

  if (
    document.getElementById('pageProfile').classList.contains('active') &&
    currentProfileTab === 'favorites'
  ) {
    const activeBtn = document.querySelector('#pageProfile .tab-btn.active');
    if (activeBtn) switchTab('favorites', activeBtn);
  }

  if (currentProduct && String(currentProduct.id) === productId) {
    updateModalFavoriteButton(productId);
  }

  try {
    if (isCurrentlyFav) {
      await sb
        .from('favorites')
        .delete()
        .eq('user_id', currentUser.id)
        .eq('product_id', productId);
    } else {
      await sb.from('favorites').insert([{ user_id: currentUser.id, product_id: productId }]);
    }
  } catch (e) {
    console.error('Favoritfel:', e);
    showToast('Kunde inte spara ändring, återställer...');
    if (isCurrentlyFav) localFavorites.add(productId);
    else localFavorites.delete(productId);
    renderProducts();
  }
}

async function toggleFavoriteFromModal() {
  if (!currentProduct) return;
  await toggleFav(currentProduct.id);
}

async function updateModalFavoriteButton(productId) {
  if (!currentUser) {
    const b = document.getElementById('modalFavBtn');
    if (b) {
      b.innerHTML = '🤍 Favorit';
      b.style.background = '';
    }
    return;
  }

  const isFav = localFavorites.has(String(productId));
  const btn = document.getElementById('modalFavBtn');
  if (btn) {
    btn.innerHTML = isFav ? '❤️ Favorit' : '🤍 Favorit';
    btn.style.background = isFav ? '#fee2e2' : '';
  }
}

async function removeFromFavorites(productId) {
  if (!currentUser) return;
  localFavorites.delete(String(productId));
  showToast('Borttagen från favoriter');
  updateChatBadge();

  const activeBtn = document.querySelector('#pageProfile .tab-btn.active');
  if (activeBtn && currentProfileTab === 'favorites') {
    switchTab('favorites', activeBtn);
  }
  renderProducts();

  try {
    await sb.from('favorites').delete().eq('user_id', currentUser.id).eq('product_id', productId);
  } catch (e) {
    showToast('Fel vid borttagning, återställer...');
    localFavorites.add(String(productId));
    if (activeBtn) switchTab('favorites', activeBtn);
  }
}

// ===========================
// UI: skeletons, categories
// ===========================
function renderSkeletons(count = 6) {
  const grid = document.getElementById('productsGrid');
  if (!grid) return;

  grid.innerHTML = Array.from({ length: count })
    .map(
      () => `
    <div class="skeleton">
      <div class="sk-img"></div>
      <div class="sk-body">
        <div class="sk-line w80"></div>
        <div class="sk-line w60"></div>
        <div class="sk-line w40"></div>
      </div>
    </div>
  `
    )
    .join('');

  const noResults = document.getElementById('noResults');
  if (noResults) noResults.classList.add('hidden');
}

function toggleCatMenu(e) {
  e.stopPropagation();
  document.getElementById('catMultiMenu')?.classList.toggle('hidden');
}

function onCatChange(e) {
  if (e) e.stopPropagation();
  const menu = document.getElementById('catMultiMenu');
  const checks = menu ? Array.from(menu.querySelectorAll('input[type="checkbox"]')) : [];
  selectedCats = new Set(checks.filter((c) => c.checked).map((c) => c.value));
  updateCatUI();
}

function clearCats() {
  const menu = document.getElementById('catMultiMenu');
  if (menu) menu.querySelectorAll('input[type="checkbox"]').forEach((c) => (c.checked = false));
  selectedCats.clear();
  updateCatUI();
  renderProducts();
}

function applyCats() {
  document.getElementById('catMultiMenu')?.classList.add('hidden');
  renderProducts();
}

function removeCat(cat) {
  const menu = document.getElementById('catMultiMenu');
  const cb = menu ? menu.querySelector(`input[type="checkbox"][value="${cat}"]`) : null;
  if (cb) cb.checked = false;
  selectedCats.delete(cat);
  updateCatUI();
  renderProducts();
}

function updateCatUI() {
  const label = document.getElementById('catMultiLabel');
  const chips = document.getElementById('catChips');

  const names = {
    leksaker: '🧸 Leksaker',
    barnvagn: '🍼 Barnvagnar',
    bilbarnstol: '🚗 Bilbarnstolar',
    kläder: '👕 Kläder',
    möbler: '🛏️ Möbler',
  };

  const arr = Array.from(selectedCats);

  if (label) {
    label.textContent = arr.length === 0 ? 'Alla kategorier' : `${arr.length} valda`;
  }

  if (chips) {
    chips.innerHTML = arr
      .map(
        (c) => `
      <span class="chip">
        ${names[c] || c}
        <button type="button" onclick="removeCat('${c}')">×</button>
      </span>
    `
      )
      .join('');
  }
}

// ===========================
// HOME: RENDER PRODUCTS
// ===========================
async function renderProducts() {
  const grid = document.getElementById('productsGrid');
  const search = (document.getElementById('searchInput').value || '').toLowerCase();
  const loc = document.getElementById('filterLoc').value;

  let list = products.filter(isPublicProduct);

  if (search) list = list.filter((p) => (p.title || '').toLowerCase().includes(search));
  if (loc) list = list.filter((p) => p.location === loc);
  if (selectedCats.size > 0) list = list.filter((p) => selectedCats.has(p.category));

  if (list.length === 0) {
    grid.innerHTML = '';
    document.getElementById('noResults').classList.remove('hidden');
    return;
  }
  document.getElementById('noResults').classList.add('hidden');

  const favIds = Array.from(localFavorites);

  for (const p of list) {
    if (cardImageIndex[p.id] == null) cardImageIndex[p.id] = 0;
    const max = Math.max((p.images?.length || 1) - 1, 0);
    cardImageIndex[p.id] = Math.min(Math.max(cardImageIndex[p.id], 0), max);
  }

  grid.innerHTML = list
    .map((p) => {
      const isFav = favIds.includes(String(p.id));
      const imgCount = p.images?.length ? p.images.length : 1;
      const idx = cardImageIndex[p.id] ?? 0;
      const imgUrl = p.images?.[idx] || DEFAULT_IMAGE;

      return `
      <div class="card" onclick="openProduct('${p.id}')">
        <div style="position: relative;">
          <div class="card-image-wrapper" style="position: relative;">

            ${
              imgCount > 1
                ? `
              <button class="card-img-nav left"
                onclick="event.stopPropagation(); cardPrevImage('${p.id}')"
                title="Föregående">‹</button>
            `
                : ''
            }

            <img id="cardImg-${p.id}"
                 src="${imgUrl}"
                 class="card-img"
                 alt="${escapeHtml(p.title)}"
                 onerror="this.src='${DEFAULT_IMAGE}'">

            ${
              imgCount > 1
                ? `
              <button class="card-img-nav right"
                onclick="event.stopPropagation(); cardNextImage('${p.id}')"
                title="Nästa">›</button>
            `
                : ''
            }

          </div>

          <button class="fav-btn ${isFav ? 'active' : ''}" 
                  onclick="event.stopPropagation(); toggleFav('${p.id}', event)"
                  style="${isFav ? 'background: #fee2e2;' : ''}">
            ${isFav ? '❤️' : '🤍'}
          </button>
        </div>

        <div class="card-body">
          <div class="card-title">${escapeHtml(p.title)}</div>
          <div class="card-price">${p.price} kr</div>
          <div class="card-meta">
            <span>📍 ${escapeHtml(p.location)}</span>
            <span>${escapeHtml(p.date)}</span>
          </div>
        </div>
      </div>
    `;
    })
    .join('');
}

function setCat() {
  renderProducts();
}

// ===========================
// PRODUCT MODAL
// ===========================
async function openProduct(id) {
  currentProduct = products.find((p) => String(p.id) === String(id));
  if (!currentProduct) return;

  const hasMultiple = (currentProduct.images || []).length > 1;
  const prevBtn = document.getElementById('prevImgBtn');
  const nextBtn = document.getElementById('nextImgBtn');
  if (prevBtn) prevBtn.classList.toggle('hidden', !hasMultiple);
  if (nextBtn) nextBtn.classList.toggle('hidden', !hasMultiple);

  document.getElementById('modalTitle').textContent = currentProduct.title;
  document.getElementById('modalPrice').textContent = currentProduct.price + ' kr';
  document.getElementById('modalMeta').textContent = `${currentProduct.location} • ${currentProduct.date} • ${currentProduct.category}`;
  document.getElementById('modalDesc').textContent = currentProduct.description || 'Ingen beskrivning.';
  document.getElementById('modalSellerName').textContent = currentProduct.seller;
  document.getElementById('modalSellerAvatar').textContent = (currentProduct.seller || '??').substring(0, 2).toUpperCase();

  currentImageIndex = 0;

  const thumbsDiv = document.getElementById('modalThumbs');
  if (thumbsDiv) thumbsDiv.classList.toggle('hidden', !hasMultiple);

  if (hasMultiple) {
    thumbsDiv.innerHTML = currentProduct.images
      .map(
        (img, i) => `
      <img src="${img}"
           style="width:60px;height:60px;object-fit:cover;border-radius:8px;
                  cursor:pointer;border:2px solid transparent;flex-shrink:0;"
           onclick="selectImage(${i})"
           onerror="this.style.display='none'">
    `
      )
      .join('');
  } else {
    thumbsDiv.innerHTML = '';
  }

  updateModalImage();
  updateArrowState();

  document.getElementById('modalImg').onerror = function () {
    this.src = DEFAULT_IMAGE;
  };

  // status
  const statusDiv = document.getElementById('modalStatus');
  if (currentProduct.status === 'sold') {
    statusDiv.innerHTML = '<span class="badge-sold">SÅLD</span>';
  } else if (currentProduct.status === 'pending') {
    statusDiv.innerHTML = '<span class="status-badge-small status-pending">VÄNTAR PÅ GRANSKNING</span>';
  } else if (currentProduct.status === 'rejected') {
    const reason = currentProduct.rejected_reason
      ? escapeHtml(currentProduct.rejected_reason)
      : 'Ingen anledning angiven';
    statusDiv.innerHTML = `
      <span class="status-badge-small" style="background:#fee2e2;color:#991b1b;">AVVISAD</span>
      <div style="margin-top:8px; font-size:13px; color:#991b1b;">${reason}</div>
    `;
  } else {
    statusDiv.innerHTML = '<span class="status-badge-small status-active">AKTIV</span>';
  }

  const isOwner = currentUser && String(currentUser.id) === String(currentProduct.sellerId);
  const isSold = currentProduct.status === 'sold';

  const contactBtn = document.getElementById('btnContact');
  contactBtn.style.display = isOwner || isSold ? 'none' : 'inline-flex';

  document.getElementById('ownerActions').classList.toggle('hidden', !isOwner);

  if (isOwner) {
    document.getElementById('btnSold').textContent =
      currentProduct.status === 'sold' ? '↩ Ångra såld' : '✓ Markera som såld';
  }

  await updateModalFavoriteButton(id);
  showModal('productModal');
}

// ===========================
// PROFILE TABS
// ===========================
async function switchTab(tab, btn) {
  currentProfileTab = tab;
  document.querySelectorAll('#pageProfile .tab-btn').forEach((b) => b.classList.remove('active'));
  btn.classList.add('active');

  const content = document.getElementById('tabContent');

  if (tab === 'active') {
    const myProducts = products.filter(
      (p) =>
        String(p.sellerId) === String(currentUser.id) &&
        ['active', 'pending', 'rejected'].includes(p.status)
    );

    if (myProducts.length === 0) {
      content.innerHTML =
        '<div style="text-align: center; padding: 40px; color: #64748b;">Du har inga aktiva annonser</div>';
      return;
    }
    content.innerHTML = myProducts.map((p) => renderProductItem(p, 'active')).join('');
  } else if (tab === 'history') {
    const history = products.filter(
      (p) => String(p.sellerId) === String(currentUser.id) && p.status === 'sold'
    );
    if (history.length === 0) {
      content.innerHTML =
        '<div style="text-align: center; padding: 40px; color: #64748b;">Ingen historik</div>';
      return;
    }
    content.innerHTML = history.map((p) => renderProductItem(p, 'history')).join('');
  } else if (tab === 'favorites') {
    const favIds = Array.from(localFavorites);
    if (favIds.length === 0) {
      content.innerHTML =
        '<div style="text-align: center; padding: 40px; color: #64748b;">Inga favoriter sparade</div>';
      return;
    }
    const favProducts = products.filter(
      (p) => favIds.includes(String(p.id)) && p.status === 'active'
    );
    if (favProducts.length === 0) {
      content.innerHTML =
        '<div style="text-align: center; padding: 40px; color: #64748b;">Dina favoriter är inte längre tillgängliga</div>';
      return;
    }
    content.innerHTML = favProducts.map((p) => renderProductItem(p, 'favorite')).join('');
  }
}

function renderProductItem(p, type) {
  const isSold = p.status === 'sold';
  const isPending = p.status === 'pending';
  const isRejected = p.status === 'rejected';

  const statusBadge = isSold
    ? '<span class="badge-sold">SÅLD</span>'
    : isPending
    ? '<span class="status-badge-small status-pending">VÄNTAR</span>'
    : isRejected
    ? '<span class="status-badge-small" style="background:#fee2e2;color:#991b1b;">AVVISAD</span>'
    : '';

  const imgUrl = p.images?.[0] || DEFAULT_IMAGE;

  let actionsHtml = '';

  if (type === 'favorite') {
    actionsHtml = `
      <div class="item-actions">
        <button class="btn btn-soft"
                onclick="event.stopPropagation(); removeFromFavorites('${p.id}')"
                style="border-color: var(--danger); color: var(--danger);">
          💔 Ta bort från favoriter
        </button>
      </div>
    `;
  } else if (type === 'active') {
    actionsHtml = `
      <div class="item-actions" onclick="event.stopPropagation()">

        ${!isPending && !isRejected ? `<button class="btn btn-success" onclick="event.stopPropagation(); quickSold('${p.id}')">✓ Såld</button>` : ''}

        ${
          isRejected
            ? `<button class="btn btn-warning" onclick="event.stopPropagation(); resubmitProduct('${p.id}')">🔁 Skicka igen</button>`
            : ''
        }

        <button class="btn btn-danger" onclick="event.stopPropagation(); prepDelete('${p.id}')">
          🗑️ Ta bort annons permanent
        </button>
      </div>
    `;

    // Visa anledning inline om rejected
    if (isRejected && p.rejected_reason) {
      actionsHtml =
        `
        <div style="margin-top:8px; font-size:13px; color:#991b1b;">
          <b>Anledning:</b> ${escapeHtml(p.rejected_reason)}
        </div>
      ` + actionsHtml;
    }
  } else if (type === 'history') {
    actionsHtml = `
      <div class="item-actions" onclick="event.stopPropagation()">
        <button class="btn btn-success" onclick="event.stopPropagation(); quickSold('${p.id}')">↩ Ångra såld</button>
      </div>
    `;
  }

  return `
    <div class="list-item" style="${isSold ? 'opacity: 0.7;' : ''} cursor: pointer;" onclick="openProduct('${p.id}')">
      <img src="${imgUrl}" class="item-thumb" style="${isSold ? 'filter: grayscale(1);' : ''}" onerror="this.src='${DEFAULT_IMAGE}'">
      <div class="item-content" style="flex: 1;">
        <div class="item-title" style="${isSold ? 'text-decoration: line-through;' : ''}">
          ${escapeHtml(p.title)} ${statusBadge}
        </div>
        <div class="item-meta">${p.price} kr • ${escapeHtml(p.location)}</div>
        ${actionsHtml}
      </div>
    </div>
  `;
}

// ===========================
// SELL / EDIT / DELETE
// ===========================
async function quickSold(id, e) {
  if (e) e.stopPropagation();
  const p = products.find((x) => String(x.id) === String(id));
  if (!p) return;

  try {
    const newStatus = p.status === 'sold' ? 'active' : 'sold';
    await updateProductStatus(p.id, newStatus);
    await loadProducts();
    renderProducts();

    const activeBtn = document.querySelector('#pageProfile .tab-btn.active');
    if (activeBtn) switchTab(currentProfileTab, activeBtn);

    updateChatBadge();
    showToast(newStatus === 'sold' ? 'Markerad som såld' : 'Återaktiverad');
  } catch {
    showToast('Kunde inte uppdatera');
  }
}

function prepDelete(id) {
  event.stopPropagation();
  currentProduct = products.find((x) => String(x.id) === String(id));
  if (currentProduct) showModal('deleteModal');
}

async function confirmDelete() {
  if (!currentProduct) return;

  try {
    await deleteProductFromSupabase(currentProduct.id);
    await loadProducts();
    renderProducts();
    updateChatBadge();
    showToast('Annons borttagen permanent');
    closeModal('deleteModal');

    if (document.getElementById('pageProfile').classList.contains('active')) {
      const activeBtn = document.querySelector('#pageProfile .tab-btn.active');
      if (activeBtn) switchTab(currentProfileTab, activeBtn);
    }
  } catch {
    showToast('Kunde inte ta bort annonsen');
  }
}

function openSellModal() {
  if (!currentUser) {
    showToast('Logga in för att sälja');
    openAuth();
    return;
  }
  tempImages = [];
  document.getElementById('sellTitleInput').value = '';
  document.getElementById('sellPrice').value = '';
  document.getElementById('sellDesc').value = '';
  document.getElementById('editId').value = '';
  document.getElementById('sellTitle').textContent = 'Ny annons';
  document.getElementById('imagePreviewGrid').innerHTML = '';
  document.getElementById('pendingNotice')?.classList.toggle('hidden', !!currentUser.isAdmin);
  showModal('sellModal');
}

async function previewImages(input) {
  const files = Array.from(input.files);
  if (files.length === 0) return;

  const remainingSlots = 6 - tempImages.length;
  if (remainingSlots <= 0) {
    showToast('Max 6 bilder tillåtna');
    input.value = '';
    return;
  }

  const filesToProcess = files.slice(0, remainingSlots);
  if (files.length > remainingSlots) {
    showToast(`Bara ${remainingSlots} bilder fick plats (max 6 totalt)`);
  }

  try {
    const promises = filesToProcess.map((file) => {
      return new Promise((resolve, reject) => {
        if (file.size > 2 * 1024 * 1024) {
          reject(new Error(`${file.name} är för stor (max 2MB)`));
          return;
        }
        const reader = new FileReader();
        reader.onload = (e) => resolve(e.target.result);
        reader.onerror = reject;
        reader.readAsDataURL(file);
      });
    });

    const results = await Promise.all(promises);
    tempImages.push(...results);
    renderImagePreviews();
  } catch (err) {
    showToast('Fel vid bildläsning: ' + err.message);
  }

  input.value = '';
}

function renderImagePreviews() {
  const grid = document.getElementById('imagePreviewGrid');
  if (tempImages.length === 0) {
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = tempImages
    .map(
      (img, i) => `
      <div class="img-preview">
        <img src="${img}">
        <button type="button" class="remove-img" onclick="removeImage(${i})">✕</button>
      </div>
    `
    )
    .join('');
}

function removeImage(idx) {
  tempImages.splice(idx, 1);
  renderImagePreviews();
}

async function submitProduct() {
  const title = document.getElementById('sellTitleInput').value.trim();
  const price = parseInt(document.getElementById('sellPrice').value);
  const cat = document.getElementById('sellCat').value;
  const loc = document.getElementById('sellLoc').value;
  const desc = document.getElementById('sellDesc').value.trim();
  const editId = document.getElementById('editId').value;

  if (!currentUser) {
    showToast('Logga in för att sälja');
    return;
  }
  if (!title || !price) {
    showToast('Fyll i titel och pris');
    return;
  }

  const uniqueImages = [...new Set(tempImages)];

  try {
    if (editId) {
      await updateProductInSupabase(
        editId,
        { title, price, category: cat, location: loc, description: desc },
        uniqueImages
      );
      showToast('Annons uppdaterad!');
    } else {
      const isAdmin = !!currentUser.isAdmin;

      // ✅ Ny: non-admin => pending + visible=false
      const newProduct = {
        title,
        price,
        category: cat,
        location: loc,
        description: desc,
        seller: currentUser.name,
        sellerId: currentUser.id,
        status: isAdmin ? 'active' : 'pending',
        visible: isAdmin ? true : false,
      };

      const imagesToSave = uniqueImages.length > 0 ? uniqueImages : [DEFAULT_IMAGE];
      await createProductInSupabase(newProduct, imagesToSave);
      showToast(isAdmin ? 'Annons publicerad' : 'Annons skickad till granskning');
    }

    tempImages = [];
    await loadProducts();
    renderProducts();
    updateChatBadge();
    if (currentUser?.isAdmin) await updateAdminBadgesDb();
    closeModal('sellModal');
  } catch (e) {
    console.error('Sparfel:', e);
    showToast('Kunde inte spara: ' + e.message);
  }
}

function editProduct() {
  if (!currentProduct) return;

  closeModal('productModal');
  document.getElementById('sellTitle').textContent = 'Redigera annons';
  document.getElementById('sellTitleInput').value = currentProduct.title;
  document.getElementById('sellPrice').value = currentProduct.price;
  document.getElementById('sellCat').value = currentProduct.category;
  document.getElementById('sellLoc').value = currentProduct.location;
  document.getElementById('sellDesc').value = currentProduct.description || '';
  document.getElementById('editId').value = currentProduct.id;
  document.getElementById('pendingNotice')?.classList.add('hidden');

  tempImages = [...new Set((currentProduct.images || []).filter((img) => img !== DEFAULT_IMAGE))];
  renderImagePreviews();

  showModal('sellModal');
}

async function markSold() {
  if (!currentProduct) return;
  try {
    const newStatus = currentProduct.status === 'sold' ? 'active' : 'sold';
    await updateProductStatus(currentProduct.id, newStatus);
    await loadProducts();
    renderProducts();
    updateChatBadge();
    showToast(newStatus === 'sold' ? 'Markerad som såld' : 'Återaktiverad');
    closeModal('productModal');
  } catch {
    showToast('Kunde inte uppdatera status');
  }
}

function deleteProduct() {
  closeModal('productModal');
  showModal('deleteModal');
}

// ===========================
// REJECT / RESUBMIT (seller)
// ===========================
async function resubmitProduct(id) {
  if (!currentUser) return;

  try {
    const p = products.find((x) => String(x.id) === String(id));
    if (!p || String(p.sellerId) !== String(currentUser.id)) return;

    const now = new Date().toISOString();

    const { error } = await sb
      .from('products')
      .update({
        status: 'pending',
        visible: false,
        resubmitted_at: now,
        updated_at: now,
      })
      .eq('id', id);

    if (error) throw error;

    // logg (valfritt men nice för admin-history)
    try {
      await adminLogModeration({
        productId: id,
        action: 'resubmit',
        reason: null,
      });
    } catch (e) {
      console.warn('resubmit log failed:', e);
    }

    await loadProducts();
    renderProducts();

    const activeBtn = document.querySelector('#pageProfile .tab-btn.active');
    if (activeBtn) switchTab('active', activeBtn);

    if (currentUser?.isAdmin) await updateAdminBadgesDb();
    showToast('Skickad igen för granskning');
  } catch (e) {
    console.error('resubmitProduct error:', e);
    showToast('Kunde inte skicka igen: ' + (e.message || 'okänt fel'));
  }
}

// ===========================
// FORGOT PASSWORD
// ===========================
function forgotPassword() {
  document.getElementById('forgotEmail').value = '';
  closeModal('authModal');
  showModal('forgotPasswordModal');
}

async function submitForgotPassword() {
  const email = document.getElementById('forgotEmail').value.trim();
  if (!email) return;
  try {
    const { error } = await sb.auth.resetPasswordForEmail(email, {
      redirectTo: window.location.origin + window.location.pathname,
    });
    if (error) showToast(error.message);
    else {
      showToast('Återställningslänk skickad! Kolla din e-post.');
      closeModal('forgotPasswordModal');
    }
  } catch {
    showToast('Kunde inte skicka återställningslänk');
  }
}

// ===========================
// CHAT BADGE
// ===========================
async function updateChatBadge() {
  if (!currentUser || !sb) return;

  try {
    const { data: convs, error } = await sb
      .from('conversations')
      .select('buyer_id, seller_id, buyer_unread, seller_unread')
      .or(`buyer_id.eq.${currentUser.id},seller_id.eq.${currentUser.id}`);

    if (error) throw error;

    let totalUnread = 0;
    for (const conv of convs || []) {
      const isBuyer = String(conv.buyer_id) === String(currentUser.id);
      const unreadCount = isBuyer ? conv.buyer_unread || 0 : conv.seller_unread || 0;
      totalUnread += unreadCount;
    }

    const badge = document.getElementById('chatBadge');
    const chatBtn = document.getElementById('chatBtn');

    if (totalUnread > 0) {
      badge.textContent = totalUnread > 99 ? '99+' : totalUnread;
      badge.classList.remove('hidden');
      chatBtn.style.position = 'relative';
    } else {
      badge.classList.add('hidden');
    }
  } catch (e) {
    console.error('Kunde inte uppdatera badge:', e);
  }
}

// ===========================
// CHAT
// ===========================
async function openChat() {
  if (!currentUser) {
    showToast('Logga in för att chatta');
    return;
  }

  document.getElementById('chatPanel').classList.add('show');
  document.getElementById('chatOverlay').classList.add('show');
  lockBodyScroll();

  try {
    await loadConversationsDb();
  } catch (e) {
    console.error(e);
    showToast('Kunde inte ladda konversationer');
  }
}

function closeChat() {
  cleanupChatRealtime();
  document.getElementById('chatPanel').classList.remove('show');
  document.getElementById('chatOverlay').classList.remove('show');
  document.getElementById('chatConversation').classList.add('hidden');

  currentChat = null;
  currentChatId = null;

  const anyModalOpen = document.querySelector('.modal.show');
  if (!anyModalOpen) unlockBodyScroll();
}

async function loadConversationsDb() {
  if (!currentUser) return;

  const list = document.getElementById('chatList');
  list.innerHTML = '<div style="padding: 20px; color:#64748b;">Laddar...</div>';

  try {
    const { data: convs, error } = await sb
      .from('conversations')
      .select('*')
      .or(`buyer_id.eq.${currentUser.id},seller_id.eq.${currentUser.id}`)
      .order('updated_at', { ascending: false });

    if (error) throw error;

    const visible = (convs || []).filter((c) => {
      const isBuyer = String(c.buyer_id) === String(currentUser.id);
      const isSeller = String(c.seller_id) === String(currentUser.id);
      if (isBuyer && c.buyer_deleted === true) return false;
      if (isSeller && c.seller_deleted === true) return false;
      return true;
    });

    if (visible.length === 0) {
      list.innerHTML =
        '<div style="padding: 20px; text-align: center; color: #64748b;">Inga konversationer än</div>';
      return;
    }

    const enriched = [];
    for (const c of visible) {
      const isBuyer = String(c.buyer_id) === String(currentUser.id);
      const otherId = isBuyer ? c.seller_id : c.buyer_id;
      let otherName = await getDisplayName(otherId);
      if (!otherName) otherName = 'Okänd användare';

      const prod = products.find((p) => String(p.id) === String(c.product_id));
      enriched.push({ ...c, otherId, otherName, productTitle: prod?.title || null });
    }

    list.innerHTML = enriched
      .map(
        (c) => `
      <div class="chat-conv" data-id="${String(c.id)}">
        <div style="width: 40px; height: 40px; border-radius: 50%; background: linear-gradient(135deg, #fb923c, #ec4899); display:flex; align-items:center; justify-content:center; color:white; font-weight:700; flex-shrink:0;">
          ${(c.otherName || '??').substring(0, 2).toUpperCase()}
        </div>
        <div style="flex: 1; min-width: 0;">
          <div style="font-weight: 700;">${escapeHtml(c.otherName || 'Okänd')}</div>
          <div style="font-size: 14px; color: #64748b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">
            ${escapeHtml(c.last_message || 'Inga meddelanden')}
          </div>
          ${
            c.productTitle
              ? `<div style="font-size: 12px; color: var(--primary); margin-top: 2px;">📦 ${escapeHtml(
                  c.productTitle.substring(0, 30)
                )}${c.productTitle.length > 30 ? '...' : ''}</div>`
              : ''
          }
        </div>
        <button class="delete-conv" onclick="event.stopPropagation(); deleteConversationFromList('${String(
          c.id
        )}')" title="Ta bort">🗑️</button>
      </div>
    `
      )
      .join('');
  } catch (e) {
    console.error('Fel i loadConversationsDb:', e);
    list.innerHTML =
      '<div style="padding: 20px; color:#ef4444;">Kunde inte ladda konversationer</div>';
  }
}

async function deleteConversationFromList(conversationId) {
  if (
    !currentUser ||
    !confirm(
      'Radera denna konversation? Den kommer att försvinna från din lista, men den andra parten behåller sin kopia.'
    )
  )
    return;

  try {
    const convIdNum = Number(conversationId);

    const { data: conv, error: convErr } = await sb
      .from('conversations')
      .select('id,buyer_id,seller_id')
      .eq('id', convIdNum)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) {
      showToast('Konversationen finns inte');
      return;
    }

    const isBuyer = String(currentUser.id) === String(conv.buyer_id);
    const update = isBuyer ? { buyer_deleted: true } : { seller_deleted: true };

    const { error: updErr } = await sb.from('conversations').update(update).eq('id', convIdNum);

    if (updErr) throw updErr;

    await loadConversationsDb();
    await updateChatBadge();
    showToast('Konversation raderad från din lista');
  } catch (e) {
    console.error(e);
    showToast('Kunde inte radera chatten');
  }
}

async function openConversationDb(conversationId) {
  if (!currentUser) return;

  if (conversationId == null || conversationId === 'null' || conversationId === 'undefined') {
    showToast('Kunde inte öppna chatten (saknar ID)');
    return;
  }

  const convIdNum = Number(conversationId);
  if (!Number.isFinite(convIdNum)) {
    showToast('Kunde inte öppna chatten (fel id-format)');
    return;
  }

  try {
    const { data: conv, error } = await sb
      .from('conversations')
      .select('*')
      .eq('id', convIdNum)
      .maybeSingle();

    if (error) throw error;
    if (!conv) {
      showToast('Konversationen finns inte längre');
      return;
    }

    const isBuyer = String(conv.buyer_id) === String(currentUser.id);
    const isSeller = String(conv.seller_id) === String(currentUser.id);

    if (isBuyer && conv.buyer_deleted === true) {
      showToast('Du har tagit bort denna konversation');
      return;
    }
    if (isSeller && conv.seller_deleted === true) {
      showToast('Du har tagit bort denna konversation');
      return;
    }

    currentChatId = String(conv.id);

    const otherId = isBuyer ? conv.seller_id : conv.buyer_id;
    let otherName = await getDisplayName(otherId);
    if (!otherName) otherName = isBuyer ? 'Säljare' : 'Köpare';

    currentChat = {
      id: conv.id,
      otherId,
      otherName,
      isBuyer,
      productId: conv.product_id,
    };

    document.getElementById('chatConversation').classList.remove('hidden');
    document.getElementById('chatName').textContent = otherName;
    document.getElementById('chatAvatar').textContent = (otherName || '??').substring(0, 2).toUpperCase();

    const msgInput = document.getElementById('msgInput');
    if (msgInput) {
      msgInput.value = '';
      setTimeout(() => msgInput.focus(), 100);
    }

    const prod = products.find((p) => String(p.id) === String(conv.product_id));
    if (prod) {
      document.getElementById('chatProductImg').src = prod.images?.[0] || DEFAULT_IMAGE;
      document.getElementById('chatProductTitle').textContent = prod.title || '--';
      document.getElementById('chatProductPrice').textContent =
        prod.price != null ? prod.price + ' kr' : '';
      document.getElementById('chatProductInfo').classList.remove('hidden');
    } else {
      document.getElementById('chatProductInfo').classList.add('hidden');
    }

    document.querySelectorAll('.chat-conv').forEach((el) => el.classList.remove('active'));
    const activeEl = document.querySelector(`.chat-conv[data-id="${String(conv.id)}"]`);
    if (activeEl) activeEl.classList.add('active');

    await loadMessagesDb(String(conv.id));
    subscribeToMessages(String(conv.id));
    await markConversationAsRead(conv.id);
  } catch (e) {
    console.error('Fel i openConversationDb:', e);
    showToast('Kunde inte öppna chatten');
  }
}

async function markConversationAsRead(conversationId) {
  if (!currentUser || !sb) return;

  try {
    const { data: conv, error: fetchErr } = await sb
      .from('conversations')
      .select('buyer_id, seller_id')
      .eq('id', conversationId)
      .single();

    if (fetchErr) throw fetchErr;

    const isBuyer = String(conv.buyer_id) === String(currentUser.id);
    const updateField = isBuyer ? 'buyer_unread' : 'seller_unread';

    const { error } = await sb.from('conversations').update({ [updateField]: 0 }).eq('id', conversationId);

    if (error) throw error;
    await updateChatBadge();
  } catch (e) {
    console.error('Kunde inte markera som läst:', e);
  }
}

async function loadMessagesDb(conversationId) {
  const container = document.getElementById('chatMessages');
  container.innerHTML = '<div style="text-align:center; color:#64748b; margin-top:40px;">Laddar...</div>';

  try {
    const { data: msgs, error } = await sb
      .from('messages')
      .select('*')
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true });

    if (error) throw error;

    if (!msgs || msgs.length === 0) {
      container.innerHTML =
        '<div style="text-align: center; color: #64748b; margin-top: 40px;">Skriv första meddelandet</div>';
      return;
    }

    container.innerHTML = msgs
      .map(
        (m) => `
      <div class="msg ${String(m.sender_id) === String(currentUser.id) ? 'sent' : 'received'}">
        ${escapeHtml(m.body)}
        <div class="msg-time">${
          m.created_at
            ? new Date(m.created_at).toLocaleTimeString('sv-SE', {
                hour: '2-digit',
                minute: '2-digit',
              })
            : ''
        }</div>
      </div>
    `
      )
      .join('');

    container.scrollTop = container.scrollHeight;
  } catch (e) {
    console.error('Fel i loadMessagesDb:', e);
    container.innerHTML =
      '<div style="text-align:center; color:#ef4444; margin-top:40px;">Kunde inte ladda meddelanden</div>';
  }
}

async function sendMessage() {
  const input = document.getElementById('msgInput');
  if (!input) {
    showToast('Fel: Chattfältet saknas');
    return;
  }
  const text = input.value.trim();

  if (!text) return;
  if (!currentChatId) {
    showToast('Fel: Ingen aktiv konversation');
    return;
  }
  if (!currentUser) {
    showToast('Fel: Du måste vara inloggad');
    return;
  }

  try {
    const { data: conv, error: convFetchErr } = await sb
      .from('conversations')
      .select('buyer_id, seller_id, buyer_unread, seller_unread')
      .eq('id', Number(currentChatId))
      .single();

    if (convFetchErr) throw convFetchErr;

    const isBuyer = String(conv.buyer_id) === String(currentUser.id);
    const receiverField = isBuyer ? 'seller_unread' : 'buyer_unread';
    const currentUnread = conv[receiverField] || 0;
    const newUnread = currentUnread + 1;

    const { error: unreadErr } = await sb
      .from('conversations')
      .update({ [receiverField]: newUnread })
      .eq('id', Number(currentChatId));
    if (unreadErr) throw unreadErr;

    const { error: msgErr } = await sb.from('messages').insert([
      {
        conversation_id: Number(currentChatId),
        sender_id: currentUser.id,
        body: text,
        created_at: new Date().toISOString(),
      },
    ]);
    if (msgErr) throw msgErr;

    const { error: convErr } = await sb
      .from('conversations')
      .update({
        last_message: text,
        updated_at: new Date().toISOString(),
      })
      .eq('id', Number(currentChatId));
    if (convErr) throw convErr;

    input.value = '';

    await loadMessagesDb(currentChatId);
    await loadConversationsDb();
    await updateChatBadge();
  } catch (e) {
    console.error('Fel i sendMessage:', e);
    showToast('Kunde inte skicka: ' + (e.message || 'okänt fel'));
  }
}

async function getDisplayName(userId) {
  try {
    const { data, error } = await sb.from('profiles').select('name').eq('id', userId).maybeSingle();
    if (error) return null;
    return data?.name || null;
  } catch {
    return null;
  }
}

function cleanupChatRealtime() {
  try {
    if (msgChannel && sb) sb.removeChannel(msgChannel);
  } catch (e) {
    console.error('Fel vid cleanup:', e);
  }
  msgChannel = null;
}

function subscribeToMessages(conversationId) {
  cleanupChatRealtime();
  if (!sb) return;

  msgChannel = sb
    .channel('messages_changes')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, async (payload) => {
      const msg = payload.new;
      if (currentChatId && String(msg.conversation_id) === String(currentChatId)) {
        await loadMessagesDb(currentChatId);
      }
      await loadConversationsDb();
      await updateChatBadge();
    })
    .subscribe();
}

function backToChatList() {
  document.getElementById('chatConversation').classList.add('hidden');
  cleanupChatRealtime();
  currentChat = null;
  currentChatId = null;
}

async function deleteCurrentChat() {
  if (!currentUser || !sb || !currentChatId) return;
  if (!confirm('Radera konversationen? Den försvinner från din lista men behålls för den andra parten.')) return;

  try {
    cleanupChatRealtime();

    const convIdNum = Number(currentChatId);
    const { data: conv, error: convErr } = await sb
      .from('conversations')
      .select('id,buyer_id,seller_id')
      .eq('id', convIdNum)
      .maybeSingle();

    if (convErr) throw convErr;
    if (!conv) throw new Error('Konversationen finns inte');

    const isBuyer = String(currentUser.id) === String(conv.buyer_id);
    const update = isBuyer ? { buyer_deleted: true } : { seller_deleted: true };

    const { error: updErr } = await sb.from('conversations').update(update).eq('id', convIdNum);
    if (updErr) throw updErr;

    document.getElementById('chatConversation').classList.add('hidden');
    currentChat = null;
    currentChatId = null;

    await loadConversationsDb();
    await updateChatBadge();
    showToast('Konversation raderad från din lista');
  } catch (e) {
    console.error(e);
    showToast('Kunde inte radera chatten');
  }
}

// ===========================
// CONTACT SELLER
// ===========================
async function contactSeller() {
  if (!currentUser) {
    showToast('Logga in först');
    openAuth();                 // ✅ öppna login-modalen
    return;
  }
  if (!currentProduct) return;

  if (String(currentProduct.sellerId) === String(currentUser.id)) {
    showToast('Detta är din egen annons');
    return;
  }

  try {
    const { data: existing, error: findErr } = await sb
      .from('conversations')
      .select('*')
      .eq('product_id', currentProduct.id)
      .eq('buyer_id', currentUser.id)
      .eq('seller_id', currentProduct.sellerId)
      .maybeSingle();

    if (findErr) throw findErr;

    let conv = existing;

    if (!conv) {
      const now = new Date().toISOString();
      const { data: created, error: createErr } = await sb
        .from('conversations')
        .insert([
          {
            product_id: currentProduct.id,
            buyer_id: currentUser.id,
            seller_id: currentProduct.sellerId,
            last_message: 'Hej! Jag är intresserad av din annons.',
            created_at: now,
            updated_at: now,
            buyer_deleted: false,
            seller_deleted: false,
          },
        ])
        .select()
        .single();

      if (createErr) throw createErr;
      conv = created;

      const { error: msgErr } = await sb.from('messages').insert([
        {
          conversation_id: conv.id,
          sender_id: currentUser.id,
          body: 'Hej! Jag är intresserad av din annons.',
          created_at: now,
        },
      ]);
      if (msgErr) throw msgErr;
    } else {
      const isBuyer = String(conv.buyer_id) === String(currentUser.id);
      const wasDeletedByMe = isBuyer ? conv.buyer_deleted : conv.seller_deleted;

      if (wasDeletedByMe) {
        const update = isBuyer ? { buyer_deleted: false } : { seller_deleted: false };
        const { error: restoreErr } = await sb.from('conversations').update(update).eq('id', conv.id);
        if (restoreErr) throw restoreErr;
        showToast('Konversation återställd');
      }
    }

    closeModal('productModal');
    openChat();
    setTimeout(async () => {
      await openConversationDb(conv.id);
    }, 300);
  } catch (e) {
    console.error('Fel i contactSeller:', e);
    showToast('Kunde inte starta chat: ' + (e.message || 'okänt fel'));
  }
}

// ===========================
// REPORTS (DB)
// ===========================
function openReport() {
  if (!currentUser) {
    showToast('Logga in för att anmäla');
    openAuth();                 // ✅ öppna login-modalen
    return;
  }
  document.getElementById('reportReason').value = 'Bedrägeri';
  document.getElementById('reportDetails').value = '';
  showModal('reportModal');
}

async function submitReport() {
  if (!currentUser) {
    showToast('Logga in för att anmäla');
    return;
  }
  if (!currentProduct) {
    showToast('Ingen annons vald');
    return;
  }
  if (!sb) {
    showToast('Databasen är inte ansluten');
    return;
  }

  const reason = document.getElementById('reportReason').value;
  const details = document.getElementById('reportDetails').value?.trim() || null;

  try {
    const { error } = await sb.from('reports').insert([
      {
        type: 'product',
        product_id: Number(currentProduct.id),
        reporter_id: currentUser.id,
        reason,
        details,
        status: 'pending',
      },
    ]);

    if (error) throw error;

    showToast('Anmälan skickad');
    closeModal('reportModal');

    if (currentUser.isAdmin) {
      await updateAdminBadgesDb();
      renderAdminContent('reports');
    }
  } catch (e) {
    console.error('submitReport error:', e);
    showToast('Kunde inte skicka: ' + (e.message || 'okänt fel'));
  }
}

async function fetchReportsFromDb() {
  if (!currentUser?.isAdmin || !sb) return [];

  const { data, error } = await sb
    .from('reports')
    .select('id, created_at, type, product_id, reason, details, status, reporter_id')
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) {
    console.error('fetchReportsFromDb error:', error);
    return [];
  }
  return data || [];
}

async function dismissReportDb(reportId) {
  if (!currentUser?.isAdmin || !sb) return;

  try {
    const { error } = await sb
      .from('reports')
      .update({
        status: 'dismissed',
        handled_by: currentUser.id,
        handled_at: new Date().toISOString(),
      })
      .eq('id', reportId);

    if (error) throw error;

    showToast('Anmälan avfärdad');
    await updateAdminBadgesDb();
    renderAdminContent('reports');
  } catch (e) {
    console.error(e);
    showToast('Kunde inte uppdatera');
  }
}

async function resolveReportDb(reportId) {
  if (!currentUser?.isAdmin || !sb) return;

  try {
    const { error } = await sb
      .from('reports')
      .update({
        status: 'resolved',
        handled_by: currentUser.id,
        handled_at: new Date().toISOString(),
      })
      .eq('id', reportId);

    if (error) throw error;

    showToast('Anmälan markerad som löst');
    await updateAdminBadgesDb();
    renderAdminContent('reports');
  } catch (e) {
    console.error(e);
    showToast('Kunde inte uppdatera');
  }
}

// ✅ Enda badges-funktionen nu (DB + products-array)
async function updateAdminBadgesDb() {
  if (!currentUser?.isAdmin || !sb) return;

  const pending = products.filter((p) => p.status === 'pending').length;

  const { count, error } = await sb
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq('status', 'pending');

  const rep = error ? 0 : count || 0;

  const bPending = document.getElementById('badgePending');
  const bReports = document.getElementById('badgeReports');

  if (bPending) {
    bPending.textContent = pending;
    bPending.classList.toggle('hidden', pending === 0);
  }

  if (bReports) {
    bReports.textContent = rep;
    bReports.classList.toggle('hidden', rep === 0);
  }
}

// ===========================
// ADMIN UI
// ===========================
function setAdminTab(tab, element) {
  document.querySelectorAll('.admin-nav-item').forEach((el) => el.classList.remove('active'));
  element.classList.add('active');
  renderAdminContent(tab);
}

async function renderAdminContent(tab) {
  const content = document.getElementById('adminContent');

  if (tab === 'overview') {
    const activeAds = products.filter((p) => p.status === 'active').length;
    const pendingAds = products.filter((p) => p.status === 'pending').length;
    const rejectedAds = products.filter((p) => p.status === 'rejected').length;
    const soldAds = products.filter((p) => p.status === 'sold').length;

    content.innerHTML = `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px;">
        <div class="panel" style="padding: 20px;">
          <div style="color: #64748b; font-size: 14px; font-weight: 600;">AKTIVA</div>
          <div style="font-size: 32px; font-weight: 800; margin-top: 8px;">${activeAds}</div>
        </div>
        <div class="panel" style="padding: 20px;">
          <div style="color: #64748b; font-size: 14px; font-weight: 600;">GRANSKNING</div>
          <div style="font-size: 32px; font-weight: 800; margin-top: 8px;">${pendingAds}</div>
        </div>
        <div class="panel" style="padding: 20px;">
          <div style="color: #64748b; font-size: 14px; font-weight: 600;">AVVISADE</div>
          <div style="font-size: 32px; font-weight: 800; margin-top: 8px;">${rejectedAds}</div>
        </div>
        <div class="panel" style="padding: 20px;">
          <div style="color: #64748b; font-size: 14px; font-weight: 600;">SÅLDA</div>
          <div style="font-size: 32px; font-weight: 800; margin-top: 8px;">${soldAds}</div>
        </div>
      </div>
    `;
    await updateAdminBadgesDb();
    return;
  }

  if (tab === 'pending') {
    const pending = products.filter((p) => p.status === 'pending');

    if (pending.length === 0) {
      content.innerHTML =
        '<div class="panel" style="padding: 40px; text-align: center; color: #64748b;">Inga annonser väntar på granskning</div>';
      await updateAdminBadgesDb();
      return;
    }

    content.innerHTML = pending
      .map((p) => {
        const img = p.images?.[0] || DEFAULT_IMAGE;
        return `
        <div class="panel" style="margin-bottom: 12px; overflow: hidden;">
          <div style="display: flex; gap: 16px; padding: 16px; flex-wrap: wrap;">
            <img src="${img}" style="width: 100px; height: 75px; object-fit: cover; border-radius: 8px; flex-shrink: 0;" onerror="this.src='${DEFAULT_IMAGE}'">
            <div style="flex: 1; min-width: 200px;">
              <div style="font-weight: 700;">${escapeHtml(p.title)}</div>
              <div style="color: #64748b; font-size: 14px;">${p.price} kr • ${escapeHtml(p.seller)}</div>
              <div style="margin-top: 8px; font-size: 14px;">${escapeHtml(p.description || '')}</div>
            </div>
          </div>
          <div style="display: flex; gap: 8px; padding: 0 16px 16px;">
            <button class="btn btn-success" onclick="approveProduct('${p.id}')">✓ Godkänn</button>
            <button class="btn btn-danger" onclick="rejectProduct('${p.id}')">✕ Avvisa</button>
          </div>
        </div>
      `;
      })
      .join('');

    await updateAdminBadgesDb();
    return;
  }

  if (tab === 'reports') {
    const dbReports = await fetchReportsFromDb();
    const pendingReports = dbReports.filter((r) => r.status === 'pending');

    if (pendingReports.length === 0) {
      content.innerHTML =
        '<div class="panel" style="padding: 40px; text-align: center; color: #64748b;">Inga nya anmälningar</div>';
      await updateAdminBadgesDb();
      return;
    }

    content.innerHTML = pendingReports
      .map((r) => {
        const prod = r.product_id
          ? products.find((p) => String(p.id) === String(r.product_id))
          : null;

        return `
        <div class="panel" style="margin-bottom: 12px; padding: 16px; border-left: 4px solid #f59e0b;">
          <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:12px; flex-wrap:wrap;">
            <div>
              <span style="background:#f59e0b; color:white; padding:4px 8px; border-radius:4px; font-size:12px; font-weight:700;">
                ${escapeHtml(r.type)}
              </span>
              <div style="font-weight:700; margin-top:8px;">${escapeHtml(r.reason)}</div>
              <div style="color:#64748b; font-size:14px;">
                Mål: ${escapeHtml(prod?.title || (r.product_id ? 'Produkt #' + r.product_id : '—'))}
              </div>
              ${r.details ? `<div style="margin-top:8px; font-size:14px; color:#64748b;">${escapeHtml(r.details)}</div>` : ''}
              <div style="margin-top:8px; font-size:12px; color:#94a3b8;">
                ${r.created_at ? new Date(r.created_at).toLocaleString('sv-SE') : ''}
              </div>
            </div>

            <div style="display:flex; gap:8px; flex-wrap:wrap;">
              <button class="btn btn-soft" onclick="dismissReportDb(${r.id})">Avfärda</button>
              <button class="btn btn-success" onclick="resolveReportDb(${r.id})">Markera löst</button>
            </div>
          </div>
        </div>
      `;
      })
      .join('');

    await updateAdminBadgesDb();
    return;
  }

  if (tab === 'history') {
    const all = (products || []).slice();

    all.sort((a, b) => {
      const ta = new Date(a.updatedAt || a.createdAt || 0).getTime();
      const tb = new Date(b.updatedAt || b.createdAt || 0).getTime();
      return tb - ta;
    });

    content.innerHTML = `
      <div class="panel" style="padding:16px; margin-bottom:12px;">
        <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
          <input id="adminHistSearch" class="input" placeholder="Sök titel / säljare / plats..."
                 style="flex:1; min-width:220px;" />
          <select id="adminHistStatus" class="input" style="min-width:200px;">
            <option value="">Alla status</option>
            <option value="active">Aktiv</option>
            <option value="pending">Pending</option>
            <option value="rejected">Rejected</option>
            <option value="sold">Såld</option>
          </select>
          <button class="btn btn-soft" id="adminHistRefresh">Uppdatera</button>
        </div>
        <div style="margin-top:10px; color:#64748b; font-size:13px;">
          Tips: Rejected visar anledning + vem + datum. Pending visar att den väntar på granskning.
        </div>
      </div>

      <div id="adminHistoryList"></div>
    `;

    const listEl = document.getElementById('adminHistoryList');
    const searchEl = document.getElementById('adminHistSearch');
    const statusEl = document.getElementById('adminHistStatus');

    function renderHistoryRows() {
      const q = (searchEl.value || '').trim().toLowerCase();
      const st = statusEl.value;

      let list = all;

      if (st) list = list.filter((p) => (p.status || '') === st);

      if (q) {
        list = list.filter((p) => {
          const title = (p.title || '').toLowerCase();
          const seller = (p.seller || '').toLowerCase();
          const loc = (p.location || '').toLowerCase();
          const id = String(p.id || '').toLowerCase();
          return title.includes(q) || seller.includes(q) || loc.includes(q) || id.includes(q);
        });
      }

      if (!list.length) {
        listEl.innerHTML = `
          <div class="panel" style="padding:40px; text-align:center; color:#64748b;">
            Ingen historik matchar filtret.
          </div>
        `;
        return;
      }

      listEl.innerHTML = list
        .map((p) => {
          const img = p.images?.[0] || DEFAULT_IMAGE;

          const rejectedMeta =
            p.status === 'rejected'
              ? `
            <div style="margin-top:8px; font-size:13px; color:#991b1b;">
              <b>Anledning:</b> ${escapeHtml(p.rejected_reason || '—')}
              <div style="margin-top:4px; color:#64748b;">
                <b>Rejected at:</b> ${formatDateTimeSv(p.rejected_at)}
              </div>
              <div style="margin-top:4px; color:#64748b;">
                <b>Rejected by:</b> ${escapeHtml(p.rejected_by || '—')}
              </div>
              ${p.resubmitted_at ? `<div style="margin-top:4px; color:#64748b;"><b>Resubmitted:</b> ${formatDateTimeSv(p.resubmitted_at)}</div>` : ''}
            </div>
          `
              : '';

          const timeline = `
          <div style="margin-top:8px; font-size:12px; color:#94a3b8;">
            <b>Skapad:</b> ${formatDateTimeSv(p.createdAt)}
            ${p.updatedAt ? ` • <b>Uppdaterad:</b> ${formatDateTimeSv(p.updatedAt)}` : ''}
          </div>
        `;

          return `
          <div class="panel" style="margin-bottom:12px; overflow:hidden;">
            <div style="display:flex; gap:16px; padding:16px; flex-wrap:wrap;">
              <img src="${img}"
                   style="width:100px; height:75px; object-fit:cover; border-radius:8px; flex-shrink:0;"
                   onerror="this.src='${DEFAULT_IMAGE}'">
              <div style="flex:1; min-width:220px;">
                <div style="display:flex; justify-content:space-between; gap:10px; align-items:flex-start; flex-wrap:wrap;">
                  <div style="font-weight:800;">
                    ${escapeHtml(p.title || '—')}
                    <span style="margin-left:8px;">${adminStatusLabel(p.status)}</span>
                  </div>
                  <div style="color:#64748b; font-size:12px;">
                    #${escapeHtml(String(p.id))}
                  </div>
                </div>

                <div style="color:#64748b; font-size:14px; margin-top:4px;">
                  ${p.price} kr • ${escapeHtml(p.location || '—')} • ${escapeHtml(p.seller || '—')}
                </div>

                ${rejectedMeta}
                ${timeline}
              </div>
            </div>

            <div style="display:flex; gap:8px; padding:0 16px 16px; flex-wrap:wrap;">
              <button class="btn btn-soft" onclick="openProduct('${p.id}')">Öppna</button>

              ${
                p.status === 'pending'
                  ? `
                  <button class="btn btn-success" onclick="approveProduct('${p.id}')">✓ Godkänn</button>
                  <button class="btn btn-danger" onclick="rejectProduct('${p.id}')">✕ Avvisa</button>
                `
                  : ''
              }
            </div>
          </div>
        `;
        })
        .join('');
    }

    searchEl.addEventListener('input', renderHistoryRows);
    statusEl.addEventListener('change', renderHistoryRows);

    document.getElementById('adminHistRefresh').addEventListener('click', async () => {
      await loadProducts();
      await updateAdminBadgesDb();
      renderAdminContent('history');
    });

    renderHistoryRows();
    await updateAdminBadgesDb();
    return;
  }

  if (tab === 'users') {
    content.innerHTML = '<div style="text-align: center; color: #64748b;">Användarhantering visas här</div>';
    await updateAdminBadgesDb();
  }
}

// ✅ approve/reject wrappers (kopplade till module)
async function approveProduct(id) {
  try {
    await adminApproveProduct(id);
    await loadProducts();
    renderProducts();
    await updateAdminBadgesDb();
    renderAdminContent('pending');
    showToast('Annons godkänd');
  } catch (e) {
    console.error(e);
    showToast('Kunde inte godkänna');
  }
}

/*async function rejectProduct(id) {
  const reason = prompt('Ange anledning för avvisning:');
  if (!reason || !reason.trim()) return;

  try {
    await adminRejectProduct(id, reason);
    await loadProducts();
    renderProducts();
    await updateAdminBadgesDb();
    renderAdminContent('pending');
    showToast('Annons avvisad + notis skickad');
  } catch (e) {
    console.error('rejectProduct error:', e);
    showToast('Kunde inte avvisa: ' + (e.message || 'okänt fel'));
  }
} */
function rejectProduct(id) {
  openRejectModal(id);
}

// ===========================
// MODALS
// ===========================
function showModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;

  // ✅ säkerställ att senaste modal alltid ligger överst
  __modalZ += 1;
  modal.style.zIndex = String(__modalZ);

  modal.classList.add('show');
  modal.style.display = 'flex';
  const box = modal.querySelector('.modal-box');
if (box) box.scrollTop = 0;
  lockBodyScroll();
}


function closeModal(id) {
  const modal = document.getElementById(id);
  if (!modal) return;
  modal.classList.remove('show');

  setTimeout(() => {
    modal.style.display = 'none';

    const anyModalOpen = document.querySelector('.modal.show');
    const chatOpen = document.getElementById('chatPanel')?.classList.contains('show');

    if (!anyModalOpen && !chatOpen) {
      unlockBodyScroll();
    }
  }, 300);
}

function closeAllModals() {
  ['authModal', 'sellModal', 'productModal', 'reportModal', 'deleteModal', 'forgotPasswordModal'].forEach((id) => {
    const modal = document.getElementById(id);
    if (modal && modal.classList.contains('show')) closeModal(id);
  });
}

// ===========================
// TOAST + HELPERS
// ===========================
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('show');
  setTimeout(() => toast.classList.remove('show'), 3000);
}

function escapeHtml(text) {
  if (!text) return '';
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ===========================
// NOTIFICATIONS
// ===========================
async function fetchUnreadNotifications() {
  if (!currentUser) return [];
  const { data, error } = await sb
    .from('notifications')
    .select('*')
    .eq('user_id', currentUser.id)
    .eq('is_read', false)
    .order('created_at', { ascending: false })
    .limit(5);

  if (error) {
    console.error(error);
    return [];
  }
  return data || [];
}

async function markNotificationsRead(ids) {
  if (!currentUser || !ids?.length) return;
  const { error } = await sb.from('notifications').update({ is_read: true }).in('id', ids);
  if (error) console.error('markNotificationsRead error:', error);
}

async function fetchNotifications(limit = 30) {
  if (!currentUser || !sb) return [];

  const { data, error } = await sb
    .from('notifications')
    .select('id, created_at, type, title, body, product_id, is_read')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(limit);

  if (error) {
    console.error('fetchNotifications error:', error);
    return [];
  }
  return data || [];
}

function renderNotificationsList(list) {
  const el = document.getElementById('notificationsList');
  if (!el) return;

  if (!list.length) {
    el.innerHTML = `<div style="text-align:center; color:#64748b; padding:20px;">
      Inga notiser än.
    </div>`;
    return;
  }

  el.innerHTML = list.map(n => {
    const created = n.created_at ? new Date(n.created_at).toLocaleString('sv-SE') : '';
    const unreadBadge = !n.is_read
      ? `<span style="background:#fee2e2;color:#991b1b;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:800;">OLÄST</span>`
      : `<span style="background:#e2e8f0;color:#0f172a;padding:2px 8px;border-radius:999px;font-size:12px;font-weight:700;">LÄST</span>`;

    const productBtn = n.product_id
      ? `<button class="btn btn-soft" onclick="openProduct('${String(n.product_id)}')">Öppna annons</button>`
      : '';

    const markBtn = !n.is_read
      ? `<button class="btn btn-soft" onclick="markOneNotificationRead(${n.id})">Markera som läst</button>`
      : '';

    return `
      <div class="panel" style="padding:12px; margin-bottom:10px; border-left:4px solid ${n.is_read ? '#e2e8f0' : '#ef4444'};">
        <div style="display:flex; justify-content:space-between; gap:10px; flex-wrap:wrap;">
          <div style="font-weight:800;">${escapeHtml(n.title || 'Notis')}</div>
          <div style="display:flex; gap:8px; align-items:center;">
            ${unreadBadge}
            <div style="color:#94a3b8; font-size:12px;">${escapeHtml(created)}</div>
          </div>
        </div>

        ${n.body ? `<div style="margin-top:8px; color:#334155; font-size:14px; white-space:pre-line;">${escapeHtml(n.body)}</div>` : ''}

        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-top:10px;">
          ${productBtn}
          ${markBtn}
        </div>
      </div>
    `;
  }).join('');
}

async function refreshNotifications() {
  if (!currentUser) return;
   renderNotificationsLoading(); // ← lägg till
  const list = await fetchNotifications(30);
  renderNotificationsList(list);
}

async function markOneNotificationRead(id) {
  if (!currentUser) return;
  try {
    await markNotificationsRead([id]);
    await refreshNotifications();
  } catch (e) {
    console.error(e);
    showToast('Kunde inte markera som läst');
  }
}

function renderNotificationsLoading() {
  const el = document.getElementById('notificationsList');
  if (el) {
    el.innerHTML = '<div style="padding:20px;color:#64748b;">⏳ Laddar...</div>';
  }
}


async function markAllNotificationsRead() {
  if (!currentUser) return;
  try {
    const list = await fetchNotifications(50);
    const unreadIds = list.filter(n => !n.is_read).map(n => n.id);
    if (!unreadIds.length) {
      showToast('Inga olästa notiser');
      return;
    }
    await markNotificationsRead(unreadIds);
    showToast('Markerade alla som lästa');
    await refreshNotifications();
  } catch (e) {
    console.error(e);
    showToast('Kunde inte markera alla');
  }
}


// ===========================
// PRODUCT MODAL IMAGES
// ===========================
function updateModalImage() {
  if (!currentProduct || !currentProduct.images?.length) return;
  const img = document.getElementById('modalImg');
  img.src = currentProduct.images[currentImageIndex] || DEFAULT_IMAGE;

  document.querySelectorAll('#modalThumbs img').forEach((t, i) => {
    t.style.border = i === currentImageIndex ? '2px solid var(--primary)' : '2px solid transparent';
  });
}

function updateArrowState() {
  const prevBtn = document.getElementById('prevImgBtn');
  const nextBtn = document.getElementById('nextImgBtn');
  if (!prevBtn || !nextBtn || !currentProduct?.images) return;

  const max = currentProduct.images.length - 1;
  prevBtn.disabled = currentImageIndex === 0;
  nextBtn.disabled = currentImageIndex === max;

  prevBtn.style.opacity = prevBtn.disabled ? '0.4' : '1';
  nextBtn.style.opacity = nextBtn.disabled ? '0.4' : '1';
  prevBtn.style.cursor = prevBtn.disabled ? 'not-allowed' : 'pointer';
  nextBtn.style.cursor = nextBtn.disabled ? 'not-allowed' : 'pointer';
}

function nextImage() {
  if (!currentProduct?.images) return;
  if (currentImageIndex < currentProduct.images.length - 1) {
    currentImageIndex++;
    updateModalImage();
  }
  updateArrowState();
}

function prevImage() {
  if (!currentProduct?.images) return;
  if (currentImageIndex > 0) {
    currentImageIndex--;
    updateModalImage();
  }
  updateArrowState();
}

function selectImage(i) {
  currentImageIndex = i;
  updateModalImage();
  updateArrowState();
}

// swipe
let touchStartX = 0;
document.addEventListener('touchstart', (e) => {
  if (!document.getElementById('productModal')?.classList.contains('show')) return;
  touchStartX = e.changedTouches[0].screenX;
});
document.addEventListener('touchend', (e) => {
  if (!document.getElementById('productModal')?.classList.contains('show')) return;
  const endX = e.changedTouches[0].screenX;
  const diff = endX - touchStartX;
  if (Math.abs(diff) > 50) {
    if (diff > 0) prevImage();
    else nextImage();
  }
});

// ===========================
// CARD IMAGE NAV
// ===========================
function updateCardArrowState(productId) {
  const p = products.find((x) => String(x.id) === String(productId));
  if (!p?.images || p.images.length <= 1) return;

  const idx = cardImageIndex[productId] ?? 0;
  const max = p.images.length - 1;

  const imgEl = document.getElementById(`cardImg-${productId}`);
  if (!imgEl) return;

  const wrapper = imgEl.closest('.card-image-wrapper');
  if (!wrapper) return;

  const prevBtn = wrapper.querySelector('.card-img-nav.left');
  const nextBtn = wrapper.querySelector('.card-img-nav.right');

  if (prevBtn) {
    prevBtn.disabled = idx === 0;
    prevBtn.style.opacity = prevBtn.disabled ? '0.4' : '1';
    prevBtn.style.cursor = prevBtn.disabled ? 'not-allowed' : 'pointer';
  }
  if (nextBtn) {
    nextBtn.disabled = idx === max;
    nextBtn.style.opacity = nextBtn.disabled ? '0.4' : '1';
    nextBtn.style.cursor = nextBtn.disabled ? 'not-allowed' : 'pointer';
  }
}

function updateCardImage(productId) {
  const p = products.find((x) => String(x.id) === String(productId));
  if (!p) return;

  const idx = cardImageIndex[productId] ?? 0;
  const imgEl = document.getElementById(`cardImg-${productId}`);
  if (imgEl) imgEl.src = p.images?.[idx] || DEFAULT_IMAGE;

  updateCardArrowState(productId);
}

function cardNextImage(productId) {
  const p = products.find((x) => String(x.id) === String(productId));
  if (!p?.images || p.images.length <= 1) return;

  const idx = cardImageIndex[productId] ?? 0;
  if (idx >= p.images.length - 1) {
    updateCardArrowState(productId);
    return;
  }

  cardImageIndex[productId] = idx + 1;
  updateCardImage(productId);
}

function cardPrevImage(productId) {
  const p = products.find((x) => String(x.id) === String(productId));
  if (!p?.images || p.images.length <= 1) return;

  const idx = cardImageIndex[productId] ?? 0;
  if (idx <= 0) {
    updateCardArrowState(productId);
    return;
  }

  cardImageIndex[productId] = idx - 1;
  updateCardImage(productId);
}

// ===========================
// PLACEHOLDERS (behåller dina)
// ===========================
function reportFromChat() {
  showToast('Anmälningsfunktion från chat ej implementerad');
}
function openProductFromChat() {
  showToast('Öppna annons från chat ej implementerad');
}

// ===========================
// GLOBAL EXPORTS
// ===========================
window.showHome = showHome;
window.showProfile = showProfile;
window.showAdmin = showAdmin;
window.openAuth = openAuth;
window.toggleAuthMode = toggleAuthMode;
window.handleAuth = handleAuth;
window.logout = logout;
window.toggleMenu = toggleMenu;

window.openSellModal = openSellModal;
window.submitProduct = submitProduct;
window.editProduct = editProduct;
window.markSold = markSold;
window.deleteProduct = deleteProduct;

window.confirmDelete = confirmDelete;
window.prepDelete = prepDelete;

window.openProduct = openProduct;
window.renderProducts = renderProducts;
window.setCat = setCat;
window.switchTab = switchTab;

window.toggleFav = toggleFav;
window.toggleFavoriteFromModal = toggleFavoriteFromModal;
window.removeFromFavorites = removeFromFavorites;

window.quickSold = quickSold;

window.contactSeller = contactSeller;

window.openChat = openChat;
window.closeChat = closeChat;
window.sendMessage = sendMessage;
window.backToChatList = backToChatList;
window.deleteCurrentChat = deleteCurrentChat;

window.deleteConversationFromList = deleteConversationFromList;
window.openConversationDb = openConversationDb;

window.openReport = openReport;
window.submitReport = submitReport;

window.setAdminTab = setAdminTab;
window.approveProduct = approveProduct;
window.rejectProduct = rejectProduct;

window.closeModal = closeModal;
window.closeAllModals = closeAllModals;

window.forgotPassword = forgotPassword;
window.submitForgotPassword = submitForgotPassword;

window.previewImages = previewImages;
window.removeImage = removeImage;

window.nextImage = nextImage;
window.prevImage = prevImage;
window.selectImage = selectImage;

window.cardNextImage = cardNextImage;
window.cardPrevImage = cardPrevImage;

window.toggleCatMenu = toggleCatMenu;
window.onCatChange = onCatChange;
window.clearCats = clearCats;
window.applyCats = applyCats;
window.removeCat = removeCat;

window.dismissReportDb = dismissReportDb;
window.resolveReportDb = resolveReportDb;

window.resubmitProduct = resubmitProduct;
window.refreshNotifications = refreshNotifications;
window.markAllNotificationsRead = markAllNotificationsRead;
window.markOneNotificationRead = markOneNotificationRead;

window.openRejectModal = openRejectModal;
window.closeRejectModal = closeRejectModal;
window.confirmRejectModal = confirmRejectModal;
