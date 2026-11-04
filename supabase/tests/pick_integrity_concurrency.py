"""Real PostgreSQL races, using only psql and stdlib. Never targets a live database.

Apply all migrations to an isolated LOCAL Supabase-compatible wte_issue80_test DB first.
python3 supabase/tests/pick_integrity_concurrency.py --confirm-isolated \
  --dsn postgresql://postgres:synthetic@127.0.0.1:54322/wte_issue80_test
The SQL rollback suite is separate: psql -X -v ON_ERROR_STOP=1 -f pick_integrity_test.sql DSN
"""
import argparse
import json
import os
import selectors
import shutil
import subprocess
import time
from urllib.parse import urlparse
from uuid import uuid4


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--dsn', required=True)
    parser.add_argument('--confirm-isolated', action='store_true')
    args = parser.parse_args()
    url = urlparse(args.dsn)
    if (not args.confirm_isolated or url.scheme not in {'postgres', 'postgresql'}
            or url.hostname not in {'127.0.0.1', 'localhost', '::1'}
            or url.path != '/wte_issue80_test' or url.query or url.fragment):
        parser.error('Only an explicitly confirmed local wte_issue80_test database is permitted')
    psql = shutil.which('psql')
    if not psql:
        parser.error('psql is unavailable; no PostgreSQL concurrency verification was run')
    command = [psql, '-X', '-qAt', '-w', '-v', 'ON_ERROR_STOP=1', args.dsn]
    # No psql startup files, password files or service settings from the developer's setup.
    env = {**os.environ, 'PGPASSFILE': os.devnull, 'PGSERVICEFILE': os.devnull}
    env.pop('PGSERVICE', None)

    def sql(text):
        done = subprocess.run(command + ['-c', text], capture_output=True, text=True,
                              env=env, timeout=15)
        if done.returncode:
            raise RuntimeError(done.stderr)  # Never echo the DSN/password in exceptions.
        return done.stdout.strip()

    def auth(user):
        return ("set local role authenticated; select set_config('request.jwt.claims',"
                f"'{{\"sub\":\"{user}\",\"role\":\"authenticated\"}}', true);")

    def action(sid, place, none=False):
        if none:
            return (f"with changed as (update public.sessions set outcome='none', ended_at=now() "
                    f"where id='{sid}' and outcome is null returning id) "
                    "select json_build_object('closed', count(*)) from changed;")
        return ("select row_to_json(r) from public.save_recommendation_pick("
                f"'{sid}',1,'{place}',123) r;")

    def result(output):
        values = [json.loads(line) for line in output.splitlines() if line.startswith('{')]
        # set_config also emits the JWT JSON; the last row is the operation's result.
        return values[-1]

    for name, first_none, second_none, same in [
        ('identical retries', False, False, True),
        ('competing picks', False, False, False),
        ('None wins before pick', True, False, True),
        ('pick wins before None', False, True, True),
    ]:
        user, sid = str(uuid4()), str(uuid4())
        places = [f'synthetic:issue80-{uuid4()}' for _ in range(2)]
        app = 'wte80_' + uuid4().hex
        first = second = None
        try:
            sql(f"""begin;
                insert into auth.users (id,aud,role,email) values
                  ('{user}','authenticated','authenticated','{user}@test.invalid');
                insert into public.places (id,name,lat,lon,category_id) values
                  ('{places[0]}','Synthetic A',1,2,'thai'),
                  ('{places[1]}','Synthetic B',1,2,'thai');
                insert into public.sessions
                  (id,user_id,timezone,local_date,meal_slot,lat,lon,budget_level)
                values ('{sid}','{user}','America/New_York','2026-11-03','lunch',1,2,3);
                insert into public.recommendation_events
                  (user_id,session_id,round,place_id,event,rank,slot,decision_budget_level)
                values ('{user}','{sid}',1,'{places[0]}','shown',1,'discovery',1),
                  ('{user}','{sid}',1,'{places[1]}','shown',2,'discovery',1);
                commit;""")
            first = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, env=env)
            first.stdin.write('begin;' + auth(user) + action(sid, places[0], first_none)
                              + '\n\\echo LOCK_HELD\n')
            first.stdin.flush()
            first_output = ''
            # Read raw chunks so TextIO prefetch cannot hide the readiness marker
            # from select(). Observe a held transaction before starting the contender.
            with selectors.DefaultSelector() as ready:
                ready.register(first.stdout, selectors.EVENT_READ)
                deadline = time.monotonic() + 10
                while True:
                    if time.monotonic() > deadline:
                        raise TimeoutError('first transaction did not acquire its lock')
                    if not ready.select(0.1):
                        continue
                    chunk = os.read(first.stdout.fileno(), 4096)
                    if not chunk:
                        raise RuntimeError(first.stderr.read())
                    first_output += chunk.decode()
                    if 'LOCK_HELD\n' in first_output:
                        break
            contender = places[0] if same else places[1]
            second = subprocess.Popen(command + ['-c', f"begin;set application_name='{app}';"
                + auth(user) + action(sid, contender, second_none) + 'commit;'],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, env=env)
            deadline = time.monotonic() + 10
            while sql("select exists(select 1 from pg_stat_activity "
                      f"where application_name='{app}' and wait_event_type='Lock');") != 't':
                if second.poll() is not None or time.monotonic() > deadline:
                    raise AssertionError('contender did not wait on the actual session lock')
                time.sleep(0.05)
            first.stdin.write('commit;\n\\q\n')
            first.stdin.flush()
            first.wait(timeout=10)
            assert first.returncode == 0, first.stderr.read()
            output, error = second.communicate(timeout=10)
            assert second.returncode == 0, error
            later = result(output)
            if first_none:
                assert later == {'status': 'conflict', 'meal_id': None}, later
            elif second_none:
                assert later == {'closed': 0}, later
            elif same:
                earlier = result(first_output)
                assert earlier['status'] == 'saved' and later['status'] == 'replayed'
                assert earlier['meal_id'] == later['meal_id']
            else:
                assert later == {'status': 'conflict', 'meal_id': None}, later
            counts = json.loads(sql(f"""select json_build_array(
                (select count(*) from public.meals where session_id='{sid}'),
                (select count(*) from public.recommendation_events
                 where session_id='{sid}' and event='picked'),
                (select outcome from public.sessions where id='{sid}'));"""))
            expected = [0, 0, 'none'] if first_none else [1, 1, 'picked']
            assert counts == expected, counts
            print(f'PASS: {name}; contender waited; persisted state={counts}')
        finally:
            for process in [first, second]:
                if process is not None and process.poll() is None:
                    process.terminate()
                    process.wait(timeout=10)
            sql(f"delete from auth.users where id='{user}'; "
                f"delete from public.places where id in ('{places[0]}','{places[1]}');")


if __name__ == '__main__':
    main()
