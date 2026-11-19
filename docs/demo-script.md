# Demo script — Riverbend Shelter Bed Line

> Final tuned version — the intake question, spoken digits, and hold-status
> behavior are all live. Verified over chat; the phone call confirms audio.

**Dial: +1 (603) 515-5568**

## CALL 1 — intake → search → hold → directions

1. Listen: greeting ("nine, eight, eight" spoken as words)
2. Say: **"Hi, I need a bed for tonight"** — and wait. Expect the assistant to ask
   where you are and about your needs (party size, pets, access). Answer naturally:
   **"Near the waterfront. Just me, and I have a dog."**
3. Expect: *"Let me check what's open tonight"* → **Harborlight Center, 15 beds**
4. Say: **"Harborlight, please"** → expect hold confirmation (*bed 1, 30 minutes*)
5. Say: **"Yes, directions"** → transit steps (Bus 12 along the waterfront…)
6. Say: **"thanks, bye"**

## CALL 2 — returning caller (wait ~2 minutes, same phone)

7. Listen: greeting
8. The webhook flags your active hold — expect the hold status plus the three
   options (keep / extend / cancel)
9. Say: **"extend it 30 minutes"** → expect: *about 60 minutes left*
10. Say: **"check how much time I have left"** → expect the model to call
    hold_status and answer precisely
11. Say: **"cancel it"** → confirm → expect the bed released back to the pool
12. Say: **"actually, I need something to eat"** → expect list_services with the
    Kitchen **including its walking/bus directions**

## SIDE-PATHS (optional)

- Crisis: say **"I'm in danger"** at any point → the verbatim crisis message
  (nine, eight, eight spoken as words)
- No-bed: *"anything near the marina?"* → honest no + closest alternative
- Full: after the tune, expect the model to hold Cedar/Faith searches too
