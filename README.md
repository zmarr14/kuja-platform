# Kuja AI Platform

## Local Setup (your laptop)

1. Open PowerShell inside the `backend` folder
2. Run: `npm install`
3. Copy `.env.example` to `.env` and fill in your details
4. Run: `node server.js`
5. Open: http://localhost:3000

## Deploy to Railway

1. Push this whole folder to GitHub
2. Go to railway.app → New Project → Deploy from GitHub
3. Add your environment variables (from .env.example)
4. Done — Railway gives you a live URL

## Environment Variables needed

- PORT=3000
- JWT_SECRET=any-long-random-string
- ADMIN_EMAIL=info@kujaai.com
- ADMIN_PASSWORD=your-password
- SMTP_HOST=smtp.gmail.com
- SMTP_PORT=587
- SMTP_USER=info@kujaai.com
- SMTP_PASS=your-gmail-app-password
- EMAIL_FROM=Kuja AI <info@kujaai.com>
- PLATFORM_URL=https://your-railway-url.railway.app
