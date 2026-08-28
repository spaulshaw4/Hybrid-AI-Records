# HYBRID 1.0 — Production Deployment Guide

## 1. Supabase Infrastructure & Database Provisioning

### Execute Database Schema

Navigate to the **Supabase SQL Editor** and run the complete schema script to provision:

- `user_balances`
- `token_transactions`
- `user_vaults`
- `spend_hybrid_token` RPC function

```sql
-- Run: supabase/migrations/20260828_hybrid_vault_schema.sql
```

### Enable Realtime Replication

Ensure real-time events are active on the `user_vaults` table so WebSocket state pushes trigger instantly when a render finishes:

```sql
alter publication supabase_realtime add table public.user_vaults;
```

### Configure Storage Buckets

1. Create a **private** storage bucket named `audio-vault`
2. Set up secure RLS policies restricting read/write access to:
   - Authenticated service roles
   - Authorized user session paths

---

## 2. Next.js Frontend & API Production Deployment

### Environment Configuration

Set up production environment variables in your hosting provider dashboard (e.g., Vercel):

```env
NEXT_PUBLIC_SUPABASE_URL=your_production_supabase_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=your_production_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_production_service_role_key
```

### Build Verification

Run a local production build test to verify zero compilation errors:

```bash
npm run build
npm run start
```

### Deploy to Production Host

Connect your repository to your target hosting platform, ensuring:

- Serverless/edge functions support standard API route execution
- Proxy streaming headers are enabled for audio delivery

---

## 3. Python Engine Worker Node Setup

### Environment Provisioning

On the dedicated hardware or server node hosting your audio library:

```bash
# Clone and setup
git clone <repo>
cd scripts

# Create virtual environment
python -m venv venv

# Activate (Linux/Mac)
source venv/bin/activate

# Activate (Windows)
venv\Scripts\activate

# Install dependencies
pip install -r requirements.txt
```

### Environment Variables

Configure the worker's local environment with production Supabase credentials:

```env
SUPABASE_URL=your_production_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_production_service_role_key
```

### Listener Daemon / Polling Service

Configure `master_engine.py` to run as:

- A persistent daemon, OR
- A queue listener watching for incoming job payloads

This ensures seamless automated execution when the frontend fires a generation request.

Example systemd service (Linux):

```ini
[Unit]
Description=Hybrid 1.0 Audio Engine
After=network.target

[Service]
Type=simple
WorkingDirectory=/path/to/scripts
ExecStart=/path/to/venv/bin/python watchdog_runner.py
Restart=always
Environment=SUPABASE_URL=...
Environment=SUPABASE_SERVICE_ROLE_KEY=...

[Install]
WantedBy=multi-user.target
```

---

## 4. End-to-End Pipeline Verification

### Token Transaction Test

1. Log into the production UI
2. Verify user balance deduction via the **$2.00** RPC function
3. Confirm transaction logging in `token_transactions` table

### Job Execution & WebSocket Sync

1. Trigger a test track generation with custom lyrics and structural tags
2. Verify UI state transitions: `processing` → `completed`
3. Confirm real-time Supabase WebSocket updates fire correctly

### Cloud Stream & Stem Export Verification

1. Open `HybridStemMixer`
2. Play master mix streaming from Supabase Cloud Storage
3. Adjust multi-track volumes
4. Test individual `.wav` stem exports

---

## Checklist

- [ ] Database schema executed
- [ ] Realtime enabled on `user_vaults`
- [ ] `audio-vault` bucket created with RLS
- [ ] Environment variables configured (frontend + worker)
- [ ] Production build passes
- [ ] Frontend deployed
- [ ] Python worker daemon running
- [ ] Token deduction verified ($2.00)
- [ ] WebSocket status updates working
- [ ] Audio streaming functional
- [ ] Stem export tested
