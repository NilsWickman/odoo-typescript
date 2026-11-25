"""D18: give the throwaway accounts of an experiment database a cheap PBKDF2 work factor.

    .venv/bin/python worker/gen/experiment_passwords.py <database> [--rounds 1000]

Rewrites `res_users.password` of every user whose password is set, with passlib's pbkdf2_sha512 at the given
rounds and the password equal to the login (the harness users' convention, harness/common.py USERS). Only for
databases a deployed experiment serves (`slot_*`, `dev_*`); the templates and the oracle's copies are refused,
because the oracle compares them with Odoo's own 600,000-round hashes. The Worker accepts the count only when
`EXPERIMENT_PASSWORD_ROUNDS` equals it (worker/src/session/auth.ts); without the variable it behaves as Odoo.
"""
import argparse
import subprocess
import sys

from passlib.context import CryptContext

ALLOWED = ("slot_", "dev_")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("database")
    ap.add_argument("--rounds", type=int, default=1000)
    a = ap.parse_args()
    if not a.database.startswith(ALLOWED):
        sys.exit(f"refusing {a.database!r}: only experiment databases ({', '.join(ALLOWED)}*)")
    if not 1 <= a.rounds < 600_000:
        sys.exit("rounds must be between 1 and 599999 (600000 is Odoo's own work factor)")
    ctx = CryptContext(["pbkdf2_sha512"], pbkdf2_sha512__rounds=a.rounds)
    psql = ["docker", "exec", "-i", "odoo-port-pg", "psql", "-q", "-v", "ON_ERROR_STOP=1", "-U", "odoo", "-d", a.database, "-At"]
    logins = subprocess.run(psql + ["-c", "SELECT login FROM res_users WHERE password IS NOT NULL AND password <> ''"],
                            capture_output=True, text=True, check=True).stdout.split()
    sql = "".join(
        "UPDATE res_users SET password = '{}' WHERE login = '{}';\n".format(ctx.hash(login), login.replace("'", "''"))
        for login in logins)
    subprocess.run(psql, input=sql, text=True, check=True)
    print(f"{a.database}: {len(logins)} users re-hashed with {a.rounds} rounds (password = login)")


if __name__ == "__main__":
    main()
