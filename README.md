# bstpl sim info (MySQL version): login + frontend + backend + database on localhost

Browser (`frontend/index.html`, `style.css`, `script.js`)  →  FastAPI backend (`backend/app.py`, `auth.py`, `db.py`)  →  your MySQL server.
No data lives in the website files: every screen is a live query to MySQL.

## Project Structure
```text
sim provider/
├── frontend/ (or fronted/)
│   ├── index.html       # UI layout
│   ├── style.css        # Main stylesheet & themes
│   ├── script.js        # Frontend interactions & API calls
│   ├── ux3d.css         # 3D UX enhancements
│   └── ux3d.js          # Tab shortcuts & animated counters
├── backend/
│   ├── app.py           # FastAPI routes & static file server
│   ├── auth.py          # Authentication, sessions, & history
│   ├── config.py        # Settings (port, MySQL credentials)
│   ├── db.py            # MySQL schema & provider table operations
│   ├── xlsxout.py       # Excel export generation
│   └── requirements.txt # Python dependencies
└── README.md
```

## Run
```bash
# 1. Install dependencies
pip install -r backend/requirements.txt

# 2. Check credentials in backend/config.py (MySQL user/password)
# 3. Start the backend server
cd backend
python app.py
# (or from the project root: python backend/app.py)
# Open http://localhost:8000 in your browser  (API docs: http://localhost:8000/docs)
```

## Sign in
The first time the app starts it creates a separate schema called `vi_tracker_auth` (hidden from the Database drop-down, never shown as a provider) and a built-in login:

| Employee ID | Password |
|---|---|
| `1234` | `1234567890` |

A banner reminds you to change it. Use the round avatar (top right) → **Change password** at any time. Passwords are stored only as salted PBKDF2 hashes. 5 wrong passwords in a row lock that ID for 10 minutes. A sign-in lasts 12 hours (`SESSION_HOURS` in `config.py`).

## What it does
| | |
|---|---|
| **Providers** | Each table = one provider. Buttons at the top: **🌐 All providers** (every table at once) and one button per provider. |
| **Fetch data** | In *All providers*, rows from every table are combined (a `PROVIDER` column tells you where each row came from; columns a provider doesn't have stay empty). Search all columns, date range, filter column + value (pick `PROVIDER` to filter by name), sort by clicking a heading, totals for qty / amount columns, Download Excel. |
| **Add entry** | Pick one provider, then the form is built from its columns. Save = one `INSERT`. |
| **Team** | Only signed-in employees can add a member (employee ID, name, temporary password) or remove one. Nobody is added by hand in MySQL. |
| **Login history** | Every sign-in (including failed ones), sign-out, password change and member added / removed, with time, IP address and device. Filterable. |
| **Themes** | The 🎨 button (bottom right, also on the sign-in page) switches between Daylight, Midnight, Ocean, Forest, Sunset, Rose and Graphite. Saved per browser. |
| **➕ New table** | Create a provider table from the website. |

## Files
`app.py` routes · `auth.py` login, sessions, team, history · `db.py` all provider MySQL code · `config.py` settings · `xlsxout.py` Excel download · `index.html`, `style.css`, `script.js` the website.
Put them all in one folder (or the three website files in a `frontend/` folder next to `app.py`).
