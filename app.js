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

/* ===== State ===== */
let calendar;
let selectedEvent   = null;
let editingAllFuture = false;
let saving          = false;
let modalCloseTimer = null;
let lastFocused     = null;
let suppressClickUntil = 0;

// Snapshot of every lesson doc from the last fetch. Conflict detection reads
// this instead of calendar.getEvents(), so lessons outside the rendered weeks
// are still taken into account.
let lessonCache = [];
let cancelledSet = new Set();

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

function describeOccurrence(date) {
  return date.toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit"
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

function showConflictNotice(conflicts, hall) {
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
  if (!start) { hideConflictNotice(); return; }

  const end = addMinutes(start, typeDuration[getLessonType()] ?? 45);
  const conflicts = findConflicts(
    start, end,
    selectedEvent ? selectedEvent.extendedProps.docId : null,
    selectedEvent ? selectedEvent.extendedProps.occStart : null
  );
  showConflictNotice(conflicts, checkHallAvailability(start, end));
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

  renderCoachChips();
  renderTypeSegments();
  renderFilterOptions();
  setLessonType(LESSON_TYPES[0].value);

  calendar = new FullCalendar.Calendar(calendarEl, {
    initialView: "timeGridWeek",
    firstDay: 1,
    selectable: true,
    selectMirror: true,
    nowIndicator: true,
    headerToolbar: { left: "prev,next today", center: "title", right: "timeGridDay,timeGridWeek" },
    slotMinTime: "09:00:00",
    slotMaxTime: "22:00:00",
    slotDuration: "00:15:00",
    slotLabelInterval: "01:00:00",
    height: "auto",
    contentHeight: "auto",

    dayHeaderContent: arg => {
      const weekday = arg.date.toLocaleDateString("en-GB", { weekday: "long" });
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
      const rangeStart = fetchInfo.start;
      const rangeEnd   = fetchInfo.end;
      const viewWeekStart = weekStartMonday(rangeStart);

      const coachFilterValue = coachFilter.value;
      const typeFilterValue  = typeFilter.value;

      const cache  = [];
      const events = [];

      const pushEvent = (rec, startDate) => {
        const occISO = startDate.toISOString();
        if (cancelled.has(`${rec.id}__${occISO}`)) return;

        const endDate = addMinutes(startDate, rec.durationMins);
        if (endDate <= rangeStart || startDate >= rangeEnd) return;

        // Filters affect what is drawn, never what goes into the cache —
        // a hidden lesson must still count as a conflict.
        if (coachFilterValue && !rec.coach.includes(coachFilterValue)) return;
        if (typeFilterValue && rec.lessonType !== typeFilterValue) return;

        const color = getEventColor(rec.coach, rec.lessonType);

        events.push({
          title: rec.coach.length ? `${rec.title} (${rec.coach.join(", ")})` : rec.title,
          start: occISO,
          end: endDate.toISOString(),
          backgroundColor: color,
          borderColor: color,
          extendedProps: {
            docId: rec.id,
            baseTitle: rec.title,        // avoids re-parsing the title out of the label
            coach: rec.coach,
            lessonType: rec.lessonType,
            repeatWeekly: rec.repeatWeekly,
            occStart: occISO,
            repeatEndDate: rec.repeatEndDate
          }
        });
      };

      snapshot.forEach(docSnap => {
        const d = docSnap.data();
        const baseStart = new Date(d.start);
        const baseEnd   = new Date(d.end);

        if (!isValidDate(baseStart) || !isValidDate(baseEnd)) {
          console.warn(`Skipping lesson ${docSnap.id}: invalid start/end`, d.start, d.end);
          return;
        }

        const rec = {
          id: docSnap.id,
          title: d.title || "Untitled lesson",
          coach: Array.isArray(d.coach) ? d.coach : d.coach ? [d.coach] : [],
          lessonType: d.lessonType || "class",
          repeatWeekly: !!d.repeatWeekly,
          repeatEndDate: d.repeatEndDate || null,
          start: d.start,
          durationMins: Math.max(1, Math.round((baseEnd - baseStart) / 60000))
        };
        cache.push(rec);

        if (!rec.repeatWeekly) {
          pushEvent(rec, baseStart);
          return;
        }

        const baseWeekStart = weekStartMonday(baseStart);
        const startOffset = Math.max(Math.round((viewWeekStart - baseWeekStart) / WEEK_MS), 0);
        const endLimit = rec.repeatEndDate ? new Date(rec.repeatEndDate) : null;

        // Bounded loop — a bad date can never spin forever
        for (let i = 0; i < 60; i++) {
          const occStart = addDays(baseStart, (startOffset + i) * 7);
          if (endLimit && occStart > endLimit) break;
          if (occStart >= rangeEnd) break;
          pushEvent(rec, occStart);
        }
      });

      lessonCache = cache;
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
    if (!modal.classList.contains("hidden")) closeModal();
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
      calendar.refetchEvents();
    } catch (e) {
      console.error(e);
      toast("Could not save the lesson", "error");
    } finally {
      saving = false;
      saveBtn.classList.remove("loading");
      saveBtn.disabled = false;
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
