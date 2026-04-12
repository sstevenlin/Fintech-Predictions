# Fintech-Predictions
predictions project

## Repository Structure
- `/backend`: Python service (Eric)
- `/frontend`: Next.js web app (Mason)
- `/docs`: Architecture and API contracts

## Local Setup

### 1. Prerequisites:
- Python 3.13+
- Node.js 20+
- Git

### 2. Environment Configuration
- Copy `.env.example` to `.env` in the root directory.

### 3. Backend Setup
1. `cd backend`
2. `python -m venv venv`
3. `.\venv\Scripts\activate` (Windows) or `source venv/bin/activate` (Mac/Linux)
4. `pip install -r requirements.txt` (Note: Eric will provide this file in his ticket).

### 4. Frontend Setup
1. `cd frontend`
2. `npm install`
3. `npm run dev`

## Contribution Rules
- **Branching:** Use `feat/` or `fix/` prefixes
- **Pull Requests:** All PRs require 1 approval and must pass CI checks
- **Secrets:** Never commit `.env` files.