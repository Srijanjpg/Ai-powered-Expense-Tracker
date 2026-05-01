import sqlite3
import psycopg

SQLITE_PATH = "expense_tracker.db"
PG_DSN = "postgresql://expense_user@localhost:5432/expense_tracker"

sqlite_conn = sqlite3.connect(SQLITE_PATH)
sqlite_cur = sqlite_conn.cursor()

pg_conn = psycopg.connect(PG_DSN)
pg_cur = pg_conn.cursor()

def copy_table(table, columns):
    cols = ", ".join(columns)
    placeholders = ", ".join(["%s"] * len(columns))
    sqlite_cur.execute(f"SELECT {cols} FROM {table}")
    rows = sqlite_cur.fetchall()
    if rows:
        pg_cur.executemany(
            f"INSERT INTO {table} ({cols}) VALUES ({placeholders})",
            rows
        )

# Order matters due to FKs
copy_table("users", ["id", "username", "password_hash", "created_at"])
copy_table("expenses", ["id", "user_id", "amount", "description", "category", "expense_date", "created_at", "updated_at"])
copy_table("refresh_tokens", ["id", "user_id", "token", "expires_at", "created_at"])

# Reset sequences to max(id)
pg_cur.execute("SELECT setval('users_id_seq', COALESCE((SELECT MAX(id) FROM users), 1))")
pg_cur.execute("SELECT setval('expenses_id_seq', COALESCE((SELECT MAX(id) FROM expenses), 1))")
pg_cur.execute("SELECT setval('refresh_tokens_id_seq', COALESCE((SELECT MAX(id) FROM refresh_tokens), 1))")

pg_conn.commit()
pg_cur.close()
pg_conn.close()
sqlite_conn.close()

print("Migration completed.")