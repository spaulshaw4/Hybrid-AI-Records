# Hybrid 1.0 Windows Service Setup

Run the daemon poller 24/7 in the background without needing an active PowerShell or command prompt window open using NSSM (Non-Sucking Service Manager).

---

## Prerequisites

- Python installed and added to PATH
- NSSM installed (download from https://nssm.cc or `choco install nssm`)
- Supabase credentials configured in environment variables

---

## Step 1: Install NSSM

**Option A: Chocolatey**
```powershell
choco install nssm
```

**Option B: Manual Download**
1. Download from https://nssm.cc/download
2. Extract and place `nssm.exe` in your system PATH or `D:\MusicDatasets\scripts\`

---

## Step 2: Register the Service

Open an **Administrator PowerShell** prompt:

```powershell
nssm install HybridDaemon "C:\Python311\python.exe" "D:\MusicDatasets\scripts\daemon_poller.py"
```

> **Note:** Adjust your Python path if installed elsewhere. Find it with: `where python`

---

## Step 3: Configure Working Directory and Auto-Start

```powershell
nssm set HybridDaemon AppDirectory "D:\MusicDatasets\scripts"
nssm set HybridDaemon Description "Hybrid 1.0 Autonomous Supabase Audio Pipeline Daemon"
nssm set HybridDaemon Start SERVICE_AUTO_START
```

### Configure Environment Variables

```powershell
nssm set HybridDaemon AppEnvironmentExtra "SUPABASE_URL=your_project_url" "SUPABASE_SERVICE_ROLE_KEY=your_service_key"
```

### Configure Logging (Optional)

```powershell
nssm set HybridDaemon AppStdout "D:\MusicDatasets\logs\daemon_stdout.log"
nssm set HybridDaemon AppStderr "D:\MusicDatasets\logs\daemon_stderr.log"
nssm set HybridDaemon AppRotateFiles 1
nssm set HybridDaemon AppRotateBytes 10485760
```

---

## Step 4: Launch the Service

```powershell
nssm start HybridDaemon
```

---

## Service Management Commands

| Command | Description |
|---------|-------------|
| `nssm start HybridDaemon` | Start the service |
| `nssm stop HybridDaemon` | Stop the service |
| `nssm restart HybridDaemon` | Restart the service |
| `nssm status HybridDaemon` | Check service status |
| `nssm edit HybridDaemon` | Open GUI configuration |
| `nssm remove HybridDaemon` | Uninstall the service |

---

## How It Works

Once running, the system is fully automated:

1. **Frontend** triggers a generation session → inserts `pending` record in Supabase `user_vaults`
2. **Daemon Poller** detects the pending status (polls every 15 seconds)
3. **PowerShell Pipeline** fires:
   - Cylinder Orchestrator pulls 420 stems to D: drive
   - Bus Summation renders 7-minute master track
   - Hex Hook generates SHA-256 signature and locks vault
   - Egress Protection purges temporary stems
4. **Vault status** updates to `completed`

All completely hands-free.

---

## Troubleshooting

### Check Service Logs
```powershell
Get-Content "D:\MusicDatasets\logs\daemon_stdout.log" -Tail 50
Get-Content "D:\MusicDatasets\logs\daemon_stderr.log" -Tail 50
```

### View Windows Event Logs
```powershell
Get-EventLog -LogName Application -Source nssm -Newest 20
```

### Verify Service is Running
```powershell
Get-Service HybridDaemon
```
