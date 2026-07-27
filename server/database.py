"""SQLite persistence for Netflix Connect - watchlist, stats, and sessions."""

import sqlite3
from contextlib import contextmanager
from datetime import datetime, timezone
from typing import Any

from config import settings


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(str(settings.db_path), check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


@contextmanager
def get_db():
    conn = _connect()
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def _today() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def init_database() -> None:
    with get_db() as conn:
        cur = conn.cursor()
        cur.execute("""
            CREATE TABLE IF NOT EXISTS watchlist (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                netflix_id TEXT NOT NULL UNIQUE,
                title TEXT NOT NULL,
                image_url TEXT,
                content_type TEXT DEFAULT 'unknown',
                added_by TEXT NOT NULL,
                added_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                notes TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS watch_stats (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                date TEXT NOT NULL UNIQUE,
                total_watch_time_s REAL DEFAULT 0,
                session_count INTEGER DEFAULT 0,
                titles_watched INTEGER DEFAULT 0,
                episodes_watched INTEGER DEFAULT 0,
                most_watched_id TEXT,
                most_watched_title TEXT
            )
        """)
        cur.execute("""
            CREATE TABLE IF NOT EXISTS watch_sessions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                session_id TEXT NOT NULL UNIQUE,
                netflix_id TEXT,
                title TEXT,
                started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                ended_at TIMESTAMP,
                duration_s REAL DEFAULT 0,
                parker_joined BOOLEAN DEFAULT FALSE,
                emily_joined BOOLEAN DEFAULT FALSE
            )
        """)
        cur.execute("CREATE INDEX IF NOT EXISTS idx_watchlist_added ON watchlist(added_at DESC)")
        cur.execute("CREATE INDEX IF NOT EXISTS idx_sessions_started ON watch_sessions(started_at DESC)")


# ---------------------------------------------------------------------------
# Watchlist
# ---------------------------------------------------------------------------

def add_to_watchlist(
    netflix_id: str,
    title: str,
    added_by: str,
    image_url: str | None = None,
    content_type: str = "unknown",
    notes: str | None = None,
) -> dict[str, Any]:
    with get_db() as conn:
        try:
            conn.execute(
                """INSERT INTO watchlist (netflix_id, title, image_url, content_type, added_by, notes)
                   VALUES (?, ?, ?, ?, ?, ?)""",
                (netflix_id, title, image_url, content_type, added_by, notes),
            )
            return {"status": "added", "netflix_id": netflix_id, "title": title, "added_by": added_by}
        except sqlite3.IntegrityError:
            return {"status": "exists", "netflix_id": netflix_id, "title": title}


def remove_from_watchlist(netflix_id: str) -> dict[str, Any]:
    with get_db() as conn:
        cur = conn.execute("DELETE FROM watchlist WHERE netflix_id = ?", (netflix_id,))
        if cur.rowcount > 0:
            return {"status": "removed", "netflix_id": netflix_id}
        return {"status": "not_found", "netflix_id": netflix_id}


def get_watchlist(limit: int = 50) -> list[dict[str, Any]]:
    with get_db() as conn:
        rows = conn.execute(
            """SELECT netflix_id, title, image_url, content_type, added_by, added_at, notes
               FROM watchlist ORDER BY added_at DESC LIMIT ?""",
            (limit,),
        ).fetchall()
        return [dict(row) for row in rows]


def is_in_watchlist(netflix_id: str) -> bool:
    with get_db() as conn:
        row = conn.execute("SELECT 1 FROM watchlist WHERE netflix_id = ?", (netflix_id,)).fetchone()
        return row is not None


# ---------------------------------------------------------------------------
# Watch stats
# ---------------------------------------------------------------------------

def update_watch_stats(
    watch_time_s: float,
    netflix_id: str | None = None,
    title: str | None = None,
    is_episode: bool = False,
) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute(
            """INSERT INTO watch_stats (date, total_watch_time_s, titles_watched, episodes_watched)
               VALUES (?, ?, ?, ?)
               ON CONFLICT(date) DO UPDATE SET
                   total_watch_time_s = total_watch_time_s + excluded.total_watch_time_s,
                   titles_watched = titles_watched + excluded.titles_watched,
                   episodes_watched = episodes_watched + excluded.episodes_watched""",
            (_today(), watch_time_s, 1 if netflix_id else 0, 1 if is_episode else 0),
        )
        return {"status": "updated", "date": _today()}


def get_watch_stats(days: int = 30) -> dict[str, Any]:
    with get_db() as conn:
        window = f"-{int(days)} days"
        daily = [
            dict(row)
            for row in conn.execute(
                """SELECT date, total_watch_time_s, session_count, titles_watched, episodes_watched
                   FROM watch_stats WHERE date >= date('now', ?) ORDER BY date DESC""",
                (window,),
            ).fetchall()
        ]
        totals = dict(
            conn.execute(
                """SELECT SUM(total_watch_time_s) AS total_time,
                          SUM(session_count) AS total_sessions,
                          SUM(titles_watched) AS total_titles,
                          SUM(episodes_watched) AS total_episodes
                   FROM watch_stats WHERE date >= date('now', ?)""",
                (window,),
            ).fetchone()
        )
        all_time = dict(
            conn.execute(
                """SELECT SUM(total_watch_time_s) AS all_time_watch_s,
                          COUNT(DISTINCT date) AS days_watched
                   FROM watch_stats"""
            ).fetchone()
        )

    return {
        "period_days": days,
        "daily": daily,
        "totals": {
            "watch_time_s": totals["total_time"] or 0,
            "watch_time_hours": round((totals["total_time"] or 0) / 3600, 1),
            "sessions": totals["total_sessions"] or 0,
            "titles": totals["total_titles"] or 0,
            "episodes": totals["total_episodes"] or 0,
        },
        "all_time": {
            "watch_time_s": all_time["all_time_watch_s"] or 0,
            "watch_time_hours": round((all_time["all_time_watch_s"] or 0) / 3600, 1),
            "days_watched": all_time["days_watched"] or 0,
        },
    }


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------

def start_session(session_id: str, netflix_id: str | None = None, title: str | None = None) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute(
            "INSERT OR REPLACE INTO watch_sessions (session_id, netflix_id, title) VALUES (?, ?, ?)",
            (session_id, netflix_id, title),
        )
        conn.execute(
            """INSERT INTO watch_stats (date, session_count) VALUES (?, 1)
               ON CONFLICT(date) DO UPDATE SET session_count = session_count + 1""",
            (_today(),),
        )
        return {"status": "started", "session_id": session_id}


def end_session(session_id: str, duration_s: float) -> dict[str, Any]:
    with get_db() as conn:
        conn.execute(
            "UPDATE watch_sessions SET ended_at = CURRENT_TIMESTAMP, duration_s = ? WHERE session_id = ?",
            (duration_s, session_id),
        )
        conn.execute(
            """INSERT INTO watch_stats (date, total_watch_time_s) VALUES (?, ?)
               ON CONFLICT(date) DO UPDATE SET total_watch_time_s = total_watch_time_s + ?""",
            (_today(), duration_s, duration_s),
        )
        return {"status": "ended", "session_id": session_id, "duration_s": duration_s}


_JOIN_COLUMNS = {"Parker": "parker_joined", "Emily": "emily_joined"}


def join_session(session_id: str, user: str) -> dict[str, Any]:
    column = _JOIN_COLUMNS.get(user)
    if column is None:
        return {"status": "error", "message": f"unknown user {user!r}"}
    with get_db() as conn:
        # Column name comes from the fixed mapping above, never from input.
        conn.execute(f"UPDATE watch_sessions SET {column} = TRUE WHERE session_id = ?", (session_id,))
        return {"status": "joined", "session_id": session_id, "user": user}


init_database()
