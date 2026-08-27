# Dance Lessons Calendar

A lightweight, zero-build scheduling calendar for a dance studio. Coaches and lessons are booked into a weekly timetable that is aware of which of the studio's two halls is free at any given time, so double-bookings are refused before they happen. Data is stored in Firebase Firestore, so the calendar stays in sync across everyone who opens it.

## Features

- **Weekly timetable** built on [FullCalendar v6](https://fullcalendar.io/) (09:00–22:00 grid).
- **Coaches**, colour-coded in a live legend — Vlad, Ana, Petar Boss, Milan.
- **Lesson types** with fixed durations — Class (45 min), Double (90 min), Group (60 min).
- **Hall awareness** — a built-in schedule tracks when only the big hall, only the small hall, or neither is free, and bookings that fall outside the drawable hours are rejected outright.
- **Recurring lessons** — repeat a lesson weekly up to a chosen end date.
- **Filters** — narrow the view by coach or by lesson type.
- **Stats** — quick overview of lessons via the Stats button.
- **Dark / light theme** — remembered in `localStorage` and resolved before first paint to avoid a flash of the wrong theme.
- **Add / edit / delete** lessons through a modal dialog.

## Tech stack

| Layer     | Technology                                  |
| --------- | ------------------------------------------- |
| UI        | Vanilla HTML, CSS, JavaScript (ES modules)  |
| Calendar  | FullCalendar v6 (bundled from CDN)          |
| Data      | Firebase Firestore (v12.8.0)                |
| Hosting   | Any static host (no build step required)    |

## Project structure

```
index.html     # markup, toolbar, modal, theme bootstrap
style.css      # styling and theme variables
app.js         # calendar logic, booking rules, Firestore reads/writes
firebase.js    # Firebase app + Firestore initialisation
```

## Running locally

Because everything is static and uses ES modules, serve the folder over HTTP (opening `index.html` directly via `file://` will block the module imports):

```bash
# from the project root
python -m http.server 8000
# then visit http://localhost:8000
```

## Configuration

Firebase settings live in `firebase.js`. A Firebase **web** config is client-side by design; what actually protects your data are your **Firestore security rules**. Make sure those rules are configured before using this in production so that only permitted reads/writes are allowed.

To point the calendar at your own Firebase project, replace the config object in `firebase.js` with the one from your Firebase console and create a Firestore database.

## Customising coaches and lesson types

Coaches, colours, and lesson types are defined once at the top of `app.js`:

```js
const COACHES = [
  { name: "Vlad", color: "#3b82f6" },
  // ...
];

const LESSON_TYPES = [
  { value: "class", label: "Class", mins: 45 },
  // ...
];
```

The legend, filters, chips, and colours are all generated from these arrays, so adding or removing a coach or lesson type is a one-line change.
