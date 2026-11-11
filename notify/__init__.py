"""What changed, and telling the people who asked.

    detect.py   compares what the database knows now with what it knew before:
                a player in an entered lineup ruled out, a status change, expected
                points moving → rows in bsb.events (each change recorded once)
    send.py     a pop-up to a signed-up device (Web Push) and an e-mail (SMTP)
    run.py      detect → record → send → log in bsb.notifications

Runs after every status snapshot and every projections run (`bsb notify run`)."""
