# ButterflyTamilChat — Big Upgrade

Features: persistent public/private chat history, permanent rooms, profiles/photos, GIF/photo attachments, admin mute/kick/ban IP, IP inspection, `/clear cmnt`, audio/video calling and Butterfly FM.

## Render setup
Set these environment variables on the Render Web Service:
- `DATABASE_URL` = your PostgreSQL connection string (Supabase/Neon or another PostgreSQL provider)
- `ADMIN_KEY` = a strong secret used by the admin panel and `/clear cmnt`

The server creates its tables automatically on first start. Without `DATABASE_URL`, the app still runs but messages/rooms are only in memory and will not survive a restart.

## /clear cmnt
In the public room chat, an administrator can type exactly `/clear cmnt`. The server checks `ADMIN_KEY` and clears the current room's persisted messages. Normal users cannot use it.

## Security note
The admin key must be kept only in Render Environment Variables, never committed to GitHub. IP addresses are visible only through the authenticated admin panel. This app uses display-name based guest profiles; production authentication can be added later if required.
