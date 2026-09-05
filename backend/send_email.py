import os
import smtplib
from email.message import EmailMessage
from dotenv import load_dotenv

# Load .env
load_dotenv()

GMAIL_ADDRESS = os.getenv("GMAIL_ADDRESS")
GMAIL_APP_PASSWORD = os.getenv("GMAIL_APP_PASSWORD")

# Check environment variables
if not GMAIL_ADDRESS:
    raise ValueError("GMAIL_ADDRESS is not set in .env")

if not GMAIL_APP_PASSWORD:
    raise ValueError("GMAIL_APP_PASSWORD is not set in .env")

print("Gmail:", GMAIL_ADDRESS)
print("App password loaded:", bool(GMAIL_APP_PASSWORD))

# Create email
msg = EmailMessage()

msg["Subject"] = "Welcome! 🎉"
msg["From"] = GMAIL_ADDRESS
msg["To"] = "23cs3041@rgipt.ac.in"

msg.set_content("""
Hi!

Welcome to our store! 🎉

Thank you for your first purchase.

Here's 15% OFF on your second purchase.

Happy shopping!

Best regards,
Your Store Team
""")

try:
    print("Connecting to Gmail...")

    with smtplib.SMTP_SSL("smtp.gmail.com", 465) as smtp:

        print("Connected to Gmail")

        smtp.login(
            GMAIL_ADDRESS,
            GMAIL_APP_PASSWORD
        )

        print("Gmail login successful")

        smtp.send_message(msg)

        print("Email sent successfully!")

except smtplib.SMTPAuthenticationError:
    print("Gmail authentication failed.")
    print("Check that you are using a Gmail App Password, not your normal Gmail password.")

except Exception as e:
    print("Error occurred:")
    print(type(e).__name__)
    print(e)