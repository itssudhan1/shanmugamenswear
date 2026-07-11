/* ── Shanmuga Mens Wear — shared account/order/address helpers ──
   Loaded as a plain (non-module) script on login.html, checkout.html
   and account.html. Everything hangs off window.SMW so the Firebase
   <script type="module"> blocks on each page can call into it.
   Orders/addresses/profile are namespaced per-user in localStorage
   because the site does not run a database — this mirrors how the
   cart and coupons already work. */
(function () {
  'use strict';

  function fmt(n) { return 'Rs.' + Number(n || 0).toLocaleString('en-IN'); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // Stable per-account key: prefer Firebase uid, fall back to email.
  function userKey(user) {
    if (!user) return null;
    return user.uid || user.email || null;
  }

  function readJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var parsed = JSON.parse(raw);
      return parsed == null ? fallback : parsed;
    } catch (e) { return fallback; }
  }
  function writeJSON(key, val) {
    try { localStorage.setItem(key, JSON.stringify(val)); return true; }
    catch (e) { return false; }
  }

  // ── ORDERS ──
  function getOrders(user) {
    var k = userKey(user);
    if (!k) return [];
    return readJSON('smw_orders_' + k, []);
  }
  function addOrder(user, order) {
    var k = userKey(user);
    if (!k) return [];
    var list = getOrders(user);
    list.unshift(order); // newest first
    writeJSON('smw_orders_' + k, list);
    return list;
  }

  // ── ADDRESSES ──
  function getAddresses(user) {
    var k = userKey(user);
    if (!k) return [];
    return readJSON('smw_addresses_' + k, []);
  }
  function saveAddress(user, addr) {
    var k = userKey(user);
    if (!k) return [];
    var list = getAddresses(user);
    if (!addr.id) addr.id = 'addr_' + Date.now() + '_' + Math.floor(Math.random() * 1000);
    var idx = list.findIndex(function (a) { return a.id === addr.id; });
    if (addr.isDefault) list.forEach(function (a) { a.isDefault = false; });
    if (idx > -1) list[idx] = addr; else list.push(addr);
    if (!list.some(function (a) { return a.isDefault; }) && list.length) list[0].isDefault = true;
    writeJSON('smw_addresses_' + k, list);
    return list;
  }
  function deleteAddress(user, id) {
    var k = userKey(user);
    if (!k) return [];
    var list = getAddresses(user).filter(function (a) { return a.id !== id; });
    if (list.length && !list.some(function (a) { return a.isDefault; })) list[0].isDefault = true;
    writeJSON('smw_addresses_' + k, list);
    return list;
  }
  function getDefaultAddress(user) {
    var list = getAddresses(user);
    return list.find(function (a) { return a.isDefault; }) || list[0] || null;
  }

  // ── PROFILE (phone number etc — name/email/photo come from Firebase) ──
  function getProfile(user) {
    var k = userKey(user);
    if (!k) return {};
    return readJSON('smw_profile_' + k, {});
  }
  function saveProfile(user, profile) {
    var k = userKey(user);
    if (!k) return {};
    var merged = Object.assign({}, getProfile(user), profile);
    writeJSON('smw_profile_' + k, merged);
    return merged;
  }

  window.SMW = {
    fmt: fmt, esc: esc, userKey: userKey,
    getOrders: getOrders, addOrder: addOrder,
    getAddresses: getAddresses, saveAddress: saveAddress,
    deleteAddress: deleteAddress, getDefaultAddress: getDefaultAddress,
    getProfile: getProfile, saveProfile: saveProfile
  };
})();
