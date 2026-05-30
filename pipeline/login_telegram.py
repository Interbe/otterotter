"""
Run this ONCE on your own computer to create a Telegram "session string".

It logs into your Telegram account (so the pipeline can read the group you're a
member of) and prints a long session string. You then paste that string into a
GitHub secret called TG_SESSION. You never have to do this again.

How to run (in Terminal):
  pip install telethon
  python pipeline/login_telegram.py

You'll be asked for:
  - your API ID and API hash (from https://my.telegram.org -> API development tools)
  - your phone number (with country code, e.g. +45...)
  - the login code Telegram sends you (and your 2FA password if you have one)

Keep the printed session string SECRET — it grants access to your account.
"""

from telethon.sync import TelegramClient
from telethon.sessions import StringSession


def main():
    print("Telegram session generator for Otterotter\n")
    api_id = int(input("API ID: ").strip())
    api_hash = input("API hash: ").strip()

    with TelegramClient(StringSession(), api_id, api_hash) as client:
        print("\n--- Your TG_SESSION (copy the whole line into a GitHub secret) ---\n")
        print(client.session.save())
        print("\n------------------------------------------------------------------")
        me = client.get_me()
        print("Logged in as:", getattr(me, "username", None) or getattr(me, "first_name", "you"))
        print("\nTip: also note the group's @username or its t.me link for TG_GROUP.")


if __name__ == "__main__":
    main()
