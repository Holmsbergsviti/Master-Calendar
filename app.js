import { collection, addDoc, getDoc, getDocs, deleteDoc, deleteField, doc, updateDoc, query, where, limit } from "https://www.gstatic.com/firebasejs/12.8.0/firebase-firestore.js";
import { db } from "./firebase.js";

/* =====================================================================
   Configuration — one place to add/remove coaches or lesson types.
   Everything else (legend, filters, chips, colours) is built from these.
   ===================================================================== */

const COACHES = [
  { name: "Vlad",       color: "#3b82f6" },
  { name: "Ana",        color: "#ec4899" },
  { name: "Petar Boss", color: "#f59e0b" },
  { name: "Milan",      color: "#10b981" }
];

const LESSON_TYPES = [
  { value: "class",  label: "Class",  mins: 45 },
  { value: "double", label: "Double", mins: 90 },
  { value: "group",  label: "Group",  mins: 60 }
];

const coachColors  = Object.fromEntries(COACHES.map(c => [c.name, c.color]));
const typeDuration = Object.fromEntries(LESSON_TYPES.map(t => [t.value, t.mins]));
const typeLabel    = Object.fromEntries(LESSON_TYPES.map(t => [t.value, t.label]));
const groupColor   = "#8b5cf6";
const fallbackColor = "#94a3b8";

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

// The hours the grid actually draws. A lesson outside these would be saved but
// invisible, so booking one is refused outright. Single source of truth: these
// also drive slotMinTime/slotMaxTime below.
const GRID_START = "09:00";
const GRID_END   = "22:00";
const GRID_START_MIN = timeToMinutes(GRID_START);
const GRID_END_MIN   = timeToMinutes(GRID_END);

// Times when the hall is already taken. Anything NOT listed here is fully free.
//   none       -> both halls booked
//   small-only -> only the small hall is still free
//   big-only   -> only the big hall is still free
const hallSchedule = [
  { day: 1, from: "10:30", to: "11:30", status: "small-only" },
  { day: 1, from: "18:00", to: "22:00", status: "none" },

  { day: 2, from: "11:00", to: "12:00", status: "small-only" },
  { day: 2, from: "18:00", to: "22:00", status: "small-only" },

  { day: 3, from: "18:00", to: "22:00", status: "big-only" },

  { day: 4, from: "11:00", to: "12:00", status: "small-only" },
  { day: 4, from: "18:00", to: "22:00", status: "small-only" },

  { day: 5, from: "10:30", to: "11:30", status: "small-only" },
  { day: 5, from: "18:00", to: "20:00", status: "small-only" },

  { day: 6, from: "09:00", to: "12:00", status: "small-only" },
  { day: 6, from: "18:00", to: "20:00", status: "small-only" },

  { day: 0, from: "18:00", to: "22:00", status: "small-only" } // sunday
];

/* ===== DOM ===== */
const modal              = document.getElementById("lessonModal");
const modalBackdrop      = modal.querySelector(".modal-backdrop");
const modalTitle         = document.getElementById("modalTitle");
const titleInput         = document.getElementById("lessonTitle");
const coachChips         = document.getElementById("coachChips");
const typeSegment        = document.getElementById("typeSegment");
const lessonDateInput    = document.getElementById("lessonDate");
const lessonTimeInput    = document.getElementById("lessonTime");
const saveBtn            = document.getElementById("saveLesson");
const cancelBtn          = document.getElementById("cancelLesson");
const closeModalBtn      = document.getElementById("closeModal");
const deleteBtn          = document.getElementById("deleteLesson");
const addLessonBtn       = document.getElementById("addLessonBtn");
const calendarEl         = document.getElementById("calendar");
const repeatWeeklyToggle = document.getElementById("repeatWeekly");
const repeatEndDateInput = document.getElementById("repeatEndDate");
const repeatEndDateLabel = document.getElementById("repeatEndDateLabel");
const bulkEditOptions    = document.getElementById("bulkEditOptions");
const editAllFutureBtn   = document.getElementById("editAllFutureBtn");
const coachFilter        = document.getElementById("coachFilter");
const typeFilter         = document.getElementById("typeFilter");
const coachLegend        = document.getElementById("coachLegend");
const conflictNotice     = document.getElementById("conflictNotice");
const toastHost          = document.getElementById("toastHost");
const dialogHost         = document.getElementById("dialogHost");
const themeToggle        = document.getElementById("themeToggle");
const studentPicker      = document.getElementById("studentPicker");
const statsBtn           = document.getElementById("statsBtn");
const statsModal         = document.getElementById("statsModal");
const statsBackdrop      = statsModal.querySelector(".modal-backdrop");
const closeStatsBtn      = document.getElementById("closeStats");
const statsPrevBtn       = document.getElementById("statsPrev");
const statsNextBtn       = document.getElementById("statsNext");
const statsMonthLabel    = document.getElementById("statsMonthLabel");
const statsSummary       = document.getElementById("statsSummary");
const statsTabs          = document.getElementById("statsTabs");
const statsBody          = document.getElementById("statsBody");

/* ===== State ===== */
let calendar;
let selectedEvent   = null;
let editingAllFuture = false;
let saving          = false;
let saveBlocked     = false;
let modalCloseTimer = null;
let lastFocused     = null;
let suppressClickUntil = 0;

// Snapshot of every lesson doc from the last fetch. Conflict detection and the
// monthly stats read this instead of calendar.getEvents(), so lessons outside
// the rendered weeks are still taken into account.
let lessonCache = [];
let cancelledSet = new Set();

// Roster docs. Stats never read this — they are derived from the lessons
// themselves, which is what keeps a deleted student's history intact.
let studentCache = [];
let statsMonth = new Date();
let statsTab = "coach";

/* =====================================================================
   Date helpers
   ===================================================================== */

