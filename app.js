// Meal Planner — plain JavaScript, no build step.
// Everything you might want to change is in SETTINGS.

const SETTINGS = {
  // Sharing between phones. Paste the Project URL and the anon/publishable
  // key from Supabase here. Leave both empty to run on one phone only.
  supabase: {
    url: "",
    key: "",
  },
  // Must match the name of the Shortcut on your iPhone exactly.
  shortcutName: "Add to Shopping",
  // Aisles are shown in this order; any others go at the end.
  aisleOrder: [
    "Fruit & Veg", "Bakery", "Meat & Fish", "Dairy & Eggs",
    "Pasta, Rice & Grains", "Tins & Jars", "World Foods",
    "Herbs & Spices", "Baking", "Frozen", "Other",
  ],
};

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];
const STORAGE_KEY = "mealPlanner.v1";

// Meal suggestions come from suggestWeek() below. To plug in AI suggestions
// later, replace pickMeal() with something that returns a recipe name.

let recipes = [];
let state = loadState();
const openMeals = new Set(); // which Saved meals are expanded

// ---------- Saving in browser storage ----------

function blankState() {
  return {
    plan: {},        // day -> recipe name
    portions: {},    // day -> number of people (defaults to prefs.portions)
    busy: { Tuesday: true, Wednesday: true, Thursday: true }, // Tue–Thu start busy; tap to change
    training: {},
    pantry: {},      // ingredient name (lower case) -> true if you already have it
    marks: {},       // recipe name -> "repeat" | "never"
    extras: [],      // everyday items you typed in: [{ name, aisle }]
    bought: {},      // list item key -> true once ticked off in the shop
    prefs: { portions: 4, maxTime: 30, vegetarian: false, avoid: "" },
    share: { code: "", name: "", lastChange: null }, // household sharing
  };
}

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY)) || {};
    const s = Object.assign(blankState(), saved);
    s.prefs = Object.assign(blankState().prefs, saved.prefs || {});
    s.share = Object.assign(blankState().share, saved.share || {});
    return s;
  } catch (e) {
    return blankState();
  }
}

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* private mode */ }
  Sync.changed(state);
}

// A random id for this phone, so we can tell our own changes from Rach's.
function deviceId() {
  try {
    let id = localStorage.getItem(STORAGE_KEY + ".device");
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem(STORAGE_KEY + ".device", id); }
    return id;
  } catch (e) { return "anon"; }
}

// ---------- Helpers ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, "");
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c != null) node.append(c);
  }
  return node;
}

function findRecipe(name) {
  return recipes.find(r => r.name === name);
}

function hasTag(recipe, tag) {
  return (recipe.tags || []).includes(tag);
}

function portionsFor(day) {
  return state.portions[day] || state.prefs.portions;
}

function avoidList() {
  return state.prefs.avoid.split(",").map(s => s.trim().toLowerCase()).filter(Boolean);
}

// Does this recipe fit the household preferences?
function allowedByPrefs(recipe) {
  if (state.marks[recipe.name] === "never") return false;
  if (state.prefs.vegetarian && !hasTag(recipe, "vegetarian")) return false;
  const avoid = avoidList();
  if (avoid.length && recipe.ingredients.some(i => avoid.some(a => i.name.toLowerCase().includes(a)))) return false;
  return true;
}

function isQuick(recipe) {
  return hasTag(recipe, "quick") || (recipe.time && recipe.time <= state.prefs.maxTime);
}

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove("show"), 2200);
}

