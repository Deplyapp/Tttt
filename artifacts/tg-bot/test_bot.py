import os
import logging
from telegram import Update
from telegram.ext import ApplicationBuilder, CommandHandler, MessageHandler, filters, ContextTypes

# Get token from environment variable (set it via /setenv in HostBot)
TOKEN = os.environ.get("BOT_TOKEN", "")

if not TOKEN:
    print("ERROR: BOT_TOKEN environment variable is not set!")
    print("Set it in HostBot using: /setenv <id> BOT_TOKEN=your_token_here")
    exit(1)

logging.basicConfig(
    format="%(asctime)s - %(name)s - %(levelname)s - %(message)s",
    level=logging.INFO
)
logger = logging.getLogger(__name__)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    user = update.effective_user
    await update.message.reply_text(
        f"👋 Hello, {user.first_name}!\n\n"
        f"I'm a test bot running on HostBot 🚀\n\n"
        f"Commands:\n"
        f"/start - Show this message\n"
        f"/echo <text> - Echo your message\n"
        f"/info - Show bot info"
    )


async def echo_command(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not context.args:
        await update.message.reply_text("Usage: /echo <your message>")
        return
    text = " ".join(context.args)
    await update.message.reply_text(f"🔊 {text}")


async def info(update: Update, context: ContextTypes.DEFAULT_TYPE):
    bot = await context.bot.get_me()
    await update.message.reply_text(
        f"🤖 *Bot Info*\n\n"
        f"Name: {bot.first_name}\n"
        f"Username: @{bot.username}\n"
        f"ID: `{bot.id}`\n\n"
        f"✅ Running successfully on HostBot!",
        parse_mode="Markdown"
    )


async def echo_message(update: Update, context: ContextTypes.DEFAULT_TYPE):
    await update.message.reply_text(
        f"You said: {update.message.text}\n\n"
        f"_I'm a simple echo bot! Use /start to see all commands._",
        parse_mode="Markdown"
    )


def main():
    print(f"Starting test bot...")
    app = ApplicationBuilder().token(TOKEN).build()

    app.add_handler(CommandHandler("start", start))
    app.add_handler(CommandHandler("echo", echo_command))
    app.add_handler(CommandHandler("info", info))
    app.add_handler(MessageHandler(filters.TEXT & ~filters.COMMAND, echo_message))

    print("Test bot is running! Press Ctrl+C to stop.")
    app.run_polling(allowed_updates=Update.ALL_TYPES)


if __name__ == "__main__":
    main()
