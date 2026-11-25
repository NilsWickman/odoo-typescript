# The expectations of src/models/ics.test.ts: the calendar file calendar_event.py `_get_ics_file` builds with vobject
# (the oracle's .venv), with the UID and DTSTAMP set (they are random and the clock), run from the repository root:
#   .venv/bin/python worker/test/ics_cases.py > worker/test/ics_cases.json
import json, random
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import vobject

random.seed(7)
UTC = ZoneInfo("UTC")
WORDS = ["budget", "plan;", "Q&A,", "räksmörgås", "naïve", "\\back", "line\nbreak", "emoji😀", "x" * 30, "über-long-word" * 4, "tab\there"]


def text(n):
    return " ".join(random.choice(WORDS) for _ in range(n))


def build(c):
    cal = vobject.iCalendar()
    event = cal.add('vevent')
    event.add('uid').value = c['uid']
    event.add('created').value = datetime.fromisoformat(c['created']).replace(tzinfo=UTC)
    event.add('dtstart').value = datetime.fromisoformat(c['dtstart']).replace(tzinfo=UTC)
    event.add('dtend').value = datetime.fromisoformat(c['dtend']).replace(tzinfo=UTC)
    event.add('summary').value = c['summary']
    if c['description']:
        event.add('description').value = c['description']
    if c['location']:
        event.add('location').value = c['location']
    if c['url']:
        event.add('url').value = c['url']
    if c['rrule']:
        event.add('rrule').value = c['rrule']
    for a in c['alarms']:
        valarm = event.add('valarm')
        trigger = valarm.add('TRIGGER')
        trigger.params['related'] = ["START"]
        trigger.value = -{'days': timedelta(days=a['duration']), 'hours': timedelta(hours=a['duration']), 'minutes': timedelta(minutes=a['duration'])}[a['interval']]
        valarm.add('DESCRIPTION').value = a['description']
    for a in c['attendees']:
        event.add('attendee').value = a
    if c['organizer']:
        organizer = event.add('organizer')
        organizer.value = c['organizer']['value']
        if c['organizer']['cn'] is not None:
            organizer.params['CN'] = [c['organizer']['cn']]
    event.add('dtstamp').value = datetime.fromisoformat(c['dtstamp']).replace(tzinfo=UTC)
    return cal.serialize()


out = []
for i in range(40):
    c = {
        'uid': f"20261109T132424Z - {random.randint(0, 99999)}@worker",
        'created': "2026-11-09 13:24:24", 'dtstamp': "2026-11-09 13:24:25",
        'dtstart': f"2027-0{random.randint(1, 9)}-1{random.randint(0, 9)} 0{random.randint(0, 9)}:{random.randint(10, 59)}:00",
        'dtend': "2027-12-31 23:59:00",
        'summary': text(random.randint(0, 12)),
        'description': text(random.randint(0, 40)) if random.random() < 0.8 else None,
        'location': text(random.randint(1, 6)) if random.random() < 0.6 else None,
        'url': "https://meet.example.com/" + "a" * random.randint(1, 90) if random.random() < 0.3 else None,
        'rrule': random.choice([None, "FREQ=WEEKLY;WKST=SU;COUNT=3;BYDAY=MO", "FREQ=MONTHLY;INTERVAL=2;BYMONTHDAY=31;UNTIL=20271231T225959"]),
        'alarms': [{'interval': random.choice(['days', 'hours', 'minutes']), 'duration': random.choice([0, 1, 15, 30, 90, 1440, 2]),
                    'description': random.choice(['Notification - 15 Minutes', 'Email - 3 Hours', 'Odoo', 'Påminnelse, dag'])}
                   for _ in range(random.randint(0, 3))],
        'attendees': ["MAILTO:" + random.choice(["a@example.com", "mark.brown23@example.com", "", "x" * 80 + "@example.com"]) for _ in range(random.randint(0, 4))],
        'organizer': random.choice([None, {'value': "MAILTO:admin@example.com", 'cn': "Mitchell Admin"},
                                    {'value': "MAILTO:b@example.com", 'cn': "Azure Interior, Brandon Freeman"},
                                    {'value': "MAILTO:c@example.com", 'cn': None}]),
    }
    out.append([c, build(c)])
print(json.dumps(out, ensure_ascii=False, indent=0))