function shuffle(list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ---------- Suggest ----------

// Picks one recipe for a day. `used` holds names already on the plan.
function pickMeal(day, used) {
  const wants = [];
  if (state.busy[day]) wants.push(isQuick);
  if (state.training[day]) wants.push(r => hasTag(r, "high-carb"));

  const allowed = recipes.filter(allowedByPrefs);
  // "Repeat soon" meals go to the front of the queue.
  const repeatFirst = list => list.sort((a, b) =>
    (state.marks[b.name] === "repeat") - (state.marks[a.name] === "repeat"));
  const unused = repeatFirst(shuffle(allowed.filter(r => !used.has(r.name))));
  const matchesAll = r => wants.every(fn => fn(r));
  const matchesAny = r => wants.some(fn => fn(r));

  return (
    unused.find(matchesAll) ||
    unused.find(matchesAny) ||
    unused[0] ||
    shuffle(allowed).find(matchesAll) || // ran out: allow a repeat
    shuffle(allowed)[0] || null
  );
}

// Fills empty days only, so meals you chose by hand stay put.
function suggestWeek() {
  const used = new Set(Object.values(state.plan).filter(Boolean));
  const emptyDays = DAYS.filter(d => !state.plan[d]);
  if (emptyDays.length === 0) {
    toast("Every day already has a meal. Remove one to get a new suggestion.");
    return;
  }
  if (!recipes.some(allowedByPrefs)) {
    toast("Your preferences rule out every meal. Loosen them on the Saved tab.");
    return;
  }
  // Handle the fussiest days first so they get the best matches.
  const need = d => (state.busy[d] ? 1 : 0) + (state.training[d] ? 1 : 0);
  emptyDays.sort((a, b) => need(b) - need(a));

  for (const day of emptyDays) {
    const pick = pickMeal(day, used);
    if (pick) {
      state.plan[day] = pick.name;
      used.add(pick.name);
    }
  }
  saveState();
  renderAll();
  toast("Week filled in");
}

// ---------- Shopping list maths ----------

// All ingredients for the planned meals, scaled to portions, with
// duplicates merged. Same name + same unit => quantities are added.
// Different units (e.g. "1 lemon" and "lemon juice 2 tbsp") stay separate.
function weekIngredients() {
  const merged = new Map();
  for (const day of DAYS) {
    const recipe = findRecipe(state.plan[day]);
    if (!recipe) continue;
    const scale = portionsFor(day) / (recipe.serves || 4);
    for (const ing of recipe.ingredients) {
      const unit = (ing.unit || "").trim();
      const key = ing.name.trim().toLowerCase() + "|" + unit.toLowerCase();
      const qty = (Number(ing.quantity) || 0) * scale;
      if (merged.has(key)) {
        merged.get(key).quantity += qty;
      } else {
        merged.set(key, {
          key,
          name: ing.name.trim(),
          quantity: qty,
          unit,
          aisle: ing.aisle || "Other",
        });
      }
    }
  }
  return [...merged.values()];
}

function formatQty(item) {
  let q = item.quantity;
  let u = item.unit;
  if (u === "g" && q >= 1000) { q = q / 1000; u = "kg"; }
  if (u === "ml" && q >= 1000) { q = q / 1000; u = "litres"; }
  // Round countable things (onions, tins) up to whole numbers; weights to 2 dp.
  const countable = !u || !["g", "kg", "ml", "litres", "tsp", "tbsp"].includes(u);
  q = countable ? Math.ceil(q - 0.001) : Math.round(q * 100) / 100;
  // "1 tin", "3 tins" (but never "3 gs" or "2 tbsps")
  const noPlural = ["g", "kg", "ml", "litres", "tsp", "tbsp"];
  if (u && q !== 1 && !noPlural.includes(u) && !u.endsWith("s")) u += "s";
  if (!q) return u;
  if (!u) return "× " + q;
  return q + (u.length <= 2 || u === "kg" ? "" : " ") + u;
}

function groupByAisle(items) {
  const groups = new Map();
  for (const item of items) {
    if (!groups.has(item.aisle)) groups.set(item.aisle, []);
    groups.get(item.aisle).push(item);
  }
  const rank = a => {
    const i = SETTINGS.aisleOrder.indexOf(a);
    return i === -1 ? 999 : i;
  };
  return [...groups.entries()]
    .sort((a, b) => rank(a[0]) - rank(b[0]) || a[0].localeCompare(b[0]))
    .map(([aisle, list]) => [aisle, list.sort((x, y) => x.name.localeCompare(y.name))]);
}

// Recipe ingredients minus what you already have, plus the extras you typed.
// Extras live in state.extras, so swapping a meal never removes them.
function shoppingItems() {
  const fromMeals = weekIngredients().filter(i => !state.pantry[i.name.toLowerCase()]);
  // An extra that's already on the list from a recipe (e.g. you typed
  // "milk" and Macaroni Cheese needs milk) isn't shown twice.
  const onList = new Set(fromMeals.map(i => i.name.toLowerCase()));
  const extras = state.extras.filter(x => !onList.has(x.name.toLowerCase())).map(x => ({
    key: "extra|" + x.name.toLowerCase(),
    name: x.name, quantity: 0, unit: "", aisle: x.aisle || "Other", extra: true,
  }));
  return fromMeals.concat(extras);
}

function itemLabel(item) {
  const q = item.extra ? "" : formatQty(item);
  return q ? item.name + " " + q : item.name;
}

// One item per line, in aisle order, skipping things already bought.
// This is what goes to Reminders.
function shoppingText() {
  const lines = [];
  for (const [, items] of groupByAisle(shoppingItems())) {
    for (const item of items) if (!state.bought[item.key]) lines.push(itemLabel(item));
  }
  return lines.join("\n");
}

// ---------- Rendering ----------

function renderPlan() {
  const list = document.getElementById("days");
  list.replaceChildren();
  for (const day of DAYS) {
    const chosen = state.plan[day] || "";
    const recipe = findRecipe(chosen);

    const select = el("select", {
      "aria-label": "Meal for " + day,
      onchange: e => { state.plan[day] = e.target.value || null; saveState(); renderAll(); },
    },
      el("option", { value: "" }, chosen ? "— Remove meal —" : "Choose a meal…"),
      recipes.map(r => el("option", { value: r.name, selected: r.name === chosen }, r.name)),
    );

    const chip = (kind, label, cls) => el("button", {
      class: "chip " + cls + (state[kind][day] ? " on" : ""),
      "aria-pressed": state[kind][day] ? "true" : "false",
      onclick: () => { state[kind][day] = !state[kind][day]; saveState(); renderPlan(); },
    }, label);

    const people = portionsFor(day);
    const portions = el("button", {
      class: "portions", "aria-label": "Portions for " + day,
      onclick: () => {
        // Cycle 1 → 8 then back to 1.
        state.portions[day] = people >= 8 ? 1 : people + 1;
        saveState(); renderAll();
      },
    }, "👤 " + people);

    const meta = [];
    if (recipe && recipe.time) meta.push(recipe.time + " min");
    if (recipe && recipe.tags && recipe.tags.length) meta.push(recipe.tags.join(" · "));

    list.append(el("li", { class: "day" + (state.busy[day] ? " is-busy" : "") },
      el("div", { class: "day-head" },
        el("span", { class: "day-name" }, day.slice(0, 3)),
        el("div", { class: "chips" }, portions, chip("busy", "Busy", "busy"), chip("training", "Training", "train")),
      ),
      // The meal name is plain text so long names wrap; the real dropdown
      // sits invisibly on top of it, so tapping the name opens the picker.
      el("div", { class: "picker" },
        el("span", { class: "meal-title" + (chosen ? "" : " unset") }, chosen || "Choose a meal…"),
        select,
      ),
      meta.length ? el("div", { class: "meta" }, meta.join("  ·  ")) : null,
    ));
  }
}

function renderPantry() {
  const box = document.getElementById("pantry");
  box.replaceChildren();
  const items = weekIngredients();
  if (items.length === 0) {
    box.append(el("p", { class: "empty" }, "Pick some meals on the Week tab first."));
    return;
  }
  for (const [aisle, list] of groupByAisle(items)) {
    box.append(el("div", { class: "group" },
      el("h2", {}, aisle),
      el("div", { class: "rows" }, list.map(item => {
        const key = item.name.toLowerCase();
        const have = !!state.pantry[key];
        return el("label", { class: "row" + (have ? " have" : "") },
          el("input", {
            type: "checkbox", checked: have,
            onchange: e => {
              if (e.target.checked) state.pantry[key] = true; else delete state.pantry[key];
              saveState(); renderPantry(); renderList();
            },
          }),
          el("span", { class: "name" }, item.name),
          el("span", { class: "qty" }, formatQty(item)),
        );
      })),
    ));
  }
}

function renderList() {
  const box = document.getElementById("list");
  box.replaceChildren();
  const items = shoppingItems();
  if (items.length === 0) {
    const planned = weekIngredients().length > 0;
    box.append(el("p", { class: "empty" },
      planned ? "You have everything! Nothing to buy." : "Pick some meals on the Week tab, or add an item above."));
    return;
  }
  const left = items.filter(i => !state.bought[i.key]).length;
  box.append(el("p", { class: "hint" }, left === items.length
    ? items.length + " items to buy"
    : left + " of " + items.length + " items still to buy"));
  for (const [aisle, list] of groupByAisle(items)) {
    box.append(el("div", { class: "group" },
      el("h2", {}, aisle),
      el("div", { class: "rows" }, list.map(item => {
        const bought = !!state.bought[item.key];
        return el("label", { class: "row" + (bought ? " bought" : "") },
          el("input", {
            type: "checkbox", checked: bought,
            onchange: e => {
              if (e.target.checked) state.bought[item.key] = true; else delete state.bought[item.key];
              saveState(); renderList();
            },
          }),
          el("span", { class: "name" }, item.name),
          item.extra ? null : el("span", { class: "qty" }, formatQty(item)),
          item.extra ? el("button", {
            class: "remove", type: "button", "aria-label": "Remove " + item.name,
            onclick: e => {
              e.preventDefault();
              state.extras = state.extras.filter(x => x.name.toLowerCase() !== item.name.toLowerCase());
              delete state.bought[item.key];
              saveState(); renderList();
            },
          }, "×") : null,
        );
      })),
    ));
  }
}

function renderSaved() {
  const box = document.getElementById("saved");
  const query = document.getElementById("search").value.trim().toLowerCase();
  box.replaceChildren();
  const matches = recipes.filter(r =>
    !query ||
    r.name.toLowerCase().includes(query) ||
    (r.tags || []).some(t => t.includes(query)) ||
    r.ingredients.some(i => i.name.toLowerCase().includes(query)));
  if (matches.length === 0) {
    box.append(el("p", { class: "empty" }, "No meals match “" + query + "”."));
    return;
  }
  for (const r of matches) {
    const mark = state.marks[r.name];
    const toggle = (value, label) => el("button", {
      class: "mark " + value + (mark === value ? " on" : ""),
      onclick: () => {
        if (state.marks[r.name] === value) delete state.marks[r.name];
        else state.marks[r.name] = value;
        saveState(); renderSaved();
      },
    }, label);
    const sub = [];
    if (r.time) sub.push(r.time + " min");
    sub.push("serves " + (r.serves || 4));
    if ((r.tags || []).length) sub.push(r.tags.join(" · "));
    box.append(el("details", {
      class: "meal" + (mark === "never" ? " is-never" : ""),
      open: openMeals.has(r.name),
      ontoggle: e => e.target.open ? openMeals.add(r.name) : openMeals.delete(r.name),
    },
      el("summary", {},
        el("div", { class: "meal-name" }, r.name),
        el("div", { class: "meal-sub" }, sub.join("  ·  ")),
      ),
      el("h3", {}, "Ingredients (serves " + (r.serves || 4) + ")"),
      el("ul", {}, r.ingredients.map(i => el("li", {}, i.name + " " + formatQty({ ...i, quantity: Number(i.quantity) || 0 })))),
      (r.method || []).length ? el("h3", {}, "Method") : null,
      (r.method || []).length ? el("ol", {}, r.method.map(step => el("li", {}, step))) : null,
      el("div", { class: "marks" }, toggle("repeat", "Repeat soon"), toggle("never", "Not again")),
    ));
  }
}

function renderPrefs() {
  document.getElementById("pref-portions").textContent = state.prefs.portions;
  document.getElementById("pref-maxTime").textContent = state.prefs.maxTime;
  document.getElementById("pref-vegetarian").checked = state.prefs.vegetarian;
  const avoid = document.getElementById("pref-avoid");
  if (document.activeElement !== avoid) avoid.value = state.prefs.avoid;
  renderShare();
}

function renderShare() {
  const box = document.getElementById("share");
  const nameInput = document.getElementById("share-name");
  if (document.activeElement !== nameInput) nameInput.value = state.share.name;
  if (!Sync.available()) {
    box.className = "share off";
    document.getElementById("share-joined").hidden = true;
    document.getElementById("share-join").hidden = true;
    document.getElementById("share-unavailable").hidden = false;
    return;
  }
  document.getElementById("share-unavailable").hidden = true;
  const joined = !!state.share.code;
  document.getElementById("share-joined").hidden = !joined;
  document.getElementById("share-join").hidden = joined;
  document.getElementById("share-code").textContent = state.share.code;
  renderSyncStatus(Sync.status());
}

function renderSyncStatus(status) {
  const line = document.getElementById("sync-status");
  line.textContent = status.text;
  line.className = "sync " + (status.ok === true ? "ok" : status.ok === false ? "bad" : "");
  line.hidden = !state.share.code;
}

function renderAll() {
  renderPlan();
  renderPantry();
  renderList();
  renderSaved();
  renderPrefs();
}

// ---------- Buttons ----------

function showView(name) {
  document.querySelectorAll(".view").forEach(v => v.classList.toggle("active", v.id === "view-" + name));
  document.querySelectorAll(".tabs button").forEach(b => b.classList.toggle("active", b.dataset.view === name));
  document.getElementById("title").textContent =
    { plan: "Your week", pantry: "Already have", list: "Shopping", saved: "Favourites" }[name];
  window.scrollTo(0, 0);
}

function sendToReminders() {
  const text = shoppingText();
  if (!text) { toast("Nothing to send"); return; }
  const url = "shortcuts://run-shortcut?name=" + encodeURIComponent(SETTINGS.shortcutName) +
    "&input=text&text=" + encodeURIComponent(text);
  window.location.href = url;
}

async function copyList() {
  const text = shoppingText();
  if (!text) { toast("Nothing to copy"); return; }
  try {
    await navigator.clipboard.writeText(text);
    toast("Copied");
  } catch (e) {
    toast("Couldn't copy on this device");
  }
}

function addExtra(name) {
  name = name.trim();
  if (!name) return;
  const exists = state.extras.some(x => x.name.toLowerCase() === name.toLowerCase());
  if (!exists) state.extras.push({ name: name[0].toUpperCase() + name.slice(1), aisle: "Other" });
  saveState(); renderList();
}

function setUp() {
  document.querySelectorAll(".tabs button").forEach(b =>
    b.addEventListener("click", () => showView(b.dataset.view)));
  document.getElementById("btn-suggest").addEventListener("click", suggestWeek);
  document.getElementById("btn-clear").addEventListener("click", () => {
    // New week: meals, portions, "already have" ticks and bought ticks go.
    // Extras, busy/training days and preferences stay.
    state.plan = {}; state.portions = {}; state.pantry = {}; state.bought = {};
    saveState(); renderAll(); toast("Ready for a new week");
  });
  document.getElementById("btn-untick").addEventListener("click", () => {
    state.pantry = {};
    saveState(); renderAll();
  });
  document.getElementById("btn-unbuy").addEventListener("click", () => {
    state.bought = {};
    saveState(); renderList();
  });
  document.getElementById("btn-reminders").addEventListener("click", sendToReminders);
  document.getElementById("btn-copy").addEventListener("click", copyList);
  document.getElementById("extra-form").addEventListener("submit", e => {
    e.preventDefault();
    const input = document.getElementById("extra-input");
    addExtra(input.value);
    input.value = "";
  });
  document.getElementById("search").addEventListener("input", renderSaved);
  document.getElementById("shortcut-name").textContent = SETTINGS.shortcutName;

  // Preferences
  document.querySelectorAll("[data-pref]").forEach(b => b.addEventListener("click", () => {
    const key = b.dataset.pref, delta = Number(b.dataset.delta);
    const min = key === "portions" ? 1 : 10, max = key === "portions" ? 12 : 120;
    state.prefs[key] = Math.min(max, Math.max(min, state.prefs[key] + delta));
    saveState(); renderAll();
  }));
  document.getElementById("pref-vegetarian").addEventListener("change", e => {
    state.prefs.vegetarian = e.target.checked; saveState();
  });
  document.getElementById("pref-avoid").addEventListener("input", e => {
    state.prefs.avoid = e.target.value; saveState();
  });

  // Sharing
  document.getElementById("share-name").addEventListener("input", e => {
    state.share.name = e.target.value.trim();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
  });
  document.getElementById("share-new").addEventListener("click", () => joinHousehold(Sync.newCode()));
  document.getElementById("share-join-form").addEventListener("submit", e => {
    e.preventDefault();
    joinHousehold(document.getElementById("share-code-input").value);
  });
  document.getElementById("share-leave").addEventListener("click", () => {
    state.share.code = ""; state.share.lastChange = null;
    Sync.stop();
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
    renderAll(); toast("This phone is no longer sharing");
  });
}

async function joinHousehold(code) {
  code = (code || "").trim().toLowerCase();
  if (!code) { toast("Type the household code first"); return; }
  if (!state.share.name) { toast("Add your name first so Rach can see who changed what"); document.getElementById("share-name").focus(); return; }
  state.share.code = code;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
  renderAll();
  await Sync.start(state);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (err) { /* ignore */ }
  renderAll();
  toast(Sync.status().ok === false ? "Couldn't connect. Check the code and try again." : "Sharing as " + code);
}

async function start() {
  setUp();
  Sync.configure(SETTINGS.supabase, {
    deviceId: deviceId(),
    // Something changed on another phone: save it here and redraw.
    onChange: () => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { /* ignore */ }
      renderAll();
    },
    onStatus: renderSyncStatus,
  });
  try {
    // "no-cache" makes sure edits to recipes.json show up straight away.
    const res = await fetch("recipes.json", { cache: "no-cache" });
    recipes = await res.json();
  } catch (e) {
    document.getElementById("days").replaceChildren(
      el("p", { class: "empty" }, "Couldn't load recipes.json. Check the file is next to index.html and is valid JSON."));
    return;
  }
  // Forget plans for recipes that no longer exist.
  for (const d of DAYS) if (state.plan[d] && !findRecipe(state.plan[d])) state.plan[d] = null;
  renderAll();
  if (state.share.code) Sync.start(state);
}

start();