function formatDateInput(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function formatTimeInput(date) {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

// "YYYY-MM-DD" parsed as LOCAL time — new Date("YYYY-MM-DD") would be UTC midnight
// and can shift the date by a day depending on timezone
function parseDateInputLocal(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function endOfDayLocal(str) {
  const d = parseDateInputLocal(str);
  d.setHours(23, 59, 59, 999);
  return d;
}

function weekStartMonday(date) {
  const d = new Date(date);
  const day = (d.getDay() + 6) % 7; // Mon=0 ... Sun=6
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - day);
  return d;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function addMinutes(date, mins) {
  const d = new Date(date);
  d.setMinutes(d.getMinutes() + mins);
  return d;
}

function timeToMinutes(t) {
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

function isValidDate(d) {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

function formatOrdinal(n) {
  if (n > 3 && n < 21) return n + "th";
  switch (n % 10) {
    case 1:  return n + "st";
    case 2:  return n + "nd";
    case 3:  return n + "rd";
    default: return n + "th";
  }
}

/**
 * Phones lay the grid out at real device width now that there is a viewport
 * meta tag, and FullCalendar decides its own row heights — CSS cannot shrink
 * them. Halving the number of rows (30-minute slots instead of 15) is what
 * actually keeps the whole 09:00-22:00 week on screen. Event positions are
 * computed from times, not slot boundaries, so a 45-minute lesson still lands
 * in the right place.
 */
function phoneLayout() {
  return window.innerWidth < 600;
}

function describeOccurrence(date) {
  return date.toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
  });
}

/* =====================================================================
   Theme switch

   The inline script in index.html has already stamped data-theme before
   first paint. Until the switch is touched the page keeps following the
   system setting; flipping it saves an explicit choice.
   ===================================================================== */

const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");

function readStoredTheme() {
  try {
    const v = localStorage.getItem("theme");
    return v === "light" || v === "dark" ? v : null;
  } catch (e) {
    return null; // storage blocked (private mode)
  }
}

function currentTheme() {
  return document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light";
}

function applyTheme(theme, persist) {
  const root = document.documentElement;

  if (persist) {
    root.classList.add("theme-transition");
    clearTimeout(applyTheme._t);
    applyTheme._t = setTimeout(() => root.classList.remove("theme-transition"), 320);
    try { localStorage.setItem("theme", theme); } catch (e) { /* ignore */ }
  }

  root.setAttribute("data-theme", theme);
  themeToggle.setAttribute("aria-checked", String(theme === "dark"));
  themeToggle.setAttribute("aria-label", theme === "dark" ? "Switch to light mode" : "Switch to dark mode");
}

function initTheme() {
  applyTheme(currentTheme(), false); // sync the switch with what the inline script chose

  themeToggle.addEventListener("click", () => {
    applyTheme(currentTheme() === "dark" ? "light" : "dark", true);
  });

  // Keep tracking the system until the boss picks a side
  prefersDark.addEventListener("change", e => {
    if (!readStoredTheme()) applyTheme(e.matches ? "dark" : "light", false);
  });
}

/* =====================================================================
   Toasts and dialogs (replaces alert() / confirm())
   ===================================================================== */

const TOAST_ICONS = { success: "✓", error: "!", warn: "!", info: "i" };

function toast(message, type = "info") {
  const el = document.createElement("div");
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon"></span><span class="toast-msg"></span>`;
  el.querySelector(".toast-icon").textContent = TOAST_ICONS[type] || "i";
  el.querySelector(".toast-msg").textContent = message;

  const dismiss = () => {
    if (el.classList.contains("closing")) return;
    el.classList.add("closing");
    setTimeout(() => el.remove(), 260);
  };

  const timer = setTimeout(dismiss, 3400);
  el.addEventListener("click", () => { clearTimeout(timer); dismiss(); });
  toastHost.appendChild(el);
}

/**
 * Animated replacement for confirm(). `actions` is a list of
 * { label, value, tone } — resolves with the chosen value, or null on
 * Escape / backdrop click.
 */
function openDialog({ title, message, actions }) {
  return new Promise(resolve => {
    const overlay = document.createElement("div");
    overlay.className = "dialog-overlay";
    overlay.innerHTML = `
      <div class="dialog" role="alertdialog" aria-modal="true">
        <h3 class="dialog-title"></h3>
        <p class="dialog-message"></p>
        <div class="dialog-actions"></div>
      </div>`;

    overlay.querySelector(".dialog-title").textContent = title;
    const msgEl = overlay.querySelector(".dialog-message");
    if (message) msgEl.textContent = message;
    else msgEl.remove();

    let settled = false;
    const close = value => {
      if (settled) return;
      settled = true;
      document.removeEventListener("keydown", onKey);
      overlay.classList.add("closing");
      setTimeout(() => overlay.remove(), 200);
      resolve(value);
    };

    const actionsEl = overlay.querySelector(".dialog-actions");
    actions.forEach(a => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = `btn ${a.tone || "ghost"}`;
      b.textContent = a.label;
      b.addEventListener("click", () => close(a.value));
      actionsEl.appendChild(b);
    });

    function onKey(e) {
      if (e.key === "Escape") { e.stopPropagation(); close(null); }
    }

    overlay.addEventListener("click", e => { if (e.target === overlay) close(null); });
    document.addEventListener("keydown", onKey);
    dialogHost.appendChild(overlay);
    requestAnimationFrame(() => actionsEl.querySelector("button")?.focus());
  });
}

async function confirmDialog(title, message, confirmLabel = "Confirm", tone = "danger") {
  const v = await openDialog({
    title,
    message,
    actions: [
      { label: confirmLabel, value: true,  tone },
      { label: "Cancel",     value: false, tone: "ghost" }
    ]
  });
  return v === true;
}

/* =====================================================================
   Colours
   ===================================================================== */

function getEventColor(coachList, lessonType = "class") {
  if (lessonType === "group") return groupColor;
  const list = Array.isArray(coachList) ? coachList : [coachList];
  return coachColors[list[0]] || fallbackColor;
}

function applyEventColors(info) {
  const coach = info.event.extendedProps.coach;
  const lessonType = info.event.extendedProps.lessonType || "class";
  const list = Array.isArray(coach) ? coach : [coach];

  if (lessonType === "group") {
    info.el.style.backgroundImage = "";
    info.el.style.backgroundColor = groupColor;
    return;
  }

  if (list.length > 1) {
    const colors = list.map(c => coachColors[c] || fallbackColor);
    info.el.style.backgroundColor = "transparent";
    info.el.style.backgroundImage = `linear-gradient(120deg, ${colors.join(", ")})`;
  } else {
    info.el.style.backgroundImage = "";
    info.el.style.backgroundColor = getEventColor(list, lessonType);
  }
}

function statusToColor(status) {
  if (status === "none")       return "rgba(202, 33, 33, 0.22)";  // both halls taken
  if (status === "small-only") return "rgba(255, 210, 80, 0.22)"; // only the small hall free
  if (status === "big-only")   return "rgba(120, 180, 255, 0.22)";// only the big hall free
  return null;                                                    // both free — no shading
}

/* =====================================================================
   Hall availability
   ===================================================================== */

// Iterate day-by-day with setDate() rather than adding 24h, so DST changes
// don't skip or repeat a weekday.
function getHallBackgroundEvents(start, end) {
  const events = [];
  const cursor = new Date(start.getFullYear(), start.getMonth(), start.getDate());

  while (cursor < end) {
    const y = cursor.getFullYear(), mo = cursor.getMonth(), da = cursor.getDate();

    for (const r of hallSchedule) {
      if (r.day !== cursor.getDay()) continue;
      const bg = statusToColor(r.status);
      if (!bg) continue;

      const fromM = timeToMinutes(r.from);
      const toM   = timeToMinutes(r.to);

      events.push({
        start: new Date(y, mo, da, Math.floor(fromM / 60), fromM % 60),
        end:   new Date(y, mo, da, Math.floor(toM / 60),   toM % 60),
        display: "background",
        allDay: false,
        backgroundColor: bg,
        extendedProps: { isHall: true, status: r.status }
      });
    }

    cursor.setDate(cursor.getDate() + 1);
  }

  return events;
}

function renderHallAvailability() {
  calendar.getEvents().forEach(ev => {
    if (ev.extendedProps && ev.extendedProps.isHall) ev.remove();
  });
  getHallBackgroundEvents(calendar.view.activeStart, calendar.view.activeEnd)
    .forEach(ev => calendar.addEvent(ev));
}

/**
 * hallSchedule lists the times the hall is BUSY, so a slot that overlaps no
 * rule at all is completely free. Overlapping a "none" rule means both halls
 * are gone; overlapping small-only/big-only means one hall is still free.
 */
/**
 * Refuses times the calendar cannot draw. Anything starting before GRID_START
 * or finishing after GRID_END would be stored but never appear on the grid,
 * so it is blocked rather than warned about.
 */
function checkWithinGrid(start, end) {
  if (!isValidDate(start) || !isValidDate(end)) return { ok: true };

  const startMin = start.getHours() * 60 + start.getMinutes();
  const endMin   = startMin + Math.round((end - start) / 60000); // avoids midnight wrap

  if (startMin < GRID_START_MIN) {
    return { ok: false, reason: `Lessons cannot start before ${GRID_START} — the calendar does not show earlier times.` };
  }
  if (endMin > GRID_END_MIN) {
    const h = String(Math.floor(endMin / 60) % 24).padStart(2, "0");
    const m = String(endMin % 60).padStart(2, "0");
    return { ok: false, reason: `This lesson would run until ${h}:${m}, past the ${GRID_END} end of the day. Start it earlier or pick a shorter type.` };
  }
  return { ok: true };
}

function checkHallAvailability(start, end) {
  if (!isValidDate(start) || !isValidDate(end)) return { available: true, status: null };

  const day = start.getDay();
  const startMins = start.getHours() * 60 + start.getMinutes();
  let endMins = end.getHours() * 60 + end.getMinutes();
  if (endMins <= startMins) endMins = 24 * 60; // lesson runs past midnight

  const overlapping = hallSchedule.filter(r =>
    r.day === day &&
    startMins < timeToMinutes(r.to) &&
    endMins   > timeToMinutes(r.from)
  );

  if (overlapping.length === 0) return { available: true, status: null };
  if (overlapping.some(r => r.status === "none")) return { available: false, status: "none" };

  return { available: true, status: overlapping[0].status };
}

/* =====================================================================
   Conflict detection (reads lessonCache, not the rendered view)
   ===================================================================== */

// Where would this lesson land in the same week as `target`?
function occurrenceNear(lesson, target) {
  const baseStart = new Date(lesson.start);
  if (!isValidDate(baseStart)) return null;
  if (!lesson.repeatWeekly) return baseStart;

  const offset = Math.round((weekStartMonday(target) - weekStartMonday(baseStart)) / WEEK_MS);
  if (offset < 0) return null;

  const occ = addDays(baseStart, offset * 7);
  if (lesson.repeatEndDate && occ > new Date(lesson.repeatEndDate)) return null;
  return occ;
}

function findConflicts(start, end, excludeDocId = null, excludeOccISO = null) {
  const out = [];

  for (const l of lessonCache) {
    const occ = occurrenceNear(l, start);
    if (!occ) continue;

    const occISO = occ.toISOString();
    if (cancelledSet.has(`${l.id}__${occISO}`)) continue;
    if (l.id === excludeDocId && (!excludeOccISO || occISO === excludeOccISO)) continue;

    const occEnd = addMinutes(occ, l.durationMins);
    if (start < occEnd && end > occ) {
      out.push({ title: l.title, coach: l.coach, start: occ, end: occEnd });
    }
  }

  return out;
}

function hideConflictNotice() {
  conflictNotice.classList.add("hidden");
}

function showConflictNotice(conflicts, hall, grid = { ok: true }) {
  // Outside calendar hours is a hard stop, so it replaces everything else
  if (!grid.ok) {
    conflictNotice.className = "notice error";
    conflictNotice.querySelector(".notice-icon").textContent = "⛔";
    conflictNotice.querySelector(".notice-title").textContent = "Outside calendar hours";
    conflictNotice.querySelector(".notice-text").textContent = grid.reason;
    return;
  }

  const lines = [];
  let tone = "";     // "" = warn (default), "error", "info"

  if (!hall.available) {
    lines.push("Both halls are already booked at this time.");
    tone = "error";
  } else if (hall.status === "small-only") {
    lines.push("Only the small hall is free then.");
  } else if (hall.status === "big-only") {
    lines.push("Only the big hall is free then.");
  }

  if (conflicts.length > 0) {
    const names = conflicts.slice(0, 3)
      .map(c => `${c.title} · ${describeOccurrence(c.start)}`)
      .join("\n");
    const more = conflicts.length > 3 ? `\n+${conflicts.length - 3} more` : "";
    lines.push(`Overlaps ${conflicts.length} lesson${conflicts.length > 1 ? "s" : ""}:\n${names}${more}`);
    if (tone !== "error") tone = "";
  }

  if (lines.length === 0) { hideConflictNotice(); return; }

  const isInfoOnly = hall.available && conflicts.length === 0;
  conflictNotice.className = `notice ${tone === "error" ? "error" : isInfoOnly ? "info" : ""}`.trim();
  conflictNotice.querySelector(".notice-icon").textContent = tone === "error" ? "⛔" : isInfoOnly ? "ℹ" : "⚠";
  conflictNotice.querySelector(".notice-title").textContent =
    tone === "error" ? "Hall unavailable" : isInfoOnly ? "Good to know" : "Heads up";
  conflictNotice.querySelector(".notice-text").textContent = lines.join("\n");
}

function updateConflictPreview() {
  const start = readStartFromInputs();
  if (!start) { hideConflictNotice(); setSaveBlocked(false); return; }

  const end = addMinutes(start, typeDuration[getLessonType()] ?? 45);
  const grid = checkWithinGrid(start, end);
  const conflicts = findConflicts(
    start, end,
    selectedEvent ? selectedEvent.extendedProps.docId : null,
    selectedEvent ? selectedEvent.extendedProps.occStart : null
  );
  showConflictNotice(conflicts, checkHallAvailability(start, end), grid);
  setSaveBlocked(!grid.ok);
}

// Out-of-hours is a policy, not a warning, so Save is disabled outright.
function setSaveBlocked(blocked) {
  saveBlocked = blocked;
  saveBtn.disabled = blocked || saving;
  saveBtn.classList.toggle("blocked", blocked);
}

/* =====================================================================
   Students

   A lesson's title IS the student's name — that is how the calendar has
   always been filled in, so no migration is needed and old lessons count
   towards the stats straight away.

   The roster is only used to populate the picker. Deleting a student
   archives the roster entry and never touches a lesson, so past months
   keep counting them.
   ===================================================================== */

function nameKey(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, " ");
}

async function loadStudents() {
  try {
    const snap = await getDocs(collection(db, "students"));
    studentCache = snap.docs.map(d => ({
      id: d.id,
      name: d.data().name || "",
      key: nameKey(d.data().name),
      archived: !!d.data().archived
    }));
  } catch (e) {
    console.error(e);
    studentCache = [];
  }
}

function archivedKeys() {
  return new Set(studentCache.filter(s => s.archived).map(s => s.key));
}

/**
 * Everyone who can be picked: roster entries plus any name that appears in
 * lesson history but was never added explicitly (i.e. every lesson booked
 * before this feature existed). Archived names are left out.
 */
function activeRoster() {
  const archived = archivedKeys();
  const byKey = new Map();

  studentCache.forEach(s => {
    if (s.archived || !s.key) return;
    byKey.set(s.key, { key: s.key, name: s.name, id: s.id, lessons: 0, coaches: new Set() });
  });

  lessonCache.forEach(l => {
    const key = nameKey(l.title);
    if (!key || archived.has(key)) return;
    if (!byKey.has(key)) byKey.set(key, { key, name: l.title.trim(), id: null, lessons: 0, coaches: new Set() });
    const entry = byKey.get(key);
    entry.lessons++;
    l.coach.forEach(c => entry.coaches.add(c));
  });

  return Array.from(byKey.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Roster entries a given coach has actually taught, most frequent first. */
function rosterForCoaches(coaches) {
  const counts = new Map();
  lessonCache.forEach(l => {
    if (!coaches.some(c => l.coach.includes(c))) return;
    const key = nameKey(l.title);
    if (!key) return;
    counts.set(key, (counts.get(key) || 0) + 1);
  });
  return counts;
}

/**
 * Only ever called from the "Add student" box on the Students tab. Saving a
 * lesson never adds anyone — the roster is curated by hand.
 * Returns false if the name is already on the roster.
 */
async function addStudent(name) {
  const key = nameKey(name);
  if (!key) return false;

  const existing = studentCache.find(s => s.key === key);
  if (existing) {
    if (existing.archived) {
      await updateDoc(doc(db, "students", existing.id), { archived: false });
      existing.archived = false;
      return true;
    }
    return false;
  }

  const ref = await addDoc(collection(db, "students"), {
    name: name.trim(),
    archived: false,
    createdAt: new Date().toISOString()
  });
  studentCache.push({ id: ref.id, name: name.trim(), key, archived: false });
  return true;
}

/**
 * Soft delete. The lessons stay exactly as they are, so every month this
 * student appears in keeps its numbers.
 */
async function archiveStudent(entry) {
  if (entry.id) {
    await updateDoc(doc(db, "students", entry.id), { archived: true, archivedAt: new Date().toISOString() });
    const cached = studentCache.find(s => s.id === entry.id);
    if (cached) cached.archived = true;
    return;
  }
  // Name only ever seen in lesson history — record it purely to hide it
  const ref = await addDoc(collection(db, "students"), {
    name: entry.name,
    archived: true,
    createdAt: new Date().toISOString(),
    archivedAt: new Date().toISOString()
  });
  studentCache.push({ id: ref.id, name: entry.name, key: entry.key, archived: true });
}

async function restoreStudent(id) {
  await updateDoc(doc(db, "students", id), { archived: false });
  const cached = studentCache.find(s => s.id === id);
  if (cached) cached.archived = false;
}

/* =====================================================================
   Occurrence expansion — one implementation shared by the calendar and
   the stats, so weekly repeats and cancellations can never disagree.
   ===================================================================== */

function occurrencesInRange(rangeStart, rangeEnd) {
  const out = [];

  for (const l of lessonCache) {
    const baseStart = new Date(l.start);
    if (!isValidDate(baseStart)) continue;

    const push = occStart => {
      const occEnd = addMinutes(occStart, l.durationMins);
      if (occEnd <= rangeStart || occStart >= rangeEnd) return;
      if (cancelledSet.has(`${l.id}__${occStart.toISOString()}`)) return;
      out.push({ lesson: l, start: occStart, end: occEnd });
    };

    if (!l.repeatWeekly) {
      push(baseStart);
      continue;
    }

    const endLimit = l.repeatEndDate ? new Date(l.repeatEndDate) : null;
    const offset = Math.max(
      0,
      Math.round((weekStartMonday(rangeStart) - weekStartMonday(baseStart)) / WEEK_MS)
    );

    // Bounded: a month view spans ~6 weeks, so this never runs long
    for (let i = 0; i < 64; i++) {
      const occStart = addDays(baseStart, (offset + i) * 7);
      if (endLimit && occStart > endLimit) break;
      if (occStart >= rangeEnd) break;
      push(occStart);
    }
  }

  return out;
}

/* =====================================================================
   Monthly stats
   ===================================================================== */

function monthRange(d) {
  return {
    start: new Date(d.getFullYear(), d.getMonth(), 1),
    end:   new Date(d.getFullYear(), d.getMonth() + 1, 1)
  };
}

function canonicalName(key, fallback) {
  const known = studentCache.find(s => s.key === key);
  return known ? known.name : fallback.trim();
}

// A double is a 90-minute back-to-back slot, so it is worth two lessons.
const LESSON_WEIGHT = { double: 2 };
function lessonWeight(type) {
  return LESSON_WEIGHT[type] || 1;
}

/**
 * A lesson with two coaches counts for each of them, so the coach totals can
 * add up to more than the month's lesson count. Doubles count as two. Both
 * are spelled out in the UI.
 */
function computeMonthStats(monthDate) {
  const { start, end } = monthRange(monthDate);
  const byCoach = new Map();
  const byStudent = new Map();
  let total = 0;
  let sessions = 0;

  for (const occ of occurrencesInRange(start, end)) {
    if (occ.start < start || occ.start >= end) continue;
    const l = occ.lesson;
    const key = nameKey(l.title);
    if (!key) continue;

    const weight = lessonWeight(l.lessonType);
    total += weight;
    sessions++;
    const name = canonicalName(key, l.title);

    let student = byStudent.get(key);
    if (!student) {
      student = { key, name, total: 0, coaches: new Map(), types: new Map() };
      byStudent.set(key, student);
    }
    student.total += weight;
    // types stays a count of actual sessions booked, not weighted
    student.types.set(l.lessonType, (student.types.get(l.lessonType) || 0) + 1);

    const coaches = l.coach.length ? l.coach : ["Unassigned"];
    for (const c of coaches) {
      student.coaches.set(c, (student.coaches.get(c) || 0) + weight);

      let coach = byCoach.get(c);
      if (!coach) { coach = { name: c, total: 0, students: new Map() }; byCoach.set(c, coach); }
      coach.total += weight;
      const s = coach.students.get(key) || { key, name, count: 0 };
      s.count += weight;
      coach.students.set(key, s);
    }
  }

  return { start, end, total, sessions, byCoach, byStudent };
}

/* =====================================================================
   Form controls built from the config
   ===================================================================== */

function renderCoachChips() {
  coachChips.innerHTML = "";
  COACHES.forEach(c => {
    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "chip";
    chip.dataset.coach = c.name;
    chip.style.setProperty("--chip-color", c.color);
    chip.setAttribute("aria-pressed", "false");
    chip.innerHTML = `<span class="chip-dot"></span><span class="chip-label"></span>`;
    chip.querySelector(".chip-label").textContent = c.name;
    chip.addEventListener("click", () => {
      const on = chip.classList.toggle("selected");
      chip.setAttribute("aria-pressed", String(on));
      renderStudentPicker(); // re-rank to this coach's students
    });
    coachChips.appendChild(chip);
  });
}

function getSelectedCoaches() {
  return Array.from(coachChips.querySelectorAll(".chip.selected")).map(el => el.dataset.coach);
}

function setSelectedCoaches(list) {
  const set = new Set(Array.isArray(list) ? list : list ? [list] : []);
  coachChips.querySelectorAll(".chip").forEach(el => {
    const on = set.has(el.dataset.coach);
    el.classList.toggle("selected", on);
    el.setAttribute("aria-pressed", String(on));
  });
}

function renderTypeSegments() {
  typeSegment.innerHTML = "";
  LESSON_TYPES.forEach(t => {
    const label = document.createElement("label");
    label.className = "segment";
    label.innerHTML = `
      <input type="radio" name="lessonType" value="${t.value}">
      <span class="segment-label"></span>
      <span class="segment-sub"></span>`;
    label.querySelector(".segment-label").textContent = t.label;
    label.querySelector(".segment-sub").textContent = `${t.mins} min`;
    typeSegment.appendChild(label);
  });

  typeSegment.addEventListener("change", () => {
    syncSegmentClasses();
    updateConflictPreview();
  });
}

function syncSegmentClasses() {
  typeSegment.querySelectorAll(".segment").forEach(seg => {
    seg.classList.toggle("active", !!seg.querySelector("input")?.checked);
  });
}

function getLessonType() {
  return typeSegment.querySelector("input:checked")?.value || LESSON_TYPES[0].value;
}

function setLessonType(value) {
  const input = typeSegment.querySelector(`input[value="${value}"]`) || typeSegment.querySelector("input");
  if (input) input.checked = true;
  syncSegmentClasses();
}

function renderFilterOptions() {
  COACHES.forEach(c => {
    const o = document.createElement("option");
    o.value = c.name;
    o.textContent = c.name;
    coachFilter.appendChild(o);
  });
  LESSON_TYPES.forEach(t => {
    const o = document.createElement("option");
    o.value = t.value;
    o.textContent = t.label;
    typeFilter.appendChild(o);
  });
}

// Legend doubles as a one-click coach filter.
function renderCoachLegend() {
  coachLegend.innerHTML = "";
  COACHES.forEach(c => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "coach-legend-item";
    item.style.setProperty("--coach-color", c.color);
    item.innerHTML = `<span class="coach-color-box"></span><span class="coach-name"></span>`;
    item.querySelector(".coach-name").textContent = c.name;
    item.addEventListener("click", () => {
      coachFilter.value = coachFilter.value === c.name ? "" : c.name;
      syncLegendActive();
      calendar.refetchEvents();
    });
    coachLegend.appendChild(item);
  });
}

function syncLegendActive() {
  coachLegend.querySelectorAll(".coach-legend-item").forEach(el => {
    el.classList.toggle("active", el.querySelector(".coach-name").textContent === coachFilter.value);
  });
}

/* =====================================================================
   Student picker — the name only ever gets typed once
   ===================================================================== */

function renderStudentPicker() {
  if (!studentPicker) return;

  const selectedCoaches = getSelectedCoaches();
  const typed = nameKey(titleInput.value);
  const chosen = nameKey(titleInput.value);

  // Rank by how often the selected coaches have taught each student, so the
  // people this coach actually works with come first.
  const coachCounts = selectedCoaches.length ? rosterForCoaches(selectedCoaches) : new Map();

  let roster = activeRoster();
  if (typed) roster = roster.filter(s => s.key.includes(typed) || typed.includes(s.key));

  roster.sort((a, b) => {
    const ca = coachCounts.get(a.key) || 0;
    const cb = coachCounts.get(b.key) || 0;
    if (ca !== cb) return cb - ca;
    if (a.lessons !== b.lessons) return b.lessons - a.lessons;
    return a.name.localeCompare(b.name);
  });

  studentPicker.innerHTML = "";

  if (roster.length === 0) {
    const empty = document.createElement("p");
    empty.className = "picker-empty";
    empty.textContent = studentCache.length || lessonCache.length
      ? "No match — this will be added as a new student."
      : "No students yet — the first name you type is saved automatically.";
    studentPicker.appendChild(empty);
    return;
  }

  roster.slice(0, 60).forEach(s => {
    const withCoach = coachCounts.get(s.key) || 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "student-chip";
    btn.classList.toggle("selected", s.key === chosen);
    if (withCoach > 0) btn.classList.add("familiar");
    btn.title = withCoach > 0
      ? `${withCoach} lesson${withCoach > 1 ? "s" : ""} with the selected coach`
      : `${s.lessons} lesson${s.lessons === 1 ? "" : "s"} in total`;
    btn.innerHTML = `<span class="student-chip-name"></span><span class="student-chip-count"></span>`;
    btn.querySelector(".student-chip-name").textContent = s.name;
    btn.querySelector(".student-chip-count").textContent = withCoach > 0 ? withCoach : s.lessons;
    btn.addEventListener("click", () => {
      titleInput.value = s.name;
      renderStudentPicker();
      updateConflictPreview();
    });
    studentPicker.appendChild(btn);
  });
}

/* =====================================================================
   Stats rendering
   ===================================================================== */

function monthLabel(d) {
  return d.toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}

function makeBar(count, max, color) {
  const bar = document.createElement("span");
  bar.className = "stat-bar";
  const fill = document.createElement("span");
  fill.className = "stat-bar-fill";
  fill.style.background = color;
  fill.style.width = `${max > 0 ? Math.max((count / max) * 100, 4) : 0}%`;
  bar.appendChild(fill);
  return bar;
}

function statRow(name, count, max, color, meta) {
  const row = document.createElement("div");
  row.className = "stat-row";
  row.innerHTML = `
    <span class="stat-name"></span>
    <span class="stat-count"></span>`;
  row.querySelector(".stat-name").textContent = name;
  row.querySelector(".stat-count").textContent = count;
  if (meta) {
    const m = document.createElement("span");
    m.className = "stat-meta";
    m.textContent = meta;
    row.querySelector(".stat-name").appendChild(m);
  }
  row.insertBefore(makeBar(count, max, color), row.querySelector(".stat-count"));
  return row;
}

function renderStatsCoachView(stats) {
  const coaches = Array.from(stats.byCoach.values()).sort((a, b) => b.total - a.total);
  if (coaches.length === 0) return [emptyState("No lessons taught this month.")];

  return coaches.map(c => {
    const color = coachColors[c.name] || fallbackColor;
    const card = document.createElement("section");
    card.className = "stat-card";
    card.style.setProperty("--card-color", color);

    const head = document.createElement("header");
    head.className = "stat-card-head";
    head.innerHTML = `
      <span class="stat-card-dot"></span>
      <span class="stat-card-title"></span>
      <span class="stat-card-total"><strong></strong> lessons</span>`;
    head.querySelector(".stat-card-title").textContent = c.name;
    head.querySelector(".stat-card-total strong").textContent = c.total;
    card.appendChild(head);

    const students = Array.from(c.students.values()).sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    const max = students.length ? students[0].count : 0;
    const list = document.createElement("div");
    list.className = "stat-list";
    students.forEach(s => list.appendChild(statRow(s.name, s.count, max, color)));
    card.appendChild(list);

    const foot = document.createElement("p");
    foot.className = "stat-card-foot";
    foot.textContent = `${students.length} student${students.length === 1 ? "" : "s"}`;
    card.appendChild(foot);

    return card;
  });
}

function renderStatsStudentView(stats) {
  const students = Array.from(stats.byStudent.values())
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
  if (students.length === 0) return [emptyState("No lessons booked this month.")];

  const archived = archivedKeys();

  return students.map(s => {
    const card = document.createElement("section");
    card.className = "stat-card";
    card.style.setProperty("--card-color", "var(--brand-500)");

    const head = document.createElement("header");
    head.className = "stat-card-head";
    head.innerHTML = `
      <span class="stat-card-title"></span>
      <span class="stat-card-total"><strong></strong> lessons</span>`;
    head.querySelector(".stat-card-title").textContent = s.name;
    head.querySelector(".stat-card-total strong").textContent = s.total;

    if (archived.has(s.key)) {
      const tag = document.createElement("span");
      tag.className = "stat-tag";
      tag.textContent = "deleted";
      tag.title = "Removed from the roster — their past lessons still count";
      head.querySelector(".stat-card-title").appendChild(tag);
    }
    card.appendChild(head);

    const coaches = Array.from(s.coaches.entries()).sort((a, b) => b[1] - a[1]);
    const max = coaches.length ? coaches[0][1] : 0;
    const list = document.createElement("div");
    list.className = "stat-list";
    coaches.forEach(([coach, count]) =>
      list.appendChild(statRow(coach, count, max, coachColors[coach] || fallbackColor)));
    card.appendChild(list);

    const types = Array.from(s.types.entries())
      .map(([t, n]) => `${n}× ${typeLabel[t] || t}`)
      .join(" · ");
    const foot = document.createElement("p");
    foot.className = "stat-card-foot";
    foot.textContent = types;
    card.appendChild(foot);

    return card;
  });
}

function renderRosterView() {
  const nodes = [];
  const active = activeRoster();
  const archived = studentCache.filter(s => s.archived);

  const note = document.createElement("p");
  note.className = "stats-note";
  note.textContent = "Students are added here by hand — booking a lesson never adds one. Deleting a student only removes them from the picker; every lesson they have already had stays in the monthly totals.";
  nodes.push(note);

  const addForm = document.createElement("form");
  addForm.className = "roster-add";
  addForm.innerHTML = `
    <input type="text" class="roster-add-input" placeholder="Add a student by name" autocomplete="off">
    <button type="submit" class="btn primary roster-add-btn">Add</button>`;
  const addInput = addForm.querySelector(".roster-add-input");

  addForm.addEventListener("submit", async e => {
    e.preventDefault();
    const name = addInput.value.trim();
    if (!name) return;
    try {
      const created = await addStudent(name);
      if (created) {
        toast(`${name} added to the roster`, "success");
        addInput.value = "";
        renderStats();
        renderStudentPicker();
      } else {
        toast(`${name} is already on the roster`, "warn");
      }
    } catch (err) {
      console.error(err);
      toast("Could not add the student", "error");
    }
  });
  nodes.push(addForm);

  if (active.length === 0) {
    nodes.push(emptyState("No students on the roster yet."));
  } else {
    // The roster grows to hundreds of names, so filter rows in place rather
    // than re-rendering — re-rendering would steal focus on every keystroke.
    const search = document.createElement("input");
    search.type = "search";
    search.className = "roster-search";
    search.placeholder = `Search ${active.length} students…`;
    search.autocomplete = "off";
    nodes.push(search);

    const list = document.createElement("div");
    list.className = "roster-list";

    search.addEventListener("input", () => {
      const q = nameKey(search.value);
      let shown = 0;
      list.querySelectorAll(".roster-row").forEach(row => {
        const hit = !q || row.dataset.key.includes(q);
        row.classList.toggle("hidden", !hit);
        if (hit) shown++;
      });
      list.classList.toggle("no-match", shown === 0);
    });

    active.forEach(s => {
      const row = document.createElement("div");
      row.className = "roster-row";
      row.dataset.key = s.key;
      row.innerHTML = `
        <span class="roster-name"></span>
        <span class="roster-meta"></span>
        <button type="button" class="roster-del icon-btn" aria-label="Delete student">&times;</button>`;
      row.querySelector(".roster-name").textContent = s.name;
      const coaches = Array.from(s.coaches);
      row.querySelector(".roster-meta").textContent =
        `${s.lessons} lesson${s.lessons === 1 ? "" : "s"}${coaches.length ? " · " + coaches.join(", ") : ""}`;
      row.querySelector(".roster-del").addEventListener("click", async () => {
        const ok = await confirmDialog(
          `Delete ${s.name}?`,
          "They will disappear from the student picker. Their lessons and every monthly total they appear in are kept.",
          "Delete student",
          "danger"
        );
        if (!ok) return;
        try {
          await archiveStudent(s);
          toast(`${s.name} removed from the roster`, "success");
          renderStats();
          renderStudentPicker();
        } catch (e) {
          console.error(e);
          toast("Could not delete the student", "error");
        }
      });
      list.appendChild(row);
    });
    nodes.push(list);
  }

  if (archived.length > 0) {
    const h = document.createElement("h3");
    h.className = "roster-heading";
    h.textContent = "Deleted";
    nodes.push(h);

    const list = document.createElement("div");
    list.className = "roster-list";
    archived.forEach(s => {
      const row = document.createElement("div");
      row.className = "roster-row archived";
      row.innerHTML = `
        <span class="roster-name"></span>
        <span class="roster-meta">still counted in past months</span>
        <button type="button" class="roster-restore">Restore</button>`;
      row.querySelector(".roster-name").textContent = s.name;
      row.querySelector(".roster-restore").addEventListener("click", async () => {
        try {
          await restoreStudent(s.id);
          toast(`${s.name} restored`, "success");
          renderStats();
          renderStudentPicker();
        } catch (e) {
          console.error(e);
          toast("Could not restore the student", "error");
        }
      });
      list.appendChild(row);
    });
    nodes.push(list);
  }

  return nodes;
}

function emptyState(text) {
  const p = document.createElement("p");
  p.className = "stats-empty";
  p.textContent = text;
  return p;
}

function renderStats() {
  const stats = computeMonthStats(statsMonth);

  statsMonthLabel.textContent = monthLabel(statsMonth);

  const coachCount = stats.byCoach.size;
  const studentCount = stats.byStudent.size;
  statsSummary.innerHTML = `
    <div class="stats-figure"><strong></strong><span>lessons</span></div>
    <div class="stats-figure"><strong></strong><span>students</span></div>
    <div class="stats-figure"><strong></strong><span>coaches</span></div>`;
  const figures = statsSummary.querySelectorAll(".stats-figure strong");
  figures[0].textContent = stats.total;
  figures[1].textContent = studentCount;
  figures[2].textContent = coachCount;

  statsTabs.querySelectorAll(".stats-tab").forEach(t =>
    t.classList.toggle("active", t.dataset.tab === statsTab));

  statsBody.innerHTML = "";
  let nodes;
  if (statsTab === "coach")        nodes = renderStatsCoachView(stats);
  else if (statsTab === "student") nodes = renderStatsStudentView(stats);
  else                             nodes = renderRosterView();
  nodes.forEach(n => statsBody.appendChild(n));

  if (statsTab !== "roster" && stats.total > 0) {
    const note = document.createElement("p");
    note.className = "stats-note";
    const doubles = stats.total - stats.sessions;
    note.textContent =
      `Counted as ${stats.total} from ${stats.sessions} booked session${stats.sessions === 1 ? "" : "s"}` +
      (doubles > 0 ? ` — a 90-minute double counts as two lessons.` : ".") +
      (statsTab === "coach" ? " A lesson taught by two coaches counts for each of them, so these can add up to more than the month's total." : "");
    statsBody.appendChild(note);
  }
}

function openStats() {
  statsModal.classList.remove("closing", "hidden");
  document.body.classList.add("modal-open");
  renderStats();
}

function closeStats() {
  if (statsModal.classList.contains("hidden")) return;
  statsModal.classList.add("closing");
  setTimeout(() => {
    statsModal.classList.add("hidden");
    statsModal.classList.remove("closing");
  }, 200);
  if (modal.classList.contains("hidden")) document.body.classList.remove("modal-open");
}

function readStartFromInputs() {
  if (!lessonDateInput.value || !lessonTimeInput.value) return null;
  const [y, mo, d] = lessonDateInput.value.split("-").map(Number);
  const [h, mi]    = lessonTimeInput.value.split(":").map(Number);
  const start = new Date(y, mo - 1, d, h, mi, 0, 0);
  return isValidDate(start) ? start : null;
}

/* =====================================================================
   Modal open / close / reset
   ===================================================================== */

function resetBulkEditToggle() {
  editingAllFuture = false;
  editAllFutureBtn.classList.remove("accent-active");
  editAllFutureBtn.textContent = "Edit all future";
}

function prepareAddModal(start) {
  selectedEvent = null;
  titleInput.value = "";
  lessonDateInput.value = formatDateInput(start);
  lessonTimeInput.value = formatTimeInput(start);
  setLessonType(LESSON_TYPES[0].value);
  setSelectedCoaches([]);
  repeatWeeklyToggle.checked = false;
  repeatEndDateInput.value = "";
  repeatEndDateLabel.classList.add("hidden");
  bulkEditOptions.classList.add("hidden");
  resetBulkEditToggle();
  modalTitle.textContent = "Add lesson";
  deleteBtn.classList.add("hidden");
  renderStudentPicker();
}

function openModal() {
  clearTimeout(modalCloseTimer);
  lastFocused = document.activeElement;
  modal.classList.remove("closing", "hidden");
  document.body.classList.add("modal-open");
  updateConflictPreview();
  requestAnimationFrame(() => titleInput.focus({ preventScroll: true }));
}

function closeModal() {
  if (modal.classList.contains("hidden")) return;
  modal.classList.add("closing");
  modalCloseTimer = setTimeout(() => {
    modal.classList.add("hidden");
    modal.classList.remove("closing");
  }, 200);

  document.body.classList.remove("modal-open");
  selectedEvent = null;
  resetBulkEditToggle();
  hideConflictNotice();
  if (lastFocused && typeof lastFocused.focus === "function") lastFocused.focus({ preventScroll: true });
}

/* =====================================================================
   Repeating-series helpers
   ===================================================================== */

/**
 * Turning "repeat weekly" off rewrites the master doc onto a single date, so
 * every occurrence before `untilISO` is written out as its own lesson first —
 * otherwise the whole history disappears. Reads the master's ORIGINAL start
 * from Firestore (the clicked occurrence is not the start of the series).
 */
async function materializePastRepeats(parentId, untilISO) {
  const masterSnap = await getDoc(doc(db, "lessons", parentId));
  if (!masterSnap.exists()) return;

  const m = masterSnap.data();
  const seriesStart = new Date(m.start);
  const seriesEnd   = new Date(m.end);
  if (!isValidDate(seriesStart) || !isValidDate(seriesEnd)) return;

  const durationMins = Math.max(1, Math.round((seriesEnd - seriesStart) / 60000));
  const until    = new Date(untilISO);
  const endLimit = m.repeatEndDate ? new Date(m.repeatEndDate) : null;
  if (!isValidDate(until)) return;

  for (let w = 0; w < 520; w++) { // hard cap: ~10 years of weekly lessons
    const occStart = addDays(seriesStart, w * 7);
    if (occStart >= until) break;
    if (endLimit && occStart > endLimit) break;

    const occISO = occStart.toISOString();
    if (cancelledSet.has(`${parentId}__${occISO}`)) continue; // was cancelled — don't resurrect it

    const existing = await getDocs(query(
      collection(db, "lessons"),
      where("parentId", "==", parentId),
      where("occStart", "==", occISO),
      limit(1)
    ));
    if (!existing.empty) continue;

    await addDoc(collection(db, "lessons"), {
      title: m.title,
      coach: m.coach,
      lessonType: m.lessonType || "class",
      start: occISO,
      end: addMinutes(occStart, durationMins).toISOString(),
      repeatWeekly: false,
      parentId,
      occStart: occISO
    });
  }
}

async function cancelSingleOccurrence(parentId, occStart) {
  await addDoc(collection(db, "repeat_exceptions"), { parentId, occStart, type: "cancel" });
}

async function deleteWholeSeries(parentId) {
  const children = await getDocs(query(collection(db, "lessons"), where("parentId", "==", parentId)));
  for (const c of children.docs) await deleteDoc(doc(db, "lessons", c.id));

  const exs = await getDocs(query(collection(db, "repeat_exceptions"), where("parentId", "==", parentId)));
  for (const ex of exs.docs) await deleteDoc(doc(db, "repeat_exceptions", ex.id));

  await deleteDoc(doc(db, "lessons", parentId));
}

/* =====================================================================
   Calendar
   ===================================================================== */

document.addEventListener("DOMContentLoaded", () => {

  initTheme();
  renderCoachChips();
  renderTypeSegments();
  renderFilterOptions();
  setLessonType(LESSON_TYPES[0].value);
  loadStudents().then(renderStudentPicker);

  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: "timeGridWeek",
    firstDay: 1,
    // Every lesson and every hall block is timed, so the all-day strip was
    // always empty — it just cost ~50px of grid on a phone.
    allDaySlot: false,
    selectable: true,
    selectMirror: true,
    nowIndicator: true,
    headerToolbar: { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek" },
    slotMinTime: `${GRID_START}:00`,
    slotMaxTime: `${GRID_END}:00`,
    slotDuration: phoneLayout() ? "00:30:00" : "00:15:00",
    slotLabelInterval: "01:00:00",
    displayEventEnd: !phoneLayout(),
    height: "auto",
    contentHeight: "auto",

    dayHeaderContent: arg => {
      // Full weekday names do not fit seven columns on a phone
      const style = window.innerWidth < 600 ? "short" : "long";
      const weekday = arg.date.toLocaleDateString("en-GB", { weekday: style });
      return `${weekday} ${formatOrdinal(arg.date.getDate())}`;
    },

    select: info => {
      if (window.innerWidth > 500) {
        prepareAddModal(info.start);
        openModal();
      }
      calendar.unselect();
    },

    eventDidMount: info => {
      if (info.event.extendedProps.isHall) return;
      applyEventColors(info);

      // Long-press to delete on touch devices
      let touchTimer = null;
      const clear = () => clearTimeout(touchTimer);

      info.el.addEventListener("touchstart", () => {
        touchTimer = setTimeout(async () => {
          // Stop the click that fires on touchend from re-opening the modal
          suppressClickUntil = Date.now() + 1500;
          const props = info.event.extendedProps;

          if (props.repeatWeekly && props.docId && props.occStart) {
            const ok = await confirmDialog(
              "Cancel this week only?",
              `"${props.baseTitle || info.event.title}" will be removed from this week. Every other week stays.`,
              "Cancel this week",
              "danger"
            );
            if (!ok) return;
            try {
              await cancelSingleOccurrence(props.docId, props.occStart);
              info.event.remove();
              toast("Cancelled for this week only", "success");
            } catch (e) {
              console.error(e);
              toast("Could not cancel the lesson", "error");
            }
            return;
          }

          const ok = await confirmDialog(
            "Delete lesson?",
            `"${props.baseTitle || info.event.title}" will be deleted permanently.`,
            "Delete",
            "danger"
          );
          if (!ok) return;
          try {
            if (props.docId) await deleteDoc(doc(db, "lessons", props.docId));
            info.event.remove();
            toast("Lesson deleted", "success");
          } catch (e) {
            console.error(e);
            toast("Could not delete the lesson", "error");
          }
        }, 600);
      }, { passive: true });

      info.el.addEventListener("touchend", clear);
      info.el.addEventListener("touchmove", clear);
      info.el.addEventListener("touchcancel", clear);
    },

    eventClick: info => {
      if (Date.now() < suppressClickUntil) return; // long-press already handled it

      selectedEvent = info.event;
      const props = info.event.extendedProps;

      titleInput.value      = props.baseTitle || info.event.title;
      lessonDateInput.value = formatDateInput(info.event.start);
      lessonTimeInput.value = formatTimeInput(info.event.start);
      setLessonType(props.lessonType || "class");
      setSelectedCoaches(props.coach);

      repeatWeeklyToggle.checked = !!props.repeatWeekly;
      repeatEndDateInput.value = props.repeatEndDate
        ? formatDateInput(new Date(props.repeatEndDate))
        : "";
      repeatEndDateLabel.classList.toggle("hidden", !props.repeatWeekly);
      bulkEditOptions.classList.toggle("hidden", !props.repeatWeekly);

      resetBulkEditToggle();
      modalTitle.textContent = "Edit lesson";
      deleteBtn.classList.remove("hidden");
      renderStudentPicker();
      openModal();
    }
  });

  calendar.addEventSource(async (fetchInfo, successCallback, failureCallback) => {
    try {
      // Cancelled occurrences (small dataset, fine to load in full)
      const exSnap = await getDocs(collection(db, "repeat_exceptions"));
      const cancelled = new Set();
      exSnap.forEach(ex => {
        const x = ex.data();
        if (x.type === "cancel") cancelled.add(`${x.parentId}__${x.occStart}`);
      });
      cancelledSet = cancelled;

      const snapshot = await getDocs(collection(db, "lessons"));

      const cache = [];
      snapshot.forEach(docSnap => {
        const d = docSnap.data();
        const baseStart = new Date(d.start);
        const baseEnd   = new Date(d.end);

        if (!isValidDate(baseStart) || !isValidDate(baseEnd)) {
          console.warn(`Skipping lesson ${docSnap.id}: invalid start/end`, d.start, d.end);
          return;
        }

        cache.push({
          id: docSnap.id,
          title: d.title || "Untitled lesson",
          coach: Array.isArray(d.coach) ? d.coach : d.coach ? [d.coach] : [],
          lessonType: d.lessonType || "class",
          repeatWeekly: !!d.repeatWeekly,
          repeatEndDate: d.repeatEndDate || null,
          start: d.start,
          durationMins: Math.max(1, Math.round((baseEnd - baseStart) / 60000))
        });
      });
      lessonCache = cache;

      const coachFilterValue = coachFilter.value;
      const typeFilterValue  = typeFilter.value;

      // Filters affect what is drawn, never what goes into the cache —
      // a hidden lesson must still count as a conflict and in the stats.
      const events = occurrencesInRange(fetchInfo.start, fetchInfo.end)
        .filter(({ lesson }) =>
          (!coachFilterValue || lesson.coach.includes(coachFilterValue)) &&
          (!typeFilterValue  || lesson.lessonType === typeFilterValue))
        .map(({ lesson, start, end }) => {
          const color = getEventColor(lesson.coach, lesson.lessonType);
          const occISO = start.toISOString();
          return {
            // On a phone the block colour already identifies the coach, and the
            // suffix would push the student's name out of a 50px column.
            title: lesson.coach.length && !phoneLayout()
              ? `${lesson.title} (${lesson.coach.join(", ")})`
              : lesson.title,
            start: occISO,
            end: end.toISOString(),
            backgroundColor: color,
            borderColor: color,
            extendedProps: {
              docId: lesson.id,
              baseTitle: lesson.title,   // avoids re-parsing the title out of the label
              coach: lesson.coach,
              lessonType: lesson.lessonType,
              repeatWeekly: lesson.repeatWeekly,
              occStart: occISO,
              repeatEndDate: lesson.repeatEndDate
            }
          };
        });

      renderStudentPicker();
      successCallback(events);
    } catch (e) {
      console.error(e);
      toast("Could not load lessons", "error");
      failureCallback(e);
    }
  });

  calendar.render();
  renderCoachLegend();
  renderHallAvailability();

  calendar.on("datesSet", () => {
    renderHallAvailability();
    calendar.refetchEvents();
  });

  // Keep the slot density in step when rotating or resizing across the breakpoint
  let lastPhone = phoneLayout();
  window.addEventListener("resize", () => {
    const now = phoneLayout();
    if (now === lastPhone) return;
    lastPhone = now;
    calendar.setOption("slotDuration", now ? "00:30:00" : "00:15:00");
    calendar.setOption("displayEventEnd", !now);
    calendar.refetchEvents(); // titles carry the coach only on wide screens
  });

  /* ===== Modal wiring ===== */

  addLessonBtn.onclick = () => {
    const now = new Date();
    now.setHours(9, 0, 0, 0);
    prepareAddModal(now);
    openModal();
  };

  cancelBtn.onclick     = closeModal;
  closeModalBtn.onclick = closeModal;
  modalBackdrop.addEventListener("click", closeModal);

  document.addEventListener("keydown", e => {
    if (e.key !== "Escape") return;
    // A confirm dialog on top owns Escape first — otherwise backing out of
    // "Save anyway?" would dismiss the whole lesson form too.
    if (dialogHost.children.length > 0) return;
    if (!modal.classList.contains("hidden")) { closeModal(); return; }
    if (!statsModal.classList.contains("hidden")) closeStats();
  });

  repeatWeeklyToggle.onchange = () => {
    repeatEndDateLabel.classList.toggle("hidden", !repeatWeeklyToggle.checked);
  };

  editAllFutureBtn.onclick = () => {
    editingAllFuture = !editingAllFuture;
    editAllFutureBtn.classList.toggle("accent-active", editingAllFuture);
    editAllFutureBtn.textContent = editingAllFuture ? "✓ Editing all future" : "Edit all future";
  };

  [lessonDateInput, lessonTimeInput].forEach(el => el.addEventListener("change", updateConflictPreview));

  // Typing filters the picker, so an existing student is one tap away
  titleInput.addEventListener("input", renderStudentPicker);

  /* ===== Stats panel ===== */

  statsBtn.onclick = () => {
    statsMonth = calendar ? new Date(calendar.getDate()) : new Date();
    statsTab = "coach";
    openStats();
  };

  closeStatsBtn.onclick = closeStats;
  statsBackdrop.addEventListener("click", closeStats);

  statsPrevBtn.onclick = () => {
    statsMonth = new Date(statsMonth.getFullYear(), statsMonth.getMonth() - 1, 1);
    renderStats();
  };

  statsNextBtn.onclick = () => {
    statsMonth = new Date(statsMonth.getFullYear(), statsMonth.getMonth() + 1, 1);
    renderStats();
  };

  statsTabs.addEventListener("click", e => {
    const tab = e.target.closest(".stats-tab");
    if (!tab) return;
    statsTab = tab.dataset.tab;
    renderStats();
  });

  coachFilter.onchange = () => { syncLegendActive(); calendar.refetchEvents(); };
  typeFilter.onchange  = () => calendar.refetchEvents();

  // Ripple origin for button presses
  document.addEventListener("pointerdown", e => {
    const btn = e.target.closest(".btn");
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    btn.style.setProperty("--rx", `${((e.clientX - r.left) / r.width) * 100}%`);
    btn.style.setProperty("--ry", `${((e.clientY - r.top) / r.height) * 100}%`);
  });

  /* ===== Delete ===== */

  deleteBtn.onclick = async () => {
    if (!selectedEvent) return;

    const props    = selectedEvent.extendedProps;
    const parentId = props.docId;
    const occStart = props.occStart;
    const label    = props.baseTitle || selectedEvent.title;

    if (props.repeatWeekly && parentId && occStart) {
      const choice = await openDialog({
        title: "Delete repeating lesson",
        message: `"${label}" repeats every week. What should happen?`,
        actions: [
          { label: "Cancel just this week", value: "one",    tone: "primary" },
          { label: "Delete the whole series", value: "all",  tone: "danger" },
          { label: "Keep it",                 value: null,   tone: "ghost" }
        ]
      });

      if (choice === "all") {
        const sure = await confirmDialog(
          "Delete every occurrence?",
          "This permanently removes the lesson from every week, past and future. It cannot be undone.",
          "Delete everything",
          "danger"
        );
        if (!sure) return;
        try {
          await deleteWholeSeries(parentId);
          closeModal();
          calendar.refetchEvents();
          toast("Series deleted", "success");
        } catch (e) {
          console.error(e);
          toast("Could not delete the series", "error");
        }
        return;
      }

      if (choice === "one") {
        try {
          await cancelSingleOccurrence(parentId, occStart);
          closeModal();
          calendar.refetchEvents();
          toast("Cancelled for this week only", "success");
        } catch (e) {
          console.error(e);
          toast("Could not cancel the lesson", "error");
        }
      }
      return;
    }

    const ok = await confirmDialog(
      "Delete lesson?",
      `"${label}" will be deleted permanently.`,
      "Delete",
      "danger"
    );
    if (!ok) return;

    try {
      if (parentId) await deleteDoc(doc(db, "lessons", parentId));
      closeModal();
      calendar.refetchEvents();
      toast("Lesson deleted", "success");
    } catch (e) {
      console.error(e);
      toast("Could not delete the lesson", "error");
    }
  };

  /* ===== Save ===== */

  saveBtn.onclick = async () => {
    if (saving) return;

    const title  = titleInput.value.trim();
    const coach  = getSelectedCoaches();
    const lessonType = getLessonType();
    const repeatWeekly = repeatWeeklyToggle.checked;
    const repeatEndDate = repeatWeekly && repeatEndDateInput.value
      ? endOfDayLocal(repeatEndDateInput.value)
      : null;

    if (!title)         { toast("Enter a lesson name", "warn"); titleInput.focus(); return; }
    if (!coach.length)  { toast("Pick at least one coach", "warn"); return; }

    // Always read the inputs — previously a drag-selected slot overrode
    // whatever the user typed into the date/time fields.
    const start = readStartFromInputs();
    if (!start) { toast("Pick a date and a start time", "warn"); return; }

    if (repeatEndDate && repeatEndDate < start) {
      toast("The repeat end date is before the lesson", "warn");
      return;
    }

    const end = addMinutes(start, typeDuration[lessonType] ?? 45);

    // Hard policy: never store a lesson the grid cannot show. Not a warning,
    // and not something "Save anyway" can get past.
    const grid = checkWithinGrid(start, end);
    if (!grid.ok) {
      showConflictNotice([], { available: true, status: null }, grid);
      setSaveBlocked(true);
      toast(grid.reason, "warn");
      return;
    }

    // Warn about clashes, but let the boss decide.
    const conflicts = findConflicts(
      start, end,
      selectedEvent ? selectedEvent.extendedProps.docId : null,
      selectedEvent ? selectedEvent.extendedProps.occStart : null
    );
    const hall = checkHallAvailability(start, end);
    showConflictNotice(conflicts, hall);

    if (conflicts.length > 0 || !hall.available) {
      const reasons = [];
      if (!hall.available) reasons.push("Both halls are booked at this time.");
      if (conflicts.length) reasons.push(`It overlaps ${conflicts.length} other lesson${conflicts.length > 1 ? "s" : ""}.`);
      const proceed = await confirmDialog(
        "Save anyway?",
        `${reasons.join("\n")}\n\nYou can still book it if that's intentional.`,
        "Save anyway",
        "primary"
      );
      if (!proceed) return;
    }

    saving = true;
    saveBtn.classList.add("loading");
    saveBtn.disabled = true;

    try {
      if (selectedEvent) {
        await saveExisting({ title, coach, lessonType, repeatWeekly, repeatEndDate, start, end });
      } else {
        const newData = {
          title, coach, lessonType, repeatWeekly,
          start: start.toISOString(),
          end: end.toISOString(),
          occStart: start.toISOString()
        };
        if (repeatEndDate) newData.repeatEndDate = repeatEndDate.toISOString();

        await addDoc(collection(db, "lessons"), newData);
        toast(`${typeLabel[lessonType]} added`, "success");
        closeModal();
      }

      // Deliberately does NOT touch the students collection — the roster is
      // built by hand from the Students tab, never as a side effect of saving.
      calendar.refetchEvents();
    } catch (e) {
      console.error(e);
      toast("Could not save the lesson", "error");
    } finally {
      saving = false;
      saveBtn.classList.remove("loading");
      saveBtn.disabled = saveBlocked;
    }
  };

  async function saveExisting({ title, coach, lessonType, repeatWeekly, repeatEndDate, start, end }) {
    const props       = selectedEvent.extendedProps;
    const lessonId    = props.docId;
    const wasRepeating = !!props.repeatWeekly;
    const occStartISO = props.occStart;

    const baseData = {
      title, coach, lessonType, repeatWeekly,
      start: start.toISOString(),
      end: end.toISOString(),
      occStart: start.toISOString()
    };

    // deleteField() clears a previously set end date; only valid in updateDoc
    const updatePayload = {
      ...baseData,
      repeatEndDate: repeatEndDate ? repeatEndDate.toISOString() : deleteField()
    };

    let successMsg = "Lesson updated";

    if (!wasRepeating) {
      await updateDoc(doc(db, "lessons", lessonId), updatePayload);

    } else if (!repeatWeekly) {
      // Repeating -> one-off: keep the weeks already taught as standalone lessons
      await materializePastRepeats(lessonId, occStartISO);
      await updateDoc(doc(db, "lessons", lessonId), updatePayload);
      successMsg = "Lesson no longer repeats — past weeks kept";

    } else if (editingAllFuture) {
      // Split the series: the old one stops before this occurrence and a new
      // series carries on from the edited date/time.
      const masterSnap  = await getDoc(doc(db, "lessons", lessonId));
      const masterStart = masterSnap.exists() ? new Date(masterSnap.data().start) : null;
      const occDate     = new Date(occStartISO);

      if (!masterStart || !isValidDate(masterStart) || occDate.getTime() <= masterStart.getTime()) {
        // Editing from the very first occurrence — just update the series
        await updateDoc(doc(db, "lessons", lessonId), updatePayload);
      } else {
        await updateDoc(doc(db, "lessons", lessonId), {
          repeatEndDate: new Date(occDate.getTime() - 60000).toISOString()
        });
        const newMaster = { ...baseData, parentId: lessonId };
        if (repeatEndDate) newMaster.repeatEndDate = repeatEndDate.toISOString();
        await addDoc(collection(db, "lessons"), newMaster);
      }
      successMsg = "This and all future lessons updated";

    } else {
      // One occurrence only: cancel it in the series, add a standalone replacement
      await cancelSingleOccurrence(lessonId, occStartISO);
      await addDoc(collection(db, "lessons"), {
        title, coach, lessonType,
        repeatWeekly: false,
        start: start.toISOString(),
        end: end.toISOString(),
        parentId: lessonId,
        occStart: start.toISOString()
      });
      successMsg = "This week's lesson updated";
    }

    toast(successMsg, "success");
    closeModal();
  }
});
