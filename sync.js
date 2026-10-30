// Sharing between phones, via a free Supabase database.
//
// How it works: every piece of the plan is stored as its own row
// (e.g. "plan:Monday", "extra:milk"), so two people changing different
// things never overwrite each other. If you both change the *same* thing,
// the later change wins and the app shows who made it.
//
// Fill in SETTINGS.supabase in app.js. Leave it empty to run on one phone only.

const Sync = (() => {
  const POLL_MS = 6000;
  let cfg = null;          // { url, key }
  let lastSeen = null;     // newest updated_at we've applied
  let snapshot = {};       // key -> JSON string of what we last pushed
  let timer = null;
  let inflight = false;
  let pending = false;
  let onChange = () => {};
  let onStatus = () => {};
  let deviceId = null;
  let tickState = null;    // the state the poll timer syncs
  let lastStatus = { text: "Not shared", ok: null };

  // ---- flatten the app state into rows and back ----

  function flatten(state) {
    const rows = {};
    for (const [d, v] of Object.entries(state.plan)) if (v) rows["plan:" + d] = v;
    for (const [d, v] of Object.entries(state.guests)) if (v) rows["guests:" + d] = v;
    for (const [d, v] of Object.entries(state.busy)) if (v) rows["busy:" + d] = true;
    for (const [d, v] of Object.entries(state.training)) if (v) rows["training:" + d] = true;
    for (const [k, v] of Object.entries(state.pantry)) if (v) rows["pantry:" + k] = true;
    for (const [k, v] of Object.entries(state.marks)) if (v) rows["marks:" + k] = v;
    for (const [k, v] of Object.entries(state.bought)) if (v) rows["bought:" + k] = true;
    for (const x of state.extras) rows["extra:" + x.name.toLowerCase()] = { name: x.name, aisle: x.aisle || "Other" };
    for (const x of state.staples) rows["staple:" + x.name.toLowerCase()] = { name: x.name, aisle: x.aisle || "Other" };
    rows["staples-set"] = true; // marks that this household has its own staples list
    rows["prefs"] = state.prefs;
    rows["recent"] = state.recent;
    return rows;
  }

  // Apply one row (value null = removed) onto the state.
  function applyRow(state, key, value) {
    const i = key.indexOf(":");
    const kind = i === -1 ? key : key.slice(0, i);
    const rest = key.slice(i + 1);
    const setOrDelete = (obj, k, v) => { if (v == null || v === false) delete obj[k]; else obj[k] = v; };
    switch (kind) {
      case "plan": setOrDelete(state.plan, rest, value); break;
      case "guests": setOrDelete(state.guests, rest, value); break;
      case "busy": setOrDelete(state.busy, rest, value); break;
      case "training": setOrDelete(state.training, rest, value); break;
      case "pantry": setOrDelete(state.pantry, rest, value); break;
      case "marks": setOrDelete(state.marks, rest, value); break;
      case "bought": setOrDelete(state.bought, rest, value); break;
      case "extra":
        state.extras = state.extras.filter(x => x.name.toLowerCase() !== rest);
        if (value) state.extras.push(value);
        break;
      case "staple":
        state.staples = state.staples.filter(x => x.name.toLowerCase() !== rest);
        if (value) state.staples.push(value);
        break;
      case "staples-set": break;
      case "prefs": if (value) state.prefs = Object.assign({}, state.prefs, value); break;
      case "recent": state.recent = Array.isArray(value) ? value : []; break;
    }
  }

  // ---- talking to Supabase ----

  function headers() {
    return {
      apikey: cfg.key,
      Authorization: "Bearer " + cfg.key,
      "Content-Type": "application/json",
    };
  }

  async function fetchRows(code, since) {
    let url = cfg.url + "/rest/v1/household_state?select=key,value,by,by_name,updated_at" +
      "&code=eq." + encodeURIComponent(code) + "&order=updated_at.asc";
    if (since) url += "&updated_at=gt." + encodeURIComponent(since);
    const res = await fetch(url, { headers: headers() });
    if (!res.ok) throw new Error("read failed: " + res.status);
    return res.json();
  }

  async function upsertRows(code, rows, name) {
    if (!rows.length) return;
    const res = await fetch(cfg.url + "/rest/v1/household_state?on_conflict=code,key", {
      method: "POST",
      headers: Object.assign(headers(), { Prefer: "resolution=merge-duplicates,return=minimal" }),
      body: JSON.stringify(rows.map(([key, value]) => ({ code, key, value, by: deviceId, by_name: name || "" }))),
    });
    if (!res.ok) throw new Error("write failed: " + res.status);
  }

  // ---- the two directions ----

  function setStatus(text, ok) {
    lastStatus = { text, ok };
    onStatus(lastStatus);
  }

  function timeAgo(iso) {
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return Math.round(s / 60) + " min ago";
    if (s < 86400) return Math.round(s / 3600) + " h ago";
    return Math.round(s / 86400) + " days ago";
  }

  // Pull changes from the database into the state. Returns true if anything changed.
  async function pull(state) {
    const rows = await fetchRows(state.share.code, lastSeen);
    let changed = false, lastOther = null;
    for (const r of rows) {
      lastSeen = r.updated_at;
      if (r.by === deviceId) continue; // our own writes, already applied
      applyRow(state, r.key, r.value);
      snapshot[r.key] = JSON.stringify(r.value == null ? null : r.value);
      changed = true;
      lastOther = r;
    }
    if (lastOther) {
      state.share.lastChange = { by: lastOther.by_name || "someone", at: lastOther.updated_at };
    }
    const lc = state.share.lastChange;
    setStatus(lc ? "Shared · last change by " + lc.by + " " + timeAgo(lc.at) : "Shared · up to date", true);
    return changed;
  }

  // Push whatever differs from what we last pushed.
  async function push(state) {
    const now = flatten(state);
    const diff = [];
    for (const [k, v] of Object.entries(now)) {
      const s = JSON.stringify(v);
      if (snapshot[k] !== s) diff.push([k, v]);
    }
    for (const k of Object.keys(snapshot)) {
      if (!(k in now) && snapshot[k] !== "null") diff.push([k, null]);
    }
    if (!diff.length) return;
    await upsertRows(state.share.code, diff, state.share.name);
    for (const [k, v] of diff) snapshot[k] = JSON.stringify(v);
  }

  async function cycle(state, { pushFirst } = {}) {
    if (!cfg || !state.share.code) return;
    if (inflight) { pending = true; return; }
    inflight = true;
    let changed = false;
    try {
      if (pushFirst) await push(state);
      changed = await pull(state);
      await push(state);
    } catch (e) {
      setStatus("Shared · can't reach the database right now", false);
    } finally {
      inflight = false;
    }
    if (changed) onChange();
    if (pending) { pending = false; cycle(state); }
  }

  // ---- public bits ----

  function configure(settings, handlers) {
    cfg = settings && settings.url && settings.key ? settings : null;
    onChange = handlers.onChange || onChange;
    onStatus = handlers.onStatus || onStatus;
    deviceId = handlers.deviceId;
    return !!cfg;
  }

  function available() { return !!cfg; }

  // Start syncing a state that has share.code set. First time: whatever is
  // already in the database wins, then anything only on this phone is added.
  async function start(state) {
    stop();
    tickState = state;
    if (!cfg || !state.share.code) { setStatus("Not shared", null); return; }
    lastSeen = null;
    snapshot = {};
    setStatus("Shared · connecting…", null);
    try {
      const rows = await fetchRows(state.share.code, null);
      // The household's every-week list replaces this phone's starter list.
      if (rows.some(r => r.key === "staples-set")) state.staples = [];
      for (const r of rows) {
        lastSeen = r.updated_at;
        applyRow(state, r.key, r.value);
        snapshot[r.key] = JSON.stringify(r.value == null ? null : r.value);
        if (r.by !== deviceId) state.share.lastChange = { by: r.by_name || "someone", at: r.updated_at };
      }
      onChange();
      await push(state); // anything local the household didn't have yet
      const lc = state.share.lastChange;
      setStatus(lc ? "Shared · last change by " + lc.by + " " + timeAgo(lc.at) : "Shared · up to date", true);
    } catch (e) {
      setStatus("Shared · can't reach the database right now", false);
    }
    timer = setInterval(() => { if (document.visibilityState === "visible") cycle(state); }, POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
  }

  function onVisible() { if (document.visibilityState === "visible" && tickState) cycle(tickState); }

  function stop() {
    clearInterval(timer); timer = null;
    document.removeEventListener("visibilitychange", onVisible);
  }

  // Call after every local change.
  function changed(state) {
    if (cfg && state.share.code) cycle(state, { pushFirst: true });
  }

  function newCode() {
    const words = ["apple", "basil", "cocoa", "dill", "fennel", "ginger", "honey", "lemon", "mango", "nutmeg",
      "olive", "pepper", "quince", "rhubarb", "saffron", "thyme", "vanilla", "walnut", "yam", "zest"];
    const pick = () => words[Math.floor(Math.random() * words.length)];
    return pick() + "-" + pick() + "-" + pick() + "-" + Math.floor(100 + Math.random() * 900);
  }

  return { configure, available, start, stop, changed, newCode, flatten, applyRow, status: () => lastStatus };
})();
